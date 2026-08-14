import { assetUrnFromCompleteUrn, BODY_SHAPE_URN } from '../../../avatar/constants'
import {
  expandOwnedWearableRows,
  type OwnedWearableApiRow,
  type OwnedWearableEntry
} from '../../../avatar/ownedWearables'
import type { AvatarProfile, WearableCategory } from '../../../avatar/types'
import {
  filterEquippedWearables,
  guessWearableRarity,
  wearableShortLabel,
  wearableThumbnailUrl,
  type WearableDisplayCard
} from '../profile/wearableThumb'

export type BackpackWearableItem = WearableDisplayCard & {
  category: WearableCategory | 'unknown'
  amount: number
  /** Free base-avatars catalog item (not wallet-owned). */
  isBase?: boolean
  /** Body-shape URNs with a representation; undefined = fits all shapes. */
  bodyShapes?: string[]
  /** Categories this wearable hides/replaces when equipped (ADR-239). */
  hides?: string[]
  replaces?: string[]
  /** Creator-authored description from Catalyst metadata. */
  description?: string
  /** Marketplace collection display name (annotated async — see wearableCollections). */
  collectionName?: string
  /** Collection creator wallet (lowercase) + resolved profile name. */
  creatorAddress?: string
  creatorName?: string
}

type OwnedEntry = OwnedWearableEntry

type WearableApiHit = {
  id?: string
  name?: string
  description?: string
  rarity?: string | null
  thumbnail?: string
  data?: { category?: string; hides?: string[]; replaces?: string[] }
}

type BaseCatalogHit = WearableApiHit & {
  i18n?: Array<{ code?: string; text?: string }>
  data?: {
    category?: string
    hides?: string[]
    replaces?: string[]
    representations?: Array<{ bodyShapes?: string[] }>
  }
}

const METADATA_CONCURRENCY = 14

const BASE_COLLECTION_ID = 'urn:decentraland:off-chain:base-avatars'

const INVENTORY_PAGE_SIZE = 100
const INVENTORY_MAX_PAGES = 50

/**
 * Catalyst lambdas — full wallet inventory with tokenIds.
 * Prefer `/users/{addr}/wearables` (includes individualData; PAGINATED — walk
 * every page or wallets with >100 wearables silently lose inventory). Fall back
 * to `wearables-by-owner` which often only returns asset URNs without tokens.
 *
 * When both an asset URN and instance URN(s) exist for the same item, drop the
 * asset-only row — trade settle needs the packed ERC-721 token id.
 */
export async function fetchOwnedWearableUrns(
  address: string,
  lambdasUrl: string
): Promise<OwnedEntry[]> {
  const base = lambdasUrl.replace(/\/$/, '')
  const addr = address.toLowerCase()

  const byKey = new Map<string, OwnedEntry>()
  const addAll = (entries: OwnedEntry[]) => {
    for (const e of entries) {
      const u = e.urn?.trim()
      if (!u) continue
      const k = u.toLowerCase()
      if (!byKey.has(k)) byKey.set(k, { urn: u, amount: e.amount })
    }
  }

  // Primary: /users/{addr}/wearables (individualData + PAGINATED).
  try {
    const rows: OwnedWearableApiRow[] = []
    for (let pageNum = 1; pageNum <= INVENTORY_MAX_PAGES; pageNum++) {
      const res = await fetch(
        `${base}/users/${addr}/wearables?pageSize=${INVENTORY_PAGE_SIZE}&pageNum=${pageNum}`
      )
      if (!res.ok) break
      const raw = (await res.json()) as
        | OwnedWearableApiRow[]
        | { elements?: OwnedWearableApiRow[]; totalAmount?: number; error?: string }
      if (Array.isArray(raw)) {
        // Legacy unpaginated shape — the response is already the full list.
        rows.push(...raw)
        break
      }
      if (!Array.isArray(raw.elements)) break
      rows.push(...raw.elements)
      const total = typeof raw.totalAmount === 'number' ? raw.totalAmount : rows.length
      if (raw.elements.length < INVENTORY_PAGE_SIZE || rows.length >= total) break
    }
    if (rows.length) {
      addAll(expandOwnedWearableRows(rows))
    }
  } catch {
    /* continue to merge secondary */
  }

  // Secondary: wearables-by-owner often has different individualData coverage — merge both.
  try {
    const res = await fetch(`${base}/collections/wearables-by-owner/${addr}`)
    if (res.ok) {
      const raw = (await res.json()) as OwnedWearableApiRow[] | { error?: string }
      if (Array.isArray(raw)) {
        addAll(expandOwnedWearableRows(raw))
      }
    }
  } catch {
    /* ignore */
  }

  // Prefer instance URNs over bare asset URNs (…:itemId without tokenId).
  const assetsWithInstances = new Set<string>()
  for (const e of byKey.values()) {
    const asset = assetUrnFromCompleteUrn(e.urn).toLowerCase()
    if (e.urn.toLowerCase() !== asset) assetsWithInstances.add(asset)
  }
  const merged = [...byKey.values()].filter((e) => {
    const asset = assetUrnFromCompleteUrn(e.urn).toLowerCase()
    if (e.urn.toLowerCase() === asset && assetsWithInstances.has(asset)) return false
    return true
  })
  if (merged.length) return merged
  throw new Error('wearables inventory empty or failed')
}

