import type { IEngine } from '@dcl/ecs'
import type { InjectPointerClickBody } from '../../player/injectPointerClick'
import {
  injectPointerClickDownOnEngine,
  injectPointerClickUpOnEngine
} from './injectPointerClick'
import {
  bindWorkerUiSchedulerEngine,
  commitSceneUiCrdtBaseline,
  computeWorkerUiFingerprint,
  didSkipCooperativeReactEcsThisTick,
  enterCooperativeSchedulerTick,
  getLastPlannedUiDirtyEntities,
  holdCooperativeReactEcs,
  leaveCooperativeSchedulerTick,
  notePlayModePointerUiEgress,
  planSceneUiCrdtEmit,
  resetPlayModePointerUiEgress,
  seedWorkerUiFingerprint,
  shouldUsePartialUiMountSnapshot
} from './sceneEngineUiScheduler'
import {
  resolveWorkerUiText,
  resolveWorkerUiTransform
} from './resolveBundledUiComponents'
import {
  collectWorkerUiMountEntityIds,
  collectWorkerUiMountSnapshot,
  type WorkerUiMountSnapshotRow
} from './workerSceneUiCrdtOutbound'
import {
  setPointerInteractivePhase,
  setPointerInteractiveTickActive
} from './sceneWorkerInputSession'
import {
  beginPointerPlayerFrameBatch,
  describeWorkerInputModifier,
  isRefuseFreezeWrites,
  reconcileLocomotionLatchAfterInjectDown,
  rewriteStopMoveCameraUiLabels
} from './workerPlayerFrameEgress'

/**
 * Single worker entry for sceneEngine.update — boot, hydration, play, inbound, pointer.
 *
 * Cooperative tick phases:
 *   1. engine.update(dt) — closure/timers + deferred react-ecs
 *   2. emitSceneUiMountSnapshotIfDirty — structured snapshot when fingerprint changes
 *      (hydration splash + play-mode async UI: QR textures, remote lists — not Ui* CRDT wire)
 *   3. onUnifiedPlayFrameComplete (pollEvents) — runs AFTER tickInFlight clears so a slow
 *      plaza onUpdate cannot starve the next eng.update (welcome Color4.a fade / timers).
 *
 * Pointer interactive tick:
 *   sceneUi: DOWN → flush → phase-4 → UP(PlayerEntity, react-ecs off) → non-ui
 *   mesh:    DOWN → UP(entity) → flush → phase-4 → non-ui
 * Inject path skips exports.onUpdate. Skipped onUpdate is not replayed in the deliver chain.
 */

export type SceneEngineSchedulerConfig = {
  log: (message: string) => void
  hydrationIntervalMs: number
  tickAbortMs: number
  isHydration: () => boolean
  resolvePlayIntervalMs: () => number
  pointerBlocksTick: () => boolean
  /** Queue phase-4 structured UI mount for flushPointerDeferredOutboundsAsync. */
  queuePointerUiEgress?: (snapshot: WorkerUiMountSnapshotRow[]) => void
  /**
   * Immediate structured UI mount post (hydration + play dirty).
   * Bypasses play-mode cold CRDT buffer which drops uiEntities/snapshot metadata.
   * `mountEntityIds` is always the full worker mount set; snapshot may be dirty-only.
   */
  postUiMountSnapshot?: (
    snapshot: WorkerUiMountSnapshotRow[],
    mountEntityIds: number[]
  ) => void
  onStuckRecover: () => void
  onAfterEngineTick?: () => void
  /**
   * Phase 2 — play mode only: pollEvents + cold CRDT flush after cooperative engine.update.
   * Replaces a second exports.onUpdate engine.update leg on the cooperative interval.
   */
  onUnifiedPlayFrameComplete?: (dt: number) => Promise<void>
  /** Inject-only UI pointer tick finished — defer SDK pollEvents on next exports.onUpdate. */
  onInjectOnlyUiPointerTickDone?: () => void
  /**
   * Scene DOM UI inject finished — end pointer session / unpause cooperative ticks immediately
   * so fade systems (CBD Plaza welcome nZ) get real dt without waiting for main resume.
   */
  onSceneUiInjectPointerComplete?: (info: { mountGrew: boolean }) => void
}

export type RendererInboundInjectCounts = {
  tweenPuts: number
  raycastPuts: number
  videoPlayerPuts: number
  audioSourcePuts: number
  /** ADR-215 GltfContainerLoadingState — SpaceRunner freezes until FINISHED. */
  gltfLoadingStatePuts: number
  gltfLoadingStateTerminalPuts?: number
  uiInputResultPuts: number
  uiDropdownResultPuts: number
  triggerAppends: number
  videoAppends: number
  pointerAppends: number
  audioAppends: number
  assetLoadAppends: number
}

let engine: IEngine | null = null
let config: SceneEngineSchedulerConfig | null = null
let tickInFlight = false
let tickQueued = false
let tickStartedAt = 0
let lastExecutedAt = 0
/**
 * Scene-time ledger — sum of positive dt passed to engine.update since wallClockOriginMs.
 * Intended so NeonScreen pauseDuration/scrollDuration (`elapsed += dt`) track wall clock.
 *
 * KNOWN (lastraum, 2026-07-14): still insufficient — plaza marquee row pause does not honor
 * scene pauseDuration (no hold / ~instant). Wall-clock ledger + engine.update wrap did not fix
 * it. Parked for follow-up; see TweenBridge KNOWN note.
 */
let wallClockOriginMs = 0
let sceneTimeSec = 0
let bootSealed = false
let hydrationTimer: ReturnType<typeof setInterval> | null = null
let diagCount = 0
let tickEpoch = 0
/** Serialize engine.update — cooperative ticks must not interleave with pointer interactive ticks. */
let engineUpdateMutex: Promise<void> = Promise.resolve()
let engineUpdateRelease: (() => void) | null = null
let engineUpdateInFlight = false
/** True only during intentional Ui CRDT transport emit — rpcCrdt must not attach uiEntities otherwise. */
let attachUiMountSnapshot = false
export function shouldAttachUiMountSnapshot(): boolean {
  return attachUiMountSnapshot
}

