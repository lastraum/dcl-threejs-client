import type { AuthIdentity } from '@dcl/crypto/dist/types'
import signedFetch from 'decentraland-crypto-fetch'
import { GATEKEEPER_URL } from './GatekeeperClient'

/**
 * Gatekeeper community-voice actions (signed-fetch client path).
 * OpenAPI also documents service Bearer — we use signed-fetch like Explorer clients.
 * Preferred client path is Social Service v2 RPC; this is fallback.
 */
export type CommunityVoiceAction =
  | 'create'
  | 'join'
  | 'request-to-speak'
  | 'promote-speaker'
  | 'demote-speaker'
  | 'kick-player'

export type CommunityVoiceJoinResult =
  | { ok: true; connectionUrl: string }
  | { ok: false; status: number; error: string }

export type CommunityVoiceActionResult = { ok: true } | { ok: false; status: number; error: string }

export type ActiveCommunityVoiceChat = {
  communityId: string
  participantCount: number
  moderatorCount: number
  communityName?: string
  communityImage?: string
}

export type CommunityUserRole = 'owner' | 'moderator' | 'member' | 'none'

function mapRole(role?: string | null): CommunityUserRole {
  const r = (role ?? '').trim().toLowerCase()
  if (r === 'owner') return 'owner'
  if (r === 'moderator' || r === 'mod' || r === 'admin') return 'moderator'
  if (r === 'member') return 'member'
  return 'none'
}

/**
 * Join / create community voice (LiveKit credentials).
 * For promote/demote/request-to-speak/kick, use dedicated helpers (may return 204).
 */
export async function joinCommunityVoiceChat(
  identity: AuthIdentity,
  params: {
    communityId: string
    userAddress: string
    action: CommunityVoiceAction
    userRole?: string | null
    profileName?: string
    /** Target user for promote / demote / kick (when different from self). */
    targetUserAddress?: string
  },
  gatekeeperUrl = GATEKEEPER_URL
): Promise<CommunityVoiceJoinResult> {
  const url = `${gatekeeperUrl.replace(/\/$/, '')}/community-voice-chat`
  const body: Record<string, unknown> = {
    community_id: params.communityId,
    user_address: params.userAddress.toLowerCase(),
    action: params.action,
    user_role: mapRole(params.userRole)
  }
  if (params.profileName) {
    body.profile_data = { name: params.profileName, hasClaimedName: false }
  }
  if (params.targetUserAddress) {
    body.target_user_address = params.targetUserAddress.toLowerCase()
  }

  let res: Response
  try {
    res = await signedFetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      identity,
      metadata: {
        signer: 'decentraland-kernel-scene',
        intent: 'dcl:explorer:community-voice',
        communityId: params.communityId,
        action: params.action
      }
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 503, error: `gatekeeper_unreachable: ${detail}` }
  }

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }

  if (!res.ok) {
    const error =
      parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : res.statusText || 'community_voice_join_failed'
    return { ok: false, status: res.status, error }
  }

  // Promote/demote/request/kick may return 200 empty or 204.
  if (res.status === 204 || params.action !== 'create' && params.action !== 'join') {
    const connectionUrl =
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { connection_url?: unknown }).connection_url === 'string'
        ? (parsed as { connection_url: string }).connection_url.trim()
        : ''
    if (connectionUrl) return { ok: true, connectionUrl }
    // Action succeeded without new credentials.
    if (params.action !== 'create' && params.action !== 'join') {
      return { ok: true, connectionUrl: '' }
    }
  }

  const connectionUrl =
    parsed &&
    typeof parsed === 'object' &&
    typeof (parsed as { connection_url?: unknown }).connection_url === 'string'
      ? (parsed as { connection_url: string }).connection_url.trim()
      : parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { adapter?: unknown }).adapter === 'string'
        ? (parsed as { adapter: string }).adapter.trim()
        : ''

  if (!connectionUrl) {
    return { ok: false, status: res.status, error: 'invalid_community_voice_response' }
  }

  return { ok: true, connectionUrl }
}

/** POST /community-voice-chat/{id}/users/{addr}/speak-request */
export async function requestToSpeakGatekeeper(
  identity: AuthIdentity,
  communityId: string,
  userAddress: string,
  gatekeeperUrl = GATEKEEPER_URL
): Promise<CommunityVoiceActionResult> {
  const base = gatekeeperUrl.replace(/\/$/, '')
  const url = `${base}/community-voice-chat/${encodeURIComponent(communityId)}/users/${encodeURIComponent(userAddress.toLowerCase())}/speak-request`
  return signedAction(identity, url, 'POST', communityId)
}

