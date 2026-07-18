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
}

type OwnedEntry = OwnedWearableEntry

type WearableApiHit = {
  id?: string
  name?: string
  rarity?: string | null
  thumbnail?: string
  data?: { category?: string; hides?: string[]; replaces?: string[] }
}

type BaseCatalogHit = WearableApiHit & {
  i18n?: Array<{ code?: string; text?: string }>
  data?: {
    category?: string
    representations?: Array<{ bodyShapes?: string[] }>
  }
}

const METADATA_CONCURRENCY = 14

const BASE_COLLECTION_ID = 'urn:decentraland:off-chain:base-avatars'

/**
 * Catalyst lambdas — full wallet inventory with tokenIds.
 * Prefer `/users/{addr}/wearables` (includes individualData). Fall back to
 * `wearables-by-owner` which often only returns asset URNs without tokens.
 */
export async function fetchOwnedWearableUrns(
  address: string,
  lambdasUrl: string
): Promise<OwnedEntry[]> {
  const base = lambdasUrl.replace(/\/$/, '')
  const addr = address.toLowerCase()

  // Primary: has individualData[].id / tokenId (required for profile deploy).
  try {
    const res = await fetch(`${base}/users/${addr}/wearables`)
    if (res.ok) {
      const raw = (await res.json()) as
        | OwnedWearableApiRow[]
        | { elements?: OwnedWearableApiRow[]; error?: string }
      const rows = Array.isArray(raw)
        ? raw
        : Array.isArray(raw.elements)
          ? raw.elements
          : null
      if (rows) {
        const expanded = expandOwnedWearableRows(rows).filter((e) => e.urn?.trim())
        if (expanded.length) return expanded
      }
    }
  } catch {
    /* fall through */
  }

  const res = await fetch(`${base}/collections/wearables-by-owner/${addr}`)
  if (!res.ok) {
    throw new Error(`wearables inventory failed (${res.status})`)
  }
  const raw = (await res.json()) as OwnedWearableApiRow[] | { error?: string }
  if (!Array.isArray(raw)) {
    throw new Error('wearables inventory returned unexpected payload')
  }
  return expandOwnedWearableRows(raw).filter((e) => e.urn?.trim())
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
      replaces: hit.data?.replaces
    }
  } catch {
    return null
  }
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

  const urns = [...deduped.keys()]
  let loaded = 0
  const enriched = await mapPool(urns, METADATA_CONCURRENCY, async (urn) => {
    const meta = await fetchWearableMetadata(urn, lambdasUrl)
    loaded++
    onProgress?.(loaded, urns.length)
    const item = meta ?? fallbackItem(urn, deduped.get(urn) ?? 1)
    item.amount = deduped.get(urn) ?? 1
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
      bodyShapes: bodyShapes.length ? bodyShapes : undefined
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
      item.rarity.toLowerCase().includes(q)
    )
  })
}