/** Run fn while rpcCrdt may attach uiEntities (pointer UI transport). */
export async function runWithUiMountSnapshot(fn: () => Promise<void>): Promise<void> {
  attachUiMountSnapshot = true
  try {
    await fn()
  } finally {
    attachUiMountSnapshot = false
  }
}

export function initSceneEngineScheduler(cfg: SceneEngineSchedulerConfig): void {
  config = cfg
}

type WallClockWrappedEngine = IEngine & { __threejsWallClockWrapped?: boolean }

/**
 * Intercept every engine.update — SDK onUpdate, pointer ticks, cooperative, flight.
 *
 * Explorer-style: positive dt tracks **wall clock between eng.update starts** (capped).
 * Stamping lastExecutedAt only *after* a long eng.update made scene time advance only by the
 * idle gap (e.g. 16ms) while the update itself took 100ms+ — CBD welcome nZ(dt) fade
 * (authored ~1.2s) ran multi-seconds and PE stayed mounted (hand cursor / freecam blocked).
 *
 * dt=0 stays transport-only (TweenState inject, pointer UI) and does not move the clock.
 * Do NOT substep nativeUpdate: each call runs every scene system + network transport.
 */
function wrapEngineUpdateWithWallClock(eng: IEngine): void {
  const wrapped = eng as WallClockWrappedEngine
  if (wrapped.__threejsWallClockWrapped) return
  const nativeUpdate = eng.update.bind(eng)
  wrapped.update = async (dt: number) => {
    if (!(dt > 0)) {
      await nativeUpdate(0)
      return
    }
    // Wall since last positive tick *start* (or prior stamp).
    const applied = clampDtToWallClock(dt)
    // Stamp at START so this frame's eng.update work is not "lost" from scene time.
    const now = performance.now()
    if (wallClockOriginMs <= 0) wallClockOriginMs = now
    lastExecutedAt = now
    sceneTimeSec += applied
    await nativeUpdate(applied)
  }
  wrapped.__threejsWallClockWrapped = true
}

export function bindSceneEngineScheduler(eng: IEngine | null): void {
  engine = eng
  if (eng) wrapEngineUpdateWithWallClock(eng)
  bindWorkerUiSchedulerEngine(eng)
}

export function resetSceneEngineScheduler(): void {
  stopSceneEngineHydrationTimer()
  engine = null
  tickInFlight = false
  tickQueued = false
  tickStartedAt = 0
  lastExecutedAt = 0
  wallClockOriginMs = 0
  sceneTimeSec = 0
  bootSealed = false
  diagCount = 0
  tickEpoch = 0
  resetPlayModePointerUiEgress()
}

export function resetSceneEngineDiagCount(): void {
  diagCount = 0
}

export function isSceneEngineBootSealed(): boolean {
  return bootSealed
}

export function isSceneEngineTickInFlight(): boolean {
  return tickInFlight
}

export function getSceneEngineTickStartedAt(): number {
  return tickStartedAt
}

export function getSceneEngineLastExecutedAt(): number {
  return lastExecutedAt
}

export function isEngineUpdateInFlight(): boolean {
  return engineUpdateInFlight || tickInFlight
}

/** Break a hung runSerializedEngineUpdate — awaitEngineUpdateIdle must not wait forever on the mutex. */
export function forceReleaseEngineUpdateMutex(reason: string): void {
  const cfg = config
  if (engineUpdateRelease) {
    cfg?.log(`[sceneWorker] engine update mutex force-release — ${reason}`)
    const release = engineUpdateRelease
    engineUpdateRelease = null
    engineUpdateInFlight = false
    release()
    return
  }
  if (engineUpdateInFlight) {
    cfg?.log(`[sceneWorker] engine update in-flight flag cleared — ${reason}`)
    engineUpdateInFlight = false
  }
}

/** Wait for any in-flight cooperative engine.update before pointer interactive tick. */
export async function awaitEngineUpdateIdle(timeoutMs = 4000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (isEngineUpdateInFlight()) {
    if (performance.now() >= deadline) {
      forceRecoverStuckSceneEngineTick('pointer-await-engine-idle')
      forceReleaseEngineUpdateMutex('pointer-await-engine-idle')
      break
    }
    await new Promise<void>((resolve) => queueMicrotask(resolve))
  }
  const mutexDeadline = performance.now() + timeoutMs
  await Promise.race([
    engineUpdateMutex.catch(() => {}),
    new Promise<void>((resolve) => {
      const waitMs = Math.max(0, mutexDeadline - performance.now())
      setTimeout(() => {
        if (performance.now() >= mutexDeadline) {
          forceReleaseEngineUpdateMutex('pointer-await-mutex-idle')
        }
        resolve()
      }, waitMs)
    })
  ])
}

async function runSerializedEngineUpdate(fn: () => Promise<void>): Promise<void> {
  const prior = engineUpdateMutex
  let release!: () => void
  engineUpdateMutex = new Promise<void>((resolve) => {
    release = resolve
  })
  await prior.catch(() => {})
  engineUpdateRelease = release
  engineUpdateInFlight = true
  try {
    await fn()
  } finally {
    engineUpdateInFlight = false
    engineUpdateRelease = null
    release()
  }
}

export function setSceneEngineLastExecutedAt(ms: number): void {
  lastExecutedAt = ms
}

/**
 * Explorer-style max frame step (seconds). Timers (`accumulatedTime += 1000*dt`) and
 * continuous systems need hitch recovery; 33ms was too tight and leftover “debt skips”
 * froze SDK setTimeout (Spring flower scale 0.1→1 after 500ms).
 *
 * Cap at 250ms so sustained heavy ticks (fishing cast/reel UI + plaza systems) still
 * advance scene time near wall clock. A 100ms cap with 5Hz ticks ran animations at ~½ speed.
 */
