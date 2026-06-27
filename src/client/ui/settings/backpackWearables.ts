import { assetUrnFromCompleteUrn, BODY_SHAPE_URN } from '../../../avatar/constants'
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
}

type OwnedEntry = { urn: string; amount?: number }

type WearableApiHit = {
  id?: string
  name?: string
  rarity?: string | null
  thumbnail?: string
  data?: { category?: string }
}

const METADATA_CONCURRENCY = 14

/** Catalyst lambdas — full wallet inventory (not just equipped profile slots). */
export async function fetchOwnedWearableUrns(
  address: string,
  lambdasUrl: string
): Promise<OwnedEntry[]> {
  const base = lambdasUrl.replace(/\/$/, '')
  const res = await fetch(`${base}/collections/wearables-by-owner/${address.toLowerCase()}`)
  if (!res.ok) {
    throw new Error(`wearables-by-owner failed (${res.status})`)
  }
  const raw = (await res.json()) as OwnedEntry[] | { error?: string }
  if (!Array.isArray(raw)) {
    throw new Error('wearables-by-owner returned unexpected payload')
  }
  return raw.filter((e) => e.urn?.trim())
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

function guessCategoryFromUrn(urn: string): WearableCategory | 'unknown' {
  const low = urn.toLowerCase()
  const colonHit = low.match(/:([a-z_]+)$/)
  const tail = colonHit?.[1] ?? ''
  const patterns: Array<[RegExp, WearableCategory]> = [
    [/body_shape|basemale|basefemale/, 'body_shape'],
    [/\bhair\b|_hair|hair_/, 'hair'],
    [/upper_body|hoodie|jacket|shirt|sweater|torso/, 'upper_body'],
    [/lower_body|pants|jeans|shorts|skirt/, 'lower_body'],
    [/\bfeet\b|shoes|sneaker|boot|sandal/, 'feet'],
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
      amount: 1
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