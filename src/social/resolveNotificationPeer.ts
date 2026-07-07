import { identityFromAvatarProfile, shortenAddress } from '../avatar/displayName'
import { fetchProfileCached, fetchProfileFaceUrl } from '../avatar/peerApi'
import type { SocialService } from './SocialService'

export type ResolvedNotificationPeer = {
  address: string
  displayName: string
  faceUrl: string | null
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase()
}

function looksLikeAddressLabel(label: string, address: string): boolean {
  const name = label.trim()
  if (!name) return true
  const key = normalizeAddress(address)
  const lower = name.toLowerCase()
  if (lower === key) return true
  if (lower === shortenAddress(key)) return true
  if (/^0x[a-f0-9]{4,}…[a-f0-9]{4}$/i.test(name)) return true
  return false
}

/** Resolve wallet → display name via social peer cache, then Catalyst profile. */
export async function resolveNotificationPeer(
  address: string,
  social: SocialService | null
): Promise<ResolvedNotificationPeer> {
  const key = normalizeAddress(address)

  if (social) {
    await social.ensurePeerProfile(key)
    const cached = social.getPeerDisplay(key)
    if (!looksLikeAddressLabel(cached.displayName, key)) {
      return { address: key, displayName: cached.displayName, faceUrl: cached.faceUrl }
    }
  }

  const [profile, faceUrl] = await Promise.all([
    fetchProfileCached(key),
    fetchProfileFaceUrl(key)
  ])

  const displayName = profile
    ? identityFromAvatarProfile(profile, key).displayName
    : social?.getPeerDisplay(key).displayName ?? shortenAddress(key)

  const cachedFace = social?.getPeerDisplay(key).faceUrl ?? null
  return {
    address: key,
    displayName,
    faceUrl: faceUrl ?? cachedFace
  }
}