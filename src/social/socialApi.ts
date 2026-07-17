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

export async function fetchMemberCommunitiesByAddressPublic(
  memberAddress: string,
  params: { limit?: number; offset?: number } = {}
): Promise<{ communities: CommunityListRow[]; total: number }> {
  const address = memberAddress.trim().toLowerCase()
  const url = new URL(`${getSocialApiBaseUrl()}/v1/communities`)
  url.searchParams.set('limit', String(params.limit ?? 100))
  url.searchParams.set('offset', String(params.offset ?? 0))
  url.searchParams.set('onlyMemberOf', 'true')
  url.searchParams.set('memberAddress', address)

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

/** Join a community (POST /v1/communities/{id}/members). */
export async function joinCommunitySigned(
  identity: AuthIdentity,
  communityId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = communityId.trim()
  if (!id) return { ok: false, error: 'missing_community_id' }
  const url = `${getSocialApiBaseUrl()}/v1/communities/${encodeURIComponent(id)}/members`
  try {
    const res = await signedFetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      identity
    })
    if (res.ok || res.status === 204) return { ok: true }
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
    return { ok: false, error: body.message ?? body.error ?? `join_failed_${res.status}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type CommunityMemberRow = {
  address: string
  name?: string
  role?: string
  profilePictureUrl?: string
  joinedAt?: string
}

export type CommunityPost = {
  id: string
  communityId: string
  authorAddress: string
  authorName: string
  authorProfilePictureUrl?: string
  authorHasClaimedName?: boolean
  content: string
  createdAt: string
  likesCount: number
  isLikedByUser?: boolean
}

/**
 * Paginated community members (Social API).
 * Public GET works for public communities; pass identity for private + richer fields.
 */
export async function fetchCommunityMembers(
  communityId: string,
  opts: {
    identity?: AuthIdentity | null
    limit?: number
    offset?: number
    onlyOnline?: boolean
  } = {}
): Promise<{ members: CommunityMemberRow[]; total: number }> {
  const id = communityId.trim()
  if (!id) return { members: [], total: 0 }
  const url = new URL(
    `${getSocialApiBaseUrl()}/v1/communities/${encodeURIComponent(id)}/members`
  )
  url.searchParams.set('limit', String(opts.limit ?? 50))
  url.searchParams.set('offset', String(opts.offset ?? 0))
  if (opts.onlyOnline) url.searchParams.set('onlyOnline', 'true')

  const res = opts.identity
    ? await signedFetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        identity: opts.identity
      })
    : await fetch(url.toString(), { headers: { Accept: 'application/json' } })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
    throw new Error(body.message ?? body.error ?? `Social API members ${res.status}`)
  }

  const raw = (await res.json()) as Record<string, unknown>
  const data = raw.data
  let results: unknown[] = []
  let total = 0
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as { results?: unknown; total?: unknown }
    if (Array.isArray(d.results)) results = d.results
    if (typeof d.total === 'number') total = d.total
  } else if (Array.isArray(raw.results)) {
    results = raw.results as unknown[]
    if (typeof raw.total === 'number') total = raw.total
  }

  const members: CommunityMemberRow[] = []
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue
    const r = entry as Record<string, unknown>
    const addressRaw =
      typeof r.memberAddress === 'string'
        ? r.memberAddress
        : typeof r.address === 'string'
          ? r.address
          : ''
    const address = addressRaw.trim().toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(address)) continue
    members.push({
      address,
      name: typeof r.name === 'string' ? r.name : undefined,
      role: typeof r.role === 'string' ? r.role : undefined,
      profilePictureUrl:
        typeof r.profilePictureUrl === 'string'
          ? r.profilePictureUrl
          : typeof r.profile_picture_url === 'string'
            ? r.profile_picture_url
            : undefined,
      joinedAt: typeof r.joinedAt === 'string' ? r.joinedAt : undefined
    })
  }
  if (!total) total = members.length
  return { members, total }
}

/** @deprecated use fetchCommunityMembers */
export async function fetchCommunityMembersSigned(
  identity: AuthIdentity,
  communityId: string,
  params: { limit?: number; offset?: number; onlyOnline?: boolean } = {}
): Promise<{ members: CommunityMemberRow[]; total: number }> {
  return fetchCommunityMembers(communityId, { identity, ...params })
}

export async function fetchCommunityPosts(
  communityId: string,
  opts: { identity?: AuthIdentity | null; limit?: number; offset?: number } = {}
): Promise<{ posts: CommunityPost[]; total: number }> {
  const id = communityId.trim()
  if (!id) return { posts: [], total: 0 }
  const url = new URL(
    `${getSocialApiBaseUrl()}/v1/communities/${encodeURIComponent(id)}/posts`
  )
  url.searchParams.set('limit', String(opts.limit ?? 30))
  url.searchParams.set('offset', String(opts.offset ?? 0))

  const res = opts.identity
    ? await signedFetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        identity: opts.identity
      })
    : await fetch(url.toString(), { headers: { Accept: 'application/json' } })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
    throw new Error(body.message ?? body.error ?? `Social API posts ${res.status}`)
  }

  const raw = (await res.json()) as { data?: { posts?: unknown; total?: unknown } }
  const list = Array.isArray(raw.data?.posts) ? raw.data!.posts! : []
  const total = typeof raw.data?.total === 'number' ? raw.data.total : list.length
  const posts: CommunityPost[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const r = entry as Record<string, unknown>
    const postId = typeof r.id === 'string' ? r.id : ''
    const content = typeof r.content === 'string' ? r.content : ''
    const authorAddress =
      typeof r.authorAddress === 'string' ? r.authorAddress.trim().toLowerCase() : ''
    if (!postId || !content) continue
    posts.push({
      id: postId,
      communityId: typeof r.communityId === 'string' ? r.communityId : id,
      authorAddress,
      authorName: typeof r.authorName === 'string' ? r.authorName : authorAddress.slice(0, 8),
      authorProfilePictureUrl:
        typeof r.authorProfilePictureUrl === 'string' ? r.authorProfilePictureUrl : undefined,
      authorHasClaimedName: r.authorHasClaimedName === true,
      content,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
      likesCount: typeof r.likesCount === 'number' ? r.likesCount : 0,
      isLikedByUser: r.isLikedByUser === true
    })
  }
  return { posts, total }
}

export async function createCommunityPostSigned(
  identity: AuthIdentity,
  communityId: string,
  content: string
): Promise<{ ok: true; post: CommunityPost } | { ok: false; error: string }> {
  const id = communityId.trim()
  const text = content.trim().slice(0, 1000)
  if (!id || !text) return { ok: false, error: 'empty_post' }
  const url = `${getSocialApiBaseUrl()}/v1/communities/${encodeURIComponent(id)}/posts`
  try {
    const res = await signedFetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
      identity
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
      return { ok: false, error: body.message ?? body.error ?? `post_failed_${res.status}` }
    }
    const raw = (await res.json()) as { data?: Record<string, unknown> }
    const r = raw.data ?? {}
    const post: CommunityPost = {
      id: typeof r.id === 'string' ? r.id : `local-${Date.now()}`,
      communityId: id,
      authorAddress: typeof r.authorAddress === 'string' ? r.authorAddress : '',
      authorName: typeof r.authorName === 'string' ? r.authorName : 'You',
      authorProfilePictureUrl:
        typeof r.authorProfilePictureUrl === 'string' ? r.authorProfilePictureUrl : undefined,
      content: text,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
      likesCount: typeof r.likesCount === 'number' ? r.likesCount : 0,
      isLikedByUser: false
    }
    return { ok: true, post }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function setCommunityPostLikedSigned(
  identity: AuthIdentity,
  communityId: string,
  postId: string,
  liked: boolean
): Promise<boolean> {
  const url = `${getSocialApiBaseUrl()}/v1/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postId)}/like`
  try {
    const res = await signedFetch(url, {
      method: liked ? 'POST' : 'DELETE',
      headers: { Accept: 'application/json' },
      identity
    })
    return res.ok || res.status === 201 || res.status === 204
  } catch {
    return false
  }
}

export async function fetchCommunityPlaces(
  communityId: string,
  opts: { identity?: AuthIdentity | null; limit?: number } = {}
): Promise<{ placeIds: string[]; total: number }> {
  const id = communityId.trim()
  if (!id) return { placeIds: [], total: 0 }
  const url = new URL(
    `${getSocialApiBaseUrl()}/v1/communities/${encodeURIComponent(id)}/places`
  )
  url.searchParams.set('limit', String(opts.limit ?? 50))
  url.searchParams.set('offset', '0')

  const res = opts.identity
    ? await signedFetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        identity: opts.identity
      })
    : await fetch(url.toString(), { headers: { Accept: 'application/json' } })

  if (!res.ok) return { placeIds: [], total: 0 }
  const raw = (await res.json()) as { data?: { results?: unknown; total?: unknown } }
  const results = Array.isArray(raw.data?.results) ? raw.data!.results! : []
  const placeIds: string[] = []
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue
    const pid = (entry as { id?: unknown }).id
    if (typeof pid === 'string' && pid.trim()) placeIds.push(pid.trim())
  }
  const total = typeof raw.data?.total === 'number' ? raw.data.total : placeIds.length
  return { placeIds, total }
}
