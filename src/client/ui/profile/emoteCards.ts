import { assetUrnFromCompleteUrn } from '../../../avatar/constants'
import {
  baseEmoteSlugFromRef,
  catalystPointerForEmoteUrn,
  emoteLabel
} from '../../../avatar/profileEmotes'
import type { ProfileEmoteSlot } from '../../../avatar/types'
import {
  fetchCatalystItemMeta,
  guessWearableRarity,
  wearableThumbnailUrl,
  type WearableDisplayCard
} from './wearableThumb'

const DEFAULT_CATALYST = 'https://peer.decentraland.org'

export type EmoteDisplayCard = WearableDisplayCard & {
  /** Emote wheel slot (0-9) the profile assigns this emote to. */
  slot: number
}

/**
 * Equipped emote wheel → display cards with the same shape (and rarity source)
 * as wearable cards, so both grids render through `renderRarityCard`.
 * Free base emotes have no marketplace rarity — they show as `base`.
 */
export async function fetchEmoteDisplayCards(
  emotes: readonly ProfileEmoteSlot[],
  peerUrl = DEFAULT_CATALYST
): Promise<EmoteDisplayCard[]> {
  const base = peerUrl.replace(/\/$/, '')
  const slots = emotes
    .filter((entry) => entry?.urn?.trim())
    .map((entry) => ({ slot: entry.slot, urn: entry.urn.trim() }))
  if (!slots.length) return []

  const metaMap = await fetchCatalystItemMeta(
    slots.map((entry) => catalystPointerForEmoteUrn(entry.urn)),
    base
  )

  return slots.map(({ slot, urn }) => {
    const pointer = catalystPointerForEmoteUrn(urn)
    const meta = metaMap.get(pointer.toLowerCase())
    const isBase = !!baseEmoteSlugFromRef(urn)
    return {
      urn,
      slot,
      name: emoteLabel(urn, meta?.name),
      rarity: meta?.rarity || (isBase ? 'base' : guessWearableRarity(assetUrnFromCompleteUrn(urn))),
      thumbnailUrl: meta?.thumbnailUrl || wearableThumbnailUrl(pointer, base)
    }
  })
}
