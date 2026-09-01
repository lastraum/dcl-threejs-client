import { catalystEntitiesActiveUrl } from '../../network/catalyst/CatalystClient'
import { normalizePointer } from '../../network/catalyst/pointer'
import type { ContentFile } from '../content/types'

export type ActiveSceneEntity = {
  id: string
  pointers: string[]
  title: string
  main: string
  runtimeVersion: string
  base: string
  parcels: string[]
  content: ContentFile[]
}

/** Catalyst parcel map rarely changes mid-session — reuse across AOI ticks. */
const ENTITY_CACHE_TTL_MS = 90_000
/** Cap memory if someone walks the whole world. */
const MAX_CACHED_POINTERS = 8_000
const MAX_CACHED_ENTITIES = 2_000

type TimedEntity = { entity: ActiveSceneEntity; expiresAt: number }
type TimedPointer = { entityId: string; expiresAt: number }

const entityById = new Map<string, TimedEntity>()
const pointerOwner = new Map<string, TimedPointer>()
/** In-flight POST by contentUrl + sorted chunk — coalesces AOI + promote races. */
const inflightChunks = new Map<string, Promise<ActiveSceneEntity[]>>()

let cacheHits = 0
let cacheMisses = 0
let networkChunks = 0

function parseContent(raw: unknown): ContentFile[] {
  if (!Array.isArray(raw)) return []
  const out: ContentFile[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.file === 'string' && typeof r.hash === 'string') {
      out.push({ file: r.file, hash: r.hash })
    }
  }
  return out
}

function normalizeEntity(raw: Record<string, unknown>): ActiveSceneEntity | null {
  const id = typeof raw.id === 'string' ? raw.id : null
  if (!id) return null
  const meta =
    raw.metadata && typeof raw.metadata === 'object'
      ? (raw.metadata as Record<string, unknown>)
      : {}
  const display =
    meta.display && typeof meta.display === 'object'
      ? (meta.display as Record<string, unknown>)
      : {}
  const scene =
    meta.scene && typeof meta.scene === 'object' ? (meta.scene as Record<string, unknown>) : {}
  const pointers = Array.isArray(raw.pointers)
    ? raw.pointers.filter((p): p is string => typeof p === 'string')
    : []
  const parcels = Array.isArray(scene.parcels)
    ? scene.parcels.filter((p): p is string => typeof p === 'string')
    : pointers
  const base =
    typeof scene.base === 'string' && scene.base.trim()
      ? scene.base.trim()
      : parcels[0] ?? pointers[0] ?? '0,0'
  const main = typeof meta.main === 'string' ? meta.main.trim() : ''
  const rv = meta.runtimeVersion
  return {
    id,
    pointers,
    title: typeof display.title === 'string' ? display.title : '',
    main,
    runtimeVersion: rv === undefined || rv === null ? '' : String(rv).trim(),
    base,
    parcels,
    content: parseContent(raw.content)
  }
}

