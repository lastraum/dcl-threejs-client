import { createPublicClient, http, type Address, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'
import { MARKETPLACE_API_BASE } from '../../../lootBag/config'
import { polygonPublicClient } from '../../../lootBag/polygonClient'
import {
  ETHEREUM_MANA,
  MARKETPLACE_POLYGON,
  MARKETPLACE_POLYGON_ALT,
  POLYGON_MANA
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
    const o = raw as { data?: unknown; results?: unknown; items?: unknown }
    if (Array.isArray(o.data)) return o.data as T[]
    if (Array.isArray(o.results)) return o.results as T[]
    if (Array.isArray(o.items)) return o.items as T[]
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

function collectionNameFromRaw(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.collectionName === 'string' && raw.collectionName.trim()) return raw.collectionName.trim()
  const col = raw.collection
  if (typeof col === 'string' && col.trim() && !/^0x[a-f0-9]{40}$/i.test(col.trim())) return col.trim()
  if (col && typeof col === 'object') {
    const name = (col as { name?: unknown }).name
    if (typeof name === 'string' && name.trim()) return name.trim()
  }
  return undefined
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
    collectionName: collectionNameFromRaw(raw),
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
  emoteCategory?: string
  onlyMinting?: boolean
  onlyListing?: boolean
  network?: 'ETHEREUM' | 'MATIC'
  wearableGenders?: string[]
  emotePlayMode?: string
  emoteHasSound?: boolean
  emoteHasGeometry?: boolean
  isWearableSmart?: boolean
  minPrice?: string
  maxPrice?: string
  contractAddress?: string
  creator?: string
}

export function itemHasPrimary(item: CatalogItem): boolean {
  const avail = Number(item.available)
  return item.isOnSale && Number.isFinite(avail) && avail > 0
}

export function itemHasSecondary(item: CatalogItem): boolean {
  if ((item.listings ?? 0) > 0) return true
  if (item.minListingPrice == null || item.minListingPrice === '' || item.minListingPrice === '0') return false
  return true
}

const MANA_WEI = 10n ** 18n

/** Whole MANA units from wei (floor). */
export function manaUnitsFromWei(wei: string | bigint | number | null | undefined): number {
  try {
    const n = Number((typeof wei === 'bigint' ? wei : BigInt(wei || '0')) / MANA_WEI)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    return 0
  }
}

/** Credits: primary Polygon mint priced ≥ 1 MANA. 1 credit = 1 MANA. */
export function isCreditEligible(item: CatalogItem): boolean {
  if (!itemHasPrimary(item)) return false
  const net = (item.network || 'MATIC').toUpperCase()
  if (net !== 'MATIC' && net !== 'POLYGON') return false
  return manaUnitsFromWei(item.price) >= 1
}

/** Credits required to fully cover a primary mint (0 if ineligible). */
export function creditCost(item: CatalogItem): number {
  return isCreditEligible(item) ? manaUnitsFromWei(item.price) : 0
}

export type CreditQuote = {
  eligible: boolean
  /** Credits needed to fully cover. */
  costCredits: number
  /** Credits applied from the owned pool. */
  applyCredits: number
  /** Whole MANA still owed after credits. */
  remainingMana: number
  remainingWei: bigint
  /** Fully paid with credits. */
  covered: boolean
}

/**
 * Official shop pricing: toggle Get with Credits → price becomes 0 if the
 * wallet has enough credits, else remaining MANA + credits applied.
 */
export function quoteCredits(
  item: CatalogItem,
  ownedCredits: number,
  useCredits: boolean
): CreditQuote {
  const cost = creditCost(item)
  const fullWei = (() => {
    try {
      return BigInt(item.price || '0')
    } catch {
      return 0n
    }
  })()
  if (!useCredits || cost <= 0 || ownedCredits <= 0) {
    return {
      eligible: cost > 0,
      costCredits: cost,
      applyCredits: 0,
      remainingMana: manaUnitsFromWei(fullWei),
      remainingWei: fullWei,
      covered: false
    }
  }
  const apply = Math.min(Math.max(0, Math.floor(ownedCredits)), cost)
  const applyWei = BigInt(apply) * MANA_WEI
  const remainingWei = fullWei > applyWei ? fullWei - applyWei : 0n
  return {
    eligible: true,
    costCredits: cost,
    applyCredits: apply,
    remainingMana: manaUnitsFromWei(remainingWei),
    remainingWei,
    covered: remainingWei === 0n && apply > 0
  }
}

export function formatCreditLabel(n: number): string {
  return n === 1 ? '1 Credit' : `${n} Credits`
}

/** Shop price string after credits (Explorer: 0 when fully covered). */
export function formatQuotedPrice(q: CreditQuote, manaLabel: string): string {
  if (!q.eligible || q.applyCredits <= 0) return manaLabel
  if (q.covered) return formatCreditLabel(q.applyCredits)
  return `${q.remainingMana} MANA + ${formatCreditLabel(q.applyCredits)}`
}

export type CartCreditLine = {
  key: string
  quote: CreditQuote
}

/** Allocate owned credits across eligible cart lines, cheapest first. */
export function allocateCartCredits(
  lines: { key: string; item: CatalogItem; source: string }[],
  ownedCredits: number,
  useCredits: boolean
): { quotes: Map<string, CreditQuote>; creditsUsed: number; manaWei: bigint } {
  const quotes = new Map<string, CreditQuote>()
  let left = useCredits ? Math.max(0, Math.floor(ownedCredits)) : 0
  const eligible = lines
    .filter((l) => l.source === 'store' && creditCost(l.item) > 0)
    .slice()
    .sort((a, b) => creditCost(a.item) - creditCost(b.item))
  const usedByKey = new Map<string, number>()
  for (const l of eligible) {
    const cost = creditCost(l.item)
    const apply = Math.min(left, cost)
    usedByKey.set(l.key, apply)
    left -= apply
  }
  let creditsUsed = 0
  let manaWei = 0n
  for (const l of lines) {
    const apply = usedByKey.get(l.key) ?? 0
    const q = quoteCredits(l.item, apply, apply > 0)
    quotes.set(l.key, q)
    creditsUsed += q.applyCredits
    manaWei += q.remainingWei
  }
  return { quotes, creditsUsed, manaWei }
}

function positiveWei(v: string | null | undefined): string | null {
  if (v == null || v === '') return null
  try {
    const n = BigInt(v)
    return n > 0n ? n.toString() : null
  } catch {
    return null
  }
}

/** Cheapest open listing in wei. Shop credits do not apply to secondaries. */
export function listingPayWei(item: CatalogItem, order?: MarketplaceOrder | null): string {
  return (
    positiveWei(order?.price) ||
    positiveWei(item.minListingPrice) ||
    (!itemHasPrimary(item) ? positiveWei(item.price) : null) ||
    '0'
  )
}

export function catalogDisplayWei(
  item: CatalogItem,
  sale: 'primary' | 'secondary' | 'auto' = 'auto',
  order?: MarketplaceOrder | null
): string {
  const primary = itemHasPrimary(item)
  const listingWei = listingPayWei(item, order)
  const secondary = itemHasSecondary(item) || listingWei !== '0'
  if (sale === 'secondary' || (sale === 'auto' && !primary && secondary)) {
    return listingWei
  }
  return item.price || '0'
}

/** Shop © credits are primary Collection Store mints only. Listings settle in MANA. */
export function usesShopCredits(
  item: CatalogItem,
  sale: 'primary' | 'secondary' | 'auto' = 'auto'
): boolean {
  if (sale === 'secondary') return false
  if (!itemHasPrimary(item)) return false
  return positiveWei(item.price) != null
}

/** Shop peg: 1 credit = $0.10. USD is 18-decimal wei, so one credit is 1e17. */
export const USD_CENTS_PER_CREDIT = 10
const USD_WEI_PER_CREDIT = 10n ** 17n

export type ManaUsdRate = { rate: bigint; decimals: number }

/** MANA wei → shop credits, rounded up so the quote never under-covers. */
export function manaWeiToShopCredits(manaWei: string | bigint, rate: ManaUsdRate): number {
  let wei: bigint
  try {
    wei = typeof manaWei === 'bigint' ? manaWei : BigInt(manaWei || '0')
  } catch {
    return 0
  }
  if (wei <= 0n || rate.rate <= 0n) return 0
  const usdWei = (wei * rate.rate) / 10n ** BigInt(rate.decimals)
  const whole = usdWei / USD_WEI_PER_CREDIT
  const credits = usdWei % USD_WEI_PER_CREDIT > 0n ? whole + 1n : whole
  const n = Number(credits)
  if (!Number.isFinite(n) || n < 1) return 1
  return n
}

const manaUsdAggAbi = [
  {
    type: 'function',
    name: 'manaUsdAggregator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  }
] as const

const aggregatorAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }]
  },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint80' },
      { type: 'int256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint80' }
    ]
  }
] as const

