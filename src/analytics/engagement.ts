/**
 * First-party "active pulse" engagement: visibility + recent input.
 * Dwell / heartbeats should use engaged time, not wall-clock AFK.
 */

const IDLE_MS = 90_000
const MAX_ENGAGED_MS = 6 * 60 * 60 * 1000
const ACTIVITY_THROTTLE_MS = 1000

let lastActivityAt = 0
let activityWired = false

export function noteAnalyticsActivity(): void {
  lastActivityAt = Date.now()
}

/** Wire global input listeners once (throttled). Safe to call repeatedly. */
export function wireAnalyticsActivity(): void {
  if (activityWired || typeof window === 'undefined') return
  activityWired = true

  let lastBump = 0
  const throttled = (): void => {
    const n = Date.now()
    if (n - lastBump < ACTIVITY_THROTTLE_MS) return
    lastBump = n
    lastActivityAt = n
  }

  const opts: AddEventListenerOptions = { passive: true, capture: true }
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const) {
    window.addEventListener(ev, throttled, opts)
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') noteAnalyticsActivity()
  })
  noteAnalyticsActivity()
}

export function isUserEngaged(): boolean {
  if (typeof document === 'undefined') return false
  if (document.visibilityState === 'hidden') return false
  if (lastActivityAt <= 0) return false
  return Date.now() - lastActivityAt < IDLE_MS
}

export type EngagedClock = {
  reset: () => void
  /** Advance clock; return total engaged ms so far (capped). */
  tick: () => number
  /** Current engaged ms without advancing wall segment mid-idle incorrectly. */
  peek: () => number
}

/** Accumulates ms only while tab visible and user recently active. */
export function createEngagedClock(maxMs = MAX_ENGAGED_MS): EngagedClock {
  let engagedMs = 0
  let lastTick = Date.now()

  const advance = (): number => {
    const now = Date.now()
    const dt = Math.max(0, now - lastTick)
    lastTick = now
    if (isUserEngaged()) {
      engagedMs = Math.min(maxMs, engagedMs + dt)
    }
    return engagedMs
  }

  return {
    reset() {
      engagedMs = 0
      lastTick = Date.now()
      noteAnalyticsActivity()
    },
    tick: advance,
    peek() {
      // Speculative add without committing if engaged (for display-style reads)
      if (!isUserEngaged()) return engagedMs
      const now = Date.now()
      const dt = Math.max(0, now - lastTick)
      return Math.min(maxMs, engagedMs + dt)
    }
  }
}
