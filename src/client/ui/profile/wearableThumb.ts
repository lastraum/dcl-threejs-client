import { assetUrnFromCompleteUrn } from '../../../avatar/constants'

/** Catalyst collections thumbnail URL — same source as BackpackView. */
export function wearableThumbnailUrl(urn: string, peerUrl = 'https://peer.decentraland.org'): string {
  const base = peerUrl.replace(/\/$/, '')
  const assetUrn = assetUrnFromCompleteUrn(urn)
  return `${base}/lambdas/collections/contents/${encodeURIComponent(assetUrn)}/thumbnail`
}

export function wearableShortLabel(urn: string): string {
  const tail = urn.split(':').pop() ?? urn
  return tail.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function guessWearableRarity(urn: string): string {
  const low = urn.toLowerCase()
  if (low.includes('legendary')) return 'legendary'
  if (low.includes('epic')) return 'epic'
  if (low.includes('rare')) return 'rare'
  if (low.includes('uncommon')) return 'uncommon'
  if (low.includes('base') || low.includes('default')) return 'base'
  return 'common'
}

export function filterEquippedWearables(wearables: string[]): string[] {
  return wearables.filter((u) => !u.includes('basemale') && !u.includes('basefemale'))
}

export type WearableDisplayCard = {
  urn: string
  name: string
  rarity: string
  thumbnailUrl: string
}

export const WEARABLE_RARITY_COLORS: Record<string, string> = {
  legendary: '#ff8723',
  epic: '#a335ee',
  rare: '#00b4d8',
  uncommon: '#57e389',
  common: '#9aa3b2',
  base: '#9aa3b2',
  unique: '#ffd700',
  exotic: '#ff2d6f',
  mythic: '#ff6ad5'
}

/** Solid cell fills — matches DCL rarity swatches (no gradients). */
export const WEARABLE_RARITY_BACKGROUNDS: Record<string, string> = {
  legendary: '#ff8723',
  epic: '#a335ee',
  rare: '#00b4d8',
  uncommon: '#57e389',
  common: '#6b7280',
  base: '#6b7280',
  unique: '#ffd700',
  exotic: '#ff2d6f',
  mythic: '#ff6ad5'
}

export function wearableRarityLabel(rarity: string): string {
  return rarity.trim().toUpperCase() || 'COMMON'
}

export function wearableRarityBackground(rarity: string): string {
  const key = rarity.trim().toLowerCase() || 'common'
  return WEARABLE_RARITY_BACKGROUNDS[key] ?? WEARABLE_RARITY_BACKGROUNDS.common!
}

export async function fetchWearableDisplayCards(
  urns: string[],
  peerUrl = 'https://peer.decentraland.org'
): Promise<WearableDisplayCard[]> {
  const base = peerUrl.replace(/\/$/, '')
  const equipped = filterEquippedWearables(urns).slice(0, 12)

  return Promise.all(
    equipped.map(async (urn): Promise<WearableDisplayCard> => {
      const assetUrn = assetUrnFromCompleteUrn(urn)
      const fallback: WearableDisplayCard = {
        urn,
        name: wearableShortLabel(assetUrn),
        rarity: guessWearableRarity(assetUrn),
        thumbnailUrl: wearableThumbnailUrl(assetUrn, base)
      }
      try {
        const url = `${base}/lambdas/collections/wearables?wearableId=${encodeURIComponent(assetUrn)}`
        const res = await fetch(url)
        if (!res.ok) return fallback
        const raw = (await res.json()) as {
          wearables?: Array<{ name?: string; rarity?: string | null; thumbnail?: string }>
        }
        const hit = raw.wearables?.[0]
        if (!hit) return fallback
        const rarity = (hit.rarity?.trim().toLowerCase() || guessWearableRarity(urn)).toLowerCase()
        return {
          urn,
          name: hit.name?.trim() || fallback.name,
          rarity,
          thumbnailUrl: hit.thumbnail?.trim() || fallback.thumbnailUrl
        }
      } catch {
        return fallback
      }
    })
  )
}