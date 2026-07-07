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
export function resolveContentImageUrl(
  raw: string | null | undefined,
  peerUrl = DEFAULT_CATALYST
): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return value
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
  return `${base}/lambdas/collections/contents/${urn}/thumbnail`
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

export const WEARABLE_RARITY_BACKGROUNDS: Record<string, string> = {
  legendary: 'linear-gradient(145deg, #5b1f8a 0%, #9b3fd4 55%, #ff8723 100%)',
  epic: 'linear-gradient(145deg, #1a2f7a 0%, #4a3fd4 55%, #7b5cff 100%)',
  rare: 'linear-gradient(145deg, #0a4a52 0%, #0d7a6a 55%, #57e389 100%)',
  uncommon: 'linear-gradient(145deg, #6a2a10 0%, #b24a18 55%, #ff9a4a 100%)',
  common: 'linear-gradient(145deg, #2a2d3a 0%, #3d4254 100%)',
  base: 'linear-gradient(145deg, #2a2d3a 0%, #3d4254 100%)',
  unique: 'linear-gradient(145deg, #5a4a10 0%, #c9a227 100%)',
  exotic: 'linear-gradient(145deg, #5a1030 0%, #ff2d6f 100%)',
  mythic: 'linear-gradient(145deg, #4a1050 0%, #ff6ad5 100%)'
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
  try {
    const url = `${base}/lambdas/collections/wearables?wearableId=${encodeURIComponent(urn)}`
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