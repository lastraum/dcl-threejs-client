import {
  MAP_TILE_FETCH_ZOOM,
  SATELLITE_MAX_PARCEL_Y,
  SATELLITE_MIN_PARCEL_X,
  TILE_DISPLAY_PX,
  satelliteGridSize,
  satelliteLodForZoom,
  satelliteParcelsPerChunk,
  satelliteTileUrl,
  type SatelliteLodLevel
} from './genesisMapTiles'

export { satelliteLodForZoom, type SatelliteLodLevel } from './genesisMapTiles'

export const VIEWPORT_FETCH_ZOOM = MAP_TILE_FETCH_ZOOM
export const VIEWPORT_MIN_ZOOM = 4
/** Extra steps for close-zoom multi-LOD satellite (and optional parcel layer on full map). */
export const VIEWPORT_MAX_ZOOM = 8
export const VIEWPORT_DEFAULT_ZOOM = 5

/**
 * Satellite atlas ↔ Genesis parcel X calibration.
 * Click on Angzaar SW (−9,−91) was reporting −11 with +1; use −1 so popup matches world.
 * (reportX ≈ rawX − SHIFT → more negative SHIFT raises reported X.)
 */
export const MAP_PARCEL_X_SHIFT = -1

/** Plaza (0,0) parcel center in **level-3** continuous tile space (includes X shift). */
export const VIEWPORT_DEFAULT_CENTER_TILE = {
  x: (0 + MAP_PARCEL_X_SHIFT - SATELLITE_MIN_PARCEL_X + 0.5) / 40,
  y: (SATELLITE_MAX_PARCEL_Y - 0 + 0.5) / 40
}

export type MapViewState = {
  zoom: number
  /**
   * Continuous center in **level-3** tile space (0…8).
   * Higher LODs reproject: tileL = center * (gridL / 8).
   */
  centerTileX: number
  centerTileY: number
  panX: number
  panY: number
}

export type ScreenRect = { left: number; top: number; size: number }

export type VisibleTile = ScreenRect & { tx: number; ty: number; lod: SatelliteLodLevel }

const L3_GRID = 8

/** Display-only scale between zoom steps (CSS). */
function displayZoomScale(z: number): number {
  return Math.pow(2, z - VIEWPORT_FETCH_ZOOM)
}

/**
 * CSS px for one tile at this zoom **and LOD**.
 * Level-3 at baseline zoom → TILE_DISPLAY_PX; denser LODs use smaller tiles
 * so each parcel keeps the same screen size.
 */
export function tileDisplayPx(z: number, lod: SatelliteLodLevel = satelliteLodForZoom(z)): number {
  const l3Size = TILE_DISPLAY_PX * displayZoomScale(z)
  const scale = L3_GRID / satelliteGridSize(lod)
  return l3Size * scale
}

/** @deprecated Use satelliteGridSize(satelliteLodForZoom(z)). */
export function tileGridSize(z?: number): number {
  return satelliteGridSize(satelliteLodForZoom(z ?? VIEWPORT_DEFAULT_ZOOM))
}

/**
 * Satellite chunk URL for the LOD that matches display zoom.
 * `z` selects LOD; `tx,ty` are indices in that LOD’s grid.
 */
export function mapTileUrl(z: number, tx: number, ty: number): string {
  const lod = satelliteLodForZoom(z)
  return satelliteTileUrl(lod, tx, ty)
}

export function mapTileUrlForLod(lod: SatelliteLodLevel, tx: number, ty: number): string {
  return satelliteTileUrl(lod, tx, ty)
}

/** Level-3 continuous tile coords from parcel. */
function parcelToL3TileCenter(px: number, py: number): { x: number; y: number } {
  const chunk = satelliteParcelsPerChunk(3)
  const x = (px + MAP_PARCEL_X_SHIFT - SATELLITE_MIN_PARCEL_X + 0.5) / chunk
  const y = (SATELLITE_MAX_PARCEL_Y - py + 0.5) / chunk
  return { x, y }
}

function l3TileCenterToParcel(cx: number, cy: number): { x: number; y: number } {
  const chunk = satelliteParcelsPerChunk(3)
  const pxExact = SATELLITE_MIN_PARCEL_X - 0.5 + cx * chunk - MAP_PARCEL_X_SHIFT
  const pyExact = SATELLITE_MAX_PARCEL_Y + 0.5 - cy * chunk
  return {
    x: Math.floor(pxExact),
    y: Math.floor(pyExact)
  }
}

/** Project level-3 continuous coords into a denser LOD’s tile space. */
export function l3ToLodTile(l3x: number, l3y: number, lod: SatelliteLodLevel): { x: number; y: number } {
  const scale = satelliteGridSize(lod) / L3_GRID
  return { x: l3x * scale, y: l3y * scale }
}

function clampTile(lod: SatelliteLodLevel, tx: number, ty: number): { tx: number; ty: number } | null {
  const g = satelliteGridSize(lod)
  if (tx < 0 || ty < 0 || tx >= g || ty >= g) return null
  return { tx, ty }
}

