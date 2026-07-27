/**
 * Creator collections for Loot Bag stock UI.
 *
 * Builder API (`builder-api.decentraland.org/v1/{address}/collections`) requires a
 * signed Auth Chain — browser guests cannot call it raw.
 *
 * Marketplace index is same-origin `/api/marketplace/v1` (nginx/Vite → marketplace-api).
 * Direct marketplace-api CORS fails on custom hosts (Allow-Origin: false).
 */

import { MARKETPLACE_API_BASE } from './config'

const PEER_THUMB_BASE = 'https://peer.decentraland.org/lambdas/collections/contents'

/** Build marketplace path (same-origin `/api/marketplace/v1/...` by default). */
function marketplaceUrl(path: string, query: Record<string, string>): string {
  const base = MARKETPLACE_API_BASE.replace(/\/$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  const qs = new URLSearchParams(query).toString()
  return `${base}${p}${qs ? `?${qs}` : ''}`
}

export type CreatorCollection = {
  name: string
  contractAddress: string
  /** Number of item designs in the collection */
  size: number
  urn: string
  /** First-item thumbnail (marketplace has no collection image field). */
  thumbnail: string | null
  isOnSale: boolean
  network: string
  chainId: number
}

/** Catalyst thumbnail for Collection V2 design id (usually item 0 as cover). */
export function collectionItemThumbnailUrl(urnOrContract: string, itemId = 0): string {
  const raw = urnOrContract.trim()
  if (raw.startsWith('urn:decentraland:')) {
    return `${PEER_THUMB_BASE}/${raw}:${itemId}/thumbnail`
  }
  const addr = raw.toLowerCase()
  if (/^0x[a-f0-9]{40}$/.test(addr)) {
    return `${PEER_THUMB_BASE}/urn:decentraland:matic:collections-v2:${addr}:${itemId}/thumbnail`
  }
  return `${PEER_THUMB_BASE}/${raw}:${itemId}/thumbnail`
}

export type CreatorCollectionItem = {
  itemId: number
  name: string
  rarity: string
  thumbnail: string | null
  available: number | null
  contractAddress: string
  category: string
}

type MpCollection = {
  name?: string
  contractAddress?: string
  size?: number
  urn?: string
  isOnSale?: boolean
  network?: string
  chainId?: number
  creator?: string
}

type MpItem = {
  itemId?: string | number
  name?: string
  rarity?: string
  thumbnail?: string
  available?: string | number
  contractAddress?: string
  category?: string
}

function isEthAddress(a: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(a.trim())
}

/**
 * Polygon Collection V2 created by `creatorAddress` (marketplace index).
 * Prefer MATIC / chain 137 for Loot Bag stock.
 */
export async function fetchCreatorCollections(
  creatorAddress: string,
  opts?: { first?: number; signal?: AbortSignal }
): Promise<CreatorCollection[]> {
  const creator = creatorAddress.trim().toLowerCase()
  if (!isEthAddress(creator)) return []

  const first = Math.min(Math.max(opts?.first ?? 50, 1), 100)
  // Marketplace may ignore network; we filter client-side.
  const res = await fetch(
    marketplaceUrl('/collections', { creator, first: String(first) }),
    {
      signal: opts?.signal,
      headers: { Accept: 'application/json' }
    }
  )
  if (!res.ok) {
    throw new Error(`Collections fetch failed (${res.status})`)
  }
  const json = (await res.json()) as { data?: MpCollection[]; total?: number }
  const rows = Array.isArray(json.data) ? json.data : []

  const out: CreatorCollection[] = []
  for (const c of rows) {
    const addr = (c.contractAddress ?? '').trim().toLowerCase()
    if (!isEthAddress(addr)) continue
    const chainId = typeof c.chainId === 'number' ? c.chainId : 0
    const network = (c.network ?? '').toUpperCase()
    // Stock uses Polygon Collection V2 only
    if (chainId !== 137 && network !== 'MATIC' && network !== 'POLYGON') continue
    const urn =
      (c.urn ?? '').trim() || `urn:decentraland:matic:collections-v2:${addr}`
    out.push({
      name: (c.name ?? 'Collection').trim() || 'Collection',
      contractAddress: addr,
      size: typeof c.size === 'number' && Number.isFinite(c.size) ? c.size : 0,
      urn,
      thumbnail: collectionItemThumbnailUrl(urn, 0),
      isOnSale: c.isOnSale === true,
      network: network || 'MATIC',
      chainId: chainId || 137
    })
  }
  return out
}

/** Item designs (templates) in a Collection V2 contract. */
export async function fetchCollectionItems(
  contractAddress: string,
  opts?: { first?: number; signal?: AbortSignal }
): Promise<CreatorCollectionItem[]> {
  const contract = contractAddress.trim().toLowerCase()
  if (!isEthAddress(contract)) return []

  const first = Math.min(Math.max(opts?.first ?? 50, 1), 100)
  const res = await fetch(
    marketplaceUrl('/items', { contractAddress: contract, first: String(first) }),
    {
      signal: opts?.signal,
      headers: { Accept: 'application/json' }
    }
  )
  if (!res.ok) {
    throw new Error(`Items fetch failed (${res.status})`)
  }
  const json = (await res.json()) as { data?: MpItem[] }
  const rows = Array.isArray(json.data) ? json.data : []

  const out: CreatorCollectionItem[] = []
  for (const it of rows) {
    const idRaw = it.itemId
    const itemId =
      typeof idRaw === 'number'
        ? idRaw
        : typeof idRaw === 'string' && /^\d+$/.test(idRaw)
          ? Number(idRaw)
          : NaN
    if (!Number.isFinite(itemId) || itemId < 0) continue
    const availRaw = it.available
    let available: number | null = null
    if (typeof availRaw === 'number' && Number.isFinite(availRaw)) available = availRaw
    else if (typeof availRaw === 'string' && /^\d+$/.test(availRaw)) available = Number(availRaw)

    out.push({
      itemId: Math.floor(itemId),
      name: (it.name ?? `Item ${itemId}`).trim() || `Item ${itemId}`,
      rarity: (it.rarity ?? 'common').toLowerCase(),
      thumbnail: typeof it.thumbnail === 'string' && it.thumbnail ? it.thumbnail : null,
      available,
      contractAddress: (it.contractAddress ?? contract).toLowerCase(),
      category: (it.category ?? 'wearable').toLowerCase()
    })
  }
  // Stable order by item id
  out.sort((a, b) => a.itemId - b.itemId)
  return out
}
