import type { AuthIdentity } from '@dcl/crypto/dist/types'
import signedFetch from 'decentraland-crypto-fetch'
import { GATEKEEPER_URL } from './GatekeeperClient'

export type CommunityVoiceAction = 'create' | 'join'

export type CommunityVoiceJoinResult =
  | { ok: true; connectionUrl: string }
  | { ok: false; status: number; error: string }

export type ActiveCommunityVoiceChat = {
  communityId: string
  participantCount: number
  moderatorCount: number
  communityName?: string
  communityImage?: string
}

/**
 * Join / create community voice (LiveKit).
 *
 * Public OpenAPI lists BearerAuth (service-to-service). Explorer clients may
 * still reach this via signed-fetch — we try that path first. On 401, surface
 * a clear error so UI can show "voice join unavailable".
 */
export async function joinCommunityVoiceChat(
  identity: AuthIdentity,
  params: {
    communityId: string
    userAddress: string
    action: CommunityVoiceAction
    userRole?: 'owner' | 'moderator' | 'member' | 'none'
    profileName?: string
  },
  gatekeeperUrl = GATEKEEPER_URL
): Promise<CommunityVoiceJoinResult> {
  const url = `${gatekeeperUrl.replace(/\/$/, '')}/community-voice-chat`
  const body = {
    community_id: params.communityId,
    user_address: params.userAddress,
    action: params.action,
    user_role: params.userRole ?? 'member',
    ...(params.profileName
      ? { profile_data: { name: params.profileName, hasClaimedName: false } }
      : {})
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
        communityId: params.communityId
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
