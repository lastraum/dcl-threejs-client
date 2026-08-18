import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { extractUiTextureSrc } from '../../ui/scene/uiBackgroundStyle'
import { normalizePointerFilterMode, normalizeYGDisplay } from '../../ui/scene/yogaEnums'

import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import { ensureWorkerLocomotionFreezePersisted } from './workerPlayerFrameEgress'
import {
  isLevelStatePointerEdgeActive,
  isLevelStatePointerHeld,
  isPointerInteractiveTickActive,
  isWorkerPointerButtonHeld,
  shouldSuppressCooperativeReactEcs as shouldSuppressPointerSessionReactEcs
} from './sceneWorkerInputSession'
import {
  addReactWallMs,
  addSystemsWallMs,
  noteSystemRun,
  noteSystemsLoopBegin,
  noteSystemsLoopEnd
} from './workerEngUpdatePhases'
import {
  resolveWorkerUiBackground,
  resolveWorkerUiDropdown,
  resolveWorkerUiInput,
  resolveWorkerUiText,
  resolveWorkerUiTransform
} from './resolveBundledUiComponents'

/**
 * Scene UI scheduler — scene-agnostic infrastructure matching Explorer ordering.
 *
 * SDK7 scenes (Planet Angzaar, Genesis, etc.) drive UI through:
 *   closure / timers / onUpdate  →  @dcl/react-ecs reconcile  →  Ui* ECS  →  CRDT  →  renderer
 *
 * Stock @dcl/ecs registers react-ecs @ 1e5, which runs BEFORE default-priority systems that
 * mutate closure state (splash timers, loading screens, menu flags). Explorer avoids stale UI
 * by running UI reconcile after scene logic; we patch the bundled engine system loop to match.
 *
 * Layers:
 * 1. patchEngineSystemLoopPartition — defer @dcl/react-ecs* to end of engine.update (bundle)
 * 2. installSceneEngineUiScheduler — per-engine addSystem idempotency + post-update CRDT flush
 */

export const ENGINE_SYSTEM_LOOP_KEY = '__THREEJS_ENGINE_SYSTEM_LOOP__'

/** System names reconciled after all other systems in a tick. */
const DEFERRED_UI_SYSTEM_NAMES = new Set(['@dcl/react-ecs', '@dcl/react-ecs-ui-scale'])

type SystemItem = { fn: (dt: number) => void; name?: string; priority: number }

let boundWorkerEngine: IEngine | null = null
/** Non-zero only during sceneEngineScheduler cooperative ticks — not sceneOnUpdate/inbound. */
let cooperativeSchedulerTickDepth = 0

export function bindWorkerUiSchedulerEngine(eng: IEngine | null): void {
  boundWorkerEngine = eng
}

/** @deprecated No longer gates react-ecs — kept for call-site compatibility. */
export function notePlayModePointerUiEgress(_mountCount: number): void {}

/** @deprecated No longer gates react-ecs — kept for call-site compatibility. */
export function resetPlayModePointerUiEgress(): void {}

export function enterCooperativeSchedulerTick(): void {
  cooperativeSchedulerTickDepth++
}

export function leaveCooperativeSchedulerTick(): void {
  cooperativeSchedulerTickDepth = Math.max(0, cooperativeSchedulerTickDepth - 1)
}

/**
 * Min spacing between cooperative react-ecs reconciles (not pointer ticks).
 * Systems still run every engine tick (timers, LoadingScreen wall-clock).
 * Active scale/move Tween: never throttle (see shouldDeferCooperativeReactEcs).
 * Idle: ~30Hz is enough for static HUD; avoids 250–350 entity thrash at 60Hz forever.
 */
const COOPERATIVE_REACT_ECS_IDLE_MIN_MS = 33
let lastCooperativeReactEcsAt = 0
/** True when the current cooperative eng.update skipped react-ecs (throttle). */
let cooperativeReactEcsSkippedThisTick = false

/**
 * After pointer phase-4 UI open, skip this many cooperative react-ecs reconciles so
 * open menus are not immediately collapsed by residual systems / poll edges.
 */
let cooperativeReactEcsHoldTicks = 0
/** Wall-clock hold — PE pump never enters cooperativeSchedulerTickDepth so ticks alone never expire. */
let cooperativeReactEcsHoldUntilMs = 0

