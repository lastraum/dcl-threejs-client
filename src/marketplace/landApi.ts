/**
 * Land listings for Marketplace Land section (parcels + estates for sale).
 * Uses marketplace-api NFTs (same-origin proxy).
 */

import { MARKETPLACE_API_BASE } from '../lootBag/config'
import { weiToMana } from './format'

export type LandKind = 'parcel' | 'estate'

export type LandCoord = { x: number; y: number }

export type LandListing = {
  id: string
  kind: LandKind
  name: string
  /** Primary / centroid coords for map focus. */
  x: number
  y: number
  /** All parcels (1 for parcel, many for estate). */
  parcels: LandCoord[]
  size: number
  priceWei: string | null
  priceMana: number | null
  owner: string | null
  thumbnail: string | null
  contractAddress: string | null
  tokenId: string | null
  isOnSale: boolean
  description: string | null
}

export type LandOrderBy = 'newest' | 'cheapest' | 'name' | 'recently_listed'

function marketplaceUrl(path: string, query: Record<string, string | undefined>): string {
  const base = MARKETPLACE_API_BASE.replace(/\/$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') qs.set(k, v)
  }
  const q = qs.toString()
  return `${base}${p}${q ? `?${q}` : ''}`
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function parseCoord(v: unknown): number | null {
  const n = num(v)
  return n != null && Number.isFinite(n) ? Math.trunc(n) : null
}

export function normalizeLandListing(row: unknown): LandListing | null {
  const root = asRecord(row)
  if (!root) return null
  const nft = asRecord(root.nft) ?? root
  const order = asRecord(root.order)
  const category = (str(nft.category) ?? '').toLowerCase()
  const kind: LandKind | null =
    category === 'parcel' ? 'parcel' : category === 'estate' ? 'estate' : null
  if (!kind) return null

  const data = asRecord(nft.data)
  const parcels: LandCoord[] = []
  let name = str(nft.name) ?? (kind === 'parcel' ? 'Parcel' : 'Estate')
  let size = 1

  let description: string | null = null

  if (kind === 'parcel') {
    const parcel = data ? asRecord(data.parcel) : null
    const x = parseCoord(parcel?.x)
    const y = parseCoord(parcel?.y)
    if (x == null || y == null) return null
    parcels.push({ x, y })
    if (name === 'Parcel') name = `${x}, ${y}`
    description = str(parcel?.description)
  } else {
    const estate = data ? asRecord(data.estate) : null
    size = num(estate?.size) ?? 0
    description = str(estate?.description)
    const rawParcels = estate?.parcels
    if (Array.isArray(rawParcels)) {
      for (const p of rawParcels) {
        const rec = asRecord(p)
        const x = parseCoord(rec?.x)
        const y = parseCoord(rec?.y)
        if (x != null && y != null) parcels.push({ x, y })
      }
    }
    size = Math.max(size, parcels.length)
    if (!parcels.length) return null
  }

  const cx =
    Math.round(parcels.reduce((s, p) => s + p.x, 0) / parcels.length)
  const cy =
    Math.round(parcels.reduce((s, p) => s + p.y, 0) / parcels.length)

  const priceWei = str(order?.price) ?? str(nft.price)
  const id = str(nft.id) ?? `${kind}-${cx},${cy}-${str(nft.tokenId) ?? ''}`

  return {
    id,
    kind,
    name,
    x: cx,
    y: cy,
    parcels,
    size: kind === 'parcel' ? 1 : size || parcels.length,
    priceWei,
    priceMana: weiToMana(priceWei),
    owner: str(nft.owner) ?? str(order?.owner),
    thumbnail: str(nft.image) ?? str(nft.thumbnail),
    contractAddress: str(nft.contractAddress),
    tokenId: str(nft.tokenId),
    isOnSale: Boolean(order || nft.activeOrderId),
    description
  }
}

/** Single land NFT by contract + tokenId (DCL marketplace land URL shape). */
export async function fetchLandByToken(
  contractAddress: string,
  tokenId: string
): Promise<LandListing | null> {
  const url = marketplaceUrl('/nfts', {
    contractAddress: contractAddress.toLowerCase(),
    tokenId,
    first: '1'
  })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`land nft ${res.status}`)
  const raw = (await res.json()) as { data?: unknown[] }
  const row = raw.data?.[0]
  return row ? normalizeLandListing(row) : null
}

