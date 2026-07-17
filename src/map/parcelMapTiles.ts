/**
 * Close-zoom parcel basemap — Unity ParcelAtlas parity.
 *
 * Unity: `https://api.decentraland.org/v1/map.png?center=x,y&width=…&height=…&size=…`
 * (`DecentralandUrl.ApiChunks`). Drawn over the satellite layer when zoomed in.
 */

import {
  parcelScreenRect,
  screenPointToParcel,
  type MapViewState,
  type ScreenRect
} from './genesisMapViewport'

/**
 * Former map.png overlay threshold. Disabled: multi-LOD satellite (lod-0/4–6)
 * is sharper and the API layer only dimmed the basemap (opacity 0.35 + dark tiles).
 * Set below VIEWPORT_MAX_ZOOM again if we re-enable ParcelAtlas.
 */
export const PARCEL_LAYER_MIN_ZOOM = 99

/** Parcels per side of one map.png chunk (web-friendly; Unity uses ~51). */
export const PARCEL_CHUNK_PARCELS = 20

/** Pixels per parcel in the PNG (Unity uses 20). */
export const PARCEL_CHUNK_PX_PER_PARCEL = 16

const CHUNK = PARCEL_CHUNK_PARCELS
const PX = PARCEL_CHUNK_PX_PER_PARCEL
const IMG_PX = CHUNK * PX

/** Genesis City interactable bounds (approx). */
const WORLD_MIN = -150
const WORLD_MAX = 150

export const PARCEL_MAP_API_BASE = (
  import.meta.env.VITE_PARCEL_MAP_API_BASE?.trim() || 'https://api.decentraland.org/v1/map.png'
).replace(/\?+$/, '')

export type VisibleParcelChunk = ScreenRect & {
  /** SW parcel of this chunk (inclusive). */
  originX: number
  originY: number
  centerX: number
  centerY: number
  url: string
}

export function shouldShowParcelLayer(zoom: number): boolean {
  return zoom >= PARCEL_LAYER_MIN_ZOOM
}

/**
 * Unity-style map.png URL. `width`/`height` are image pixels; `size` is px/parcel.
 * `center` is parcel coordinates at the image center.
 */
export function parcelMapChunkUrl(centerX: number, centerY: number): string {
  const cx = Math.round(centerX)
  const cy = Math.round(centerY)
  return (
    `${PARCEL_MAP_API_BASE}?center=${cx},${cy}` +
    `&width=${IMG_PX}&height=${IMG_PX}&size=${PX}`
  )
}

/**
 * Chunks overlapping the viewport at the current zoom, positioned in screen space.
 */
export function visibleParcelChunks(
  viewW: number,
  viewH: number,
  view: MapViewState
): VisibleParcelChunk[] {
  if (!shouldShowParcelLayer(view.zoom)) return []

  const corners = [
    screenPointToParcel(0, 0, viewW, viewH, view),
    screenPointToParcel(viewW, 0, viewW, viewH, view),
    screenPointToParcel(0, viewH, viewW, viewH, view),
    screenPointToParcel(viewW, viewH, viewW, viewH, view)
  ].filter(Boolean) as Array<{ px: number; py: number }>

  if (!corners.length) return []

  let minPx = Infinity
  let maxPx = -Infinity
  let minPy = Infinity
  let maxPy = -Infinity
  for (const c of corners) {
    minPx = Math.min(minPx, c.px)
    maxPx = Math.max(maxPx, c.px)
    minPy = Math.min(minPy, c.py)
    maxPy = Math.max(maxPy, c.py)
  }

  minPx = Math.max(WORLD_MIN - CHUNK, Math.floor(minPx / CHUNK) * CHUNK - CHUNK)
  maxPx = Math.min(WORLD_MAX + CHUNK, Math.ceil(maxPx / CHUNK) * CHUNK + CHUNK)
  minPy = Math.max(WORLD_MIN - CHUNK, Math.floor(minPy / CHUNK) * CHUNK - CHUNK)
  maxPy = Math.min(WORLD_MAX + CHUNK, Math.ceil(maxPy / CHUNK) * CHUNK + CHUNK)

  const out: VisibleParcelChunk[] = []
  for (let ox = minPx; ox <= maxPx; ox += CHUNK) {
    for (let oy = minPy; oy <= maxPy; oy += CHUNK) {
      const rect = parcelChunkScreenRect(ox, oy, viewW, viewH, view)
      if (!rect) continue
      const centerX = ox + (CHUNK - 1) / 2
      const centerY = oy + (CHUNK - 1) / 2
      out.push({
        originX: ox,
        originY: oy,
        centerX,
        centerY,
        url: parcelMapChunkUrl(centerX, centerY),
        ...rect
      })
    }
  }
  return out
}

/**
 * Screen rect covering parcels [ox, ox+CHUNK) × [oy, oy+CHUNK).
 * Map +Y = north = toward top of image / lower screen Y.
 */
function parcelChunkScreenRect(
  ox: number,
  oy: number,
  viewW: number,
  viewH: number,
  view: MapViewState
): ScreenRect | null {
  const nw = parcelScreenRect(ox, oy + CHUNK - 1, viewW, viewH, view)
  const se = parcelScreenRect(ox + CHUNK - 1, oy, viewW, viewH, view)
  if (!nw || !se) return null

  const left = nw.left
  const top = nw.top
  const sizeW = se.left + se.size - nw.left
  const sizeH = se.top + se.size - nw.top
  const size = Math.max(sizeW, sizeH)
  if (left + size < -16 || top + size < -16 || left > viewW + 16 || top > viewH + 16) return null
  return { left, top, size }
}
