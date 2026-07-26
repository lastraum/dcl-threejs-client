import { assetUrnFromCompleteUrn } from '../../../avatar/constants'

/** Catalyst collections thumbnail URL — same source as BackpackView. */
const DEFAULT_CATALYST = 'https://peer.decentraland.org'
const MARKETPLACE_API = 'https://marketplace-api.decentraland.org'

/** `urn:decentraland:matic:collections-v2:0x…:itemId:tokenId…` */
export function parseCollectionsV2WearableUrn(
  urn: string
): { contract: string; itemId: string } | null {
  const match =
    /^urn:decentraland:(?:matic|ethereum):collections-v2:(0x[a-fA-F0-9]{40}):(\d+):/i.exec(urn.trim())
  if (!match) return null
  return { contract: match[1].toLowerCase(), itemId: match[2] }
}

/** Catalyst content hash, IPFS id, or absolute URL → browser-loadable image URL. */
import { rewriteCatalystUrl } from '../../../network/catalyst/rewriteCatalystUrl'

export function resolveContentImageUrl(
  raw: string | null | undefined,
  peerUrl = DEFAULT_CATALYST
): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return rewriteCatalystUrl(value, peerUrl) ?? value
  if (value.startsWith('ipfs://')) {
    const hash = value.slice('ipfs://'.length).replace(/^ipfs\//, '')
    return `${peerUrl.replace(/\/$/, '')}/content/contents/${hash}`
  }
  if (/^(bafy|bafk|Qm)/i.test(value)) {
    return `${peerUrl.replace(/\/$/, '')}/content/contents/${value}`
  }
  return null
}

export function wearableThumbnailUrl(urn: string, peerUrl = DEFAULT_CATALYST): string {
  const base = peerUrl.replace(/\/$/, '')
  const assetUrn = assetUrnFromCompleteUrn(urn)
  return `${base}/lambdas/collections/contents/${encodeURIComponent(assetUrn)}/thumbnail`
}

