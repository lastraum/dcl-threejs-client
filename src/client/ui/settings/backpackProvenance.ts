/**
 * Item provenance for backpack detail panes:
 * - owned mint numbers ("#42 / 100") from the marketplace NFT API
 * - fixed per-rarity max supply (marketplace does not return it per token)
 * - collection preview montages (2×2 of the collection's item thumbnails —
 *   the marketplace composes these client-side too; there is no collection
 *   image field on the API)
 * - a **per-wallet** persisted URN → collection/creator store so detail lines
 *   paint instantly on later sessions (reconciled against live data at load)
 */

import { loadCollectionDirectory } from './wearableCollections'

const MARKETPLACE_API = 'https://marketplace-api.decentraland.org/v1'

/** DCL rarity caps (dcl-schemas Rarity.getMaxSupply). `base` items are uncapped. */
export const WEARABLE_RARITY_MAX_SUPPLY: Record<string, number> = {
  unique: 1,
  mythic: 10,
  exotic: 50,
  legendary: 100,
  epic: 1000,
  rare: 5000,
  uncommon: 10000,
  common: 100000
}

export function rarityMaxSupply(rarity: string): number | null {
  return WEARABLE_RARITY_MAX_SUPPLY[rarity.trim().toLowerCase()] ?? null
}

// ---------------------------------------------------------------------------
// Owned mint numbers
// ---------------------------------------------------------------------------

type NftRow = {
  nft?: {
    urn?: string | null
    tokenId?: string | null
    issuedId?: string | null
  }
}

const NFT_PAGE_SIZE = 100
/** 50 × 100 = 5000 NFTs — covers large wardrobes; beyond that mint lines may be missing. */
const NFT_MAX_PAGES = 50

/** Per-wallet memo — `Map<itemUrn lowercase, issuedId>`. */
const mintNumbersCache = new Map<string, Promise<Map<string, string>>>()

/**
 * Issue numbers for every NFT the wallet owns (wearables + emotes).
 * Keys match backpack item URNs from `expandOwnedWearableRows` (`assetUrn:tokenId`).
 * Also indexes the marketplace asset urn alone when it already equals the instance form.
 * A failed fetch clears the memo so the next backpack open retries.
 */
export function loadOwnedMintNumbers(address: string): Promise<Map<string, string>> {
  const key = address.trim().toLowerCase()
  const hit = mintNumbersCache.get(key)
  if (hit) return hit
  const promise = fetchOwnedMintNumbers(key).catch((err) => {
    if (mintNumbersCache.get(key) === promise) mintNumbersCache.delete(key)
    throw err
  })
  mintNumbersCache.set(key, promise)
  return promise
}

/**
 * Resolve issuedId for a backpack item URN (case-insensitive).
 * Tries full instance URN, then last-segment-as-tokenId composite if needed.
 */
export function mintNumberForUrn(map: Map<string, string> | null | undefined, itemUrn: string): string | null {
  if (!map || !itemUrn) return null
  const k = itemUrn.trim().toLowerCase()
  const direct = map.get(k)
  if (direct) return direct
  // Backpack complete URN ends with :tokenId; map may only have assetUrn:tokenId if shapes differ slightly.
  const parts = k.split(':')
  if (parts.length >= 2) {
    const tokenId = parts[parts.length - 1]!
    const asset = parts.slice(0, -1).join(':')
    return map.get(`${asset}:${tokenId}`) ?? null
  }
  return null
}

