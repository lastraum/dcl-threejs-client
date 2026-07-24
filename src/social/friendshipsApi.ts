import signedFetch from 'decentraland-crypto-fetch'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import {
  fetchFriendshipSnapshotViaSocialRpc,
  upsertFriendshipViaSocialRpc
} from './socialServiceV2'

/** REST host used by Explorer `@dcl/social-rpc-client` (social-service.decentraland.org is NXDOMAIN). */
const SOCIAL_SERVICE_URL =
  (import.meta.env.VITE_SOCIAL_SERVICE_URL as string | undefined)?.trim().replace(/\/$/, '') ||
  'https://social.decentraland.org'

export type FriendshipRelation = 'none' | 'friends' | 'request-sent' | 'request-received' | 'unknown'

export type FriendshipDisplayHint = {
  displayName: string
  faceUrl: string | null
  nameColor?: string | null
}

export type FriendshipSnapshot = {
  friends: Set<string>
  incoming: Set<string>
  outgoing: Set<string>
  /** Lowercased address → name/face from social-rpc (session seed). */
  displayHints?: Map<string, FriendshipDisplayHint>
}

export function getSocialServiceBaseUrl(): string {
  return SOCIAL_SERVICE_URL
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(trimmed) ? trimmed : null
}

function collectAddresses(value: unknown): Set<string> {
  const out = new Set<string>()
  if (!value) return out

  if (typeof value === 'string') {
    const addr = normalizeAddress(value)
    if (addr) out.add(addr)
    return out
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      for (const addr of collectAddresses(entry)) out.add(addr)
    }
    return out
  }

  if (typeof value !== 'object') return out
  const obj = value as Record<string, unknown>

  // Common shapes: { address }, { user: { address } }, { userAddress }, { id }
  const direct =
    normalizeAddress(obj.address) ??
    normalizeAddress(obj.userAddress) ??
    normalizeAddress(obj.user_address) ??
    normalizeAddress(obj.id)
  if (direct) {
    out.add(direct)
    return out
  }
  if (obj.user && typeof obj.user === 'object') {
    const nested = normalizeAddress((obj.user as { address?: unknown }).address)
    if (nested) {
      out.add(nested)
      return out
    }
  }

  // Aggregate containers from REST /friendships/me and /v1 variants.
  for (const key of [
    'friends',
    'friendships',
    'users',
    'data',
    'elements',
    'results',
    'items'
  ] as const) {
    if (key in obj) {
      for (const addr of collectAddresses(obj[key])) out.add(addr)
    }
  }
  return out
}

function collectRequestAddresses(value: unknown, bucket: 'incoming' | 'outgoing'): Set<string> {
  const out = new Set<string>()
  if (!value || typeof value !== 'object') return out
  const obj = value as Record<string, unknown>
  const list =
    obj[bucket] ??
    obj[bucket === 'incoming' ? 'received' : 'sent'] ??
    obj[bucket === 'incoming' ? 'requestsReceived' : 'requestsSent']
  return collectAddresses(list)
}

