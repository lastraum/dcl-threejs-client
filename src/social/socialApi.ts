import signedFetch from 'decentraland-crypto-fetch'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { parseCommunityDetailJson } from './communityDetail'
import { parseCommunitiesListFromJson } from './memberCommunities'
import type { CommunityDetail, CommunityListRow } from './types'

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

export async function fetchCommunitiesBrowsePublic(params: {
  limit?: number
  offset?: number
  search?: string
}): Promise<{ communities: CommunityListRow[]; total: number }> {
  const url = new URL(`${getSocialApiBaseUrl()}/v1/communities`)
  url.searchParams.set('limit', String(params.limit ?? 100))
  url.searchParams.set('offset', String(params.offset ?? 0))
  url.searchParams.set('onlyMemberOf', 'false')
  const q = params.search?.trim()
  if (q) url.searchParams.set('search', q)

  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
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

export async function fetchCommunitiesBrowseSigned(
  identity: AuthIdentity,
  params: { limit?: number; offset?: number; search?: string } = {}
): Promise<{ communities: CommunityListRow[]; total: number }> {
  const url = new URL(`${getSocialApiBaseUrl()}/v1/communities`)
  url.searchParams.set('limit', String(params.limit ?? 100))
  url.searchParams.set('offset', String(params.offset ?? 0))
  url.searchParams.set('onlyMemberOf', 'false')
  const q = params.search?.trim()
  if (q) url.searchParams.set('search', q)

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

export async function fetchCommunityByIdPublic(communityId: string): Promise<CommunityDetail | null> {
  const id = communityId.trim()
  if (!id) return null
  const url = `${getSocialApiBaseUrl()}/v1/communities/${encodeURIComponent(id)}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) return null
  const raw = await res.json()
  return parseCommunityDetailJson(raw)
}

export async function fetchCommunityByIdSigned(
  identity: AuthIdentity,
  communityId: string
): Promise<CommunityDetail | null> {
  const id = communityId.trim()
  if (!id) return null
  const url = `${getSocialApiBaseUrl()}/v1/communities/${encodeURIComponent(id)}`
  const res = await signedFetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    identity
  })
  if (!res.ok) return null
  const raw = await res.json()
  return parseCommunityDetailJson(raw)
}