async function fetchOwnedMintNumbers(address: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let page = 0; page < NFT_MAX_PAGES; page++) {
    const res = await fetch(
      `${MARKETPLACE_API}/nfts?owner=${address}&first=${NFT_PAGE_SIZE}&skip=${page * NFT_PAGE_SIZE}`
    )
    if (!res.ok) throw new Error(`marketplace nfts failed (${res.status})`)
    const raw = (await res.json()) as { data?: NftRow[]; total?: number }
    const rows = Array.isArray(raw.data) ? raw.data : []
    for (const row of rows) {
      const urn = row.nft?.urn?.trim().toLowerCase()
      const tokenId = row.nft?.tokenId != null ? String(row.nft.tokenId).trim() : ''
      const issuedId = row.nft?.issuedId != null ? String(row.nft.issuedId).trim() : ''
      // LAND/names have no urn; unminted rows no issuedId — both useless here.
      if (!urn || !tokenId || !issuedId) continue
      // Primary: complete instance URN (matches expandOwnedWearableRows).
      const complete = urn.endsWith(`:${tokenId}`) ? urn : `${urn}:${tokenId}`
      out.set(complete, issuedId)
      // Secondary: raw marketplace urn (when API already returns the instance form).
      out.set(urn, issuedId)
    }
    const total = typeof raw.total === 'number' ? raw.total : rows.length
    if (rows.length < NFT_PAGE_SIZE || (page + 1) * NFT_PAGE_SIZE >= total) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Collection preview montage
// ---------------------------------------------------------------------------

export type CollectionPreviewTile = { thumbnailUrl: string; rarity: string }

type ItemRow = {
  thumbnail?: string
  rarity?: string
}

const collectionPreviewCache = new Map<string, Promise<CollectionPreviewTile[]>>()

/**
 * Up to 4 item thumbnails (+ rarity for the tile background) from a
 * collections-v2 contract — rendered as the circular montage the marketplace
 * shows for collections. Memoized per contract; failures clear the memo.
 */
export function loadCollectionPreview(contract: string): Promise<CollectionPreviewTile[]> {
  const key = contract.trim().toLowerCase()
  const hit = collectionPreviewCache.get(key)
  if (hit) return hit
  const promise = fetchCollectionPreview(key).catch((err) => {
    if (collectionPreviewCache.get(key) === promise) collectionPreviewCache.delete(key)
    throw err
  })
  collectionPreviewCache.set(key, promise)
  return promise
}

async function fetchCollectionPreview(contract: string): Promise<CollectionPreviewTile[]> {
  const res = await fetch(`${MARKETPLACE_API}/items?contractAddress=${contract}&first=4`)
  if (!res.ok) throw new Error(`marketplace items failed (${res.status})`)
  const raw = (await res.json()) as { data?: ItemRow[] }
  const rows = Array.isArray(raw.data) ? raw.data : []
  return rows
    .map((row) => ({
      thumbnailUrl: row.thumbnail?.trim() ?? '',
      rarity: row.rarity?.trim().toLowerCase() ?? 'common'
    }))
    .filter((tile) => tile.thumbnailUrl)
}

// ---------------------------------------------------------------------------
// Per-wallet persisted URN → collection/creator store
// ---------------------------------------------------------------------------

const CREATOR_STORE_PREFIX = 'd3js-backpack-creators-v2:'
/** Soft cap per wallet — stays under origin quota (~100 bytes/row). */
const CREATOR_STORE_MAX_ENTRIES = 4000

export type CreatorStoreEntry = {
  collectionName?: string
  creatorAddress?: string
  creatorName?: string
  /** Last write time — used for LRU eviction when over cap. */
  at?: number
}

type CreatorStore = Record<string, CreatorStoreEntry>

type ProvenanceAnnotatable = {
  urn: string
  collectionName?: string
  creatorAddress?: string
  creatorName?: string
}

function normalizeWallet(address: string | null | undefined): string | null {
  const a = address?.trim().toLowerCase() ?? ''
  return /^0x[a-f0-9]{40}$/.test(a) ? a : null
}

function creatorStoreKey(wallet: string): string {
  return `${CREATOR_STORE_PREFIX}${wallet}`
}

function readCreatorStore(wallet: string): CreatorStore {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(creatorStoreKey(wallet))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as CreatorStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeCreatorStore(wallet: string, store: CreatorStore): void {
  if (typeof window === 'undefined') return
  let entries = Object.entries(store)
  if (entries.length > CREATOR_STORE_MAX_ENTRIES) {
    // LRU: keep most recently written rows.
    entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
    entries = entries.slice(0, CREATOR_STORE_MAX_ENTRIES)
  }
  try {
    localStorage.setItem(creatorStoreKey(wallet), JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* quota — provenance is a cache, live annotation still works */
  }
}

function storeKey(urn: string): string {
  return urn.trim().toLowerCase()
}

/**
 * "0x00c5…1d23" — the short-address fallback the annotation pass uses when the
 * marketplace directory fetch fails. Never persist or apply these: they would
 * paint junk instantly on every later session until the real name overwrites.
 */
function isFallbackName(value: string | undefined): boolean {
  return !!value && /^0x[0-9a-f]{4}/i.test(value) && value.includes('…')
}

/**
 * Synchronously fill missing collection/creator fields from the **per-wallet**
 * persisted store — call before first render so detail lines paint instantly.
 * No-ops when address is missing (guest / catalog-only).
 */
export function applyCreatorStore(
  items: ProvenanceAnnotatable[],
  address: string | null | undefined
): boolean {
  const wallet = normalizeWallet(address)
  if (!wallet) return false
  const store = readCreatorStore(wallet)
  let changed = false
  for (const item of items) {
    const entry = store[storeKey(item.urn)]
    if (!entry) continue
    if (!item.collectionName && entry.collectionName && !isFallbackName(entry.collectionName)) {
      item.collectionName = entry.collectionName
      changed = true
    }
    if (!item.creatorAddress && entry.creatorAddress) {
      item.creatorAddress = entry.creatorAddress
      changed = true
    }
    if (!item.creatorName && entry.creatorName && !isFallbackName(entry.creatorName)) {
      item.creatorName = entry.creatorName
      changed = true
    }
  }
  return changed
}

/** Write resolved collection/creator info for this wallet so the next session skips the wait. */
export function persistCreatorStore(
  items: ProvenanceAnnotatable[],
  address: string | null | undefined
): void {
  const wallet = normalizeWallet(address)
  if (!wallet) return
  const store = readCreatorStore(wallet)
  const now = Date.now()
  let changed = false
  for (const item of items) {
    // Drop short-address fallbacks — persist only real resolved names.
    const collectionName = isFallbackName(item.collectionName) ? undefined : item.collectionName
    const creatorName = isFallbackName(item.creatorName) ? undefined : item.creatorName
    if (!collectionName && !item.creatorAddress && !creatorName) continue
    const key = storeKey(item.urn)
    const prev = store[key]
    if (
      prev &&
      prev.collectionName === collectionName &&
      prev.creatorAddress === item.creatorAddress &&
      prev.creatorName === creatorName
    ) {
      // Touch LRU without rewriting if nothing else changed.
      if ((prev.at ?? 0) < now - 60_000) {
        store[key] = { ...prev, at: now }
        changed = true
      }
      continue
    }
    store[key] = {
      collectionName,
      creatorAddress: item.creatorAddress,
      creatorName,
      at: now
    }
    changed = true
  }
  if (changed) writeCreatorStore(wallet, store)
}

// ---------------------------------------------------------------------------
// Launch warm-up
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget at login: pre-fetch the wallet's mint numbers and the
 * marketplace collection directory so the backpack's provenance lines resolve
 * immediately when it first opens. Failures are silent — the backpack
 * re-fetches on demand.
 */
export function warmBackpackProvenance(address: string): void {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address.trim())) return
  void loadOwnedMintNumbers(address).catch(() => {})
  void loadCollectionDirectory().catch(() => {})
}
