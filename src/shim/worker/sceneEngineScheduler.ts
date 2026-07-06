import type { IEngine } from '@dcl/ecs'
import {
  commitSceneUiCrdtBaseline,
  planSceneUiCrdtEmit,
  seedWorkerUiFingerprint
} from './sceneEngineUiScheduler'

/**
 * Single worker entry for sceneEngine.update — boot, hydration, play, inbound, pointer.
 *
 * Cooperative tick phases:
 *   1. engine.update(dt) — closure/timers + deferred react-ecs
 *   2. emitSceneUiCrdtIfDirty — touch dirty Ui* + transport emit + baseline commit
 *
 * Pointer interactive tick (separate pipeline — see runSceneEnginePointerTick):
 *   1. engine.update(0) — getClick + react-ecs
 *   2. scene.exports.onUpdate(0)
 *   3. engine.update(0) — react-ecs after onUpdate
 *   4. emitSceneUiCrdtIfDirty — one Ui CRDT emit
 */

export type SceneEngineSchedulerConfig = {
  log: (message: string) => void
  hydrationIntervalMs: number
  tickAbortMs: number
  isHydration: () => boolean
  resolvePlayIntervalMs: () => number
  pointerBlocksTick: () => boolean
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
/** True only during intentional Ui CRDT transport emit — rpcCrdt must not attach uiEntities otherwise. */
let attachUiMountSnapshot = false

export function shouldAttachUiMountSnapshot(): boolean {
  return attachUiMountSnapshot
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
  if (!planSceneUiCrdtEmit(eng, cfg.log)) return
  attachUiMountSnapshot = true
  try {
    await eng.update(0)
    commitSceneUiCrdtBaseline(eng)
  } finally {
    attachUiMountSnapshot = false
  }
}

/** Cooperative play / hydration tick. */
async function runCooperativeEngineTickPhases(engineDt: number): Promise<void> {
  const cfg = config!
  const eng = engine!
  if (diagCount < 8) {
    diagCount++
    cfg.log(
      `[sceneWorker] engine tick #${diagCount} dt=${engineDt.toFixed(3)} hydration=${cfg.isHydration()}`
    )
  }
  await eng.update(engineDt)
  lastExecutedAt = performance.now()
  cfg.onAfterEngineTick?.()
  await emitSceneUiCrdtIfDirty(eng)
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
 * Pointer interactive tick — inject is already on the engine before this runs.
 * Separate from cooperative ticks; one Ui CRDT emit at the end.
 */
export async function runSceneEnginePointerTick(
  eng: IEngine,
  runOnUpdate: () => Promise<void>
): Promise<void> {
  const cfg = config!
  await eng.update(0)
  lastExecutedAt = performance.now()
  cfg.onAfterEngineTick?.()
  await runOnUpdate()
  await eng.update(0)
  lastExecutedAt = performance.now()
  cfg.onAfterEngineTick?.()
  await emitSceneUiCrdtIfDirty(eng)
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