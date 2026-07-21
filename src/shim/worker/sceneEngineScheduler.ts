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
  /** ADR-215 GltfContainerLoadingState — SpaceRunner freezes until FINISHED. */
  gltfLoadingStatePuts: number
  gltfLoadingStateTerminalPuts?: number
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
 * Positive dt is clamped to wall-clock debt and committed to the scene-time ledger so
 * NeonScreen pauseDuration cannot be compressed by double ticks or unpatched paths.
 *
 * Do NOT substep nativeUpdate: each call runs every scene system + network transport.
 * Multi-stepping (even 2–3×) multiplies worker cost and starves TriggerArea / UI on large
 * scenes. Projectile tunneling is a discrete-sample scene concern, not solved by replaying
 * the full ECS loop.
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
/**
 * Cap a single engine.update dt (seconds). Explorer-class systems often run near 30–60 Hz;
 * allowing 100 ms jumps makes fast projectiles teleport (miss discrete hit spheres) and
 * look faster than wall clock after a hitch. Debt remains and is spent over following ticks
 * — not multi-update substeps (those re-run all systems and starve TriggerArea/UI).
 */
const MAX_ENGINE_DT_SEC = 1 / 30

function resolveDt(): number {
  const now = performance.now()
  if (wallClockOriginMs <= 0) {
    // Seed origin one starter interval in the past so the first tick has real debt
    // (origin=now would yield debt=0 forever until a later frame).
    const starter = Math.min(MAX_ENGINE_DT_SEC, Math.max(1 / 120, resolveIntervalMs() / 1000))
    wallClockOriginMs = now - starter * 1000
    sceneTimeSec = 0
    return starter
  }
  const debt = wallClockDebtSec(now)
  if (debt <= 1e-6) return 0
  return Math.min(debt, MAX_ENGINE_DT_SEC)
}

/** Clamp an explicit dt (e.g. flight pump) so it cannot race NeonScreen past wall clock. */
function clampDtToWallClock(requested: number): number {
  if (!(requested > 0)) return 0
  if (wallClockOriginMs <= 0) {
    // Seed ledger, then clamp request to the first-tick debt.
    const starter = resolveDt()
    return Math.min(requested, starter, MAX_ENGINE_DT_SEC)
  }
  const debt = wallClockDebtSec()
  if (debt <= 1e-6) return 0
  return Math.min(requested, debt, MAX_ENGINE_DT_SEC)
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
  if (!mountEntityIds.length && !snapshot.length) return
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
      (texSamples > 0 ? ` bgTextures=${texSamples}` : '')
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
    counts.gltfLoadingStatePuts > 0 ||
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

/** Extra react-ecs passes after inject — exit on stable UI fingerprint, not mount heuristics. */
const POINTER_UI_FINGERPRINT_FLUSH_MAX_PASSES = 12

async function flushReactEcsForUiSnapshot(
  eng: IEngine,
  log: (message: string) => void,
  interactive: boolean,
  maxPasses = POINTER_UI_FINGERPRINT_FLUSH_MAX_PASSES
): Promise<void> {
  if (!interactive) return
  let prevFp = ''
  let stablePasses = 0
  for (let pass = 0; pass < maxPasses; pass++) {
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
  beginPointerPlayerFrameBatch()
  setPointerInteractiveTickActive(true)
  setPointerInteractivePhase('inject')
  const mountBeforeDown = injectOnlyUiClick ? countWorkerUiMount(eng) : 0
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
        runPointerUiPhase4Egress(eng)
        // Hold cooperative react-ecs ONLY when a menu actually opened (mount grew).
        // PE Neurolink thrash: residual reconcile collapsed open panel (1245→1203).
        // CBD Plaza welcome splash: onMouseDown only starts a fade (same mount size) —
        // systems update Color4.a every frame; holding react-ecs freezes that alpha on the
        // last paint and leaves a half-visible full-screen PE catcher (pointer stuck).
        const mountGrew = mountAfterDownUpdate > mountBeforeDown
        if (mountGrew) {
          holdCooperativeReactEcs(90)
          cfg.log(
            `[sceneWorker] pointer phase-4 hold — mount=${countWorkerUiMount(eng)} ` +
              `texts=[${sampleWorkerUiTexts(eng)}] (menu open; skip multi-pass flush)`
          )
        } else {
          cfg.log(
            `[sceneWorker] pointer phase-4 no-hold — mount=${countWorkerUiMount(eng)} ` +
              `texts=[${sampleWorkerUiTexts(eng)}] (same mount; allow fade react-ecs)`
          )
        }

        cfg.onAfterEngineTick?.()
        cfg.log('[sceneWorker] pointer tick — skipping exports.onUpdate (inject path)')
        await runPointerNonUiPhase(eng)
        // Unblock cooperative eng.update NOW — welcome fade (nZ) needs real dt every frame.
        // Waiting for main forceResume left isPointerInputSessionActive true and starved systems.
        cfg.onSceneUiInjectPointerComplete?.({ mountGrew })
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
        cfg.log('[sceneWorker] pointer ui flush — post-UP react-ecs fingerprint')
        await flushReactEcsForUiSnapshot(eng, cfg.log, true)

        if (isRefuseFreezeWrites()) {
          const n = rewriteStopMoveCameraUiLabels(eng)
          if (n > 0) {
            cfg.log(`[sceneWorker] UI label fix — rewrote ${n} STOP MOVE CAMERA → MOVE CAMERA`)
          }
        }

        runPointerUiPhase4Egress(eng)
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