export function wearableShortLabel(urn: string): string {
  const parts = urn.split(':')
  let tail = parts[parts.length - 1] ?? urn
  // collections-v2 profile URNs end in a long tokenId — the itemId reads better.
  if (/^\d{10,}$/.test(tail) && parts[3] === 'collections-v2' && parts[5]) {
    tail = parts[5]
  }
  return tail.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function guessWearableRarity(urn: string): string {
  const low = urn.toLowerCase()
  if (low.includes('legendary')) return 'legendary'
  if (low.includes('epic')) return 'epic'
  if (low.includes('rare')) return 'rare'
  if (low.includes('uncommon')) return 'uncommon'
  if (low.includes('base') || low.includes('default')) return 'base'
  return 'common'
}

/** Body shape URNs only (legacy filter for general equipped lists). */
export function filterEquippedWearables(wearables: string[]): string[] {
  return wearables.filter((u) => {
    const low = u.toLowerCase()
    return !low.includes('basemale') && !low.includes('basefemale')
  })
}

/**
 * True for free default wardrobe: body shape + off-chain base-avatars
 * (hair, eyes, default clothes, etc.). Photo review hides these.
 */
export function isDefaultBaseWearableUrn(urn: string): boolean {
  const u = urn.trim().toLowerCase()
  if (!u) return true
  if (u.includes('basemale') || u.includes('basefemale')) return true
  if (u.includes('off-chain:base-avatars') || u.includes(':base-avatars:')) return true
  if (u.startsWith('dcl://base-avatars/')) return true
  return false
}

/** Collection / NFT wearables only — no default base avatar pieces. */
export function filterNonDefaultWearables(wearables: string[]): string[] {
  return wearables.filter((u) => !isDefaultBaseWearableUrn(u))
}

export type WearableDisplayCard = {
  urn: string
  name: string
  rarity: string
  thumbnailUrl: string
}

export const WEARABLE_RARITY_COLORS: Record<string, string> = {
  legendary: '#A14BF3',
  epic: '#438FFF',
  rare: '#34CE76',
  uncommon: '#FF8362',
  common: '#73D3D3',
  base: '#73D3D3',
  unique: '#FEA217',
  // Announcement-era red was retired — marketplace/schemas settled on lime green.
  exotic: '#CAFF73',
  mythic: '#FF4BED'
}

/** Solid cell fills — matches DCL rarity swatches (no gradients). */
export const WEARABLE_RARITY_BACKGROUNDS: Record<string, string> = {
  legendary: '#A14BF3',
  epic: '#438FFF',
  rare: '#34CE76',
  uncommon: '#FF8362',
  common: '#73D3D3',
  base: '#73D3D3',
  unique: '#FEA217',
  exotic: '#CAFF73',
  mythic: '#FF4BED'
}

/** Rarest-first ordering by DCL max supply (unique 1 → common 100k; free base items last). */
export const WEARABLE_RARITY_RANK: Record<string, number> = {
  unique: 0,
  mythic: 1,
  exotic: 2,
  legendary: 3,
  epic: 4,
  rare: 5,
  uncommon: 6,
  common: 7,
  base: 8
}

/** Sorted copy, rarest first; ties fall back to name A–Z. Unknown rarities sort last. */
export function sortWearablesByRarity<T extends { name: string; rarity: string }>(
  items: readonly T[]
): T[] {
  return [...items].sort((a, b) => {
    const ra = WEARABLE_RARITY_RANK[a.rarity.trim().toLowerCase()] ?? 99
    const rb = WEARABLE_RARITY_RANK[b.rarity.trim().toLowerCase()] ?? 99
    if (ra !== rb) return ra - rb
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/**
 * Sorted copy grouped alphabetically by collection or creator name; items still
 * missing that metadata (annotation pending or failed) sort last. Ties fall back
 * to item name A–Z.
 */
export function sortWearablesByGroup<T extends { name: string }>(
  items: readonly T[],
  key: (item: T) => string | undefined
): T[] {
  return [...items].sort((a, b) => {
    const ga = key(a)
    const gb = key(b)
    if (ga !== gb) {
      if (!ga) return 1
      if (!gb) return -1
      const d = ga.localeCompare(gb, undefined, { sensitivity: 'base' })
      if (d !== 0) return d
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

export function wearableRarityLabel(rarity: string): string {
  return rarity.trim().toUpperCase() || 'COMMON'
}

export function wearableRarityBackground(rarity: string): string {
  const key = rarity.trim().toLowerCase() || 'common'
  return WEARABLE_RARITY_BACKGROUNDS[key] ?? WEARABLE_RARITY_BACKGROUNDS.common!
}

function escapeCardHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export type RarityCardInput = {
  name: string
  rarity: string
  thumbnailUrl: string
  /** Thumbnail used when the primary URL 404s (Catalyst hash vs lambdas path). */
  fallbackThumbnailUrl?: string
  /** Corner pill — emote wheel slot, mint number, amount… */
  badge?: string
  badgeTitle?: string
}

/**
 * Single markup source for every equipped-item tile (wearables and emotes, in
 * the profile modal and the profile page) so rarity reads identically wherever
 * it appears: rarity fill behind the thumbnail, name + tier on a dark footer.
 */
export function renderRarityCard(item: RarityCardInput): string {
  const rarity = item.rarity.trim().toLowerCase() || 'common'
  const bg = wearableRarityBackground(rarity)
  const color = WEARABLE_RARITY_COLORS[rarity] ?? WEARABLE_RARITY_COLORS.common!
  const label = wearableRarityLabel(rarity)
  const name = escapeCardHtml(item.name)
  const fallback = item.fallbackThumbnailUrl
    ? ` onerror="this.onerror=null;this.src='${escapeCardHtml(item.fallbackThumbnailUrl)}'"`
    : ''
  const badge = item.badge
    ? `<span class="rarity-card__badge"${item.badgeTitle ? ` title="${escapeCardHtml(item.badgeTitle)}"` : ''}>${escapeCardHtml(item.badge)}</span>`
    : ''

  return `
    <article class="rarity-card is-${escapeCardHtml(rarity)}" style="--rarity-bg:${escapeCardHtml(bg)};--rarity-color:${escapeCardHtml(color)}" title="${name} · ${escapeCardHtml(label)}">
      <div class="rarity-card__tile">
        <img class="rarity-card__img" src="${escapeCardHtml(item.thumbnailUrl)}" alt="${name}" loading="lazy" decoding="async"${fallback} />
        ${badge}
      </div>
      <div class="rarity-card__meta">
        <span class="rarity-card__name">${name}</span>
        <span class="rarity-card__rarity">${escapeCardHtml(label)}</span>
      </div>
    </article>
  `
}

type WearableMeta = {
  name: string
  rarity: string
  thumbnailUrl: string
}

type CatalystEntityMeta = {
  id?: string
  name?: string
  rarity?: string | null
  thumbnail?: string
  i18n?: Array<{ code?: string; text?: string }>
}

/** Catalyst caps pointer batches; equipped lists are far smaller, but stay safe. */
const ENTITY_BATCH_SIZE = 40

/**
 * One `POST /content/entities/active` per batch — resolves name + rarity +
 * thumbnail for wearables AND emotes (same entity shape). This is the only
 * lookup that works for every URN flavour: the marketplace items API misses
 * collections-v1 / third-party items, which is why equipped grids used to fall
 * back to "common" (teal) tiles with raw token ids for names.
 */
export async function fetchCatalystItemMeta(
  pointers: string[],
  peerUrl = DEFAULT_CATALYST
): Promise<Map<string, WearableMeta>> {
  const out = new Map<string, WearableMeta>()
  const unique = [...new Set(pointers.map((p) => p.trim().toLowerCase()).filter(Boolean))]
  if (!unique.length) return out
  const root = peerUrl.replace(/\/$/, '')

  for (let i = 0; i < unique.length; i += ENTITY_BATCH_SIZE) {
    const batch = unique.slice(i, i + ENTITY_BATCH_SIZE)
    try {
      const res = await fetch(`${root}/content/entities/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointers: batch })
      })
      if (!res.ok) continue
      const entities = (await res.json()) as Array<{
        pointers?: string[]
        metadata?: CatalystEntityMeta
        content?: Array<{ file: string; hash: string }>
      }>
      for (const entity of entities) {
        const meta = entity.metadata
        if (!meta) continue
        const thumbFile = meta.thumbnail || 'thumbnail.png'
        const thumbHash = entity.content?.find(
          (c) => c.file === thumbFile || c.file.endsWith('/' + thumbFile)
        )?.hash
        const enName = meta.i18n?.find((row) => row.code === 'en')?.text?.trim()
        const keys = [...(entity.pointers ?? []), meta.id ?? '']
          .map((k) => k.trim().toLowerCase())
          .filter(Boolean)
        if (!keys.length) continue
        const resolved: WearableMeta = {
          name: meta.name?.trim() || enName || wearableShortLabel(keys[0]!),
          rarity: (meta.rarity?.trim().toLowerCase() || guessWearableRarity(keys[0]!)).toLowerCase(),
          thumbnailUrl: thumbHash
            ? `${root}/content/contents/${encodeURIComponent(thumbHash)}`
            : (resolveContentImageUrl(meta.thumbnail, root) ?? wearableThumbnailUrl(keys[0]!, root))
        }
        for (const key of keys) out.set(key, resolved)
      }
    } catch {
      /* skip batch — per-item fallbacks still run */
    }
  }
  return out
}

async function fetchMarketplaceWearableMeta(
  contract: string,
  itemId: string,
  peerUrl: string
): Promise<WearableMeta | null> {
  const url = `${MARKETPLACE_API}/v1/items?contractAddress=${encodeURIComponent(
    contract
  )}&itemId=${encodeURIComponent(itemId)}`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const raw = (await res.json()) as {
      data?: Array<{ name?: string; rarity?: string; thumbnail?: string; data?: { wearable?: { rarity?: string } } }>
    }
    const hit = raw.data?.[0]
    if (!hit) return null
    const rarity =
      hit.rarity?.trim().toLowerCase() ||
      hit.data?.wearable?.rarity?.trim().toLowerCase() ||
      'common'
    const thumbnailUrl =
      resolveContentImageUrl(hit.thumbnail, peerUrl) ?? wearableThumbnailUrl(
        `urn:decentraland:matic:collections-v2:${contract}:${itemId}`,
        peerUrl
      )
    return {
      name: hit.name?.trim() || wearableShortLabel(contract),
      rarity,
      thumbnailUrl
    }
  } catch {
    return null
  }
}

async function fetchCatalystWearableMeta(urn: string, peerUrl: string): Promise<WearableMeta | null> {
  const base = peerUrl.replace(/\/$/, '')
  const assetUrn = assetUrnFromCompleteUrn(urn)
  try {
    const url = `${base}/lambdas/collections/wearables?wearableId=${encodeURIComponent(assetUrn)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const raw = (await res.json()) as {
      wearables?: Array<{ name?: string; rarity?: string | null; thumbnail?: string; i18n?: Array<{ code?: string; text?: string }> }>
    }
    const hit = raw.wearables?.[0]
    if (!hit) return null
    const enName = hit.i18n?.find((row) => row.code === 'en')?.text?.trim()
    const rarity = (hit.rarity?.trim().toLowerCase() || guessWearableRarity(urn)).toLowerCase()
    const thumbnailUrl =
      resolveContentImageUrl(hit.thumbnail, peerUrl) ?? wearableThumbnailUrl(urn, peerUrl)
    return {
      name: enName || hit.name?.trim() || wearableShortLabel(urn),
      rarity,
      thumbnailUrl
    }
  } catch {
    return null
  }
}

async function resolveWearableMeta(urn: string, peerUrl: string): Promise<WearableDisplayCard> {
  const fallback: WearableDisplayCard = {
    urn,
    name: wearableShortLabel(urn),
    rarity: guessWearableRarity(urn),
    thumbnailUrl: wearableThumbnailUrl(urn, peerUrl)
  }

  const parsed = parseCollectionsV2WearableUrn(urn)
  if (parsed) {
    const marketplace = await fetchMarketplaceWearableMeta(parsed.contract, parsed.itemId, peerUrl)
    if (marketplace) {
      return { urn, ...marketplace }
    }
    const itemUrn = `urn:decentraland:matic:collections-v2:${parsed.contract}:${parsed.itemId}`
    return {
      urn,
      name: wearableShortLabel(urn),
      rarity: guessWearableRarity(urn),
      thumbnailUrl: wearableThumbnailUrl(itemUrn, peerUrl)
    }
  }

  const catalyst = await fetchCatalystWearableMeta(urn, peerUrl)
  if (catalyst) return { urn, ...catalyst }

  return fallback
}

/** Equipped outfits top out around 16 slots; the cap only guards junk profiles. */
const MAX_EQUIPPED_CARDS = 32

export async function fetchWearableDisplayCards(
  urns: string[],
  peerUrl = DEFAULT_CATALYST
): Promise<WearableDisplayCard[]> {
  const base = peerUrl.replace(/\/$/, '')
  const equipped = filterEquippedWearables(urns).slice(0, MAX_EQUIPPED_CARDS)
  if (!equipped.length) return []

  // One batched Catalyst call covers nearly every item; only misses pay for a
  // per-item marketplace/lambdas round trip.
  const metaMap = await fetchCatalystItemMeta(
    equipped.map((urn) => assetUrnFromCompleteUrn(urn)),
    base
  )

  const cards: WearableDisplayCard[] = new Array(equipped.length)
  const misses: number[] = []
  equipped.forEach((urn, index) => {
    const meta = metaMap.get(assetUrnFromCompleteUrn(urn).toLowerCase())
    if (meta) cards[index] = { urn, ...meta }
    else misses.push(index)
  })

  const chunkSize = 4
  for (let i = 0; i < misses.length; i += chunkSize) {
    const chunk = misses.slice(i, i + chunkSize)
    const resolved = await Promise.all(
      chunk.map((index) => resolveWearableMeta(equipped[index]!, base))
    )
    chunk.forEach((index, offset) => {
      cards[index] = resolved[offset]!
    })
  }

  return cards
}