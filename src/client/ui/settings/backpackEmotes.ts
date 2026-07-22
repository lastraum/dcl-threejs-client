import { assetUrnFromCompleteUrn, PEER_URL } from '../../../avatar/constants'
import {
  baseEmoteSlugFromRef,
  baseEmoteUrn,
  emoteLabel,
  listBaseEmoteCatalog
} from '../../../avatar/profileEmotes'
import {
  expandOwnedWearableRows,
  type OwnedWearableApiRow
} from '../../../avatar/ownedWearables'
import {
  guessWearableRarity,
  wearableShortLabel,
  wearableThumbnailUrl
} from '../profile/wearableThumb'

export type BackpackEmoteItem = {
  urn: string
  name: string
  rarity: string
  thumbnailUrl: string
  amount: number
  /** Free base catalog vs wallet-owned vs only on profile wheel. */
  source: 'base' | 'owned' | 'equipped'
  /** Marketplace collection display name (annotated async — see wearableCollections). */
  collectionName?: string
  /** Collection creator wallet (lowercase) + resolved profile name. */
  creatorAddress?: string
  creatorName?: string
}

const METADATA_CONCURRENCY = 12

type EmoteEntityMeta = {
  id?: string
  name?: string
  rarity?: string | null
  thumbnail?: string
  image?: string
  i18n?: Array<{ code?: string; text?: string }>
  emoteDataADR74?: { loop?: boolean }
}

/**
 * Catalyst lambdas — wallet emote inventory (same shape as wearables:
 * `/users/{addr}/emotes` with optional individualData token rows).
 */
