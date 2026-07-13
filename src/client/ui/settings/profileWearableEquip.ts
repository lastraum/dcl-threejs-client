import { assetUrnFromCompleteUrn, normalizeUrn } from '../../../avatar/constants'
import type { AvatarProfile, WearableCategory } from '../../../avatar/types'
import type { BackpackWearableItem } from './backpackWearables'

export function isWearableEquipped(profile: AvatarProfile, urn: string): boolean {
  const asset = assetUrnFromCompleteUrn(urn)
  return profile.wearables.some((u) => assetUrnFromCompleteUrn(u) === asset)
}

/** Replace the profile slot for `item.category` and equip the new URN (local session only). */
export function equipWearableOnProfile(
  profile: AvatarProfile,
  item: BackpackWearableItem,
  equippedByCategory: Map<WearableCategory, BackpackWearableItem>
): string[] {
  if (item.category === 'unknown') return [...profile.wearables]

  const slotItem = equippedByCategory.get(item.category)
  const slotAsset = slotItem ? assetUrnFromCompleteUrn(slotItem.urn) : null
  const equipUrn = normalizeUrn(item.urn)
  const asset = assetUrnFromCompleteUrn(equipUrn)

  // Drop the previous slot URN when known. Also drop any other copy of the same asset.
  const wearables = profile.wearables.filter((urn) => {
    const u = assetUrnFromCompleteUrn(urn)
    if (u === asset) return false
    if (slotAsset && u === slotAsset) return false
    return true
  })

  // Prefer inventory item URN as returned (should include tokenId from individualData).
  // Do NOT invent `:0` — Catalyst ownership checks fail on fake tokens.
  wearables.push(equipUrn)
  return wearables
}

export function unequipWearableFromProfile(profile: AvatarProfile, urn: string): string[] {
  const asset = assetUrnFromCompleteUrn(urn)
  return profile.wearables.filter((u) => assetUrnFromCompleteUrn(u) !== asset)
}