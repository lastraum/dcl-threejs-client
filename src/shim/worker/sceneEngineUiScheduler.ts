import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { extractUiTextureSrc } from '../../ui/scene/uiBackgroundStyle'
import { normalizePointerFilterMode, normalizeYGDisplay } from '../../ui/scene/yogaEnums'

import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import { ensureWorkerLocomotionFreezePersisted } from './workerPlayerFrameEgress'
import {
  isPointerInteractiveTickActive,
  shouldSuppressCooperativeReactEcs as shouldSuppressPointerSessionReactEcs
} from './sceneWorkerInputSession'
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
 * Full react-ecs on 250–350 Ui* entities every 16ms saturates the worker after
 * connect (NPC flood + character UI) → engine-tick recovery / ~1fps.
 */
const COOPERATIVE_REACT_ECS_MIN_MS = 100
let lastCooperativeReactEcsAt = 0
/** True when the current cooperative eng.update skipped react-ecs (throttle). */
let cooperativeReactEcsSkippedThisTick = false

/**
 * After pointer phase-4 UI open, skip this many cooperative react-ecs reconciles so
 * open menus are not immediately collapsed by residual systems / poll edges.
 */
let cooperativeReactEcsHoldTicks = 0

export function holdCooperativeReactEcs(ticks: number): void {
  cooperativeReactEcsHoldTicks = Math.max(cooperativeReactEcsHoldTicks, ticks)
}

/**
 * Play-mode react-ecs gate.
 *
 * - Pointer inject / flush: always reconcile (open menus, stabilize fingerprint).
 * - Pointer non-ui phase: suppress (phase-4 snapshot already taken; re-reconcile collapses UI).
 * - Pointer session (non-interactive): suppress (pointer batch owns UI).
 * - Cooperative: at most every COOPERATIVE_REACT_ECS_MIN_MS (systems still run).
 *
 * Do NOT gate on freeze latch or inject-only pollEvents DEFER.
 */
export function shouldDeferCooperativeReactEcs(): boolean {
  // isPointerInteractiveTickActive is false during non-ui phase — fall through to session suppress.
  if (isPointerInteractiveTickActive()) return false
  if (shouldSuppressPointerSessionReactEcs()) return true
  if (cooperativeSchedulerTickDepth > 0) {
    if (cooperativeReactEcsHoldTicks > 0) {
      cooperativeReactEcsHoldTicks--
      return true
    }
    const now = performance.now()
    if (now - lastCooperativeReactEcsAt < COOPERATIVE_REACT_ECS_MIN_MS) return true
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
    let react: SystemItem | undefined
    let scale: SystemItem | undefined
    for (const system of systems) {
      const name = system.name
      if (name === '@dcl/react-ecs') {
        react = system
        continue
      }
      if (name === '@dcl/react-ecs-ui-scale') {
        scale = system
        continue
      }
      safeRunSystem(system, dt, runOne)
    }
    const suppressReact = shouldDeferCooperativeReactEcs()
    if (suppressReact && cooperativeSchedulerTickDepth > 0 && !isPointerInteractiveTickActive()) {
      cooperativeReactEcsSkippedThisTick = true
    }
    if (scale && !suppressReact) safeRunSystem(scale, dt, runOne)
    if (react && !suppressReact) {
      safeRunSystem(react, dt, runOne)
      if (cooperativeSchedulerTickDepth > 0) lastCooperativeReactEcsAt = performance.now()
    }
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
    let line = `${entity}:d${normalizeYGDisplay(t.display)}:o${t.opacity ?? 1}:p${t.parent ?? 0}:pf${normalizePointerFilterMode(t.pointerFilter)}`
    const bg = UiBackground.getOrNull(entity)
    if (bg) {
      line += `:bg${colorKey(bg.color)}:${extractUiTextureSrc(bg.texture) ?? ''}`
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

function touchWorkerUiEntityForCrdt(
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
      touched += touchWorkerUiEntityForCrdt(entity, components)
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
  lastPlannedUiDirtyEntities = dirty
  lastPlannedUiFullTouch = fullTouch
  log?.(
    `[sceneWorker] ui fingerprint flush — touched=${touched} dirtyEntities=${dirty.length || 'all'} ` +
      `fp=${prevLen}→${fingerprint.length}B${fullTouch ? ' full' : ''}`
  )
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