import { indexById, mergeItems } from './format'
import { fetchItems, fetchTrendings, supportedApiCategory } from './marketplaceApi'
import type { DiscoverData, MarketplaceFilters, MarketplaceItem, MarketplaceKind } from './types'

const RAIL_SIZE = 18
const RANK_SIZE = 10
const TRENDING_MIN = 6

function pickHero(candidates: readonly MarketplaceItem[]): MarketplaceItem | null {
  const onSale = candidates.find((i) => i.isOnSale && i.thumbnail)
  if (onSale) return onSale
  const withThumb = candidates.find((i) => i.thumbnail)
  return withThumb ?? candidates[0] ?? null
}

function takeUnique(items: readonly MarketplaceItem[], n: number): MarketplaceItem[] {
  const seen = new Set<string>()
  const out: MarketplaceItem[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
    if (out.length >= n) break
  }
  return out
}

/**
 * Load Discover rails + rankings for a kind filter.
 * Wearables/Emotes hit marketplace-api; Names/Land return empty rails (chip UI only).
 */
export async function loadDiscover(filters: MarketplaceFilters): Promise<DiscoverData> {
  const kind: MarketplaceKind | 'all' = filters.kind
  const apiCat = supportedApiCategory(kind)

  if (!apiCat) {
    return {
      trending: [],
      newest: [],
      rankings: [],
      byId: new Map(),
      hero: null
    }
  }

  const [trendingsRes, newestRes, soldRes] = await Promise.allSettled([
    fetchTrendings(24),
    fetchItems({ category: apiCat, orderBy: 'newest', first: RAIL_SIZE }),
    fetchItems({ category: apiCat, orderBy: 'recently_sold', first: Math.max(RAIL_SIZE, RANK_SIZE) })
  ])

  const trendings = trendingsRes.status === 'fulfilled' ? trendingsRes.value : []
  const newest = newestRes.status === 'fulfilled' ? newestRes.value : []
  const sold = soldRes.status === 'fulfilled' ? soldRes.value : []

  // Filter trendings to active kind when possible (API may mix)
  const trendingFiltered =
    kind === 'all' ? trendings : trendings.filter((i) => i.kind === kind || i.kind === 'other')

  let trending = takeUnique(trendingFiltered, RAIL_SIZE)
  if (trending.length < TRENDING_MIN) {
    trending = takeUnique([...trending, ...sold, ...newest], RAIL_SIZE)
  }

  let rankings = takeUnique(trendingFiltered.length ? trendingFiltered : sold, RANK_SIZE)
  if (rankings.length < RANK_SIZE) {
    rankings = takeUnique([...rankings, ...sold, ...newest], RANK_SIZE)
  }

  const newestRail = takeUnique(newest.length ? newest : sold, RAIL_SIZE)
  const all = mergeItems(trending, newestRail, rankings, sold)
  const byId = indexById(all)
  const hero = pickHero(trending.length ? trending : newestRail)

  return {
    trending,
    newest: newestRail,
    rankings,
    byId,
    hero
  }
}

export const DISCOVER_UNSUPPORTED_COPY: Record<'name' | 'land', string> = {
  name: 'Names browse is coming next — Discover is live for Wearables & Emotes.',
  land: 'Land browse is coming next — Discover is live for Wearables & Emotes.'
}
