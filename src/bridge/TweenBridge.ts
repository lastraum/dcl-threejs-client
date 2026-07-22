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

/** Stable float key — CRDT float noise must not thrash TextureMove signatures. */
function r4(n: number | undefined | null): number | null {
  if (n == null || !Number.isFinite(n)) return null
  return Math.round(n * 1e4) / 1e4
}

function vec2Key(v?: { x?: number; y?: number } | null): { x: number; y: number } | null {
  if (!v) return null
  return { x: r4(v.x) ?? 0, y: r4(v.y) ?? 0 }
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
 * (Older “split panel” bugs were dual-face PlaneGeometry + DoubleSide, not this sign.)
 */
function applyTextureUvToTargets(
  targets: THREE.Texture[],
  uv: Vec2,
  movementType?: number,
  root?: THREE.Object3D
): void {
  const tiling = movementType === TMT_TILING
  // Offset mode: invert V so TextureMove y steps match Explorer scroll direction.
  const y = tiling ? uv.y : -uv.y
  for (const tex of targets) {
    ensureRepeatWrapping(tex)
    if (tiling) {
      tex.repeat.set(uv.x, uv.y)
    } else {
      tex.offset.set(uv.x, y)
    }
  }
  // Persist ST on meshes so material re-clone can restore during scene pause.
  // Store the values we actually applied (incl. Y negate for offset mode).
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
 * KNOWN (lastraum, 2026-07-14): Genesis NeonScreen row pause is still broken. Scene owns
 * pauseDuration/scrollDuration via addSystem(dt); client no longer fakes a 0.5s hold. TextureMove
 * scrolls, but the authored inter-row pause does not hold (was ~10ms or none after wall-clock
 * ledger attempts). Needs a dedicated follow-up — do not reintroduce TEXTURE_MOVE_PAUSE_OVER_SCROLL
 * without fixing worker scene-time vs NeonScreen properly.
 */
export class TweenBridge {
  private readonly runtime = new Map<Entity, TweenRuntime>()
  /** Entities whose TweenState/Transform changed this frame — scopes CrdtEncoder tween scan. */
  private readonly encodeDirty = new Set<Entity>()
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

  /** Consume and clear encoder dirty set (call before `CrdtEncoder.encode()`). */
  consumeEncodeDirty(): ReadonlySet<Entity> {
    const out = new Set(this.encodeDirty)
    this.encodeDirty.clear()
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

  sync(view: ProjectionView): void {
    this.motionFocusView = view
    const { Tween } = this.ecs
    const active = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(Tween)) {
      active.add(entity)
      this.store.setTween(entity, true)
      const tween = Tween.get(entity)
      const signature = tweenSignature(tween)
      const prev = this.runtime.get(entity)
      if (!prev || prev.signature !== signature) {
        const node = this.store.getNode(entity)
        const keptTargets =
          prev?.textureTargets && node && textureTargetsLive(node, prev.textureTargets)
            ? prev.textureTargets
            : node && isTextureMode(tween.mode)
              ? collectTextureTargets(node)
              : undefined
        this.runtime.set(entity, {
          signature,
          completed: false,
          progress: 0,
          textureUv: undefined,
          textureTargets: keptTargets,
          justReset: true,
          completedDirtySent: false,
          lastWrittenState: undefined,
          lastWrittenProgress: undefined,
          lastLoggedState: undefined,
          lastProgressMilestone: undefined
        })
        this.logTween(
          `Tween reset — entity ${entity} · ${tweenModeLabel(tween)} · duration ${tween.duration}ms · playing ${tween.playing !== false}`,
          { entity }
        )
        // Discrete textureMove row steps only after mesh maps exist (never during hydration targets=0).
        if (
          tween.mode?.$case === 'textureMove' &&
          isPlazaMarqueeTextureMove(tween) &&
          (keptTargets?.length ?? 0) > 0
        ) {
          if (!this.marqueeLive) {
            this.marqueeLive = true
            this.logMarquee('logging live (meshes attached)', {
              event: 'live',
              force: true,
              throttleMs: 0
            })
          }
          this.logMarquee(
            `START ${this.formatTextureMove(tween)} · targets=${keptTargets!.length}`,
            { entity, level: 'success', event: 'start', throttleMs: 200 }
          )
        }
      }
    }

    for (const entity of this.runtime.keys()) {
      if (!active.has(entity)) {
        this.runtime.delete(entity)
        this.store.setTween(entity, false)
        this.logTween(`Tween removed — entity ${entity}`, { entity })
      }
    }
  }

  /**
   * Phase C: true when any runtime needs a per-frame advance (playing / continuous / just reset).
   * Parked completed tweens do not count.
   */
  hasLiveTweens(): boolean {
    if (!this.runtime.size) return false
    const { Tween } = this.ecs
    for (const [entity, runtime] of this.runtime) {
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

    // Phase C dirty set: iterate runtime only (not full ECS scan). Skip parked completed/paused.
    for (const [entity, runtime] of this.runtime) {
      if (!Tween.has(entity)) continue
      const tween = Tween.get(entity)

      if (AvatarAttach.has(entity)) {
        this.logTween(`Tween skip — entity ${entity} has AvatarAttach`, { entity, throttleMs: 2000 })
        continue
      }

      // Parked: finished finite tween already reported to worker — wait for next signature via sync.
      if (runtime.completed && runtime.completedDirtySent && !runtime.justReset) {
        continue
      }

      const node = this.store.getNode(entity)
      // Never log no-node during attach storms (Genesis: thousands of tweens).

      const playing = tween.playing !== false
      const continuous = isContinuousMode(tween.mode)
      const textureMode = isTextureMode(tween.mode)
      const durationSec = Math.max(tween.duration / 1000, 0)

      // Paused and already wrote TweenState=2 — no per-frame work until playing/signature changes.
      if (
        !playing &&
        !runtime.completed &&
        !runtime.justReset &&
        runtime.lastWrittenState === 2
      ) {
        continue
      }

      // Completed finite tween: pin end once, encode dirty once, then park.
      if (runtime.completed) {
        if (node && textureMode && !runtime.completedDirtySent) {
          this.applyTextureTween(node, tween, runtime, 0, 1, true)
        }
        TweenState.createOrReplace(entity, { state: 1, currentTime: 1 })
        if (!runtime.completedDirtySent) {
          runtime.completedDirtySent = true
          runtime.lastWrittenState = 1
          runtime.lastWrittenProgress = 1
          this.encodeDirty.add(entity)
          if (textureMode && isPlazaMarqueeTextureMove(tween)) {
            this.logMarquee(`COMPLETED · ${this.formatTextureMove(tween)}`, {
              entity,
              level: 'success',
              event: 'complete',
              throttleMs: 50
            })
          }
        }
        continue
      }

      let progress = runtime.progress ?? 0
      if (runtime.justReset) {
        progress = runtime.progress
        runtime.justReset = false
      }
      if (!runtime.completed && playing) {
        if (!continuous && durationSec > 0) {
          progress = Math.min(1, progress + delta / durationSec)
        } else if (textureMode && durationSec <= 0) {
          this.logMarquee(
            `SCROLL blocked · durationSec=${durationSec} durationRaw=${tween.duration} continuous=${continuous}`,
            { entity, level: 'warn', throttleMs: 1000 }
          )
        }
      }
      runtime.progress = progress

      const eased = applyEasing(tween.easingFunction ?? 0, progress)
      let applied = false

      if (node) {
        if (textureMode) {
          applied = this.applyTextureTween(node, tween, runtime, delta, eased, playing)
          if (this.marqueeVerbose && runtime && isPlazaMarqueeTextureMove(tween)) {
            const mile = progressMilestone(progress)
            if (runtime.lastProgressMilestone !== mile) {
              runtime.lastProgressMilestone = mile
              const uv = runtime.textureUv
              this.logMarquee(
                `SCROLL ${formatTweenProgress(progress)} · ` +
                  `uv=(${uv?.x.toFixed(3) ?? '?'},${uv?.y.toFixed(3) ?? '?'}) · ` +
                  `delta=${(delta * 1000).toFixed(0)}ms durSec=${durationSec.toFixed(2)} · ` +
                  this.formatTextureMove(tween),
                { entity }
              )
            }
          }
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
      } else if (textureMode) {
        this.logMarquee(`SCROLL no node · ${this.formatTextureMove(tween)}`, {
          entity,
          level: 'warn',
          throttleMs: 1000
        })
      }

      const reachedEnd = !continuous && durationSec > 0 && progress >= 1
      const completed = reachedEnd && !runtime.completed
      if (reachedEnd) {
        runtime.completed = true
      }

      const state = !playing && !reachedEnd ? 2 : reachedEnd ? 1 : 0

      TweenState.createOrReplace(entity, { state, currentTime: progress })
      const stateChanged = runtime.lastWrittenState !== state
      const progressChanged =
        runtime.lastWrittenProgress === undefined ||
        Math.abs(runtime.lastWrittenProgress - progress) >= 0.02
      if (stateChanged || progressChanged || completed) {
        runtime.lastWrittenState = state
        runtime.lastWrittenProgress = progress
        if (reachedEnd) runtime.completedDirtySent = true
        this.encodeDirty.add(entity)
      }
      this.logTweenState(entity, tween, state, progress, continuous)

      if (!applied && !textureMode) {
        this.logTween(
          `Tween visual skip — entity ${entity} · ${tweenModeLabel(tween)} (no node or Transform)`,
          { entity, throttleMs: 1500, level: 'warn' }
        )
      }
    }

    if (this.marqueeVerbose) {
      const now = performance.now()
      if (now - this.marqueeSummaryAt > 5000) {
        this.marqueeSummaryAt = now
        this.logMarqueeSummary()
      }
    }
  }

  private logMarqueeSummary(): void {
    const { Tween } = this.ecs
    let plaza = 0
    let scrolling = 0
    let completed = 0
    let withTargets = 0
    const samples: string[] = []
    for (const [entity, rt] of this.runtime) {
      const tw = Tween.has(entity) ? Tween.get(entity) : null
      if (!tw || !isPlazaMarqueeTextureMove(tw)) continue
      plaza++
      if ((rt.textureTargets?.length ?? 0) > 0) withTargets++
      if (rt.completed) {
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
      `summary · textureMove=${plaza} meshes=${withTargets} scroll=${scrolling} done=${completed}` +
        (samples.length ? ` · ${samples.join(' | ')}` : ''),
      { level: withTargets === 0 ? 'warn' : 'info', event: 'summary', throttleMs: 4000 }
    )
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
    applyDclLocalTransform(node, _scratchTransform)
    this.transformMotionEntities.add(entity)
    return true
  }
}