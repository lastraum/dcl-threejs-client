import { MARKETPLACE_API_BASE } from '../../../lootBag/config'
import {
  MARKETPLACE_POLYGON,
  MARKETPLACE_POLYGON_ALT
} from '../trade/marketplaceConfig'

const LEGACY_MARKETPLACE = '0x480a0f4e360e8964e68858dd231c2922f1df45ef'

export type CatalogItem = {
  id: string
  name: string
  thumbnail: string
  url: string
  category: string
  contractAddress: string
  itemId: string
  rarity: string
  price: string
  available: number | string
  isOnSale: boolean
  creator?: string
  collectionName?: string
  network?: string
  urn?: string
  tradeId: string | null
  tradeContractAddress?: string | null
  minListingPrice?: string | null
  listings?: number | null
  picks?: { count?: number }
  data?: {
    wearable?: {
      description?: string
      category?: string
      bodyShapes?: string[]
      rarity?: string
      isSmart?: boolean
    }
    emote?: {
      description?: string
      category?: string
      rarity?: string
    }
  }
}

export type MarketplaceOrder = {
  id: string
  marketplaceAddress: string
  contractAddress: string
  tokenId: string
  itemId?: string
  price: string
  owner: string
  status: string
  tradeId?: string | null
}

export type CartSource = 'store' | 'listing' | 'legacy'

