import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBVirtualCamera } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/virtual_camera.gen'
import type { CameraTransition } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/common/camera_transition.gen'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { EntityPose } from '../bridge/ReservedEntitiesSync'
import type { ProjectionView } from '../bridge/ProjectionView'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { entityDisplayQuatToThreeCameraQuat, threeToDclPos } from '../bridge/dclTransform'
import { resolveEntityWorldPose, type EntityWorldTransformDeps } from '../transform/entityWorldTransform'
import {
  computeLensEcsDelta,
  logVcLensParity,
  vec3FromThree,
  vcDebugVerbose,
  yawPitchFromEntityDisplayQuat,
  yawPitchFromThreeQuat,
  type VcLensParityReport,
  type VcPoseSnapshot
} from './VirtualCameraDebug'

const _targetPos = new THREE.Vector3()
const _targetQuat = new THREE.Quaternion()
const _lerpPos = new THREE.Vector3()
const _lerpQuat = new THREE.Quaternion()
const _lookObj = new THREE.Object3D()
const _gizmoWorld = new THREE.Vector3()
const _gizmoWorldQuat = new THREE.Quaternion()

type TransitionState = {
  fromPos: THREE.Vector3
  fromQuat: THREE.Quaternion
  toPos: THREE.Vector3
  toQuat: THREE.Quaternion
  duration: number
  elapsed: number
}

type ResolveVcResult = {
  entity: Entity | null
  inactiveReason: string | null
  mainVcEntity: Entity | null
}

