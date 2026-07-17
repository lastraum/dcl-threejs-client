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
