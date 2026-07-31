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
import {
  isDualRootParked,
  isModalShellOnCanvas,
  isNoVisibleModalOnCanvas,
  isOpenPoseBlocked as isOpenPoseBlockedFromRows,
  isScaleSeedOpen,
  needsOpenScale as needsOpenScaleFromRows,
  resolveUiPoseRow,
  sampleOpenPoseBlockedFlags,
  sampleOpenPoseMicroSeeds as sampleOpenPoseMicroSeedsFromRows,
  type UiPoseRow,
  VIRTUAL_UI_HEIGHT,
  VIRTUAL_UI_WIDTH
} from './uiOpenPose'

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
  /**
   * Queue phase-4 structured UI mount for flushPointerDeferredOutboundsAsync.
   * fullPaint=true → main Forest once (remount/open); false → soft dirty / Patch growth.
   */
  queuePointerUiEgress?: (
    snapshot: WorkerUiMountSnapshotRow[],
    fullPaint?: boolean
  ) => void
  /**
   * Immediate structured UI mount post (hydration + play dirty).
   * Bypasses play-mode cold CRDT buffer which drops uiEntities/snapshot metadata.
   * `mountEntityIds` is always the full worker mount set; snapshot may be dirty-only.
   */
  postUiMountSnapshot?: (
    snapshot: WorkerUiMountSnapshotRow[],
    mountEntityIds: number[],
    /** Force Forest — phase-4 only; cooperative must pass false (COD P1). */
    forceFullPaint?: boolean
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
  /**
   * Open settle only: run exports.onUpdate(dt) with pollEvents deferred so plaza/fishing
   * scale timers in onUpdate can advance. eng.update alone left how-to-play stuck at 6×6
   * (fp frozen for 48 micro passes). Must not pollEvents mid-batch (replays click).
   */
  runOpenSettleSceneFrame?: (dt: number) => Promise<void>
  /**
   * Flush deferred pointer non-UI CRDT + queued UI mount now (before deliver-done).
   * Required so main receives Tween + first snapshot while we wait for scale growth.
   * Open-scale must not await long CRDT acks every pass (4s hang).
   */
  flushPointerDeferredOutboundsNow?: () => Promise<void>
  /** Fire-and-forget variant — post outbound without awaiting main acks. */
  flushPointerDeferredOutboundsFireAndForget?: () => void
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
    // Steady: Patch only. Brief post-open followup: fullPaint while micro/parked/off, then one
    // ready paint when dual-root slide / scale finishes (vending @2146 → on-canvas).
    const now = performance.now()
    const inWindow =
      openScaleFollowupFullUntil > 0 && now < openScaleFollowupFullUntil
    const midOpen = uiOpenPoseBlocked(eng)
    const fullPaint =
      inWindow && (midOpen || openScaleNeedReadyPaint)
    if (fullPaint && !midOpen) openScaleNeedReadyPaint = false
    if (!inWindow) {
      openScaleFollowupFullUntil = 0
      openScaleNeedReadyPaint = false
    }
    cfg.postUiMountSnapshot(snapshot, mountEntityIds, fullPaint)
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

/**
 * Pointer phase 4 — structured mount snapshot (sole play-mode UI click egress).
 * @param fullPaint main Forest once for remount/open; false for mid open-scale growth (Patch).
 */
function runPointerUiPhase4Egress(eng: IEngine, opts?: { fullPaint?: boolean }): void {
  const cfg = config!
  const wantFull = opts?.fullPaint !== false
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
      `UiInput=${uiInput} PointerEvents=${pointerEvents}` +
      `${wantFull ? ' fullPaint' : ' softPaint'}`
  )
  cfg.queuePointerUiEgress?.(snapshot, wantFull)
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
/**
 * Open settle budget — must finish well under pointer deliver path so phase-4
 * (UI snapshot + Tween CRDT) always posts. 48 passes + onUpdate burned ~4.4s and
 * raced past phase-4 → no first paint, scale stuck at ~7×7 (696×0.01).
 * Dual-root / scale finish on cooperative ticks after phase-4 when still mid-open.
 */
const POINTER_UI_OPEN_FLUSH_MAX_PASSES = 8
const POINTER_UI_OPEN_STABLE_NEEDED = 2
const POINTER_UI_OPEN_DT = 1 / 20
/** Hard wall cap inside open flush — leave headroom for phase-4 + open-scale. */
const POINTER_UI_OPEN_MAX_WALL_MS = 450
/**
 * Open-scale under pointer deliver — micro/shell path stays SHORT.
 * Oracle 19:12: no open-scale finish log + deliver-done +5s — onUpdate hung open-scale.
 * Cap onUpdate per pass; exit when modal shell on-canvas even if content still 6×6 seed.
 */
const POINTER_UI_OPEN_SCALE_MAX_WALL_MS = 500
/**
 * Dual-root shop (vending/inventory) parks content at left≥VW until Tween RTT unparks.
 * Oracle 21:33: dualRootParked progress=0 wall=591ms stillMid → blank grid icons on first open.
 * Need wall-clock for main to apply Tween CRDT + push TweenState mid open-scale (not only after
 * deliver-done). Micro-only wall stays short; dual-park uses this longer budget.
 */
const POINTER_UI_OPEN_SCALE_DUAL_PARK_MAX_WALL_MS = 1600
/** Wall-clock yield between dual-park passes so main rAF can advance Tween + deliver TweenState. */
const POINTER_UI_OPEN_SCALE_DUAL_PARK_YIELD_MS = 48
/** Per-pass cap for exports.onUpdate during open-scale (must not block deliver). */
const POINTER_UI_OPEN_SCALE_ONUPDATE_CAP_MS = 32
/**
 * After open-scale, cooperative forceFull while micro/parked + one ready paint.
 * Covers deliver-done latency (~ack wait) so dual-root unpark after open-scale still Forests.
 */
const POINTER_UI_OPEN_SCALE_FOLLOWUP_MS = 5000
/** If fp unchanged this many stable passes while pose blocked, stop waiting (can't invent scale). */
const POINTER_UI_OPEN_FROZEN_POSE_STABLE = 2

/** Wall-clock until which cooperative may forceFull for mid-open scale/unpark. */
let openScaleFollowupFullUntil = 0
/** One more fullPaint after micro clears so main paints usable peOnModal without a second click. */
let openScaleNeedReadyPaint = false

/** Re-arm cooperative fullPaint window while dual-root/micro still mid-open (after inject complete). */
export function rearmOpenScaleFollowupIfStillMidOpen(eng: IEngine): boolean {
  if (!isOpenPoseBlockedFromRows(collectUiPoseRows(eng))) return false
  openScaleFollowupFullUntil = performance.now() + POINTER_UI_OPEN_SCALE_FOLLOWUP_MS
  openScaleNeedReadyPaint = true
  return true
}

/**
 * Short positive-dt settle for close / page / fade / slot tweens — **any** UI size.
 * Guard is wall + fingerprint stable (not mount-count ranges).
 */
async function briefUiTweenSettle(
  eng: IEngine,
  log: (message: string) => void,
  label: string
): Promise<void> {
  const seed = computeWorkerUiFingerprint(eng)
  await flushReactEcsForUiSnapshot(eng, log, true, {
    maxPasses: 8,
    seedFp: seed,
    stableNeeded: 2,
    dt: POINTER_UI_OPEN_DT,
    minPasses: 2,
    minWallMs: 40,
    maxWallMs: 320,
    driveSceneOnUpdate: false
  })
  log(
    `[sceneWorker] pointer ${label} tween settle — mount=${countWorkerUiMount(eng)} ` +
      `seed=${seed.length}B wall≤320ms`
  )
}

/** Collect resolved pose rows from worker UiTransform (POINT + PERCENT). */
function collectUiPoseRows(eng: IEngine): Map<number, UiPoseRow> {
  const UiTransform = resolveWorkerUiTransform(eng)
  const byId = new Map<number, UiPoseRow>()
  for (const [entity] of eng.getEntitiesWith(UiTransform)) {
    const t = UiTransform.getOrNull(entity) as Parameters<typeof resolveUiPoseRow>[0] | null
    if (!t) continue
    const row = resolveUiPoseRow(t, VIRTUAL_UI_WIDTH, VIRTUAL_UI_HEIGHT)
    if (row) byId.set(entity as number, row)
  }
  return byId
}

/** COD single blocked gate — dual-park | scale seed | no visible modal. */
function uiOpenPoseBlocked(eng: IEngine): boolean {
  return isOpenPoseBlockedFromRows(collectUiPoseRows(eng))
}

function largeModalContentStillParked(eng: IEngine): boolean {
  return isDualRootParked(collectUiPoseRows(eng))
}

function uiOpenPoseStillMicro(eng: IEngine): boolean {
  return isScaleSeedOpen(collectUiPoseRows(eng))
}

/** @deprecated prefer uiOpenPoseBlocked — kept for log field labels only */
function uiOpenPoseNoVisibleModal(eng: IEngine): boolean {
  return isNoVisibleModalOnCanvas(collectUiPoseRows(eng))
}

function sampleOpenPoseMicroSeeds(eng: IEngine, limit = 4): string {
  return sampleOpenPoseMicroSeedsFromRows(collectUiPoseRows(eng), limit)
}

function uiOpenModalShellOnCanvas(eng: IEngine): boolean {
  return isModalShellOnCanvas(collectUiPoseRows(eng))
}

async function runOpenSettleOnUpdateCapped(
  cfg: SceneEngineSchedulerConfig,
  dt: number
): Promise<void> {
  if (!cfg.runOpenSettleSceneFrame) return
  await Promise.race([
    cfg.runOpenSettleSceneFrame(dt).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, POINTER_UI_OPEN_SCALE_ONUPDATE_CAP_MS))
  ])
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
    /**
     * When true and pose still blocked after eng.update, also run open-settle scene frame
     * (onUpdate with poll deferred). Prefer false for mesh open — onUpdate every pass
     * burned 4s+ without advancing scale (scale needs Tween CRDT to main first).
     */
    driveSceneOnUpdate?: boolean
    /** Hard wall-ms exit even if pose blocked (phase-4 must run; cooperative finishes scale). */
    maxWallMs?: number
  }
): Promise<void> {
  if (!interactive) return
  const maxPasses = options?.maxPasses ?? POINTER_UI_FINGERPRINT_FLUSH_MAX_PASSES
  const stableNeeded = options?.stableNeeded ?? POINTER_UI_SCENEU_STABLE_NEEDED
  const dt = options?.dt ?? 0
  const minPasses = Math.max(1, options?.minPasses ?? 1)
  const minWallMs = Math.max(0, options?.minWallMs ?? 0)
  const maxWallMs = Math.max(
    minWallMs,
    options?.maxWallMs ?? (dt > 0 ? POINTER_UI_OPEN_MAX_WALL_MS : 0)
  )
  const driveScene = options?.driveSceneOnUpdate === true && dt > 0
  const t0 = performance.now()
  let prevFp = options?.seedFp ?? ''
  let stablePasses = 0
  let sceneFrames = 0
  for (let pass = 0; pass < maxPasses; pass++) {
    await runSerializedEngineUpdate(async () => {
      await eng.update(dt)
    })
    // Optional onUpdate — not the primary scale path (Tween CRDT to main is).
    if (driveScene && config?.runOpenSettleSceneFrame && uiOpenPoseBlocked(eng)) {
      try {
        await config.runOpenSettleSceneFrame(dt)
        sceneFrames++
      } catch (err) {
        log(
          `[sceneWorker] open-settle onUpdate failed — ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
    const mount = countWorkerUiMount(eng)
    const fp = computeWorkerUiFingerprint(eng)
    const wall = performance.now() - t0
    const parked = largeModalContentStillParked(eng)
    const micro = uiOpenPoseStillMicro(eng)
    const offCanvas = uiOpenPoseNoVisibleModal(eng)
    // One pose-ready law everywhere: park + true scale seed + modal not on-canvas.
    const poseBlocked = parked || micro || offCanvas
    const logThis =
      pass < 6 || pass % 4 === 0 || pass + 1 === maxPasses || !poseBlocked
    if (logThis) {
      log(
        `[sceneWorker] pointer ui react-ecs flush pass=${pass + 1}/${maxPasses} mount=${mount} ` +
          `fp=${fp.length}B dt=${dt.toFixed(3)} wall=${wall.toFixed(0)}ms` +
          `${parked ? ' parked' : ''}${micro ? ' micro' : ''}${offCanvas ? ' offCanvas' : ''}` +
          `${sceneFrames > 0 ? ` onUp=${sceneFrames}` : ''}` +
          `${micro && pass === 0 ? ` seeds=[${sampleOpenPoseMicroSeeds(eng)}]` : ''}`
      )
    }
    // Hard wall — always leave time for phase-4 + Tween/UI deferred egress.
    if (maxWallMs > 0 && wall >= maxWallMs) {
      log(
        `[sceneWorker] pointer ui react-ecs flush WALL cap ${maxWallMs}ms ` +
          `poseBlocked=${poseBlocked} seeds=[${sampleOpenPoseMicroSeeds(eng)}] → phase-4`
      )
      return
    }
    if (prevFp && fp === prevFp) {
      stablePasses++
      // Pose ready: exit (or inventory final with only offCanvas residual).
      if (
        stablePasses >= stableNeeded &&
        pass + 1 >= minPasses &&
        wall >= minWallMs &&
        !poseBlocked
      ) {
        return
      }
      // Pose blocked but fp frozen — scale cannot invent itself here (needs main Tween).
      // Exit so phase-4 ships mount + Tween CRDT; cooperative finishes open.
      if (
        poseBlocked &&
        stablePasses >= POINTER_UI_OPEN_FROZEN_POSE_STABLE &&
        pass + 1 >= minPasses
      ) {
        log(
          `[sceneWorker] pointer ui react-ecs flush FROZEN fp while pose blocked ` +
            `stable=${stablePasses} seeds=[${sampleOpenPoseMicroSeeds(eng)}] → phase-4 (tween via main)`
        )
        return
      }
    } else {
      stablePasses = 0
    }
    prevFp = fp
  }
  if (uiOpenPoseBlocked(eng)) {
    log(
      `[sceneWorker] pointer ui react-ecs flush END pose still blocked ` +
        `parked=${largeModalContentStillParked(eng)} micro=${uiOpenPoseStillMicro(eng)} ` +
        `offCanvas=${uiOpenPoseNoVisibleModal(eng)} mount=${countWorkerUiMount(eng)} ` +
        `wall=${(performance.now() - t0).toFixed(0)}ms onUp=${sceneFrames} ` +
        `seeds=[${sampleOpenPoseMicroSeeds(eng)}] (phase-4 mid-open; cooperative continues)`
    )
  }
}

/**
 * Mid-open after phase-4: ship Tween+UI, pump eng.update until COD poseReady
 * (NOT dualParked, NOT scaleSeed, modal body on-canvas). Fail closed — never log
 * "pose ready" while dual-root content is still left≥virtualWidth.
 *
 * Dual-root: longer wall + wall-clock yields so main can apply Tween + push TweenState
 * (open-scale RTT). followupFull only when exiting still mid-open (cooperative residual).
 */
async function finishOpenScaleAfterPhase4(
  eng: IEngine,
  log: (message: string) => void
): Promise<void> {
  const cfg = config!
  // True skip only when NOT blocked (poseReady ≡ !blocked when fp stable).
  if (!uiOpenPoseBlocked(eng)) {
    if (cfg.flushPointerDeferredOutboundsNow) {
      await cfg.flushPointerDeferredOutboundsNow()
    }
    log(
      `[sceneWorker] open-scale skip — mount=${countWorkerUiMount(eng)} ` +
        `poseReady flags=${sampleOpenPoseBlockedFlags(collectUiPoseRows(eng))}`
    )
    return
  }
  const micro0 = uiOpenPoseStillMicro(eng)
  const parked0 = largeModalContentStillParked(eng)
  const offCanvas0 = uiOpenPoseNoVisibleModal(eng)
  // Snapshot #1 seed Forest — fire-and-forget (no multi-second ack wait under pointer).
  // Main must apply Tween CRDT + force-push TweenState during pointerAwaiting (SceneScriptSystem).
  runPointerUiPhase4Egress(eng, { fullPaint: true })
  if (cfg.flushPointerDeferredOutboundsFireAndForget) {
    cfg.flushPointerDeferredOutboundsFireAndForget()
  } else if (cfg.flushPointerDeferredOutboundsNow) {
    void cfg.flushPointerDeferredOutboundsNow()
  }
  log(
    `[sceneWorker] open-scale early egress — Tween+UI shipped seeds=[${sampleOpenPoseMicroSeeds(eng)}]` +
      `${micro0 ? ' micro' : ''}${parked0 ? ' dualParked' : ''}${offCanvas0 && !parked0 ? ' offCanvas' : ''}`
  )
  const t0 = performance.now()
  // Dual-park needs main RTT + wall-clock; micro-only stays short.
  let maxMs = parked0
    ? POINTER_UI_OPEN_SCALE_DUAL_PARK_MAX_WALL_MS
    : POINTER_UI_OPEN_SCALE_MAX_WALL_MS
  const maxPasses = parked0 ? 28 : 12
  let prevFp = computeWorkerUiFingerprint(eng)
  let progressPasses = 0
  let frozenStreak = 0
  let midGrowthShipped = false
  let lastMidEgressAt = 0
  setPointerInteractiveTickActive(true)
  setPointerInteractivePhase('flush')
  for (let i = 0; i < maxPasses; i++) {
    if (performance.now() - t0 > maxMs) break
    const stillBlocked = uiOpenPoseBlocked(eng)
    const stillMicro = uiOpenPoseStillMicro(eng)
    const stillParked = largeModalContentStillParked(eng)
    // Extend budget if dual-park appears mid-loop (seed had only micro).
    if (stillParked && maxMs < POINTER_UI_OPEN_SCALE_DUAL_PARK_MAX_WALL_MS) {
      maxMs = POINTER_UI_OPEN_SCALE_DUAL_PARK_MAX_WALL_MS
    }
    // Shell-ready only when dual-park is CLEAR and only micro content remains
    // (tutorial body 6×6 under full shell). NEVER when dual-root still parked.
    if (
      !stillParked &&
      stillMicro &&
      uiOpenModalShellOnCanvas(eng) &&
      i >= 2
    ) {
      log(
        `[sceneWorker] open-scale shell-ready after ${i + 1} passes — content micro → cooperative`
      )
      break
    }
    if (!stillBlocked) break

    await runSerializedEngineUpdate(async () => {
      await eng.update(POINTER_UI_OPEN_DT)
    })
    await runOpenSettleOnUpdateCapped(cfg, POINTER_UI_OPEN_DT)
    // Dual-park: longer wall yield so main rAF applies Tween + tween-state-deliver.
    // Micro: short yield (synthetic dt drives scale).
    const yieldMs = stillParked
      ? POINTER_UI_OPEN_SCALE_DUAL_PARK_YIELD_MS
      : stillMicro
        ? 8
        : 4
    await new Promise<void>((resolve) => setTimeout(resolve, yieldMs))

    const fp = computeWorkerUiFingerprint(eng)
    if (fp !== prevFp) {
      progressPasses++
      frozenStreak = 0
      prevFp = fp
      const now = performance.now()
      // Mid soft: first progress, then throttle re-egress while dual-park slides (not every pass).
      const shouldMidEgress =
        !midGrowthShipped ||
        (stillParked && now - lastMidEgressAt >= 120)
      if (shouldMidEgress) {
        midGrowthShipped = true
        lastMidEgressAt = now
        runPointerUiPhase4Egress(eng, { fullPaint: false })
        cfg.flushPointerDeferredOutboundsFireAndForget?.()
      }
      if (progressPasses <= 4 || i % 3 === 0) {
        log(
          `[sceneWorker] open-scale progress pass=${i + 1} fp=${fp.length}B ` +
            `seeds=[${sampleOpenPoseMicroSeeds(eng)}] ` +
            `flags=${sampleOpenPoseBlockedFlags(collectUiPoseRows(eng))}`
        )
      }
    } else {
      frozenStreak++
      // Frozen fp while still blocked: keep pumping until wall (do not claim ready).
      if (frozenStreak >= 3 && !stillBlocked) {
        log(
          `[sceneWorker] open-scale frozen fp after ${i + 1} passes → phase-4 poseReady`
        )
        break
      }
    }
  }
  // Snapshot #3 final full — fire-and-forget.
  const finalBlocked = uiOpenPoseBlocked(eng)
  const finalParked = largeModalContentStillParked(eng)
  const finalMicro = uiOpenPoseStillMicro(eng)
  runPointerUiPhase4Egress(eng, { fullPaint: true })
  if (cfg.flushPointerDeferredOutboundsFireAndForget) {
    cfg.flushPointerDeferredOutboundsFireAndForget()
  } else if (cfg.flushPointerDeferredOutboundsNow) {
    void cfg.flushPointerDeferredOutboundsNow()
  }
  // followupFull ONLY while still mid-open — never after true poseReady.
  if (finalBlocked) {
    openScaleFollowupFullUntil = performance.now() + POINTER_UI_OPEN_SCALE_FOLLOWUP_MS
    openScaleNeedReadyPaint = true
  } else {
    openScaleFollowupFullUntil = 0
    openScaleNeedReadyPaint = false
  }
  log(
    `[sceneWorker] open-scale finish — blocked=${finalBlocked} ` +
      `parked=${finalParked} micro=${finalMicro} ` +
      `flags=${sampleOpenPoseBlockedFlags(collectUiPoseRows(eng))} ` +
      `progress=${progressPasses} wall=${(performance.now() - t0).toFixed(0)}ms ` +
      `seeds=[${sampleOpenPoseMicroSeeds(eng)}] mount=${countWorkerUiMount(eng)}` +
      ` finalFull` +
      `${finalBlocked ? ' followupFull stillMid' : ' poseReady'}`
  )
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
        // COD single gate: dual-park | scale seed | no visible modal.
        const poseNeedsOpen = uiOpenPoseBlocked(eng)
        if ((!mountGrew && !mountShrunk && !poseNeedsOpen) || mountShrunk) {
          // Selection / page / close — any mount size.
          const selectSeed = computeWorkerUiFingerprint(eng)
          await flushReactEcsForUiSnapshot(eng, cfg.log, true, {
            maxPasses: 2,
            seedFp: selectSeed,
            stableNeeded: 1,
            dt: 0
          })
          await briefUiTweenSettle(
            eng,
            cfg.log,
            mountShrunk ? 'sceneUi-close' : 'sceneUi-tween'
          )
          cfg.log(
            `[sceneWorker] pointer sceneUi selection settle — mount=${mountAfterUp} seed=${selectSeed.length}B` +
              `${mountShrunk ? ' shrink' : ''} tweenSettle` +
              ` flags=${sampleOpenPoseBlockedFlags(collectUiPoseRows(eng))}`
          )
        } else if (mountGrew || poseNeedsOpen) {
          const openSeed = computeWorkerUiFingerprint(eng)
          cfg.log(
            `[sceneWorker] pointer sceneUi open flush — mount=${mountAfterUp} seed=${openSeed.length}B` +
              `${mountGrew ? ' grew' : ''}` +
              ` flags=${sampleOpenPoseBlockedFlags(collectUiPoseRows(eng))}`
          )
          await flushReactEcsForUiSnapshot(eng, cfg.log, true, {
            maxPasses: POINTER_UI_OPEN_FLUSH_MAX_PASSES,
            seedFp: openSeed,
            stableNeeded: POINTER_UI_OPEN_STABLE_NEEDED,
            dt: POINTER_UI_OPEN_DT,
            minPasses: 3,
            minWallMs: 150,
            maxWallMs: POINTER_UI_OPEN_MAX_WALL_MS,
            driveSceneOnUpdate: false
          })
          mountGrew = mountGrew || poseNeedsOpen
        }
        // Open-scale when still blocked after flush (hard dual-park / micro).
        const needsOpenScale = needsOpenScaleFromRows(
          mountGrew,
          collectUiPoseRows(eng)
        )
        if (needsOpenScale) {
          cfg.log(
            `[sceneWorker] pointer sceneUi mid-open — mount=${countWorkerUiMount(eng)} ` +
              `seeds=[${sampleOpenPoseMicroSeeds(eng)}] → open-scale (owns seed Forest)`
          )
          await finishOpenScaleAfterPhase4(eng, cfg.log)
        } else {
          runPointerUiPhase4Egress(eng, { fullPaint: true })
        }
        // Short hold only when open settled — residual PE cannot toggle closed.
        if (mountGrew) {
          const stillOpen = uiOpenPoseBlocked(eng)
          if (stillOpen) {
            cfg.log(
              `[sceneWorker] pointer phase-4 no-hold — mount=${countWorkerUiMount(eng)} ` +
                `pose still open seeds=[${sampleOpenPoseMicroSeeds(eng)}] (allow scale/tween)`
            )
          } else {
            holdCooperativeReactEcs(2)
            cfg.log(
              `[sceneWorker] pointer phase-4 hold — mount=${countWorkerUiMount(eng)} hold=2 ` +
                `texts=[${sampleWorkerUiTexts(eng)}] (menu open settled)`
            )
          }
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
        // Mesh/getClick: COD open settle — grow OR blocked pose → open path.
        const meshSeedFp = computeWorkerUiFingerprint(eng)
        const meshMount = countWorkerUiMount(eng)
        const mountGrewMesh = meshMount > mountBeforeDown
        const poseBlocked = uiOpenPoseBlocked(eng)
        const needOpenSettle = mountGrewMesh || poseBlocked
        cfg.log(
          `[sceneWorker] pointer ui flush — post-UP seed=${meshSeedFp.length}B ` +
            `mount=${mountBeforeDown}→${meshMount}` +
            `${mountGrewMesh ? ' grew' : ''}` +
            ` flags=${sampleOpenPoseBlockedFlags(collectUiPoseRows(eng))}`
        )
        await flushReactEcsForUiSnapshot(eng, cfg.log, true, {
          maxPasses: needOpenSettle ? POINTER_UI_OPEN_FLUSH_MAX_PASSES : 4,
          seedFp: meshSeedFp,
          stableNeeded: needOpenSettle ? POINTER_UI_OPEN_STABLE_NEEDED : 1,
          dt: needOpenSettle ? POINTER_UI_OPEN_DT : 0,
          minPasses: needOpenSettle ? 3 : 1,
          minWallMs: needOpenSettle ? 100 : 0,
          maxWallMs: needOpenSettle ? POINTER_UI_OPEN_MAX_WALL_MS : 0,
          driveSceneOnUpdate: false
        })

        if (isRefuseFreezeWrites()) {
          const n = rewriteStopMoveCameraUiLabels(eng)
          if (n > 0) {
            cfg.log(`[sceneWorker] UI label fix — rewrote ${n} STOP MOVE CAMERA → MOVE CAMERA`)
          }
        }

        // After flush: open-scale iff still blocked (hard dual-park / micro). Never skip as
        // "pose ready" while dual-root content remains left≥virtualWidth.
        const needsOpenScale = needsOpenScaleFromRows(
          needOpenSettle,
          collectUiPoseRows(eng)
        )
        if (needsOpenScale) {
          cfg.log(
            `[sceneWorker] pointer mesh mid-open — mount=${countWorkerUiMount(eng)} ` +
              `seeds=[${sampleOpenPoseMicroSeeds(eng)}] → open-scale (owns seed Forest)`
          )
          await finishOpenScaleAfterPhase4(eng, cfg.log)
        } else if (needOpenSettle) {
          runPointerUiPhase4Egress(eng, { fullPaint: true })
          // True poseReady only — no followupFull safety net on this branch.
          cfg.log(
            `[sceneWorker] pointer mesh phase-4 — mount=${countWorkerUiMount(eng)} ` +
              `open-scale skip poseReady flags=${sampleOpenPoseBlockedFlags(collectUiPoseRows(eng))}`
          )
        } else {
          await briefUiTweenSettle(eng, cfg.log, 'mesh-tween')
          runPointerUiPhase4Egress(eng, { fullPaint: true })
        }
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