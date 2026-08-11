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
import { isMarqueeVerbose, isTweenVerbose } from './tweenConfig'
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
  /** Encode dirty once per completion (tweenCompleted / sequence advance). */
  completedDirtySent?: boolean
  /** Last TweenState.state written to mirror (dedupe encodeDirty). */
  lastWrittenState?: number
  /** Last progress written to TweenState (dedupe encodeDirty). */
  lastWrittenProgress?: number
  /**
   * performance.now() deadline: pin textureMove end UV between NeonScreen rows.
   * Genesis pauseDuration=0.5s (wall). Next TextureMove is deferred until this time.
   */
  textureHoldUntil?: number
  /** DCL-space end UV frozen during / after hold until next row adopts. */
  textureHoldUv?: Vec2
  textureHoldMovementType?: number
  /**
   * Plaza LED row (discrete textureMove step). While scrolling or holding, ignore
   * createOrReplace of the next row — scene clock often fires the next step early.
   */
  marqueeRow?: boolean
  /** Snapshot of the active row — used when ECS already replaced Tween with the next step. */
  marqueeStart?: Vec2
  marqueeEnd?: Vec2
  marqueeDurationSec?: number
  marqueeEasing?: number
  /** Verbose — last TweenState.state written (0 active / 1 completed / 2 paused). */
  lastLoggedState?: number
  /** Verbose — last progress milestone logged (0, 0.25, 0.5, 0.75, 1). */
  lastProgressMilestone?: number
  /** Marquee debug — last hold phase logged. */
  lastHoldLogPhase?: 'holding' | 'expired' | 'armed' | 'defer-scroll'
  /**
   * Client-driven sequence cycle (TL_RESTART / multi-leg). Keeps visuals moving when
   * worker TweenSequence stalls (settings hitch, missed COMPLETED inject).
   * Cleared when CRDT delivers a real new Tween signature.
   */
  localLoop?: {
    legs: PBTween[]
    index: number
  }
}

const TWEEN_STATE_LABEL = ['active', 'completed', 'paused'] as const

/**
 * Genesis NeonScreen (bin/index.js):
 *   pauseDuration = 0.5s, scrollDuration = 1s
 *   state 0: elapsed += dt until pauseDuration → create TextureMove(duration=scroll*1000)
 *   state 1: elapsed += dt until scrollDuration → back to pause
 * Pause is pure wall-clock in addSystem — NOT tweenCompleted. Worker scene-time often
 * races ahead and createOrReplace's the next TextureMove while the client is still
 * scrolling (or mid-hold). Client must finish the current row + wall-clock pause before
 * adopting the next signature.
 */
const NEON_SCREEN_PAUSE_MS = 500

const _v3a = new THREE.Vector3()
const _qA = new THREE.Quaternion()
const _qB = new THREE.Quaternion()
const _qOut = new THREE.Quaternion()
const _yAxis = new THREE.Vector3(0, 1, 0)
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

/**
 * Interpolate rotation for Tween.rotate.
 * Pure Y spins (Genesis blimp 0→180→360): Euler 360° serializes as identity (=0°), so
 * short-path slerp would reverse the second leg. Prefer continuous yaw (unwrap, +π when
 * exactly 180°) so full-orbit sequences keep spinning the same way.
 */
function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  _qA.set(a.x, a.y, a.z, a.w).normalize()
  _qB.set(b.x, b.y, b.z, b.w).normalize()
  // Horizontal yaw-dominant: |x|,|z| small on both ends.
  const yawOnly =
    Math.abs(_qA.x) < 0.08 &&
    Math.abs(_qA.z) < 0.08 &&
    Math.abs(_qB.x) < 0.08 &&
    Math.abs(_qB.z) < 0.08
  if (yawOnly) {
    const yawA = 2 * Math.atan2(_qA.y, _qA.w)
    const yawB = 2 * Math.atan2(_qB.y, _qB.w)
    let d = yawB - yawA
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    // Exactly half-turn: short path is ambiguous. Authored 180°→360° becomes 180°→identity
    // after quat bake — take +180° so GP blimp keeps orbiting the same way (not reverse).
    if (Math.abs(Math.abs(d) - Math.PI) < 1e-3) {
      const endIsIdentity = Math.abs(_qB.w) > 0.99
      const startIsHalfY = Math.abs(_qA.y) > 0.99
      d = endIsIdentity && startIsHalfY ? Math.PI : d >= 0 ? Math.PI : -Math.PI
    }
    const yaw = yawA + d * t
    _qOut.setFromAxisAngle(_yAxis, yaw)
    return { x: _qOut.x, y: _qOut.y, z: _qOut.z, w: _qOut.w }
  }
  _qOut.copy(_qA).slerp(_qB, t)
  return { x: _qOut.x, y: _qOut.y, z: _qOut.z, w: _qOut.w }
}

function applyEasing(fn: number, t: number): number {
  const easing = EASING[fn] ?? EASING[0]
  return easing(Math.min(1, Math.max(0, t)))
}

/** Stable float key — CRDT float noise must not thrash TextureMove signatures. */
function r4(n: number | undefined | null): number | null {
  if (n == null || !Number.isFinite(n)) return null
  return Math.round(n * 1e4) / 1e4
}

function vec2Key(v?: { x?: number; y?: number } | null): { x: number; y: number } | null {
  if (!v) return null
  return { x: r4(v.x) ?? 0, y: r4(v.y) ?? 0 }
}

