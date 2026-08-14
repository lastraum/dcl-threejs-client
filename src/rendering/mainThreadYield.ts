import { getLastFrameMs } from '../util/perfCounters'

/**
 * Yield to the browser so one rAF paint/input turn can run before more main-thread work.
 * Used to time-slice remote avatar compose/attach so peer loads don't hitch the frame loop.
 */
export function yieldToNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
      return
    }
    setTimeout(resolve, 0)
  })
}

/**
 * Yield until the browser is idle (or `timeoutMs`). Prefer this over starting
 * GLB parse / avatar compose / composite attach from the play rAF.
 */
export function yieldToIdle(timeoutMs = 32): Promise<void> {
  return new Promise((resolve) => {
    const w = typeof window !== 'undefined' ? window : null
    const ric = w && typeof w.requestIdleCallback === 'function' ? w.requestIdleCallback.bind(w) : null
    if (ric) {
      ric(() => resolve(), { timeout: timeoutMs })
      return
    }
    setTimeout(resolve, 0)
  })
}

/**
 * Schedule work off the play rAF. Uses idle callback when available, else a macrotask.
 * Never runs `fn` synchronously.
 */
export function scheduleOffPlayRaf(fn: () => void, timeoutMs = 32): void {
  const w = typeof window !== 'undefined' ? window : null
  const ric = w && typeof w.requestIdleCallback === 'function' ? w.requestIdleCallback.bind(w) : null
  if (ric) {
    ric(() => fn(), { timeout: timeoutMs })
    return
  }
  setTimeout(fn, 0)
}

/** True when the last completed frame already blew a 30 FPS budget. */
export function lastFrameOverBudget(budgetMs = 33): boolean {
  const ms = getLastFrameMs()
  return ms > 0 && ms > budgetMs
}
