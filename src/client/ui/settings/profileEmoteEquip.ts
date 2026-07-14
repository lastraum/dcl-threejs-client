import { assetUrnFromCompleteUrn, normalizeUrn } from '../../../avatar/constants'
import { baseEmoteSlugFromRef, baseEmoteUrn } from '../../../avatar/profileEmotes'
import type { AvatarProfile, ProfileEmoteSlot } from '../../../avatar/types'

function emoteAssetKey(ref: string): string {
  const urn = ref.startsWith('urn:') ? normalizeUrn(ref) : baseEmoteUrn(ref)
  return assetUrnFromCompleteUrn(urn).toLowerCase()
}

function sameEmote(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a.toLowerCase() === b.toLowerCase()) return true
  const sa = baseEmoteSlugFromRef(a)
  const sb = baseEmoteSlugFromRef(b)
  if (sa && sb && sa === sb) return true
  return emoteAssetKey(a) === emoteAssetKey(b)
}

/** True if this emote is assigned to any profile wheel slot (not default fill). */
export function isEmoteEquippedOnProfile(profile: AvatarProfile, emoteRef: string): boolean {
  return (profile.emotes ?? []).some((e) => sameEmote(e.urn, emoteRef))
}

/** Slot indices (0–9) currently holding this emote. */
export function profileSlotsForEmote(profile: AvatarProfile, emoteRef: string): number[] {
  return (profile.emotes ?? [])
    .filter((e) => sameEmote(e.urn, emoteRef))
    .map((e) => e.slot)
    .filter((s) => s >= 0 && s < 10)
}

/**
 * Assign emote to a wheel slot (0–9). Removes the same emote from other slots
 * and replaces whatever was in the target slot.
 */
export function equipEmoteOnProfile(
  profile: AvatarProfile,
  emoteRef: string,
  slotIndex: number
): ProfileEmoteSlot[] {
  if (slotIndex < 0 || slotIndex > 9) return [...(profile.emotes ?? [])]
  const equipUrn = emoteRef.startsWith('urn:') ? normalizeUrn(emoteRef) : baseEmoteUrn(emoteRef)
  const next = (profile.emotes ?? []).filter(
    (e) => e.slot !== slotIndex && !sameEmote(e.urn, equipUrn)
  )
  next.push({ slot: slotIndex, urn: equipUrn })
  return next.sort((a, b) => a.slot - b.slot)
}

/** Remove this emote from all wheel slots (or clear a specific slot if provided). */
export function unequipEmoteFromProfile(
  profile: AvatarProfile,
  emoteRef: string,
  slotIndex?: number
): ProfileEmoteSlot[] {
  return (profile.emotes ?? []).filter((e) => {
    if (slotIndex != null && e.slot === slotIndex) return false
    if (slotIndex == null && sameEmote(e.urn, emoteRef)) return false
    return true
  })
}

/** Clear a single wheel slot regardless of what is there. */
export function clearEmoteSlotOnProfile(
  profile: AvatarProfile,
  slotIndex: number
): ProfileEmoteSlot[] {
  return (profile.emotes ?? []).filter((e) => e.slot !== slotIndex)
}