/** Scene VirtualCamera + MainCamera — drives Three.js camera with SDK7 transitions. */
export class VirtualCameraBridge {
  private activeEntity: Entity | null = null
  private transition: TransitionState | null = null
  private debugElapsed = 0
  private parityFramesAfterBind = 0

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly view: ProjectionView,
    private readonly getCamera: () => THREE.Camera,
    private readonly playerPose: () => EntityPose,
    private readonly cameraPose: () => EntityPose,
    private readonly getEntityNodes?: () => Map<Entity, THREE.Group> | undefined
  ) {}

  isActive(): boolean {
    return this.resolveActiveVirtualCamera().entity !== null
  }

  /** Log lens vs VC entity pose — call after projection ingests a MainCamera bind. */
  logLensParity(label: string, vcEntity?: Entity): void {
    const resolved = this.resolveActiveVirtualCamera()
    const entity = vcEntity ?? resolved.entity
    if (entity === null) {
      const mainVc = this.readMainCameraVcEntity()
      clientDebugLog.log(
        'vc-lens',
        `${label} — no active VC (main→vc=${mainVc ?? 'null'} reason=${resolved.inactiveReason ?? '?'})`,
        { level: 'warn', alsoConsole: true }
      )
      return
    }
    this.emitParityReport(label, entity, resolved, true)
    this.parityFramesAfterBind = 120
  }

  /** When active, applies virtual camera pose and returns true (skip default orbit camera). */
  apply(delta: number): boolean {
    const resolved = this.resolveActiveVirtualCamera()
    const virtualEntity = resolved.entity
    if (virtualEntity === null) {
      this.logInactiveIfBound(resolved)
      if (this.activeEntity !== null) {
        this.activeEntity = null
        this.transition = null
        this.parityFramesAfterBind = 0
      }
      return false
    }

    const target = this.computeTargetPose(virtualEntity)
    if (!target) {
      clientDebugLog.log(
        'vc-lens',
        `computeTargetPose failed for vc=e${virtualEntity}`,
        { level: 'warn', throttleMs: 1000, alsoConsole: true }
      )
      return false
    }

    const camera = this.getCamera()
    const bindChanged = this.activeEntity !== virtualEntity

    if (bindChanged) {
      this.beginTransition(camera, virtualEntity, target)
      this.activeEntity = virtualEntity
      this.emitParityReport('VIEW SHOT bind', virtualEntity, resolved, true)
      this.parityFramesAfterBind = 120
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
      const lag = camera.position.distanceTo(target.position)
      const followAlpha = lag > 0.08 ? 1 : 1 - Math.exp(-32 * delta)
      camera.position.lerp(target.position, followAlpha)
      camera.quaternion.slerp(target.rotation, followAlpha)
    }

    this.debugElapsed += delta
    if (this.parityFramesAfterBind > 0) {
      this.parityFramesAfterBind--
      if (this.debugElapsed >= 0.25) {
        this.debugElapsed = 0
        this.emitParityReport('post-bind tick', virtualEntity, resolved, false)
      }
    } else if (vcDebugVerbose() && this.debugElapsed >= 0.5) {
      this.debugElapsed = 0
      this.emitParityReport('vcdebug', virtualEntity, resolved, false)
    }

    return true
  }

  private readMainCameraVcEntity(): Entity | null {
    const main = this.ecs.MainCamera.getOrNull(this.view.CameraEntity) as
      | { virtualCameraEntity?: number }
      | null
    const entity = main?.virtualCameraEntity
    return entity === undefined || entity === null ? null : (entity as Entity)
  }

  private logInactiveIfBound(resolved: ResolveVcResult): void {
    if (resolved.mainVcEntity === null) return
    clientDebugLog.log(
      'vc-lens',
      `MainCamera→e${resolved.mainVcEntity} but bridge inactive: ${resolved.inactiveReason ?? 'unknown'}`,
      { level: 'warn', throttleMs: 1500, alsoConsole: true }
    )
  }

  private emitParityReport(
    label: string,
    virtualEntity: Entity,
    resolved: ResolveVcResult,
    force: boolean
  ): void {
    const camera = this.getCamera()
    const lensPos = vec3FromThree(camera.position)

    const ecsWorldPos = resolveEntityWorldPose(virtualEntity, this.worldDeps())
    const ecsWorld = ecsWorldPos ? vec3FromThree(ecsWorldPos.position) : null

    const { Transform } = this.ecs
    const local = Transform.getOrNull(virtualEntity) as
      | {
          position: { x: number; y: number; z: number }
          parent?: Entity
        }
      | null

    const ecsDcl: VcPoseSnapshot | null =
      local ?
        { x: local.position.x, y: local.position.y, z: local.position.z }
      : ecsWorldPos ?
        (() => {
          const d = threeToDclPos(ecsWorldPos.position.x, ecsWorldPos.position.y, ecsWorldPos.position.z)
          return { x: d.x, y: d.y, z: d.z }
        })()
      : null

    let gizmoWorld: VcPoseSnapshot | null = null
    let gizmoEntityRot = null
    const node = this.getEntityNodes?.()?.get(virtualEntity)
    if (node) {
      node.getWorldPosition(_gizmoWorld)
      gizmoWorld = vec3FromThree(_gizmoWorld)
      node.getWorldQuaternion(_gizmoWorldQuat)
      gizmoEntityRot = yawPitchFromEntityDisplayQuat(_gizmoWorldQuat)
    }

    const spec = this.ecs.VirtualCamera.getOrNull(virtualEntity) as PBVirtualCamera | null
    const lookAt = spec?.lookAtEntity
    const lensRot = yawPitchFromThreeQuat(camera.quaternion)

    const report: VcLensParityReport = {
      vcEntity: virtualEntity,
      lensPos,
      lensRot,
      gizmoEntityRot,
      ecsWorldPos: ecsWorld,
      gizmoWorldPos: gizmoWorld,
      ecsDclPos: ecsDcl,
      lensEcsDeltaM: computeLensEcsDelta(lensPos, ecsWorld),
      lensGizmoDeltaM: gizmoWorld ? computeLensEcsDelta(lensPos, gizmoWorld) : null,
      mainCameraVcEntity: resolved.mainVcEntity,
      vcTransformLocal:
        local ?
          { x: local.position.x, y: local.position.y, z: local.position.z }
        : null,
      vcTransformParent: (local?.parent as Entity | undefined) ?? null,
      vcLookAtEntity:
        lookAt !== undefined && lookAt !== null ? (lookAt as Entity) : null,
      bridgeActive: resolved.entity !== null,
      inactiveReason: resolved.inactiveReason
    }

    logVcLensParity(label, report, { force })
  }

  private resolveActiveVirtualCamera(): ResolveVcResult {
    const { VirtualCamera, Transform } = this.ecs
    const mainVc = this.readMainCameraVcEntity()
    if (mainVc === null) {
      return { entity: null, inactiveReason: 'MainCamera.virtualCameraEntity unset', mainVcEntity: null }
    }

    const virtualEntity = mainVc
    if (!Transform.has(virtualEntity)) {
      return {
        entity: null,
        inactiveReason: `vc=e${virtualEntity} missing Transform on projection`,
        mainVcEntity: mainVc
      }
    }
    if (!VirtualCamera.has(virtualEntity)) {
      return {
        entity: null,
        inactiveReason: `vc=e${virtualEntity} missing VirtualCamera on projection`,
        mainVcEntity: mainVc
      }
    }

    return { entity: virtualEntity, inactiveReason: null, mainVcEntity: mainVc }
  }

  private worldDeps(): EntityWorldTransformDeps {
    return {
      view: this.view,
      playerPose: this.playerPose,
      cameraPose: this.cameraPose
    }
  }

  private computeTargetPose(virtualEntity: Entity): { position: THREE.Vector3; rotation: THREE.Quaternion } | null {
    const spec = this.ecs.VirtualCamera.get(virtualEntity) as PBVirtualCamera
    if (
      !resolveEntityWorldPose(virtualEntity, this.worldDeps(), {
        position: _targetPos,
        rotation: _targetQuat
      })
    ) {
      return null
    }

    const lookAt = spec.lookAtEntity
    if (
      lookAt !== undefined &&
      lookAt !== null &&
      lookAt !== (virtualEntity as number) &&
      lookAt !== (this.view.CameraEntity as number) &&
      quatIsIdentity(_targetQuat)
    ) {
      const targetWorld = resolveEntityWorldPose(lookAt as Entity, this.worldDeps())
      if (targetWorld) {
        _lookObj.position.copy(_targetPos)
        _lookObj.lookAt(targetWorld.position)
        _targetQuat.copy(_lookObj.quaternion)
        return { position: _targetPos, rotation: _targetQuat }
      }
    }

    entityDisplayQuatToThreeCameraQuat(_targetQuat, _targetQuat)
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
  }
}

function quatIsIdentity(q: THREE.Quaternion, eps = 1e-4): boolean {
  return (
    Math.abs(q.x) < eps &&
    Math.abs(q.y) < eps &&
    Math.abs(q.z) < eps &&
    Math.abs(q.w - 1) < eps
  )
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