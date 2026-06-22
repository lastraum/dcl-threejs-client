/**
 * Decentraland Places API — Genesis places + Worlds
 * @see https://docs.decentraland.org/apis/apis/places/places
 * @see https://docs.decentraland.org/apis/apis/places/worlds
 */

import signedFetch from 'decentraland-crypto-fetch'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { RouteTarget } from '../dcl/content/route'
import { placesApiBase } from '../map/mapConfig'

export const PLACES_PAGE_SIZE = 100

export type PlacesOrderBy =
  | 'like_score'
  | 'most_active'
  | 'updated_at'
  | 'created_at'
  | 'user_visits'

export type WorldsOrderBy = 'like_score' | 'most_active' | 'created_at'

export type PlacesSceneCategory = {
  id: string
  label: string
  slug: string | null
  swatch: string
}

/** Explorer-style category chips (matches dcl-companion HotScenesCrowd). */
export const PLACES_SCENE_CATEGORIES: readonly PlacesSceneCategory[] = [
  { id: 'all', label: 'ALL', slug: null, swatch: '#6ec8ff' },
  { id: 'social', label: 'SOCIAL', slug: 'social', swatch: '#7ec4ff' },
  { id: 'music', label: 'MUSIC', slug: 'music', swatch: '#9fe04a' },
  { id: 'art', label: 'ART', slug: 'art', swatch: '#2d7a4e' },
  { id: 'game', label: 'GAME', slug: 'game', swatch: '#6b4dff' },
  { id: 'fashion', label: 'FASHION', slug: 'fashion', swatch: '#ff4db8' },
  { id: 'education', label: 'EDUCATION', slug: 'education', swatch: '#2a4f9e' },
  { id: 'shop', label: 'SHOP', slug: 'shop', swatch: '#c94dff' },
  { id: 'sports', label: 'SPORTS', slug: 'sports', swatch: '#ff8c32' },
  { id: 'business', label: 'BUSINESS', slug: 'business', swatch: '#7a7a8c' }
] as const

export type DclGenesisPlace = {
  id: string
  title: string
  image: string | null
  baseX: number
  baseY: number
  userCount: number
  likePercent: number | null
  owner: string | null
  creatorAddress: string | null
  highlighted: boolean
  isLive: boolean
  categories: string[]
}

export type DclPlacesWorld = {
  id: string
  worldName: string
  title: string
  image: string | null
  userCount: number
  likePercent: number | null
  owner: string | null
  creatorAddress: string | null
  highlighted: boolean
  isLive: boolean
}

export type DclExploreItem =
  | { kind: 'scene'; id: string; title: string; userCount: number; place: DclGenesisPlace }
  | { kind: 'world'; id: string; title: string; userCount: number; world: DclPlacesWorld }

export type FetchPlacesGenesisOpts = {
  search?: string
  orderBy?: PlacesOrderBy
  categories?: string[]
  limit?: number
  offset?: number
  onlyFavorites?: boolean
  identity?: AuthIdentity | null
}

export type FetchPlacesWorldsOpts = {
  search?: string
  names?: string[]
  orderBy?: WorldsOrderBy
  limit?: number
  offset?: number
  onlyFavorites?: boolean
  identity?: AuthIdentity | null
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return PLACES_PAGE_SIZE
  return Math.max(1, Math.min(100, Math.floor(limit)))
}

function likePercentFromRow(o: Record<string, unknown>): number | null {
  const lr = o.like_rate
  if (typeof lr === 'number' && Number.isFinite(lr)) {
    return Math.round(Math.min(1, Math.max(0, lr)) * 100)
  }
  const ls = o.like_score
  if (typeof ls === 'number' && Number.isFinite(ls)) {
    return Math.round(Math.min(1, Math.max(0, ls)) * 100)
  }
  return null
}

function parseBasePosition(raw: unknown): { x: number; y: number } | null {
  const bp = typeof raw === 'string' ? raw.trim() : ''
  const m = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(bp)
  if (!m) return null
  const x = Number(m[1])
  const y = Number(m[2])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function mapGenesisPlace(item: unknown): DclGenesisPlace | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  if (o.world === true) return null
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  if (!id) return null
  const coords = parseBasePosition(o.base_position)
  if (!coords) return null
  const titleRaw = typeof o.title === 'string' ? o.title.trim() : ''
  const image = typeof o.image === 'string' && o.image.trim() ? o.image.trim() : null
  const userCount =
    typeof o.user_count === 'number' && Number.isFinite(o.user_count)
      ? Math.max(0, Math.floor(o.user_count))
      : 0
  const ownerRaw = typeof o.owner === 'string' ? o.owner.trim() : ''
  const creatorRaw = typeof o.creator_address === 'string' ? o.creator_address.trim() : ''
  const categories = Array.isArray(o.categories)
    ? o.categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : []
  const isMostActive = o.is_most_active_place === 1 || o.is_most_active_place === true
  return {
    id,
    title: titleRaw.length > 0 ? titleRaw : 'Place',
    image,
    baseX: coords.x,
    baseY: coords.y,
    userCount,
    likePercent: likePercentFromRow(o),
    owner: ownerRaw.length > 0 ? ownerRaw : null,
    creatorAddress: creatorRaw.length > 0 ? creatorRaw : null,
    highlighted: o.highlighted === true,
    isLive: userCount > 0 || isMostActive,
    categories
  }
}

