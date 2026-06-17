import type { CommunityListRow } from './types'

function coerceThumbnailRecord(source: unknown): Record<string, string> | undefined {
  if (source === null || source === undefined) return undefined
  if (typeof source === 'string' && source.trim()) return { raw: source.trim() }
  if (typeof source !== 'object' || Array.isArray(source)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim()
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const u = (v as { url?: unknown }).url
      if (typeof u === 'string' && u.trim()) out[k] = u.trim()
    }
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
    ownerAddress:
      typeof source.ownerAddress === 'string'
        ? source.ownerAddress
        : typeof source.owner_address === 'string'
          ? source.owner_address
          : undefined,
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

export function pickCommunityThumbnailUrl(thumbnails?: Record<string, string>): string | undefined {
  if (!thumbnails) return undefined
  for (const key of ['256', '128', 'raw', 'communityImage', 'profileImage']) {
    const hit = thumbnails[key]
    if (typeof hit === 'string' && hit.trim()) return hit.trim()
  }
  for (const v of Object.values(thumbnails)) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}
