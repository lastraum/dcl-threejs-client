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
const _lerpPos = new THREE.Vector3()
const _lerpQuat = new THREE.Quaternion()
const _lookDir = new THREE.Vector3()
const _lookMat = new THREE.Matrix4()
const _worldUp = new THREE.Vector3(0, 1, 0)
const _followPos = new THREE.Vector3()
const _gizmoWorld = new THREE.Vector3()
const _gizmoWorldQuat = new THREE.Quaternion()
let lastFollowDiagMs = 0
let lastApplyDiagMs = 0

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
      // No distance heuristics — missing or zero-duration transition = instant cut.
      this.beginTransition(camera, virtualEntity, target)
      if (!this.transition) {
        camera.position.copy(target.position)
        camera.quaternion.copy(target.rotation)
      }
      this.activeEntity = virtualEntity
      if (vcDebugVerbose()) {
        this.emitParityReport('VIEW SHOT bind', virtualEntity, resolved, true)
        this.parityFramesAfterBind = 120
      }
    }

    if (this.transition) {
      // Follow / lookAt targets keep moving (CameraFollowSystem). Retarget end pose each frame.
      this.transition.toPos.copy(target.position)
      this.transition.toQuat.copy(target.rotation)
      this.transition.elapsed += delta
      const u = Math.min(1, this.transition.elapsed / Math.max(this.transition.duration, 1e-6))
      // Smoothstep — Explorer-style ease in/out (proto has no easing field yet).
      const t = u * u * (3 - 2 * u)
      _lerpPos.copy(this.transition.fromPos).lerp(this.transition.toPos, t)
      _lerpQuat.copy(this.transition.fromQuat).slerp(this.transition.toQuat, t)
      camera.position.copy(_lerpPos)
      camera.quaternion.copy(_lerpQuat)
      if (u >= 1) this.transition = null
    } else {
      // Locked/world-flat shots: hold last pose on huge teleports (stale CRDT during FPS hitch).
      // PE-follow keeps parent≠Root and may legitimately jump on movePlayerTo — do not hold those.
      const localTr = this.ecs.Transform.getOrNull(virtualEntity) as { parent?: number } | null
      const parent = localTr?.parent
      const worldFlat =
        parent === undefined ||
        parent === null ||
        parent === 0 ||
        parent === (this.view.RootEntity as number)
      const jumpM = camera.position.distanceTo(target.position)
      if (!bindChanged && worldFlat && jumpM > 25) {
        return true
      }
      camera.position.copy(target.position)
      camera.quaternion.copy(target.rotation)
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
    return entity === undefined || entity === null ? null : (entity as Entity)
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

  private computeTargetPose(virtualEntity: Entity): { position: THREE.Vector3; rotation: THREE.Quaternion } | null {
    const spec = this.ecs.VirtualCamera.get(virtualEntity) as PBVirtualCamera
    const local = this.ecs.Transform.getOrNull(virtualEntity) as DclTransformValues | null
    if (!local) return null

    const lookAt = spec.lookAtEntity
    const parent = local.parent as number | undefined
    const { RootEntity, PlayerEntity, CameraEntity } = this.view

    // Classic third-person: parent === lookAt === cameraParent. Always f(PE)+local on main —
    // never fall back to lagging cameraParent CRDT (FPS hitch → flicker to stale map).
    // Select/cinematic shots use lookAt unset or worldFlattened hydrate (not this shape).
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
      // Anchor at PE (DCL); CameraFollow only moves parent position (identity rot).
      const wx = player.position.x + local.position.x
      const wy = player.position.y + local.position.y
      const wz = player.position.z + local.position.z
      dclToThreePos(wx, wy, wz, _targetPos)
      dclToThreePos(player.position.x, player.position.y, player.position.z, _followPos)
      if (cameraLookAtQuat(_targetPos, _followPos, _targetQuat)) {
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
        return { position: _targetPos, rotation: _targetQuat }
      }
    }

    if (
      !resolveEntityWorldPose(virtualEntity, this.worldDeps(), {
        position: _targetPos,
        rotation: _targetQuat
      })
    ) {
      return null
    }

    // lookAtEntity owns full lens orientation (yaw + pitch, world-up roll) — not Z-only.
    if (
      lookAt !== undefined &&
      lookAt !== null &&
      lookAt !== (virtualEntity as number) &&
      lookAt !== (CameraEntity as number)
    ) {
      const targetWorld = resolveEntityWorldPose(lookAt as Entity, this.worldDeps())
      if (targetWorld && cameraLookAtQuat(_targetPos, targetWorld.position, _targetQuat)) {
        return { position: _targetPos, rotation: _targetQuat }
      }
    }

    // No lookAt (or coincident points) — use entity world rotation as camera facing.
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
    if (vcDebugVerbose()) {
      console.info(
        `[vc-lens] bind transition vc=e${virtualEntity} duration=${duration.toFixed(2)}s jump=${camera.position.distanceTo(target.position).toFixed(1)}m`
      )
    }
  }
}

/**
 * Full-axis camera aim: PerspectiveCamera looks down -Z toward `target`, with world +Y up
 * (yaw + pitch; roll stays upright). Returns false when eye ≈ target (undefined direction).
 */
function cameraLookAtQuat(
  eye: THREE.Vector3,
  target: THREE.Vector3,
  out: THREE.Quaternion
): boolean {
  _lookDir.subVectors(target, eye)
  if (_lookDir.lengthSq() < 1e-12) return false
  // Camera convention: eye→target with -Z forward (same basis Object3D uses for isCamera).
  _lookMat.lookAt(eye, target, _worldUp)
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