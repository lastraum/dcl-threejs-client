/**
 * Worker System Pie (WSP) — COD frame law inside engine.update.
 *
 * Hard wall budget for the **entire** systems pass (HOT first, then COLD residual).
 * One sync system can still take long on first run — quarantine skips it for a few
 * ticks afterward so a multi-second system cannot pin every frame (Explorer drops
 * scene rate under load).
 *
 * @see docs/WORKER_SYSTEM_PIE.md
 */

import {
  isLevelStatePointerEdgeActive,
  isPointerInteractiveTickActive
} from './sceneWorkerInputSession'

export type PieSystemItem = { fn: (dt: number) => void; name?: string; priority: number }

export type WorkerSystemPieSnapshot = {
  totalMs: number
  hotMs: number
  coldMs: number
  hotRun: number
  coldRun: number
  skipped: number
  quarantined: number
  budgetMs: number
  fullPass: boolean
  systemCount: number
}

/** Hard wall for cooperative eng.update systems (ms). */
export const WSP_HARD_BUDGET_MS_HIGH = 14
export const WSP_HARD_BUDGET_MS_MEDIUM = 18
export const WSP_HARD_BUDGET_MS_LOW = 24
/** Pointer edges: slightly higher so DOWN/UP still drain events. */
export const WSP_POINTER_HARD_BUDGET_MS = 20
/** Single system over this → quarantine for N ticks (cannot preempt mid-fn). */
export const WSP_QUARANTINE_MS = 40
export const WSP_QUARANTINE_TICKS = 4
/** Always log when a pie pass exceeds this. */
export const WSP_SLOW_LOG_MS = 80

const HOT_SDK_SYSTEM_NAMES = new Set([
  'TriggerAreaResultSystem',
  'EventSystem',
  'observableSystem',
  'sleepSystem',
  'executeTasks',
  'buttonStateUpdateSystem',
  'TestingFrameworkCoroutineRunner'
])

let hardBudgetMs = WSP_HARD_BUDGET_MS_HIGH
let hotResumeIndex = 0
let coldResumeIndex = 0
/** system key → ticks remaining to skip */
const quarantineTicks = new Map<string, number>()
const systemMsRing = new Map<string, number>()
let lastSnapshot: WorkerSystemPieSnapshot = {
  totalMs: 0,
  hotMs: 0,
  coldMs: 0,
  hotRun: 0,
  coldRun: 0,
  skipped: 0,
  quarantined: 0,
  budgetMs: hardBudgetMs,
  fullPass: true,
  systemCount: 0
}
let lastSlowLogAt = 0
let piePassCount = 0

export function setWorkerSystemPieBudgetMs(ms: number): void {
  if (!Number.isFinite(ms) || ms < 4) return
  hardBudgetMs = Math.min(48, Math.max(4, ms))
}

export function setWorkerSystemPieTier(tier: 'high' | 'medium' | 'low' | undefined): void {
  if (tier === 'low') hardBudgetMs = WSP_HARD_BUDGET_MS_LOW
  else if (tier === 'medium') hardBudgetMs = WSP_HARD_BUDGET_MS_MEDIUM
  else hardBudgetMs = WSP_HARD_BUDGET_MS_HIGH
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
  hotResumeIndex = 0
  coldResumeIndex = 0
  quarantineTicks.clear()
  systemMsRing.clear()
  piePassCount = 0
  lastSnapshot = {
    totalMs: 0,
    hotMs: 0,
    coldMs: 0,
    hotRun: 0,
    coldRun: 0,
    skipped: 0,
    quarantined: 0,
    budgetMs: hardBudgetMs,
    fullPass: true,
    systemCount: 0
  }
}

function systemKey(s: PieSystemItem): string {
  return s.name || `anon:${s.priority}`
}

/**
 * HOT = preferred this tick (SDK core, event drains, pointer edges).
 * Everything else is residual COLD — still runs under the same hard wall.
 */
export function isHotPieSystem(system: PieSystemItem): boolean {
  const name = system.name ?? ''
  if (name.startsWith('@dcl/react-ecs')) return false
  if (isPointerInteractiveTickActive() || isLevelStatePointerEdgeActive()) return true
  if (!name) return true
  if (name.startsWith('@dcl/')) return true
  if (HOT_SDK_SYSTEM_NAMES.has(name)) return true
  return false
}

function isDeferredUiSystem(system: PieSystemItem): boolean {
  const name = system.name ?? ''
  return name === '@dcl/react-ecs' || name === '@dcl/react-ecs-ui-scale'
}