function pruneExpired(now: number): void {
  for (const [id, e] of entityById) {
    if (e.expiresAt <= now) entityById.delete(id)
  }
  for (const [p, e] of pointerOwner) {
    if (e.expiresAt <= now) pointerOwner.delete(p)
  }
  // Soft LRU: if over cap, drop oldest half by expiry
  if (pointerOwner.size > MAX_CACHED_POINTERS) {
    const sorted = [...pointerOwner.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    const drop = sorted.slice(0, Math.floor(sorted.length / 2))
    for (const [p] of drop) pointerOwner.delete(p)
  }
  if (entityById.size > MAX_CACHED_ENTITIES) {
    const sorted = [...entityById.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    const drop = sorted.slice(0, Math.floor(sorted.length / 2))
    for (const [id] of drop) entityById.delete(id)
  }
}

/**
 * Occupied footprint = catalyst pointers ∪ scene.parcels ∪ base.
 * Catalyst's pointer index can omit a cell that metadata.scene.parcels still
 * claims (POST `125,104` empty while the entity at `125,103` lists both).
 */
export function entityFootprintKeys(
  ent: Pick<ActiveSceneEntity, 'pointers' | 'parcels' | 'base'>
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of [...ent.pointers, ...ent.parcels, ent.base]) {
    const p = normalizePointer(typeof raw === 'string' ? raw : '')
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/** Catalyst `/entities/active` row → full occupied footprint (pointers ∪ scene.parcels). */
export function footprintKeysFromCatalystRecord(
  raw: Record<string, unknown>,
  id?: string
): string[] {
  const withId =
    typeof id === 'string' && id.trim() ? { ...raw, id: id.trim() } : raw
  const ent = normalizeEntity(withId)
  return ent ? entityFootprintKeys(ent) : []
}

function rememberEntity(ent: ActiveSceneEntity, now: number): void {
  const expiresAt = now + ENTITY_CACHE_TTL_MS
  entityById.set(ent.id, { entity: ent, expiresAt })
  const keys = entityFootprintKeys(ent)
  for (const raw of keys) {
    const p = normalizePointer(raw)
    // Prefer higher-rank owners when writing (same as buildPointerOwnershipMap intent).
    const prev = pointerOwner.get(p)
    if (prev && prev.expiresAt > now) {
      const prevEnt = entityById.get(prev.entityId)?.entity
      if (prevEnt && entityParcelClaimRank(prevEnt) > entityParcelClaimRank(ent)) continue
    }
    pointerOwner.set(p, { entityId: ent.id, expiresAt })
  }
}

async function fetchChunk(
  url: string,
  chunk: string[],
  contentUrl: string
): Promise<ActiveSceneEntity[]> {
  const key = `${contentUrl}|${chunk.join(';')}`
  const existing = inflightChunks.get(key)
  if (existing) return existing

  const promise = (async () => {
    networkChunks++
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointers: chunk })
      })
      if (!res.ok) return []
      const data = (await res.json()) as unknown
      if (!Array.isArray(data)) return []
      const out: ActiveSceneEntity[] = []
      for (const row of data) {
        if (!row || typeof row !== 'object') continue
        const ent = normalizeEntity(row as Record<string, unknown>)
        if (ent) out.push(ent)
      }
      return out
    } catch {
      return []
    } finally {
      inflightChunks.delete(key)
    }
  })()

  inflightChunks.set(key, promise)
  return promise
}

/**
 * Batch catalyst active entities for parcel pointers (chunks of 80).
 * Pointer-level TTL cache + in-flight chunk dedupe — AOI used to re-POST the same
 * ~80-parcel rings every 2.5s (hundreds of identical /entities/active calls).
 */
export async function fetchActiveEntitiesForPointers(
  contentUrl: string,
  pointers: string[]
): Promise<ActiveSceneEntity[]> {
  if (!pointers.length) return []
  const url = catalystEntitiesActiveUrl(contentUrl)
  const unique = [...new Set(pointers.map(normalizePointer))]
  const now = performance.now()
  pruneExpired(now)

  const byId = new Map<string, ActiveSceneEntity>()
  const needFetch: string[] = []

  for (const p of unique) {
    const hit = pointerOwner.get(p)
    if (hit && hit.expiresAt > now) {
      const ent = entityById.get(hit.entityId)?.entity
      if (ent && entityById.get(hit.entityId)!.expiresAt > now) {
        cacheHits++
        byId.set(ent.id, ent)
        continue
      }
    }
    cacheMisses++
    needFetch.push(p)
  }

  const chunkSize = 80
  for (let i = 0; i < needFetch.length; i += chunkSize) {
    const chunk = needFetch.slice(i, i + chunkSize)
    const fresh = await fetchChunk(url, chunk, contentUrl)
    const t = performance.now()
    for (const ent of fresh) {
      rememberEntity(ent, t)
      byId.set(ent.id, ent)
    }
  }

  // Single-pointer lookups: catalyst index can miss a cell the entity still claims
  // (POST `125,104` empty; POST `125,103` returns the 2-parcel scene listing both).
  // AOI rings already include neighbors — only probe when the original set is tiny.
  if (unique.length <= 2) {
    const stillNeed = unique.filter((p) => {
      const hit = pointerOwner.get(p)
      return !(hit && hit.expiresAt > performance.now() && entityById.get(hit.entityId))
    })
    if (stillNeed.length) {
      const extra = adjacentParcelPointers(stillNeed).filter((p) => !unique.includes(p))
      for (let i = 0; i < extra.length; i += chunkSize) {
        const chunk = extra.slice(i, i + chunkSize)
        const fresh = await fetchChunk(url, chunk, contentUrl)
        const t = performance.now()
        for (const ent of fresh) {
          rememberEntity(ent, t)
          if (entityFootprintKeys(ent).some((k) => unique.includes(k))) {
            byId.set(ent.id, ent)
          }
        }
      }
    }
  }

  // Multi-parcel entities from cache may cover more pointers than we requested — fine.
  return [...byId.values()]
}

