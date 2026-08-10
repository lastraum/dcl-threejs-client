/**
 * WSP v2 Phase 0 — engine.update phase meters (behavior-neutral).
 *
 * Measures wall time split for diagnosis only:
 *   pre  ≈ work before systems loop (CRDT/native setup when patch applies)
 *   systems = scene systems in the partition loop (excludes react-ecs*)
 *   react   = @dcl/react-ecs + ui-scale after systems
 *   post  ≈ work after systems loop returns (transport / send when after systems)
 *   total = full eng.update wall
 *
 * Does not skip, quarantine, or budget systems. Log when total ≥ SLOW_MS.
 *
 * @see docs/WORKER_SYSTEM_PIE_V2.md
 */

export type EngUpdatePhaseSnapshot = {
  totalMs: number
  preMs: number
  systemsMs: number
  reactMs: number
  postMs: number
  systemRun: number
  systemCount: number
  /** True when structured systems-loop hook ran this update. */
  systemsLoop: boolean
  dt: number
}

const SLOW_MS = 80
const SLOW_LOG_MIN_INTERVAL_MS = 1_500
const TOP_EMA_SIZE = 80
const TOP_LOG = 6

type PhaseGate = {
  active: boolean
  t0: number
  dt: number
  systemsLoopStart: number
  systemsLoopEnd: number
  systemsMs: number
  reactMs: number
  systemRun: number
  systemCount: number
  systemsLoop: boolean
}

const gate: PhaseGate = {
  active: false,
  t0: 0,
  dt: 0,
  systemsLoopStart: 0,
  systemsLoopEnd: 0,
  systemsMs: 0,
  reactMs: 0,
  systemRun: 0,
  systemCount: 0,
  systemsLoop: false
}

const systemMsEma = new Map<string, number>()
let lastSnapshot: EngUpdatePhaseSnapshot = {
  totalMs: 0,
  preMs: 0,
  systemsMs: 0,
  reactMs: 0,
  postMs: 0,
  systemRun: 0,
  systemCount: 0,
  systemsLoop: false,
  dt: 0
}
let lastSlowLogAt = 0
let passCount = 0

export function getEngUpdatePhaseSnapshot(): EngUpdatePhaseSnapshot {
  return { ...lastSnapshot }
}

