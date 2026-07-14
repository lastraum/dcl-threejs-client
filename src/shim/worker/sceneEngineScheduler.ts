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
  leaveCooperativeSchedulerTick,
  notePlayModePointerUiEgress,
  planSceneUiCrdtEmit,
  resetPlayModePointerUiEgress,
  seedWorkerUiFingerprint,
  shouldUsePartialUiMountSnapshot
} from './sceneEngineUiScheduler'
import { resolveWorkerUiTransform } from './resolveBundledUiComponents'
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
 * Cooperative tick phases (hydration only for Ui CRDT):
 *   1. engine.update(dt) — closure/timers + deferred react-ecs
 *   2. emitSceneUiCrdtIfDirty — hydration splash/composite only
 *
 * Pointer interactive tick (only play-mode Ui CRDT egress) — same pipeline for every scene:
 *   1. inject PET_DOWN → engine.update(0) — handlers + systems
 *   2. inject PET_UP → engine.update(0) — no exports.onUpdate on inject path
 *   3. react-ecs flush until UI fingerprint stable (two identical passes)
 *   4. phase-4 structured mount snapshot egress (sole UI egress)
 *   5. engine.update(0) — react-ecs off (pointer session open); non-Ui CRDT deferred
 *
 * inject-only UI clicks skip exports.onUpdate mid-batch — SDK onUpdate runs pollEvents which
 * must not interleave before phase-4 / non-Ui egress (undoes MainCamera binds, UI flags, etc.).
 * Skipped onUpdate is not replayed in the deliver chain; cooperative schedule runs it next interval.
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
}

export type RendererInboundInjectCounts = {
  tweenPuts: number
  raycastPuts: number
  videoPlayerPuts: number
  triggerAppends: number
  videoAppends: number
  pointerAppends: number
}

let engine: IEngine | null = null
let config: SceneEngineSchedulerConfig | null = null
let tickInFlight = false
let tickQueued = false
let tickStartedAt = 0
let lastExecutedAt = 0
/**
 * Scene-time ledger — sum of positive dt passed to engine.update since wallClockOriginMs.
 * NeonScreen (pauseDuration/scrollDuration) does `elapsed += dt`; any path that invents dt
 * (floor, double ticks, flight clamp misses) compresses the 0.5s row hold to ~10ms.
 * Guarantees: sceneTimeSec never exceeds wall seconds since origin.
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
 * Positive dt is clamped to wall-clock debt and committed to the scene-time ledger so
 * NeonScreen pauseDuration cannot be compressed by double ticks or unpatched paths.
 */