function recordSystemMs(name: string, ms: number): void {
  if (ms < 0.05) return
  const prev = systemMsRing.get(name) ?? 0
  systemMsRing.set(name, prev * 0.65 + ms * 0.35)
  if (systemMsRing.size > 80) {
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

function isQuarantined(key: string): boolean {
  const left = quarantineTicks.get(key) ?? 0
  return left > 0
}

function tickQuarantine(): void {
  for (const [k, left] of [...quarantineTicks.entries()]) {
    if (left <= 1) quarantineTicks.delete(k)
    else quarantineTicks.set(k, left - 1)
  }
}

function quarantine(key: string, ms: number): void {
  if (ms < WSP_QUARANTINE_MS) return
  // Longer overrun → longer skip (cap 12 ticks ~200ms at 60Hz).
  const ticks = Math.min(12, WSP_QUARANTINE_TICKS + Math.floor(ms / 50))
  quarantineTicks.set(key, Math.max(quarantineTicks.get(key) ?? 0, ticks))
}

type RunOne = (s: PieSystemItem, dt: number) => void

/**
 * Hard-budget system pass. Cannot abort mid-system (JS), but will not start more
 * systems after wall budget and will quarantine multi-frame hogs.
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
  const hardBudget = opts?.pointerEdge ? WSP_POINTER_HARD_BUDGET_MS : hardBudgetMs
  tickQuarantine()
  piePassCount++

  const hot: PieSystemItem[] = []
  const cold: PieSystemItem[] = []
  for (const s of systems) {
    if (isDeferredUiSystem(s)) continue
    if (isHotPieSystem(s)) hot.push(s)
    else cold.push(s)
  }

  const t0 = performance.now()
  let hotRun = 0
  let coldRun = 0
  let skipped = 0
  let quarantined = 0
  let fullPass = true

  const runList = (
    list: PieSystemItem[],
    startIdx: number,
    onProgress: (nextIdx: number) => void
  ): { nextIdx: number; ran: number; stopped: boolean } => {
    if (list.length === 0) return { nextIdx: 0, ran: 0, stopped: false }
    const n = list.length
    let idx = ((startIdx % n) + n) % n
    let ran = 0
    let visited = 0
    while (visited < n) {
      if (performance.now() - t0 >= hardBudget) {
        return { nextIdx: idx, ran, stopped: true }
      }
      const s = list[idx]!
      const key = systemKey(s)
      if (isQuarantined(key)) {
        quarantined++
        skipped++
        visited++
        idx = (idx + 1) % n
        continue
      }
      const a = performance.now()
      safe(s, dt, runOne)
      const ms = performance.now() - a
      recordSystemMs(key, ms)
      quarantine(key, ms)
      ran++
      visited++
      idx = (idx + 1) % n
      // If this one system blew the whole budget, stop (cannot reclaim mid-fn).
      if (performance.now() - t0 >= hardBudget) {
        return { nextIdx: idx, ran, stopped: true }
      }
    }
    onProgress(0)
    return { nextIdx: 0, ran, stopped: false }
  }

  // HOT preferred first (from resume), then COLD residual.
  const hotResult = runList(hot, hotResumeIndex, () => {
    hotResumeIndex = 0
  })
  hotRun = hotResult.ran
  if (hotResult.stopped) {
    hotResumeIndex = hotResult.nextIdx
    fullPass = false
  } else {
    hotResumeIndex = 0
  }
  const hotMs = performance.now() - t0

  let coldMs = 0
  if (fullPass && performance.now() - t0 < hardBudget) {
    const tCold = performance.now()
    const coldResult = runList(cold, coldResumeIndex, () => {
      coldResumeIndex = 0
    })
    coldRun = coldResult.ran
    if (coldResult.stopped) {
      coldResumeIndex = coldResult.nextIdx
      fullPass = false
    } else {
      coldResumeIndex = 0
    }
    coldMs = performance.now() - tCold
  } else if (cold.length > 0 && !fullPass) {
    skipped += cold.length
  }

  const totalMs = performance.now() - t0
  lastSnapshot = {
    totalMs,
    hotMs,
    coldMs,
    hotRun,
    coldRun,
    skipped,
    quarantined,
    budgetMs: hardBudget,
    fullPass,
    systemCount: hot.length + cold.length
  }

  const perfOn = !!(globalThis as { __THREEJS_SCENEWORKER_PERF__?: boolean }).__THREEJS_SCENEWORKER_PERF__
  const now = performance.now()
  if (totalMs >= WSP_SLOW_LOG_MS && now - lastSlowLogAt > 1500) {
    lastSlowLogAt = now
    const top = getWorkerSystemPieTopSystems(6)
      .map((x) => `${x.name.slice(0, 28)}:${x.ms.toFixed(0)}`)
      .join(' ')
    console.warn(
      `[wsp] SLOW total=${totalMs.toFixed(0)}ms budget=${hardBudget} hot=${hotRun}/${hot.length} cold=${coldRun}/${cold.length} ` +
        `q=${quarantined} full=${fullPass ? 1 : 0} n=${hot.length + cold.length} top=${top || '—'}`
    )
  } else if (perfOn && piePassCount % 120 === 0) {
    const top = getWorkerSystemPieTopSystems(4)
      .map((x) => `${x.name.slice(0, 20)}:${x.ms.toFixed(0)}`)
      .join(' ')
    console.info(
      `[wsp] ok total=${totalMs.toFixed(1)}ms hot=${hotRun} cold=${coldRun} q=${quarantined} full=${fullPass ? 1 : 0} top=${top || '—'}`
    )
  }
}