/** Live MANA/USD from the shop's on-chain aggregator (same oracle checkout locks against). */
export async function fetchManaUsdRate(): Promise<ManaUsdRate | null> {
  try {
    const aggAddr = await polygonPublicClient.readContract({
      address: MARKETPLACE_POLYGON,
      abi: manaUsdAggAbi,
      functionName: 'manaUsdAggregator'
    })
    const [decimals, round] = await Promise.all([
      polygonPublicClient.readContract({
        address: aggAddr,
        abi: aggregatorAbi,
        functionName: 'decimals'
      }),
      polygonPublicClient.readContract({
        address: aggAddr,
        abi: aggregatorAbi,
        functionName: 'latestRoundData'
      })
    ])
    const rate = BigInt(round[1])
    if (rate <= 0n) return null
    return { rate, decimals: Number(decimals) }
  } catch {
    return null
  }
}

export async function fetchCatalog(q: CatalogQuery): Promise<{ items: CatalogItem[]; total: number }> {
  const params = new URLSearchParams()
  params.set('first', String(q.first ?? 24))
  params.set('skip', String(q.skip ?? 0))
  params.set('category', q.category ?? 'wearable')
  params.set('sortBy', q.sortBy ?? 'newest')
  if (q.onlyListing) params.set('onlyListing', 'true')
  else if (q.onlyMinting) params.set('onlyMinting', 'true')
  else if (q.isOnSale !== false) params.set('isOnSale', 'true')
  if (q.search?.trim()) params.set('search', q.search.trim())
  for (const r of q.rarities ?? []) params.append('rarity', r)
  if ((q.category ?? 'wearable') !== 'emote' && q.wearableCategory) {
    params.set('wearableCategory', q.wearableCategory)
  }
  if (q.category === 'emote' && q.emoteCategory) params.set('emoteCategory', q.emoteCategory)
  if (q.network) params.set('network', q.network)
  for (const g of q.wearableGenders ?? []) params.append('wearableGender', g)
  if (q.emotePlayMode) params.append('emotePlayMode', q.emotePlayMode)
  if (q.emoteHasSound) params.set('emoteHasSound', 'true')
  if (q.emoteHasGeometry) params.set('emoteHasGeometry', 'true')
  if (q.isWearableSmart) params.set('isWearableSmart', 'true')
  if (q.minPrice) params.set('minPrice', q.minPrice)
  if (q.maxPrice) params.set('maxPrice', q.maxPrice)
  if (q.contractAddress) params.set('contractAddress', q.contractAddress.toLowerCase())
  if (q.creator) params.append('creator', q.creator.toLowerCase())
  const body = await getJson<unknown>(`/api/marketplace/v2/catalog?${params.toString()}`)
  const list = asList<Record<string, unknown>>(body)
  const items = list.map(normalizeItem).filter((x): x is CatalogItem => x != null)
  return { items, total: asTotal(body, items.length) }
}

