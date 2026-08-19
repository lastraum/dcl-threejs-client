import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBVirtualCamera } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/virtual_camera.gen'
import type { CameraTransition } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/common/camera_transition.gen'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { EntityPose } from '../bridge/ReservedEntitiesSync'
import type { ProjectionView } from '../bridge/ProjectionView'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import {
  dclToThreePos,
  entityDisplayQuatToThreeCameraQuat,
  threeToDclPos,
  type DclTransformValues
} from '../bridge/dclTransform'
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
const _lookAtPoint = new THREE.Vector3()
const _lerpPos = new THREE.Vector3()
const _lerpQuat = new THREE.Quaternion()
const _lerpLookAt = new THREE.Vector3()
const _lookDir = new THREE.Vector3()
const _lookMat = new THREE.Matrix4()
const _lookRight = new THREE.Vector3()
const _lookUp = new THREE.Vector3()
const _camZ = new THREE.Vector3()
const _entityDisplayQuat = new THREE.Quaternion()
const _worldUp = new THREE.Vector3(0, 1, 0)
const _gizmoWorld = new THREE.Vector3()
const _gizmoWorldQuat = new THREE.Quaternion()
let lastFollowDiagMs = 0
let lastApplyDiagMs = 0
let lastBindYawLogMs = 0

type TargetPose = {
  position: THREE.Vector3
  rotation: THREE.Quaternion
  /** Prefer PerspectiveCamera.lookAt — avoids entity-euler → camera quat yaw flips. */
  lookAtPoint?: THREE.Vector3
}