export function marketplaceUrl(path: string, query: Record<string, string | string[] | undefined> = {}): string {
  const u = new URL(`${MARKETPLACE_API_BASE}${path}`, window.location.origin)
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === '') continue
    if (Array.isArray(v)) {
      for (const item of v) u.searchParams.append(k, item)
    } else {
      u.searchParams.set(k, v)
    }
  }
  return u.pathname + u.search
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Marketplace API ${res.status}`)
  return (await res.json()) as T
}

function asList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (raw && typeof raw === 'object') {
    const o = raw as { data?: unknown; results?: unknown }
    if (Array.isArray(o.data)) return o.data as T[]
    if (Array.isArray(o.results)) return o.results as T[]
  }
  return []
}

function asTotal(raw: unknown, fallback: number): number {
  if (raw && typeof raw === 'object' && 'total' in raw) {
    const n = Number((raw as { total?: unknown }).total)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function normalizeItem(raw: Record<string, unknown>): CatalogItem | null {
  const contractAddress = String(raw.contractAddress ?? '').toLowerCase()
  const itemId = String(raw.itemId ?? '')
  if (!contractAddress || itemId === '') return null
  const tradeIdRaw = raw.tradeId
  const tradeId =
    typeof tradeIdRaw === 'string' && tradeIdRaw.trim() !== '' ? tradeIdRaw.trim() : null
  return {
    id: String(raw.id ?? `${contractAddress}-${itemId}`),
    name: String(raw.name ?? 'Untitled'),
    thumbnail: String(raw.thumbnail ?? raw.image ?? ''),
    url: String(raw.url ?? ''),
    category: String(raw.category ?? 'wearable'),
    contractAddress,
    itemId,
    rarity: String(raw.rarity ?? 'common'),
    price: String(raw.price ?? raw.minPrice ?? '0'),
    available: (raw.available as number | string) ?? 0,
    isOnSale: Boolean(raw.isOnSale),
    creator: raw.creator ? String(raw.creator) : undefined,
    collectionName: raw.collection ? String((raw.collection as { name?: string }).name ?? '') : undefined,
    network: raw.network ? String(raw.network) : undefined,
    urn: raw.urn ? String(raw.urn) : undefined,
    tradeId,
    tradeContractAddress: raw.tradeContractAddress
      ? String(raw.tradeContractAddress)
      : raw.tradeId
        ? MARKETPLACE_POLYGON
        : null,
    minListingPrice: raw.minListingPrice != null ? String(raw.minListingPrice) : null,
    listings: raw.listings != null ? Number(raw.listings) : null,
    picks: raw.picks as CatalogItem['picks'],
    data: raw.data as CatalogItem['data']
  }
}

export type CatalogQuery = {
  first?: number
  skip?: number
  category?: 'wearable' | 'emote'
  isOnSale?: boolean
  sortBy?: string
  search?: string
  rarities?: string[]
  wearableCategory?: string
}

export async function fetchCatalog(q: CatalogQuery): Promise<{ items: CatalogItem[]; total: number }> {
  const params = new URLSearchParams()
  params.set('first', String(q.first ?? 24))
  params.set('skip', String(q.skip ?? 0))
  params.set('category', q.category ?? 'wearable')
  params.set('sortBy', q.sortBy ?? 'newest')
  if (q.isOnSale !== false) params.set('isOnSale', 'true')
  if (q.search?.trim()) params.set('search', q.search.trim())
  for (const r of q.rarities ?? []) params.append('rarity', r)
  if (q.wearableCategory) params.set('wearableCategory', q.wearableCategory)
  const body = await getJson<unknown>(`/api/marketplace/v2/catalog?${params.toString()}`)
  const list = asList<Record<string, unknown>>(body)
  const items = list.map(normalizeItem).filter((x): x is CatalogItem => x != null)
  return { items, total: asTotal(body, items.length) }
}

export async function fetchCatalogItem(contractAddress: string, itemId: string): Promise<CatalogItem | null> {
  const url = marketplaceUrl('/items', {
    contractAddress: contractAddress.toLowerCase(),
    first: '100'
  })
  const body = await getJson<unknown>(url)
  const list = asList<Record<string, unknown>>(body)
  const match = list.find((raw) => String(raw.itemId ?? '') === String(itemId))
  return match ? normalizeItem(match) : null
}

export async function fetchOpenOrders(contractAddress: string, itemId: string): Promise<MarketplaceOrder[]> {
  const url = marketplaceUrl('/orders', {
    contractAddress: contractAddress.toLowerCase(),
    itemId: String(itemId),
    status: 'open',
    first: '20',
    sortBy: 'cheapest'
  })
  const body = await getJson<unknown>(url)
  return asList<Record<string, unknown>>(body).map((o) => ({
    id: String(o.id ?? ''),
    marketplaceAddress: String(o.marketplaceAddress ?? '').toLowerCase(),
    contractAddress: String(o.contractAddress ?? o.nftAddress ?? '').toLowerCase(),
    tokenId: String(o.tokenId ?? o.assetId ?? ''),
    itemId: o.itemId != null ? String(o.itemId) : undefined,
    price: String(o.price ?? o.priceInWei ?? '0'),
    owner: String(o.owner ?? ''),
    status: String(o.status ?? 'open'),
    tradeId: typeof o.tradeId === 'string' && o.tradeId.trim() ? o.tradeId.trim() : null
  }))
}

export async function fetchSales(
  contractAddress: string,
  itemId: string
): Promise<{ type?: string; price: string; buyer?: string; tokenId?: string }[]> {
  const url = marketplaceUrl('/sales', {
    contractAddress: contractAddress.toLowerCase(),
    itemId: String(itemId),
    first: '8'
  })
  const body = await getJson<unknown>(url)
  return asList<Record<string, unknown>>(body).map((s) => ({
    type: s.type ? String(s.type) : undefined,
    price: String(s.price ?? '0'),
    buyer: s.buyer ? String(s.buyer) : undefined,
    tokenId: s.tokenId != null ? String(s.tokenId) : undefined
  }))
}

export async function fetchOwners(
  contractAddress: string,
  itemId: string
): Promise<{ tokenId: string; owner: string }[]> {
  const url = marketplaceUrl('/nfts', {
    contractAddress: contractAddress.toLowerCase(),
    itemId: String(itemId),
    first: '8'
  })
  const body = await getJson<unknown>(url)
  return asList<Record<string, unknown>>(body).map((e) => {
    const nft = (e.nft as Record<string, unknown> | undefined) ?? e
    return {
      tokenId: String(nft.tokenId ?? ''),
      owner: String(nft.owner ?? '')
    }
  })
}

export type SignedTradePayload = Record<string, unknown> & { signature?: string }

export async function fetchTrade(tradeId: string): Promise<SignedTradePayload | null> {
  const url = marketplaceUrl(`/trades/${tradeId}`)
  const res = await fetch(url)
  if (!res.ok) return null
  const json = (await res.json()) as { data?: SignedTradePayload }
  const data = json?.data ?? json
  return data && typeof data === 'object' ? (data as SignedTradePayload) : null
}

function isOffchainMarketplace(addr: string | null | undefined): boolean {
  const a = (addr || '').toLowerCase()
  return a === MARKETPLACE_POLYGON.toLowerCase() || a === MARKETPLACE_POLYGON_ALT.toLowerCase()
}

function isUuid(s: string | null | undefined): boolean {
  return Boolean(s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim()))
}

/** True when this listing can ride in one accept() / CollectionStore.buy() checkout. */
export function classifyCartSource(item: CatalogItem, order?: MarketplaceOrder | null): CartSource {
  if (isUuid(item.tradeId) && isOffchainMarketplace(item.tradeContractAddress || MARKETPLACE_POLYGON)) {
    return 'store'
  }
  if (order) {
    if (isUuid(order.tradeId) && isOffchainMarketplace(order.marketplaceAddress)) return 'listing'
    if (order.marketplaceAddress === LEGACY_MARKETPLACE) return 'legacy'
  }
  if (item.isOnSale && !item.tradeId) return 'store'
  return 'legacy'
}

export function isBatchableSource(source: CartSource): boolean {
  return source === 'store' || source === 'listing'
}
