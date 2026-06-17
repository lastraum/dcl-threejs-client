import signedFetch from 'decentraland-crypto-fetch'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { parseCommunitiesListFromJson } from './memberCommunities'
import type { CommunityListRow } from './types'

const SOCIAL_API_URL =
  (import.meta.env.VITE_SOCIAL_API_URL as string | undefined)?.trim().replace(/\/$/, '') ||
  'https://social-api.decentraland.org'

export function getSocialApiBaseUrl(): string {
  return SOCIAL_API_URL
}

export async function fetchMemberCommunitiesSigned(
  identity: AuthIdentity
): Promise<{ communities: CommunityListRow[]; total: number }> {
  const url = new URL(`${getSocialApiBaseUrl()}/v1/communities`)
  url.searchParams.set('limit', '100')
  url.searchParams.set('offset', '0')
  url.searchParams.set('onlyMemberOf', 'true')

  const res = await signedFetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    identity
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
    throw new Error(body.message ?? body.error ?? `Social API ${res.status}`)
  }

  const raw = (await res.json()) as Record<string, unknown>
  const communities = parseCommunitiesListFromJson(raw)
  const data = raw.data
  let total = communities.length
  if (typeof raw.total === 'number') total = raw.total
  else if (data && typeof data === 'object' && !Array.isArray(data)) {
    const t = (data as { total?: unknown }).total
    if (typeof t === 'number') total = t
  }
  return { communities, total }
}
