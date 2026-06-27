import signedFetch from 'decentraland-crypto-fetch'
import type { AuthIdentity } from '@dcl/crypto/dist/types'

/** REST host used by Explorer `@dcl/social-rpc-client` (social-service.decentraland.org is NXDOMAIN). */
const SOCIAL_SERVICE_URL =
  (import.meta.env.VITE_SOCIAL_SERVICE_URL as string | undefined)?.trim().replace(/\/$/, '') ||
  'https://social.decentraland.org'

export type FriendshipRelation = 'none' | 'friends' | 'request-sent' | 'request-received' | 'unknown'

export type FriendshipSnapshot = {
  friends: Set<string>
  incoming: Set<string>
  outgoing: Set<string>
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
  if (!value || typeof value !== 'object') return out

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') {
        const addr = normalizeAddress(entry)
        if (addr) out.add(addr)
        continue
      }
      if (entry && typeof entry === 'object') {
        const addr = normalizeAddress((entry as { address?: unknown }).address)
        if (addr) out.add(addr)
      }
    }
    return out
  }

  const friends = (value as { friends?: unknown }).friends
  if (Array.isArray(friends)) return collectAddresses(friends)
  return out
}

function collectRequestAddresses(value: unknown, bucket: 'incoming' | 'outgoing'): Set<string> {
  const out = new Set<string>()
  if (!value || typeof value !== 'object') return out
  const list = (value as Record<string, unknown>)[bucket]
  return collectAddresses(list)
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
 * Signed REST fetch (ADR-44) — `identity` adds `Authorization: <signed-fetch-token>`.
 * Friends: GET /v1/friendships/{userId}; requests: GET /v1/friendships/me/requests.
 */
export async function fetchFriendshipSnapshotSigned(
  identity: AuthIdentity,
  userAddress: string
): Promise<FriendshipSnapshot> {
  const base = getSocialServiceBaseUrl()
  const userId = userAddress.trim().toLowerCase()
  const signedInit = {
    method: 'GET' as const,
    headers: { Accept: 'application/json' },
    identity
  }

  const [friendsRes, requestsRes] = await Promise.all([
    signedFetch(`${base}/v1/friendships/${userId}`, signedInit),
    signedFetch(`${base}/v1/friendships/me/requests`, signedInit)
  ])

  let friends = new Set<string>()
  if (friendsRes.ok) {
    const raw = (await friendsRes.json().catch(() => ({}))) as Record<string, unknown>
    friends = collectAddresses(raw.friends ?? raw.data ?? raw)
  } else {
    console.warn(
      `[social] friendships list ${friendsRes.status}: ${await readSocialServiceError(friendsRes)} (${base}/v1/friendships/${userId})`
    )
  }

  let incoming = new Set<string>()
  let outgoing = new Set<string>()
  if (requestsRes.ok) {
    const raw = (await requestsRes.json().catch(() => ({}))) as Record<string, unknown>
    incoming = collectRequestAddresses(raw, 'incoming')
    outgoing = collectRequestAddresses(raw, 'outgoing')
  } else {
    console.warn(
      `[social] friendship requests ${requestsRes.status}: ${await readSocialServiceError(requestsRes)} (${base}/v1/friendships/me/requests)`
    )
  }

  if (!friendsRes.ok && !requestsRes.ok) {
    throw new Error(`Social service friendships unavailable (${friendsRes.status}/${requestsRes.status})`)
  }

  return { friends, incoming, outgoing }
}