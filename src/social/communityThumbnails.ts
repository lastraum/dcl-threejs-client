import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { resolveCommunityDisplayImageUrl } from './memberCommunities'
import { proxyCommunityThumbnailOrById } from './communityThumbnailProxy'
import { fetchCommunityByIdPublic, fetchCommunityByIdSigned } from './socialApi'

/** Card / chat / modal cover — API thumbnails first, then Social CDN by id. */
export function communityDisplayImageUrl(
  communityId: string,
  thumbnails?: Record<string, string> | null,
  voiceBundleImage?: string | null
): string | undefined {
  return proxyCommunityThumbnailOrById(
    resolveCommunityDisplayImageUrl(thumbnails ?? undefined, voiceBundleImage),
    communityId
  )
}

/** After CDN/list URL 404s, fetch `GET /v1/communities/{id}` and retry with detail thumbnails. */
export async function enrichCommunityThumbnailFromDetail(
  communityId: string,
  getAuthIdentity?: () => AuthIdentity | null
): Promise<string | undefined> {
  const id = communityId.trim()
  if (!id) return undefined
  const identity = getAuthIdentity?.() ?? null
  const detail = identity
    ? await fetchCommunityByIdSigned(identity, id)
    : await fetchCommunityByIdPublic(id)
  if (!detail) return undefined
  return communityDisplayImageUrl(detail.id, detail.thumbnails)
}