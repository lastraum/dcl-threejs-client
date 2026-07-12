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
  const wearables = profile.wearables.filter((urn) => {
    if (!slotItem) return true
    return assetUrnFromCompleteUrn(urn) !== assetUrnFromCompleteUrn(slotItem.urn)
  })

  // Prefer inventory item URN as returned (should include tokenId from individualData).
  // Do NOT invent `:0` — Catalyst ownership checks fail on fake tokens.
  const equipUrn = normalizeUrn(item.urn)
  const asset = assetUrnFromCompleteUrn(equipUrn)
  if (!wearables.some((u) => assetUrnFromCompleteUrn(u) === asset)) {
    wearables.push(equipUrn)
  }
  return wearables
}

export function unequipWearableFromProfile(profile: AvatarProfile, urn: string): string[] {
  const asset = assetUrnFromCompleteUrn(urn)
  return profile.wearables.filter((u) => assetUrnFromCompleteUrn(u) !== asset)
}