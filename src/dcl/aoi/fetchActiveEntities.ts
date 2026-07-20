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

/** Batch catalyst active entities for parcel pointers (chunks of 80). */
export async function fetchActiveEntitiesForPointers(
  contentUrl: string,
  pointers: string[]
): Promise<ActiveSceneEntity[]> {
  if (!pointers.length) return []
  const url = catalystEntitiesActiveUrl(contentUrl)
  const unique = [...new Set(pointers.map(normalizePointer))]
  const byId = new Map<string, ActiveSceneEntity>()
  const chunkSize = 80
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointers: chunk })
      })
      if (!res.ok) continue
      const data = (await res.json()) as unknown
      if (!Array.isArray(data)) continue
      for (const row of data) {
        if (!row || typeof row !== 'object') continue
        const ent = normalizeEntity(row as Record<string, unknown>)
        if (ent) byId.set(ent.id, ent)
      }
    } catch {
      /* network — skip chunk */
    }
  }
  return [...byId.values()]
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

/** Multi-parcel (or multi-glb) scene worth a secondary slot — not a 1×1 road/empty. */
export function isSecondarySceneCandidate(ent: ActiveSceneEntity): boolean {
  if (isClassicOpenRoadContent(ent)) return false
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
    const keys = ent.pointers.length ? ent.pointers : ent.parcels
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
