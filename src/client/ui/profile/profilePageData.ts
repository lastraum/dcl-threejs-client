import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { identityFromAvatarProfile, shortenAddress } from '../../../avatar/displayName'
import {
  fetchProfileCached,
  fetchProfileDescriptionCached,
  fetchProfileFaceUrl
} from '../../../avatar/peerApi'
import type { AvatarProfile } from '../../../avatar/types'
import { fetchUserBadges, type UserBadge } from '../../../social/badgesApi'
import {
  fetchMemberCommunitiesByAddressPublic,
  fetchMemberCommunitiesSigned
} from '../../../social/socialApi'
import type { CommunityListRow } from '../../../social/types'
import { fetchEmoteDisplayCards, type EmoteDisplayCard } from './emoteCards'
import { fetchWearableDisplayCards, type WearableDisplayCard } from './wearableThumb'

export type ProfilePageData = {
  address: string
  profile: AvatarProfile | null
  displayName: string
  nameColor: string
  claimed: boolean
  faceUrl: string | null
  description: string | null
  badges: UserBadge[]
  wearables: WearableDisplayCard[]
  emotes: EmoteDisplayCard[]
  communities: CommunityListRow[]
  profileUrl: string
}

const DEFAULT_CATALYST = 'https://peer.decentraland.org'

export type LoadProfilePageDataOptions = {
  address: string
  peerUrl?: string
  identity?: AuthIdentity | null
}

export async function loadProfilePageData(
  addressOrOptions: string | LoadProfilePageDataOptions,
  peerUrl = DEFAULT_CATALYST
): Promise<ProfilePageData> {
  const opts: LoadProfilePageDataOptions =
    typeof addressOrOptions === 'string'
      ? { address: addressOrOptions, peerUrl }
      : { peerUrl: DEFAULT_CATALYST, ...addressOrOptions }

  const normalized = opts.address.trim().toLowerCase()
  const base = (opts.peerUrl ?? DEFAULT_CATALYST).replace(/\/$/, '') || DEFAULT_CATALYST
  const lambdasUrl = base.endsWith('/lambdas') ? base : `${base}/lambdas`

  const [profile, faceUrl, description, badges, communitiesResult] = await Promise.all([
    fetchProfileCached(normalized, lambdasUrl),
    fetchProfileFaceUrl(normalized, lambdasUrl),
    fetchProfileDescriptionCached(normalized, lambdasUrl),
    fetchUserBadges(normalized),
    loadProfileCommunities(normalized, opts.identity ?? null)
  ])

  const displayName = profile
    ? identityFromAvatarProfile(profile, normalized).displayName
    : `${normalized.slice(0, 6)}…${normalized.slice(-4)}`
  const [wearables, emotes] = await Promise.all([
    profile
      ? fetchWearableDisplayCards(profile.wearables, base)
      : Promise.resolve<WearableDisplayCard[]>([]),
    profile ? fetchEmoteDisplayCards(profile.emotes, base) : Promise.resolve<EmoteDisplayCard[]>([])
  ])

  return {
    address: normalized,
    profile,
    displayName,
    nameColor: profile?.nameColor ?? '#ffffff',
    claimed: profile?.hasClaimedName ?? false,
    faceUrl,
    description,
    badges,
    wearables,
    emotes,
    communities: communitiesResult.communities,
    profileUrl: `https://decentraland.org/profile/accounts/${normalized}`
  }
}

async function loadProfileCommunities(
  address: string,
  identity: AuthIdentity | null
): Promise<{ communities: CommunityListRow[] }> {
  try {
    if (identity) {
      const { communities } = await fetchMemberCommunitiesSigned(identity)
      return { communities }
    }
    const { communities } = await fetchMemberCommunitiesByAddressPublic(address)
    return { communities }
  } catch (err) {
    console.warn('[profile] communities load failed', err)
    return { communities: [] }
  }
}

export function profilePageWalletLabel(address: string): string {
  return shortenAddress(address)
}