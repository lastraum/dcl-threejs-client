import * as THREE from 'three'
import { Easing } from '@tweenjs/tween.js'
import type { Entity } from '@dcl/ecs'
import type { PBTween } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/tween.gen'
import {
  applyDclLocalTransform,
  dclYawToThreeYaw,
  threeToDclQuat,
  type DclTransformValues
} from './dclTransform'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import type { EntityStore } from './EntityStore'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'
import { isTweenVerbose } from './tweenConfig'
import { isInBlimpSubtree, isMotionFocusActive } from './motionFocus'

type Vec2 = { x: number; y: number }
type Vec3 = { x: number; y: number; z: number }
type Quat = { x: number; y: number; z: number; w: number }

type TweenRuntime = {
  signature: string
  completed: boolean
  /** Local progress tracker (0–1 for finite tweens). */
  progress: number
  /** Accumulated UV for textureMoveContinuous. */
  textureUv?: Vec2
  /** Cached texture targets — avoids per-frame Object3D traverse. */
  textureTargets?: THREE.Texture[]
  /** Reset progress on the frame after signature change. */
  justReset?: boolean
  /** Verbose — last TweenState.state written (0 active / 1 completed / 2 paused). */
  lastLoggedState?: number
  /** Verbose — last progress milestone logged (0, 0.25, 0.5, 0.75, 1). */
  lastProgressMilestone?: number
}

const TWEEN_STATE_LABEL = ['active', 'completed', 'paused'] as const

const _v3a = new THREE.Vector3()
const _qA = new THREE.Quaternion()
const _qB = new THREE.Quaternion()
const _qOut = new THREE.Quaternion()
const _euler = new THREE.Euler(0, 0, 0, 'YXZ')
const _scratchTransform: DclTransformValues = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
  parent: 0 as Entity
}
/** Matches `TextureMovementType.TMT_TILING` (const enum — use literal under isolatedModules). */
const TMT_TILING = 1

const EASING: Array<(t: number) => number> = [
  Easing.Linear.None,
  Easing.Quadratic.In,
  Easing.Quadratic.Out,
  Easing.Quadratic.InOut,
  Easing.Sinusoidal.In,
  Easing.Sinusoidal.Out,
  Easing.Sinusoidal.InOut,
  Easing.Exponential.In,
  Easing.Exponential.Out,
  Easing.Exponential.InOut,
  Easing.Elastic.In,
  Easing.Elastic.Out,
  Easing.Elastic.InOut,
  Easing.Bounce.In,
  Easing.Bounce.Out,
  Easing.Bounce.InOut,
  Easing.Cubic.In,
  Easing.Cubic.Out,
  Easing.Cubic.InOut,
  Easing.Quartic.In,
  Easing.Quartic.Out,
  Easing.Quartic.InOut,
  Easing.Quintic.In,
  Easing.Quintic.Out,
  Easing.Quintic.InOut,
  Easing.Circular.In,
  Easing.Circular.Out,
  Easing.Circular.InOut,
  Easing.Back.In,
  Easing.Back.Out,
  Easing.Back.InOut
]

function copyVec3(dst: Vec3, src: Vec3): void {
  dst.x = src.x
  dst.y = src.y
  dst.z = src.z
}

function copyQuat(dst: Quat, src: Quat): void {
  dst.x = src.x
  dst.y = src.y
  dst.z = src.z
  dst.w = src.w
}

function copyTransform(dst: DclTransformValues, src: DclTransformValues): void {
  copyVec3(dst.position, src.position)
  copyQuat(dst.rotation, src.rotation)
  copyVec3(dst.scale, src.scale)
  dst.parent = src.parent
}

function lerpVec2(a: Vec2, b: Vec2, t: number): Vec2 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t
  }
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t
  }
}

function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  _qA.set(a.x, a.y, a.z, a.w)
  _qB.set(b.x, b.y, b.z, b.w)
  _qOut.copy(_qA).slerp(_qB, t)
  return { x: _qOut.x, y: _qOut.y, z: _qOut.z, w: _qOut.w }
}

function applyEasing(fn: number, t: number): number {
  const easing = EASING[fn] ?? EASING[0]
  return easing(Math.min(1, Math.max(0, t)))
}

function tweenSignature(tween: PBTween): string {
  return JSON.stringify({
    duration: tween.duration,
    easingFunction: tween.easingFunction,
    mode: tween.mode,
    playing: tween.playing
  })
}

function isContinuousMode(mode: PBTween['mode']): boolean {
  const kind = mode?.$case
  return (
    kind === 'moveContinuous' ||
    kind === 'rotateContinuous' ||
    kind === 'textureMoveContinuous'
  )
}

function isTextureMode(mode: PBTween['mode']): boolean {
  const kind = mode?.$case
  return kind === 'textureMove' || kind === 'textureMoveContinuous'
}

