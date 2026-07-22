/**
 * Decentraland Notifications Workers API (Inbox service).
 * @see https://docs.decentraland.org/apis/apis/notifications-workers/notifications
 */
import signedFetch from 'decentraland-crypto-fetch'
import type { AuthIdentity } from '@dcl/crypto/dist/types'

const NOTIFICATIONS_URL =
  (import.meta.env.VITE_NOTIFICATIONS_URL as string | undefined)?.trim().replace(/\/$/, '') ||
  'https://notifications.decentraland.org'

/** Explorer-signed fetch — service rejects kernel-scene signer. */
const EXPLORER_METADATA = {
  signer: 'dcl:explorer',
  intent: 'dcl:explorer:notifications'
}

export type DclNotification = {
  id: string
  type: string
  address: string | null
  metadata: Record<string, unknown>
  /** Unix seconds (API string). */
  timestamp: string
  read: boolean
}

export type FetchNotificationsResult =
  | { ok: true; notifications: DclNotification[] }
  | { ok: false; status: number; error: string }

export type MarkNotificationsReadResult =
  | { ok: true; updated: number }
  | { ok: false; status: number; error: string }

export function getNotificationsBaseUrl(): string {
  return NOTIFICATIONS_URL
}

function parseNotification(raw: unknown): DclNotification | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  if (typeof o.type !== 'string') return null
  if (typeof o.timestamp !== 'string' && typeof o.timestamp !== 'number') return null
  if (typeof o.read !== 'boolean') return null
  const address =
    o.address === null
      ? null
      : typeof o.address === 'string' && /^0x[a-fA-F0-9]{40}$/i.test(o.address)
        ? o.address.toLowerCase()
        : null
  const metadata =
    o.metadata && typeof o.metadata === 'object' && !Array.isArray(o.metadata)
      ? (o.metadata as Record<string, unknown>)
      : {}
  return {
    id: o.id.trim(),
    type: o.type,
    address,
    metadata,
    timestamp: String(o.timestamp),
    read: o.read
  }
}

export type GetNotificationsQuery = {
  /** Unix ms — only notifications with timestamp >= from */
  from?: number
  limit?: number
  onlyUnread?: boolean
}

/**
 * GET /notifications — paginated inbox for the authenticated wallet.
 * Address comes from the signed-fetch auth chain.
 */
export async function fetchNotifications(
  identity: AuthIdentity,
  query: GetNotificationsQuery = {}
): Promise<FetchNotificationsResult> {
  const params = new URLSearchParams()
  if (query.from != null && query.from >= 0) params.set('from', String(Math.floor(query.from)))
  if (query.limit != null) {
    params.set('limit', String(Math.min(50, Math.max(1, Math.floor(query.limit)))))
  }
  if (query.onlyUnread) params.set('onlyUnread', 'true')

  const qs = params.toString()
  const url = `${NOTIFICATIONS_URL}/notifications${qs ? `?${qs}` : ''}`

  let res: Response
  try {
    res = await signedFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      identity,
      metadata: EXPLORER_METADATA
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 503, error: `notifications_unreachable: ${detail}` }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const error =
      body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : res.statusText || 'notifications_fetch_failed'
    return { ok: false, status: res.status, error }
  }

  const list =
    body && typeof body === 'object' && Array.isArray((body as { notifications?: unknown }).notifications)
      ? (body as { notifications: unknown[] }).notifications
      : []
  const notifications: DclNotification[] = []
  for (const entry of list) {
    const n = parseNotification(entry)
    if (n) notifications.push(n)
  }
  return { ok: true, notifications }
}

/** PUT /notifications/read — mark ids as read (irreversible). */
export async function markNotificationsRead(
  identity: AuthIdentity,
  notificationIds: string[]
): Promise<MarkNotificationsReadResult> {
  const ids = notificationIds.map((id) => id.trim()).filter(Boolean)
  if (!ids.length) return { ok: false, status: 400, error: 'notificationIds required' }

  const url = `${NOTIFICATIONS_URL}/notifications/read`
  let res: Response
  try {
    res = await signedFetch(url, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ notificationIds: ids }),
      identity,
      metadata: EXPLORER_METADATA
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 503, error: `notifications_unreachable: ${detail}` }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const error =
      body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : res.statusText || 'mark_read_failed'
    return { ok: false, status: res.status, error }
  }

  const updated =
    body && typeof body === 'object' && typeof (body as { updated?: unknown }).updated === 'number'
      ? (body as { updated: number }).updated
      : ids.length
  return { ok: true, updated }
}

