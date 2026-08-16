import type { IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import type { InjectPointerClickBody } from '../../player/injectPointerClick'
import {
  diagnoseLevelStateGroundRay,
  injectGlobalPointerUpOnPlayer,
  injectLevelStatePointerEdgeOnEngine,
  injectPointerClickDownOnEngine,
  injectPointerClickUpOnEngine,
  isIaPointerPressedOnEngine,
  isLevelStateInjectBody
} from './injectPointerClick'
import {
  bindWorkerUiSchedulerEngine,
  commitSceneUiCrdtBaseline,
  didSkipCooperativeReactEcsThisTick,
  enterCooperativeSchedulerTick,
  getLastPlannedUiDirtyEntities,
  holdCooperativeReactEcs,
  leaveCooperativeSchedulerTick,
  releaseCooperativeReactEcsHold,
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
  setLevelStatePointerEdgeActive,
  setPointerInteractivePhase,
  setPointerInteractiveTickActive
} from './sceneWorkerInputSession'
import {
  beginPointerPlayerFrameBatch,
  reconcileLocomotionLatchAfterInjectDown
} from './workerPlayerFrameEgress'
import {
  beginEngUpdatePhase,
  endEngUpdatePhase,
  resetEngUpdatePhases
} from './workerEngUpdatePhases'

let lastUiDirtySnapshotLogAt = 0

/** COD pointer proof lines — warn when available so they cannot share scene-log throttle. */
function pointerProofLog(message: string): void {
  const cfg = config
  if (cfg?.logWarn) cfg.logWarn(message)
  else cfg?.log(message)
}

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
  /**
   * Pointer/COD diagnostics that must never be throttled as normal scene noise.
   * Prefer workerLog('warn') so main pointerDiag + DevTools always show the line.
   */
  logWarn?: (message: string) => void
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
  ) => boolean | void
  onStuckRecover: () => void
  /**
   * Explorer: reserved LWW (PlayerIdentityData, RealmInfo) exists on the scene store
   * before sendBinary / systems. Called at the start of every eng.update (dt=0 included).
   */
  onBeforeEngineUpdate?: () => void
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
/**
 * After the first play-frame-tick, only SceneLoop (and pointer-edge immediate) may
 * start engine.update(dt>0). Inbound LWW / cooperative interval only queue.
 */
let sceneLoopOwnsPositiveDt = false
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
    config?.onBeforeEngineUpdate?.()
    // WSP v2 Phase 0 — phase meters around every eng.update (incl. dt=0 transport).
    if (!(dt > 0)) {
      beginEngUpdatePhase(0)
      try {
        await nativeUpdate(0)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/Profile not initialized/i.test(msg)) {
          console.warn(`[sceneWorker] eng.update(0) ${msg} (continuing)`)
        } else {
          throw err
        }
      } finally {
        endEngUpdatePhase()
      }
      return
    }
    // Wall since last positive tick *start* (or prior stamp).
    const applied = clampDtToWallClock(dt)
    // Stamp at START so this frame's eng.update work is not "lost" from scene time.
    const now = performance.now()
    if (wallClockOriginMs <= 0) wallClockOriginMs = now
    lastExecutedAt = now
    sceneTimeSec += applied
    beginEngUpdatePhase(applied)
    try {
      await nativeUpdate(applied)
    } finally {
      endEngUpdatePhase()
    }
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
  sceneLoopOwnsPositiveDt = false
  resetPlayModePointerUiEgress()
  resetEngUpdatePhases()
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

/**
 * Do **not** free the mutex while `eng.update` is still running.
 * Early release allowed concurrent eng.update (pointer budget / inject-received) and
 * collapsed Genesis Plaza into 5s tick-recovery thrash (~15–25 FPS).
 * Mutex always drains when the in-flight update's finally runs.
 */