export function getEngUpdateTopSystems(limit = TOP_LOG): { name: string; ms: number }[] {
  return [...systemMsEma.entries()]
    .map(([name, ms]) => ({ name, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, Math.max(1, limit))
}

export function resetEngUpdatePhases(): void {
  systemMsEma.clear()
  passCount = 0
  lastSlowLogAt = 0
  lastSnapshot = {
    totalMs: 0,
    preMs: 0,
    systemsMs: 0,
    reactMs: 0,
    postMs: 0,
    systemRun: 0,
    systemCount: 0,
    systemsLoop: false,
    dt: 0
  }
}

function recordSystemMs(name: string, ms: number): void {
  if (ms < 0.05) return
  const key = name || 'anonymous'
  const prev = systemMsEma.get(key) ?? 0
  systemMsEma.set(key, prev * 0.65 + ms * 0.35)
  if (systemMsEma.size > TOP_EMA_SIZE) {
    let worst = ''
    let worstMs = Infinity
    for (const [n, v] of systemMsEma) {
      if (v < worstMs) {
        worstMs = v
        worst = n
      }
    }
    if (worst) systemMsEma.delete(worst)
  }
}

/** Call at the start of every engine.update wrap. */
export function beginEngUpdatePhase(dt: number): void {
  gate.active = true
  gate.t0 = performance.now()
  gate.dt = dt
  gate.systemsLoopStart = 0
  gate.systemsLoopEnd = 0
  gate.systemsMs = 0
  gate.reactMs = 0
  gate.systemRun = 0
  gate.systemCount = 0
  gate.systemsLoop = false
}

/** Systems-loop partition entered (after native pre-loop work). */
export function noteSystemsLoopBegin(systemCount: number): void {
  if (!gate.active) return
  gate.systemsLoop = true
  gate.systemsLoopStart = performance.now()
  gate.systemCount = systemCount
}

/** Time one system.fn invocation (behavior unchanged — only measures). */
export function noteSystemRun(name: string | undefined, run: () => void): void {
  if (!gate.active) {
    run()
    return
  }
  const a = performance.now()
  run()
  const ms = performance.now() - a
  gate.systemRun++
  recordSystemMs(name || 'anonymous', ms)
}

/** Accumulate pure systems wall (caller may also use noteSystemRun for per-fn). */
export function addSystemsWallMs(ms: number): void {
  if (!gate.active || ms <= 0) return
  gate.systemsMs += ms
}

export function addReactWallMs(ms: number): void {
  if (!gate.active || ms <= 0) return
  gate.reactMs += ms
}

export function noteSystemsLoopEnd(): void {
  if (!gate.active) return
  gate.systemsLoopEnd = performance.now()
  if (gate.systemsLoopStart > 0 && gate.systemsMs <= 0) {
    // Fallback: whole loop wall if per-pass not set
    gate.systemsMs = Math.max(0, gate.systemsLoopEnd - gate.systemsLoopStart - gate.reactMs)
  }
}

/** Call in finally after nativeUpdate resolves. */
export function endEngUpdatePhase(): EngUpdatePhaseSnapshot {
  const now = performance.now()
  const totalMs = gate.active ? now - gate.t0 : 0
  const preMs =
    gate.systemsLoop && gate.systemsLoopStart > 0
      ? Math.max(0, gate.systemsLoopStart - gate.t0)
      : 0
  const systemsMs = gate.systemsMs
  const reactMs = gate.reactMs
  const postMs =
    gate.systemsLoop && gate.systemsLoopEnd > 0
      ? Math.max(0, now - gate.systemsLoopEnd)
      : Math.max(0, totalMs - systemsMs - reactMs - preMs)

  const snap: EngUpdatePhaseSnapshot = {
    totalMs,
    preMs,
    systemsMs,
    reactMs,
    postMs,
    systemRun: gate.systemRun,
    systemCount: gate.systemCount,
    systemsLoop: gate.systemsLoop,
    dt: gate.dt
  }
  lastSnapshot = snap
  gate.active = false
  passCount++

  if (totalMs >= SLOW_MS) {
    const t = performance.now()
    if (t - lastSlowLogAt >= SLOW_LOG_MIN_INTERVAL_MS) {
      lastSlowLogAt = t
      const top = getEngUpdateTopSystems(TOP_LOG)
        .map((x) => `${x.name.slice(0, 28)}:${x.ms.toFixed(0)}`)
        .join(' ')
      console.warn(
        `[wsp0] eng.update ${totalMs.toFixed(0)}ms ` +
          `pre=${preMs.toFixed(0)} systems=${systemsMs.toFixed(0)} react=${reactMs.toFixed(0)} post=${postMs.toFixed(0)} ` +
          `n=${snap.systemRun}/${snap.systemCount} loop=${snap.systemsLoop ? 1 : 0} dt=${snap.dt.toFixed(3)} ` +
          `top=${top || '—'}`
      )
    }
  } else if (
    !!(globalThis as { __THREEJS_SCENEWORKER_PERF__?: boolean }).__THREEJS_SCENEWORKER_PERF__ &&
    passCount % 120 === 0
  ) {
    const top = getEngUpdateTopSystems(4)
      .map((x) => `${x.name.slice(0, 20)}:${x.ms.toFixed(0)}`)
      .join(' ')
    console.info(
      `[wsp0] ok total=${totalMs.toFixed(1)}ms pre=${preMs.toFixed(1)} sys=${systemsMs.toFixed(1)} ` +
        `react=${reactMs.toFixed(1)} post=${postMs.toFixed(1)} top=${top || '—'}`
    )
  }

  return snap
}
