/**
 * Decentraland marketplace-api client (same-origin proxy).
 * Base: `/api/marketplace/v1` → marketplace-api.decentraland.org/v1
 */

import { MARKETPLACE_API_BASE } from '../lootBag/config'
import { kindFromApiCategory, weiToMana } from './format'
import type {
  FetchItemsParams,
  FetchItemsResult,
  MarketplaceItem,
  MarketplaceKind,
  MarketplaceListing,
  MarketplaceOffer,
  MarketplaceOwnerRow,
  MarketplaceSale
} from './types'

function marketplaceUrl(path: string, query: Record<string, string | undefined> = {}): string {
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

/** Normalize a marketplace-api item / trending row into MarketplaceItem. */
export function normalizeMarketplaceItem(row: unknown): MarketplaceItem | null {
  const root = asRecord(row)
  if (!root) return null
  // Some payloads nest under `.item`
  const item = asRecord(root.item) ?? root

  const id =
    str(item.id) ??
    str(root.id) ??
    (str(item.contractAddress) && str(item.itemId)
      ? `${str(item.contractAddress)}-${str(item.itemId)}`
      : null)
  if (!id) return null

  const urn = str(item.urn) ?? str(root.urn) ?? id
  const name = str(item.name) ?? str(root.name) ?? 'Untitled'
  const apiCategory = str(item.category) ?? str(root.category) ?? ''
  const kind = kindFromApiCategory(apiCategory)

  const data = asRecord(item.data)
  const wearable = data ? asRecord(data.wearable) : null
  const emote = data ? asRecord(data.emote) : null
  const slot =
    str(wearable?.category) ?? str(emote?.category) ?? str(item.category) ?? apiCategory ?? ''

  const rarity =
    str(item.rarity) ?? str(wearable?.rarity) ?? str(emote?.rarity) ?? str(root.rarity) ?? 'common'

  const priceWei = str(item.price) ?? str(root.price)
  const priceMana = weiToMana(priceWei)
  const isOnSale = Boolean(item.isOnSale ?? root.isOnSale)

  const picksObj = asRecord(item.picks) ?? asRecord(root.picks)
  const picks = num(picksObj?.count) ?? num(item.picks) ?? 0

  const createdAt = num(item.createdAt) ?? num(root.createdAt)
  const soldAt = num(item.soldAt) ?? num(root.soldAt)

  const description =
    str(wearable?.description) ??
    str(emote?.description) ??
    str(item.description) ??
    str(root.description)

  const availableRaw = item.available ?? root.available
  const available = num(availableRaw)

  const bodyShapesRaw = wearable?.bodyShapes ?? emote?.bodyShapes
  const bodyShapes = Array.isArray(bodyShapesRaw)
    ? bodyShapesRaw.filter((s): s is string => typeof s === 'string')
    : []

  const isSmart = Boolean(wearable?.isSmart ?? emote?.isSmart ?? item.isSmart)

  return {
    id,
    urn,
    name,
    kind,
    category: slot,
    rarity,
    priceWei,
    priceMana,
    isOnSale,
    thumbnail: str(item.thumbnail) ?? str(root.thumbnail),
    creator: str(item.creator) ?? str(root.creator),
    contractAddress: str(item.contractAddress) ?? str(root.contractAddress),
    itemId: str(item.itemId) ?? str(root.itemId),
    network: str(item.network) ?? str(root.network),
    picks,
    soldAt,
    createdAt,
    description,
    available,
    bodyShapes,
    isSmart
  }
}

export function normalizeMarketplaceSale(row: unknown): MarketplaceSale | null {
  const rec = asRecord(row)
  if (!rec) return null
  const id = str(rec.id) ?? `${str(rec.txHash) ?? 'sale'}-${str(rec.timestamp) ?? ''}`
  const priceWei = str(rec.price)
  let timestamp = num(rec.timestamp)
  // Some feeds use seconds
  if (timestamp != null && timestamp < 1e12) timestamp = timestamp * 1000
  return {
    id,
    type: str(rec.type) ?? 'sale',
    priceWei,
    priceMana: weiToMana(priceWei),
    seller: str(rec.seller),
    buyer: str(rec.buyer),
    timestamp,
    tokenId: str(rec.tokenId),
    txHash: str(rec.txHash)
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`marketplace ${res.status}: ${url}`)
  return res.json()
}

function parseDataArray(raw: unknown): unknown[] {
  const rec = asRecord(raw)
  if (!rec) return []
  const data = rec.data
  return Array.isArray(data) ? data : []
}

export async function fetchTrendings(size = 24): Promise<MarketplaceItem[]> {
  const url = marketplaceUrl('/trendings', { size: String(size) })
  const raw = await fetchJson(url)
  const out: MarketplaceItem[] = []
  for (const row of parseDataArray(raw)) {
    const item = normalizeMarketplaceItem(row)
    if (item) out.push(item)
  }
  return out
}

export async function fetchItemsPage(params: FetchItemsParams = {}): Promise<FetchItemsResult> {
  const first = params.first ?? 24
  const skip = params.skip ?? 0
  const query: Record<string, string | undefined> = {
    first: String(first),
    skip: String(skip),
    orderBy: params.orderBy ?? 'newest'
  }
  if (params.category) query.category = params.category
  if (params.wearableCategory) query.wearableCategory = params.wearableCategory
  if (params.isOnSale != null) query.isOnSale = params.isOnSale ? 'true' : 'false'
  if (params.contractAddress) query.contractAddress = params.contractAddress.toLowerCase()
  if (params.itemId != null && params.itemId !== '') query.itemId = params.itemId
  if (params.search?.trim()) query.search = params.search.trim()
  if (params.rarity) query.rarity = params.rarity
  if (params.isSmart != null) query.isWearableSmart = params.isSmart ? 'true' : 'false'

  const url = marketplaceUrl('/items', query)
  const raw = await fetchJson(url)
  const rec = asRecord(raw)
  const total = num(rec?.total)
  const out: MarketplaceItem[] = []
  for (const row of parseDataArray(raw)) {
    const item = normalizeMarketplaceItem(row)
    if (item) out.push(item)
  }
  return { items: out, total }
}

export async function fetchItems(params: FetchItemsParams = {}): Promise<MarketplaceItem[]> {
  const page = await fetchItemsPage(params)
  return page.items
}

/** Single item by collection contract + design itemId. */
export async function fetchItem(
  contractAddress: string,
  itemId: string
): Promise<MarketplaceItem | null> {
  const items = await fetchItems({
    contractAddress,
    itemId,
    first: 1,
    orderBy: 'newest'
  })
  return items[0] ?? null
}

export async function fetchItemSales(
  contractAddress: string,
  itemId: string,
  first = 12
): Promise<MarketplaceSale[]> {
  const url = marketplaceUrl('/sales', {
    contractAddress: contractAddress.toLowerCase(),
    itemId,
    first: String(first)
  })
  const raw = await fetchJson(url)
  const out: MarketplaceSale[] = []
  for (const row of parseDataArray(raw)) {
    const sale = normalizeMarketplaceSale(row)
    if (sale) out.push(sale)
  }
  return out
}

export async function fetchCollectionItems(
  contractAddress: string,
  first = 12
): Promise<MarketplaceItem[]> {
  return fetchItems({
    contractAddress,
    first,
    orderBy: 'newest'
  })
}

function toMs(v: number | null): number | null {
  if (v == null) return null
  return v < 1e12 ? v * 1000 : v
}

export function normalizeMarketplaceListing(row: unknown): MarketplaceListing | null {
  const rec = asRecord(row)
  if (!rec) return null
  const id = str(rec.id) ?? `${str(rec.tokenId)}-${str(rec.owner)}`
  if (!id) return null
  const priceWei = str(rec.price)
  return {
    id,
    tokenId: str(rec.tokenId),
    issuedId: str(rec.issuedId),
    owner: str(rec.owner),
    priceWei,
    priceMana: weiToMana(priceWei),
    status: str(rec.status) ?? 'open',
    expiresAt: toMs(num(rec.expiresAt)),
    createdAt: toMs(num(rec.createdAt))
  }
}

export function normalizeMarketplaceOwner(row: unknown): MarketplaceOwnerRow | null {
  const root = asRecord(row)
  if (!root) return null
  const nft = asRecord(root.nft) ?? root
  const id = str(nft.id) ?? str(root.id)
  if (!id) return null
  const activeOrderId = str(nft.activeOrderId) ?? str(root.activeOrderId)
  const order = asRecord(root.order)
  return {
    id,
    tokenId: str(nft.tokenId),
    issuedId: str(nft.issuedId),
    owner: str(nft.owner),
    hasActiveOrder: Boolean(activeOrderId || order)
  }
}

export function normalizeMarketplaceOffer(row: unknown): MarketplaceOffer | null {
  const rec = asRecord(row)
  if (!rec) return null
  const id = str(rec.id) ?? `${str(rec.bidder)}-${str(rec.price)}-${str(rec.createdAt)}`
  if (!id) return null
  const priceWei = str(rec.price) ?? str(rec.amount)
  return {
    id,
    bidder: str(rec.bidder) ?? str(rec.buyer) ?? str(rec.from),
    priceWei,
    priceMana: weiToMana(priceWei),
    status: str(rec.status) ?? 'open',
    expiresAt: toMs(num(rec.expiresAt)),
    createdAt: toMs(num(rec.createdAt)),
    tokenId: str(rec.tokenId)
  }
}

/** Open secondary-market listings for an item design. */
export async function fetchItemListings(
  contractAddress: string,
  itemId: string,
  first = 24
): Promise<MarketplaceListing[]> {
  const url = marketplaceUrl('/orders', {
    contractAddress: contractAddress.toLowerCase(),
    itemId,
    first: String(first),
    status: 'open'
  })
  const raw = await fetchJson(url)
  const out: MarketplaceListing[] = []
  for (const row of parseDataArray(raw)) {
    const listing = normalizeMarketplaceListing(row)
    if (listing) out.push(listing)
  }
  // cheapest first
  out.sort((a, b) => (a.priceMana ?? Infinity) - (b.priceMana ?? Infinity))
  return out
}

/**
 * Owners of minted editions. API may ignore itemId — filter client-side.
 */
export async function fetchItemOwners(
  contractAddress: string,
  itemId: string,
  first = 48
): Promise<MarketplaceOwnerRow[]> {
  const url = marketplaceUrl('/nfts', {
    contractAddress: contractAddress.toLowerCase(),
    first: String(Math.min(first, 100))
  })
  const raw = await fetchJson(url)
  const out: MarketplaceOwnerRow[] = []
  const want = String(itemId)
  for (const row of parseDataArray(raw)) {
    const root = asRecord(row)
    const nft = root ? (asRecord(root.nft) ?? root) : null
    if (!nft) continue
    const rowItemId = str(nft.itemId)
    if (rowItemId != null && rowItemId !== want) continue
    const owner = normalizeMarketplaceOwner(row)
    if (owner) out.push(owner)
  }
  return out
}

/** Bids / offers — endpoint shape varies; tolerate empty. */
export async function fetchItemOffers(
  contractAddress: string,
  itemId: string,
  first = 24
): Promise<MarketplaceOffer[]> {
  const url = marketplaceUrl('/bids', {
    contractAddress: contractAddress.toLowerCase(),
    itemId,
    first: String(first)
  })
  try {
    const raw = await fetchJson(url)
    const rec = asRecord(raw)
    let rows: unknown[] = parseDataArray(raw)
    if (!rows.length && rec) {
      const data = asRecord(rec.data)
      if (data && Array.isArray(data.results)) rows = data.results
      else if (Array.isArray(rec.results)) rows = rec.results
    }
    const out: MarketplaceOffer[] = []
    for (const row of rows) {
      const offer = normalizeMarketplaceOffer(row)
      if (offer) out.push(offer)
    }
    return out
  } catch {
    return []
  }
}

/** API category string for Discover chips that are supported today. */
export function supportedApiCategory(
  kind: MarketplaceKind | 'all'
): 'wearable' | 'emote' | null {
  if (kind === 'emote') return 'emote'
  if (kind === 'wearable' || kind === 'all') return 'wearable'
  return null
}