type TransitionState = {
  fromPos: THREE.Vector3
  fromQuat: THREE.Quaternion
  toPos: THREE.Vector3
  toQuat: THREE.Quaternion
  fromLookAt?: THREE.Vector3
  toLookAt?: THREE.Vector3
  useLookAt: boolean
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
  /** Last target we applied — distinguishes teleport (accept) from single-frame CRDT spikes (hold). */
  private readonly lastAppliedTargetPos = new THREE.Vector3()
  private hasAppliedTarget = false

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

  /**
   * MainCamera has a virtualCameraEntity — freecam orbit/look must not run even if the
   * bridge cannot yet resolve Transform/VirtualCamera (one-frame hydrate lag).
   */
  isMainCameraVcBound(): boolean {
    return this.readMainCameraVcEntity() !== null
  }

  /**
   * Log lens vs VC entity pose — opt-in only (`?vcdebug`).
   * Never call from player-frame / per-tick paths without the flag; unthrottled
   * console.warn + DevTools stacks tank FPS to ~1.
   */
  logLensParity(label: string, vcEntity?: Entity): void {
    if (!vcDebugVerbose()) return
    const resolved = this.resolveActiveVirtualCamera()
    const entity = vcEntity ?? resolved.entity
    if (entity === null) {
      const mainVc = this.readMainCameraVcEntity()
      clientDebugLog.log(
        'vc-lens',
        `${label} — no active VC (main→vc=${mainVc ?? 'null'} reason=${resolved.inactiveReason ?? '?'})`,
        { level: 'warn', alsoConsole: true, throttleMs: 1000, throttleKey: `vc-lens:inactive:${label}` }
      )
      return
    }
    this.emitParityReport(label, entity, resolved, true)
    this.parityFramesAfterBind = 120
  }

  /** Write lens pose — lookAtPoint uses PerspectiveCamera.lookAt (roll-free Three path). */
  private applyLensPose(
    camera: THREE.Camera,
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
    lookAtPoint?: THREE.Vector3
  ): void {
    camera.position.copy(position)
    camera.up.copy(_worldUp)
    if (lookAtPoint) {
      camera.lookAt(lookAtPoint)
    } else {
      camera.quaternion.copy(rotation)
    }
  }

  /** When active, applies virtual camera pose and returns true (skip default orbit camera). */
  apply(delta: number): boolean {
    const resolved = this.resolveActiveVirtualCamera()
    const virtualEntity = resolved.entity
    if (virtualEntity === null) {
      this.logApplyDiag(resolved, null, null)
      this.logInactiveIfBound(resolved)
      if (this.activeEntity !== null) {
        this.activeEntity = null
        this.transition = null
        this.parityFramesAfterBind = 0
        this.hasAppliedTarget = false
      }
      return false
    }

    const target = this.computeTargetPose(virtualEntity)
    if (!target) {
      this.logApplyDiag(resolved, virtualEntity, 'computeTargetPose-failed')
      if (vcDebugVerbose()) {
        clientDebugLog.log(
          'vc-lens',
          `computeTargetPose failed for vc=e${virtualEntity}`,
          { level: 'warn', throttleMs: 1000, alsoConsole: true }
        )
      }
      return false
    }
    this.logApplyDiag(resolved, virtualEntity, 'active')

    const camera = this.getCamera()
    const bindChanged = this.activeEntity !== virtualEntity

    if (bindChanged) {
      // SDK parity: only VirtualCamera.defaultTransition drives motion (time / speed).
      this.beginTransition(camera, virtualEntity, target)
      if (!this.transition) {
        this.applyLensPose(camera, target.position, target.rotation, target.lookAtPoint)
        this.lastAppliedTargetPos.copy(target.position)
        this.hasAppliedTarget = true
      } else {
        this.hasAppliedTarget = false
      }
      this.activeEntity = virtualEntity
      const now = performance.now()
      if (now - lastBindYawLogMs > 2000) {
        lastBindYawLogMs = now
        const look = target.lookAtPoint
          ? `lookAt=(${target.lookAtPoint.x.toFixed(1)},${target.lookAtPoint.y.toFixed(1)},${target.lookAtPoint.z.toFixed(1)})`
          : 'lookAt=entity-quat'
        clientDebugLog.log(
          'vc-lens',
          `bind e${virtualEntity} pos=(${target.position.x.toFixed(1)},${target.position.y.toFixed(1)},${target.position.z.toFixed(1)}) ${look}`
        )
      }
      if (vcDebugVerbose()) {
        this.emitParityReport('VIEW SHOT bind', virtualEntity, resolved, true)
        this.parityFramesAfterBind = 120
      }
    }

    if (this.transition) {
      // Retarget end pose each frame (follow / player moves).
      this.transition.toPos.copy(target.position)
      this.transition.toQuat.copy(target.rotation)
      if (this.transition.useLookAt && target.lookAtPoint) {
        if (!this.transition.toLookAt) this.transition.toLookAt = target.lookAtPoint.clone()
        else this.transition.toLookAt.copy(target.lookAtPoint)
      }
      this.transition.elapsed += delta
      const u = Math.min(1, this.transition.elapsed / Math.max(this.transition.duration, 1e-6))
      const t = u * u * (3 - 2 * u)
      _lerpPos.copy(this.transition.fromPos).lerp(this.transition.toPos, t)
      if (this.transition.useLookAt && this.transition.fromLookAt && this.transition.toLookAt) {
        _lerpLookAt.copy(this.transition.fromLookAt).lerp(this.transition.toLookAt, t)
        this.applyLensPose(camera, _lerpPos, target.rotation, _lerpLookAt)
      } else {
        // Short-path slerp — avoid long-way flip through underground.
        _lerpQuat.copy(this.transition.fromQuat)
        if (_lerpQuat.dot(this.transition.toQuat) < 0) {
          this.transition.toQuat.x *= -1
          this.transition.toQuat.y *= -1
          this.transition.toQuat.z *= -1
          this.transition.toQuat.w *= -1
        }
        _lerpQuat.slerp(this.transition.toQuat, t)
        this.applyLensPose(camera, _lerpPos, _lerpQuat)
      }
      if (u >= 1) {
        this.transition = null
        this.lastAppliedTargetPos.copy(target.position)
        this.hasAppliedTarget = true
      }
    } else {
      // World-flat VC: suppress single-frame CRDT spikes only (not teleports).
      const localTr = this.ecs.Transform.getOrNull(virtualEntity) as { parent?: number } | null
      const parent = localTr?.parent
      const worldFlat =
        parent === undefined ||
        parent === null ||
        parent === 0 ||
        parent === (this.view.RootEntity as number)
      const jumpM = camera.position.distanceTo(target.position)
      const targetMoved =
        !this.hasAppliedTarget || this.lastAppliedTargetPos.distanceTo(target.position) > 2
      if (!bindChanged && worldFlat && jumpM > 25 && !targetMoved) {
        return true
      }
      this.applyLensPose(camera, target.position, target.rotation, target.lookAtPoint)
      this.lastAppliedTargetPos.copy(target.position)
      this.hasAppliedTarget = true
    }

    if (vcDebugVerbose()) {
      this.debugElapsed += delta
      if (this.parityFramesAfterBind > 0) {
        this.parityFramesAfterBind--
        if (this.debugElapsed >= 0.25) {
          this.debugElapsed = 0
          this.emitParityReport('post-bind tick', virtualEntity, resolved, false)
        }
      } else if (this.debugElapsed >= 0.5) {
        this.debugElapsed = 0
        this.emitParityReport('vcdebug', virtualEntity, resolved, false)
      }
    }

    return true
  }

  private readMainCameraVcEntity(): Entity | null {
    const main = this.ecs.MainCamera.getOrNull(this.view.CameraEntity) as
      | { virtualCameraEntity?: number }
      | null
    const entity = main?.virtualCameraEntity
    // 0 / missing = unbound. GP freeRevealCamera sets void 0; some CRDT paths leave 0.
    if (entity === undefined || entity === null || entity === 0) return null
    return entity as Entity
  }

  private logInactiveIfBound(resolved: ResolveVcResult): void {
    if (!vcDebugVerbose() || resolved.mainVcEntity === null) return
    clientDebugLog.log(
      'vc-lens',
      `MainCamera→e${resolved.mainVcEntity} but bridge inactive: ${resolved.inactiveReason ?? 'unknown'}`,
      { level: 'warn', throttleMs: 1500, alsoConsole: true }
    )
  }

  /** Opt-in (`?vcdebug`) or first bind — avoid per-2s console spam that tanks FPS with DevTools. */
  private logApplyDiag(
    resolved: ResolveVcResult,
    virtualEntity: Entity | null,
    mode: string | null
  ): void {
    if (!vcDebugVerbose()) return
    const now = performance.now()
    if (now - lastApplyDiagMs < 2000) return
    lastApplyDiagMs = now

    if (virtualEntity === null) {
      console.info(
        `[vc-lens] apply inactive main→vc=${resolved.mainVcEntity ?? 'null'} reason=${resolved.inactiveReason ?? 'unset'}`
      )
      return
    }

    const local = this.ecs.Transform.getOrNull(virtualEntity) as
      | {
          position: { x: number; y: number; z: number }
          parent?: number
        }
      | null
    const spec = this.ecs.VirtualCamera.getOrNull(virtualEntity) as PBVirtualCamera | null
    const parent = local?.parent
    const lookAt = spec?.lookAtEntity
    const pe = this.playerPose()
    const cam = this.getCamera()
    const world = resolveEntityWorldPose(virtualEntity, this.worldDeps())
    console.info(
      `[vc-lens] apply ${mode} vc=e${virtualEntity} parent=${parent ?? '∅'} lookAt=${lookAt ?? '∅'} ` +
        `local=(${local ? `${local.position.x.toFixed(1)},${local.position.y.toFixed(1)},${local.position.z.toFixed(1)}` : '∅'}) ` +
        `worldThree=(${world ? `${world.position.x.toFixed(1)},${world.position.y.toFixed(1)},${world.position.z.toFixed(1)}` : '∅'}) ` +
        `lens=(${cam.position.x.toFixed(1)},${cam.position.y.toFixed(1)},${cam.position.z.toFixed(1)}) ` +
        `pe=(${pe.position.x.toFixed(1)},${pe.position.y.toFixed(1)},${pe.position.z.toFixed(1)})`
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

  private computeTargetPose(virtualEntity: Entity): TargetPose | null {
    const spec = this.ecs.VirtualCamera.get(virtualEntity) as PBVirtualCamera
    const local = this.ecs.Transform.getOrNull(virtualEntity) as DclTransformValues | null
    if (!local) return null

    const lookAt = spec.lookAtEntity
    const parent = local.parent as number | undefined
    const { RootEntity, PlayerEntity, CameraEntity } = this.view

    // Classic CameraFollow third-person: parent === lookAtEntity === cameraParent (not reserved).
    // Parent is driven toward the player by the scene; use live PE + local offset so the lens
    // does not hitch on lagging cameraParent CRDT (Planet Angzaar / gameplay follow).
    const isPeFollowShape =
      lookAt !== undefined &&
      lookAt !== null &&
      parent !== undefined &&
      parent !== null &&
      parent !== 0 &&
      parent !== (RootEntity as number) &&
      parent !== (PlayerEntity as number) &&
      parent !== (CameraEntity as number) &&
      (parent as number) === (lookAt as number) &&
      lookAt !== (virtualEntity as number) &&
      lookAt !== (CameraEntity as number)

    if (isPeFollowShape) {
      const player = this.playerPose()
      const wx = player.position.x + local.position.x
      const wy = player.position.y + local.position.y
      const wz = player.position.z + local.position.z
      dclToThreePos(wx, wy, wz, _targetPos)
      // Aim at the follow parent (lookAtEntity) — usually PE/cameraParent at the player.
      dclToThreePos(player.position.x, player.position.y, player.position.z, _lookAtPoint)
      if (cameraLookAtQuat(_targetPos, _lookAtPoint, _targetQuat)) {
        if (vcDebugVerbose()) {
          const now = performance.now()
          if (now - lastFollowDiagMs > 2000) {
            lastFollowDiagMs = now
            clientDebugLog.log(
              'vc-lens',
              `PE-follow rig vc=e${virtualEntity} parent=e${parent} pe=(${player.position.x.toFixed(1)},${player.position.y.toFixed(1)},${player.position.z.toFixed(1)}) ` +
                `local=(${local.position.x.toFixed(1)},${local.position.y.toFixed(1)},${local.position.z.toFixed(1)}) ` +
                `lensThree=(${_targetPos.x.toFixed(1)},${_targetPos.y.toFixed(1)},${_targetPos.z.toFixed(1)})`,
              { alsoConsole: true, throttleMs: 2000, throttleKey: 'vc-pe-follow' }
            )
          }
        }
        return { position: _targetPos, rotation: _targetQuat, lookAtPoint: _lookAtPoint }
      }
    }

    // Scene-authored hierarchy: world pose from Transform parent chain (VC may be a child of
    // a lookAt/follow entity that tracks the player — Angzaar-style — or a root-level shot).
    if (
      !resolveEntityWorldPose(virtualEntity, this.worldDeps(), {
        position: _targetPos,
        rotation: _entityDisplayQuat
      })
    ) {
      return null
    }

    // VirtualCamera.lookAtEntity — aim at that entity's world position every frame.
    if (
      lookAt !== undefined &&
      lookAt !== null &&
      lookAt !== (virtualEntity as number) &&
      lookAt !== (CameraEntity as number)
    ) {
      const targetWorld = resolveEntityWorldPose(lookAt as Entity, this.worldDeps())
      if (targetWorld) {
        // Plaza reveal `vp` is created at (0,-1,1) and only later tweened to the
        // catch / player. Aiming at that spawn pose pulls the lens through the floor.
        const playerY = this.playerPose().position.y
        const lookY = targetWorld.position.y
        const lookAtReady = !(lookY < -0.25 && playerY > 0.4)
        if (lookAtReady && cameraLookAtQuat(_targetPos, targetWorld.position, _targetQuat)) {
          _lookAtPoint.copy(targetWorld.position)
          return { position: _targetPos, rotation: _targetQuat, lookAtPoint: _lookAtPoint }
        }
      }
    }

    // No lookAtEntity: scene drives aim via Transform rotation (entity +Z = look, DCL/Unity).
    // Map to Three by aiming along display-space +Z (avoids euler→camera-quat pitch flips).
    _lookDir.set(0, 0, 1).applyQuaternion(_entityDisplayQuat)
    if (_lookDir.lengthSq() < 1e-12) {
      entityDisplayQuatToThreeCameraQuat(_entityDisplayQuat, _targetQuat)
      return { position: _targetPos, rotation: _targetQuat }
    }
    _lookDir.normalize()
    _lookAtPoint.copy(_targetPos).addScaledVector(_lookDir, 8)
    if (!cameraLookAtQuat(_targetPos, _lookAtPoint, _targetQuat)) {
      entityDisplayQuatToThreeCameraQuat(_entityDisplayQuat, _targetQuat)
      return { position: _targetPos, rotation: _targetQuat }
    }
    return { position: _targetPos, rotation: _targetQuat, lookAtPoint: _lookAtPoint }
  }

  private beginTransition(camera: THREE.Camera, virtualEntity: Entity, target: TargetPose): void {
    const spec = this.ecs.VirtualCamera.get(virtualEntity) as PBVirtualCamera
    const duration = resolveTransitionDuration(spec.defaultTransition, camera.position, target.position)
    if (duration <= 0) {
      this.transition = null
      return
    }

    const useLookAt = !!target.lookAtPoint
    // Seed fromLookAt along current camera -Z so lookAt transitions don't spin.
    let fromLookAt: THREE.Vector3 | undefined
    if (useLookAt && target.lookAtPoint) {
      fromLookAt = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(camera.quaternion)
        .multiplyScalar(8)
        .add(camera.position)
    }

    this.transition = {
      fromPos: camera.position.clone(),
      fromQuat: camera.quaternion.clone(),
      toPos: target.position.clone(),
      toQuat: target.rotation.clone(),
      fromLookAt,
      toLookAt: target.lookAtPoint?.clone(),
      useLookAt,
      duration,
      elapsed: 0
    }
    if (vcDebugVerbose()) {
      console.info(
        `[vc-lens] bind transition vc=e${virtualEntity} duration=${duration.toFixed(2)}s jump=${camera.position.distanceTo(target.position).toFixed(1)}m lookAt=${useLookAt}`
      )
    }
  }
}

/**
 * Build camera quaternion: local -Z aims at target, world +Y up (roll-free).
 * Matches THREE.Matrix4.lookAt / PerspectiveCamera.lookAt basis exactly:
 *   z = eye - target  (camera looks down -Z ⇒ +Z points toward eye from target)
 *   x = up × z
 *   y = z × x
 */
function cameraLookAtQuat(
  eye: THREE.Vector3,
  target: THREE.Vector3,
  out: THREE.Quaternion
): boolean {
  // +Z = from target toward eye (= -lookDir)
  _camZ.subVectors(eye, target)
  if (_camZ.lengthSq() < 1e-12) return false
  _camZ.normalize()
  // +X = up × z
  _lookRight.crossVectors(_worldUp, _camZ)
  if (_lookRight.lengthSq() < 1e-12) {
    // look parallel to up — nudge like Three.Matrix4.lookAt
    if (Math.abs(_worldUp.z) === 1) _camZ.x += 1e-4
    else _camZ.z += 1e-4
    _camZ.normalize()
    _lookRight.crossVectors(_worldUp, _camZ)
  }
  _lookRight.normalize()
  // +Y = z × x
  _lookUp.crossVectors(_camZ, _lookRight)
  _lookMat.makeBasis(_lookRight, _lookUp, _camZ)
  out.setFromRotationMatrix(_lookMat)
  return true
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