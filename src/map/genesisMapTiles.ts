/**
 * Genesis City basemap tiles — Unity Explorer SatelliteAtlas parity.
 *
 * Unity (`SatelliteChunkController`) loads:
 *   genesis-city/parcels@new-client-images / maps/lod-0/3/{x},{y}.jpg
 * (8×8 grid, 40 parcels per chunk). That tree is updated monthly; the older
 * genesis.city `map/latest` pyramid stalled ~Jan 2025.
 *
 * Override base with `VITE_GENESIS_TILE_BASE_URL` if self-hosting.
 */

/** Grid size at lod-0/3 (Unity GRID_SIZE). */
export const SATELLITE_GRID_SIZE = 8

/** Parcels covered by one satellite chunk (Unity PARCELS_INSIDE_CHUNK). */
export const SATELLITE_PARCELS_PER_CHUNK = 40

/**
 * SW-most parcel X of coverage. Unity: WorldMin (-150) − 3 border parcels
 * on the satellite image outside the city.
 */
export const SATELLITE_MIN_PARCEL_X = -153

/**
 * North-most parcel Y of coverage (top edge of chunk row 0).
 * Chunk (0,0) center ≈ (-133, 132) with half-size 20 → top Y = 152.
 */
export const SATELLITE_MAX_PARCEL_Y = 152

/**
 * Zoomed satellite JPG base (no trailing slash). Path ends at lod level;
 * tiles are `{tx},{ty}.jpg` under this base.
 */
export const GENESIS_TILE_BASE_URL = (
  import.meta.env.VITE_GENESIS_TILE_BASE_URL?.trim() ||
  'https://media.githubusercontent.com/media/genesis-city/parcels/new-client-images/maps/lod-0/3'
).replace(/\/+$/, '')

/** @deprecated Old genesis.city pad — kept for any external importers; unused by viewport. */
export const GENESIS_TILE_PAD = 30

/** Display zoom ladder (not a remote pyramid). */
export const GENESIS_MAX_ZOOM = 6

/**
 * Fetch level label for API compat — all tiles come from lod-0/3.
 * Display zoom still scales tile CSS size from this baseline.
 */
export const MAP_TILE_FETCH_ZOOM = 4

/**
 * On-screen size of one 40-parcel satellite chunk at {@link MAP_TILE_FETCH_ZOOM}.
 * ~8px per parcel (was 8px with old z4 5-parcel tiles).
 */
export const TILE_DISPLAY_PX = 320
