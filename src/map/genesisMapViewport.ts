import {
  GENESIS_TILE_BASE_URL,
  MAP_TILE_FETCH_ZOOM,
  SATELLITE_GRID_SIZE,
  SATELLITE_MAX_PARCEL_Y,
  SATELLITE_MIN_PARCEL_X,
  SATELLITE_PARCELS_PER_CHUNK,
  TILE_DISPLAY_PX
} from './genesisMapTiles'

export const VIEWPORT_FETCH_ZOOM = MAP_TILE_FETCH_ZOOM
export const VIEWPORT_MIN_ZOOM = 4
/** Extra steps for close-zoom parcel map.png layer (Unity ParcelAtlas). */
export const VIEWPORT_MAX_ZOOM = 8
export const VIEWPORT_DEFAULT_ZOOM = 5

/** Plaza (0,0) sits near tile (3.8, 3.8) of the 8×8 satellite grid. */
export const VIEWPORT_DEFAULT_CENTER_TILE = { x: 3.825, y: 3.825 }

export type MapViewState = {
  zoom: number
  centerTileX: number
  centerTileY: number
  panX: number
  panY: number
}

export type ScreenRect = { left: number; top: number; size: number }

export type VisibleTile = ScreenRect & { tx: number; ty: number }

const CHUNK = SATELLITE_PARCELS_PER_CHUNK

/** Display-only scale between zoom steps (remote tiles always lod-0/3). */
function displayZoomScale(z: number): number {
  return Math.pow(2, z - VIEWPORT_FETCH_ZOOM)
}

export function tileDisplayPx(z: number): number {
  return TILE_DISPLAY_PX * displayZoomScale(z)
}

/** Satellite grid is always 8×8 at the fetch level. */
export function tileGridSize(_z?: number): number {
  return SATELLITE_GRID_SIZE
}

function clampTile(tx: number, ty: number): { tx: number; ty: number } | null {
  if (tx < 0 || ty < 0 || tx >= SATELLITE_GRID_SIZE || ty >= SATELLITE_GRID_SIZE) return null
  return { tx, ty }
}

/**
 * Unity SatelliteChunkController URL:
 *   …/maps/lod-0/3/{tx}%2C{ty}.jpg
 * Zoom arg ignored — basemap is a single LOD (CSS zoom scales tiles).
 */
export function mapTileUrl(_z: number, tx: number, ty: number): string {
  return `${GENESIS_TILE_BASE_URL}/${tx},${ty}.jpg`
}

/** Parcel → continuous tile coords (chunk index + fraction inside chunk). */
function parcelToTileCenter(px: number, py: number): { x: number; y: number } {
  const x = (px - SATELLITE_MIN_PARCEL_X + 0.5) / CHUNK
  const y = (SATELLITE_MAX_PARCEL_Y - py + 0.5) / CHUNK
  return { x, y }
}

function tileCenterToParcel(cx: number, cy: number): { x: number; y: number } {
  // Invert parcelToTileCenter: x = (px - MIN + 0.5)/CHUNK, y = (MAX - py + 0.5)/CHUNK
  const pxExact = SATELLITE_MIN_PARCEL_X - 0.5 + cx * CHUNK
  const pyExact = SATELLITE_MAX_PARCEL_Y + 0.5 - cy * CHUNK
  return {
    x: Math.floor(pxExact),
    y: Math.floor(pyExact)
  }
}

/** Map viewport click position → Genesis parcel indices. */
export function screenPointToParcel(
  sx: number,
  sy: number,
  viewW: number,
  viewH: number,
  view: MapViewState
): { px: number; py: number } | null {
  const tilePx = tileDisplayPx(view.zoom)
  const viewCenterPxX = view.centerTileX * tilePx + view.panX
  const viewCenterPxY = view.centerTileY * tilePx + view.panY
  const tileX = (sx - viewW / 2 + viewCenterPxX) / tilePx
  const tileY = (sy - viewH / 2 + viewCenterPxY) / tilePx
  const { x, y } = tileCenterToParcel(tileX, tileY)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { px: x, py: y }
}