const MAX_ENGINE_DT_SEC = 0.25

/**
 * Wall elapsed still available for a positive system step (seconds).
 * Based on last positive update — not a cumulative ledger that can go permanently flat.
 */
function wallElapsedSinceLastTickSec(now = performance.now()): number {
  if (lastExecutedAt <= 0) return 1 / 60
  return Math.max(0, (now - lastExecutedAt) / 1000)
}

/**
 * Positive dt for engine.update (seconds).
 * dt=0 callers (TweenState inject, pointer UI) must pass 0 explicitly and not call this.
 *
 * Explorer model: dt = clamp(wall since last positive tick, 0, MAX). No skip-on-debt-ledger.
 */
function resolveDt(): number {
  const now = performance.now()
  if (wallClockOriginMs <= 0 || lastExecutedAt <= 0) {
    wallClockOriginMs = now
    lastExecutedAt = now
    sceneTimeSec = 0
    // First system step — ~one frame so timers start immediately.
    return Math.min(1 / 60, MAX_ENGINE_DT_SEC)
  }
  const elapsed = wallElapsedSinceLastTickSec(now)
  if (elapsed <= 1e-5) return 0
  return Math.min(elapsed, MAX_ENGINE_DT_SEC)
}

/**
 * Clamp an explicit positive dt so two concurrent update paths cannot double-count
 * the same wall interval. dt=0 remains exact 0.
 *
 * Same-ms re-entry: grant a tiny floor so SDK timers (`+= 1000*dt`) never hard-stall
 * under thrash (Explorer keeps advancing each frame).
 */
function clampDtToWallClock(requested: number): number {
  if (!(requested > 0)) return 0
  if (wallClockOriginMs <= 0 || lastExecutedAt <= 0) {
    wallClockOriginMs = performance.now()
    lastExecutedAt = wallClockOriginMs
    sceneTimeSec = 0
    return Math.min(requested, MAX_ENGINE_DT_SEC)
  }
  const elapsed = wallElapsedSinceLastTickSec()
  if (elapsed <= 1e-5) return Math.min(requested, 1 / 120, MAX_ENGINE_DT_SEC)
  return Math.min(requested, elapsed, MAX_ENGINE_DT_SEC)
}

function resolveIntervalMs(): number {
  const cfg = config!
  return cfg.isHydration() ? cfg.hydrationIntervalMs : cfg.resolvePlayIntervalMs()
}

export function sceneEngineTickDue(now: number): boolean {
  if (!engine || !bootSealed) return false
  // Explorer: run on the play/hydration interval. Do not require leftover “debt”
  // (that skipped ticks and froze SDK timers when dt was already spent that frame).
  if (lastExecutedAt <= 0) return true
  return now - lastExecutedAt >= resolveIntervalMs()
}

/**
 * Structured UI mount when worker fingerprint changes.
 *
 * Hydration: splash/composite.
 * Play mode: async react-ecs updates after a pointer open (QR texture mint, remote lists,
 * timers). Pointer phase-4 is still the click boundary; this path only ships fingerprint
 * deltas via postUiMountSnapshot — never Ui* CRDT on the cooperative rpcCrdt wire.
 *
 * Safe after inject-only PE append discard: cooperative remount no longer re-fires CAM toggle.
 */
async function emitSceneUiMountSnapshotIfDirty(eng: IEngine): Promise<void> {
  const cfg = config!
  if (cfg.pointerBlocksTick()) return
  if (!planSceneUiCrdtEmit(eng, cfg.log)) return
  const mountEntityIds = collectWorkerUiMountEntityIds(eng)
  const partial = shouldUsePartialUiMountSnapshot(mountEntityIds.length)
  const dirtyOnly = partial
    ? new Set(getLastPlannedUiDirtyEntities().map((e) => e as number))
    : undefined
  const snapshot = collectWorkerUiMountSnapshot(eng, dirtyOnly)
  commitSceneUiCrdtBaseline(eng)
  // Always post — including mount=[] + empty rows when react-ecs unmounts the last UI
  // (CBD welcome: Hr<=0 → return null). Skipping empty left main PE/DOM ghosts.
  const mode = cfg.isHydration() ? 'hydration' : 'play'
  let texSamples = 0
  for (const row of snapshot) {
    if (row.componentId !== 1053) continue
    const src = extractUiTextureSrcFromSnapshot(row.value)
    if (src) texSamples++
  }
  cfg.log(
    `[sceneWorker] ui dirty snapshot — mount=${mountEntityIds.length} rows=${snapshot.length}` +
      `${partial ? ' partial' : ' full'} mode=${mode}` +
      (texSamples > 0 ? ` bgTextures=${texSamples}` : '') +
      (mountEntityIds.length === 0 ? ' emptyMount' : '')
  )
  if (cfg.postUiMountSnapshot) {
    cfg.postUiMountSnapshot(snapshot, mountEntityIds)
    return
  }
  attachUiMountSnapshot = true
  try {
    await eng.update(0)
  } finally {
    attachUiMountSnapshot = false
  }
}

function extractUiTextureSrcFromSnapshot(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const bg = value as { texture?: unknown }
  const t = bg.texture as Record<string, unknown> | string | undefined
  if (typeof t === 'string') return t.trim() || null
  if (!t || typeof t !== 'object') return null
  if (typeof t.src === 'string') return t.src.trim() || null
  const tex = t.tex as { texture?: { src?: string } } | undefined
  if (typeof tex?.texture?.src === 'string') return tex.texture.src.trim() || null
  const nested = t.texture as { src?: string } | undefined
  if (typeof nested?.src === 'string') return nested.src.trim() || null
  return null
}