function collectMeshTextures(mesh: THREE.Mesh): THREE.Texture[] {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const out: THREE.Texture[] = []
  for (const mat of materials) {
    if (!mat) continue
    if (mat instanceof THREE.MeshStandardMaterial) {
      if (mat.map) out.push(mat.map)
      if (mat.emissiveMap) out.push(mat.emissiveMap)
      if (mat.alphaMap) out.push(mat.alphaMap)
    } else if (mat instanceof THREE.MeshBasicMaterial) {
      if (mat.map) out.push(mat.map)
      if (mat.alphaMap) out.push(mat.alphaMap)
    }
  }
  return out
}

function collectTextureTargets(root: THREE.Object3D): THREE.Texture[] {
  const out: THREE.Texture[] = []
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    out.push(...collectMeshTextures(child))
  })
  return out
}

function ensureRepeatWrapping(tex: THREE.Texture): void {
  if (tex.wrapS !== THREE.RepeatWrapping || tex.wrapT !== THREE.RepeatWrapping) {
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.needsUpdate = true
  }
}

function applyTextureUvToTargets(targets: THREE.Texture[], uv: Vec2, movementType?: number): void {
  const tiling = movementType === TMT_TILING
  for (const tex of targets) {
    ensureRepeatWrapping(tex)
    if (tiling) {
      tex.repeat.set(uv.x, uv.y)
    } else {
      tex.offset.set(uv.x, uv.y)
    }
  }
}

function readTextureUvFromTargets(targets: THREE.Texture[], movementType?: number): Vec2 | null {
  const tex = targets[0]
  if (!tex) return null
  if (movementType === TMT_TILING) {
    return { x: tex.repeat.x, y: tex.repeat.y }
  }
  return { x: tex.offset.x, y: tex.offset.y }
}

function tweenModeLabel(tween: PBTween): string {
  return tween.mode?.$case ?? 'unknown'
}

function tweenStateLabel(state: number): string {
  return TWEEN_STATE_LABEL[state] ?? `state:${state}`
}

function progressMilestone(progress: number): number {
  return Math.min(1, Math.floor(progress * 4) / 4)
}

function formatTweenProgress(progress: number): string {
  return `${(progress * 100).toFixed(1)}%`
}

function faceMoveDirection(
  transform: DclTransformValues,
  start: Vec3,
  end: Vec3,
  t: number
): void {
  if (t <= 0) return
  const dx = end.x - start.x
  const dz = end.z - start.z
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return
  const yaw = Math.atan2(dx, dz)
  _euler.set(0, dclYawToThreeYaw(yaw), 0)
  _qOut.setFromEuler(_euler)
  const dclQ = threeToDclQuat(_qOut)
  transform.rotation = { x: dclQ.x, y: dclQ.y, z: dclQ.z, w: dclQ.w }
}

/**
 * ECS `Tween` → EntityStore pose + material UV interpolation.
 * Writes `TweenState` (+ interpolated `Transform`) back to the mirror for worker `tweenCompleted()`.
 *
 * SDK parity: `@dcl/ecs` `createTweenSystem()` reads `TweenState.state` (0 active / 1 completed / 2 paused)
 * and `currentTime` (0–1 progress) to fire `tweenCompleted()` and advance `TweenSequence` yoyo/restart.
 */