function metaString(m: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const v = m[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/** Best-effort title from notification metadata. */
export function notificationTitle(n: DclNotification): string {
  const m = n.metadata
  // Friendship / social: show sender name as the primary title (Explorer style).
  if (isSocialFriendshipType(n.type)) {
    const name = metaString(m, [
      'senderName',
      'userName',
      'displayName',
      'fromName',
      'name',
      'Name',
      'title',
      'Title'
    ])
    if (name) return name
  }
  const title = metaString(m, ['title', 'Title', 'subject', 'Subject', 'name', 'Name'])
  if (title) return title
  return humanizeNotificationType(n.type)
}

export function notificationBody(n: DclNotification): string {
  const m = n.metadata
  if (isSocialFriendshipType(n.type)) {
    const t = n.type.toLowerCase()
    if (t.includes('request') && !t.includes('accept')) return 'sent you a friend request'
    if (t.includes('accept')) return 'accepted your friend request'
  }
  const body = metaString(m, [
    'description',
    'Description',
    'body',
    'Body',
    'text',
    'Text',
    'message',
    'Message'
  ])
  return body
}

export function notificationLink(n: DclNotification): string | null {
  const m = n.metadata
  for (const key of ['link', 'Link', 'url', 'Url', 'href'] as const) {
    const v = m[key]
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim()
  }
  return null
}

/** Image / avatar URL from metadata (or profile-images entity id). */
export function notificationImageUrl(n: DclNotification): string | null {
  const m = n.metadata
  for (const key of [
    'image',
    'imageUrl',
    'thumbnail',
    'thumbnailUrl',
    'icon',
    'iconUrl',
    'picture',
    'portraitUrl',
    'face',
    'faceUrl',
    'avatar',
    'avatarUrl'
  ] as const) {
    const v = m[key]
    if (typeof v !== 'string' || !v.trim()) continue
    const s = v.trim()
    if (/^https?:\/\//i.test(s)) return s
    // Catalyst face snapshot entity id
    if (/^[a-zA-Z0-9_-]{20,}$/.test(s) && !s.includes(' ')) {
      return `https://profile-images.decentraland.org/entities/${s}/face.png`
    }
  }
  // Nested sender / from objects
  for (const nestKey of ['sender', 'from', 'user', 'profile'] as const) {
    const nest = m[nestKey]
    if (!nest || typeof nest !== 'object') continue
    const o = nest as Record<string, unknown>
    for (const k of ['image', 'imageUrl', 'face', 'faceUrl', 'avatar', 'portraitUrl'] as const) {
      const v = o[k]
      if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim()
    }
  }
  return null
}

/** Wallet address associated with a social notification (for face lookup). */
export function notificationActorAddress(n: DclNotification): string | null {
  const m = n.metadata
  for (const key of ['address', 'sender', 'from', 'userId', 'ethAddress', 'wallet'] as const) {
    const v = m[key]
    if (typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/i.test(v)) return v.toLowerCase()
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      for (const k of ['address', 'userId', 'ethAddress'] as const) {
        const inner = o[k]
        if (typeof inner === 'string' && /^0x[a-fA-F0-9]{40}$/i.test(inner)) return inner.toLowerCase()
      }
    }
  }
  if (n.address && /^0x[a-fA-F0-9]{40}$/i.test(n.address)) return n.address.toLowerCase()
  return null
}

export function isSocialFriendshipType(type: string): boolean {
  const t = type.toLowerCase()
  return t.includes('friend') || t.includes('social_service') || t.includes('friendship')
}

/** Green title accent for person-name rows (Explorer friendship style). */
export function notificationTitleAccent(n: DclNotification): 'person' | 'default' {
  return isSocialFriendshipType(n.type) ? 'person' : 'default'
}

export type NotificationTypeKind =
  | 'friendship'
  | 'campaign'
  | 'event'
  | 'reward'
  | 'marketplace'
  | 'governance'
  | 'world'
  | 'generic'

export function notificationTypeKind(type: string): NotificationTypeKind {
  const t = type.toLowerCase()
  if (t.includes('friend') || t.includes('friendship') || t.includes('social_service')) return 'friendship'
  if (t.includes('campaign') || t.includes('marketing') || t.includes('announcement')) return 'campaign'
  if (t.includes('event')) return 'event'
  if (t.includes('reward') || t.includes('airdrop') || t.includes('credit')) return 'reward'
  if (t.includes('bid') || t.includes('rental') || t.includes('sale') || t.includes('marketplace'))
    return 'marketplace'
  if (t.includes('governance') || t.includes('proposal') || t.includes('vote')) return 'governance'
  if (t.includes('world')) return 'world'
  return 'generic'
}

export function humanizeNotificationType(type: string): string {
  const t = type.trim()
  if (!t) return 'Notification'
  return t
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Parse API timestamp (seconds or ms string/number) to Date. */
export function notificationDate(n: DclNotification): Date {
  const raw = Number(n.timestamp)
  if (!Number.isFinite(raw) || raw <= 0) return new Date(0)
  // Heuristic: seconds vs ms
  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms)
}

/** Absolute local datetime (tooltip / a11y). */
export function formatNotificationTime(n: DclNotification): string {
  const d = notificationDate(n)
  if (d.getTime() <= 0) return ''
  try {
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  } catch {
    return d.toISOString()
  }
}

/** Explorer-style relative time: "3 days ago", "2 hours ago", "Just now". */
export function formatNotificationRelativeTime(n: DclNotification, nowMs = Date.now()): string {
  const d = notificationDate(n)
  const t = d.getTime()
  if (t <= 0) return ''
  const diff = Math.max(0, nowMs - t)
  const sec = Math.floor(diff / 1000)
  if (sec < 45) return 'Just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return min === 1 ? '1 minute ago' : `${min} minutes ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return hr === 1 ? '1 hour ago' : `${hr} hours ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return day === 1 ? '1 day ago' : `${day} days ago`
  const month = Math.floor(day / 30)
  if (month < 12) return month === 1 ? '1 month ago' : `${month} months ago`
  const year = Math.floor(day / 365)
  return year === 1 ? '1 year ago' : `${year} years ago`
}
