import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBVirtualCamera } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/virtual_camera.gen'
import type { CameraTransition } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/common/camera_transition.gen'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { EntityStore } from '../bridge/EntityStore'
import type { EntityPose } from '../bridge/ReservedEntitiesSync'
import type { ProjectionView } from '../bridge/ProjectionView'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { resolveEntityWorldPose, type EntityWorldTransformDeps } from './entityWorldTransform'

const _targetPos = new THREE.Vector3()
const _targetQuat = new THREE.Quaternion()
const _lerpPos = new THREE.Vector3()
const _lerpQuat = new THREE.Quaternion()
const _lookObj = new THREE.Object3D()

type TransitionState = {
  fromPos: THREE.Vector3
  fromQuat: THREE.Quaternion
  toPos: THREE.Vector3
  toQuat: THREE.Quaternion
  duration: number
  elapsed: number
}

/** Scene VirtualCamera + MainCamera — drives Three.js camera with SDK7 transitions. */
export class VirtualCameraBridge {
  private activeEntity: Entity | null = null
  private transition: TransitionState | null = null
  private readonly verbose = false

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly store: EntityStore,
    private readonly view: ProjectionView,
    private readonly getCamera: () => THREE.Camera,
    private readonly playerPose: () => EntityPose,
    private readonly cameraPose: () => EntityPose
  ) {}

  isActive(): boolean {
    return this.resolveActiveVirtualCamera() !== null
  }

  /** When active, applies virtual camera pose and returns true (skip default orbit camera). */
  apply(delta: number): boolean {
    const virtualEntity = this.resolveActiveVirtualCamera()
    if (virtualEntity === null) {
      if (this.activeEntity !== null) {
        this.activeEntity = null
        this.transition = null
      }
      return false
    }

    const target = this.computeTargetPose(virtualEntity)
    if (!target) return false

    const camera = this.getCamera()

    if (this.activeEntity !== virtualEntity) {
      this.beginTransition(camera, virtualEntity, target)
      this.activeEntity = virtualEntity
    }

    if (this.transition) {
      this.transition.elapsed += delta
      const t = Math.min(1, this.transition.elapsed / Math.max(this.transition.duration, 1e-6))
      _lerpPos.copy(this.transition.fromPos).lerp(this.transition.toPos, t)
      _lerpQuat.copy(this.transition.fromQuat).slerp(this.transition.toQuat, t)
      camera.position.copy(_lerpPos)
      camera.quaternion.copy(_lerpQuat)
      if (t >= 1) this.transition = null
    }

    if (!this.transition) {
      camera.position.copy(target.position)
      camera.quaternion.copy(target.rotation)
    }

    return true
  }

  private resolveActiveVirtualCamera(): Entity | null {
    const { MainCamera, VirtualCamera, Transform } = this.ecs
    const main = MainCamera.getOrNull(this.view.CameraEntity) as
      | { virtualCameraEntity?: number }
      | null
    const entity = main?.virtualCameraEntity
    if (entity === undefined || entity === null) return null
    if (!VirtualCamera.has(entity as Entity) || !Transform.has(entity as Entity)) return null
    return entity as Entity
  }

  private worldDeps(): EntityWorldTransformDeps {
    return {
      view: this.view,
      store: this.store,
      playerPose: this.playerPose,
      cameraPose: this.cameraPose
    }
  }

  private computeTargetPose(virtualEntity: Entity): { position: THREE.Vector3; rotation: THREE.Quaternion } | null {
    const spec = this.ecs.VirtualCamera.get(virtualEntity) as PBVirtualCamera
    if (!resolveEntityWorldPose(virtualEntity, this.worldDeps(), { position: _targetPos, rotation: _targetQuat })) {
      return null
    }

    const lookAt = spec.lookAtEntity
    if (
      lookAt !== undefined &&
      lookAt !== null &&
      lookAt !== (virtualEntity as number) &&
      lookAt !== (this.view.CameraEntity as number)
    ) {
      const targetWorld = resolveEntityWorldPose(lookAt as Entity, this.worldDeps())
      if (targetWorld) {
        _lookObj.position.copy(_targetPos)
        _lookObj.lookAt(targetWorld.position)
        _targetQuat.copy(_lookObj.quaternion)
      }
    }

    return { position: _targetPos, rotation: _targetQuat }
  }

  private beginTransition(
    camera: THREE.Camera,
    virtualEntity: Entity,
    target: { position: THREE.Vector3; rotation: THREE.Quaternion }
  ): void {
    const spec = this.ecs.VirtualCamera.get(virtualEntity) as PBVirtualCamera
    const duration = resolveTransitionDuration(spec.defaultTransition, camera.position, target.position)
    if (duration <= 0) {
      this.transition = null
      if (this.verbose) {
        clientDebugLog.log('camera', `VirtualCamera e${virtualEntity} — instant cut`, { level: 'info' })
      }
      return
    }

    this.transition = {
      fromPos: camera.position.clone(),
      fromQuat: camera.quaternion.clone(),
      toPos: target.position.clone(),
      toQuat: target.rotation.clone(),
      duration,
      elapsed: 0
    }
    if (this.verbose) {
      clientDebugLog.log('camera', `VirtualCamera e${virtualEntity} — transition ${duration.toFixed(2)}s`, {
        level: 'info'
      })
    }
  }
}

function resolveTransitionDuration(
  transition: CameraTransition | undefined,
  from: THREE.Vector3,
  to: THREE.Vector3
): number {
  const mode = transition?.transitionMode
  if (!mode) return 0
  if (mode.$case === 'time') return Math.max(0, mode.time)
  if (mode.$case === 'speed') {
    const speed = Math.max(1e-6, mode.speed)
    return from.distanceTo(to) / speed
  }
  return 0
}