export class TweenBridge {
  private readonly runtime = new Map<Entity, TweenRuntime>()
  /** Entities whose TweenState/Transform changed this frame — scopes CrdtEncoder tween scan. */
  private readonly encodeDirty = new Set<Entity>()
  private readonly verbose = isTweenVerbose()
  private motionFocusView: ProjectionView | null = null

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly store: EntityStore
  ) {
    if (this.verbose) {
      const hint = isMotionFocusActive()
        ? 'Motion focus — filtered tween logs (?blimpdebug or ?motionfocus=pattern)'
        : 'Tween verbose — logging TweenState + progress (?tweenverbose)'
      clientDebugLog.log('motion', hint, { level: 'info', alsoConsole: true })
    }
  }

  private logTween(
    message: string,
    options: { level?: 'info' | 'warn' | 'success'; throttleMs?: number; entity?: Entity } = {}
  ): void {
    if (!this.verbose) return
    if (
      isMotionFocusActive() &&
      options.entity !== undefined &&
      this.motionFocusView &&
      !isInBlimpSubtree(options.entity, this.ecs, this.motionFocusView)
    ) {
      return
    }
    const key = options.entity !== undefined ? `tween:${options.entity}` : 'tween'
    clientDebugLog.log('motion', message, {
      level: options.level ?? 'info',
      throttleKey: key,
      throttleMs: options.throttleMs,
      alsoConsole: true
    })
  }

  /** True when `TweenState` / tween `Transform` changed since the last consume. */
  hasEncodeDirty(): boolean {
    return this.encodeDirty.size > 0
  }

  /** Consume and clear encoder dirty set (call before `CrdtEncoder.encode()`). */
  consumeEncodeDirty(): ReadonlySet<Entity> {
    const out = new Set(this.encodeDirty)
    this.encodeDirty.clear()
    return out
  }

  sync(view: ProjectionView): void {
    this.motionFocusView = view
    const { Tween } = this.ecs
    const active = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(Tween)) {
      active.add(entity)
      const tween = Tween.get(entity)
      const signature = tweenSignature(tween)
      const prev = this.runtime.get(entity)
      if (!prev || prev.signature !== signature) {
        const node = this.store.getNode(entity)
        const progress = tween.currentTime ?? 0
        this.runtime.set(entity, {
          signature,
          completed: false,
          progress,
          textureUv: undefined,
          textureTargets: node && isTextureMode(tween.mode) ? collectTextureTargets(node) : undefined,
          justReset: true,
          lastLoggedState: undefined,
          lastProgressMilestone: undefined
        })
        this.logTween(
          `Tween reset — entity ${entity} · ${tweenModeLabel(tween)} · duration ${tween.duration}ms · progress ${formatTweenProgress(progress)} · playing ${tween.playing !== false}`,
          { entity }
        )
      }
    }

    for (const entity of this.runtime.keys()) {
      if (!active.has(entity)) {
        this.runtime.delete(entity)
        this.logTween(`Tween removed — entity ${entity}`, { entity })
      }
    }
  }

  update(delta: number, view: ProjectionView): void {
    this.motionFocusView = view
    const { Tween, TweenState, Transform, AvatarAttach } = this.ecs

    for (const [entity, tween] of view.getEntitiesWith(Tween)) {
      const runtime = this.runtime.get(entity)
      if (runtime?.completed) continue

      if (AvatarAttach.has(entity)) {
        this.logTween(`Tween skip — entity ${entity} has AvatarAttach`, { entity, throttleMs: 2000 })
        continue
      }
      const node = this.store.getNode(entity)
      if (!node) {
        this.logTween(`Tween warn — entity ${entity} has no EntityStore node (TweenState still written)`, {
          entity,
          throttleMs: 2000,
          level: 'warn'
        })
      }

      const playing = tween.playing !== false
      const continuous = isContinuousMode(tween.mode)
      const textureMode = isTextureMode(tween.mode)
      const durationSec = Math.max(tween.duration / 1000, 0)

      let progress = runtime?.progress ?? tween.currentTime ?? 0
      if (runtime?.justReset) {
        progress = runtime.progress
        runtime.justReset = false
      }
      if (runtime && !runtime.completed && playing) {
        if (!continuous && durationSec > 0) {
          progress = Math.min(1, progress + delta / durationSec)
        }
      }
      if (runtime) runtime.progress = progress

      const eased = applyEasing(tween.easingFunction ?? 0, progress)
      let applied = false

      if (node) {
        if (textureMode) {
          applied = this.applyTextureTween(node, tween, runtime, delta, eased, playing)
        } else if (Transform.has(entity)) {
          applied = this.applyTransformTween(
            entity,
            tween,
            Transform.get(entity),
            node,
            eased,
            playing,
            delta
          )
        }
      }

      const completed =
        !continuous && durationSec > 0 && playing && progress >= 1 && !runtime?.completed
      if (runtime && completed) runtime.completed = true

      const state = !playing ? 2 : completed || (!continuous && durationSec > 0 && progress >= 1) ? 1 : 0

      TweenState.createOrReplace(entity, { state, currentTime: progress })
      this.encodeDirty.add(entity)
      this.logTweenState(entity, tween, state, progress, continuous)

      if (!applied && !textureMode) {
        this.logTween(
          `Tween visual skip — entity ${entity} · ${tweenModeLabel(tween)} (no node or Transform)`,
          { entity, throttleMs: 1500, level: 'warn' }
        )
      }
    }
  }

  private logTweenState(
    entity: Entity,
    tween: PBTween,
    state: number,
    progress: number,
    continuous: boolean
  ): void {
    if (!this.verbose) return
    const runtime = this.runtime.get(entity)
    const mode = tweenModeLabel(tween)
    const prevState = runtime?.lastLoggedState
    if (prevState !== state) {
      if (runtime) runtime.lastLoggedState = state
      const level = state === 1 ? 'success' : state === 2 ? 'warn' : 'info'
      this.logTween(
        `TweenState ${tweenStateLabel(state)} — entity ${entity} · ${mode} · currentTime ${formatTweenProgress(progress)}`,
        { entity, level }
      )
    }
    if (state !== 0 || continuous) return
    const milestone = progressMilestone(progress)
    if (runtime && runtime.lastProgressMilestone === milestone) return
    if (runtime) runtime.lastProgressMilestone = milestone
    this.logTween(
      `Tween progress — entity ${entity} · ${mode} · ${formatTweenProgress(progress)}`,
      { entity, throttleMs: 400 }
    )
  }

  private applyTextureTween(
    node: THREE.Object3D,
    tween: PBTween,
    runtime: TweenRuntime | undefined,
    delta: number,
    eased: number,
    playing: boolean
  ): boolean {
    let targets = runtime?.textureTargets
    if (!targets?.length) {
      targets = collectTextureTargets(node)
      if (runtime) runtime.textureTargets = targets
    }
    if (!targets.length) return false

    switch (tween.mode?.$case) {
      case 'textureMove': {
        const { start, end, movementType } = tween.mode.textureMove
        if (!start || !end) return false
        const uv = lerpVec2(start, end, eased)
        applyTextureUvToTargets(targets, uv, movementType)
        if (runtime) runtime.textureUv = uv
        return true
      }
      case 'textureMoveContinuous': {
        const { direction, speed, movementType } = tween.mode.textureMoveContinuous
        if (!direction || !playing) return false
        let uv = runtime?.textureUv
        if (!uv) {
          uv = readTextureUvFromTargets(targets, movementType) ?? { x: 0, y: 0 }
        }
        const step = speed * delta
        uv = {
          x: uv.x + direction.x * step,
          y: uv.y + direction.y * step
        }
        applyTextureUvToTargets(targets, uv, movementType)
        if (runtime) runtime.textureUv = uv
        return true
      }
      default:
        return false
    }
  }

  private applyTransformTween(
    entity: Entity,
    tween: PBTween,
    baseTransform: DclTransformValues,
    node: THREE.Group,
    eased: number,
    playing: boolean,
    delta: number
  ): boolean {
    copyTransform(_scratchTransform, baseTransform)
    let applied = false

    switch (tween.mode?.$case) {
      case 'move': {
        const { start, end, faceDirection } = tween.mode.move
        if (start && end) {
          _scratchTransform.position = lerpVec3(start, end, eased)
          if (faceDirection) faceMoveDirection(_scratchTransform, start, end, eased)
          applied = true
        }
        break
      }
      case 'rotate': {
        const { start, end } = tween.mode.rotate
        if (start && end) {
          _scratchTransform.rotation = slerpQuat(start, end, eased)
          applied = true
        }
        break
      }
      case 'scale': {
        const { start, end } = tween.mode.scale
        if (start && end) {
          _scratchTransform.scale = lerpVec3(start, end, eased)
          applied = true
        }
        break
      }
      case 'moveRotateScale': {
        const m = tween.mode.moveRotateScale
        if (m.positionStart && m.positionEnd) {
          _scratchTransform.position = lerpVec3(m.positionStart, m.positionEnd, eased)
          applied = true
        }
        if (m.rotationStart && m.rotationEnd) {
          _scratchTransform.rotation = slerpQuat(m.rotationStart, m.rotationEnd, eased)
          applied = true
        }
        if (m.scaleStart && m.scaleEnd) {
          _scratchTransform.scale = lerpVec3(m.scaleStart, m.scaleEnd, eased)
          applied = true
        }
        break
      }
      case 'moveContinuous': {
        const { direction, speed } = tween.mode.moveContinuous
        if (direction && playing) {
          const step = speed * delta
          _scratchTransform.position = {
            x: _scratchTransform.position.x + direction.x * step,
            y: _scratchTransform.position.y + direction.y * step,
            z: _scratchTransform.position.z + direction.z * step
          }
          applied = true
        }
        break
      }
      case 'rotateContinuous': {
        const { direction, speed } = tween.mode.rotateContinuous
        if (direction && playing) {
          _qA.set(direction.x, direction.y, direction.z, direction.w).normalize()
          _v3a.set(_qA.x, _qA.y, _qA.z)
          if (_v3a.lengthSq() < 1e-8) _v3a.set(0, 1, 0)
          _v3a.normalize()
          _qB.setFromAxisAngle(_v3a, speed * delta)
          _qA.set(
            _scratchTransform.rotation.x,
            _scratchTransform.rotation.y,
            _scratchTransform.rotation.z,
            _scratchTransform.rotation.w
          )
          _qOut.copy(_qB).multiply(_qA)
          _scratchTransform.rotation = { x: _qOut.x, y: _qOut.y, z: _qOut.z, w: _qOut.w }
          applied = true
        }
        break
      }
      default:
        break
    }

    if (!applied) return false

    this.ecs.Transform.createOrReplace(entity, {
      position: { ..._scratchTransform.position },
      rotation: { ..._scratchTransform.rotation },
      scale: { ..._scratchTransform.scale },
      parent: _scratchTransform.parent
    })
    applyDclLocalTransform(node, _scratchTransform)
    return true
  }
}