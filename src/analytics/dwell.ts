import {
  createEngagedClock,
  isUserEngaged,
  type EngagedClock,
  wireAnalyticsActivity
} from './engagement'
import { newPlaySessionId } from './ids'
import { placeFieldsFromRoute } from './placeKey'
import {
  endPlaySession,
  flushAnalyticsSync,
  getPlaySessionId,
  tickPlayEngaged,
  track
} from './track'
import type { RouteTarget } from '../dcl/content/route'

/** Active pulse interval while engaged. */
const PULSE_MS = 45_000
/** Hard cap on engaged accumulation. */
const MAX_DWELL_MS = 6 * 60 * 60 * 1000
/** Soft product cap on reported dwell (medians / UI). */
const SOFT_DWELL_CAP_MS = 45 * 60 * 1000
/** Max active pulses per surface session. */
const MAX_PULSES = 40
/** Bounce floor — still emit leave with 0 if under this. */
const MIN_REPORT_DWELL_MS = 2_000

let playPulseTimer: ReturnType<typeof setInterval> | 0 = 0
let playSeq = 0
let playRoute: RouteTarget | null = null

let landingPulseTimer: ReturnType<typeof setInterval> | 0 = 0
let landingSeq = 0
let landingRoute: RouteTarget | null = null
let landingSessionId: string | null = null
let landingClock: EngagedClock | null = null

let wiredUnload = false

function clampHard(ms: number): number {
  return Math.min(Math.max(0, ms), MAX_DWELL_MS)
}

function reportDwell(ms: number): number {
  const hard = clampHard(ms)
  if (hard < MIN_REPORT_DWELL_MS) return 0
  return Math.min(hard, SOFT_DWELL_CAP_MS)
}

function onPageHide(): void {
  stopLandingDwell('unload')
  stopDwellTracking('unload')
  flushAnalyticsSync()
}

function ensureUnloadHook(): void {
  if (wiredUnload || typeof window === 'undefined') return
  wiredUnload = true
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('beforeunload', onPageHide)
}

function stopPlayPulseOnly(): void {
  if (playPulseTimer) {
    clearInterval(playPulseTimer)
    playPulseTimer = 0
  }
}

function stopLandingPulseOnly(): void {
  if (landingPulseTimer) {
    clearInterval(landingPulseTimer)
    landingPulseTimer = 0
  }
}

/** Start active pulses for in-play session (after scene_enter). */
export function startDwellTracking(route: RouteTarget | null): void {
  stopPlayPulseOnly()
  stopLandingDwell('jump_in')
  playRoute = route
  playSeq = 0
  wireAnalyticsActivity()
  ensureUnloadHook()
  tickPlayEngaged()

  if (typeof window === 'undefined') return
  playPulseTimer = setInterval(() => {
    if (!getPlaySessionId()) return
    const engaged = tickPlayEngaged()
    if (!isUserEngaged()) return
    if (playSeq >= MAX_PULSES) return
    playSeq += 1
    track('active_pulse', {
      route: playRoute,
      props: {
        surface: 'play',
        seq: playSeq,
        dwell_ms: engaged,
        engaged: true
      }
    })
  }, PULSE_MS)
}

/** Emit scene_leave with engaged dwell. */
export function stopDwellTracking(
  reason: 'navigate' | 'landing' | 'shell' | 'unload' | 'error' = 'navigate'
): void {
  stopPlayPulseOnly()
  const engaged = tickPlayEngaged()
  const { play_session_id } = endPlaySession()
  if (!play_session_id) {
    playRoute = null
    return
  }
  track('scene_leave', {
    route: playRoute,
    play_session_id,
    props: {
      surface: 'play',
      dwell_ms: reportDwell(engaged),
      engaged_ms: clampHard(engaged),
      reason
    }
  })
  playRoute = null
  flushAnalyticsSync()
}

/** Start engaged dwell + active pulses on 2D scene landing. */
export function startLandingDwell(route: RouteTarget | null): void {
  stopLandingDwell('navigate')
  if (!route || (route.kind !== 'coords' && route.kind !== 'world')) return

  wireAnalyticsActivity()
  ensureUnloadHook()
  landingRoute = route
  landingSessionId = newPlaySessionId()
  landingClock = createEngagedClock(MAX_DWELL_MS)
  landingClock.reset()
  landingSeq = 0

  if (typeof window === 'undefined') return
  landingPulseTimer = setInterval(() => {
    if (!landingSessionId || !landingClock) return
    const engaged = landingClock.tick()
    if (!isUserEngaged()) return
    if (landingSeq >= MAX_PULSES) return
    landingSeq += 1
    track('active_pulse', {
      route: landingRoute,
      props: {
        surface: 'landing',
        landing_session_id: landingSessionId,
        seq: landingSeq,
        dwell_ms: engaged,
        engaged: true
      }
    })
  }, PULSE_MS)
}

export function stopLandingDwell(
  reason: 'jump_in' | 'navigate' | 'shell' | 'unload' = 'navigate'
): void {
  stopLandingPulseOnly()
  const sessionId = landingSessionId
  const route = landingRoute
  const engaged = landingClock ? landingClock.tick() : 0
  landingSessionId = null
  landingClock = null
  landingRoute = null
  if (!sessionId) return

  track('landing_leave', {
    route,
    props: {
      surface: 'landing',
      landing_session_id: sessionId,
      dwell_ms: reportDwell(engaged),
      engaged_ms: clampHard(engaged),
      reason
    }
  })
  flushAnalyticsSync()
}

export function currentPlayPlaceFields() {
  return placeFieldsFromRoute(playRoute)
}