/** Map viewport click position → Genesis parcel indices. */
export function screenPointToParcel(
  sx: number,
  sy: number,
  viewW: number,
  viewH: number,
  view: MapViewState
): { px: number; py: number } | null {
  const lod = satelliteLodForZoom(view.zoom)
  const tilePx = tileDisplayPx(view.zoom, lod)
  // pan is in CSS px; convert to level-3 tile fractions via L3 tile size
  const l3TilePx = tileDisplayPx(view.zoom, 3)
  const panL3X = view.panX / l3TilePx
  const panL3Y = view.panY / l3TilePx
  const centerWithPan = l3ToLodTile(
    view.centerTileX + panL3X,
    view.centerTileY + panL3Y,
    lod
  )
  const tileX = (sx - viewW / 2) / tilePx + centerWithPan.x
  const tileY = (sy - viewH / 2) / tilePx + centerWithPan.y
  // back to L3 then parcel
  const scale = L3_GRID / satelliteGridSize(lod)
  const { x, y } = l3TileCenterToParcel(tileX * scale, tileY * scale)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { px: x, py: y }
}

export function centerViewOnParcel(view: MapViewState, px: number, py: number): MapViewState {
  const c = parcelToL3TileCenter(px, py)
  return {
    ...view,
    centerTileX: c.x,
    centerTileY: c.y,
    panX: 0,
    panY: 0
  }
}

const PARCEL_SIZE_M = 16

/**
 * Center on continuous Genesis City meters (player feet).
 * Matches `centerViewOnParcel` + sub-parcel offset (same projection as Unity lod-0).
 */
export function centerViewOnGenesisMeters(
  view: MapViewState,
  genesisX: number,
  genesisZ: number
): MapViewState {
  const chunk = satelliteParcelsPerChunk(3)
  // Continuous parcel indices (SW of parcel N is N.0; center is N.5).
  const pxf = genesisX / PARCEL_SIZE_M
  const pyf = genesisZ / PARCEL_SIZE_M
  // Inverse of parcelToL3TileCenter + fractional offset (+ MAP_PARCEL_X_SHIFT):
  //   integer center: (p + SHIFT - MIN + 0.5) / chunk  and  (MAX - p + 0.5) / chunk
  //   → (pxf + SHIFT - MIN) / chunk  and  (MAX + 1 - pyf) / chunk
  return {
    ...view,
    centerTileX: (pxf + MAP_PARCEL_X_SHIFT - SATELLITE_MIN_PARCEL_X) / chunk,
    centerTileY: (SATELLITE_MAX_PARCEL_Y + 1 - pyf) / chunk,
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
  const lod = satelliteLodForZoom(view.zoom)
  const tilePx = tileDisplayPx(view.zoom, lod)
  const chunk = satelliteParcelsPerChunk(lod)
  const span = 1 / chunk // one parcel in this LOD’s tile units
  const centerL3 = parcelToL3TileCenter(px, py)
  const center = l3ToLodTile(centerL3.x, centerL3.y, lod)
  const topLeftX = center.x - span / 2
  const topLeftY = center.y - span / 2

  const l3TilePx = tileDisplayPx(view.zoom, 3)
  const panLodX = (view.panX / l3TilePx) * (satelliteGridSize(lod) / L3_GRID)
  const panLodY = (view.panY / l3TilePx) * (satelliteGridSize(lod) / L3_GRID)
  const viewCenterLod = l3ToLodTile(view.centerTileX, view.centerTileY, lod)
  const vcx = viewCenterLod.x + panLodX
  const vcy = viewCenterLod.y + panLodY
  const left = viewW / 2 + (topLeftX - vcx) * tilePx
  const top = viewH / 2 + (topLeftY - vcy) * tilePx
  const size = span * tilePx
  if (left + size < 0 || top + size < 0 || left > viewW || top > viewH) return null
  return { left, top, size }
}

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
  const lod = satelliteLodForZoom(view.zoom)
  const tilePx = tileDisplayPx(view.zoom, lod)
  const centerLod = l3ToLodTile(view.centerTileX, view.centerTileY, lod)
  const l3TilePx = tileDisplayPx(view.zoom, 3)
  const panLodX = (view.panX / l3TilePx) * (satelliteGridSize(lod) / L3_GRID)
  const panLodY = (view.panY / l3TilePx) * (satelliteGridSize(lod) / L3_GRID)
  const viewCenterX = centerLod.x + panLodX
  const viewCenterY = centerLod.y + panLodY
  const viewCenterPxX = viewCenterX * tilePx
  const viewCenterPxY = viewCenterY * tilePx

  const minTx = Math.floor((viewCenterPxX - viewW / 2) / tilePx) - 1
  const maxTx = Math.ceil((viewCenterPxX + viewW / 2) / tilePx) + 1
  const minTy = Math.floor((viewCenterPxY - viewH / 2) / tilePx) - 1
  const maxTy = Math.ceil((viewCenterPxY + viewH / 2) / tilePx) + 1
  const out: VisibleTile[] = []
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      if (!clampTile(lod, tx, ty)) continue
      out.push({
        tx,
        ty,
        lod,
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