export function holdCooperativeReactEcs(ticks: number): void {
  cooperativeReactEcsHoldTicks = Math.max(cooperativeReactEcsHoldTicks, ticks)
  // ~16ms/tick; keep menu open long enough for main to paint phase-4 snapshot.
  const holdMs = Math.max(0, ticks) * 16
  cooperativeReactEcsHoldUntilMs = Math.max(cooperativeReactEcsHoldUntilMs, performance.now() + holdMs)
}

/** Drop the post-click menu hold so Color4.a / unmount reconciles can run. */
export function releaseCooperativeReactEcsHold(): void {
  cooperativeReactEcsHoldTicks = 0
  cooperativeReactEcsHoldUntilMs = 0
}

/**
 * After a scene-UI click that did not grow the mount (dismiss / fade), keep
 * react-ecs live so JS-driven Color4.a (welcome dissolve) reaches the DOM.
 */
let cooperativeReactEcsPaintFollowupUntilMs = 0

export function armCooperativeReactEcsPaintFollowup(ms: number): void {
  cooperativeReactEcsPaintFollowupUntilMs = Math.max(
    cooperativeReactEcsPaintFollowupUntilMs,
    performance.now() + Math.max(0, ms)
  )
}

export function isCooperativeReactEcsPaintFollowupActive(): boolean {
  return performance.now() < cooperativeReactEcsPaintFollowupUntilMs
}

/** True while post-click hold is suppressing cooperative/PE eng.update UI reconcile. */
export function isCooperativeReactEcsHeld(): boolean {
  if (cooperativeReactEcsHoldTicks > 0) return true
  return performance.now() < cooperativeReactEcsHoldUntilMs
}

/**
 * Genesis Plaza / fishing drive popup scale, letterbox, cake/confetti HUD from Transform
 * tweens (`Nm() = m.get(a9).scale.x`, `bottom: kse()+"%"`, etc.). react-ecs must re-run
 * every tick while a UI-driving Tween is playing so UiTransform widths / display flip at ~60fps.
 *
 * Ignore continuous rotate/move (NPCs, props) — those would force 60Hz UI forever.
 */
function workerHasUiDrivingTween(engine: IEngine | null): boolean {
  if (!engine) return false
  try {
    preregisterRendererInjectedComponents(engine)
    const Tween = generated.Tween(engine)
    for (const [_e, tw] of engine.getEntitiesWith(Tween)) {
      const t = tw as {
        playing?: boolean
        mode?: { $case?: string }
      }
      if (t.playing === false) continue
      const kind = t.mode?.$case
      // Scale / move (letterbox slide, popup open, page pulse). Not continuous loops.
      if (kind === 'scale' || kind === 'move' || kind === 'moveRotateScale') return true
      // Some scenes omit $case and nest move/scale objects.
      const mode = t.mode as Record<string, unknown> | undefined
      if (
        mode &&
        (mode.scale != null ||
          mode.move != null ||
          mode.moveRotateScale != null)
      ) {
        return true
      }
    }
  } catch {
    /* component not registered yet */
  }
  return false
}

/** True when any mounted UiBackground has crop/fill UVs (reeling bars, atlas sprites). */
function workerHasUvDrivenUi(engine: IEngine | null): boolean {
  if (!engine) return false
  try {
    const UiBackground = resolveWorkerUiBackground(engine)
    if (!UiBackground) return false
    for (const [_e, bg] of engine.getEntitiesWith(UiBackground)) {
      const uvs = (bg as { uvs?: ArrayLike<number> | Record<string, number> }).uvs
      if (!uvs) continue
      let n = (uvs as { length?: number }).length ?? 0
      if (!n && typeof uvs === 'object' && !Array.isArray(uvs) && !ArrayBuffer.isView(uvs)) {
        const o = uvs as Record<string, unknown>
        while (Object.prototype.hasOwnProperty.call(o, String(n))) n++
      }
      if (n >= 8) return true
    }
  } catch {
    /* component not registered yet */
  }
  return false
}

/**
 * Play-mode react-ecs gate.
 *
 * - Pointer inject / flush: always reconcile (open menus, stabilize fingerprint).
 * - Active Transform/UI Tween: never defer (scale pulse, page flip, show/hide HUD).
 * - Pointer non-ui phase: suppress (phase-4 snapshot already taken; re-reconcile collapses UI).
 * - Pointer session (non-interactive): suppress (pointer batch owns UI).
 * - Cooperative idle: throttle; animating: every tick (~16ms).
 *
 * Do NOT gate on freeze latch or inject-only pollEvents DEFER.
 */
