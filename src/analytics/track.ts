import type { LoginResult } from '../auth/AuthClient'
import { APP_VERSION } from '../client/appVersion'
import { getSessionId, getVisitorId, newEventId, newPlaySessionId } from './ids'
import { placeFieldsFromRoute, type PlaceFields } from './placeKey'
import type { RouteTarget } from '../dcl/content/route'

export type AnalyticsSource =
  | 'direct'
  | 'explore'
  | 'map'
  | 'events'
  | 'communities'
  | 'goto'
  | 'history'
  | 'external'
  | 'unknown'

export type TrackProps = {
  place?: PlaceFields | null
  route?: RouteTarget | null
  source?: AnalyticsSource | string | null
  from_place_key?: string | null
  to_place_key?: string | null
  play_session_id?: string | null
  /** Sparse extras merged into props jsonb (keep small). */
  props?: Record<string, unknown>
}

type LoginKind = 'guest' | 'wallet'

type OutboundEvent = {
  event_id: string
  event: string
  at: string
  visitor_id: string
  session_id: string
  play_session_id?: string
  login_kind: LoginKind
  wallet?: string
  client_version: string
  path: string
  source?: string
  ua_class?: string
  place_kind?: string
  place_key?: string
  world_name?: string
  x?: number
  y?: number
  from_place_key?: string
  to_place_key?: string
  props: Record<string, unknown>
}

const queue: OutboundEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | 0 = 0
let loginKind: LoginKind = 'guest'
let wallet: string | undefined
let playSessionId: string | null = null
let playSessionStartedAt = 0

/** True only when `VITE_ANALYTICS_ENABLED=true` was set at build time. */
export function isAnalyticsEnabled(): boolean {
  return import.meta.env.VITE_ANALYTICS_ENABLED === 'true'
}

function analyticsEnabled(): boolean {
  return isAnalyticsEnabled()
}

function uaClass(): 'desktop' | 'mobile' | 'unknown' {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent || ''
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return 'mobile'
  if (ua) return 'desktop'
  return 'unknown'
}

function currentPath(): string {
  if (typeof window === 'undefined') return '/'
  const p = `${window.location.pathname}${window.location.search}`
  return p.length > 512 ? p.slice(0, 512) : p
}

function ingestUrl(): string {
  const base = (import.meta.env.VITE_ANALYTICS_URL as string | undefined)?.trim()
  if (base) return base.replace(/\/$/, '')
  return '/api/analytics/events'
}

export function setAnalyticsLogin(login: LoginResult | null): void {
  if (!login) {
    loginKind = 'guest'
    wallet = undefined
    return
  }
  loginKind = login.kind === 'wallet' ? 'wallet' : 'guest'
  const addr = typeof login.address === 'string' ? login.address.trim().toLowerCase() : ''
  wallet = /^0x[a-f0-9]{40}$/.test(addr) ? addr : undefined
}

export function getPlaySessionId(): string | null {
  return playSessionId
}

export function beginPlaySession(): string {
  playSessionId = newPlaySessionId()
  playSessionStartedAt = Date.now()
  return playSessionId
}

export function endPlaySession(): { play_session_id: string | null; dwell_ms: number } {
  const id = playSessionId
  const dwell_ms = playSessionStartedAt > 0 ? Math.max(0, Date.now() - playSessionStartedAt) : 0
  playSessionId = null
  playSessionStartedAt = 0
  return { play_session_id: id, dwell_ms }
}

export function playSessionDwellMs(): number {
  if (!playSessionId || playSessionStartedAt <= 0) return 0
  return Math.max(0, Date.now() - playSessionStartedAt)
}

/**
 * Fire-and-forget place analytics event. No-ops unless VITE_ANALYTICS_ENABLED=true.
 * Never throws; never blocks play.
 */
export function track(event: string, extra: TrackProps = {}): void {
  if (!analyticsEnabled()) return
  if (typeof window === 'undefined') return
  if (!event || event.length > 64) return

  try {
    const place = extra.place ?? placeFieldsFromRoute(extra.route ?? null)
    const row: OutboundEvent = {
      event_id: newEventId(),
      event,
      at: new Date().toISOString(),
      visitor_id: getVisitorId(),
      session_id: getSessionId(),
      login_kind: loginKind,
      client_version: APP_VERSION,
      path: currentPath(),
      ua_class: uaClass(),
      props: extra.props && typeof extra.props === 'object' ? { ...extra.props } : {}
    }
    if (wallet) row.wallet = wallet
    const ps = extra.play_session_id === undefined ? playSessionId : extra.play_session_id
    if (ps) row.play_session_id = ps
    if (extra.source) row.source = String(extra.source).slice(0, 32)
    if (place) {
      row.place_kind = place.place_kind
      row.place_key = place.place_key
      if (place.world_name) row.world_name = place.world_name
      if (typeof place.x === 'number') row.x = place.x
      if (typeof place.y === 'number') row.y = place.y
    }
    if (extra.from_place_key) row.from_place_key = extra.from_place_key
    if (extra.to_place_key) row.to_place_key = extra.to_place_key

    queue.push(row)
    scheduleFlush()
  } catch {
    /* analytics must never surface */
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = 0
    void flushQueue()
  }, 40)
}

async function flushQueue(): Promise<void> {
  if (queue.length === 0) return
  const batch = queue.splice(0, 20)
  try {
    await fetch(ingestUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      keepalive: true
    })
  } catch {
    /* drop — do not requeue forever */
  }
  if (queue.length > 0) scheduleFlush()
}

/** Flush pending events (e.g. pagehide). */
export function flushAnalyticsSync(): void {
  if (!analyticsEnabled() || queue.length === 0) return
  const batch = queue.splice(0, 20)
  try {
    const body = JSON.stringify({ events: batch })
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' })
      navigator.sendBeacon(ingestUrl(), blob)
      return
    }
    void fetch(ingestUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true
    })
  } catch {
    /* ignore */
  }
}
