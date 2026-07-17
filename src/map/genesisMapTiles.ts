/**
 * Genesis City basemap tiles — multi-LOD satellite pyramid.
 *
 * Source (Unity Explorer / genesis-city):
 *   media.githubusercontent.com/.../genesis-city/parcels/new-client-images/maps/lod-0/{level}/{x},{y}.jpg
 *
 * Each tile is 512×512. Higher `level` = denser grid = more px per parcel (sharper when zoomed in).
 *
 * | level | grid   | parcels/chunk | ~px/parcel |
 * | ----- | ------ | ------------- | ---------- |
 * | 3     | 8×8    | 40            | 12.8       |
 * | 4     | 16×16  | 20            | 25.6       |
 * | 5     | 32×32  | 10            | 51.2       |
 * | 6     | 64×64  | 5             | 102.4      |
 *
 * Override root with `VITE_GENESIS_TILE_BASE_URL` (…/maps/lod-0 or legacy …/lod-0/3).
 */

/** Satellite LOD levels present under maps/lod-0/{level}/ */
export type SatelliteLodLevel = 3 | 4 | 5 | 6

/** World coverage shared by all LODs (level-3 Unity constants). */
export const SATELLITE_MIN_PARCEL_X = -153
export const SATELLITE_MAX_PARCEL_Y = 152
/** 8 chunks × 40 parcels (level 3). */
export const SATELLITE_WORLD_SPAN_PARCELS = 320

/** Level-3 grid (legacy default). */
export const SATELLITE_GRID_SIZE = 8
/** Level-3 parcels per chunk (legacy default). */
export const SATELLITE_PARCELS_PER_CHUNK = 40

const LOD_GRID: Record<SatelliteLodLevel, number> = {
  3: 8,
  4: 16,
  5: 32,
  6: 64
}

/** Normalize env base to `…/maps/lod-0` (strip trailing /3 if present). */
function normalizeLodRoot(raw: string): string {
  return raw
    .replace(/\/+$/, '')
    .replace(/\/[1-6]$/, '')
}

/**
 * Root for lod-0 pyramid (no level suffix).
 * Legacy env values ending in `/3` are still accepted.
 */
export const GENESIS_TILE_LOD_ROOT = normalizeLodRoot(
  import.meta.env.VITE_GENESIS_TILE_BASE_URL?.trim() ||
    'https://media.githubusercontent.com/media/genesis-city/parcels/new-client-images/maps/lod-0'
)

/** @deprecated Prefer GENESIS_TILE_LOD_ROOT + level; kept for importers. */
export const GENESIS_TILE_BASE_URL = `${GENESIS_TILE_LOD_ROOT}/3`

/** @deprecated Old genesis.city pad — unused by viewport. */
export const GENESIS_TILE_PAD = 30

/** Display zoom ladder (not a remote pyramid by itself). */
export const GENESIS_MAX_ZOOM = 6

/**
 * Baseline display zoom where one level-3 tile is {@link TILE_DISPLAY_PX} wide.
 * Higher display zoom CSS-scales tiles; we also pick denser LODs for real detail.
 */
export const MAP_TILE_FETCH_ZOOM = 4

/**
 * On-screen size of one **level-3** 40-parcel chunk at {@link MAP_TILE_FETCH_ZOOM}.
 * Other LODs scale tile CSS size by parcelsPerChunk ratio so 1 parcel = same screen size.
 */
export const TILE_DISPLAY_PX = 320

export function satelliteGridSize(lod: SatelliteLodLevel): number {
  return LOD_GRID[lod]
}

export function satelliteParcelsPerChunk(lod: SatelliteLodLevel): number {
  return SATELLITE_WORLD_SPAN_PARCELS / LOD_GRID[lod]
}

/**
 * Pick denser satellite LOD as the user zooms in.
 * Display zoom 4–5 → L3; 6 → L4; 7 → L5; 8+ → L6.
 */
export function satelliteLodForZoom(zoom: number): SatelliteLodLevel {
  if (zoom >= 8) return 6
  if (zoom >= 7) return 5
  if (zoom >= 6) return 4
  return 3
}

/** URL for one satellite chunk at a pyramid level. */
export function satelliteTileUrl(lod: SatelliteLodLevel, tx: number, ty: number): string {
  return `${GENESIS_TILE_LOD_ROOT}/${lod}/${tx},${ty}.jpg`
}