function quatKey(q?: Quat | null): Quat | null {
  if (!q) return null
  return {
    x: r4(q.x) ?? 0,
    y: r4(q.y) ?? 0,
    z: r4(q.z) ?? 0,
    w: r4(q.w) ?? 1
  }
}

function vec3Key(v?: Vec3 | null): Vec3 | null {
  if (!v) return null
  return { x: r4(v.x) ?? 0, y: r4(v.y) ?? 0, z: r4(v.z) ?? 0 }
}

function tweenSignature(tween: PBTween): string {
  // Do NOT include `playing` — false→true during pause must not wipe progress/completed.
  // Normalize mode + round floats so CRDT identity/noise cannot thrash the signature.
  const mode = tween.mode
  let modeKey: unknown = mode
  if (mode?.$case === 'textureMove' && mode.textureMove) {
    const tm = mode.textureMove
    modeKey = {
      $case: 'textureMove',
      start: vec2Key(tm.start),
      end: vec2Key(tm.end),
      movementType: tm.movementType ?? 0
    }
  } else if (mode?.$case === 'textureMoveContinuous' && mode.textureMoveContinuous) {
    const tm = mode.textureMoveContinuous
    modeKey = {
      $case: 'textureMoveContinuous',
      direction: vec2Key(tm.direction),
      speed: r4(tm.speed),
      movementType: tm.movementType ?? 0
    }
  } else if (mode?.$case === 'rotate' && mode.rotate) {
    // Genesis blimp: sequence legs 0→180 / 180→360 must differ so TL_RESTART restarts.
    modeKey = {
      $case: 'rotate',
      start: quatKey(mode.rotate.start as Quat | undefined),
      end: quatKey(mode.rotate.end as Quat | undefined)
    }
  } else if (mode?.$case === 'move' && mode.move) {
    modeKey = {
      $case: 'move',
      start: vec3Key(mode.move.start as Vec3 | undefined),
      end: vec3Key(mode.move.end as Vec3 | undefined)
    }
  } else if (mode?.$case === 'scale' && mode.scale) {
    modeKey = {
      $case: 'scale',
      start: vec3Key(mode.scale.start as Vec3 | undefined),
      end: vec3Key(mode.scale.end as Vec3 | undefined)
    }
  }
  return JSON.stringify({
    duration: r4(tween.duration) ?? 0,
    easingFunction: tween.easingFunction ?? 0,
    mode: modeKey
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

function cloneTween(tween: PBTween): PBTween {
  return JSON.parse(JSON.stringify(tween)) as PBTween
}

/** TweenLoop.TL_RESTART = 0, TL_YOYO = 1 */
function isSequenceRestartLoop(loop: number | undefined): boolean {
  return loop === 0
}

function isSequenceYoyoLoop(loop: number | undefined): boolean {
  return loop === 1
}

function backwardsTween(tween: PBTween): PBTween {
  const next = cloneTween(tween)
  const mode = next.mode
  if (mode?.$case === 'move' && mode.move) {
    const s = mode.move.start
    mode.move.start = mode.move.end
    mode.move.end = s
  } else if (mode?.$case === 'rotate' && mode.rotate) {
    const s = mode.rotate.start
    mode.rotate.start = mode.rotate.end
    mode.rotate.end = s
  } else if (mode?.$case === 'scale' && mode.scale) {
    const s = mode.scale.start
    mode.scale.start = mode.scale.end
    mode.scale.end = s
  } else if (mode?.$case === 'textureMove' && mode.textureMove) {
    const s = mode.textureMove.start
    mode.textureMove.start = mode.textureMove.end
    mode.textureMove.end = s
  }
  return next
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

/** True when every cached target is still referenced by a mesh under `root`. */
function textureTargetsLive(root: THREE.Object3D, targets: THREE.Texture[]): boolean {
  if (!targets.length) return false
  const live = new Set(collectTextureTargets(root))
  for (const t of targets) {
    if (!live.has(t)) return false
  }
  return true
}

function ensureRepeatWrapping(tex: THREE.Texture): void {
  if (tex.wrapS !== THREE.RepeatWrapping || tex.wrapT !== THREE.RepeatWrapping) {
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.needsUpdate = true
  }
}

/** Mesh userData key — MaterialApplier restores ST after clone so pause holds. */
export const DCL_TEXTURE_MOVE_ST = 'dclTextureMoveST'

/**
 * Apply DCL TextureMove UV as Three texture.offset / .repeat.
 *
 * Plaza marquee MeshRenderer UVs are already atlas *sub-rects* (e.g. V≈0.38–0.59).
 * TextureMove y (0.4 → −0.4) is an additional offset on top of those UVs.
 *
 * Offset mode: Y is negated for Three’s V axis (flipY=false marquees). Without −Y
 * the LED scroll runs opposite Explorer. Tiling uses DCL sign as-is.
 *
 * **Map-U flip law (event cards):** MaterialApplier may set `dclMapUFlipped` with
 * `repeat.x = −base` and `offset.x = 1 − base`. TextureMove must write **base** ST
 * into userData (for re-apply) but apply **flipped** ST on the live texture, or scroll
 * overwrites the flip and posters go L–R mirrored mid-tween.
 *
 * (Older “split panel” bugs were dual-face PlaneGeometry + DoubleSide, not this sign.)
 */
function applyTextureUvToTargets(
  targets: THREE.Texture[],
  uv: Vec2,
  movementType?: number,
  root?: THREE.Object3D
): void {
  const tiling = movementType === TMT_TILING
  // Offset mode: DCL y → Three V with sign flip for flipY=false marquees (636e405).
  // Horizontal U uses DCL sign as-is (Explorer). Do not invert X — that mirrored marquees.
  const y = tiling ? uv.y : -uv.y
  for (const tex of targets) {
    ensureRepeatWrapping(tex)
    // Clear false map-U flips left by old worldMirror det checks so scroll stays L→R.
    if (tex.userData.dclMapUFlipped) {
      // Restore base ST if we still have a flipped residual from prior Material apply.
      const rep = tex.repeat.x
      if (rep < 0) {
        tex.repeat.x = -rep
        tex.offset.x = 1 - tex.offset.x
      }
      tex.userData.dclMapUFlipped = false
    }
    if (tiling) {
      tex.repeat.set(uv.x, uv.y)
    } else {
      tex.offset.set(uv.x, y)
    }
  }
  // Persist ST on meshes in **DCL/base** space so MaterialApplier re-flip stays honest.
  if (root) {
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      child.userData[DCL_TEXTURE_MOVE_ST] = {
        tiling: !!tiling,
        x: uv.x,
        y
      }
    })
  }
}

function readTextureUvFromTargets(targets: THREE.Texture[], movementType?: number): Vec2 | null {
  const tex = targets[0]
  if (!tex) return null
  if (movementType === TMT_TILING) {
    return { x: tex.repeat.x, y: tex.repeat.y }
  }
  // Undo offset-mode V invert so callers keep DCL-space UV.
  return { x: tex.offset.x, y: -tex.offset.y }
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

/** NeonScreen-style row step: ~1s, mostly Y offset ~0.2 — not full-atlas / long ambient tweens. */
function isPlazaMarqueeTextureMove(tween: PBTween): boolean {
  if (tween.mode?.$case !== 'textureMove' || !tween.mode.textureMove) return false
  const d = tween.duration ?? 0
  if (d < 200 || d > 5000) return false
  const s = tween.mode.textureMove.start
  const e = tween.mode.textureMove.end
  if (!s || !e) return false
  const dy = Math.abs((e.y ?? 0) - (s.y ?? 0))
  const dx = Math.abs((e.x ?? 0) - (s.x ?? 0))
  return dy >= 0.05 && dy <= 0.5 && dx < 0.05
}

/**
 * ECS `Tween` → EntityStore pose + material UV interpolation.
 * Writes `TweenState` (+ interpolated `Transform`) back to the mirror for worker `tweenCompleted()`.
 *
 * SDK parity: `@dcl/ecs` `createTweenSystem()` reads `TweenState.state` (0 active / 1 completed / 2 paused)
 * and `currentTime` (0–1 progress) to fire `tweenCompleted()` and advance `TweenSequence` yoyo/restart.
 *
 * NeonScreen row pause: scene addSystem owns pauseDuration/scrollDuration; client finishes
 * each discrete textureMove, pins end UV for {@link NEON_SCREEN_PAUSE_MS}, and defers any
 * next-row createOrReplace until that wall hold ends (worker clock often races).
 */
export class TweenBridge {
  private readonly runtime = new Map<Entity, TweenRuntime>()
  /** Entities whose TweenState/Transform changed this frame — scopes CrdtEncoder tween scan. */
  private readonly encodeDirty = new Set<Entity>()
  /**
   * Tween finished this frame — worker needs TweenState immediately so
   * TweenSequence TL_RESTART (bobber float) can queue the next hop without a step.
   */
  private completionDeliverUrgent = false
  /** Entities whose scene-graph pose was interpolated this frame (collider pose slide). */
  private readonly transformMotionEntities = new Set<Entity>()
  private readonly verbose = isTweenVerbose()
  private readonly marqueeVerbose = isMarqueeVerbose()
  private motionFocusView: ProjectionView | null = null
  private marqueeSummaryAt = 0
  /** Stay silent until a plaza marquee has real mesh maps (after hydration attach). */
  private marqueeLive = false

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly store: EntityStore
  ) {
    // Intentionally no boot console blast — logging only after meshes exist (see logMarquee).
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

  /**
   * TextureMove / row-pause debug. Silent until `marqueeLive` (mesh maps exist).
   * Always throttled — never per-frame, never during Genesis attach spam.
   */
  private logMarquee(
    message: string,
    options: {
      level?: 'info' | 'warn' | 'success'
      throttleMs?: number
      entity?: Entity
      /** Distinct key so START/COMPLETE don't share one throttle bucket. */
      event?: string
      /** Allow one boot-safe line before meshes exist (unused for hot path). */
      force?: boolean
    } = {}
  ): void {
    if (!this.marqueeVerbose) return
    if (!this.marqueeLive && !options.force) return
    const prefix = options.entity !== undefined ? `e${options.entity}` : 'marquee'
    const line = `[marquee] ${prefix} · ${message}`
    const throttleMs = options.throttleMs ?? 500
    const event = options.event ?? 'gen'
    clientDebugLog.log('motion', line, {
      level: options.level ?? 'info',
      throttleKey: `marquee:${event}:${options.entity ?? 'all'}`,
      throttleMs,
      alsoConsole: true
    })
  }

  private formatTextureMove(tween: PBTween): string {
    if (tween.mode?.$case !== 'textureMove' || !tween.mode.textureMove) {
      return tween.mode?.$case ?? 'none'
    }
    const tm = tween.mode.textureMove
    const s = tm.start
    const e = tm.end
    return (
      `textureMove start=(${s?.x?.toFixed(3) ?? '?'},${s?.y?.toFixed(3) ?? '?'}) ` +
      `end=(${e?.x?.toFixed(3) ?? '?'},${e?.y?.toFixed(3) ?? '?'}) ` +
      `dur=${tween.duration}ms ease=${tween.easingFunction ?? 0} ` +
      `playing=${tween.playing !== false}`
    )
  }

  /** True when `TweenState` / tween `Transform` changed since the last consume. */
  hasEncodeDirty(): boolean {
    return this.encodeDirty.size > 0
  }

  /** Finite tween completed this frame — deliver without 100ms throttle (sequence restart). */
  hasUrgentCompletionDeliver(): boolean {
    return this.completionDeliverUrgent
  }

  /** Consume and clear encoder dirty set (call before `CrdtEncoder.encode()`). */
  consumeEncodeDirty(): ReadonlySet<Entity> {
    const out = new Set(this.encodeDirty)
    this.encodeDirty.clear()
    this.completionDeliverUrgent = false
    return out
  }

  /** Consume entities whose transform was tween-interpolated this frame. */
  consumeTransformMotionEntities(): ReadonlySet<Entity> {
    const out = new Set(this.transformMotionEntities)
    this.transformMotionEntities.clear()
    return out
  }

  /** Entities with active tween runtime — avoids `getEntitiesWith(Tween)` in consumeDiff. */
  getActiveTweenEntities(): Entity[] {
    return [...this.runtime.keys()]
  }

  /**
   * True while a NeonScreen row must finish (scroll in flight or wall-clock pause).
   * Incoming createOrReplace TextureMoves are ignored until this is false.
   */
  private marqueeRowBusy(runtime: TweenRuntime, now: number): boolean {
    if (!runtime.marqueeRow) return false
    if (!runtime.completed) return true
    if (runtime.textureHoldUntil != null && now < runtime.textureHoldUntil) return true
    return false
  }

  sync(view: ProjectionView): void {
    this.motionFocusView = view
    const { Tween, TweenState } = this.ecs
    const active = new Set<Entity>()
    const now = performance.now()

    for (const [entity] of view.getEntitiesWith(Tween)) {
      active.add(entity)
      this.store.setTween(entity, true)
      const tween = Tween.get(entity)
      const signature = tweenSignature(tween)
      const prev = this.runtime.get(entity)
      if (!prev || prev.signature !== signature) {
        // NeonScreen: worker often createOrReplace's the next row early (compressed pause
        // and/or scroll). Finish current scroll + wall hold before adopting the new signature.
        if (
          prev &&
          tween.mode?.$case === 'textureMove' &&
          this.marqueeRowBusy(prev, now)
        ) {
          const holding =
            prev.textureHoldUntil != null && now < prev.textureHoldUntil && prev.textureHoldUv
          if (holding) {
            if (prev.lastHoldLogPhase !== 'holding') {
              prev.lastHoldLogPhase = 'holding'
              this.logMarquee(
                `HOLD defer next · ${((prev.textureHoldUntil! - now) / 1000).toFixed(2)}s left · ` +
                  `heldUv=(${prev.textureHoldUv!.x.toFixed(3)},${prev.textureHoldUv!.y.toFixed(3)}) · ` +
                  `incoming ${this.formatTextureMove(tween)}`,
                { entity, level: 'warn', event: 'hold-defer', throttleMs: 50 }
              )
            }
          } else if (prev.lastHoldLogPhase !== 'defer-scroll') {
            prev.lastHoldLogPhase = 'defer-scroll'
            this.logMarquee(
              `SCROLL defer next · progress=${formatTweenProgress(prev.progress)} · ` +
                `incoming ${this.formatTextureMove(tween)}`,
              { entity, level: 'warn', event: 'scroll-defer', throttleMs: 200 }
            )
          }
          continue
        }
        const node = this.store.getNode(entity)
        const keptTargets =
          prev?.textureTargets && node && textureTargetsLive(node, prev.textureTargets)
            ? prev.textureTargets
            : node && isTextureMode(tween.mode)
              ? collectTextureTargets(node)
              : undefined
        const wasHolding = prev?.lastHoldLogPhase === 'holding' || prev?.lastHoldLogPhase === 'expired'
        const marqueeRow = isPlazaMarqueeTextureMove(tween)
        const tm = tween.mode?.$case === 'textureMove' ? tween.mode.textureMove : undefined
        const durationMs = tween.duration ?? 0
        // CRDT / worker delivered a real next Tween — drop client sequence loop for this entity.
        this.runtime.set(entity, {
          signature,
          completed: false,
          progress: 0,
          textureUv: undefined,
          textureTargets: keptTargets,
          justReset: true,
          completedDirtySent: false,
          lastWrittenState: 0,
          lastWrittenProgress: 0,
          textureHoldUntil: undefined,
          textureHoldUv: undefined,
          textureHoldMovementType: tm?.movementType ?? 0,
          marqueeRow,
          marqueeStart: tm?.start
            ? { x: tm.start.x ?? 0, y: tm.start.y ?? 0 }
            : undefined,
          marqueeEnd: tm?.end ? { x: tm.end.x ?? 0, y: tm.end.y ?? 0 } : undefined,
          marqueeDurationSec: durationMs > 0 ? durationMs / 1000 : 1,
          marqueeEasing: tween.easingFunction ?? 0,
          lastLoggedState: undefined,
          lastProgressMilestone: undefined,
          lastHoldLogPhase: undefined,
          localLoop: undefined
        })
        // Clear stale TS_COMPLETED immediately so worker TweenSequence does not treat the
        // next leg as already finished (blimp TL_RESTART would advance once and stall).
        TweenState.createOrReplace(entity, { state: 0, currentTime: 0 })
        this.encodeDirty.add(entity)
        this.completionDeliverUrgent = true
        this.logTween(
          `Tween reset — entity ${entity} · ${tweenModeLabel(tween)} · duration ${tween.duration}ms · playing ${tween.playing !== false}`,
          { entity }
        )
        // Discrete textureMove row steps only after mesh maps exist (never during hydration targets=0).
        if (marqueeRow && (keptTargets?.length ?? 0) > 0) {
          if (!this.marqueeLive) {
            this.marqueeLive = true
            this.logMarquee('logging live (meshes attached)', {
              event: 'live',
              force: true,
              throttleMs: 0
            })
          }
          this.logMarquee(
            `START ${wasHolding ? '(after hold) ' : ''}${this.formatTextureMove(tween)} · targets=${keptTargets!.length}`,
            { entity, level: 'success', event: 'start', throttleMs: 200 }
          )
        }
      }
    }

    for (const entity of this.runtime.keys()) {
      if (!active.has(entity)) {
        const rt = this.runtime.get(entity)
        // Keep runtime through row-pause / unfinished marquee scroll.
        if (rt && this.marqueeRowBusy(rt, now)) continue
        this.runtime.delete(entity)
        this.store.setTween(entity, false)
        this.logTween(`Tween removed — entity ${entity}`, { entity })
      }
    }
  }

  /**
   * Phase C: true when any runtime needs a per-frame advance (playing / continuous / just reset / row hold).
   * Parked completed tweens do not count — except NeonScreen hold (must expire).
   */
  hasLiveTweens(): boolean {
    if (!this.runtime.size) return false
    const now = performance.now()
    const { Tween } = this.ecs
    for (const [entity, runtime] of this.runtime) {
      // Marquee row busy (scroll or wall hold) — must keep update running even if ECS
      // already replaced the Tween component with the next signature.
      if (this.marqueeRowBusy(runtime, now)) return true
      // Local sequence loop (blimp TL_RESTART) — keep ticking even while ECS Tween is parked COMPLETED.
      if (runtime.localLoop && runtime.localLoop.legs.length > 0 && !runtime.completed) return true
      if (!Tween.has(entity)) continue
      if (runtime.justReset) return true
      if (runtime.completed && runtime.completedDirtySent) continue
      const tween = Tween.get(entity)
      if (tween.playing === false && runtime.lastWrittenState === 2 && !runtime.completed) {
        continue
      }
      return true
    }
    return false
  }

  update(delta: number, view: ProjectionView): void {
    this.motionFocusView = view
    this.transformMotionEntities.clear()
    if (!this.runtime.size) return

    const { Tween, TweenState, Transform, AvatarAttach } = this.ecs
    const now = performance.now()

    // Phase C dirty set: iterate runtime only (not full ECS scan). Skip parked completed/paused.
    for (const [entity, runtime] of this.runtime) {
      const hasTween = Tween.has(entity)
      const tween = hasTween ? Tween.get(entity) : undefined

      if (hasTween && AvatarAttach.has(entity)) {
        this.logTween(`Tween skip — entity ${entity} has AvatarAttach`, { entity, throttleMs: 2000 })
        continue
      }

      // Transform-only pivots (Genesis blimp orbit) must get a scene Group even without a mesh.
      const node =
        this.store.getNode(entity) ??
        (Transform.has(entity) ? this.store.getOrCreateNode(entity) : undefined)

      // Force-pin end UV for NeonScreen-style row pause (scene may already have next Tween).
      const holdingRow =
        runtime.marqueeRow === true &&
        runtime.textureHoldUntil != null &&
        now < runtime.textureHoldUntil &&
        runtime.textureHoldUv != null

      if (holdingRow) {
        if (node) {
          let targets = runtime.textureTargets
          if (!targets?.length || !textureTargetsLive(node, targets)) {
            targets = collectTextureTargets(node)
            runtime.textureTargets = targets
          }
          if (targets.length) {
            applyTextureUvToTargets(
              targets,
              runtime.textureHoldUv!,
              runtime.textureHoldMovementType,
              node
            )
          }
        }
        // Keep TweenState completed so scene systems don't stall; we ignore the next
        // TextureMove signature until hold ends.
        if (hasTween) {
          TweenState.createOrReplace(entity, { state: 1, currentTime: 1 })
          if (!runtime.completedDirtySent) {
            runtime.completedDirtySent = true
            runtime.lastWrittenState = 1
            runtime.lastWrittenProgress = 1
            this.encodeDirty.add(entity)
          }
        }
        continue
      }

      // Hold expired — pin end UV; keep completed signature so we don't re-start the same
      // row. Next sync adopts only when ECS TextureMove start/end actually change.
      if (
        runtime.marqueeRow &&
        runtime.textureHoldUntil != null &&
        now >= runtime.textureHoldUntil
      ) {
        const held = runtime.textureHoldUv
        this.logMarquee(
          `HOLD expired · was uv=(${held?.x.toFixed(3) ?? '?'},${held?.y.toFixed(3) ?? '?'}) · open for next row`,
          { entity, level: 'success', event: 'hold-end', throttleMs: 50 }
        )
        if (node && held) {
          let targets = runtime.textureTargets
          if (!targets?.length || !textureTargetsLive(node, targets)) {
            targets = collectTextureTargets(node)
            runtime.textureTargets = targets
          }
          if (targets?.length) {
            applyTextureUvToTargets(targets, held, runtime.textureHoldMovementType, node)
          }
        }
        runtime.textureHoldUntil = undefined
        // Keep textureHoldUv for pin while parked until next row adopts.
        runtime.completed = true
        runtime.completedDirtySent = true
        runtime.lastHoldLogPhase = 'expired'
        // marqueeRow stays true until next START clears it — but marqueeRowBusy is false
        // once hold deadline is cleared and completed, so next signature can adopt.
        continue
      }

      // ── NeonScreen row: drive from runtime snapshot (ignore early ECS replace) ──
      if (runtime.marqueeRow && !runtime.completed && runtime.marqueeStart && runtime.marqueeEnd) {
        if (runtime.justReset) runtime.justReset = false
        const durationSec = Math.max(runtime.marqueeDurationSec ?? 1, 1e-3)
        let progress = runtime.progress ?? 0
        progress = Math.min(1, progress + delta / durationSec)
        runtime.progress = progress
        const eased = applyEasing(runtime.marqueeEasing ?? 0, progress)
        const start = runtime.marqueeStart
        const end = runtime.marqueeEnd
        const uv: Vec2 = {
          x: start.x + (end.x - start.x) * eased,
          y: start.y + (end.y - start.y) * eased
        }
        runtime.textureUv = uv
        if (node) {
          let targets = runtime.textureTargets
          if (!targets?.length || !textureTargetsLive(node, targets)) {
            targets = collectTextureTargets(node)
            runtime.textureTargets = targets
          }
          if (targets?.length) {
            applyTextureUvToTargets(targets, uv, runtime.textureHoldMovementType ?? 0, node)
          }
        }
        if (this.marqueeVerbose) {
          const mile = progressMilestone(progress)
          if (runtime.lastProgressMilestone !== mile) {
            runtime.lastProgressMilestone = mile
            this.logMarquee(
              `SCROLL ${formatTweenProgress(progress)} · uv=(${uv.x.toFixed(3)},${uv.y.toFixed(3)}) · ` +
                `durSec=${durationSec.toFixed(2)}`,
              { entity }
            )
          }
        }
        if (progress >= 1) {
          runtime.completed = true
          runtime.completedDirtySent = true
          runtime.textureHoldUv = { x: end.x, y: end.y }
          runtime.textureHoldUntil = now + NEON_SCREEN_PAUSE_MS
          runtime.lastHoldLogPhase = 'armed'
          if (hasTween) {
            TweenState.createOrReplace(entity, { state: 1, currentTime: 1 })
            this.encodeDirty.add(entity)
            this.completionDeliverUrgent = true
          }
          this.logMarquee(
            `COMPLETE → HOLD ${NEON_SCREEN_PAUSE_MS}ms · end=(${end.x.toFixed(3)},${end.y.toFixed(3)})`,
            { entity, level: 'success', event: 'complete', throttleMs: 50 }
          )
        } else if (hasTween) {
          // Report progress for the *current* row; ECS may already hold the next signature.
          TweenState.createOrReplace(entity, { state: 0, currentTime: progress })
          if (
            runtime.lastWrittenProgress === undefined ||
            Math.abs(runtime.lastWrittenProgress - progress) >= 0.02
          ) {
            runtime.lastWrittenProgress = progress
            runtime.lastWrittenState = 0
            this.encodeDirty.add(entity)
          }
        }
        continue
      }

      // Local sequence loop can run without a live ECS Tween (worker deleted mid-RESTART).
      const loopTween =
        runtime.localLoop && !runtime.completed
          ? runtime.localLoop.legs[runtime.localLoop.index]
          : undefined
      if (!hasTween && !loopTween) continue
      const driveTween = loopTween ?? tween
      if (!driveTween) continue

      // Parked: finished finite tween already reported — wait for next signature via sync.
      // Keep pinning marquee end UV so material re-apply cannot flash mid-pause.
      // Exception: localLoop should not park here (completed is cleared when next leg starts).
      if (runtime.completed && runtime.completedDirtySent && !runtime.justReset) {
        // Still finished with a sequence loop but no next leg started — try arm again.
        if (hasTween && tween && this.tryArmLocalSequenceLoop(entity, tween, runtime)) {
          // Fall through with new leg active.
        } else {
          if (runtime.marqueeRow && runtime.textureHoldUv && node) {
            let targets = runtime.textureTargets
            if (!targets?.length || !textureTargetsLive(node, targets)) {
              targets = collectTextureTargets(node)
              runtime.textureTargets = targets
            }
            if (targets?.length) {
              applyTextureUvToTargets(
                targets,
                runtime.textureHoldUv,
                runtime.textureHoldMovementType,
                node
              )
            }
          }
          continue
        }
      }

      const playing = driveTween.playing !== false
      const textureMode = isTextureMode(driveTween.mode)

      // Paused and already wrote TweenState=2 — no per-frame work until playing/signature changes.
      if (
        !playing &&
        !runtime.completed &&
        !runtime.justReset &&
        runtime.lastWrittenState === 2
      ) {
        continue
      }

      // Completed finite tween: pin end once, encode dirty once, then either park or
      // start the next sequence leg locally (worker may lag after settings hitches).
      if (runtime.completed) {
        if (node && !runtime.completedDirtySent) {
          if (textureMode) {
            this.applyTextureTween(node, driveTween, runtime, 0, 1, true)
          } else if (Transform.has(entity)) {
            this.applyTransformTween(
              entity,
              driveTween,
              Transform.get(entity),
              node,
              1,
              true,
              0
            )
          }
        }
        TweenState.createOrReplace(entity, { state: 1, currentTime: 1 })
        if (!runtime.completedDirtySent) {
          runtime.completedDirtySent = true
          runtime.lastWrittenState = 1
          runtime.lastWrittenProgress = 1
          this.encodeDirty.add(entity)
          this.completionDeliverUrgent = true
        }
        // Start next RESTART leg for next frame — keep COMPLETED on the wire this frame.
        this.tryArmLocalSequenceLoop(entity, driveTween, runtime)
        continue
      }

      // Re-resolve after possible sequence step.
      const activeTween =
        runtime.localLoop && !runtime.completed
          ? runtime.localLoop.legs[runtime.localLoop.index]!
          : driveTween
      const activePlaying = activeTween.playing !== false
      const activeContinuous = isContinuousMode(activeTween.mode)
      const activeTexture = isTextureMode(activeTween.mode)
      const activeDurationSec = Math.max((activeTween.duration ?? 0) / 1000, 0)

      let progress = runtime.progress ?? 0
      if (runtime.justReset) {
        progress = runtime.progress
        runtime.justReset = false
      }
      if (!runtime.completed && activePlaying) {
        if (!activeContinuous && activeDurationSec > 0) {
          progress = Math.min(1, progress + delta / activeDurationSec)
        } else if (activeTexture && activeDurationSec <= 0) {
          this.logMarquee(
            `SCROLL blocked · durationSec=${activeDurationSec} durationRaw=${activeTween.duration} continuous=${activeContinuous}`,
            { entity, level: 'warn', throttleMs: 1000 }
          )
        }
      }
      runtime.progress = progress

      const eased = applyEasing(activeTween.easingFunction ?? 0, progress)
      let applied = false

      if (node) {
        if (activeTexture) {
          applied = this.applyTextureTween(node, activeTween, runtime, delta, eased, activePlaying)
        } else if (Transform.has(entity)) {
          applied = this.applyTransformTween(
            entity,
            activeTween,
            Transform.get(entity),
            node,
            eased,
            activePlaying,
            delta
          )
        }
      }

      const reachedEnd = !activeContinuous && activeDurationSec > 0 && progress >= 1
      const completed = reachedEnd && !runtime.completed
      if (reachedEnd) {
        runtime.completed = true
      }

      const state = !activePlaying && !reachedEnd ? 2 : reachedEnd ? 1 : 0

      TweenState.createOrReplace(entity, { state, currentTime: progress })
      const stateChanged = runtime.lastWrittenState !== state
      const progressChanged =
        runtime.lastWrittenProgress === undefined ||
        Math.abs(runtime.lastWrittenProgress - progress) >= 0.02
      if (stateChanged || progressChanged || completed) {
        runtime.lastWrittenState = state
        runtime.lastWrittenProgress = progress
        if (reachedEnd) {
          runtime.completedDirtySent = true
          // Sequence loops (bobber bob / blimp) need the worker this frame.
          this.completionDeliverUrgent = true
        }
        this.encodeDirty.add(entity)
      }
      this.logTweenState(entity, activeTween, state, progress, activeContinuous)

      // After COMPLETED is encoded this frame, arm next leg for the following update tick.
      if (reachedEnd && completed) {
        this.tryArmLocalSequenceLoop(entity, activeTween, runtime)
      }

      if (!applied && !activeTexture) {
        this.logTween(
          `Tween visual skip — entity ${entity} · ${tweenModeLabel(activeTween)} (no node or Transform)`,
          { entity, throttleMs: 1500, level: 'warn' }
        )
      }
    }

    if (this.marqueeVerbose) {
      if (now - this.marqueeSummaryAt > 5000) {
        this.marqueeSummaryAt = now
        this.logMarqueeSummary(now)
      }
    }
  }

  private logMarqueeSummary(now: number): void {
    const { Tween } = this.ecs
    let plaza = 0
    let scrolling = 0
    let holding = 0
    let completed = 0
    let withTargets = 0
    const samples: string[] = []
    for (const [entity, rt] of this.runtime) {
      const tw = Tween.has(entity) ? Tween.get(entity) : null
      if (!tw || !isPlazaMarqueeTextureMove(tw)) continue
      plaza++
      if ((rt.textureTargets?.length ?? 0) > 0) withTargets++
      if (rt.textureHoldUntil != null && now < rt.textureHoldUntil) {
        holding++
        if (samples.length < 2) {
          samples.push(
            `e${entity}:HOLD ${((rt.textureHoldUntil - now) / 1000).toFixed(2)}s y=${rt.textureHoldUv?.y?.toFixed(2)}`
          )
        }
      } else if (rt.completed) {
        completed++
      } else {
        scrolling++
        if (samples.length < 2) {
          const y0 = tw.mode?.$case === 'textureMove' ? tw.mode.textureMove?.start?.y : undefined
          const y1 = tw.mode?.$case === 'textureMove' ? tw.mode.textureMove?.end?.y : undefined
          samples.push(
            `e${entity}:SCROLL ${(rt.progress * 100).toFixed(0)}% y ${y0?.toFixed(2)}→${y1?.toFixed(2)}`
          )
        }
      }
    }
    // Skip empty early-boot summaries (hydration — no meshes yet).
    if (plaza === 0) return
    this.logMarquee(
      `summary · textureMove=${plaza} meshes=${withTargets} scroll=${scrolling} hold=${holding} done=${completed}` +
        (samples.length ? ` · ${samples.join(' | ')}` : ''),
      { level: withTargets === 0 ? 'warn' : 'info', event: 'summary', throttleMs: 4000 }
    )
  }

  /**
   * After a finite leg completes, start the next TweenSequence leg on the client so
   * continuous orbits (Genesis blimp TL_RESTART) never wait on worker CRDT / settings hitches.
   * Returns true when a new leg is live (runtime.completed cleared).
   */
  private tryArmLocalSequenceLoop(
    entity: Entity,
    completedTween: PBTween,
    runtime: TweenRuntime
  ): boolean {
    // Texture marquee rows are driven by scene systems — do not invent a loop.
    if (isTextureMode(completedTween.mode)) return false

    const { TweenSequence } = this.ecs
    if (!runtime.localLoop) {
      if (!TweenSequence.has(entity)) return false
      const seq = TweenSequence.get(entity)
      const loop = seq.loop
      const queued = seq.sequence ?? []
      const hasQueued = queued.length > 0
      if (!hasQueued && !isSequenceRestartLoop(loop) && !isSequenceYoyoLoop(loop)) {
        return false
      }
      if (isSequenceYoyoLoop(loop) && !hasQueued) {
        runtime.localLoop = {
          legs: [cloneTween(completedTween), backwardsTween(completedTween)],
          index: 0
        }
      } else {
        // Full cycle: completed leg + remaining sequence (RESTART rotates this forever).
        runtime.localLoop = {
          legs: [cloneTween(completedTween), ...queued.map(cloneTween)],
          index: 0
        }
      }
      this.logTween(
        `Tween local sequence armed — entity ${entity} · legs=${runtime.localLoop.legs.length} · loop=${loop ?? 'none'}`,
        { entity, level: 'success' }
      )
    }

    const loop = runtime.localLoop
    if (!loop.legs.length) return false

    // Advance to next leg (wrap).
    loop.index = (loop.index + 1) % loop.legs.length
    const next = loop.legs[loop.index]!
    runtime.signature = tweenSignature(next)
    runtime.completed = false
    runtime.progress = 0
    runtime.justReset = true
    // Keep last COMPLETED dirty/urgent so the worker still receives the finish edge.
    // Do not overwrite TweenState with ACTIVE here — that would swallow COMPLETED on the
    // same encode (settings hitches left the blimp parked after one orbit).
    runtime.completedDirtySent = false
    runtime.lastWrittenProgress = 0
    runtime.lastProgressMilestone = undefined
    this.logTween(
      `Tween local sequence next — entity ${entity} · leg ${loop.index + 1}/${loop.legs.length} · ${tweenModeLabel(next)}`,
      { entity }
    )
    return true
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
    // Re-collect when empty or stale — MaterialApplier clones maps on apply, so a cached
    // target list can point at orphaned textures after a deferred material attach.
    let targets = runtime?.textureTargets
    if (!targets?.length || !textureTargetsLive(node, targets)) {
      targets = collectTextureTargets(node)
      if (runtime) runtime.textureTargets = targets
    }
    if (!targets.length) return false

    switch (tween.mode?.$case) {
      case 'textureMove': {
        const { start, end, movementType } = tween.mode.textureMove
        if (!start || !end) return false
        const uv = lerpVec2(start, end, eased)
        applyTextureUvToTargets(targets, uv, movementType, node)
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
        applyTextureUvToTargets(targets, uv, movementType, node)
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
        // Explorer/SDK contract (Neurolink rotors, camera-operator orbit, kart spin):
        // - `direction` = small euler-hint quaternion encoding the spin axis
        //   (e.g. fromEulerDegrees(0, ±1, 0) → parent-space +Y)
        // - `speed` = degrees per second (scene comments: DRONE_ROTOR_SPIN_SPEED_DEG_PER_S)
        // Parent-space multiply (delta * current): rotor planes are often Rx(90) so local-Y
        // tumble is wrong; parent +Y is the fan axis for horizontal discs.
        const { direction, speed } = tween.mode.rotateContinuous
        if (direction && playing && Number.isFinite(speed) && speed !== 0) {
          const qx = direction.x ?? 0
          const qy = direction.y ?? 0
          const qz = direction.z ?? 0
          const qw = direction.w ?? 1
          _qA.set(qx, qy, qz, qw)
          if (_qA.lengthSq() < 1e-12) {
            _v3a.set(0, 1, 0)
          } else {
            _qA.normalize()
            const wClamped = Math.min(1, Math.max(-1, _qA.w))
            const sinHalf = Math.sqrt(Math.max(0, 1 - wClamped * wClamped))
            if (sinHalf < 1e-6) {
              _v3a.set(0, 1, 0)
            } else {
              _v3a.set(_qA.x / sinHalf, _qA.y / sinHalf, _qA.z / sinHalf)
            }
            if (_v3a.lengthSq() < 1e-8) _v3a.set(0, 1, 0)
            else _v3a.normalize()
          }
          // speed is degrees/sec (Explorer + all production scene authors).
          _qB.setFromAxisAngle(_v3a, THREE.MathUtils.degToRad(speed) * delta)
          _qA.set(
            _scratchTransform.rotation.x,
            _scratchTransform.rotation.y,
            _scratchTransform.rotation.z,
            _scratchTransform.rotation.w
          )
          // Parent-space: delta * current (not current * delta / local).
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
    // Orbit pivots (Genesis blimp) must never stay frozen — children inherit world TRS.
    node.matrixAutoUpdate = true
    applyDclLocalTransform(node, _scratchTransform)
    // Propagate to blimp/child GLBs this frame (don't wait for renderer walk).
    node.updateMatrixWorld(true)
    this.transformMotionEntities.add(entity)
    return true
  }
}