function mapWorld(item: unknown): DclPlacesWorld | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const wnRaw =
    typeof o.world_name === 'string'
      ? o.world_name.trim()
      : typeof o.worldName === 'string'
        ? o.worldName.trim()
        : ''
  const worldName = wnRaw.length > 0 ? wnRaw : id
  if (!id && !worldName) return null
  const titleRaw = typeof o.title === 'string' ? o.title.trim() : ''
  const image = typeof o.image === 'string' && o.image.trim() ? o.image.trim() : null
  const ucRaw = o.user_count ?? o.userCount
  const userCount =
    typeof ucRaw === 'number' && Number.isFinite(ucRaw) ? Math.max(0, Math.floor(ucRaw)) : 0
  const ownerRaw = typeof o.owner === 'string' ? o.owner.trim() : ''
  const creatorRaw = typeof o.creator_address === 'string' ? o.creator_address.trim() : ''
  return {
    id: id || worldName,
    worldName,
    title: titleRaw.length > 0 ? titleRaw : worldName,
    image,
    userCount,
    likePercent: likePercentFromRow(o),
    owner: ownerRaw.length > 0 ? ownerRaw : null,
    creatorAddress: creatorRaw.length > 0 ? creatorRaw : null,
    highlighted: o.highlighted === true,
    isLive: userCount > 0
  }
}