/** Pointer phase 4 — structured mount snapshot after interactive click (sole play-mode UI egress). */
function runPointerUiPhase4Egress(eng: IEngine): void {
  const cfg = config!
  planSceneUiCrdtEmit(eng, cfg.log, {
    pointerTick: true,
    forceFullTouch: true
  })
  const snapshot = collectWorkerUiMountSnapshot(eng)
  let uiTransform = 0
  let uiBackground = 0
  let uiText = 0
  let uiInput = 0
  let pointerEvents = 0
  for (const row of snapshot) {
    switch (row.componentId) {
      case 1050:
        uiTransform++
        break
      case 1052:
        uiText++
        break
      case 1053:
        uiBackground++
        break
      case 1093:
        uiInput++
        break
      case 1062:
        pointerEvents++
        break
      default:
        break
    }
  }
  const mountEntities = new Set(snapshot.filter((r) => r.componentId === 1050).map((r) => r.entity))
  if (!cfg.isHydration()) {
    notePlayModePointerUiEgress(mountEntities.size)
  }
  cfg.log(
    `[sceneWorker] pointer ui snapshot — mount=${mountEntities.size} rows=${snapshot.length} ` +
      `UiTransform=${uiTransform} UiBackground=${uiBackground} UiText=${uiText} ` +
      `UiInput=${uiInput} PointerEvents=${pointerEvents}`
  )
  cfg.queuePointerUiEgress?.(snapshot)
  commitSceneUiCrdtBaseline(eng)
}

/** Cooperative play / hydration tick. */
async function runCooperativeEngineTickPhases(engineDt: number): Promise<void> {
  const cfg = config!
  const eng = engine!
  if (cfg.pointerBlocksTick()) return
  // Re-clamp at execution time (async gap since resolveDt). Always run systems when
  // we still have wall elapsed — never drop a positive request to a no-op skip that
  // freezes timers for the whole interval.
  let dt = engineDt > 0 ? clampDtToWallClock(engineDt) : engineDt
  if (dt <= 0 && engineDt > 0) {
    // Race: another path committed the interval. Still give timers a tiny step so
    // setTimeout(500) cannot stall forever under thrash (Explorer keeps advancing).
    dt = Math.min(1 / 120, MAX_ENGINE_DT_SEC)
  }
  const epoch = tickEpoch
  if (diagCount < 8) {
    diagCount++
    cfg.log(
      `[sceneWorker] engine tick #${diagCount} dt=${dt.toFixed(3)} hydration=${cfg.isHydration()}` +
        ` sceneT=${sceneTimeSec.toFixed(2)}s elapsed=${wallElapsedSinceLastTickSec().toFixed(3)}`
    )
  }
  enterCooperativeSchedulerTick()
  try {
    await runSerializedEngineUpdate(async () => {
      // Wrapped update stamps wall clock at tick start + applies clamped dt.
      await eng.update(dt)
    })
  } finally {
    leaveCooperativeSchedulerTick()
  }
  if (epoch !== tickEpoch) {
    cfg.log('[sceneWorker] cooperative tick — preempted during engine.update')
    return
  }
  cfg.onAfterEngineTick?.()
  // UI fingerprint only when react-ecs ran — skipped ticks cannot flip display/text via react.
  if (!didSkipCooperativeReactEcsThisTick()) {
    await emitSceneUiMountSnapshotIfDirty(eng)
  }
  // onUnifiedPlayFrameComplete runs after tickInFlight clears (see requestSceneEngineTick).
}

/** Applied positive dt for the last completed eng.update leg (poll phase uses same step). */
let lastCompletedEngineDt = 0

async function executeTickWork(engineDt: number): Promise<void> {
  const cfg = config!
  let abortTimer: ReturnType<typeof setTimeout> | null = null
  lastCompletedEngineDt = 0
  try {
    await Promise.race([
      runCooperativeEngineTickPhases(engineDt),
      new Promise<never>((_, reject) => {
        abortTimer = setTimeout(
          () => reject(new Error(`engine tick exceeded ${cfg.tickAbortMs}ms`)),
          cfg.tickAbortMs
        )
      })
    ])
    lastCompletedEngineDt = engineDt
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('engine tick exceeded')) {
      forceRecoverStuckSceneEngineTick(msg)
      return
    }
    cfg.log(`[sceneWorker] engine tick failed — ${msg}`)
  } finally {
    if (abortTimer) clearTimeout(abortTimer)
  }
}

export function forceRecoverStuckSceneEngineTick(reason: string): void {
  if (!tickInFlight || !config) return
  config.log(
    `[sceneWorker] engine tick recovery — ${reason} (inFlight=${tickInFlight} queued=${tickQueued})`
  )
  tickEpoch++
  tickInFlight = false
  tickStartedAt = 0
  config.onStuckRecover()
  const requeue = tickQueued
  tickQueued = false
  if (requeue) {
    // Only re-fire when the play/hydration interval has elapsed — immediate re-entry
    // with a dt floor used to invent NeonScreen wall-clock (row pause disappeared).
    queueMicrotask(() => {
      if (sceneEngineTickDue(performance.now())) {
        requestSceneEngineTick()
      } else {
        tickQueued = true
      }
    })
  }
}

export function preemptSceneEngineTick(): void {
  if (!tickInFlight) return
  tickEpoch++
  tickInFlight = false
  tickStartedAt = 0
}

/**
 * One engine.update flush — used after MOVE CAMERA flight onUpdate while ticks are paused,
 * and after TweenState inject (dt=0) so tweenCompleted can fire without advancing wall clocks.
 *
 * eng.update is wall-clock wrapped: dt=0 commits nothing; positive dt is clamped to debt.
 */
