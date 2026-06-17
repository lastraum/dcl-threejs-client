import {
  BODY_SHAPE_URN,
  DEFAULT_WEARABLE_CATEGORIES,
  defaultWearableUrn,
  normalizeUrn
} from './constants'
import { fetchWearablesByUrns, hasRepresentation } from './peerApi'
import { preloadBundledWearableManifests } from './bundledWearables'
import { catalystPointerForWearableUrn } from './wearablePointers'
import {
  profileWearableFingerprint,
  readCachedAvatar,
  writeCachedAvatar
} from './profileStorage'
import { getSlots } from './slots'
import type { AvatarComposeConfig, AvatarProfile, BodyShape, WearableDefinition } from './types'

export async function buildComposeConfig(
  profile: AvatarProfile,
  address?: string,
  contentUrl?: string
): Promise<AvatarComposeConfig> {
  const catalystUrl = contentUrl?.replace(/\/$/, '') || undefined
  const cacheKey = address?.toLowerCase() ?? profile.address?.toLowerCase()
  const fingerprint = profileWearableFingerprint(profile)

  if (cacheKey) {
    const cached = readCachedAvatar(cacheKey, fingerprint)
    if (cached) {
      const wearables = cached.wearables.filter((w) => hasRepresentation(w, profile.bodyShape))
      const slots = getSlots({
        bodyShape: profile.bodyShape,
        wearables,
        forceRender: profile.forceRender
      })
      const slotted = Array.from(slots.values())
      if (getBodyShapeWearable(slotted, profile.bodyShape)) {
        return {
          bodyShape: profile.bodyShape,
          skin: profile.skin,
          hair: profile.hair,
          eyes: profile.eyes,
          wearables: slotted,
          forceRender: profile.forceRender
        }
      }
    }
  }

  const urns = profile.wearables.map(normalizeUrn)
  if (
    !urns.some(
      (u) => normalizeUrn(u).includes('basemale') || normalizeUrn(u).includes('basefemale')
    )
  ) {
    urns.unshift(BODY_SHAPE_URN[profile.bodyShape])
  }

  const pointers = urns.map((urn) => catalystPointerForWearableUrn(urn))
  await preloadBundledWearableManifests(pointers)

  let wearables = await fetchWearablesByUrns(urns, catalystUrl)
  wearables = wearables.filter((w) => hasRepresentation(w, profile.bodyShape))

  if (!profile.fromWallet) {
    const missing: string[] = []
    for (const category of DEFAULT_WEARABLE_CATEGORIES) {
      if (wearables.some((w) => w.data.category === category)) continue
      const urn = defaultWearableUrn(category, profile.bodyShape)
      if (urn) missing.push(urn)
    }
    if (missing.length) {
      wearables.push(...(await fetchWearablesByUrns(missing, catalystUrl)))
    }
  } else if (wearables.length < urns.length) {
    console.warn(
      `Loaded ${wearables.length}/${urns.length} profile wearables — some URNs may have failed Catalyst lookup`
    )
  }

  const slots = getSlots({
    bodyShape: profile.bodyShape,
    wearables,
    forceRender: profile.forceRender
  })

  const config: AvatarComposeConfig = {
    bodyShape: profile.bodyShape,
    skin: profile.skin,
    hair: profile.hair,
    eyes: profile.eyes,
    wearables: Array.from(slots.values()),
    forceRender: profile.forceRender
  }

  if (cacheKey && profile.fromWallet) {
    writeCachedAvatar(cacheKey, {
      fingerprint,
      profile,
      wearables,
      cachedAt: Date.now()
    })
  }

  return config
}

export function getBodyShapeWearable(
  wearables: WearableDefinition[],
  bodyShape: BodyShape
): WearableDefinition | undefined {
  return wearables.find((w) => w.data.category === 'body_shape' && hasRepresentation(w, bodyShape))
}