export function shouldDeferCooperativeReactEcs(): boolean {
  // Tween / UV HUD first — pointer-hold suppress must not freeze reeling bars
  // (R3.barHeight + UiBackground.uvs) or skip miss unmount (reelingUIVisible=false).
  if (workerHasUiDrivingTween(boundWorkerEngine)) return false
  if (workerHasUvDrivenUi(boundWorkerEngine)) return false
  // react-ecs Layer/Toast kits tween UiTransform.position via engine.addSystem
  // (showFrom / hideTo) — not core::Tween. After a scene-UI click the followup
  // window must reconcile every tick or the panel stays parked off-canvas.
  if (isCooperativeReactEcsPaintFollowupActive()) return false
  // No-target pointer edge / hold: systems only (defer react-ecs). Any scene may use
  // isPressed between DOWN and UP — do not thrash full UI reconcile on the hold window.
  if (isLevelStatePointerEdgeActive() || isLevelStatePointerHeld()) return true
  // isPointerInteractiveTickActive is false during non-ui phase — fall through to session suppress.
  if (isPointerInteractiveTickActive()) return false
  // World PE / UI hold (not empty-ground): marquee and select HUD need live react-ecs.
  if (isWorkerPointerButtonHeld()) return false
  if (shouldSuppressPointerSessionReactEcs()) return true
  // Wall-clock hold after PE/sceneUi phase-4 — suppress even when not in cooperative depth
  // (PE vehicle pump uses runSceneEngineUpdateNow without enterCooperativeSchedulerTick).
  // But never freeze scale animations mid-hold if a tween is live (checked above).
  // Exception: pointer still held (marquee) — never suppress (checked above).
  if (performance.now() < cooperativeReactEcsHoldUntilMs) return true
  if (cooperativeSchedulerTickDepth > 0) {
    if (cooperativeReactEcsHoldTicks > 0) {
      cooperativeReactEcsHoldTicks--
      return true
    }
    const now = performance.now()
    const minMs = COOPERATIVE_REACT_ECS_IDLE_MIN_MS
    if (now - lastCooperativeReactEcsAt < minMs) return true
  }
  return false
}

/** Whether the last cooperative eng.update skipped react-ecs (skip UI fingerprint scan). */
export function didSkipCooperativeReactEcsThisTick(): boolean {
  return cooperativeReactEcsSkippedThisTick
}

/** Throttle scene-system error spam (plaza flower-component getFrom races, etc.). */
const systemErrorLastLog = new Map<string, number>()
const SYSTEM_ERROR_LOG_MS = 5000

function logSystemThrow(system: SystemItem, err: unknown): void {
  const name = system.name || 'anonymous'
  const msg = err instanceof Error ? err.message : String(err)
  const key = `${name}|${msg}`
  const now = performance.now()
  const last = systemErrorLastLog.get(key) ?? 0
  if (now - last < SYSTEM_ERROR_LOG_MS) return
  systemErrorLastLog.set(key, now)
  // Flagtag/auth scenes often throw `syncEntity … already in use` after AUTH_RES —
  // must not abort the rest of the tick (lobby UI / InputModifier live in other systems).
  console.warn(`[sceneWorker] system "${name}" threw (continuing): ${msg}`)
}

/**
 * Run one system without aborting the rest of engine.update.
 * Sync throws (plaza flower-component, Flagtag syncEntity enum races) and async
 * rejections from scene systems that return Promises are both swallowed.
 */
function safeRunSystem(
  system: SystemItem,
  dt: number,
  runOne: (s: SystemItem, dt: number) => void
): void {
  try {
    const ret = runOne(system, dt) as unknown
    if (ret != null && typeof (ret as { then?: unknown }).then === 'function') {
      void (ret as Promise<unknown>).catch((err) => logSystemThrow(system, err))
    }
  } catch (err) {
    logSystemThrow(system, err)
  }
}

