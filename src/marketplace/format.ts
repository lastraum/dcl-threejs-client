import type { MarketplaceItem, MarketplaceKind, MarketplaceRarity } from './types'

const WEI_PER_MANA = 1e18

/** Parse marketplace wei string → MANA number (null if missing/invalid). */
export function weiToMana(priceWei: string | null | undefined): number | null {
  if (priceWei == null || priceWei === '') return null
  try {
    const n = Number(priceWei)
    if (!Number.isFinite(n) || n < 0) return null
    return n / WEI_PER_MANA
  } catch {
    return null
  }
}

/** Compact MANA for cards: 0.85, 12, 1.2k, 3.4M */
export function formatMana(priceMana: number | null | undefined): string {
  if (priceMana == null || !Number.isFinite(priceMana)) return '—'
  if (priceMana === 0) return '0'
  const abs = Math.abs(priceMana)
  if (abs >= 1_000_000) return `${trimNum(priceMana / 1_000_000)}M`
  if (abs >= 1_000) return `${trimNum(priceMana / 1_000)}k`
  if (abs >= 100) return String(Math.round(priceMana))
  if (abs >= 10) return trimNum(priceMana, 1)
  if (abs >= 1) return trimNum(priceMana, 2)
  return trimNum(priceMana, 3)
}

export function formatManaWei(priceWei: string | null | undefined): string {
  return formatMana(weiToMana(priceWei))
}

function trimNum(n: number, maxFrac = 2): string {
  const s = n.toFixed(maxFrac)
  return s.replace(/\.?0+$/, '')
}

export function shortCreator(address: string | null | undefined, max = 8): string {
  if (!address) return ''
  const a = address.trim()
  if (a.length <= max + 2) return a
  return `${a.slice(0, 4)}…${a.slice(-4)}`
}

export function rarityClass(rarity: MarketplaceRarity | null | undefined): string {
  const r = String(rarity ?? 'common')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
  return `rarity-${r || 'common'}`
}

export function kindFromApiCategory(category: string | null | undefined): MarketplaceKind {
  const c = (category ?? '').toLowerCase()
  if (c === 'emote') return 'emote'
  if (c === 'wearable') return 'wearable'
  if (c === 'ens' || c === 'name') return 'name'
  if (c === 'parcel' || c === 'estate' || c === 'land') return 'land'
  return 'other'
}

/** Map Discover chip kind → marketplace-api `category` query (null = unsupported yet). */
export function apiCategoryForKind(kind: MarketplaceKind | 'all'): string | null {
  if (kind === 'all' || kind === 'wearable') return 'wearable'
  if (kind === 'emote') return 'emote'
  return null
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function indexById(items: readonly MarketplaceItem[]): Map<string, MarketplaceItem> {
  const map = new Map<string, MarketplaceItem>()
  for (const item of items) {
    if (!map.has(item.id)) map.set(item.id, item)
  }
  return map
}

export function mergeItems(...lists: readonly (readonly MarketplaceItem[])[]): MarketplaceItem[] {
  const map = new Map<string, MarketplaceItem>()
  for (const list of lists) {
    for (const item of list) {
      if (!map.has(item.id)) map.set(item.id, item)
    }
  }
  return [...map.values()]
}

export function filterMarketplaceItems(
  items: readonly MarketplaceItem[],
  kind: MarketplaceKind | 'all'
): MarketplaceItem[] {
  if (kind === 'all') return [...items]
  return items.filter((i) => i.kind === kind)
}

/** Relative time for activity rows. */
export function formatRelativeTime(tsMs: number | null | undefined): string {
  if (tsMs == null || !Number.isFinite(tsMs)) return '—'
  const diff = Date.now() - tsMs
  if (diff < 0) {
    const abs = Math.abs(diff)
    if (abs < 60_000) return 'soon'
    if (abs < 3_600_000) return `in ${Math.round(abs / 60_000)}m`
    if (abs < 86_400_000) return `in ${Math.round(abs / 3_600_000)}h`
    return `in ${Math.round(abs / 86_400_000)}d`
  }
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  if (diff < 30 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`
  try {
    return new Date(tsMs).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
  } catch {
    return '—'
  }
}

export function formatBodyShapes(shapes: readonly string[]): string {
  if (!shapes.length) return ''
  const labels = shapes.map((s) => {
    const t = s.replace(/^Base/i, '')
    if (/female/i.test(t)) return 'Female'
    if (/male/i.test(t)) return 'Male'
    return t
  })
  const uniq = [...new Set(labels)]
  if (uniq.includes('Male') && uniq.includes('Female')) return 'Unisex'
  return uniq.join(' · ')
}

export function formatSaleType(type: string): string {
  const t = type.toLowerCase()
  if (t === 'order' || t === 'listing') return 'Listing'
  if (t === 'mint') return 'Mint'
  if (t === 'bid') return 'Bid'
  if (t === 'rental') return 'Rental'
  return type.charAt(0).toUpperCase() + type.slice(1)
}