export async function runSceneEngineUpdateNow(engineDt?: number): Promise<void> {
  const eng = engine
  if (!eng || !bootSealed || !config) return
  // Explicit 0 → transport-only (TweenState / pointer). Undefined → cooperative wall debt.
  const dt = engineDt === undefined ? resolveDt() : engineDt <= 0 ? 0 : engineDt
  try {
    await runSerializedEngineUpdate(async () => {
      await eng.update(dt)
    })
  } catch (err) {
    // Scene systems can throw after system-loop catch if update itself rejects.
    config.log(
      `[sceneWorker] engine.update(${dt}) failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
  config.onAfterEngineTick?.()
}

export function requestSceneEngineTick(): void {
  if (!engine || !bootSealed || !config) return
  if (config.pointerBlocksTick()) {
    tickQueued = true
    return
  }
  if (tickInFlight) {
    tickQueued = true
    return
  }
  let dt = resolveDt()
  // Same-frame re-entry: no wall elapsed yet — do not invent large time, but queue so
  // the next play-frame-tick can run (was a hard return that starved timers).
  if (dt <= 0 && lastExecutedAt > 0) {
    tickQueued = true
    return
  }
  if (dt <= 0) dt = Math.min(1 / 60, MAX_ENGINE_DT_SEC)
  const epoch = tickEpoch
  tickInFlight = true
  tickStartedAt = performance.now()
  void executeTickWork(dt)
    .finally(() => {
      // Always clear if we still own this epoch. If preempt bumped epoch, it already
      // cleared inFlight — never leave a stuck true that starves fishing bob/cast.
      // CRITICAL: clear BEFORE onUpdate (poll) so plaza onUpdate cannot hold eng.update
      // at ~10Hz and stretch Color4.a fade / PE unmount to multi-second wall time.
      if (epoch === tickEpoch) {
        tickInFlight = false
        tickStartedAt = 0
      } else if (tickInFlight && tickStartedAt > 0) {
        tickInFlight = false
        tickStartedAt = 0
      }
      if (tickQueued && config && !config.pointerBlocksTick()) {
        if (sceneEngineTickDue(performance.now())) {
          tickQueued = false
          requestSceneEngineTick()
        } else {
          const wait = Math.max(
            1,
            resolveIntervalMs() - (performance.now() - lastExecutedAt)
          )
          setTimeout(() => {
            if (tickQueued) drainQueuedSceneEngineTick()
          }, wait)
        }
      }
    })
    .then(async () => {
      if (epoch !== tickEpoch || !config) return
      if (config.isHydration() || !config.onUnifiedPlayFrameComplete) return
      const pollDt = lastCompletedEngineDt
      if (!(pollDt > 0)) return
      try {
        await config.onUnifiedPlayFrameComplete(pollDt)
      } catch (err) {
        config.log(
          `[sceneWorker] play frame poll after tick failed — ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    })
}

export function drainQueuedSceneEngineTick(): void {
  if (!tickQueued || tickInFlight || !config) return
  if (config.pointerBlocksTick()) return
  if (!sceneEngineTickDue(performance.now())) return
  tickQueued = false
  requestSceneEngineTick()
}

export async function runSceneEngineBootTick(eng: IEngine): Promise<void> {
  bootSealed = false
  tickInFlight = true
  tickStartedAt = performance.now()
  try {
    await runCooperativeEngineTickPhases(0)
    seedWorkerUiFingerprint(eng)
    bootSealed = true
    diagCount = 0
  } finally {
    tickInFlight = false
    tickStartedAt = 0
  }
}

/**
 * True when host inject includes any component scenes listen to via onChange / SDK systems.
 * Excludes tween-only (uses dt=0 path) and reserved pose heartbeats.
 */
export function hostInjectNeedsSceneSystems(counts: RendererInboundInjectCounts): boolean {
  return (
    counts.raycastPuts > 0 ||
    counts.videoPlayerPuts > 0 ||
    counts.audioSourcePuts > 0 ||
    counts.gltfLoadingStatePuts > 0 ||
    counts.uiInputResultPuts > 0 ||
    counts.uiDropdownResultPuts > 0 ||
    counts.triggerAppends > 0 ||
    counts.pointerAppends > 0 ||
    counts.videoAppends > 0 ||
    counts.audioAppends > 0 ||
    counts.assetLoadAppends > 0
  )
}

/**
 * After inbound LWW/append inject — request a real-dt engine tick only when systems need
 * time to advance (any host-owned component scene onChange / event systems care about).
 *
 * TweenState inject must NOT request a real-dt tick: NeonScreen (and similar) use wall-clock
 * elapsed in addSystem; extra ticks from ambient tween-state-deliver compressed pauseDuration
 * to near zero. Tween paths use runSceneEngineUpdateNow(0) instead.
 */
export function sceneEngineTickAfterInboundInject(counts: RendererInboundInjectCounts): void {
  if (hostInjectNeedsSceneSystems(counts)) requestSceneEngineTick()
}

function countWorkerUiMount(eng: IEngine): number {
  const UiTransform = resolveWorkerUiTransform(eng)
  let count = 0
  for (const _entry of eng.getEntitiesWith(UiTransform)) count++
  return count
}

/** Compact UiText sample for pointer diagnostics (must survive main log throttle). */
function sampleWorkerUiTexts(eng: IEngine, limit = 10): string {
  const UiText = resolveWorkerUiText(eng)
  const samples: string[] = []
  for (const [entity, text] of eng.getEntitiesWith(UiText)) {
    const value = (text as { value?: string }).value?.trim()
    if (!value) continue
    samples.push(`e${entity as number}:"${value.slice(0, 28)}"`)
    if (samples.length >= limit) break
  }
  return samples.length ? samples.join(', ') : '(no text)'
}

/** Extra react-ecs passes after inject — exit on stable UI fingerprint. */
const POINTER_UI_FINGERPRINT_FLUSH_MAX_PASSES = 12
const POINTER_UI_SCENEU_STABLE_NEEDED = 2
/**
 * Universal open settle (no shop/scale/kind classification).
 * Fingerprint includes position/size — keep eng.update(dt) until stable.
 * Cap maxPasses so we never multi-second stall; early-exit when stable.
 * Overhead: only until stable (typically 2–4 frames); not ongoing cost.
 */
const POINTER_UI_OPEN_FLUSH_MAX_PASSES = 12
const POINTER_UI_OPEN_STABLE_NEEDED = 2
const POINTER_UI_OPEN_DT = 1 / 20

/**
 * Dual large absolute roots: shell on-screen + content left≥1800 (fishing shop).
 * Used only for logging / optional extra passes — not a menu "kind".
 */
