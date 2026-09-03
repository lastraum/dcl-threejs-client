/**
 * Worlds catalog for the map "space" view — live occupancy + Places thumbnails.
 */
import { fetchWorldDeployDisplayMeta } from '../dcl/content/resolveScene'
import { placesApiBase, sceneParticipantsUrl } from './mapConfig'
import type { WorldsLiveData } from './types'

export type WorldMapEntry = {
  worldName: string
  users: number
  imageUrl: string | null
  title: string | null
  description?: string | null
  /** Places `creator_address` (wallet). */
  creatorAddress?: string | null
  /** Places `owner` display name when it isn't a wallet. */
  ownerName?: string | null
  categories?: string[]
  likes?: number
  favorites?: number
  /** Wallets currently in the world (Places `connected_addresses`) when the API sends them. */
  connectedAddresses?: string[]
}

type PlacesWorldRow = {
  world_name?: string | null
  title?: string | null
  image?: string | null
  user_count?: number | null
  description?: string | null
  owner?: string | null
  contact_name?: string | null
  creator_address?: string | null
  creatorAddress?: string | null
  categories?: string[] | null
  likes?: number | null
  favorites?: number | null
  connected_addresses?: string[] | null
  connectedAddresses?: string[] | null
}

function shortWorldLabel(worldName: string): string {
  const n = worldName.trim()
  if (!n) return 'World'
  return n.replace(/\.dcl\.eth$/i, '')
}

function parseWallet(raw: unknown): string | null {
  const addr = String(raw ?? '').trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(addr) ? addr : null
}

function parseCreator(row: PlacesWorldRow): { creatorAddress: string | null; ownerName: string | null } {
  const creatorAddress =
    parseWallet(row.creator_address) ?? parseWallet(row.creatorAddress) ?? parseWallet(row.owner)
  const ownerRaw = String(row.owner ?? row.contact_name ?? '').trim()
  const ownerName = ownerRaw && !parseWallet(ownerRaw) ? ownerRaw : null
  return { creatorAddress, ownerName }
}

function parseConnectedAddresses(row: PlacesWorldRow): string[] | undefined {
  const raw = row.connected_addresses ?? row.connectedAddresses
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const addr = String(item ?? '').trim().toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(addr) || seen.has(addr)) continue
    seen.add(addr)
    out.push(addr)
  }
  return out.length ? out : undefined
}

function placesRowToEntry(row: PlacesWorldRow): WorldMapEntry | null {
  const worldName = String(row.world_name ?? '').trim()
  if (!worldName) return null
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
  const creator = parseCreator(row)
  return {
    worldName,
    users: Number.isFinite(users) && users > 0 ? users : 0,
    imageUrl: image,
    title,
    description,
    creatorAddress: creator.creatorAddress,
    ownerName: creator.ownerName,
    categories: categories.length ? categories : undefined,
    likes: Number.isFinite(likes) ? likes : undefined,
    favorites: Number.isFinite(favorites) ? favorites : undefined,
    connectedAddresses: parseConnectedAddresses(row)
  }
}

function applyPlacesFields(target: WorldMapEntry, src: WorldMapEntry): void {
  if (!target.imageUrl && src.imageUrl) target.imageUrl = src.imageUrl
  if (!target.title && src.title) target.title = src.title
  if (!target.description && src.description) target.description = src.description
  if (!target.creatorAddress && src.creatorAddress) target.creatorAddress = src.creatorAddress
  if (!target.ownerName && src.ownerName) target.ownerName = src.ownerName
}

