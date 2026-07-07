import type { CommunityListRow } from './types'

const COMMUNITY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function addThumbnailPair(out: Record<string, string>, key: string, val: unknown): void {
  if (typeof val === 'string' && val.trim()) {
    out[key] = val.trim()
    return
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const u = (val as { url?: unknown }).url
    if (typeof u === 'string' && u.trim()) out[key] = u.trim()
  }
}

function mergeThumbnailsFieldInto(out: Record<string, string>, th: unknown): void {
  if (th === null || th === undefined) return
  if (typeof th === 'string' && th.trim()) {
    out.raw = th.trim()
    return
  }
  if (Array.isArray(th)) {
    for (let i = 0; i < th.length; i++) {
      const item = th[i]
      if (typeof item === 'string' && item.trim()) {
        const u = item.trim()
        if (i === 0 && !out.raw) out.raw = u
        out[String(i)] = u
        continue
      }
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>
        const u = typeof rec.url === 'string' ? rec.url.trim() : ''
        if (!u) continue
        const key =
          (typeof rec.type === 'string' && rec.type.trim()) ||
          (typeof rec.size === 'string' && rec.size.trim()) ||
          (typeof rec.name === 'string' && rec.name.trim()) ||
          String(i)
        out[key] = u
        if (i === 0 && !out.raw) out.raw = u
      }
    }
    return
  }
  if (typeof th === 'object') {
    for (const [k, v] of Object.entries(th as Record<string, unknown>)) {
      addThumbnailPair(out, k, v)
    }
  }
}

/** Normalize Social API thumbnail shapes into a flat string map. */
export function coerceThumbnailRecord(source: unknown): Record<string, string> | undefined {
  if (source === null || source === undefined) return undefined
  if (typeof source === 'string' && source.trim()) {
    return { raw: source.trim() }
  }
  if (typeof source !== 'object' || Array.isArray(source)) return undefined
  const o = source as Record<string, unknown>
  const out: Record<string, string> = {}

  mergeThumbnailsFieldInto(out, o.thumbnails)
  for (const key of [
    'communityImage',
    'image',
    'imageUrl',
    'coverImage',
    'bannerImage',
    'banner',
    'thumbnail',
    'thumbnailUrl',
    'cover',
    'logo',
    'avatar',
    'profileImage',
    'profile_image',
    'cover_photo',
    'coverPhoto',
    'picture',
    'photo',
    'icon',
    'thumb',
    'image_url',
    'cover_image',
    'bannerUrl',
    'banner_url'
  ] as const) {
    if (key in o) addThumbnailPair(out, key, o[key])
  }
  return Object.keys(out).length ? out : undefined
}

function mapRowFromApi(item: unknown): CommunityListRow | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  const source = o.community && typeof o.community === 'object' ? (o.community as Record<string, unknown>) : o
  const id = typeof source.id === 'string' ? source.id : ''
  const name = typeof source.name === 'string' ? source.name : ''
  if (!id || !name.trim()) return null
  return {
    id,
    name: name.trim(),
    description: typeof source.description === 'string' ? source.description.trim() : undefined,
    ownerAddress:
      typeof source.ownerAddress === 'string'
        ? source.ownerAddress
        : typeof source.owner_address === 'string'
          ? source.owner_address
          : undefined,
    ownerName: typeof source.ownerName === 'string' ? source.ownerName.trim() : undefined,
    role: typeof o.role === 'string' ? o.role : typeof source.role === 'string' ? source.role : undefined,
    thumbnails: coerceThumbnailRecord(source),
    memberCount:
      typeof source.memberCount === 'number'
        ? source.memberCount
        : typeof source.membersCount === 'number'
          ? source.membersCount
          : undefined,
    isPrivate:
      source.privacy === 'private' || source.visibility === 'private' || source.isPrivate === true
        ? true
        : source.privacy === 'public' || source.visibility === 'public'
          ? false
          : undefined
  }
}