function largeModalContentStillParked(eng: IEngine): boolean {
  const UiTransform = resolveWorkerUiTransform(eng)
  let onScreen = 0
  let offRight = 0
  for (const [_entity] of eng.getEntitiesWith(UiTransform)) {
    const t = UiTransform.getOrNull(_entity) as {
      positionType?: number
      width?: number
      height?: number
      widthUnit?: number
      heightUnit?: number
      positionLeft?: number
      positionLeftUnit?: number
      position?: { left?: number; leftUnit?: number }
    } | null
    if (!t) continue
    if ((t.positionType ?? 0) !== 1 /* ABSOLUTE */) continue
    const wUnit = t.widthUnit ?? 0
    const hUnit = t.heightUnit ?? 0
    if (wUnit !== 1 && wUnit !== 0) continue
    if (hUnit !== 1 && hUnit !== 0) continue
    const w = t.width ?? 0
    const h = t.height ?? 0
    if (w < 800 || h < 400) continue
    if (w >= 1800) continue
    const leftU = t.positionLeftUnit ?? t.position?.leftUnit ?? 0
    if (leftU === 2 /* PERCENT */) continue
    const left = t.positionLeft ?? t.position?.left ?? 0
    if (left >= 1800) offRight++
    else if (left >= 0 && left < 1200) onScreen++
  }
  return onScreen > 0 && offRight > 0
}

/** True while open pose is only micro absolute panels (scale-from-zero still in flight). */
function uiOpenPoseStillMicro(eng: IEngine): boolean {
  const UiTransform = resolveWorkerUiTransform(eng)
  let micro = 0
  let full = 0
  for (const [_entity] of eng.getEntitiesWith(UiTransform)) {
    const t = UiTransform.getOrNull(_entity) as {
      positionType?: number
      width?: number
      height?: number
      widthUnit?: number
      heightUnit?: number
    } | null
    if (!t) continue
    if ((t.positionType ?? 0) !== 1 /* ABSOLUTE */) continue
    const wUnit = t.widthUnit ?? 0
    const hUnit = t.heightUnit ?? 0
    if (wUnit !== 1 && wUnit !== 0) continue
    if (hUnit !== 1 && hUnit !== 0) continue
    const w = t.width ?? 0
    const h = t.height ?? 0
    if (w >= 4 && h >= 4 && w <= 48 && h <= 48) micro++
    else if (w >= 200 && h >= 200 && w < 1800) full++
  }
  return micro > 0 && full === 0
}

async function flushReactEcsForUiSnapshot(
  eng: IEngine,
  log: (message: string) => void,
  interactive: boolean,
  options?: {
    maxPasses?: number
    seedFp?: string
    stableNeeded?: number
    /** 0 = structural only; positive advances open tweens. */
    dt?: number
    /**
     * Minimum eng.update passes before early-exit (open/selection animations).
     * Fingerprint can look "stable" while wall-clock scale tweens still have work.
     */
    minPasses?: number
    /**
     * Minimum wall-clock ms before early-exit. Plaza how-to-play / popup scale reads
     * Date.now() / Transform tweens — synthetic dt alone is not enough if we exit in 1 frame.
     */
    minWallMs?: number
  }
): Promise<void> {
  if (!interactive) return
  const maxPasses = options?.maxPasses ?? POINTER_UI_FINGERPRINT_FLUSH_MAX_PASSES
  const stableNeeded = options?.stableNeeded ?? POINTER_UI_SCENEU_STABLE_NEEDED
  const dt = options?.dt ?? 0
  const minPasses = Math.max(1, options?.minPasses ?? 1)
  const minWallMs = Math.max(0, options?.minWallMs ?? 0)
  const t0 = performance.now()
  let prevFp = options?.seedFp ?? ''
  let stablePasses = 0
  for (let pass = 0; pass < maxPasses; pass++) {
    await runSerializedEngineUpdate(async () => {
      await eng.update(dt)
    })
    const mount = countWorkerUiMount(eng)
    const fp = computeWorkerUiFingerprint(eng)
    const wall = performance.now() - t0
    const parked = largeModalContentStillParked(eng)
    const micro = uiOpenPoseStillMicro(eng)
    log(
      `[sceneWorker] pointer ui react-ecs flush pass=${pass + 1}/${maxPasses} mount=${mount} ` +
        `fp=${fp.length}B dt=${dt.toFixed(3)} wall=${wall.toFixed(0)}ms` +
        `${parked ? ' parked' : ''}${micro ? ' micro' : ''}`
    )
    if (prevFp && fp === prevFp) {
      stablePasses++
      // Pose not ready: keep simulating even if fingerprint bytes look stable
      // (scale/slide driven by wall-clock / systems that lag the fingerprint).
      if (
        stablePasses >= stableNeeded &&
        pass + 1 >= minPasses &&
        wall >= minWallMs &&
        !parked &&
        !micro
      ) {
        return
      }
    } else {
      stablePasses = 0
    }
    prevFp = fp
  }
}

/**
 * Post phase-4 — non-Ui system/CRDT only. react-ecs stays off so a second reconcile cannot
 * collapse a modal that phase-4 just snapshotted (architecture: phase 5 react-ecs off).
 * Locomotion unfreeze window still open via pointer session depth.
 */
async function runPointerNonUiPhase(eng: IEngine): Promise<void> {
  setPointerInteractivePhase('non-ui')
  // Drop interactive flag so shouldDeferCooperativeReactEcs suppresses @dcl/react-ecs.
  setPointerInteractiveTickActive(false)
  try {
    await runSerializedEngineUpdate(async () => {
      await eng.update(0)
    })
  } finally {
    setPointerInteractiveTickActive(true)
  }
  config?.onAfterEngineTick?.()
}

