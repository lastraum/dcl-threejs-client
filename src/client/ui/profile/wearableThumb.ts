import { assetUrnFromCompleteUrn } from '../../../avatar/constants'

/** Catalyst collections thumbnail URL — same source as BackpackView. */
const DEFAULT_CATALYST = 'https://peer.decentraland.org'
const MARKETPLACE_API = 'https://marketplace-api.decentraland.org'

/** `urn:decentraland:matic:collections-v2:0x…:itemId:tokenId…` */
export function parseCollectionsV2WearableUrn(
  urn: string
): { contract: string; itemId: string } | null {
  const match =
    /^urn:decentraland:(?:matic|ethereum):collections-v2:(0x[a-fA-F0-9]{40}):(\d+):/i.exec(urn.trim())
  if (!match) return null
  return { contract: match[1].toLowerCase(), itemId: match[2] }
}

/** Catalyst content hash, IPFS id, or absolute URL → browser-loadable image URL. */
import { rewriteCatalystUrl } from '../../../network/catalyst/rewriteCatalystUrl'

export function resolveContentImageUrl(
  raw: string | null | undefined,
  peerUrl = DEFAULT_CATALYST
): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return rewriteCatalystUrl(value, peerUrl) ?? value
  if (value.startsWith('ipfs://')) {
    const hash = value.slice('ipfs://'.length).replace(/^ipfs\//, '')
    return `${peerUrl.replace(/\/$/, '')}/content/contents/${hash}`
  }
  if (/^(bafy|bafk|Qm)/i.test(value)) {
    return `${peerUrl.replace(/\/$/, '')}/content/contents/${value}`
  }
  return null
}

