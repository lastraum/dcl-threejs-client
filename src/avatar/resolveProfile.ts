import {
  assetUrnFromCompleteUrn,
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

/** True when every profile wearable pointer resolved into a definition (avoids bald-cache hits). */
function wearablesCoverProfileUrns(
  wearables: WearableDefinition[],
  profileUrns: string[],
  bodyShape: BodyShape
): boolean {
  const have = new Set<string>()
  for (const w of wearables) {
    if (!hasRepresentation(w, bodyShape)) continue
    have.add(normalizeUrn(w.id))
    have.add(assetUrnFromCompleteUrn(w.id))
    have.add(normalizeUrn(catalystPointerForWearableUrn(w.id)))
  }
  for (const urn of profileUrns) {
    const pointer = normalizeUrn(catalystPointerForWearableUrn(urn))
    const asset = assetUrnFromCompleteUrn(pointer)
    if (!have.has(pointer) && !have.has(asset) && !have.has(normalizeUrn(urn))) {
      return false
    }
  }
  return true
}

/** Every default category resolved for this body shape — missing these render bald or blank-faced. */
function coversDefaultCategories(wearables: WearableDefinition[], bodyShape: BodyShape): boolean {
  return DEFAULT_WEARABLE_CATEGORIES.every((category) =>
    wearables.some((w) => w.data.category === category && hasRepresentation(w, bodyShape))
  )
}

export async function buildComposeConfig(
  profile: AvatarProfile,
  address?: string,
  contentUrl?: string
): Promise<AvatarComposeConfig> {
  const catalystUrl = contentUrl?.replace(/\/$/, '') || undefined
  const cacheKey = address?.toLowerCase() ?? profile.address?.toLowerCase()
  const fingerprint = profileWearableFingerprint(profile)

  const profileUrns = profile.wearables.map(normalizeUrn)
  if (
    !profileUrns.some(
      (u) => normalizeUrn(u).includes('basemale') || normalizeUrn(u).includes('basefemale')
    )
  ) {
    profileUrns.unshift(BODY_SHAPE_URN[profile.bodyShape])
  }

  if (cacheKey) {
    const cached = readCachedAvatar(cacheKey, fingerprint)
    if (cached) {
      const wearables = cached.wearables.filter((w) => hasRepresentation(w, profile.bodyShape))
      if (
        wearablesCoverProfileUrns(wearables, profileUrns, profile.bodyShape) &&
        coversDefaultCategories(wearables, profile.bodyShape) &&
        getBodyShapeWearable(wearables, profile.bodyShape)
      ) {
        const slots = getSlots({
          bodyShape: profile.bodyShape,
          wearables,
          forceRender: profile.forceRender
        })
        return {
          bodyShape: profile.bodyShape,
          skin: profile.skin,
          hair: profile.hair,
          eyes: profile.eyes,
          brows: profile.browsColor,
          facialHair: profile.facialHairColor,
          wearables: Array.from(slots.values()),
          forceRender: profile.forceRender
        }
      }
    }
  }

  const pointers = profileUrns.map((urn) => catalystPointerForWearableUrn(urn))
  await preloadBundledWearableManifests(pointers)

  let wearables = await fetchWearablesByUrns(profileUrns, catalystUrl)
  wearables = wearables.filter((w) => hasRepresentation(w, profile.bodyShape))

  // Profiles omit default head/body items (only colors are stored) — clients are expected
  // to backfill defaults for missing categories, like the Unity Explorer. Wallet profiles
  // relying on defaults were rendering bald / blank-faced when this only ran for guests.
  const missing: string[] = []
  for (const category of DEFAULT_WEARABLE_CATEGORIES) {
    if (wearables.some((w) => w.data.category === category && hasRepresentation(w, profile.bodyShape)))
      continue
    const urn = defaultWearableUrn(category, profile.bodyShape)
    if (urn) missing.push(urn)
  }
  if (missing.length) {
    wearables.push(...(await fetchWearablesByUrns(missing, catalystUrl)))
    wearables = wearables.filter((w) => hasRepresentation(w, profile.bodyShape))
  }

  if (profile.fromWallet && !wearablesCoverProfileUrns(wearables, profileUrns, profile.bodyShape)) {
    console.warn(
      `Loaded ${wearables.length}/${profileUrns.length} profile wearables — some URNs may have failed Catalyst lookup`
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
    brows: profile.browsColor,
    facialHair: profile.facialHairColor,
    wearables: Array.from(slots.values()),
    forceRender: profile.forceRender
  }

  // Only persist complete resolves — partial cache was leaving avatars bald (e.g. missing base hair).
  if (
    cacheKey &&
    profile.fromWallet &&
    wearablesCoverProfileUrns(wearables, profileUrns, profile.bodyShape) &&
    coversDefaultCategories(wearables, profile.bodyShape)
  ) {
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
