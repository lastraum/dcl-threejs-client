import type { IEngine } from '@dcl/ecs'
import type { InjectPointerClickBody } from '../../player/injectPointerClick'
import { injectPointerClickDownOnEngine, injectPointerClickUpOnEngine } from './injectPointerClick'
import {
  commitSceneUiCrdtBaseline,
  planSceneUiCrdtEmit,
  seedWorkerUiFingerprint
} from './sceneEngineUiScheduler'
import {
  collectWorkerUiMountSnapshot,
  type WorkerUiMountSnapshotRow
} from './workerSceneUiCrdtOutbound'
import { setPointerInteractiveTickActive } from './sceneWorkerInputSession'

/**
 * Single worker entry for sceneEngine.update — boot, hydration, play, inbound, pointer.
 *
 * Cooperative tick phases (hydration only for Ui CRDT):
 *   1. engine.update(dt) — closure/timers + deferred react-ecs
 *   2. emitSceneUiCrdtIfDirty — hydration splash/composite only
 *
 * Pointer interactive tick (only play-mode Ui CRDT egress):
 *   1. engine.update(0) — getClick(PET_DOWN)
 *   2. scene.exports.onUpdate(0)
 *   3. inject PET_UP → engine.update(0) — getClick(PET_UP) + react-ecs
 *   4. renderer-aligned Ui encode → pointerUiEgressChunks (atomic flush)
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
  onStuckRecover: () => void
  onAfterEngineTick?: () => void
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
let bootSealed = false
let hydrationTimer: ReturnType<typeof setInterval> | null = null
let diagCount = 0
let tickEpoch = 0
/** Serialize engine.update — cooperative ticks must not interleave with pointer interactive ticks. */
let engineUpdateMutex: Promise<void> = Promise.resolve()
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

export function bindSceneEngineScheduler(eng: IEngine | null): void {
  engine = eng
}

export function resetSceneEngineScheduler(): void {
  stopSceneEngineHydrationTimer()
  engine = null
  tickInFlight = false
  tickQueued = false
  tickStartedAt = 0
  lastExecutedAt = 0
  bootSealed = false
  diagCount = 0
  tickEpoch = 0
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

/** Wait for any in-flight cooperative engine.update before pointer interactive tick. */
export async function awaitEngineUpdateIdle(timeoutMs = 4000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (isEngineUpdateInFlight()) {
    if (performance.now() >= deadline) {
      forceRecoverStuckSceneEngineTick('pointer-await-engine-idle')
      break
    }
    await new Promise<void>((resolve) => queueMicrotask(resolve))
  }
  await engineUpdateMutex.catch(() => {})
}

async function runSerializedEngineUpdate(fn: () => Promise<void>): Promise<void> {
  const prior = engineUpdateMutex
  let release!: () => void
  engineUpdateMutex = new Promise<void>((resolve) => {
    release = resolve
  })
  await prior.catch(() => {})
  engineUpdateInFlight = true
  try {
    await fn()
  } finally {
    engineUpdateInFlight = false
    release()
  }
}

export function setSceneEngineLastExecutedAt(ms: number): void {
  lastExecutedAt = ms
}

function resolveDt(): number {
  const cfg = config!
  const elapsed = lastExecutedAt > 0 ? (performance.now() - lastExecutedAt) / 1000 : 0.1
  const floor = cfg.isHydration() ? cfg.hydrationIntervalMs / 1000 : 1 / 120
  return Math.min(Math.max(elapsed, floor), 0.1)
}

function resolveIntervalMs(): number {
  const cfg = config!
  return cfg.isHydration() ? cfg.hydrationIntervalMs : cfg.resolvePlayIntervalMs()
}

export function sceneEngineTickDue(now: number): boolean {
  if (!engine || !bootSealed) return false
  if (lastExecutedAt <= 0) return true
  return now - lastExecutedAt >= resolveIntervalMs()
}

async function emitSceneUiCrdtIfDirty(eng: IEngine): Promise<void> {
  const cfg = config!
  if (cfg.pointerBlocksTick()) return
  if (!cfg.isHydration()) return
  if (!planSceneUiCrdtEmit(eng, cfg.log)) return
  attachUiMountSnapshot = true
  try {
    await eng.update(0)
    commitSceneUiCrdtBaseline(eng)
  } finally {
    attachUiMountSnapshot = false
  }
}

/** Pointer phase 4 — sole play-mode UI egress (structured mount snapshot, not CRDT wire). */
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
  const epoch = tickEpoch
  if (diagCount < 8) {
    diagCount++
    cfg.log(
      `[sceneWorker] engine tick #${diagCount} dt=${engineDt.toFixed(3)} hydration=${cfg.isHydration()}`
    )
  }
  await runSerializedEngineUpdate(async () => {
    await eng.update(engineDt)
  })
  if (epoch !== tickEpoch) {
    cfg.log('[sceneWorker] cooperative tick — preempted during engine.update')
    return
  }
  lastExecutedAt = performance.now()
  cfg.onAfterEngineTick?.()
  if (cfg.isHydration()) {
    await emitSceneUiCrdtIfDirty(eng)
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
    queueMicrotask(() => requestSceneEngineTick())
  }
}

export function preemptSceneEngineTick(): void {
  if (!tickInFlight) return
  tickEpoch++
  tickInFlight = false
  tickStartedAt = 0
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
  const epoch = tickEpoch
  tickInFlight = true
  tickStartedAt = performance.now()
  const dt = resolveDt()
  void executeTickWork(dt).finally(() => {
    if (epoch !== tickEpoch) return
    tickInFlight = false
    tickStartedAt = 0
    if (tickQueued && config && !config.pointerBlocksTick()) {
      tickQueued = false
      requestSceneEngineTick()
    }
  })
}

export function drainQueuedSceneEngineTick(): void {
  if (!tickQueued || tickInFlight || !config) return
  if (config.pointerBlocksTick()) return
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

export function sceneEngineTickAfterInboundInject(counts: RendererInboundInjectCounts): void {
  const needsSystems =
    counts.raycastPuts > 0 ||
    counts.videoPlayerPuts > 0 ||
    counts.triggerAppends > 0 ||
    counts.pointerAppends > 0 ||
    counts.videoAppends > 0 ||
    counts.tweenPuts > 0
  if (needsSystems) requestSceneEngineTick()
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
  setPointerInteractiveTickActive(true)
  try {
    await runSerializedEngineUpdate(async () => {
      if (splitPointerInject) {
        injectPointerClickDownOnEngine(eng, splitPointerInject)
      }
      await eng.update(0)
    })
    lastExecutedAt = performance.now()
    cfg.onAfterEngineTick?.()
    await runOnUpdate()
    await runSerializedEngineUpdate(async () => {
      if (splitPointerInject) {
        injectPointerClickUpOnEngine(eng, splitPointerInject)
      }
      await eng.update(0)
    })
    lastExecutedAt = performance.now()
    cfg.onAfterEngineTick?.()
    // react-ecs may run after getClick in the same update — one flush before mount snapshot.
    await runSerializedEngineUpdate(async () => {
      await eng.update(0)
    })
    lastExecutedAt = performance.now()
    runPointerUiPhase4Egress(eng)
  } finally {
    setPointerInteractiveTickActive(false)
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