function wrapEngineUpdateWithWallClock(eng: IEngine): void {
  const wrapped = eng as WallClockWrappedEngine
  if (wrapped.__threejsWallClockWrapped) return
  const nativeUpdate = eng.update.bind(eng)
  wrapped.update = async (dt: number) => {
    const applied = dt > 0 ? clampDtToWallClock(dt) : 0
    await nativeUpdate(applied)
    commitSceneDt(applied)
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
 * Wall-clock debt still available for scene systems (seconds).
 * sum(positive engine.update dt) is not allowed to exceed wall time since origin.
 */
function wallClockDebtSec(now = performance.now()): number {
  if (wallClockOriginMs <= 0) return 0
  const wallSec = (now - wallClockOriginMs) / 1000
  return Math.max(0, wallSec - sceneTimeSec)
}

/**
 * Positive dt for engine.update (seconds), hard-capped by wall-clock debt.
 * dt=0 callers (TweenState inject, pointer UI) must pass 0 explicitly and not call this.
 */
function resolveDt(): number {
  const now = performance.now()
  if (wallClockOriginMs <= 0) {
    // Seed origin one starter interval in the past so the first tick has real debt
    // (origin=now would yield debt=0 forever until a later frame).
    const starter = Math.min(0.1, Math.max(1 / 120, resolveIntervalMs() / 1000))
    wallClockOriginMs = now - starter * 1000
    sceneTimeSec = 0
    return starter
  }
  const debt = wallClockDebtSec(now)
  if (debt <= 1e-6) return 0
  return Math.min(debt, 0.1)
}

/** Clamp an explicit dt (e.g. flight pump) so it cannot race NeonScreen past wall clock. */
function clampDtToWallClock(requested: number): number {
  if (!(requested > 0)) return 0
  if (wallClockOriginMs <= 0) {
    // Seed ledger, then clamp request to the first-tick debt.
    const starter = resolveDt()
    return Math.min(requested, starter, 0.1)
  }
  const debt = wallClockDebtSec()
  if (debt <= 1e-6) return 0
  return Math.min(requested, debt, 0.1)
}

/** Commit scene time after a successful eng.update with dt>0. */
function commitSceneDt(dt: number): void {
  if (!(dt > 0)) return
  sceneTimeSec += dt
  lastExecutedAt = performance.now()
}

function resolveIntervalMs(): number {
  const cfg = config!
  return cfg.isHydration() ? cfg.hydrationIntervalMs : cfg.resolvePlayIntervalMs()
}

export function sceneEngineTickDue(now: number): boolean {
  if (!engine || !bootSealed) return false
  // Prefer wall-clock debt: if we already spent scene time up to wall, wait.
  // Also respect the configured play/hydration interval so we don't thrash at 0-debt.
  if (wallClockOriginMs <= 0 || lastExecutedAt <= 0) return true
  if (wallClockDebtSec(now) <= 1e-6) return false
  return now - lastExecutedAt >= resolveIntervalMs()
}

/**
 * When worker UI fingerprint changes, push a structured mount snapshot to main.
 * Full mount id list is always authoritative; row payload is dirty-only when the
 * change set is small (avoids 500–800 row posts + full yoga thrash for 1–2 entity flips).
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
  if (!mountEntityIds.length && !snapshot.length) return
  cfg.log(
    `[sceneWorker] ui dirty snapshot — mount=${mountEntityIds.length} rows=${snapshot.length}` +
      `${partial ? ' partial' : ' full'} hydration=${cfg.isHydration()}`
  )
  if (cfg.postUiMountSnapshot) {
    cfg.postUiMountSnapshot(snapshot, mountEntityIds)
    return
  }
  // Fallback: historical attachUiMount + engine.update path
  attachUiMountSnapshot = true
  try {
    await eng.update(0)
  } finally {
    attachUiMountSnapshot = false
  }
}

/** Pointer phase 4 — structured mount snapshot after interactive click. */
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
        uiBackground++
        break
      case 1053:
        uiText++
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
  // Re-clamp at execution time — resolveDt may have been computed before an async gap.
  // eng.update is wall-clock wrapped (clamp + ledger commit); skip empty positive requests.
  const dt = clampDtToWallClock(engineDt)
  if (dt <= 0 && engineDt > 0) {
    // No wall debt left (another path already spent it) — skip systems this turn.
    return
  }
  const epoch = tickEpoch
  if (diagCount < 8) {
    diagCount++
    cfg.log(
      `[sceneWorker] engine tick #${diagCount} dt=${dt.toFixed(3)} hydration=${cfg.isHydration()}` +
        ` sceneT=${sceneTimeSec.toFixed(2)}s debt=${wallClockDebtSec().toFixed(3)}`
    )
  }
  enterCooperativeSchedulerTick()
  try {
    await runSerializedEngineUpdate(async () => {
      // Wrapped update clamps again + commits sceneTimeSec.
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
  if (!cfg.isHydration() && cfg.onUnifiedPlayFrameComplete) {
    await cfg.onUnifiedPlayFrameComplete(dt)
  }
}

async function executeTickWork(engineDt: number): Promise<void> {
  const cfg = config!
  let abortTimer: ReturnType<typeof setTimeout> | null = null
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
  const dt = resolveDt()
  // No wall time since last real tick — skip. Queued thrash must not invent scene time.
  if (dt <= 0 && lastExecutedAt > 0) {
    return
  }
  const epoch = tickEpoch
  tickInFlight = true
  tickStartedAt = performance.now()
  void executeTickWork(dt).finally(() => {
    if (epoch !== tickEpoch) return
    tickInFlight = false
    tickStartedAt = 0
    if (tickQueued && config && !config.pointerBlocksTick()) {
      // Keep tickQueued if interval not due yet — drainQueued / play-frame will fire later.
      if (sceneEngineTickDue(performance.now())) {
        tickQueued = false
        requestSceneEngineTick()
      }
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
 * After inbound LWW/append inject — request a real-dt engine tick only when systems need
 * time to advance (raycast/video/trigger/pointer).
 *
 * TweenState inject must NOT request a real-dt tick: NeonScreen (and similar) use wall-clock
 * elapsed in addSystem; extra ticks from ambient tween-state-deliver compressed pauseDuration
 * to near zero. Tween paths use runSceneEngineUpdateNow(0) instead.
 */
export function sceneEngineTickAfterInboundInject(counts: RendererInboundInjectCounts): void {
  const needsTimedSystems =
    counts.raycastPuts > 0 ||
    counts.videoPlayerPuts > 0 ||
    counts.triggerAppends > 0 ||
    counts.pointerAppends > 0 ||
    counts.videoAppends > 0
  if (needsTimedSystems) requestSceneEngineTick()
}

function countWorkerUiMount(eng: IEngine): number {
  const UiTransform = resolveWorkerUiTransform(eng)
  let count = 0
  for (const _entry of eng.getEntitiesWith(UiTransform)) count++
  return count
}

/** Extra react-ecs passes after inject — exit on stable UI fingerprint, not mount heuristics. */
const POINTER_UI_FINGERPRINT_FLUSH_MAX_PASSES = 12

async function flushReactEcsForUiSnapshot(
  eng: IEngine,
  log: (message: string) => void,
  interactive: boolean
): Promise<void> {
  if (!interactive) return
  let prevFp = ''
  let stablePasses = 0
  for (let pass = 0; pass < POINTER_UI_FINGERPRINT_FLUSH_MAX_PASSES; pass++) {
    await runSerializedEngineUpdate(async () => {
      await eng.update(0)
    })
    // Do not bump lastExecutedAt on dt=0 — preserves wall-clock for NeonScreen etc.
    const mount = countWorkerUiMount(eng)
    const fp = computeWorkerUiFingerprint(eng)
    log(
      `[sceneWorker] pointer ui react-ecs flush pass=${pass + 1} mount=${mount} fp=${fp.length}B`
    )
    if (prevFp && fp === prevFp) {
      stablePasses++
      if (stablePasses >= 2) return
    } else {
      stablePasses = 0
    }
    prevFp = fp
  }
}

/**
 * Post phase-4 — one suppressed react-ecs update so handler/system non-Ui writes egress in-batch.
 * Runs while pointer unfreeze window is still open so STOP clear is not re-latched.
 */
async function runPointerNonUiPhase(eng: IEngine): Promise<void> {
  setPointerInteractivePhase('non-ui')
  await runSerializedEngineUpdate(async () => {
    await eng.update(0)
  })
  config?.onAfterEngineTick?.()
}

/**
 * Pointer interactive tick — DOWN/UP inject immediately before each engine.update(0).
 * Separate from cooperative ticks; one Ui mount snapshot at the end.
 */
export async function runSceneEnginePointerTick(
  eng: IEngine,
  runOnUpdate: () => Promise<void>,
  splitPointerInject?: InjectPointerClickBody | null
): Promise<void> {
  const cfg = config!
  const injectOnlyUiClick = !!splitPointerInject
  beginPointerPlayerFrameBatch()
  setPointerInteractiveTickActive(true)
  setPointerInteractivePhase('inject')
  try {
    if (splitPointerInject) {
      cfg.log(`[sceneWorker] pointer ui click — entity=${splitPointerInject.entity}`)
      await runSerializedEngineUpdate(async () => {
        injectPointerClickDownOnEngine(eng, splitPointerInject)
        await eng.update(0)
      })
      // Reconcile freeze latch after onMouseDown (handles unpatched SDK IM writes + STOP).
      reconcileLocomotionLatchAfterInjectDown(eng)
      cfg.log(`[sceneWorker] pointer DOWN done — ${describeWorkerInputModifier(eng)}`)
    } else {
      await runSerializedEngineUpdate(async () => {
        await eng.update(0)
      })
      await runSerializedEngineUpdate(async () => {
        await eng.update(0)
      })
    }
    // After DOWN — MOVE CAMERA freeze / STOP clear may already be applied.
    // dt=0 updates must not advance lastExecutedAt (marquee NeonScreen wall-clock).
    cfg.onAfterEngineTick?.()
    if (injectOnlyUiClick) {
      cfg.log('[sceneWorker] pointer tick — skipping exports.onUpdate (inject-only UI click)')
    } else {
      await runOnUpdate()
    }
    if (splitPointerInject) {
      await runSerializedEngineUpdate(async () => {
        injectPointerClickUpOnEngine(eng, splitPointerInject)
        await eng.update(0)
      })
      // After UP — republish player-frame if STOP/clear landed on this edge.
      cfg.onAfterEngineTick?.()
    }
    if (injectOnlyUiClick) {
      setPointerInteractivePhase('flush')
      cfg.log('[sceneWorker] pointer ui flush — react-ecs reconcile passes (inject-only fingerprint)')
    }
    await flushReactEcsForUiSnapshot(eng, cfg.log, injectOnlyUiClick)
    // After STOP force-unfreeze, react-ecs may still paint "STOP MOVE CAMERA" — fix label before snapshot.
    if (isRefuseFreezeWrites()) {
      const n = rewriteStopMoveCameraUiLabels(eng)
      if (n > 0) cfg.log(`[sceneWorker] UI label fix — rewrote ${n} STOP MOVE CAMERA → MOVE CAMERA`)
    }
    runPointerUiPhase4Egress(eng)
    // Non-ui phase still inside the unfreeze window so latched freeze cannot re-apply.
    await runPointerNonUiPhase(eng)
  } finally {
    setPointerInteractivePhase('none')
    setPointerInteractiveTickActive(false)
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