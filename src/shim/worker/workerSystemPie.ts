/**
 * Worker System Pie (WSP) — COD frame law inside engine.update.
 *
 * Explorer does not run an unbounded all-systems barrier: scene logic can drop under
 * load (~30 Hz contract) while HOT input/motion keeps feeling live. ThreejsClient
 * already pies the main renderer; this module pies the worker system loop.
 *
 * Law:
 *   HOT  — always finishes every eng.update
 *   COLD — proven-expensive ambient systems under wall budget + resume cursor
 *   UI   — @dcl/react-ecs* deferred to end (sceneEngineUiScheduler)
 *
 * Classification (scene-agnostic):
 *   - Pointer / level-state edges → all non-UI HOT
 *   - @dcl/* core, anonymous, SDK event names → HOT
 *   - Named scene systems → HOT by default; COLD only if EMA cost exceeds threshold
 *     (Explorer drops expensive ambient under load without inventing scene names)
 *
 * @see docs/WORKER_SYSTEM_PIE.md
 */

import {
  isLevelStatePointerEdgeActive,
  isPointerInteractiveTickActive
} from './sceneWorkerInputSession'

export type PieSystemItem = { fn: (dt: number) => void; name?: string; priority: number }

export type WorkerSystemPieSnapshot = {
  hotMs: number
  coldMs: number
  hotCount: number
  coldRun: number
  coldSkip: number
  resumeIndex: number
  budgetMs: number
  fullPass: boolean
}

/** Cooperative eng.update wall budget for COLD systems after HOT completes (ms). */
export const WSP_COOPERATIVE_BUDGET_MS_HIGH = 12
export const WSP_COOPERATIVE_BUDGET_MS_MEDIUM = 16
export const WSP_COOPERATIVE_BUDGET_MS_LOW = 20
/** Pointer / dt=0 edges: all non-UI HOT (isHotPieSystem); residual budget if any cold slips. */
export const WSP_POINTER_BUDGET_MS = 8
/** Force progress on COLD at least this often (never unbounded full list). */
export const WSP_COLD_MAX_SKIP_TICKS = 8
/** EMA ms above which a named scene system is treated as COLD ambient. */
export const WSP_COLD_EMA_MS = 1.5

/**
 * SDK systems registered without `@dcl/` name prefix (fn.name from engine.addSystem).
 * Must stay HOT — TriggerAreaResult only drains pad ENTER via this system.
 */
const HOT_SDK_SYSTEM_NAMES = new Set([
  'TriggerAreaResultSystem',
  'EventSystem',
  'observableSystem',
  'sleepSystem',
  'executeTasks',
  'buttonStateUpdateSystem',
  'TestingFrameworkCoroutineRunner'
])

let coldResumeIndex = 0
let coldSkipStreak = 0
let pieBudgetMs = WSP_COOPERATIVE_BUDGET_MS_HIGH
let lastSnapshot: WorkerSystemPieSnapshot = {
  hotMs: 0,
  coldMs: 0,
  hotCount: 0,
  coldRun: 0,
  coldSkip: 0,
  resumeIndex: 0,
  budgetMs: pieBudgetMs,
  fullPass: true
}
let lastPerfLogAt = 0
const systemMsRing = new Map<string, number>()

export function setWorkerSystemPieBudgetMs(ms: number): void {
  if (!Number.isFinite(ms) || ms < 4) return
  pieBudgetMs = Math.min(48, Math.max(4, ms))
}

export function setWorkerSystemPieTier(tier: 'high' | 'medium' | 'low' | undefined): void {
  if (tier === 'low') pieBudgetMs = WSP_COOPERATIVE_BUDGET_MS_LOW
  else if (tier === 'medium') pieBudgetMs = WSP_COOPERATIVE_BUDGET_MS_MEDIUM
  else pieBudgetMs = WSP_COOPERATIVE_BUDGET_MS_HIGH
}

export function setWorkerSystemPiePerfLog(_enabled: boolean): void {
  /* reserved — use globalThis.__THREEJS_SCENEWORKER_PERF__ */
}

export function getWorkerSystemPieSnapshot(): WorkerSystemPieSnapshot {
  return { ...lastSnapshot }
}