/** Prefer first successful GET among path candidates (docs + OpenAPI variants). */
async function signedGetJson(
  base: string,
  paths: string[],
  identity: AuthIdentity
): Promise<{ ok: true; path: string; raw: Record<string, unknown> } | { ok: false; status: number; path: string; error: string }> {
  const signedInit = {
    method: 'GET' as const,
    headers: { Accept: 'application/json' },
    identity
  }
  let last: { status: number; path: string; error: string } = {
    status: 0,
    path: paths[0] ?? '',
    error: 'no paths'
  }
  for (const path of paths) {
    const url = `${base}${path}`
    try {
      const res = await signedFetch(url, signedInit)
      if (res.ok) {
        const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>
        return { ok: true, path, raw }
      }
      last = { status: res.status, path, error: await readSocialServiceError(res) }
      // 401/403 — auth problem, don't thrash alternates
      if (res.status === 401 || res.status === 403) break
      // 5xx / 530 — same origin is down; no point trying path variants
      if (res.status >= 500) break
      // 404 — try next path shape
      if (res.status === 404) continue
    } catch (err) {
      last = {
        status: 0,
        path,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }
  return { ok: false, ...last }
}

export function resolveFriendshipRelation(
  address: string,
  snapshot: FriendshipSnapshot | null
): FriendshipRelation {
  if (!snapshot) return 'unknown'
  const key = address.toLowerCase()
  if (snapshot.friends.has(key)) return 'friends'
  if (snapshot.incoming.has(key)) return 'request-received'
  if (snapshot.outgoing.has(key)) return 'request-sent'
  return 'none'
}

export function buildFriendshipRelationMap(snapshot: FriendshipSnapshot): Map<string, FriendshipRelation> {
  const map = new Map<string, FriendshipRelation>()
  for (const addr of snapshot.friends) map.set(addr, 'friends')
  for (const addr of snapshot.incoming) map.set(addr, 'request-received')
  for (const addr of snapshot.outgoing) map.set(addr, 'request-sent')
  return map
}

export function friendshipActionLabel(relation: FriendshipRelation): {
  label: string
  disabled: boolean
  variant: 'add' | 'friends' | 'pending' | 'accept'
} {
  switch (relation) {
    case 'friends':
      return { label: 'Friends', disabled: true, variant: 'friends' }
    case 'request-sent':
      return { label: 'Request Sent', disabled: true, variant: 'pending' }
    case 'request-received':
      return { label: 'Accept Request', disabled: false, variant: 'accept' }
    case 'none':
      return { label: 'Add Friend', disabled: false, variant: 'add' }
    default:
      return { label: 'Add Friend', disabled: false, variant: 'add' }
  }
}

async function readSocialServiceError(res: Response): Promise<string> {
  const raw = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
  return raw.message ?? raw.error ?? res.statusText ?? `HTTP ${res.status}`
}

/**
 * Load friendships for the signed-in user.
 *
 * Primary (working in production): Social Service **v2 WebSocket RPC**
 *   GetFriends / GetPendingFriendshipRequests / GetSentFriendshipRequests
 *   (see docs.decentraland.org/contributor/social-service/get-friends)
 *
 * Fallback: signed REST (legacy ADR-113 / OpenAPI):
 *   GET /friendships/me, GET /v1/friendships/{userId}, GET /v1/friendships/me/requests
 *   Note: social.decentraland.org often returns 530 on REST friendships origin.
 */
export async function fetchFriendshipSnapshotSigned(
  identity: AuthIdentity,
  userAddress: string
): Promise<FriendshipSnapshot> {
  // 1) WebSocket RPC — Explorer path
  try {
    const rpc = await fetchFriendshipSnapshotViaSocialRpc(identity)
    console.info(
      `[social] friends via social-rpc: ${rpc.friends.size} friends, ${rpc.incoming.size} in, ${rpc.outgoing.size} out (hints=${rpc.displayHints.size})`
    )
    return {
      friends: rpc.friends,
      incoming: rpc.incoming,
      outgoing: rpc.outgoing,
      displayHints: rpc.displayHints
    }
  } catch (err) {
    console.warn(
      '[social] social-rpc GetFriends failed, falling back to REST:',
      err instanceof Error ? err.message : err
    )
  }

  // 2) REST fallback
  const base = getSocialServiceBaseUrl()
  const userId = userAddress.trim().toLowerCase()

  const [friendsHit, requestsHit] = await Promise.all([
    signedGetJson(
      base,
      [
        // Documented Social Service path
        '/friendships/me',
        // Common /v1 variants used by social.decentraland.org
        '/v1/friendships/me',
        `/v1/friendships/${userId}`,
        `/friendships/${userId}`
      ],
      identity
    ),
    signedGetJson(
      base,
      ['/friendships/me/requests', '/v1/friendships/me/requests', '/friendships/me'],
      identity
    )
  ])

  let friends = new Set<string>()
  let incoming = new Set<string>()
  let outgoing = new Set<string>()

  if (friendsHit.ok) {
    const raw = friendsHit.raw
    friends = collectAddresses(raw.friends ?? raw.friendships ?? raw.data ?? raw.users ?? raw)
    // Some /friendships/me responses also embed pending requests
    if (incoming.size === 0) incoming = collectRequestAddresses(raw, 'incoming')
    if (outgoing.size === 0) outgoing = collectRequestAddresses(raw, 'outgoing')
    console.info(`[social] friends via REST ${friendsHit.path}: ${friends.size}`)
  } else if (friendsHit.status > 0) {
    console.warn(
      `[social] friendships list ${friendsHit.status}: ${friendsHit.error} (${base}${friendsHit.path})`
    )
  }

  if (requestsHit.ok) {
    const raw = requestsHit.raw
    const inc = collectRequestAddresses(raw, 'incoming')
    const out = collectRequestAddresses(raw, 'outgoing')
    if (inc.size > 0) incoming = inc
    if (out.size > 0) outgoing = out
    // If this was a friends list hit reused for requests, also harvest friends
    if (friends.size === 0) {
      const extra = collectAddresses(raw.friends ?? raw.friendships)
      if (extra.size > 0) friends = extra
    }
  } else if (requestsHit.status > 0 && requestsHit.path.includes('requests')) {
    console.warn(
      `[social] friendship requests ${requestsHit.status}: ${requestsHit.error} (${base}${requestsHit.path})`
    )
  }

  if (!friendsHit.ok && !requestsHit.ok) {
    // social.decentraland.org returns 530 when the friendships origin is down — degrade gracefully.
    if (friendsHit.status >= 500 || requestsHit.status >= 500 || friendsHit.status === 0) {
      return { friends: new Set(), incoming: new Set(), outgoing: new Set() }
    }
    throw new Error(
      `Social service friendships unavailable (${friendsHit.status}/${requestsHit.status})`
    )
  }

  return { friends, incoming, outgoing, displayHints: new Map() }
}

async function friendshipMutation(
  identity: AuthIdentity,
  path: string,
  method: 'POST' | 'PUT' | 'DELETE'
): Promise<void> {
  const base = getSocialServiceBaseUrl()
  const res = await signedFetch(`${base}${path}`, {
    method,
    headers: { Accept: 'application/json' },
    identity
  })
  if (res.ok || res.status === 204) return
  throw new Error(await readSocialServiceError(res))
}

/** Accept an incoming friend request. */
export async function acceptFriendshipRequestSigned(
  identity: AuthIdentity,
  peerAddress: string
): Promise<void> {
  const addr = peerAddress.trim().toLowerCase()
  try {
    await upsertFriendshipViaSocialRpc(identity, 'accept', addr)
    return
  } catch (err) {
    console.warn('[social] rpc accept failed, REST fallback:', err)
  }
  try {
    await friendshipMutation(identity, `/v1/friendships/${addr}/accept`, 'POST')
    return
  } catch {
    /* try alternate */
  }
  await friendshipMutation(identity, `/v1/friendships/me/requests/${addr}/accept`, 'POST')
}

/** Reject / delete an incoming friend request. */
export async function rejectFriendshipRequestSigned(
  identity: AuthIdentity,
  peerAddress: string
): Promise<void> {
  const addr = peerAddress.trim().toLowerCase()
  try {
    await upsertFriendshipViaSocialRpc(identity, 'reject', addr)
    return
  } catch (err) {
    console.warn('[social] rpc reject failed, REST fallback:', err)
  }
  try {
    await friendshipMutation(identity, `/v1/friendships/${addr}/reject`, 'POST')
    return
  } catch {
    /* try alternate */
  }
  await friendshipMutation(identity, `/v1/friendships/me/requests/${addr}`, 'DELETE')
}

/** Cancel an outgoing friend request or remove an existing friendship. */
export async function removeFriendshipSigned(
  identity: AuthIdentity,
  peerAddress: string
): Promise<void> {
  const addr = peerAddress.trim().toLowerCase()
  try {
    // Try delete (existing friend); cancel covers pending outgoing.
    await upsertFriendshipViaSocialRpc(identity, 'delete', addr)
    return
  } catch {
    try {
      await upsertFriendshipViaSocialRpc(identity, 'cancel', addr)
      return
    } catch (err) {
      console.warn('[social] rpc remove/cancel failed, REST fallback:', err)
    }
  }
  await friendshipMutation(identity, `/v1/friendships/${addr}`, 'DELETE')
}

/** Send a friend request to an address. */
export async function requestFriendshipSigned(
  identity: AuthIdentity,
  peerAddress: string
): Promise<void> {
  const addr = peerAddress.trim().toLowerCase()
  try {
    await upsertFriendshipViaSocialRpc(identity, 'request', addr)
    return
  } catch (err) {
    console.warn('[social] rpc request failed, REST fallback:', err)
  }
  await friendshipMutation(identity, `/v1/friendships/${addr}`, 'POST')
}