/** Installed once in the worker before scene bundle eval. */
export function installEngineSystemLoopPartition(): void {
  const g = globalThis as Record<string, unknown>
  if (typeof g[ENGINE_SYSTEM_LOOP_KEY] === 'function') return
  g[ENGINE_SYSTEM_LOOP_KEY] = (systems: SystemItem[], dt: number, runOne: (s: SystemItem, dt: number) => void) => {
    if (boundWorkerEngine) ensureWorkerLocomotionFreezePersisted(boundWorkerEngine)
    cooperativeReactEcsSkippedThisTick = false
    // First-wins for react-ecs: scene createReactBasedUiSystem registers before
    // asset-packs. Last-wins left Dead Surge running only the AP system (ui null
    // until async admin toolkit setUiRenderer) → permanent mount=0.
    let react: SystemItem | undefined
    let scale: SystemItem | undefined
    const sceneSystems: SystemItem[] = []
    for (const system of systems) {
      const name = system.name
      if (name === '@dcl/react-ecs') {
        if (!react) react = system
        continue
      }
      if (name === '@dcl/react-ecs-ui-scale') {
        if (!scale) scale = system
        continue
      }
      sceneSystems.push(system)
    }
    // WSP v2 Phase 0 — measure only (same run order as before).
    noteSystemsLoopBegin(sceneSystems.length + (scale ? 1 : 0) + (react ? 1 : 0))
    const sysT0 = performance.now()
    for (const system of sceneSystems) {
      noteSystemRun(system.name, () => safeRunSystem(system, dt, runOne))
    }
    addSystemsWallMs(performance.now() - sysT0)

    const suppressReact = shouldDeferCooperativeReactEcs()
    if (suppressReact && cooperativeSchedulerTickDepth > 0 && !isPointerInteractiveTickActive()) {
      cooperativeReactEcsSkippedThisTick = true
    }
    const reactT0 = performance.now()
    if (scale && !suppressReact) {
      noteSystemRun(scale.name || '@dcl/react-ecs-ui-scale', () => safeRunSystem(scale!, dt, runOne))
    }
    if (react && !suppressReact) {
      noteSystemRun(react.name || '@dcl/react-ecs', () => safeRunSystem(react!, dt, runOne))
      if (cooperativeSchedulerTickDepth > 0) lastCooperativeReactEcsAt = performance.now()
    }
    addReactWallMs(performance.now() - reactT0)
    noteSystemsLoopEnd()
  }
}

/** Seed RootEntity canvas info on the worker — react-ecs ui-scale reads this before main paints. */
export function seedWorkerUiCanvasInformation(engine: IEngine, width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
  preregisterRendererInjectedComponents(engine)
  const UiCanvasInformation = generated.UiCanvasInformation(engine)
  const w = Math.floor(width)
  const h = Math.floor(height)
  const fullCanvas = { left: 0, top: 0, right: w, bottom: h }
  UiCanvasInformation.createOrReplace(0 as Entity, {
    devicePixelRatio: 1,
    width: w,
    height: h,
    interactableArea: fullCanvas,
    screenInsetArea: { left: 0, top: 0, right: 0, bottom: 0 }
  })
}

let lastWorkerUiFingerprint = ''
const engineUiHooked = new WeakSet<IEngine>()

const DUPLICATE_SYSTEM_RE = /already added to the engine/i