async function placesApiGet(
  path: 'places' | 'worlds',
  params: URLSearchParams,
  identity?: AuthIdentity | null
): Promise<{ data: unknown[]; total: number }> {
  const url = `${placesApiBase()}/${path}?${params.toString()}`
  const res = identity
    ? await signedFetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        identity
      })
    : await fetch(url, { headers: { Accept: 'application/json' } })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Places API ${res.status}`)
  }

  const body = (await res.json()) as { data?: unknown; total?: unknown }
  const data = Array.isArray(body.data) ? body.data : []
  const total =
    typeof body.total === 'number' && Number.isFinite(body.total) ? Math.max(0, Math.floor(body.total)) : data.length
  return { data, total }
}

export async function fetchDclGenesisPlaces(opts?: FetchPlacesGenesisOpts): Promise<DclGenesisPlace[]> {
  const limit = clampLimit(opts?.limit)
  const offset =
    typeof opts?.offset === 'number' && Number.isFinite(opts.offset) && opts.offset > 0
      ? Math.floor(opts.offset)
      : 0
  const qs = new URLSearchParams({
    limit: String(limit),
    order_by: opts?.orderBy ?? 'most_active',
    order: 'desc'
  })
  if (offset > 0) qs.set('offset', String(offset))
  const s = opts?.search?.trim() ?? ''
  if (s.length >= 3) qs.set('search', s)
  for (const raw of opts?.categories ?? []) {
    const c = typeof raw === 'string' ? raw.trim() : ''
    if (c.length > 0 && /^[a-z0-9_-]+$/i.test(c)) qs.append('categories', c)
  }
  if (opts?.onlyFavorites) qs.set('only_favorites', 'true')

  const { data } = await placesApiGet('places', qs, opts?.onlyFavorites ? opts.identity : null)
  const out: DclGenesisPlace[] = []
  for (const item of data) {
    const row = mapGenesisPlace(item)
    if (row) out.push(row)
  }
  return out
}

export async function fetchDclPlacesWorlds(opts?: FetchPlacesWorldsOpts): Promise<DclPlacesWorld[]> {
  const limit = clampLimit(opts?.limit)
  const offset =
    typeof opts?.offset === 'number' && Number.isFinite(opts.offset) && opts.offset > 0
      ? Math.floor(opts.offset)
      : 0
  const qs = new URLSearchParams({
    limit: String(limit),
    order_by: opts?.orderBy ?? 'most_active',
    order: 'desc'
  })
  if (offset > 0) qs.set('offset', String(offset))
  const s = opts?.search?.trim() ?? ''
  if (s.length > 0) qs.set('search', s)
  for (const raw of opts?.names ?? []) {
    const n = typeof raw === 'string' ? raw.trim() : ''
    if (n.length > 0) qs.append('names', n)
  }
  if (opts?.onlyFavorites) qs.set('only_favorites', 'true')

  const { data } = await placesApiGet('worlds', qs, opts?.onlyFavorites ? opts.identity : null)
  const out: DclPlacesWorld[] = []
  for (const item of data) {
    const row = mapWorld(item)
    if (row) out.push(row)
  }
  return out
}

export function mergeUniqueById<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (next.length === 0) return prev
  const seen = new Set(prev.map((item) => item.id))
  const merged = [...prev]
  for (const item of next) {
    if (!seen.has(item.id)) {
      seen.add(item.id)
      merged.push(item)
    }
  }
  return merged
}

export function worldNameSearchCandidates(rawQuery: string): string[] {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return []
  const out = new Set<string>()
  out.add(q)
  if (q.endsWith('.dcl.eth')) {
    const short = q.slice(0, -'.dcl.eth'.length).trim()
    if (short) out.add(short)
  } else if (/^[a-z0-9][a-z0-9-]*$/.test(q)) {
    out.add(`${q}.dcl.eth`)
  }
  return [...out]
}

export function matchesPlaceSearch(
  place: DclGenesisPlace,
  queryLower: string,
  compactQuery: string
): boolean {
  if (!queryLower) return true
  const title = place.title.toLowerCase()
  const owner = (place.owner ?? '').toLowerCase()
  const coords = `${place.baseX},${place.baseY}`.replace(/\s/g, '')
  return title.includes(queryLower) || owner.includes(queryLower) || coords.includes(compactQuery)
}

export function matchesWorldSearch(world: DclPlacesWorld, queryLower: string): boolean {
  if (!queryLower) return true
  const title = world.title.toLowerCase()
  const worldName = world.worldName.toLowerCase()
  const id = world.id.toLowerCase()
  return title.includes(queryLower) || worldName.includes(queryLower) || id.includes(queryLower)
}

export function genesisPlaceJumpRoute(place: DclGenesisPlace): RouteTarget {
  return {
    kind: 'coords',
    x: place.baseX,
    y: place.baseY,
    segment: `${place.baseX},${place.baseY}`
  }
}

export function placesWorldJumpRoute(world: DclPlacesWorld): RouteTarget {
  const raw = world.worldName.trim() || world.id.trim()
  const worldName = raw.includes('.') ? raw : `${raw}.dcl.eth`
  return { kind: 'world', worldName, segment: worldName }
}

export function placeOwnerAddress(item: DclGenesisPlace | DclPlacesWorld): string | null {
  return item.creatorAddress ?? item.owner
}

export function formatOwnerShort(address: string | null): string | null {
  if (!address) return null
  if (!address.startsWith('0x') || address.length < 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function placeLocationLabel(item: DclGenesisPlace | DclPlacesWorld): string {
  if ('worldName' in item) return item.worldName
  return `${item.baseX}, ${item.baseY}`
}

export type ExplorerSortMode = 'most_users' | 'name_az'

export function buildUnifiedExplorerItems(
  places: DclGenesisPlace[],
  worlds: DclPlacesWorld[],
  sort: ExplorerSortMode
): DclExploreItem[] {
  const items: DclExploreItem[] = [
    ...places.map((place) => ({
      id: `scene:${place.id}`,
      kind: 'scene' as const,
      title: place.title,
      userCount: place.userCount,
      place
    })),
    ...worlds.map((world) => ({
      id: `world:${world.id}`,
      kind: 'world' as const,
      title: world.title,
      userCount: world.userCount,
      world
    }))
  ]
  if (sort === 'name_az') {
    return items.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  }
  return items.sort(
    (a, b) =>
      b.userCount - a.userCount ||
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  )
}

export async function fetchDclWorldsWithNameFallback(
  opts: FetchPlacesWorldsOpts
): Promise<DclPlacesWorld[]> {
  const q = opts.search?.trim() ?? ''
  let data = await fetchDclPlacesWorlds(opts)
  if (q.length > 0) {
    const qLower = q.toLowerCase()
    const hasDirectMatch = data.some((world) => matchesWorldSearch(world, qLower))
    if (!hasDirectMatch) {
      const candidates = worldNameSearchCandidates(q)
      if (candidates.length > 0) {
        const byName = await fetchDclPlacesWorlds({
          ...opts,
          search: undefined,
          names: candidates,
          offset: 0
        })
        data = mergeUniqueById(data, byName)
      }
    }
  }
  return data
}