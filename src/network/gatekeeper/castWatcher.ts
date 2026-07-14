/**
 * Cast 2.0 watcher credentials — separate LiveKit room from scene chat.
 * @see https://docs.decentraland.org/apis/apis/comms-gatekeeper/cast-2.0
 */
import { GATEKEEPER_URL } from './GatekeeperClient'

export type CastWatcherTokenResult =
  | {
      ok: true
      url: string
      token: string
      roomId: string | null
      identity: string
      placeName?: string
    }
  | { ok: false; status: number; error: string }

/**
 * POST /cast/watcher-token — no wallet auth.
 * `location` = world name (e.g. rickroll.dcl.eth) or base parcel (e.g. -95,83).
 * `identity` = display id for this watcher (wallet address or guest id).
 */
export async function fetchCastWatcherToken(
  location: string,
  identity: string,
  gatekeeperUrl = GATEKEEPER_URL
): Promise<CastWatcherTokenResult> {
  const loc = location.trim()
  const id = identity.trim()
  if (!loc || !id) {
    return { ok: false, status: 400, error: 'location_and_identity_required' }
  }

  let res: Response
  try {
    res = await fetch(`${gatekeeperUrl.replace(/\/$/, '')}/cast/watcher-token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: loc, identity: id })
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return { ok: false, status: 503, error: `gatekeeper_unreachable: ${detail}` }
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const err =
      body &&
      typeof body === 'object' &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : res.statusText || 'gatekeeper_error'
    return { ok: false, status: res.status, error: err }
  }

  if (!body || typeof body !== 'object') {
    return { ok: false, status: res.status, error: 'invalid_cast_watcher_response' }
  }
  const o = body as Record<string, unknown>
  const url = typeof o.url === 'string' ? o.url.trim() : ''
  const token = typeof o.token === 'string' ? o.token.trim() : ''
  if (!url || !token) {
    return { ok: false, status: res.status, error: 'invalid_cast_watcher_response' }
  }

  const roomRaw = o.roomId
  const roomId =
    roomRaw == null || roomRaw === ''
      ? null
      : typeof roomRaw === 'string'
        ? roomRaw.trim() || null
        : String(roomRaw)

  return {
    ok: true,
    url,
    token,
    roomId,
    identity: typeof o.identity === 'string' && o.identity.trim() ? o.identity.trim() : id,
    placeName: typeof o.placeName === 'string' && o.placeName.trim() ? o.placeName.trim() : undefined
  }
}

/** True when gatekeeper reports an active Cast room for this location. */
export async function probeCastStreamActive(
  location: string,
  identity: string
): Promise<{ active: boolean; roomId: string | null; error?: string }> {
  const r = await fetchCastWatcherToken(location, identity)
  if (!r.ok) {
    // 401 = no active stream for location (per API docs)
    if (r.status === 401) return { active: false, roomId: null }
    return { active: false, roomId: null, error: r.error }
  }
  return { active: r.roomId != null && r.roomId.length > 0, roomId: r.roomId }
}