export function landRefFromListing(
  listing: LandListing
): { contractAddress: string; tokenId: string } | null {
  const c = listing.contractAddress?.trim().toLowerCase()
  const t = listing.tokenId?.trim()
  if (!c || !t || !/^0x[a-f0-9]{40}$/.test(c)) return null
  return { contractAddress: c, tokenId: t }
}

export type FetchLandParams = {
  kind?: LandKind | 'all'
  orderBy?: LandOrderBy
  first?: number
  skip?: number
  isOnSale?: boolean
  search?: string
}

export type FetchLandResult = {
  listings: LandListing[]
  total: number | null
}

async function fetchLandCategory(
  category: 'parcel' | 'estate',
  params: FetchLandParams
): Promise<FetchLandResult> {
  const first = params.first ?? 48
  const skip = params.skip ?? 0
  const query: Record<string, string | undefined> = {
    category,
    first: String(first),
    skip: String(skip),
    orderBy: params.orderBy ?? 'newest'
  }
  if (params.isOnSale != null) query.isOnSale = params.isOnSale ? 'true' : 'false'
  if (params.search?.trim()) query.search = params.search.trim()

  const url = marketplaceUrl('/nfts', query)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`land nfts ${res.status}`)
  const raw = (await res.json()) as { data?: unknown[]; total?: string | number }
  const listings: LandListing[] = []
  for (const row of raw.data ?? []) {
    const item = normalizeLandListing(row)
    if (item) listings.push(item)
  }
  const total = num(raw.total)
  return { listings, total }
}

/** Catalog page for parcels and/or estates. */
export async function fetchLandPage(params: FetchLandParams = {}): Promise<FetchLandResult> {
  const kind = params.kind ?? 'all'
  if (kind === 'parcel' || kind === 'estate') {
    return fetchLandCategory(kind, params)
  }

  // Merge both categories (split page size)
  const half = Math.max(12, Math.floor((params.first ?? 48) / 2))
  const skip = params.skip ?? 0
  // Simple strategy: alternate pages by skip on each category
  const [parcels, estates] = await Promise.all([
    fetchLandCategory('parcel', { ...params, first: half, skip: Math.floor(skip / 2) }),
    fetchLandCategory('estate', { ...params, first: half, skip: Math.floor(skip / 2) })
  ])
  const listings = [...parcels.listings, ...estates.listings]
  // Sort merged
  const orderBy = params.orderBy ?? 'newest'
  if (orderBy === 'cheapest') {
    listings.sort((a, b) => (a.priceMana ?? Infinity) - (b.priceMana ?? Infinity))
  } else if (orderBy === 'name') {
    listings.sort((a, b) => a.name.localeCompare(b.name))
  }
  const total =
    parcels.total != null && estates.total != null ? parcels.total + estates.total : null
  return { listings, total }
}

/**
 * Dense for-sale set for map cyan overlay (parcels + estate parcel cells).
 * Caps network to a few pages so map stays snappy.
 */
export async function fetchLandForSaleMap(maxParcels = 400): Promise<LandListing[]> {
  const pages = 4
  const pageSize = 100
  const out: LandListing[] = []
  const seen = new Set<string>()

  for (let page = 0; page < pages && out.length < maxParcels; page++) {
    const skip = page * pageSize
    const [parcels, estates] = await Promise.all([
      fetchLandCategory('parcel', {
        first: pageSize,
        skip,
        isOnSale: true,
        orderBy: 'cheapest'
      }).catch(() => ({ listings: [] as LandListing[], total: null })),
      fetchLandCategory('estate', {
        first: Math.min(50, pageSize),
        skip: Math.floor(skip / 2),
        isOnSale: true,
        orderBy: 'cheapest'
      }).catch(() => ({ listings: [] as LandListing[], total: null }))
    ])
    for (const L of [...parcels.listings, ...estates.listings]) {
      if (seen.has(L.id)) continue
      seen.add(L.id)
      out.push(L)
    }
    if (parcels.listings.length === 0 && estates.listings.length === 0) break
  }
  return out
}

/** Parcel key → listing (first wins) for map hit-testing. */
export function buildParcelSaleIndex(
  listings: readonly LandListing[]
): Map<string, LandListing> {
  const map = new Map<string, LandListing>()
  for (const L of listings) {
    for (const p of L.parcels) {
      const key = `${p.x},${p.y}`
      if (!map.has(key)) map.set(key, L)
    }
  }
  return map
}
