/**
 * Worlds catalog for the map "space" view — live occupancy + Places thumbnails.
 */
import { placesApiBase } from './mapConfig'
import type { WorldsLiveData } from './types'

export type WorldMapEntry = {
  worldName: string
  users: number
  imageUrl: string | null
  title: string | null
  description?: string | null
  categories?: string[]
  likes?: number
  favorites?: number
}

type PlacesWorldRow = {
  world_name?: string | null
  title?: string | null
  image?: string | null
  user_count?: number | null
  description?: string | null
  categories?: string[] | null
  likes?: number | null
  favorites?: number | null
}

function shortWorldLabel(worldName: string): string {
  const n = worldName.trim()
  if (!n) return 'World'
  return n.replace(/\.dcl\.eth$/i, '')
}

/**
 * Places API worlds list (thumbnails + titles). Uses same-origin `/api/places` proxy.
 * @see https://places.decentraland.org/api/worlds
 */
export async function fetchPlacesWorlds(opts: {
  limit?: number
  offset?: number
  orderBy?: 'most_active' | 'like_score_best' | 'most_liked' | 'updated_at'
} = {}): Promise<WorldMapEntry[]> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 48))
  const offset = Math.max(0, opts.offset ?? 0)
  const orderBy = opts.orderBy ?? 'most_active'
  const base = placesApiBase().replace(/\/$/, '')
  const url = `${base}/worlds?limit=${limit}&offset=${offset}&order_by=${encodeURIComponent(orderBy)}`

  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`places_worlds_http_${res.status}`)
  const body = (await res.json()) as { data?: PlacesWorldRow[]; ok?: boolean }
  const rows = Array.isArray(body.data) ? body.data : []
  const out: WorldMapEntry[] = []
  for (const row of rows) {
    const worldName = String(row.world_name ?? '').trim()
    if (!worldName) continue
    const users = Number(row.user_count)
    const image = typeof row.image === 'string' && row.image.trim() ? row.image.trim() : null
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null
    const description =
      typeof row.description === 'string' && row.description.trim() ? row.description.trim() : null
    const categories = Array.isArray(row.categories)
      ? row.categories.map((c) => String(c).trim()).filter(Boolean)
      : []
    const likes = Number(row.likes)
    const favorites = Number(row.favorites)
    out.push({
      worldName,
      users: Number.isFinite(users) && users > 0 ? users : 0,
      imageUrl: image,
      title,
      description,
      categories: categories.length ? categories : undefined,
      likes: Number.isFinite(likes) ? likes : undefined,
      favorites: Number.isFinite(favorites) ? favorites : undefined
    })
  }
  return out
}

/** Resolve a single world for the map modal (exact name match via Places search). */
export async function fetchWorldMapDetail(worldName: string): Promise<WorldMapEntry | null> {
  const name = worldName.trim()
  if (!name) return null
  const base = placesApiBase().replace(/\/$/, '')
  const q = encodeURIComponent(name.replace(/\.dcl\.eth$/i, ''))
  const url = `${base}/worlds?search=${q}&limit=12`
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: PlacesWorldRow[] }
    const rows = Array.isArray(body.data) ? body.data : []
    const needle = name.toLowerCase()
    const hit =
      rows.find((r) => String(r.world_name ?? '').toLowerCase() === needle) ??
      rows.find((r) => String(r.world_name ?? '').toLowerCase().startsWith(needle))
    if (!hit?.world_name) return null
    const users = Number(hit.user_count)
    const cats = Array.isArray(hit.categories)
      ? hit.categories.map((c) => String(c).trim()).filter(Boolean)
      : []
    return {
      worldName: String(hit.world_name).trim(),
      users: Number.isFinite(users) && users > 0 ? users : 0,
      imageUrl: typeof hit.image === 'string' && hit.image.trim() ? hit.image.trim() : null,
      title: typeof hit.title === 'string' && hit.title.trim() ? hit.title.trim() : null,
      description:
        typeof hit.description === 'string' && hit.description.trim()
          ? hit.description.trim()
          : null,
      categories: cats.length ? cats : undefined,
      likes: Number.isFinite(Number(hit.likes)) ? Number(hit.likes) : undefined,
      favorites: Number.isFinite(Number(hit.favorites)) ? Number(hit.favorites) : undefined
    }
  } catch {
    return null
  }
}

/** Merge live occupancy into Places catalog; keep live-only worlds even without Places row. */
export function mergeLiveWithPlaces(
  live: WorldsLiveData,
  places: WorldMapEntry[]
): WorldMapEntry[] {
  const liveUsers = new Map<string, number>()
  for (const w of live.perWorld) {
    const key = w.worldName.trim().toLowerCase()
    if (!key) continue
    liveUsers.set(key, w.users)
  }

  const byKey = new Map<string, WorldMapEntry>()
  for (const p of places) {
    const key = p.worldName.trim().toLowerCase()
    if (!key) continue
    byKey.set(key, {
      ...p,
      users: liveUsers.get(key) ?? p.users
    })
  }

  for (const w of live.perWorld) {
    const key = w.worldName.trim().toLowerCase()
    if (!key || byKey.has(key)) continue
    byKey.set(key, {
      worldName: w.worldName,
      users: w.users,
      imageUrl: null,
      title: shortWorldLabel(w.worldName)
    })
  }

  return [...byKey.values()].sort((a, b) => {
    const byUsers = b.users - a.users
    if (byUsers !== 0) return byUsers
    return a.worldName.localeCompare(b.worldName, undefined, { sensitivity: 'base' })
  })
}

export async function loadWorldMapCatalog(live: WorldsLiveData, limit = 48): Promise<WorldMapEntry[]> {
  let places: WorldMapEntry[] = []
  try {
    // Places page size max 100 — pull multiple pages when asking for a large atlas.
    const pageSize = 100
    let offset = 0
    while (places.length < limit) {
      const batch = await fetchPlacesWorlds({
        limit: Math.min(pageSize, limit - places.length),
        offset,
        orderBy: 'most_active'
      })
      if (!batch.length) break
      places.push(...batch)
      offset += batch.length
      if (batch.length < pageSize) break
    }
  } catch (err) {
    console.warn('[map/worlds] places catalog failed', err)
  }
  return mergeLiveWithPlaces(live, places).slice(0, limit)
}

export function worldDisplayName(entry: WorldMapEntry): string {
  const t = entry.title?.trim()
  if (t) return t
  return shortWorldLabel(entry.worldName)
}
