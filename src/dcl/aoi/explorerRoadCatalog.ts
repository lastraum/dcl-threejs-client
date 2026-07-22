/**
 * Explorer Genesis City roads — parcel → model + rotation.
 * Source of truth: unity-explorer `SingleParcelRoadInfo.json` (RoadParser → RoadDescription).
 * NOT runtime SDK6 game.js.
 */

export type ExplorerRoadEntry = {
  /** Prefab / FBX name without extension, e.g. OpenRoad_A */
  model: string
  /** DCL-space quaternion (same as game.js / JSON). */
  rotation: { x: number; y: number; z: number; w: number }
}

type RawRoadInfo = {
  model?: string
  rotation?: string
  position?: string
  scale?: string
}

let catalogPromise: Promise<Map<string, ExplorerRoadEntry>> | null = null
let catalog: Map<string, ExplorerRoadEntry> | null = null

/** Parse Unity-style "(x, y, z, w)" quaternion string. */
export function parseUnityQuatString(s: string): { x: number; y: number; z: number; w: number } {
  const t = s.trim()
  const inner = t.startsWith('(') && t.endsWith(')') ? t.slice(1, -1) : t
  const parts = inner.split(',').map((p) => Number(p.trim()))
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) {
    return { x: 0, y: 0, z: 0, w: 1 }
  }
  const [x, y, z, w] = parts as [number, number, number, number]
  // Zero quat → identity (Explorer RoadDescription does the same)
  if (x === 0 && y === 0 && z === 0 && w === 0) return { x: 0, y: 0, z: 0, w: 1 }
  return { x, y, z, w }
}

function modelBaseName(model: string): string {
  const base = model.split('/').pop() ?? model
  return base.replace(/\.glb$/i, '').replace(/\.fbx$/i, '')
}

/**
 * Load Explorer road catalog (once). Served from `/roads/SingleParcelRoadInfo.json`
 * (copied from unity-explorer Roads data).
 */
export function loadExplorerRoadCatalog(): Promise<Map<string, ExplorerRoadEntry>> {
  if (catalog) return Promise.resolve(catalog)
  if (catalogPromise) return catalogPromise

  catalogPromise = (async () => {
    // Vite serves public/ at site root
    const res = await fetch('/roads/SingleParcelRoadInfo.json')
    if (!res.ok) throw new Error(`Road catalog fetch failed ${res.status}`)
    return parseCatalog(await res.json())
  })()
    .then((map) => {
      catalog = map
      console.info(`[roads] Explorer catalog loaded — ${map.size} parcels`)
      return map
    })
    .catch((err) => {
      catalogPromise = null
      console.warn('[roads] Explorer catalog failed', err)
      catalog = new Map()
      return catalog
    })

  return catalogPromise
}

function parseCatalog(raw: Record<string, RawRoadInfo>): Map<string, ExplorerRoadEntry> {
  const map = new Map<string, ExplorerRoadEntry>()
  for (const [key, info] of Object.entries(raw)) {
    if (!info?.model) continue
    map.set(key.trim(), {
      model: modelBaseName(info.model),
      rotation: parseUnityQuatString(info.rotation ?? '(0,0,0,1)')
    })
  }
  return map
}

export function getExplorerRoadEntry(
  parcelKey: string
): ExplorerRoadEntry | null {
  return catalog?.get(parcelKey.trim()) ?? null
}

export function isExplorerRoadParcel(parcelKey: string): boolean {
  return catalog?.has(parcelKey.trim()) ?? false
}

/** Local FBX path for Explorer original road assets (with street furniture). */
export function explorerRoadFbxUrl(model: string): string {
  const name = modelBaseName(model)
  return `/roads/models/${name}.fbx`
}

/** Models we shipped under public/roads/models (missing variants fall back). */
export const EXPLORER_ROAD_FBX_FALLBACK = 'OpenRoad_0'