function fallbackItem(urn: string, amount = 1): BackpackWearableItem {
  const assetUrn = assetUrnFromCompleteUrn(urn)
  return {
    urn,
    name: wearableShortLabel(assetUrn),
    rarity: guessWearableRarity(assetUrn),
    thumbnailUrl: wearableThumbnailUrl(assetUrn),
    category: guessCategoryFromUrn(assetUrn),
    amount
  }
}

/**
 * Complete free base-avatar hair catalog (Catalyst off-chain collection).
 * Several omit the word "hair" — without this set equip fallbacks mark them `unknown`.
 */
const BASE_HAIR_SLUGS = new Set([
  'casual_hair_01',
  'casual_hair_02',
  'casual_hair_03',
  'cool_hair',
  'cornrows',
  'curly_hair',
  'curtained_hair',
  'double_bun',
  'hair_anime_01',
  'hair_bun',
  'hair_coolshortstyle',
  'hair_f_oldie',
  'hair_f_oldie_02',
  'hair_oldie',
  'hair_punk',
  'hair_stylish_hair',
  'hair_undere',
  'keanu_hair',
  'modern_hair',
  'moptop',
  'pompous',
  'pony_tail',
  'punk',
  'rasta',
  'semi_afro',
  'semi_bold',
  'short_hair',
  'shoulder_bob_hair',
  'shoulder_hair',
  'slicked_hair',
  'standard_hair',
  'tall_front_01',
  'two_tails'
])

function guessCategoryFromUrn(urn: string): WearableCategory | 'unknown' {
  const low = urn.toLowerCase()
  const colonHit = low.match(/:([a-z0-9_]+)$/)
  const tail = colonHit?.[1] ?? ''
  if (BASE_HAIR_SLUGS.has(tail)) {
    return 'hair'
  }
  const patterns: Array<[RegExp, WearableCategory]> = [
    [/body_shape|basemale|basefemale/, 'body_shape'],
    [
      /\bhair\b|_hair|hair_|mohawk|cornrow|rasta|pompous|semi_bold|semi_afro|double_bun|two_tails|moptop|pony_tail|tall_front/,
      'hair'
    ],
    [/upper_body|hoodie|jacket|shirt|sweater|torso/, 'upper_body'],
    [/lower_body|pants|jeans|shorts|skirt/, 'lower_body'],
    [/\bfeet\b|shoes|sneaker|boot|sandal|espadrille/, 'feet'],
    [/eyebrow/, 'eyebrows'],
    [/\beyes\b|_eyes/, 'eyes'],
    [/\bmouth\b|_mouth/, 'mouth'],
    [/facial_hair|beard|mustache/, 'facial_hair'],
    [/helmet/, 'helmet'],
    [/\bhat\b|cap|crown/, 'hat'],
    [/mask/, 'mask'],
    [/eyewear|glasses|sunglass/, 'eyewear'],
    [/earring/, 'earring'],
    [/tiara/, 'tiara'],
    [/top_head/, 'top_head'],
    [/hands_wear|glove/, 'hands_wear'],
    [/\bskin\b/, 'skin']
  ]
  for (const [re, cat] of patterns) {
    if (re.test(low) || re.test(tail)) return cat
  }
  if (low.includes(':upper_body:') || low.includes('/upper_body')) return 'upper_body'
  if (low.includes(':lower_body:') || low.includes('/lower_body')) return 'lower_body'
  if (low.includes(':feet:') || low.includes('/feet')) return 'feet'
  return 'unknown'
}

function itemFromApiHit(hit: WearableApiHit, urn: string, assetUrn: string): BackpackWearableItem {
  const rarity = (hit.rarity?.trim().toLowerCase() || guessWearableRarity(assetUrn)).toLowerCase()
  const categoryRaw = hit.data?.category?.trim().toLowerCase()
  const category = (categoryRaw as WearableCategory | undefined) ?? guessCategoryFromUrn(assetUrn)
  return {
    urn,
    name: hit.name?.trim() || wearableShortLabel(assetUrn),
    rarity,
    thumbnailUrl: hit.thumbnail?.trim() || wearableThumbnailUrl(assetUrn),
    category,
    amount: 1,
    hides: hit.data?.hides,
    replaces: hit.data?.replaces,
    description: hit.description?.trim() || undefined
  }
}