/**
 * Pointer interactive tick — one universal pipeline (worker-input-architecture).
 *
 * sceneUi (DOM / react-ecs onMouseDown) — PE Neurolink launcher thrash fix:
 *   1. inject PET_DOWN → engine.update(0) — onMouseDown toggle + remount (open panel)
 *   2. inject PET_UP (PlayerEntity + click entity), react-ecs OFF — clear isPressed
 *      without multi-pass fingerprint flush (that re-ran eng.update and toggled closed
 *      1245→1203 every click)
 *   3. phase-4 snapshot of the OPEN mount immediately
 *   4. hold cooperative react-ecs so PE pump / residual ticks cannot collapse the panel
 *   5. non-ui phase
 *
 * mesh / getClick:
 *   1. inject PET_DOWN → update
 *   2. inject PET_UP on hit targets → update
 *   3. fingerprint flush
 *   4. phase-4
 *   5. non-ui
 *
 * Inject path always skips exports.onUpdate (pollEvents mid-batch).
 */
export async function runSceneEnginePointerTick(
  eng: IEngine,
  runOnUpdate: () => Promise<void>,
  splitPointerInject?: InjectPointerClickBody | null
): Promise<void> {
  const cfg = config!
  // inject-pointer-click path: skip onUpdate (architecture). sceneUi marks DOM UI vs mesh.
  const injectOnlyUiClick = !!splitPointerInject?.sceneUi
  let sceneUiInjectCompleteFired = false
  const fireSceneUiInjectComplete = (mountGrew: boolean): void => {
    if (!injectOnlyUiClick || sceneUiInjectCompleteFired) return
    sceneUiInjectCompleteFired = true
    cfg.onSceneUiInjectPointerComplete?.({ mountGrew })
  }
  beginPointerPlayerFrameBatch()
  setPointerInteractiveTickActive(true)
  setPointerInteractivePhase('inject')
  // Always count — mesh open settle uses mount growth (not menu kind).
  const mountBeforeDown = countWorkerUiMount(eng)
  let mountGrew = false
  try {
    if (splitPointerInject) {
      cfg.log(
        `[sceneWorker] pointer inject — entity=${splitPointerInject.entity}` +
          ` sceneUi=${injectOnlyUiClick ? 1 : 0}` +
          ` down=[${(splitPointerInject.downEntities ?? splitPointerInject.entities).join(',')}]`
      )
      // Phase 1 — DOWN
      await runSerializedEngineUpdate(async () => {
        injectPointerClickDownOnEngine(eng, splitPointerInject)
        await eng.update(0)
      })
      reconcileLocomotionLatchAfterInjectDown(eng)
      const mountAfterDownUpdate = countWorkerUiMount(eng)
      cfg.log(
        `[sceneWorker] pointer DOWN done — mount ${mountBeforeDown}→${mountAfterDownUpdate}` +
          ` texts=[${sampleWorkerUiTexts(eng)}]` +
          ` ${describeWorkerInputModifier(eng)}`
      )

      if (injectOnlyUiClick) {
        // PET_UP clears isPressed. react-ecs OFF so we do not re-reconcile (and thrash toggles).
        // Multi-pass flush was collapsing Neurolink open→closed every click (1245→1203).
        setPointerInteractivePhase('inject')
        setPointerInteractiveTickActive(false)
        await runSerializedEngineUpdate(async () => {
          injectPointerClickUpOnEngine(eng, splitPointerInject)
          // Also UP the original click entity so residual PET_DOWN is not the latest on that id
          // (PlayerEntity-only UP left e2907 DOWN; later EventSystem edge cases re-toggle).
          const clickEntity = splitPointerInject.entity
          if (clickEntity !== (eng.PlayerEntity as number)) {
            injectPointerClickUpOnEngine(eng, {
              ...splitPointerInject,
              sceneUi: false,
              entities: [clickEntity],
              upEntities: [clickEntity],
              downEntities: [clickEntity]
            })
          }
          await eng.update(0)
        })
        const mountAfterUp = countWorkerUiMount(eng)
        cfg.log(
          `[sceneWorker] pointer UP early (no multi-flush) — mount ${mountAfterDownUpdate}→${mountAfterUp}` +
            ` (sceneUi; down was e${splitPointerInject.entity})` +
            ` texts=[${sampleWorkerUiTexts(eng)}]`
        )

        // Phase-4 from OPEN ECS state (react-ecs remount from DOWN still present).
        setPointerInteractivePhase('flush')
        if (isRefuseFreezeWrites()) {
          const n = rewriteStopMoveCameraUiLabels(eng)
          if (n > 0) {
            cfg.log(`[sceneWorker] UI label fix — rewrote ${n} STOP MOVE CAMERA → MOVE CAMERA`)
          }
        }
        // In-menu selection (inventory slot): mount does not grow, but react-ecs must
        // reconcile selection highlight after UP. One seeded pass — not full multipass
        // (that thrash-closed Neurolink). Skip for open/close (mountGrew) and pure fades.
        //
        // Large modal OPEN via sceneUi (inventory bag / shop HUD): same COD settle as mesh —
        // positive dt + fingerprint stable + refuse exit while content twin still parked.
        // Skipping this left dual-root shell@346 + content@2146 frozen → blank icons / PE ghost.
        mountGrew = mountAfterDownUpdate > mountBeforeDown
        const mountShrunk = mountAfterUp < mountAfterDownUpdate
        setPointerInteractiveTickActive(true)
        if (!mountGrew && !mountShrunk) {
          // Selection only: one/two reconcile passes, dt=0. Positive-dt multipass advanced
          // scene time and collapsed open menus (797→728) when clicking in-UI chrome.
          // Slot scale animation continues on cooperative ticks after inject complete.
          const selectSeed = computeWorkerUiFingerprint(eng)
          await flushReactEcsForUiSnapshot(eng, cfg.log, true, {
            maxPasses: 2,
            seedFp: selectSeed,
            stableNeeded: 1,
            dt: 0
          })
          cfg.log(
            `[sceneWorker] pointer sceneUi selection settle — mount=${mountAfterUp} seed=${selectSeed.length}B`
          )
        } else if (mountGrew) {
          // Menu open: one settle path — fingerprint stable with dt (no kind branches).
          const openSeed = computeWorkerUiFingerprint(eng)
          cfg.log(
            `[sceneWorker] pointer sceneUi open flush — mount=${mountAfterUp} seed=${openSeed.length}B`
          )
          await flushReactEcsForUiSnapshot(eng, cfg.log, true, {
            maxPasses: POINTER_UI_OPEN_FLUSH_MAX_PASSES,
            seedFp: openSeed,
            stableNeeded: POINTER_UI_OPEN_STABLE_NEEDED,
            dt: POINTER_UI_OPEN_DT,
            minPasses: 3,
            minWallMs: 200
          })
        }
        runPointerUiPhase4Egress(eng)
        // Neurolink: short hold only so residual PE cannot toggle closed. Keep short so
        // scale/fade systems still run (long hold froze tutorial / welcome).
        if (mountGrew) {
          // Tiny hold only for Neurolink toggle thrash — long holds freeze scale/open.
          holdCooperativeReactEcs(2)
          cfg.log(
            `[sceneWorker] pointer phase-4 hold — mount=${countWorkerUiMount(eng)} hold=2 ` +
              `texts=[${sampleWorkerUiTexts(eng)}] (menu open)`
          )
        } else {
          cfg.log(
            `[sceneWorker] pointer phase-4 no-hold — mount=${countWorkerUiMount(eng)} ` +
              `texts=[${sampleWorkerUiTexts(eng)}] (same mount; allow fade/selection/tween UI)`
          )
        }

        cfg.onAfterEngineTick?.()
        cfg.log('[sceneWorker] pointer tick — skipping exports.onUpdate (inject path)')
        await runPointerNonUiPhase(eng)
        // Unblock cooperative eng.update NOW — welcome fade (nZ) needs real wall-clock dt.
        fireSceneUiInjectComplete(mountGrew)
      } else {
        // Mesh inject path continues below for UP + flush + phase-4
        cfg.onAfterEngineTick?.()

        // inject path: never exports.onUpdate mid-batch (pollEvents undoes handler egress).
        cfg.log('[sceneWorker] pointer tick — skipping exports.onUpdate (inject path)')

        await runSerializedEngineUpdate(async () => {
          injectPointerClickUpOnEngine(eng, splitPointerInject)
          await eng.update(0)
        })
        cfg.onAfterEngineTick?.()

        setPointerInteractivePhase('flush')
        // Mesh/getClick: one settle path. Fingerprint-stable + dt advances open tweens
        // (scale, dual-root slide). No menu classification. Early-exit when stable.
        const meshSeedFp = computeWorkerUiFingerprint(eng)
        const meshMount = countWorkerUiMount(eng)
        // Mount grew ⇒ menu open (tutorial, shop, …). Need wall-clock settle so scale
        // popups are not snapshotted at ~6px (invisible). Not a menu-type classifier —
        // only "did the UI tree grow on this click?".
        const mountGrewMesh = meshMount > mountBeforeDown + 8
        cfg.log(
          `[sceneWorker] pointer ui flush — post-UP seed=${meshSeedFp.length}B ` +
            `mount=${mountBeforeDown}→${meshMount}${mountGrewMesh ? ' open' : ''}`
        )
        await flushReactEcsForUiSnapshot(eng, cfg.log, true, {
          maxPasses: mountGrewMesh ? 16 : POINTER_UI_OPEN_FLUSH_MAX_PASSES,
          seedFp: meshSeedFp,
          stableNeeded: POINTER_UI_OPEN_STABLE_NEEDED,
          dt: POINTER_UI_OPEN_DT,
          minPasses: mountGrewMesh ? 4 : 1,
          minWallMs: mountGrewMesh ? 250 : 0
        })

        if (isRefuseFreezeWrites()) {
          const n = rewriteStopMoveCameraUiLabels(eng)
          if (n > 0) {
            cfg.log(`[sceneWorker] UI label fix — rewrote ${n} STOP MOVE CAMERA → MOVE CAMERA`)
          }
        }

        runPointerUiPhase4Egress(eng)
        // No mesh hold — cooperative dirty must keep advancing scale / dual-root after snapshot.
        await runPointerNonUiPhase(eng)
      }
    } else {
      await runSerializedEngineUpdate(async () => {
        await eng.update(0)
      })
      await runSerializedEngineUpdate(async () => {
        await eng.update(0)
      })
      cfg.onAfterEngineTick?.()

      await runOnUpdate()

      setPointerInteractivePhase('flush')
      await flushReactEcsForUiSnapshot(eng, cfg.log, false)

      if (isRefuseFreezeWrites()) {
        const n = rewriteStopMoveCameraUiLabels(eng)
        if (n > 0) cfg.log(`[sceneWorker] UI label fix — rewrote ${n} STOP MOVE CAMERA → MOVE CAMERA`)
      }

      runPointerUiPhase4Egress(eng)
      await runPointerNonUiPhase(eng)
    }
  } finally {
    setPointerInteractivePhase('none')
    setPointerInteractiveTickActive(false)
    // Always end session for sceneUi — preempt/timeout must not leave react-ecs suppressed
    // (nZ would advance Hr but Color4.a would not paint; PE catcher stuck).
    fireSceneUiInjectComplete(mountGrew)
  }
  if (injectOnlyUiClick) {
    cfg.onInjectOnlyUiPointerTickDone?.()
  }
}

export function syncSceneEngineHydrationTimer(): void {
  stopSceneEngineHydrationTimer()
  const cfg = config
  if (!cfg || !engine || !bootSealed || !cfg.isHydration()) return
  hydrationTimer = setInterval(() => {
    if (!bootSealed || tickInFlight) return
    if (config?.pointerBlocksTick()) return
    requestSceneEngineTick()
  }, cfg.hydrationIntervalMs)
}

export function stopSceneEngineHydrationTimer(): void {
  if (hydrationTimer) {
    clearInterval(hydrationTimer)
    hydrationTimer = null
  }
}