export function centerViewOnParcel(view: MapViewState, px: number, py: number): MapViewState {
  const c = parcelToTileCenter(px, py)
  return {
    ...view,
    centerTileX: c.x,
    centerTileY: c.y,
    panX: 0,
    panY: 0
  }
}

export function parcelScreenRect(
  px: number,
  py: number,
  viewW: number,
  viewH: number,
  view: MapViewState
): ScreenRect | null {
  const tilePx = tileDisplayPx(view.zoom)
  /** One parcel as a fraction of a 40-parcel satellite chunk. */
  const span = 1 / CHUNK
  const center = parcelToTileCenter(px, py)
  const topLeftX = center.x - span / 2
  const topLeftY = center.y - span / 2
  const viewCenterPxX = view.centerTileX * tilePx + view.panX
  const viewCenterPxY = view.centerTileY * tilePx + view.panY
  const left = viewW / 2 + topLeftX * tilePx - viewCenterPxX
  const top = viewH / 2 + topLeftY * tilePx - viewCenterPxY
  const size = span * tilePx
  if (left + size < 0 || top + size < 0 || left > viewW || top > viewH) return null
  return { left, top, size }
}

const PARCEL_SIZE_M = 16

export function playerMarkerRect(
  parcelKey: string | null,
  position: { x: number; y: number; z: number } | null,
  viewW: number,
  viewH: number,
  view: MapViewState,
  minMarkerPx = 28
): (ScreenRect & { labelAnchorX: number }) | null {
  if (!parcelKey) return null
  const m = /^(-?\d+),(-?\d+)$/.exec(parcelKey.trim())
  if (!m) return null
  const px = parseInt(m[1]!, 10)
  const py = parseInt(m[2]!, 10)
  const base = parcelScreenRect(px, py, viewW, viewH, view)
  if (!base) return null

  let fx = 0.5
  let fy = 0.5
  if (position) {
    const localX = ((Number(position.x) % PARCEL_SIZE_M) + PARCEL_SIZE_M) % PARCEL_SIZE_M
    const localZ = ((Number(position.z) % PARCEL_SIZE_M) + PARCEL_SIZE_M) % PARCEL_SIZE_M
    fx = localX / PARCEL_SIZE_M
    fy = 1 - localZ / PARCEL_SIZE_M
  }

  const dot = Math.max(minMarkerPx, Math.min(base.size * 0.55, 36))
  return {
    left: base.left + base.size * fx - dot / 2,
    top: base.top + base.size * fy - dot / 2,
    size: dot,
    labelAnchorX: base.left + base.size * fx
  }
}

export function visibleTiles(viewW: number, viewH: number, view: MapViewState): VisibleTile[] {
  const tilePx = tileDisplayPx(view.zoom)
  const viewCenterPxX = view.centerTileX * tilePx + view.panX
  const viewCenterPxY = view.centerTileY * tilePx + view.panY
  const minTx = Math.floor((viewCenterPxX - viewW / 2) / tilePx) - 1
  const maxTx = Math.ceil((viewCenterPxX + viewW / 2) / tilePx) + 1
  const minTy = Math.floor((viewCenterPxY - viewH / 2) / tilePx) - 1
  const maxTy = Math.ceil((viewCenterPxY + viewH / 2) / tilePx) + 1
  const out: VisibleTile[] = []
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      if (!clampTile(tx, ty)) continue
      out.push({
        tx,
        ty,
        left: viewW / 2 + tx * tilePx - viewCenterPxX,
        top: viewH / 2 + ty * tilePx - viewCenterPxY,
        size: tilePx
      })
    }
  }
  return out
}

export function genesisMetersToParcel(
  genesisX: number,
  genesisZ: number
): { px: number; py: number; parcelKey: string } {
  const px = Math.floor(genesisX / PARCEL_SIZE_M)
  const py = Math.floor(genesisZ / PARCEL_SIZE_M)
  return { px, py, parcelKey: `${px},${py}` }
}