/** Attach per-engine hooks (idempotent addSystem for duplicate bootstrap paths). */
export function installSceneEngineUiScheduler(engine: IEngine): void {
  if (engineUiHooked.has(engine)) return
  engineUiHooked.add(engine)

  const nativeAdd = engine.addSystem.bind(engine)
  engine.addSystem = (fn, priority, name) => {
    try {
      nativeAdd(fn, priority, name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (DUPLICATE_SYSTEM_RE.test(msg)) return
      throw err
    }
  }
}

/** @deprecated Use installSceneEngineUiScheduler */
export const installWorkerEngineUiHooks = installSceneEngineUiScheduler

export function resetWorkerUiFingerprint(): void {
  lastWorkerUiFingerprint = ''
  cooperativeReactEcsHoldTicks = 0
  cooperativeReactEcsHoldUntilMs = 0
  cooperativeReactEcsPaintFollowupUntilMs = 0
}

export function seedWorkerUiFingerprint(engine: IEngine): void {
  lastWorkerUiFingerprint = computeWorkerUiFingerprint(engine)
}

export function getWorkerUiFingerprintBaseline(): string {
  return lastWorkerUiFingerprint
}

export function hasWorkerReactEcsSync(_engine: IEngine): boolean {
  return typeof (globalThis as Record<string, unknown>)[ENGINE_SYSTEM_LOOP_KEY] === 'function'
}

function colorKey(c: { r?: number; g?: number; b?: number; a?: number } | undefined): string {
  if (!c) return ''
  return `${c.r ?? 0},${c.g ?? 0},${c.b ?? 0},${c.a ?? 0}`
}

function pointerEventsKey(
  spec: { pointerEvents: ReadonlyArray<{ eventType?: number; interactionType?: number }> } | null | undefined
): string {
  if (!spec?.pointerEvents.length) return ''
  return [...spec.pointerEvents]
    .map((entry) => `${entry.eventType ?? -1}.${entry.interactionType ?? 0}`)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .join(',')
}

export function computeWorkerUiFingerprint(engine: IEngine): string {
  preregisterRendererInjectedComponents(engine)
  const UiTransform = resolveWorkerUiTransform(engine)
  const UiBackground = resolveWorkerUiBackground(engine)
  const UiText = resolveWorkerUiText(engine)
  const PointerEvents = generated.PointerEvents(engine)
  const parts: string[] = []
  for (const [entity] of engine.getEntitiesWith(UiTransform)) {
    const t = UiTransform.getOrNull(entity)
    if (!t) continue
    // Layout geometry must be in the fingerprint — progress/HP bars only change width.
    // Without it, cooperative UI egress never flushes and the bar never grows on main.
    const tr = t as {
      display?: unknown
      opacity?: number
      parent?: number
      pointerFilter?: unknown
      width?: number
      height?: number
      widthUnit?: number
      heightUnit?: number
      flexDirection?: unknown
      justifyContent?: unknown
      alignItems?: unknown
      positionType?: number
      position?: { top?: number; right?: number; bottom?: number; left?: number }
      margin?: { top?: number; right?: number; bottom?: number; left?: number }
      padding?: { top?: number; right?: number; bottom?: number; left?: number }
    }
    let line =
      `${entity}:d${normalizeYGDisplay(tr.display)}:o${tr.opacity ?? 1}:p${tr.parent ?? 0}` +
      `:pf${normalizePointerFilterMode(tr.pointerFilter)}` +
      `:w${tr.width ?? 0}:${tr.widthUnit ?? 0}:h${tr.height ?? 0}:${tr.heightUnit ?? 0}` +
      `:fd${tr.flexDirection ?? 0}:j${tr.justifyContent ?? 0}:ai${tr.alignItems ?? 0}` +
      `:pt${tr.positionType ?? 0}` +
      `:pos${tr.position?.top ?? ''},${tr.position?.right ?? ''},${tr.position?.bottom ?? ''},${tr.position?.left ?? ''}` +
      `:m${tr.margin?.top ?? ''},${tr.margin?.right ?? ''},${tr.margin?.bottom ?? ''},${tr.margin?.left ?? ''}` +
      `:pad${tr.padding?.top ?? ''},${tr.padding?.right ?? ''},${tr.padding?.bottom ?? ''},${tr.padding?.left ?? ''}`
    const bg = UiBackground.getOrNull(entity)
    if (bg) {
      // Include atlas UVs — without them tutoE/tutoF crop never invalidates the fingerprint
      // and main keeps painting the full sheet (misrendered “celebrate” banner).
      let uvKey = ''
      const uvs = (bg as { uvs?: ArrayLike<number> | number[] }).uvs
      if (uvs) {
        const n = (uvs as { length?: number }).length ?? 0
        const count = n > 0 ? Math.min(8, n) : 0
        if (count >= 8) {
          const parts: string[] = []
          for (let i = 0; i < count; i++) parts.push(Number((uvs as ArrayLike<number>)[i]).toFixed(4))
          uvKey = parts.join(',')
        } else if (typeof uvs === 'object' && !Array.isArray(uvs) && !ArrayBuffer.isView(uvs)) {
          // Object-form after bad plain convert `{0:u0,1:v0,…}`.
          const parts: string[] = []
          const o = uvs as unknown as Record<string, number>
          for (let i = 0; i < 8; i++) {
            const v = Number(o[String(i)])
            if (!Number.isFinite(v)) break
            parts.push(v.toFixed(4))
          }
          if (parts.length >= 8) uvKey = parts.join(',')
        }
      }
      line += `:bg${colorKey(bg.color)}:${extractUiTextureSrc(bg.texture) ?? ''}:uv${uvKey}`
    }
    const text = UiText.getOrNull(entity)
    if (text) {
      const value = text.value ?? ''
      line += `:tx${value.length}:${value.slice(0, 32)}`
    }
    const pointer = PointerEvents.getOrNull(entity)
    const peKey = pointerEventsKey(pointer)
    if (peKey) line += `:pe${peKey}`
    parts.push(line)
  }
  parts.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return parts.join('|')
}

function parseFingerprintEntityLines(fingerprint: string): Map<string, string> {
  const lines = new Map<string, string>()
  if (!fingerprint) return lines
  for (const line of fingerprint.split('|')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    lines.set(line.slice(0, colon), line)
  }
  return lines
}

function fingerprintLineHasPointerEvents(line: string | undefined): boolean {
  return !!line && line.includes(':pe')
}

function touchWorkerUiEntityForCrdt(
  entity: Entity,
  components: {
    UiTransform: ReturnType<typeof resolveWorkerUiTransform>
    UiBackground: ReturnType<typeof resolveWorkerUiBackground>
    UiText: ReturnType<typeof resolveWorkerUiText>
    UiInput: ReturnType<typeof resolveWorkerUiInput>
    UiDropdown: ReturnType<typeof resolveWorkerUiDropdown>
    PointerEvents: ReturnType<typeof generated.PointerEvents>
  },
  opts?: { prevLine?: string; currLine?: string }
): number {
  const id = entity as Entity
  let touched = 0
  const transform = components.UiTransform.getOrNull(id)
  if (transform) {
    components.UiTransform.createOrReplace(id, { ...transform })
    touched++
  }
  const background = components.UiBackground.getOrNull(id)
  if (background) {
    components.UiBackground.createOrReplace(id, { ...background })
    touched++
  }
  const text = components.UiText.getOrNull(id)
  if (text) {
    components.UiText.createOrReplace(id, { ...text })
    touched++
  }
  const input = components.UiInput.getOrNull(id)
  if (input) {
    components.UiInput.createOrReplace(id, { ...input })
    touched++
  }
  const dropdown = components.UiDropdown.getOrNull(id)
  if (dropdown) {
    components.UiDropdown.createOrReplace(id, { ...dropdown })
    touched++
  }
  const pointer = components.PointerEvents.getOrNull(id)
  if (pointer) {
    components.PointerEvents.createOrReplace(id, {
      pointerEvents: pointer.pointerEvents.map((entry) => ({
        ...entry,
        eventInfo: entry.eventInfo ? { ...entry.eventInfo } : entry.eventInfo
      }))
    })
    touched++
  } else if (
    fingerprintLineHasPointerEvents(opts?.prevLine) &&
    !fingerprintLineHasPointerEvents(opts?.currLine)
  ) {
    // Entity stayed mounted but scene removed PointerEvents (welcome splash after click).
    // Without an explicit LWW delete, main kept the old PE catcher forever.
    if (forceLwwDelete(components.PointerEvents, id, { pointerEvents: [] })) touched++
  }
  return touched
}

/** Force LWW PUTs when react-ecs reconciled via getMutable (transport may skip byte-identical rows). */
export function touchWorkerUiComponentsForCrdt(engine: IEngine): number {
  preregisterRendererInjectedComponents(engine)
  const components = {
    UiTransform: resolveWorkerUiTransform(engine),
    UiBackground: resolveWorkerUiBackground(engine),
    UiText: resolveWorkerUiText(engine),
    UiInput: resolveWorkerUiInput(engine),
    UiDropdown: resolveWorkerUiDropdown(engine),
    PointerEvents: generated.PointerEvents(engine)
  }
  let touched = 0
  for (const [entity] of engine.getEntitiesWith(components.UiTransform)) {
    touched += touchWorkerUiEntityForCrdt(entity as Entity, components)
  }
  return touched
}

/** Queue DeleteComponent transport when react-ecs already removed the row (no has() left). */
function forceLwwDelete<T extends object>(
  comp: { has(entity: Entity): boolean; create(entity: Entity, val?: T): T; deleteFrom(entity: Entity): T | null },
  entity: Entity,
  stub: T
): boolean {
  if (comp.has(entity)) {
    comp.deleteFrom(entity)
    return true
  }
  comp.create(entity, stub)
  comp.deleteFrom(entity)
  return true
}

function touchRemovedUiEntityForCrdt(
  entity: Entity,
  components: {
    UiTransform: ReturnType<typeof resolveWorkerUiTransform>
    UiBackground: ReturnType<typeof resolveWorkerUiBackground>
    UiText: ReturnType<typeof resolveWorkerUiText>
    UiInput: ReturnType<typeof resolveWorkerUiInput>
    UiDropdown: ReturnType<typeof resolveWorkerUiDropdown>
    PointerEvents: ReturnType<typeof generated.PointerEvents>
  }
): number {
  const id = entity as Entity
  let touched = 0
  if (forceLwwDelete(components.PointerEvents, id, { pointerEvents: [] })) touched++
  if (
    forceLwwDelete(components.UiDropdown, id, {
      options: [],
      selectedIndex: 0,
      acceptEmpty: true,
      disabled: false
    })
  ) {
    touched++
  }
  if (forceLwwDelete(components.UiInput, id, { value: '', placeholder: '', disabled: false })) touched++
  if (forceLwwDelete(components.UiText, id, { value: '' })) touched++
  if (forceLwwDelete(components.UiBackground, id, { textureMode: 0, uvs: [] })) touched++
  if (forceLwwDelete(components.UiTransform, id, { width: 1, height: 1 } as never)) touched++
  return touched
}

/** Bulk menu/panel open — dirty-only can miss transport PUTs; touch every mounted Ui* row. */
const UI_MOUNT_GROWTH_FULL_TOUCH_MIN = 4
/**
 * When dirty entity count is below this fraction of mount (and under the absolute cap),
 * cooperative egress ships dirty rows only + full mount id list (not a full 500–800 row blob).
 */
const UI_DIRTY_SNAPSHOT_MAX_ENTITIES = 24
const UI_DIRTY_SNAPSHOT_MAX_FRACTION = 0.2

/** Entities touched by the last successful planSceneUiCrdtEmit (for dirty-only snapshot). */
let lastPlannedUiDirtyEntities: Entity[] = []
/** True when last plan used full-mount touch (boot growth / pointer force). */
let lastPlannedUiFullTouch = false

export function getLastPlannedUiDirtyEntities(): readonly Entity[] {
  return lastPlannedUiDirtyEntities
}

export function lastPlannedUiEmitWasFullTouch(): boolean {
  return lastPlannedUiFullTouch
}

/** Whether cooperative snapshot can ship dirty rows only (main still gets full mount ids). */
export function shouldUsePartialUiMountSnapshot(mountCount: number): boolean {
  if (lastPlannedUiFullTouch) return false
  if (mountCount <= 0) return false
  const dirty = lastPlannedUiDirtyEntities.length
  if (dirty <= 0) return false
  if (dirty > UI_DIRTY_SNAPSHOT_MAX_ENTITIES) return false
  if (dirty >= mountCount) return false
  return dirty / mountCount <= UI_DIRTY_SNAPSHOT_MAX_FRACTION
}

/** Touch only entities whose fingerprint line changed — boot baseline uses full mount when prev is empty. */
function touchDirtyWorkerUiComponentsForCrdt(
  engine: IEngine,
  prevFingerprint: string,
  currFingerprint: string
): { touched: number; dirty: Entity[]; fullTouch: boolean } {
  if (!prevFingerprint) {
    const touched = touchWorkerUiComponentsForCrdt(engine)
    return { touched, dirty: [], fullTouch: true }
  }

  const prevLines = parseFingerprintEntityLines(prevFingerprint)
  const currLines = parseFingerprintEntityLines(currFingerprint)
  const entityGrowth = currLines.size - prevLines.size
  if (entityGrowth >= UI_MOUNT_GROWTH_FULL_TOUCH_MIN) {
    const touched = touchWorkerUiComponentsForCrdt(engine)
    return { touched, dirty: [], fullTouch: true }
  }
  const dirty = new Set<Entity>()
  for (const [entityKey, line] of currLines) {
    if (prevLines.get(entityKey) !== line) dirty.add(Number(entityKey) as Entity)
  }
  for (const entityKey of prevLines.keys()) {
    if (!currLines.has(entityKey)) dirty.add(Number(entityKey) as Entity)
  }

  if (!dirty.size) return { touched: 0, dirty: [], fullTouch: false }

  preregisterRendererInjectedComponents(engine)
  const components = {
    UiTransform: resolveWorkerUiTransform(engine),
    UiBackground: resolveWorkerUiBackground(engine),
    UiText: resolveWorkerUiText(engine),
    UiInput: resolveWorkerUiInput(engine),
    UiDropdown: resolveWorkerUiDropdown(engine),
    PointerEvents: generated.PointerEvents(engine)
  }
  let touched = 0
  for (const entity of dirty) {
    const key = String(entity)
    if (prevLines.has(key) && !currLines.has(key)) {
      touched += touchRemovedUiEntityForCrdt(entity, components)
    } else {
      touched += touchWorkerUiEntityForCrdt(entity, components, {
        prevLine: prevLines.get(key),
        currLine: currLines.get(key)
      })
    }
  }
  return { touched, dirty: [...dirty], fullTouch: false }
}

export type PlanSceneUiCrdtEmitOptions = {
  /** Pointer interactive tick — full mount touch + deterministic encode. */
  pointerTick?: boolean
  /** Pointer tick — touch every mounted Ui* row before manual encode. */
  forceFullTouch?: boolean
}

/**
 * Phase 2 of a scheduler tick — touch dirty Ui* when fingerprint changed.
 * Caller runs engine.update(0) for transport emit, then commitSceneUiCrdtBaseline.
 */
/**
 * Coalesce pure UiText thrash (pixelwars score spam) without starving 1 Hz clocks.
 * Some scenes update UI timers once per second — 120ms was fine; content-blind
 * main dedupe was the real skip. Keep a short floor so multi-text-frame score spam
 * does not flood, but always allow after the floor when plan re-runs with new text.
 */
let lastTextOnlyUiFlushAt = 0
const TEXT_ONLY_UI_FLUSH_MIN_MS = 50
let lastUiFlushLogAt = 0
const UI_FLUSH_LOG_MIN_MS = 2000

export function planSceneUiCrdtEmit(
  engine: IEngine,
  log?: (message: string) => void,
  opts?: PlanSceneUiCrdtEmitOptions
): boolean {
  const fingerprint = computeWorkerUiFingerprint(engine)
  if (fingerprint === lastWorkerUiFingerprint) return false

  const prevLen = lastWorkerUiFingerprint.length
  lastPlannedUiDirtyEntities = []
  lastPlannedUiFullTouch = false

  if (opts?.forceFullTouch) {
    const touched = touchWorkerUiComponentsForCrdt(engine)
    if (touched <= 0) {
      log?.(
        `[sceneWorker] ui fingerprint changed without transport touch — fp=${prevLen}→${fingerprint.length}B`
      )
      return false
    }
    lastPlannedUiFullTouch = true
    log?.(`[sceneWorker] ui fingerprint flush — touched=${touched} fp=${prevLen}→${fingerprint.length}B full`)
    return true
  }

  const { touched, dirty, fullTouch } = touchDirtyWorkerUiComponentsForCrdt(
    engine,
    lastWorkerUiFingerprint,
    fingerprint
  )
  if (touched <= 0) {
    log?.(
      `[sceneWorker] ui fingerprint changed without transport touch — fp=${prevLen}→${fingerprint.length}B`
    )
    return false
  }

  // Pure text dirties (countdown / % stats) — rate-limit CRDT + main paint thrash.
  // Layout/bg/mount growth always flushes immediately.
  if (!fullTouch && dirty.length > 0 && dirty.length <= 4 && !opts?.pointerTick) {
    const prevLines = parseFingerprintEntityLines(lastWorkerUiFingerprint)
    const currLines = parseFingerprintEntityLines(fingerprint)
    let textOnly = true
    for (const entity of dirty) {
      const key = String(entity)
      const prev = prevLines.get(key) ?? ''
      const curr = currLines.get(key) ?? ''
      // Strip text payload; if remainder matches, only UiText value changed.
      const stripTx = (line: string) => line.replace(/:tx\d+:[^:]*/g, '')
      if (stripTx(prev) !== stripTx(curr)) {
        textOnly = false
        break
      }
    }
    if (textOnly) {
      const now = performance.now()
      if (now - lastTextOnlyUiFlushAt < TEXT_ONLY_UI_FLUSH_MIN_MS) {
        return false
      }
      lastTextOnlyUiFlushAt = now
    }
  }

  lastPlannedUiDirtyEntities = dirty
  lastPlannedUiFullTouch = fullTouch
  const now = performance.now()
  if (now - lastUiFlushLogAt >= UI_FLUSH_LOG_MIN_MS) {
    lastUiFlushLogAt = now
    log?.(
      `[sceneWorker] ui fingerprint flush — touched=${touched} dirtyEntities=${dirty.length || 'all'} ` +
        `fp=${prevLen}→${fingerprint.length}B${fullTouch ? ' full' : ''}`
    )
  }
  return true
}

/** Phase 4 — after transport emit tick. */
export function commitSceneUiCrdtBaseline(engine: IEngine): void {
  lastWorkerUiFingerprint = computeWorkerUiFingerprint(engine)
}

/** @deprecated Use planSceneUiCrdtEmit + scheduler tick phases. */
export async function flushWorkerSceneUiAfterEngineTick(
  engine: IEngine,
  log?: (message: string) => void
): Promise<boolean> {
  if (!planSceneUiCrdtEmit(engine, log)) return false
  try {
    await engine.update(0)
    commitSceneUiCrdtBaseline(engine)
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log?.(`[sceneWorker] ui fingerprint flush failed — ${msg || 'unknown error'}`)
    return false
  }
}

export { DEFERRED_UI_SYSTEM_NAMES }