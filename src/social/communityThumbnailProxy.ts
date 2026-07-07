/**
 * Browser-only passthrough for companion `communityThumbnailProxy.ts`.
 * Three.js client loads DCL CDN / Social API image URLs directly (no companion API server).
 */

const COMMUNITY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isAllowedDirectThumbnailUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  if (host === 'decentraland.org' || host.endsWith('.decentraland.org')) return true
  if (host.endsWith('.decentraland.zone')) return true
  const catalyst = import.meta.env.VITE_CATALYST_CONTENT_URL
  if (typeof catalyst === 'string' && catalyst.trim()) {
    try {
      if (host === new URL(catalyst.trim()).hostname.toLowerCase()) return true
    } catch {
      /* ignore */
    }
  } else if (host === 'peer.decentraland.org') {
    return true
  }
  return false
}

function normalizeThumbnailUrl(url: string): string {
  let raw = url.trim()
  if (raw.startsWith('//')) raw = `https:${raw}`
  return raw
}

/** Social CDN `raw-thumbnail.png` by community UUID (companion proxies this via `/api/community-thumbnail-by-id`). */
export function proxyCommunityThumbnailByCommunityId(id: string | undefined): string | undefined {
  if (!id?.trim()) return undefined
  const t = id.trim().toLowerCase()
  if (!COMMUNITY_UUID_RE.test(t)) return undefined
  return `https://assets-cdn.decentraland.org/social/communities/${t}/raw-thumbnail.png`
}

/** Returns the URL when allowed; otherwise passes through unchanged (data URLs, third-party hosts). */
export function proxyCommunityThumbnailUrl(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined
  const raw = normalizeThumbnailUrl(url)
  if (raw.startsWith('data:') || raw.startsWith('blob:')) return raw
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return raw
  }
  if (!isAllowedDirectThumbnailUrl(parsed)) return raw
  return raw
}

/** Proxies a thumbnail URL when present, otherwise Social CDN `raw-thumbnail.png` by community id. */
export function proxyCommunityThumbnailOrById(
  thumbnailUrl: string | undefined,
  communityId: string | undefined
): string | undefined {
  return proxyCommunityThumbnailUrl(thumbnailUrl) ?? proxyCommunityThumbnailByCommunityId(communityId)
}