/** Parse Social API `GET /v1/communities?onlyMemberOf=true` JSON. */
export function parseCommunitiesListFromJson(raw: Record<string, unknown>): CommunityListRow[] {
  const data = raw.data
  let list: unknown[] = []
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>
    const r = d.results ?? d.communities ?? d.items
    if (Array.isArray(r)) list = r
  } else if (Array.isArray(raw.results)) {
    list = raw.results
  }
  const out: CommunityListRow[] = []
  for (const item of list) {
    const row = mapRowFromApi(item)
    if (row) out.push(row)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Picks a community image URL — never the owner's Catalyst face (`ownerFace`). */
export function pickCommunityThumbnailUrl(thumbnails?: Record<string, string> | null): string | undefined {
  if (!thumbnails || typeof thumbnails !== 'object') return undefined
  const order = [
    'raw',
    'default',
    'medium',
    'large',
    '256',
    '128',
    'communityImage',
    'small',
    'thumbnail',
    'image',
    'coverImage',
    'cover',
    'thumbnailUrl',
    'banner',
    'imageUrl',
    'logo',
    'avatar',
    'profileImage',
    'cover_photo',
    'coverPhoto',
    'picture',
    'photo',
    'bannerUrl'
  ] as const
  for (const k of order) {
    const u = thumbnails[k]
    if (typeof u === 'string' && u.trim()) return u.trim()
  }
  for (const [k, v] of Object.entries(thumbnails)) {
    if (k === 'ownerFace') continue
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/**
 * Community cover for cards, chat rail, drawer — same source order as companion Communities.
 * Prefer an explicit active-voice bundle image when passed; else list/detail thumbnails.
 */
export function resolveCommunityDisplayImageUrl(
  thumbnails: Record<string, string> | undefined,
  voiceBundleImage?: string | null
): string | undefined {
  const v = typeof voiceBundleImage === 'string' ? voiceBundleImage.trim() : ''
  if (v) return v
  return pickCommunityThumbnailUrl(thumbnails)
}

export function thumbnailsFromCommunityDetailBody(body: unknown): Record<string, string> | undefined {
  if (!body || typeof body !== 'object') return undefined
  const root = body as Record<string, unknown>
  const merged: Record<string, string> = {}

  const merge = (rec: Record<string, string> | undefined) => {
    if (!rec) return
    for (const [k, v] of Object.entries(rec)) {
      if (typeof v === 'string' && v.trim()) merged[k] = v.trim()
    }
  }

  merge(coerceThumbnailRecord(root))
  const data = root.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>
    merge(coerceThumbnailRecord(d))
    const comm = d.community
    if (comm && typeof comm === 'object' && !Array.isArray(comm)) {
      merge(coerceThumbnailRecord(comm))
    }
  }
  const comm = root.community
  if (comm && typeof comm === 'object' && !Array.isArray(comm)) {
    merge(coerceThumbnailRecord(comm))
  }
  return Object.keys(merged).length ? merged : undefined
}

/** Canonical Social CDN cover when the list API omits thumbnail fields. */
export function buildDclAssetsSocialCommunityRawThumbnailUrl(communityId: string): string | null {
  const id = communityId.trim().toLowerCase()
  if (!id || !COMMUNITY_UUID_RE.test(id)) return null
  return `https://assets-cdn.decentraland.org/social/communities/${id}/raw-thumbnail.png`
}

/** Canonical community icon URL from Social CDN (`raw-thumbnail.png`). */
export function communityThumbnailUrl(communityId: string): string | null {
  return buildDclAssetsSocialCommunityRawThumbnailUrl(communityId)
}

/** API thumbnail URL, else Social CDN `raw-thumbnail.png` by community id. */
export function communityThumbnailUrlOrCdnFallback(
  thumbnailUrl: string | null | undefined,
  communityId: string
): string | null {
  const fromApi = thumbnailUrl?.trim()
  if (fromApi) return fromApi
  return buildDclAssetsSocialCommunityRawThumbnailUrl(communityId)
}