const PEER_COLLECTION_THUMB = 'https://peer.decentraland.org/lambdas/collections/contents'

export type CollectionInfo = {
  name: string
  image: string
  urn: string
}

/** Cover art for a collection (item 0 thumbnail on Catalyst). */
export function collectionCoverUrl(contractAddress: string, itemUrn?: string | null): string {
  const urn = (itemUrn || '').trim()
  if (urn.startsWith('urn:decentraland:') && urn.includes('collections-v2')) {
    const parts = urn.split(':')
    if (parts.length >= 5) {
      return `${PEER_COLLECTION_THUMB}/${parts.slice(0, 5).join(':')}:0/thumbnail`
    }
  }
  const addr = contractAddress.trim().toLowerCase()
  if (/^0x[a-f0-9]{40}$/.test(addr)) {
    return `${PEER_COLLECTION_THUMB}/urn:decentraland:matic:collections-v2:${addr}:0/thumbnail`
  }
  return ''
}

export async function fetchCollectionInfo(contractAddress: string): Promise<CollectionInfo | null> {
  const addr = contractAddress.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null
  try {
    const url = marketplaceUrl('/collections', { contractAddress: addr, first: '1' })
    const body = await getJson<unknown>(url)
    const list = asList<Record<string, unknown>>(body)
    const hit = list.find((c) => String(c.contractAddress ?? '').toLowerCase() === addr) ?? list[0]
    if (!hit) return null
    const top = typeof hit.name === 'string' ? hit.name.trim() : ''
    const name = top || collectionNameFromRaw(hit) || ''
    const urn = typeof hit.urn === 'string' ? hit.urn.trim() : ''
    const image = collectionCoverUrl(addr, urn)
    if (!name && !image) return null
    return { name, image, urn }
  } catch {
    return null
  }
}