export function forceReleaseEngineUpdateMutex(reason: string): void {
  const cfg = config
  if (engineUpdateInFlight) {
    // Log once-class: flag stays true until real eng.update settles — waiters stay serialized.
    cfg?.log(
      `[sceneWorker] engine update still in-flight — ${reason} (mutex held until eng.update settles)`
    )
    return
  }
  if (engineUpdateRelease) {
    cfg?.log(`[sceneWorker] engine update mutex force-release — ${reason}`)
    const release = engineUpdateRelease
    engineUpdateRelease = null
    release()
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

/** Pointer edge direct path — same mutex as cooperative ticks / scheduler. */
export async function runSerializedEngineUpdateForPointer(fn: () => Promise<void>): Promise<void> {
  await runSerializedEngineUpdate(fn)
}

/** MeshRenderer count on worker engine (level-state VFX proof). */
export function countWorkerMeshRenderers(eng: IEngine): number {
  return countWorkerMeshRenderer(eng)
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
/** Play-mode: cap cooperative UI snapshot posts — menu thrash was 10+/s and starved inject. */
let lastUiMountSnapshotPostAt = 0
let lastUiMountSnapshotMountLen = -1
const PLAY_UI_SNAPSHOT_MIN_MS = 50

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
  // Always post — including mount=[] + empty rows when react-ecs unmounts the last UI
  // (CBD welcome: Hr<=0 → return null). Skipping empty left main PE/DOM ghosts.
  const mode = cfg.isHydration() ? 'hydration' : 'play'
  let texSamples = 0
  for (const row of snapshot) {
    if (row.componentId !== 1053) continue
    const src = extractUiTextureSrcFromSnapshot(row.value)
    if (src) texSamples++
  }
  const nowLog = performance.now()
  const mountEmpty = mountEntityIds.length === 0
  const mountLenChanged = mountEntityIds.length !== lastUiMountSnapshotMountLen
  // Play: throttle same-size remounts (~50ms = Color4.a fade without 60Hz posts).
  // Always allow mount-size change / unmount / hydration.
  if (mode === 'play' && !mountEmpty && !mountLenChanged) {
    if (nowLog - lastUiMountSnapshotPostAt < PLAY_UI_SNAPSHOT_MIN_MS) {
      return
    }
  }
  lastUiMountSnapshotPostAt = nowLog
  lastUiMountSnapshotMountLen = mountEntityIds.length
  // Throttle log — full dumps every tick tanked FPS (<45) and blocked pointer inject.
  if (nowLog - lastUiDirtySnapshotLogAt >= 2000) {
    lastUiDirtySnapshotLogAt = nowLog
    cfg.log(
      `[sceneWorker] ui dirty snapshot — mount=${mountEntityIds.length} rows=${snapshot.length}` +
        `${partial ? ' partial' : ' full'} mode=${mode}` +
        (texSamples > 0 ? ` bgTextures=${texSamples}` : '') +
        (mountEmpty ? ' emptyMount' : '')
    )
  }
  if (cfg.postUiMountSnapshot) {
    const posted = cfg.postUiMountSnapshot(snapshot, mountEntityIds)
    // Commit fingerprint only after a real post — otherwise timer text was "sent" on the
    // worker while main never received it (rate-limit / content-blind dedupe).
    if (posted !== false) commitSceneUiCrdtBaseline(eng)
    return
  }
  commitSceneUiCrdtBaseline(eng)
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
 * Pointer phase 4 — structured mount snapshot after interactive click.
 * @param fullMount — true when mount set grew (open panel): full rows required.
 *                    false when only content dirtied: dirty-only rows + full mount ids.
 */
function runPointerUiPhase4Egress(eng: IEngine, opts?: { fullMount?: boolean }): void {
  const cfg = config!
  const fullMount = opts?.fullMount !== false
  planSceneUiCrdtEmit(eng, cfg.log, {
    pointerTick: true,
    forceFullTouch: fullMount
  })
  const mountEntityIds = collectWorkerUiMountEntityIds(eng)
  const dirtyOnly =
    !fullMount && shouldUsePartialUiMountSnapshot(mountEntityIds.length)
      ? new Set(getLastPlannedUiDirtyEntities().map((e) => e as number))
      : undefined
  const snapshot = collectWorkerUiMountSnapshot(eng, dirtyOnly)
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
  const mountEntities = new Set(
    fullMount
      ? mountEntityIds
      : snapshot.filter((r) => r.componentId === 1050).map((r) => r.entity)
  )
  if (!cfg.isHydration()) {
    notePlayModePointerUiEgress(mountEntities.size || mountEntityIds.length)
  }
  cfg.log(
    `[sceneWorker] pointer ui snapshot — mount=${mountEntityIds.length} rows=${snapshot.length}` +
      `${dirtyOnly ? ' partial' : ' full'} ` +
      `UiTransform=${uiTransform} UiBackground=${uiBackground} UiText=${uiText} ` +
      `UiInput=${uiInput} PointerEvents=${pointerEvents}`
  )
  cfg.queuePointerUiEgress?.(snapshot)
  // Flush attaches full mount ids via collectWorkerUiMountEntityIds (partial rows OK).
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
  // A 5s abort that includes mutex-wait must not epoch++ a live native update.
  // That marked completing plaza ticks as "preempted" and re-queued them — 17fps storm.
  if (engineUpdateInFlight) {
    config.log(
      `[sceneWorker] engine tick recovery skipped — ${reason} (native eng.update still running)`
    )
    return
  }
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
      if (sceneLoopOwnsPositiveDt) {
        tickQueued = true
        return
      }
      if (sceneEngineTickDue(performance.now())) {
        requestSceneEngineTick({ source: 'hydrate' })
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

/** started = wait for play-frame-done; deferred = in-flight/queued (do not done); idle = no tick. */
export type SceneEngineTickRequest = 'started' | 'deferred' | 'idle'

export type SceneEngineTickSource = 'play-frame' | 'pointer-edge' | 'hydrate'

export function setSceneLoopOwnsPositiveDt(on: boolean): void {
  sceneLoopOwnsPositiveDt = on
}

export function isSceneLoopOwnsPositiveDt(): boolean {
  return sceneLoopOwnsPositiveDt
}

/** Mark a real-dt tick needed; SceneLoop play-frame starts it. */
export function queueSceneEngineTick(): void {
  if (!engine || !bootSealed) return
  tickQueued = true
}

function sceneLoopAllowsStart(source: SceneEngineTickSource | undefined): boolean {
  if (!sceneLoopOwnsPositiveDt) return true
  return source === 'play-frame' || source === 'pointer-edge'
}

export function requestSceneEngineTick(
  opts?: { source?: SceneEngineTickSource }
): SceneEngineTickRequest {
  if (!engine || !bootSealed || !config) return 'idle'
  if (!sceneLoopAllowsStart(opts?.source)) {
    tickQueued = true
    return 'deferred'
  }
  if (config.pointerBlocksTick()) {
    tickQueued = true
    return 'deferred'
  }
  if (tickInFlight) {
    tickQueued = true
    return 'deferred'
  }
  let dt = resolveDt()
  // Same-frame re-entry: no wall elapsed yet — do not invent large time, but queue so
  // the next play-frame-tick can run (was a hard return that starved timers).
  if (dt <= 0 && lastExecutedAt > 0) {
    tickQueued = true
    return 'deferred'
  }
  if (dt <= 0) dt = Math.min(1 / 60, MAX_ENGINE_DT_SEC)
  const epoch = tickEpoch
  // This start satisfies any inbound queue (store already updated).
  tickQueued = false
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
        // SceneLoop owns the next start — do not chain a second update off this tick.
        if (sceneLoopOwnsPositiveDt) return
        if (sceneEngineTickDue(performance.now())) {
          tickQueued = false
          requestSceneEngineTick({ source: 'hydrate' })
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
  return 'started'
}

export function drainQueuedSceneEngineTick(): void {
  // Play mode: SceneLoop play-frame-tick is the only starter.
  if (sceneLoopOwnsPositiveDt) return
  if (!tickQueued || tickInFlight || !config) return
  if (config.pointerBlocksTick()) return
  if (!sceneEngineTickDue(performance.now())) return
  tickQueued = false
  requestSceneEngineTick({ source: 'hydrate' })
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
    // RaycastResult is applied via writeHostLwwNoDirty. Plaza fishing aims with a
    // continuous CameraEntity ray — do not treat a Result PUT as a reason to tick.
    // SceneLoop recasts once per guest tick; extra eng.update(0) starves Tweens.
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
  if (!hostInjectNeedsSceneSystems(counts)) return
  // Store is updated; SceneLoop starts the real-dt tick. Do not steal the mutex.
  queueSceneEngineTick()
}

function countWorkerUiMount(eng: IEngine): number {
  const UiTransform = resolveWorkerUiTransform(eng)
  let count = 0
  for (const _entry of eng.getEntitiesWith(UiTransform)) count++
  return count
}

/** Worker-side MeshRenderer count — diagnose getClick click-marker creation. */
function countWorkerMeshRenderer(eng: IEngine): number {
  try {
    const MeshRenderer = generated.MeshRenderer(eng)
    let n = 0
    for (const _ of eng.getEntitiesWith(MeshRenderer)) n++
    return n
  } catch {
    return -1
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
 * Scene DOM UI (react-ecs onMouseDown) — PE Neurolink / menu thrash fix.
 *
 * 1. PET_DOWN → eng.update(0) — onMouseDown toggle + remount (open panel)
 * 2. PET_UP (PlayerEntity + click leaf) with react-ecs **OFF** — clear isPressed
 *    without multi-pass fingerprint flush (that re-ran eng.update and toggled closed)
 * 3. phase-4 snapshot of the OPEN mount immediately
 * 4. hold cooperative react-ecs so residual ticks cannot collapse the panel
 * 5. non-ui phase
 *
 * Browser may still send phase=up later — that is a no-op for sceneUi (already cleared).
 */
async function runSceneUiPointerDownBatch(
  eng: IEngine,
  cfg: NonNullable<typeof config>,
  body: InjectPointerClickBody,
  mountBefore: number
): Promise<boolean> {
  await runSerializedEngineUpdate(async () => {
    injectPointerClickDownOnEngine(eng, body)
    await eng.update(0)
  })
  reconcileLocomotionLatchAfterInjectDown(eng)
  const mountAfterDown = countWorkerUiMount(eng)
  cfg.log(
    `[sceneWorker] pointer sceneUi DOWN done — mount ${mountBefore}→${mountAfterDown} e${body.entity}`
  )

  // PET_UP on PlayerEntity only — clear isPressed. react-ecs OFF (no remount thrash).
  setPointerInteractivePhase('inject')
  setPointerInteractiveTickActive(false)
  await runSerializedEngineUpdate(async () => {
    injectPointerClickUpOnEngine(eng, body)
    await eng.update(0)
  })
  cfg.onAfterEngineTick?.()

  setPointerInteractivePhase('flush')
  const mountAfter = countWorkerUiMount(eng)
  const mountGrew = mountAfter > mountBefore
  // Full rows only when a panel opened. Fade / same-size = dirty Color4.a.
  runPointerUiPhase4Egress(eng, { fullMount: mountGrew })
  if (mountGrew) {
    holdCooperativeReactEcs(12)
  } else {
    releaseCooperativeReactEcsHold()
  }
  cfg.log(
    `[sceneWorker] pointer sceneUi phase4 — mount=${mountAfter} grew=${mountGrew ? 1 : 0}`
  )
  return mountGrew
}

/**
 * Universal pointer edge tick (all scenes) — worker-input-architecture.
 *
 * Browser: pointerdown → phase=down; pointerup → phase=up.
 * - **World mesh:** one PET edge per browser edge; isPressed sticky until UP
 * - **Scene UI (sceneUi):** DOWN batch does DOWN+UP same worker job (toggle-safe);
 *   browser phase=up is ignored
 * - no exports.onUpdate mid-edge
 * - never multi-second session pause for mouse hold
 */
export async function runSceneEnginePointerTick(
  eng: IEngine,
  _runOnUpdate: () => Promise<void>,
  splitPointerInject?: InjectPointerClickBody | null
): Promise<void> {
  const cfg = config!
  const isSceneUi = !!splitPointerInject?.sceneUi
  let sceneUiInjectCompleteFired = false
  const fireSceneUiInjectComplete = (mountGrew: boolean): void => {
    if (!isSceneUi || sceneUiInjectCompleteFired) return
    sceneUiInjectCompleteFired = true
    cfg.onSceneUiInjectPointerComplete?.({ mountGrew })
  }
  beginPointerPlayerFrameBatch()
  const playerEntity = eng.PlayerEntity as number
  // Prefer explicit flag; recover if postMessage dropped levelState (still entity=1 hit=0).
  const isLevelStateEarly = !!(
    splitPointerInject &&
    isLevelStateInjectBody(splitPointerInject, playerEntity)
  )
  // Level-state: systems only (no react-ecs). PE/sceneUi: interactive so select HUD reconciles.
  setPointerInteractiveTickActive(!isLevelStateEarly)
  setPointerInteractivePhase('inject')
  if (isLevelStateEarly) setLevelStatePointerEdgeActive(true)
  const mountBefore = countWorkerUiMount(eng)
  let mountGrew = false
  try {
    if (!splitPointerInject) {
      await runSerializedEngineUpdate(async () => {
        await eng.update(0)
      })
      cfg.onAfterEngineTick?.()
      await runPointerNonUiPhase(eng)
      return
    }

    const phase = splitPointerInject.phase ?? 'down'
    cfg.log(
      `[sceneWorker] pointer edge — entity=${splitPointerInject.entity}` +
        ` sceneUi=${isSceneUi ? 1 : 0} phase=${phase}` +
        ` targets=[${(splitPointerInject.downEntities ?? splitPointerInject.entities).join(',')}]`
    )

    // --- Scene UI: toggle-safe DOWN batch; ignore browser UP ---
    if (isSceneUi) {
      if (phase === 'up') {
        // Already cleared isPressed in the DOWN batch — do not re-enter EventSystem.
        cfg.log(
          `[sceneWorker] pointer sceneUi UP ignored — cleared on DOWN batch e${splitPointerInject.entity}`
        )
        return
      }
      // phase=down or deprecated click
      mountGrew = await runSceneUiPointerDownBatch(eng, cfg, splitPointerInject, mountBefore)
      fireSceneUiInjectComplete(mountGrew)
      return
    }

    // No-target (level-state): PlayerEntity PET, hitEntity=0 — skip UI settle.
    const isLevelState = isLevelStateInjectBody(splitPointerInject, playerEntity)
    if (isLevelState && !splitPointerInject.levelState) {
      pointerProofLog(
        `[sceneWorker] no-target flag recovered — entity=${splitPointerInject.entity} ` +
          `hitEntity=${splitPointerInject.hitEntity}`
      )
    }

    // --- World mesh: inject PET only. Do not eng.update(0) — that is plaza's
    // 80–400ms send (dt=0, sb=wait) and holds the mutex so aim play-frames never run.
    if (!isLevelState && (phase === 'click' || phase === 'down' || phase === 'up')) {
      if (phase === 'down' || phase === 'click') {
        injectPointerClickDownOnEngine(eng, splitPointerInject)
        reconcileLocomotionLatchAfterInjectDown(eng)
      }
      if (phase === 'up' || phase === 'click') {
        injectPointerClickUpOnEngine(eng, splitPointerInject)
        injectGlobalPointerUpOnPlayer(eng, splitPointerInject)
      }
      requestSceneEngineTick({ source: 'pointer-edge' })
      cfg.log(
        `[sceneWorker] pointer world-mesh inject-only phase=${phase} e${splitPointerInject.entity}`
      )
      return
    }

    if (phase === 'down') {
      // One eng.update only — multi-update freezes plaza cooperative ticks.
      const sticky = isIaPointerPressedOnEngine(eng, splitPointerInject.button)
      await runSerializedEngineUpdate(async () => {
        if (sticky) injectLevelStatePointerEdgeOnEngine(eng, splitPointerInject, 'up')
        injectLevelStatePointerEdgeOnEngine(eng, splitPointerInject, 'down')
        await eng.update(0)
      })
      if (sticky) {
        pointerProofLog(
          '[sceneWorker] no-target DOWN sticky-clear — UP+DOWN same eng.update'
        )
      }
      reconcileLocomotionLatchAfterInjectDown(eng)
      cfg.onAfterEngineTick?.()
      try {
        const ground = diagnoseLevelStateGroundRay(eng)
        const g = ground.ground
        const pressed = isIaPointerPressedOnEngine(eng, splitPointerInject.button)
        pointerProofLog(
          `[sceneWorker] no-target DOWN isPressed-arm — pressed=${pressed ? 1 : 0} ` +
            `camY=${ground.camY?.toFixed(1) ?? '-'} rayY=${ground.rayY?.toFixed(2) ?? '-'} ` +
            `planeY0=${g ? `(${g.x.toFixed(1)},${g.z.toFixed(1)})` : 'null'} ` +
            `ppi=${ground.ppi ? 1 : 0} cam=${ground.cam ? 1 : 0} hitEntity=0`
        )
      } catch (err) {
        pointerProofLog(
          `[sceneWorker] no-target DOWN isPressed-arm — diagnose failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
      return
    }

    // phase === 'up' — no-target only (world mesh returned above).
    const mrBefore = countWorkerMeshRenderer(eng)
    await runSerializedEngineUpdate(async () => {
      injectLevelStatePointerEdgeOnEngine(eng, splitPointerInject, 'up')
      await eng.update(0)
    })
    // No-target: no second eng.update on the edge (plaza FPS). Cooperative tick follows.
    cfg.onAfterEngineTick?.()
    if (isLevelState) {
      try {
        const mrAfter = countWorkerMeshRenderer(eng)
        const delta = mrAfter - mrBefore
        const ground = diagnoseLevelStateGroundRay(eng)
        const g = ground.ground
        const stillPressed = isIaPointerPressedOnEngine(eng, splitPointerInject.button)
        const line =
          `[sceneWorker] no-target UP isPressed-path — MeshRenderer ${mrBefore}→${mrAfter} (Δ=${delta}) ` +
          `camY=${ground.camY?.toFixed(1) ?? '-'} rayY=${ground.rayY?.toFixed(2) ?? '-'} ` +
          `planeY0=${g ? `(${g.x.toFixed(1)},${g.z.toFixed(1)})` : 'null'} ` +
          `ppi=${ground.ppi ? 1 : 0} cam=${ground.cam ? 1 : 0} hitEntity=0 ` +
          `stillPressed=${stillPressed ? 1 : 0} ` +
          (delta === 0
            ? `(Δ=0: no new MeshRenderer this edge — scene gate or no unit selected)`
            : `(Δ>0: scene dirtied MeshRenderer — CRDT peel should apply)`)
        pointerProofLog(line)
      } catch (err) {
        pointerProofLog(
          `[sceneWorker] no-target UP isPressed-path — diagnose failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
    await runPointerNonUiPhase(eng)
  } finally {
    setLevelStatePointerEdgeActive(false)
    setPointerInteractivePhase('none')
    setPointerInteractiveTickActive(false)
    fireSceneUiInjectComplete(mountGrew)
  }
  if (isSceneUi || mountGrew) {
    cfg.onInjectOnlyUiPointerTickDone?.()
  }
}

export function syncSceneEngineHydrationTimer(): void {
  stopSceneEngineHydrationTimer()
  const cfg = config
  if (!cfg || !engine || !bootSealed || !cfg.isHydration()) return
  hydrationTimer = setInterval(() => {
    if (!bootSealed || tickInFlight) return
    if (sceneLoopOwnsPositiveDt) return
    if (config?.pointerBlocksTick()) return
    requestSceneEngineTick({ source: 'hydrate' })
  }, cfg.hydrationIntervalMs)
}

export function stopSceneEngineHydrationTimer(): void {
  if (hydrationTimer) {
    clearInterval(hydrationTimer)
    hydrationTimer = null
  }
}