export function wearableThumbnailUrl(urn: string, peerUrl = DEFAULT_CATALYST): string {
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

/** Body shape URNs only (legacy filter for general equipped lists). */
export function filterEquippedWearables(wearables: string[]): string[] {
  return wearables.filter((u) => {
    const low = u.toLowerCase()
    return !low.includes('basemale') && !low.includes('basefemale')
  })
}

/**
 * True for free default wardrobe: body shape + off-chain base-avatars
 * (hair, eyes, default clothes, etc.). Photo review hides these.
 */
export function isDefaultBaseWearableUrn(urn: string): boolean {
  const u = urn.trim().toLowerCase()
  if (!u) return true
  if (u.includes('basemale') || u.includes('basefemale')) return true
  if (u.includes('off-chain:base-avatars') || u.includes(':base-avatars:')) return true
  if (u.startsWith('dcl://base-avatars/')) return true
  return false
}

/** Collection / NFT wearables only — no default base avatar pieces. */
export function filterNonDefaultWearables(wearables: string[]): string[] {
  return wearables.filter((u) => !isDefaultBaseWearableUrn(u))
}

export type WearableDisplayCard = {
  urn: string
  name: string
  rarity: string
  thumbnailUrl: string
}

export const WEARABLE_RARITY_COLORS: Record<string, string> = {
  legendary: '#A14BF3',
  epic: '#438FFF',
  rare: '#34CE76',
  uncommon: '#FF8362',
  common: '#73D3D3',
  base: '#73D3D3',
  unique: '#FEA217',
  // Announcement-era red was retired — marketplace/schemas settled on lime green.
  exotic: '#CAFF73',
  mythic: '#FF4BED'
}

/** Solid cell fills — matches DCL rarity swatches (no gradients). */
export const WEARABLE_RARITY_BACKGROUNDS: Record<string, string> = {
  legendary: '#A14BF3',
  epic: '#438FFF',
  rare: '#34CE76',
  uncommon: '#FF8362',
  common: '#73D3D3',
  base: '#73D3D3',
  unique: '#FEA217',
  exotic: '#CAFF73',
  mythic: '#FF4BED'
}

/** Rarest-first ordering by DCL max supply (unique 1 → common 100k; free base items last). */
export const WEARABLE_RARITY_RANK: Record<string, number> = {
  unique: 0,
  mythic: 1,
  exotic: 2,
  legendary: 3,
  epic: 4,
  rare: 5,
  uncommon: 6,
  common: 7,
  base: 8
}

/** Sorted copy, rarest first; ties fall back to name A–Z. Unknown rarities sort last. */
export function sortWearablesByRarity<T extends { name: string; rarity: string }>(
  items: readonly T[]
): T[] {
  return [...items].sort((a, b) => {
    const ra = WEARABLE_RARITY_RANK[a.rarity.trim().toLowerCase()] ?? 99
    const rb = WEARABLE_RARITY_RANK[b.rarity.trim().toLowerCase()] ?? 99
    if (ra !== rb) return ra - rb
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/**
 * Sorted copy grouped alphabetically by collection or creator name; items still
 * missing that metadata (annotation pending or failed) sort last. Ties fall back
 * to item name A–Z.
 */
export function sortWearablesByGroup<T extends { name: string }>(
  items: readonly T[],
  key: (item: T) => string | undefined
): T[] {
  return [...items].sort((a, b) => {
    const ga = key(a)
    const gb = key(b)
    if (ga !== gb) {
      if (!ga) return 1
      if (!gb) return -1
      const d = ga.localeCompare(gb, undefined, { sensitivity: 'base' })
      if (d !== 0) return d
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

export function wearableRarityLabel(rarity: string): string {
  return rarity.trim().toUpperCase() || 'COMMON'
}

export function wearableRarityBackground(rarity: string): string {
  const key = rarity.trim().toLowerCase() || 'common'
  return WEARABLE_RARITY_BACKGROUNDS[key] ?? WEARABLE_RARITY_BACKGROUNDS.common!
}

type WearableMeta = {
  name: string
  rarity: string
  thumbnailUrl: string
}

async function fetchMarketplaceWearableMeta(
  contract: string,
  itemId: string,
  peerUrl: string
): Promise<WearableMeta | null> {
  const url = `${MARKETPLACE_API}/v1/items?contractAddress=${encodeURIComponent(
    contract
  )}&itemId=${encodeURIComponent(itemId)}`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const raw = (await res.json()) as {
      data?: Array<{ name?: string; rarity?: string; thumbnail?: string; data?: { wearable?: { rarity?: string } } }>
    }
    const hit = raw.data?.[0]
    if (!hit) return null
    const rarity =
      hit.rarity?.trim().toLowerCase() ||
      hit.data?.wearable?.rarity?.trim().toLowerCase() ||
      'common'
    const thumbnailUrl =
      resolveContentImageUrl(hit.thumbnail, peerUrl) ?? wearableThumbnailUrl(
        `urn:decentraland:matic:collections-v2:${contract}:${itemId}`,
        peerUrl
      )
    return {
      name: hit.name?.trim() || wearableShortLabel(contract),
      rarity,
      thumbnailUrl
    }
  } catch {
    return null
  }
}

async function fetchCatalystWearableMeta(urn: string, peerUrl: string): Promise<WearableMeta | null> {
  const base = peerUrl.replace(/\/$/, '')
  const assetUrn = assetUrnFromCompleteUrn(urn)
  try {
    const url = `${base}/lambdas/collections/wearables?wearableId=${encodeURIComponent(assetUrn)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const raw = (await res.json()) as {
      wearables?: Array<{ name?: string; rarity?: string | null; thumbnail?: string; i18n?: Array<{ code?: string; text?: string }> }>
    }
    const hit = raw.wearables?.[0]
    if (!hit) return null
    const enName = hit.i18n?.find((row) => row.code === 'en')?.text?.trim()
    const rarity = (hit.rarity?.trim().toLowerCase() || guessWearableRarity(urn)).toLowerCase()
    const thumbnailUrl =
      resolveContentImageUrl(hit.thumbnail, peerUrl) ?? wearableThumbnailUrl(urn, peerUrl)
    return {
      name: enName || hit.name?.trim() || wearableShortLabel(urn),
      rarity,
      thumbnailUrl
    }
  } catch {
    return null
  }
}

async function resolveWearableMeta(urn: string, peerUrl: string): Promise<WearableDisplayCard> {
  const fallback: WearableDisplayCard = {
    urn,
    name: wearableShortLabel(urn),
    rarity: guessWearableRarity(urn),
    thumbnailUrl: wearableThumbnailUrl(urn, peerUrl)
  }

  const parsed = parseCollectionsV2WearableUrn(urn)
  if (parsed) {
    const marketplace = await fetchMarketplaceWearableMeta(parsed.contract, parsed.itemId, peerUrl)
    if (marketplace) {
      return { urn, ...marketplace }
    }
    const itemUrn = `urn:decentraland:matic:collections-v2:${parsed.contract}:${parsed.itemId}`
    return {
      urn,
      name: wearableShortLabel(urn),
      rarity: guessWearableRarity(urn),
      thumbnailUrl: wearableThumbnailUrl(itemUrn, peerUrl)
    }
  }

  const catalyst = await fetchCatalystWearableMeta(urn, peerUrl)
  if (catalyst) return { urn, ...catalyst }

  return fallback
}

export async function fetchWearableDisplayCards(
  urns: string[],
  peerUrl = DEFAULT_CATALYST
): Promise<WearableDisplayCard[]> {
  const base = peerUrl.replace(/\/$/, '')
  const equipped = filterEquippedWearables(urns).slice(0, 12)
  const chunkSize = 4
  const cards: WearableDisplayCard[] = []

  for (let i = 0; i < equipped.length; i += chunkSize) {
    const chunk = equipped.slice(i, i + chunkSize)
    const resolved = await Promise.all(chunk.map((urn) => resolveWearableMeta(urn, base)))
    cards.push(...resolved)
  }

  return cards
}