/** DELETE speak-request (reject / lower hand as mod, or withdraw). */
export async function rejectSpeakRequestGatekeeper(
  identity: AuthIdentity,
  communityId: string,
  userAddress: string,
  gatekeeperUrl = GATEKEEPER_URL
): Promise<CommunityVoiceActionResult> {
  const base = gatekeeperUrl.replace(/\/$/, '')
  const url = `${base}/community-voice-chat/${encodeURIComponent(communityId)}/users/${encodeURIComponent(userAddress.toLowerCase())}/speak-request`
  return signedAction(identity, url, 'DELETE', communityId)
}

/** POST …/speaker — promote */
export async function promoteSpeakerGatekeeper(
  identity: AuthIdentity,
  communityId: string,
  userAddress: string,
  gatekeeperUrl = GATEKEEPER_URL
): Promise<CommunityVoiceActionResult> {
  const base = gatekeeperUrl.replace(/\/$/, '')
  const url = `${base}/community-voice-chat/${encodeURIComponent(communityId)}/users/${encodeURIComponent(userAddress.toLowerCase())}/speaker`
  return signedAction(identity, url, 'POST', communityId)
}

/** DELETE …/speaker — demote */
export async function demoteSpeakerGatekeeper(
  identity: AuthIdentity,
  communityId: string,
  userAddress: string,
  gatekeeperUrl = GATEKEEPER_URL
): Promise<CommunityVoiceActionResult> {
  const base = gatekeeperUrl.replace(/\/$/, '')
  const url = `${base}/community-voice-chat/${encodeURIComponent(communityId)}/users/${encodeURIComponent(userAddress.toLowerCase())}/speaker`
  return signedAction(identity, url, 'DELETE', communityId)
}

/** DELETE …/users/{addr} — kick from community voice */
export async function kickPlayerGatekeeper(
  identity: AuthIdentity,
  communityId: string,
  userAddress: string,
  gatekeeperUrl = GATEKEEPER_URL
): Promise<CommunityVoiceActionResult> {
  const base = gatekeeperUrl.replace(/\/$/, '')
  const url = `${base}/community-voice-chat/${encodeURIComponent(communityId)}/users/${encodeURIComponent(userAddress.toLowerCase())}`
  return signedAction(identity, url, 'DELETE', communityId)
}

async function signedAction(
  identity: AuthIdentity,
  url: string,
  method: 'POST' | 'DELETE',
  communityId: string
): Promise<CommunityVoiceActionResult> {
  let res: Response
  try {
    res = await signedFetch(url, {
      method,
      headers: { Accept: 'application/json' },
      identity,
      metadata: {
        signer: 'decentraland-kernel-scene',
        intent: 'dcl:explorer:community-voice',
        communityId
      }
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 503, error: `gatekeeper_unreachable: ${detail}` }
  }
  if (res.ok || res.status === 204) return { ok: true }
  let error = res.statusText || 'community_voice_action_failed'
  try {
    const parsed = (await res.json()) as { error?: string }
    if (typeof parsed?.error === 'string') error = parsed.error
  } catch {
    /* ignore */
  }
  return { ok: false, status: res.status, error }
}

/** Active community voice chats visible to the signed-in user (Social API). */
export async function fetchActiveCommunityVoiceChats(
  identity: AuthIdentity,
  socialApiUrl = 'https://social-api.decentraland.org'
): Promise<ActiveCommunityVoiceChat[]> {
  const url = `${socialApiUrl.replace(/\/$/, '')}/v1/community-voice-chats/active`
  let res: Response
  try {
    res = await signedFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      identity
    })
  } catch {
    return []
  }
  if (!res.ok) return []
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return []
  }
  const data =
    body && typeof body === 'object' && (body as { data?: unknown }).data
      ? (body as { data: unknown }).data
      : body
  const list =
    data && typeof data === 'object' && Array.isArray((data as { activeChats?: unknown }).activeChats)
      ? (data as { activeChats: unknown[] }).activeChats
      : Array.isArray(data)
        ? data
        : []

  const out: ActiveCommunityVoiceChat[] = []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const communityId =
      typeof r.communityId === 'string'
        ? r.communityId
        : typeof r.community_id === 'string'
          ? r.community_id
          : ''
    if (!communityId) continue
    out.push({
      communityId,
      participantCount:
        typeof r.participantCount === 'number'
          ? r.participantCount
          : typeof r.participant_count === 'number'
            ? r.participant_count
            : 0,
      moderatorCount:
        typeof r.moderatorCount === 'number'
          ? r.moderatorCount
          : typeof r.moderator_count === 'number'
            ? r.moderator_count
            : 0,
      communityName:
        typeof r.communityName === 'string'
          ? r.communityName
          : typeof r.community_name === 'string'
            ? r.community_name
            : undefined,
      communityImage:
        typeof r.communityImage === 'string'
          ? r.communityImage
          : typeof r.community_image === 'string'
            ? r.community_image
            : undefined
    })
  }
  return out
}