export async function fetchCollectionName(contractAddress: string): Promise<string | null> {
  const info = await fetchCollectionInfo(contractAddress)
  return info?.name || null
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

function listingSourceFromOrder(order?: MarketplaceOrder | null): CartSource | null {
  if (!order) return null
  if (isUuid(order.tradeId) && isOffchainMarketplace(order.marketplaceAddress)) return 'listing'
  if (order.marketplaceAddress === LEGACY_MARKETPLACE) return 'legacy'
  return null
}

function catalogTradeSource(item: CatalogItem, asListing: boolean): CartSource | null {
  if (!isUuid(item.tradeId) || !isOffchainMarketplace(item.tradeContractAddress || MARKETPLACE_POLYGON)) {
    return null
  }
  return asListing ? 'listing' : 'store'
}

/** True when this listing can ride in one accept() / CollectionStore.buy() checkout. */
export function classifyCartSource(
  item: CatalogItem,
  order?: MarketplaceOrder | null,
  prefer: 'primary' | 'secondary' | 'auto' = 'auto'
): CartSource {
  const primary = itemHasPrimary(item)
  const wantListing = prefer === 'secondary' || (prefer === 'auto' && !primary)
  if (wantListing) {
    const fromOrder = listingSourceFromOrder(order)
    if (fromOrder) return fromOrder
    const fromItem = catalogTradeSource(item, true)
    if (fromItem) return fromItem
  }
  if (primary && !wantListing) {
    const fromItem = catalogTradeSource(item, false)
    if (fromItem) return fromItem
    if (item.isOnSale && !item.tradeId) return 'store'
  }
  const fromOrder = listingSourceFromOrder(order)
  if (fromOrder) return fromOrder
  if (item.isOnSale && !item.tradeId) return 'store'
  const leftover = catalogTradeSource(item, !primary)
  if (leftover) return leftover
  return 'legacy'
}

export function isBatchableSource(source: CartSource): boolean {
  return source === 'store' || source === 'listing'
}

const balanceOfAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  }
] as const

let ethClient: PublicClient | null = null

function ethereumPublicClient(): PublicClient {
  if (!ethClient) {
    ethClient = createPublicClient({
      chain: mainnet,
      transport: http('https://ethereum-rpc.publicnode.com', { timeout: 12_000, retryCount: 1 })
    }) as PublicClient
  }
  return ethClient
}

async function readMana(client: PublicClient, token: Address, owner: Address): Promise<bigint> {
  try {
    return (await client.readContract({
      address: token,
      abi: balanceOfAbi,
      functionName: 'balanceOf',
      args: [owner]
    })) as bigint
  } catch {
    return 0n
  }
}

export async function fetchManaBalances(address: string): Promise<{ ethWei: bigint; polyWei: bigint }> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return { ethWei: 0n, polyWei: 0n }
  const owner = address.toLowerCase() as Address
  const [ethWei, polyWei] = await Promise.all([
    readMana(ethereumPublicClient(), ETHEREUM_MANA, owner),
    readMana(polygonPublicClient as PublicClient, POLYGON_MANA, owner)
  ])
  return { ethWei, polyWei }
}