export function getWorkerSystemPieTopSystems(limit = 8): { name: string; ms: number }[] {
  return [...systemMsRing.entries()]
    .map(([name, ms]) => ({ name, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, Math.max(1, limit))
}

export function resetWorkerSystemPie(): void {
  coldResumeIndex = 0
  coldSkipStreak = 0
  systemMsRing.clear()
  lastSnapshot = {
    hotMs: 0,
    coldMs: 0,
    hotCount: 0,
    coldRun: 0,
    coldSkip: 0,
    resumeIndex: 0,
    budgetMs: pieBudgetMs,
    fullPass: true
  }
}

/**
 * HOT = must finish this eng.update before COLD budget applies.
 * Multiplayer-safe: default HOT; COLD only for proven expensive named scene systems.
 */
export function isHotPieSystem(system: PieSystemItem): boolean {
  const name = system.name ?? ''
  if (name.startsWith('@dcl/react-ecs')) return false
  if (isPointerInteractiveTickActive() || isLevelStatePointerEdgeActive()) return true
  if (!name) return true
  if (name.startsWith('@dcl/')) return true
  if (HOT_SDK_SYSTEM_NAMES.has(name)) return true
  // Named scene systems: HOT until EMA proves expensive ambient.
  const ema = systemMsRing.get(name) ?? 0
  if (ema >= WSP_COLD_EMA_MS) return false
  return true
}

function isDeferredUiSystem(system: PieSystemItem): boolean {
  const name = system.name ?? ''
  return name === '@dcl/react-ecs' || name === '@dcl/react-ecs-ui-scale'
}

function recordSystemMs(name: string, ms: number): void {
  if (ms < 0.05) return
  const prev = systemMsRing.get(name) ?? 0
  systemMsRing.set(name, prev * 0.7 + ms * 0.3)
  if (systemMsRing.size > 64) {
    let worst = ''
    let worstMs = Infinity
    for (const [n, v] of systemMsRing) {
      if (v < worstMs) {
        worstMs = v
        worst = n
      }
    }
    if (worst) systemMsRing.delete(worst)
  }
}

type RunOne = (s: PieSystemItem, dt: number) => void

/**
 * Partition + budget run for non-UI systems. Caller still runs deferred react-ecs after.
 */
export function runWorkerSystemPie(
  systems: PieSystemItem[],
  dt: number,
  runOne: RunOne,
  opts?: {
    pointerEdge?: boolean
    safeRun?: (s: PieSystemItem, dt: number, run: RunOne) => void
  }
): void {
  const safe =
    opts?.safeRun ??
    ((s, d, run) => {
      run(s, d)
    })
  const budget = opts?.pointerEdge ? WSP_POINTER_BUDGET_MS : pieBudgetMs
  const forceProgress = coldSkipStreak >= WSP_COLD_MAX_SKIP_TICKS

  const hot: PieSystemItem[] = []
  const cold: PieSystemItem[] = []
  for (const s of systems) {
    if (isDeferredUiSystem(s)) continue
    if (isHotPieSystem(s)) hot.push(s)
    else cold.push(s)
  }

  const t0 = performance.now()
  for (const s of hot) {
    const a = performance.now()
    safe(s, dt, runOne)
    recordSystemMs(s.name || 'anonymous-hot', performance.now() - a)
  }
  const hotMs = performance.now() - t0

  let coldRun = 0
  let coldSkip = 0
  let fullPass = true
  // COLD budget starts AFTER HOT (not including HOT wall — Explorer ambient under residual pie).
  const tCold0 = performance.now()
  // Force-progress: slightly higher budget, never unbounded all-systems barrier.
  const coldBudget = forceProgress ? Math.min(budget * 2, 32) : budget

  if (cold.length === 0) {
    coldResumeIndex = 0
    coldSkipStreak = 0
  } else {
    const n = cold.length
    let idx = ((coldResumeIndex % n) + n) % n
    let visited = 0
    while (visited < n) {
      if (performance.now() - tCold0 >= coldBudget) {
        fullPass = false
        break
      }
      const s = cold[idx]!
      const a = performance.now()
      safe(s, dt, runOne)
      recordSystemMs(s.name || 'anonymous-cold', performance.now() - a)
      coldRun++
      visited++
      idx = (idx + 1) % n
    }
    coldResumeIndex = idx
    if (fullPass) {
      coldSkipStreak = 0
      coldResumeIndex = 0
    } else {
      coldSkipStreak++
      coldSkip = n - coldRun
    }
  }

  const coldMs = performance.now() - tCold0
  lastSnapshot = {
    hotMs,
    coldMs,
    hotCount: hot.length,
    coldRun,
    coldSkip,
    resumeIndex: coldResumeIndex,
    budgetMs: coldBudget,
    fullPass
  }

  if ((globalThis as { __THREEJS_SCENEWORKER_PERF__?: boolean }).__THREEJS_SCENEWORKER_PERF__) {
    const now = performance.now()
    if (now - lastPerfLogAt > 2000) {
      lastPerfLogAt = now
      const top = getWorkerSystemPieTopSystems(5)
        .map((x) => `${x.name}:${x.ms.toFixed(1)}`)
        .join(' ')
      console.info(
        `[wsp] hot=${hotMs.toFixed(1)}ms×${hot.length} cold=${coldMs.toFixed(1)}ms run=${coldRun} skip=${coldSkip} ` +
          `budget=${coldBudget} full=${fullPass ? 1 : 0} top=${top || '—'}`
      )
    }
  }
}