const ORTHOGONAL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
]

function adjacentParcelPointers(pointers: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of pointers) {
    const p = normalizePointer(raw)
    const m = /^(-?\d+),(-?\d+)$/.exec(p)
    if (!m) continue
    const x = Number(m[1])
    const y = Number(m[2])
    for (const [dx, dy] of ORTHOGONAL) {
      const k = `${x + dx},${y + dy}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(k)
    }
  }
  return out
}

/** Dev / diagnostics — cache effectiveness for AOI spam. */
export function getActiveEntitiesCacheStats(): {
  hits: number
  misses: number
  networkChunks: number
  pointersCached: number
  entitiesCached: number
} {
  return {
    hits: cacheHits,
    misses: cacheMisses,
    networkChunks,
    pointersCached: pointerOwner.size,
    entitiesCached: entityById.size
  }
}

/** Test helper. */
export function clearActiveEntitiesCache(): void {
  entityById.clear()
  pointerOwner.clear()
  inflightChunks.clear()
  cacheHits = 0
  cacheMisses = 0
  networkChunks = 0
}

/**
 * Parcel should not get blank empty-land floor — foundation open-road tiles,
 * multi-parcel road scenes (Tram Line, plaza roads), or explicit road titles.
 * Not a composite secondary target.
 */
export function isOpenRoadEntity(ent: ActiveSceneEntity): boolean {
  if (/^Road at /i.test(ent.title)) return true
  if (/\broads?\b/i.test(ent.title) && /road|tram/i.test(ent.title)) return true

  const main = ent.main.toLowerCase()
  const isGameJs = main === 'game.js' || main.endsWith('/game.js')
  if (!isGameJs && !/road/i.test(ent.title)) return false

  // Classic foundation open-road GLBs at content root
  if (
    ent.content.some((c) => {
      const base = c.file.split('/').pop() ?? c.file
      return /^(OpenRoad_|OpenFork_|OpenCorner_|Road_|DeadEnd_|Fork_|Corner_|EmptyFork_)/i.test(
        base
      )
    })
  ) {
    return true
  }

  // Nested road packs (Tram Line models/roads/*) — skip blank only
  if (isGameJs && ent.content.some((c) => /\/roads?\/|road_/i.test(c.file))) return true
  if (isGameJs && /road|openroad|openfork|deadend|corner|tram/i.test(ent.title)) return true
  return false
}

export function findCompositeFile(
  content: { file: string; hash: string }[]
): { file: string; hash: string } | null {
  return (
    content.find((c) => c.file === 'main.composite' || c.file === 'assets/scene/main.composite') ??
    content.find((c) => c.file.endsWith('.composite') || c.file.endsWith('main.composite')) ??
    null
  )
}

/**
 * Catalyst "empty land" placeholders (Builder interactive-text + SCENE.glb)
 * and titled Empty parcels — visual fill only, never a nearby-scene live/shell slot.
 */
export function isCatalystEmptyLandEntity(ent: ActiveSceneEntity): boolean {
  const title = ent.title.trim().toLowerCase()
  if (title === 'interactive-text' || title === 'empty' || title === 'empty parcel') {
    return true
  }
  const main = ent.main.toLowerCase()
  if (!(main === 'game.js' || main.endsWith('/game.js') || main === 'bin/game.js')) {
    return false
  }
  // Single-parcel SDK6 with only floor / scene.json — treat as empty land.
  const parcels = ent.parcels.length ? ent.parcels : ent.pointers
  if (parcels.length !== 1) return false
  const glbs = ent.content.filter((c) => /\.glb$/i.test(c.file))
  if (glbs.length === 0) return true
  if (glbs.length === 1) {
    const f = (glbs[0]!.file.split('/').pop() ?? '').toLowerCase()
    if (f === 'scene.glb' || f.includes('floorbase') || f.includes('empty')) return true
  }
  return false
}

/** Classic single-parcel foundation open-road tile (game.js + OpenRoad_*.glb). */
export function isClassicOpenRoadContent(ent: ActiveSceneEntity): boolean {
  const main = ent.main.toLowerCase()
  if (main !== 'game.js' && !main.endsWith('/game.js')) return false
  const parcels = ent.parcels.length ? ent.parcels : ent.pointers
  if (parcels.length !== 1) return false
  if (/^Road at /i.test(ent.title)) return true
  return ent.content.some((c) => {
    const base = c.file.split('/').pop() ?? c.file
    return /^(OpenRoad_|OpenFork_|OpenCorner_|Road_|DeadEnd_|Fork_|Corner_|EmptyFork_)/i.test(
      base
    )
  })
}

/**
 * SDK7-style scene that can supply secondary visuals (composite and/or manifest GLBs).
 * Excludes classic open-road tiles.
 */
export function isCompositeVisualCandidate(ent: ActiveSceneEntity): boolean {
  if (isClassicOpenRoadContent(ent)) return false
  if (findCompositeFile(ent.content)) return true
  const rv = ent.runtimeVersion
  if (rv === '7' || rv.startsWith('7.')) return true
  const main = ent.main.toLowerCase()
  if (main.includes('bin/index.js') || main.endsWith('index.js')) return true
  return false
}

/**
 * SDK7 script entry (`bin/index.js` / `index.js`) — not classic SDK6 `game.js` CityTiles.
 * Composite + game.js estates use the composite shell path only.
 */
export function isSdk7ScriptEntry(
  ent: Pick<ActiveSceneEntity, 'main' | 'runtimeVersion'>
): boolean {
  const main = ent.main.toLowerCase().trim()
  if (!main) return false
  if (main === 'game.js' || main.endsWith('/game.js') || main === 'bin/game.js') return false
  const rv = ent.runtimeVersion
  if (rv === '6' || rv.startsWith('6.')) return false
  if (rv === '7' || rv.startsWith('7.')) return true
  if (main.includes('bin/index.js') || main.endsWith('/index.js')) return true
  return !main.includes('game.js')
}

/** Explorer first-frame bake — SDK7 script scenes (runs alongside composite shell when present). */
export function isFirstFrameSecondaryCandidate(ent: ActiveSceneEntity): boolean {
  if (!isSecondarySceneCandidate(ent)) return false
  if (isOpenRoadEntity(ent)) return false
  return isSdk7ScriptEntry(ent)
}

/** Occupied SDK7/composite scene worth a nearby live/shell slot — not road or empty land. */
export function isSecondarySceneCandidate(ent: ActiveSceneEntity): boolean {
  if (isClassicOpenRoadContent(ent)) return false
  if (isCatalystEmptyLandEntity(ent)) return false
  if (!isCompositeVisualCandidate(ent)) return false
  if (findCompositeFile(ent.content)) return true
  const parcels = ent.parcels.length ? ent.parcels : ent.pointers
  if (parcels.length >= 2) return true
  const glbs = ent.content.filter((c) => /\.glb$/i.test(c.file)).length
  return glbs >= 3
}

/**
 * Higher rank wins when multiple entities mention the same pointer
 * (should be rare; defensive against stale road + multi-parcel race).
 */
export function entityParcelClaimRank(ent: ActiveSceneEntity): number {
  if (isClassicOpenRoadContent(ent)) return 10
  if (isOpenRoadEntity(ent) && !isCompositeVisualCandidate(ent)) return 20
  const parcels = ent.parcels.length ? ent.parcels : ent.pointers
  if (isCompositeVisualCandidate(ent) || findCompositeFile(ent.content)) {
    return 100 + Math.min(parcels.length, 500)
  }
  return 40 + Math.min(parcels.length, 50)
}

/** Prefer multi-parcel scenes over single-parcel roads for pointer ownership. */
export function buildPointerOwnershipMap(
  entities: ActiveSceneEntity[]
): Map<string, ActiveSceneEntity> {
  const map = new Map<string, ActiveSceneEntity>()
  const rankAt = new Map<string, number>()
  for (const ent of entities) {
    const rank = entityParcelClaimRank(ent)
    const keys = entityFootprintKeys(ent)
    for (const p of keys) {
      const prev = rankAt.get(p) ?? -1
      if (rank >= prev) {
        rankAt.set(p, rank)
        map.set(p, ent)
      }
    }
  }
  return map
}