export async function fetchOwnedEmoteUrns(
  address: string,
  lambdasUrl: string
): Promise<Array<{ urn: string; amount?: number }>> {
  const base = lambdasUrl.replace(/\/$/, '')
  const addr = address.toLowerCase()

  try {
    const res = await fetch(`${base}/users/${addr}/emotes`)
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

  try {
    const res = await fetch(`${base}/collections/emotes-by-owner/${addr}`)
    if (!res.ok) return []
    const raw = (await res.json()) as OwnedWearableApiRow[] | { error?: string }
    if (!Array.isArray(raw)) return []
    return expandOwnedWearableRows(raw).filter((e) => e.urn?.trim())
  } catch {
    return []
  }
}

function emoteThumbnailUrl(urn: string, peerUrl = PEER_URL): string {
  // Same collections contents thumbnail path as wearables (works for base-emotes + v2).
  return wearableThumbnailUrl(assetUrnFromCompleteUrn(urn), peerUrl)
}

function fallbackEmoteItem(urn: string, amount = 1, source: BackpackEmoteItem['source']): BackpackEmoteItem {
  const asset = assetUrnFromCompleteUrn(urn)
  const slug = baseEmoteSlugFromRef(urn)
  return {
    urn,
    name: slug ? emoteLabel(slug) : wearableShortLabel(asset),
    rarity: slug || asset.includes('base-emotes') ? 'base' : guessWearableRarity(asset),
    thumbnailUrl: emoteThumbnailUrl(urn),
    amount,
    source
  }
}

async function fetchEmoteMetadataFromEntities(
  urns: string[],
  peerUrl: string
): Promise<Map<string, EmoteEntityMeta>> {
  const out = new Map<string, EmoteEntityMeta>()
  if (!urns.length) return out

  const pointers = [...new Set(urns.map((u) => assetUrnFromCompleteUrn(u)))]
  const root = peerUrl.replace(/\/$/, '')

  // Batch active entity lookups (Catalyst max ~100 pointers per call is fine for small batches).
  for (let i = 0; i < pointers.length; i += 40) {
    const batch = pointers.slice(i, i + 40)
    try {
      const res = await fetch(`${root}/content/entities/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointers: batch })
      })
      if (!res.ok) continue
      const entities = (await res.json()) as Array<{
        pointers?: string[]
        metadata?: EmoteEntityMeta
        content?: Array<{ file: string; hash: string }>
      }>
      for (const entity of entities) {
        const meta = entity.metadata
        if (!meta) continue
        const pointer = (entity.pointers?.[0] ?? meta.id ?? '').toLowerCase()
        if (!pointer) continue
        const thumbFile = meta.thumbnail || 'thumbnail.png'
        const thumbHash = entity.content?.find(
          (c) => c.file === thumbFile || c.file.endsWith('/' + thumbFile)
        )?.hash
        const resolved: EmoteEntityMeta = {
          ...meta,
          thumbnail: thumbHash
            ? `${root}/content/contents/${encodeURIComponent(thumbHash)}`
            : meta.thumbnail
        }
        out.set(pointer, resolved)
        if (meta.id) out.set(meta.id.toLowerCase(), resolved)
      }
    } catch {
      /* skip batch */
    }
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
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

function enrichFromMeta(
  urn: string,
  amount: number,
  source: BackpackEmoteItem['source'],
  meta: EmoteEntityMeta | undefined
): BackpackEmoteItem {
  const base = fallbackEmoteItem(urn, amount, source)
  if (!meta) return base
  const name =
    meta.name?.trim() ||
    meta.i18n?.find((e) => e.code === 'en')?.text?.trim() ||
    base.name
  const rarity = (meta.rarity?.trim().toLowerCase() || base.rarity).toLowerCase()
  let thumbnailUrl = base.thumbnailUrl
  if (meta.thumbnail?.startsWith('http')) thumbnailUrl = meta.thumbnail
  else if (meta.image?.startsWith('http')) thumbnailUrl = meta.image
  return { ...base, name, rarity, thumbnailUrl }
}

/**
 * Full emote backpack list: free base catalog + wallet-owned + profile-equipped
 * (so wheel-only URNs still appear). Metadata from Catalyst content entities;
 * thumbnails from lambdas collections/contents (same as wearables).
 */
export async function loadBackpackEmotes(
  address: string | undefined,
  lambdasUrl: string,
  equippedUrns: string[] = [],
  peerUrl = PEER_URL
): Promise<BackpackEmoteItem[]> {
  const owned = address ? await fetchOwnedEmoteUrns(address, lambdasUrl) : []
  const byAsset = new Map<string, BackpackEmoteItem>()

  const put = (item: BackpackEmoteItem): void => {
    const key = assetUrnFromCompleteUrn(item.urn)
    const prev = byAsset.get(key)
    if (!prev) {
      byAsset.set(key, item)
      return
    }
    // Prefer owned token URNs; keep richer names/rarity.
    const preferOwned = item.source === 'owned' && prev.source !== 'owned'
    const keepUrn = preferOwned ? item.urn : prev.urn
    byAsset.set(key, {
      urn: keepUrn,
      name: item.name && item.name !== wearableShortLabel(key) ? item.name : prev.name,
      rarity: item.rarity !== 'common' && item.rarity !== 'base' ? item.rarity : prev.rarity,
      thumbnailUrl: item.thumbnailUrl || prev.thumbnailUrl,
      amount: Math.max(prev.amount, item.amount),
      source: preferOwned || prev.source === 'owned' ? 'owned' : item.source === 'equipped' ? 'equipped' : prev.source
    })
  }

  for (const base of listBaseEmoteCatalog()) {
    put(fallbackEmoteItem(base.urn, 1, 'base'))
  }
  for (const entry of owned) {
    put(fallbackEmoteItem(entry.urn, entry.amount ?? 1, 'owned'))
  }
  for (const urn of equippedUrns) {
    if (!urn?.trim()) continue
    put(fallbackEmoteItem(urn.trim(), 1, 'equipped'))
  }

  const list = [...byAsset.values()]
  const metaMap = await fetchEmoteMetadataFromEntities(
    list.map((i) => i.urn),
    peerUrl
  )

  const enriched = await mapPool(list, METADATA_CONCURRENCY, async (item) => {
    const asset = assetUrnFromCompleteUrn(item.urn).toLowerCase()
    const meta = metaMap.get(asset) ?? metaMap.get(item.urn.toLowerCase())
    return enrichFromMeta(item.urn, item.amount, item.source, meta)
  })

  enriched.sort((a, b) => {
    // Owned first, then base; name within group.
    const rank = (s: BackpackEmoteItem['source']) => (s === 'owned' ? 0 : s === 'equipped' ? 1 : 2)
    const d = rank(a.source) - rank(b.source)
    if (d !== 0) return d
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  return enriched
}

export function filterBackpackEmotes(items: BackpackEmoteItem[], search = ''): BackpackEmoteItem[] {
  const q = search.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (i) =>
      i.name.toLowerCase().includes(q) ||
      i.urn.toLowerCase().includes(q) ||
      i.rarity.toLowerCase().includes(q) ||
      (i.collectionName?.toLowerCase().includes(q) ?? false) ||
      (i.creatorName?.toLowerCase().includes(q) ?? false)
  )
}

/** Ensure free base emotes always present even without wallet. */
export function baseEmoteCatalogAsItems(): BackpackEmoteItem[] {
  return listBaseEmoteCatalog().map((e) => fallbackEmoteItem(e.urn, 1, 'base'))
}

export { baseEmoteUrn, emoteLabel }