async function fetchWearableMetadata(
  urn: string,
  lambdasUrl: string
): Promise<BackpackWearableItem | null> {
  const assetUrn = assetUrnFromCompleteUrn(urn)
  const base = lambdasUrl.replace(/\/$/, '')
  try {
    const url = `${base}/collections/wearables?wearableId=${encodeURIComponent(assetUrn)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const raw = (await res.json()) as { wearables?: WearableApiHit[] }
    const hit = raw.wearables?.[0]
    if (!hit) return null
    return itemFromApiHit(hit, urn, assetUrn)
  } catch {
    return null
  }
}

const METADATA_BATCH_SIZE = 30

/**
 * Batch metadata lookup — `/collections/wearables` accepts repeated wearableId
 * params. One request per ~30 asset URNs instead of one per item; a paginated
 * inventory of hundreds was rate-limiting the per-item pattern into blank cards.
 * Returns hits keyed by lowercase asset URN.
 */
async function fetchWearableMetadataBatch(
  assetUrns: string[],
  lambdasUrl: string
): Promise<Map<string, WearableApiHit>> {
  const base = lambdasUrl.replace(/\/$/, '')
  const out = new Map<string, WearableApiHit>()
  const qs = assetUrns.map((u) => `wearableId=${encodeURIComponent(u)}`).join('&')
  try {
    const res = await fetch(`${base}/collections/wearables?${qs}`)
    if (!res.ok) return out
    const raw = (await res.json()) as { wearables?: WearableApiHit[] }
    for (const hit of raw.wearables ?? []) {
      const id = hit.id?.trim().toLowerCase()
      if (id) out.set(id, hit)
    }
  } catch {
    /* partial results — missing urns fall back below */
  }
  return out
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

/** Resolve owned URNs into display cards (metadata fetched in parallel batches). */
export async function loadBackpackWearables(
  address: string,
  lambdasUrl: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<BackpackWearableItem[]> {
  const owned = await fetchOwnedWearableUrns(address, lambdasUrl)
  if (!owned.length) return []

  const deduped = new Map<string, number>()
  for (const entry of owned) {
    const urn = entry.urn.trim()
    deduped.set(urn, (deduped.get(urn) ?? 0) + (entry.amount ?? 1))
  }

  // Collapse duplicate tokens of the same asset into ONE card: first token's complete
  // urn stays as the equip target, amount counts every copy in the wallet.
  // (Original casing kept for requests — v1/off-chain URNs are case-sensitive.)
  const grouped = new Map<string, { urn: string; assetUrn: string; amount: number }>()
  for (const [urn, amount] of deduped) {
    const assetUrn = assetUrnFromCompleteUrn(urn)
    const key = assetUrn.toLowerCase()
    const group = grouped.get(key)
    if (group) group.amount += amount
    else grouped.set(key, { urn, assetUrn, amount })
  }
  const groups = [...grouped.values()]
  const batches: string[][] = []
  for (let i = 0; i < groups.length; i += METADATA_BATCH_SIZE) {
    batches.push(groups.slice(i, i + METADATA_BATCH_SIZE).map((g) => g.assetUrn))
  }

  const metaByAsset = new Map<string, WearableApiHit>()
  let loaded = 0
  await mapPool(batches, 4, async (batch) => {
    const hits = await fetchWearableMetadataBatch(batch, lambdasUrl)
    for (const [id, hit] of hits) metaByAsset.set(id, hit)
    loaded += batch.length
    onProgress?.(Math.min(loaded, groups.length), groups.length)
  })

  const enriched = groups.map(({ urn, assetUrn, amount }) => {
    const hit = metaByAsset.get(assetUrn.toLowerCase())
    const item = hit ? itemFromApiHit(hit, urn, assetUrn) : fallbackItem(urn, amount)
    item.amount = amount
    return item
  })

  enriched.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return enriched
}

let baseCatalogCache: { lambdasUrl: string; promise: Promise<BackpackWearableItem[]> } | null =
  null

/**
 * Full base-avatars catalog (free off-chain wearables, ~282 items incl. the two
 * body shapes) — one lambdas call, unpaginated. Memoized per session; a failed
 * fetch clears the memo so the next backpack open retries. Body shapes are kept
 * and surfaced as switch tiles (see BackpackView.switchBodyShape).
 */
export function loadBaseWearableCatalog(lambdasUrl: string): Promise<BackpackWearableItem[]> {
  if (baseCatalogCache?.lambdasUrl === lambdasUrl) return baseCatalogCache.promise
  const promise = fetchBaseWearableCatalog(lambdasUrl).catch((err) => {
    if (baseCatalogCache?.promise === promise) baseCatalogCache = null
    throw err
  })
  baseCatalogCache = { lambdasUrl, promise }
  return promise
}

async function fetchBaseWearableCatalog(lambdasUrl: string): Promise<BackpackWearableItem[]> {
  const base = lambdasUrl.replace(/\/$/, '')
  const res = await fetch(
    `${base}/collections/wearables?collectionId=${encodeURIComponent(BASE_COLLECTION_ID)}`
  )
  if (!res.ok) throw new Error(`base wearables catalog failed (${res.status})`)
  const raw = (await res.json()) as { wearables?: BaseCatalogHit[] }
  const hits = Array.isArray(raw.wearables) ? raw.wearables : []

  const items: BackpackWearableItem[] = []
  for (const hit of hits) {
    const urn = hit.id?.trim()
    if (!urn) continue
    const categoryRaw = hit.data?.category?.trim().toLowerCase()
    const category = (categoryRaw as WearableCategory | undefined) ?? guessCategoryFromUrn(urn)
    // body_shape (BaseMale/BaseFemale) is kept: the backpack shows both as selectable
    // tiles and clicking one switches profile.bodyShape rather than equipping a slot.
    const enName = hit.i18n?.find((row) => row.code === 'en')?.text?.trim()
    const bodyShapes = [
      ...new Set((hit.data?.representations ?? []).flatMap((rep) => rep.bodyShapes ?? []))
    ]
    items.push({
      urn,
      name: enName || hit.name?.trim() || wearableShortLabel(urn),
      rarity: 'base',
      thumbnailUrl: hit.thumbnail?.trim() || wearableThumbnailUrl(urn),
      category,
      amount: 1,
      isBase: true,
      bodyShapes: bodyShapes.length ? bodyShapes : undefined,
      hides: hit.data?.hides,
      replaces: hit.data?.replaces,
      description: hit.description?.trim() || undefined
    })
  }
  return items
}

/** Owned inventory + free base catalog, deduped by asset URN (owned metadata wins). */
export function mergeBaseIntoInventory(
  items: BackpackWearableItem[],
  baseItems: BackpackWearableItem[]
): BackpackWearableItem[] {
  const seen = new Set(items.map((i) => assetUrnFromCompleteUrn(i.urn)))
  const merged = [...items]
  for (const item of baseItems) {
    const asset = assetUrnFromCompleteUrn(item.urn)
    if (seen.has(asset)) continue
    seen.add(asset)
    merged.push(item)
  }
  merged.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return merged
}

/** Profile equipped URNs merged into inventory when Catalyst omits free/base items. */
export function mergeEquippedIntoInventory(
  items: BackpackWearableItem[],
  equippedUrns: string[]
): BackpackWearableItem[] {
  const seen = new Set(items.map((i) => assetUrnFromCompleteUrn(i.urn)))
  const merged = [...items]
  for (const urn of filterEquippedWearables(equippedUrns)) {
    const asset = assetUrnFromCompleteUrn(urn)
    if (seen.has(asset)) continue
    seen.add(asset)
    merged.push(fallbackItem(urn))
  }
  return merged
}

/** Profile-equipped slots — Catalyst collections metadata (not marketplace inventory). */
export async function loadEquippedWearablesByCategory(
  profile: Pick<AvatarProfile, 'bodyShape' | 'wearables'>,
  lambdasUrl: string
): Promise<Map<WearableCategory, BackpackWearableItem>> {
  const map = new Map<WearableCategory, BackpackWearableItem>()

  const bodyUrn =
    profile.wearables.find((u) => u.includes('basemale') || u.includes('basefemale')) ??
    BODY_SHAPE_URN[profile.bodyShape]
  if (bodyUrn) {
    const bodyItem = (await fetchWearableMetadata(bodyUrn, lambdasUrl)) ?? fallbackItem(bodyUrn)
    bodyItem.category = 'body_shape'
    map.set('body_shape', bodyItem)
  }

  const urns = filterEquippedWearables(profile.wearables)
  if (urns.length) {
    const items = await mapPool(urns, METADATA_CONCURRENCY, async (urn) => {
      return (await fetchWearableMetadata(urn, lambdasUrl)) ?? fallbackItem(urn)
    })
    for (const item of items) {
      if (item.category === 'unknown') continue
      map.set(item.category, item)
    }
  }

  return map
}

export function filterBackpackWearables(
  items: BackpackWearableItem[],
  category: WearableCategory | 'all',
  search = ''
): BackpackWearableItem[] {
  const q = search.trim().toLowerCase()
  return items.filter((item) => {
    if (category !== 'all' && item.category !== category) return false
    if (!q) return true
    return (
      item.name.toLowerCase().includes(q) ||
      item.urn.toLowerCase().includes(q) ||
      item.rarity.toLowerCase().includes(q) ||
      (item.collectionName?.toLowerCase().includes(q) ?? false) ||
      (item.creatorName?.toLowerCase().includes(q) ?? false)
    )
  })
}