/** Places `image` by exact world name — occupied live-data worlds are often missing from the most_active page. */
async function fetchPlacesWorldsByNames(names: string[]): Promise<WorldMapEntry[]> {
  const uniq: string[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    const n = raw.trim()
    if (!n) continue
    const key = n.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(n)
  }
  if (!uniq.length) return []
  const base = placesApiBase().replace(/\/$/, '')
  const qs = new URLSearchParams({
    limit: String(Math.min(100, Math.max(uniq.length, 8))),
    order_by: 'most_active'
  })
  for (const n of uniq) qs.append('names', n)
  const res = await fetch(`${base}/worlds?${qs.toString()}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`places_worlds_names_http_${res.status}`)
  const body = (await res.json()) as { data?: PlacesWorldRow[] }
  const rows = Array.isArray(body.data) ? body.data : []
  const out: WorldMapEntry[] = []
  for (const row of rows) {
    const entry = placesRowToEntry(row)
    if (entry) out.push(entry)
  }
  return out
}

const worldImageCache = new Map<string, string | null>()

function rememberImage(worldName: string, imageUrl: string | null | undefined): void {
  const key = worldName.trim().toLowerCase()
  if (!key) return
  if (imageUrl) worldImageCache.set(key, imageUrl)
}

async function fillMissingWorldImages(entries: WorldMapEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.imageUrl) {
      rememberImage(entry.worldName, entry.imageUrl)
      continue
    }
    const cached = worldImageCache.get(entry.worldName.trim().toLowerCase())
    if (cached) entry.imageUrl = cached
  }

  const missing = entries.filter(
    (e) => !e.imageUrl && !worldImageCache.has(e.worldName.trim().toLowerCase())
  )
  if (!missing.length) return

  try {
    const found = await fetchPlacesWorldsByNames(missing.map((e) => e.worldName))
    const byKey = new Map<string, WorldMapEntry>()
    for (const row of found) byKey.set(row.worldName.trim().toLowerCase(), row)
    for (const entry of missing) {
      const hit = byKey.get(entry.worldName.trim().toLowerCase())
      if (!hit) continue
      applyPlacesFields(entry, hit)
      rememberImage(entry.worldName, entry.imageUrl)
    }
  } catch (err) {
    console.warn('[map/worlds] places names lookup failed', err)
  }

  const still = entries.filter(
    (e) => !e.imageUrl && !worldImageCache.has(e.worldName.trim().toLowerCase())
  )
  if (!still.length) return
  const deploy = still.sort((a, b) => b.users - a.users).slice(0, 12)
  await Promise.all(
    deploy.map(async (entry) => {
      try {
        const meta = await fetchWorldDeployDisplayMeta(entry.worldName)
        if (meta?.imageUrl) {
          entry.imageUrl = meta.imageUrl
          if (!entry.title && meta.title) entry.title = meta.title
          if (!entry.description && meta.description) entry.description = meta.description
          rememberImage(entry.worldName, meta.imageUrl)
        }
      } catch {
        /* no content-server thumbnail */
      }
    })
  )
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
    const entry = placesRowToEntry(row)
    if (entry) out.push(entry)
  }
  return out
}

function pickNamedWorld(rows: WorldMapEntry[], worldName: string): WorldMapEntry | null {
  const needle = worldName.trim().toLowerCase()
  const short = needle.replace(/\.dcl\.eth$/i, '')
  return (
    rows.find((r) => r.worldName.toLowerCase() === needle) ??
    rows.find((r) => r.worldName.toLowerCase() === `${short}.dcl.eth`) ??
    rows.find((r) => r.worldName.toLowerCase() === short) ??
    rows.find((r) => r.worldName.toLowerCase().startsWith(needle)) ??
    null
  )
}

/** Resolve a single world (Places `names=` first, then search). */
export async function fetchWorldMapDetail(worldName: string): Promise<WorldMapEntry | null> {
  const name = worldName.trim()
  if (!name) return null
  const short = name.replace(/\.dcl\.eth$/i, '')
  try {
    const named = await fetchPlacesWorldsByNames([name, short])
    const exact = pickNamedWorld(named, name)
    if (exact) return exact
  } catch {
    /* fall through to search */
  }
  const base = placesApiBase().replace(/\/$/, '')
  const q = encodeURIComponent(short)
  const url = `${base}/worlds?search=${q}&limit=12`
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: PlacesWorldRow[] }
    const rows = Array.isArray(body.data) ? body.data : []
    const parsed: WorldMapEntry[] = []
    for (const row of rows) {
      const entry = placesRowToEntry(row)
      if (entry) parsed.push(entry)
    }
    return pickNamedWorld(parsed, name)
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
  const catalog = mergeLiveWithPlaces(live, places).slice(0, limit)
  await fillMissingWorldImages(catalog)
  await enrichConnectedAddresses(catalog)
  return catalog
}

async function enrichConnectedAddresses(entries: WorldMapEntry[]): Promise<void> {
  const need = entries.filter((e) => e.users > 0)
  if (!need.length) {
    for (const e of entries) e.connectedAddresses = []
    return
  }
  await Promise.all(
    need.map(async (entry) => {
      const fromComms = await fetchWorldParticipants(entry.worldName)
      if (fromComms && fromComms.length > 0) {
        entry.connectedAddresses = fromComms
        if (fromComms.length >= entry.users) return
      }
      if ((entry.connectedAddresses?.length ?? 0) >= entry.users) return
      const detail = await fetchWorldMapDetail(entry.worldName)
      if (detail) applyPlacesFields(entry, detail)
      const extra = detail?.connectedAddresses ?? []
      if (!extra.length) return
      const have = new Set(entry.connectedAddresses ?? [])
      const merged = [...(entry.connectedAddresses ?? [])]
      for (const addr of extra) {
        if (have.has(addr)) continue
        have.add(addr)
        merged.push(addr)
      }
      entry.connectedAddresses = merged
    })
  )
  const occupied = new Set(need.map((e) => e.worldName.toLowerCase()))
  for (const e of entries) {
    if (!occupied.has(e.worldName.toLowerCase())) e.connectedAddresses = []
  }
}

function participantRealmNames(worldName: string): string[] {
  const n = worldName.trim()
  if (!n) return []
  const short = n.replace(/\.dcl\.eth$/i, '')
  const out: string[] = []
  const add = (s: string) => {
    if (s && !out.includes(s)) out.push(s)
  }
  add(n)
  add(n.toLowerCase())
  add(`${short}.dcl.eth`)
  add(`${short.toLowerCase()}.dcl.eth`)
  return out
}

function parseParticipantAddresses(body: {
  data?: { addresses?: unknown } | unknown[]
}): string[] {
  const raw = Array.isArray(body?.data)
    ? body.data
    : Array.isArray((body.data as { addresses?: unknown })?.addresses)
      ? (body.data as { addresses: unknown[] }).addresses
      : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const addr = String(item ?? '').trim().toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(addr) || seen.has(addr)) continue
    seen.add(addr)
    out.push(addr)
  }
  return out
}

/** Live wallets in a world — Comms Gatekeeper `/scene-participants?realm_name=`. */
export async function fetchWorldParticipants(worldName: string): Promise<string[] | null> {
  const names = participantRealmNames(worldName)
  if (!names.length) return null
  let empty = false
  for (const name of names) {
    try {
      const res = await fetch(sceneParticipantsUrl(name), { headers: { Accept: 'application/json' } })
      if (!res.ok) continue
      const body = (await res.json()) as { data?: { addresses?: unknown } | unknown[]; ok?: boolean }
      const out = parseParticipantAddresses(body)
      if (out.length) return out
      empty = true
    } catch {
      /* try next casing */
    }
  }
  return empty ? [] : null
}

export function worldDisplayName(entry: WorldMapEntry): string {
  const t = entry.title?.trim()
  if (t) return t
  return shortWorldLabel(entry.worldName)
}
