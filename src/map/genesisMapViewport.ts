import {
  GENESIS_MAX_ZOOM,
  GENESIS_TILE_BASE_URL,
  GENESIS_TILE_PAD,
  MAP_TILE_FETCH_ZOOM,
  TILE_DISPLAY_PX
} from './genesisMapTiles'

export const VIEWPORT_FETCH_ZOOM = MAP_TILE_FETCH_ZOOM
export const VIEWPORT_MIN_ZOOM = 4
export const VIEWPORT_MAX_ZOOM = 6
export const VIEWPORT_DEFAULT_ZOOM = 5
export const VIEWPORT_DEFAULT_CENTER_TILE = { x: 7.625, y: 7.625 }

export type MapViewState = {
  zoom: number
  centerTileX: number
  centerTileY: number
  panX: number
  panY: number
}

export type ScreenRect = { left: number; top: number; size: number }

export type VisibleTile = ScreenRect & { tx: number; ty: number }

function zoomScale(z: number): number {
  return Math.pow(2, GENESIS_MAX_ZOOM - z)
}

export function tileDisplayPx(z: number): number {
  return TILE_DISPLAY_PX * Math.pow(2, z - VIEWPORT_FETCH_ZOOM)
}

export function tileGridSize(z: number): number {
  const level = GENESIS_MAX_ZOOM - z
  return Math.floor((61 - 1) / Math.pow(2, level)) + 1
}

function clampTile(tx: number, ty: number, z: number): { tx: number; ty: number } | null {
  const size = tileGridSize(z)
  if (tx < 0 || ty < 0 || tx >= size || ty >= size) return null
  return { tx, ty }
}

export function mapTileUrl(z: number, tx: number, ty: number): string {
  return `${GENESIS_TILE_BASE_URL}/${z}/${tx},${ty}.jpg`
}

function parcelToTileCenterZ6(px: number, py: number): { x: number; y: number } {
  const tx = GENESIS_TILE_PAD + Math.floor(px / 5)
  const ty = GENESIS_TILE_PAD - Math.floor(py / 5)
  const leftParcelX = (tx - GENESIS_TILE_PAD) * 5 - 2
  const topParcelY = (GENESIS_TILE_PAD - ty) * 5 + 2
  return {
    x: tx + (px - leftParcelX + 0.5) / 5,
    y: ty + (topParcelY - py + 0.5) / 5
  }
}

function tileCenterToParcelZ6(cx: number, cy: number): { x: number; y: number } {
  const tx = Math.floor(cx)
  const ty = Math.floor(cy)
  const localX = cx - tx
  const localY = cy - ty
  const leftParcelX = (tx - GENESIS_TILE_PAD) * 5 - 2
  const topParcelY = (GENESIS_TILE_PAD - ty) * 5 + 2
  return {
    x: leftParcelX + Math.floor(localX * 5),
    y: topParcelY - Math.floor(localY * 5)
  }
}

function parcelToTileCenter(px: number, py: number): { x: number; y: number } {
  const z6 = parcelToTileCenterZ6(px, py)
  const scale = zoomScale(VIEWPORT_FETCH_ZOOM)
  return { x: z6.x / scale, y: z6.y / scale }
}

function tileCenterToParcel(cx: number, cy: number): { x: number; y: number } {
  const scale = zoomScale(VIEWPORT_FETCH_ZOOM)
  return tileCenterToParcelZ6(cx * scale, cy * scale)
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
  const fetchScale = zoomScale(VIEWPORT_FETCH_ZOOM)
  const span = 0.2 / fetchScale
  const z6 = parcelToTileCenterZ6(px, py)
  const centerX = z6.x / fetchScale
  const centerY = z6.y / fetchScale
  const topLeftX = centerX - span / 2
  const topLeftY = centerY - span / 2
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
  const px = parseInt(m[1], 10)
  const py = parseInt(m[2], 10)
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
      if (!clampTile(tx, ty, VIEWPORT_FETCH_ZOOM)) continue
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

export function genesisMetersToParcel(genesisX: number, genesisZ: number): { px: number; py: number; parcelKey: string } {
  const px = Math.floor(genesisX / PARCEL_SIZE_M)
  const py = Math.floor(genesisZ / PARCEL_SIZE_M)
  return { px, py, parcelKey: `${px},${py}` }
}
