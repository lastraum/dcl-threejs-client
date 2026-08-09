/**
 * Force Worker System Pie even when the bundle getSystems() loop patch fails.
 *
 * Wraps engine.addSystem so every system.fn is gated by a hard wall budget for the
 * current eng.update. When the needle patch *does* apply, installEngineSystemLoopPartition
 * still runs the structured pie; this gate only bites if the stock for-loop remains.
 *
 * Also times eng.update and logs when the systems loop hook never fired (patch miss).
 */
import type { IEngine } from '@dcl/ecs'
import { isHotPieSystem, type PieSystemItem } from './workerSystemPie'
import {
  isLevelStatePointerEdgeActive,
  isPointerInteractiveTickActive
} from './sceneWorkerInputSession'

const ENGINE_SYSTEM_LOOP_KEY = '__THREEJS_ENGINE_SYSTEM_LOOP__'

type GateState = {
  active: boolean
  t0: number
  budgetMs: number
  overBudget: boolean
  ran: number
  skipped: number
  pieHookCalled: boolean
}

const gate: GateState = {
  active: false,
  t0: 0,
  budgetMs: 14,
  overBudget: false,
  ran: 0,
  skipped: 0,
  pieHookCalled: false
}

/** Set by installEngineSystemLoopPartition when the structured pie runs. */
export function noteSystemLoopHookInvoked(): void {
  gate.pieHookCalled = true
}

export function beginForcedPieGate(budgetMs: number): void {
  gate.active = true
  gate.t0 = performance.now()
  gate.budgetMs = budgetMs
  gate.overBudget = false
  gate.ran = 0
  gate.skipped = 0
  gate.pieHookCalled = false
}

export function endForcedPieGate(): { ms: number; ran: number; skipped: number; pieHook: boolean } {
  const ms = performance.now() - gate.t0
  const out = {
    ms,
    ran: gate.ran,
    skipped: gate.skipped,
    pieHook: gate.pieHookCalled
  }
  gate.active = false
  return out
}

/**
 * Gate a single system invocation (stock for-loop path only).
 * When structured pie already ran this update, pass through.
 */
export function forcedPieGateRun(item: PieSystemItem, run: () => void): void {
  if (!gate.active) {
    run()
    return
  }
  if (gate.pieHookCalled) {
    run()
    return
  }
  const elapsed = performance.now() - gate.t0
  const hot =
    isHotPieSystem(item) ||
    isPointerInteractiveTickActive() ||
    isLevelStatePointerEdgeActive()
  if ((gate.overBudget || elapsed >= gate.budgetMs) && !hot) {
    gate.overBudget = true
    gate.skipped++
    return
  }
  // Absolute ceiling even for HOT after severe overrun of prior systems.
  if (elapsed >= gate.budgetMs * 5) {
    gate.skipped++
    return
  }
  const a = performance.now()
  run()
  const ms = performance.now() - a
  gate.ran++
  if (ms >= gate.budgetMs || performance.now() - gate.t0 >= gate.budgetMs) {
    gate.overBudget = true
  }
}

type EngWithPie = IEngine & { __threejsForcePieGate?: boolean }

/**
 * Wrap addSystem + update on this engine (idempotent).
 * Call from preregisterRendererInjectedComponents before scene systems register.
 */
export function installForcedSystemPieGateOnEngine(
  engine: IEngine,
  resolveBudgetMs: () => number
): void {
  const eng = engine as EngWithPie
  if (eng.__threejsForcePieGate) return
  eng.__threejsForcePieGate = true

  const nativeAdd = engine.addSystem.bind(engine)
  engine.addSystem = ((fn: (dt: number) => void, priority?: number, name?: string) => {
    const pri = priority ?? 100_000
    const sysName = name || (fn as { name?: string }).name || ''
    const item: PieSystemItem = { fn, priority: pri, name: sysName }
    const wrapped = (dt: number) => {
      forcedPieGateRun(item, () => fn(dt))
    }
    try {
      Object.defineProperty(wrapped, 'name', { value: sysName || 'anonymous', configurable: true })
    } catch {
      /* ignore */
    }
    return nativeAdd(wrapped, priority, name)
  }) as typeof engine.addSystem

  const nativeUpdate = engine.update.bind(engine)
  engine.update = async (dt: number) => {
    beginForcedPieGate(resolveBudgetMs())
    const t0 = performance.now()
    try {
      await nativeUpdate(dt)
    } finally {
      const stats = endForcedPieGate()
      const total = performance.now() - t0
      if (total >= 80) {
        console.warn(
          `[wsp] eng.update ${total.toFixed(0)}ms gate=${stats.ms.toFixed(0)}ms ran=${stats.ran} skip=${stats.skipped} ` +
            `pieHook=${stats.pieHook ? 1 : 0} budget=${resolveBudgetMs()}`
        )
      }
      if (!stats.pieHook && total >= 100) {
        console.warn(
          `[wsp] systems loop patch MISS — forced per-fn gate skip=${stats.skipped}`
        )
      }
      // Silence unused key warning in some builds
      void ENGINE_SYSTEM_LOOP_KEY
    }
  }
}
