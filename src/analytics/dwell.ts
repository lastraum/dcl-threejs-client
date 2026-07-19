import { newPlaySessionId } from './ids'
import { placeFieldsFromRoute } from './placeKey'
import {
  endPlaySession,
  flushAnalyticsSync,
  getPlaySessionId,
  playSessionDwellMs,
  track
} from './track'
import type { RouteTarget } from '../dcl/content/route'

const HEARTBEAT_MS = 45_000
const MAX_DWELL_MS = 6 * 60 * 60 * 1000

let playHeartbeatTimer: ReturnType<typeof setInterval> | 0 = 0
let playSeq = 0
let playRoute: RouteTarget | null = null

let landingHeartbeatTimer: ReturnType<typeof setInterval> | 0 = 0
let landingSeq = 0
let landingRoute: RouteTarget | null = null
let landingSessionId: string | null = null
let landingStartedAt = 0

let wiredUnload = false

function clampDwell(ms: number): number {
  return Math.min(Math.max(0, ms), MAX_DWELL_MS)
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

function landingDwellMs(): number {
  if (!landingSessionId || landingStartedAt <= 0) return 0
  return clampDwell(Date.now() - landingStartedAt)
}

/** Start heartbeats for an in-play session (call after scene_enter). */
export function startDwellTracking(route: RouteTarget | null): void {
  stopPlayHeartbeatOnly()
  // Leaving the landing page for play — end landing dwell first.
  stopLandingDwell('jump_in')
  playRoute = route
  playSeq = 0
  ensureUnloadHook()
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    playHeartbeatTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      if (!getPlaySessionId()) return
      playSeq += 1
      track('heartbeat', {
        route: playRoute,
        props: {
          surface: 'play',
          seq: playSeq,
          visible: document.visibilityState === 'visible',
          dwell_ms: playSessionDwellMs()
        }
      })
    }, HEARTBEAT_MS)
  }
}

function stopPlayHeartbeatOnly(): void {
  if (playHeartbeatTimer) {
    clearInterval(playHeartbeatTimer)
    playHeartbeatTimer = 0
  }
}

/** Emit scene_leave + clear play session. Safe to call multiple times. */
export function stopDwellTracking(
  reason: 'navigate' | 'landing' | 'shell' | 'unload' | 'error' = 'navigate'
): void {
  stopPlayHeartbeatOnly()
  const { play_session_id, dwell_ms } = endPlaySession()
  if (!play_session_id) {
    playRoute = null
    return
  }
  track('scene_leave', {
    route: playRoute,
    play_session_id,
    props: {
      surface: 'play',
      dwell_ms: clampDwell(dwell_ms),
      reason
    }
  })
  playRoute = null
  flushAnalyticsSync()
}

/** Start dwell for the 2D scene landing page (call after landing_view). */
export function startLandingDwell(route: RouteTarget | null): void {
  stopLandingDwell('navigate')
  if (!route || (route.kind !== 'coords' && route.kind !== 'world')) return
  landingRoute = route
  landingSessionId = newPlaySessionId()
  landingStartedAt = Date.now()
  landingSeq = 0
  ensureUnloadHook()
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    landingHeartbeatTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      if (!landingSessionId) return
      landingSeq += 1
      track('landing_heartbeat', {
        route: landingRoute,
        props: {
          surface: 'landing',
          landing_session_id: landingSessionId,
          seq: landingSeq,
          visible: document.visibilityState === 'visible',
          dwell_ms: landingDwellMs()
        }
      })
    }, HEARTBEAT_MS)
  }
}

function stopLandingHeartbeatOnly(): void {
  if (landingHeartbeatTimer) {
    clearInterval(landingHeartbeatTimer)
    landingHeartbeatTimer = 0
  }
}

/**
 * End landing-page dwell. Safe to call multiple times.
 * reason: jump_in | navigate | shell | unload
 */
export function stopLandingDwell(
  reason: 'jump_in' | 'navigate' | 'shell' | 'unload' = 'navigate'
): void {
  stopLandingHeartbeatOnly()
  const sessionId = landingSessionId
  const route = landingRoute
  const dwell_ms = landingDwellMs()
  landingSessionId = null
  landingStartedAt = 0
  landingRoute = null
  if (!sessionId) return
  track('landing_leave', {
    route,
    props: {
      surface: 'landing',
      landing_session_id: sessionId,
      dwell_ms,
      reason
    }
  })
  flushAnalyticsSync()
}

export function currentPlayPlaceFields() {
  return placeFieldsFromRoute(playRoute)
}
