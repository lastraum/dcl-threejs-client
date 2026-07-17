import {
  VIEWPORT_DEFAULT_ZOOM,
  VIEWPORT_FETCH_ZOOM,
  centerViewOnParcel,
  mapTileUrl,
  visibleTiles,
  type MapViewState
} from '../../map/genesisMapViewport'
import {
  shouldShowParcelLayer,
  visibleParcelChunks
} from '../../map/parcelMapTiles'
import type { MapPlayerState } from './settings/MapView'

export type MinimapOptions = {
  getPlayerState: () => MapPlayerState | null
  onClick?: () => void
  /** CSS px diameter (default 224). */
  size?: number
}

const DEFAULT_SIZE = 224
/**
 * Close enough for parcel map.png layer (PARCEL_LAYER_MIN_ZOOM = 6).
 * Satellite lod-0/3 alone looks soft/blocky when CSS-scaled this tight.
 */
const MINIMAP_ZOOM = Math.max(VIEWPORT_DEFAULT_ZOOM + 1, 6)
const BORDER_PX = 2.5
/** Soften satellite under sharper parcel map.png (MapView parity). */
const SATELLITE_UNDER_PARCEL_ALPHA = 0.38

/**
 * Circular Genesis minimap HUD — lod-0/3 satellite + close-zoom parcel map.png
 * (Unity SatelliteAtlas + ParcelAtlas). Hard circular clip, player at center.
 */
export class Minimap {
  private readonly root: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly getPlayerState: () => MapPlayerState | null
  private readonly size: number
  private readonly dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2)
  private readonly tileCache = new Map<string, HTMLImageElement>()
  /** api.decentraland.org map.png chunks for close zoom. */
  private readonly parcelCache = new Map<string, HTMLImageElement>()
  private disposed = false
  private rafId = 0
  private view: MapViewState = {
    zoom: MINIMAP_ZOOM,
    centerTileX: 3.825,
    centerTileY: 3.825,
    panX: 0,
    panY: 0
  }

  constructor({ getPlayerState, onClick, size = DEFAULT_SIZE }: MinimapOptions) {
    this.getPlayerState = getPlayerState
    this.size = size

    this.root = document.createElement('div')
    this.root.id = 'minimap'
    this.root.className = 'minimap'
    this.root.innerHTML = `<canvas width="${size}" height="${size}" aria-label="Genesis City minimap"></canvas>`

    this.canvas = this.root.querySelector('canvas')!
    this.canvas.width = Math.round(size * this.dpr)
    this.canvas.height = Math.round(size * this.dpr)
    this.canvas.style.width = `${size}px`
    this.canvas.style.height = `${size}px`

    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('Minimap 2D context unavailable')
    this.ctx = ctx

    if (onClick) {
      this.root.classList.add('is-clickable')
      this.root.setAttribute('role', 'button')
      this.root.setAttribute('tabindex', '0')
      this.root.setAttribute('aria-label', 'Open Genesis City map')
      this.root.addEventListener('click', () => onClick())
      this.root.addEventListener('keydown', (ev) => {
        if (ev.code === 'Enter' || ev.code === 'Space') {
          ev.preventDefault()
          onClick()
        }
      })
    }

    document.body.appendChild(this.root)

    const tick = (): void => {
      if (this.disposed) return
      this.render()
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible
  }

  /**
   * Pin the circle just under `anchor` (location pill). Uses viewport bottom so
   * layout is correct even when --client-safe-top / fonts change after mount.
   */
  placeBelow(anchor: HTMLElement, gapPx = 8): void {
    if (this.root.hidden || anchor.hidden) return
    const rect = anchor.getBoundingClientRect()
    // Hidden or not laid out yet — keep CSS fallback until next placeBelow.
    if (rect.height < 1) return
    this.root.style.top = `${Math.round(rect.bottom + gapPx)}px`
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    this.tileCache.clear()
    this.parcelCache.clear()
    this.root.remove()
  }

  private ensureTile(tx: number, ty: number): HTMLImageElement {
    const key = `${tx},${ty}`
    let img = this.tileCache.get(key)
    if (img) return img
    img = new Image()
    img.decoding = 'async'
    // No crossOrigin — same CDN as MapView; CORS is not required for drawImage display.
    img.src = mapTileUrl(VIEWPORT_FETCH_ZOOM, tx, ty)
    this.tileCache.set(key, img)
    return img
  }

  private ensureParcelChunk(url: string): HTMLImageElement {
    let img = this.parcelCache.get(url)
    if (img) return img
    img = new Image()
    img.decoding = 'async'
    img.src = url
    this.parcelCache.set(url, img)
    return img
  }

  private render(): void {
    const ctx = this.ctx
    const size = this.size
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)

    const player = this.getPlayerState()
    if (player?.parcelKey) {
      const m = /^(-?\d+),(-?\d+)$/.exec(player.parcelKey.trim())
      if (m) {
        const px = parseInt(m[1]!, 10)
        const py = parseInt(m[2]!, 10)
        this.view = centerViewOnParcel(
          { ...this.view, zoom: MINIMAP_ZOOM, panX: 0, panY: 0 },
          px,
          py
        )
        // Sub-parcel pan so the player sits at true center, not parcel center.
        const PARCEL_M = 16
        const localX = ((Number(player.position.x) % PARCEL_M) + PARCEL_M) % PARCEL_M
        const localZ = ((Number(player.position.z) % PARCEL_M) + PARCEL_M) % PARCEL_M
        const CHUNK = 40
        const fx = localX / PARCEL_M - 0.5
        const fy = 0.5 - localZ / PARCEL_M
        this.view = {
          ...this.view,
          centerTileX: this.view.centerTileX + fx / CHUNK,
          centerTileY: this.view.centerTileY + fy / CHUNK
        }
      }
    }

    const tiles = visibleTiles(size, size, this.view)
    const showParcel = shouldShowParcelLayer(this.view.zoom)
    const parcelChunks = showParcel ? visibleParcelChunks(size, size, this.view) : []
    const cx = size / 2
    const cy = size / 2
    const radius = size / 2 - BORDER_PX / 2

    // Hard circular clip for basemap + marker.
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.clip()

    ctx.fillStyle = 'rgba(10, 14, 20, 0.92)'
    ctx.fillRect(0, 0, size, size)

    // Satellite underlay (dimmed when parcel detail is available).
    ctx.globalAlpha = showParcel ? SATELLITE_UNDER_PARCEL_ALPHA : 1
    for (const tile of tiles) {
      const img = this.ensureTile(tile.tx, tile.ty)
      if (!img.complete || img.naturalWidth <= 0) continue
      // Square source → square dest (satellite chunks are 1:1).
      ctx.drawImage(img, tile.left, tile.top, tile.size, tile.size)
    }
    ctx.globalAlpha = 1

    // Close-zoom parcel basemap — Unity ParcelAtlas / MapView layer.
    // Square map.png chunks (width=height, size=px/parcel) drawn 1:1 to screen rects.
    for (const chunk of parcelChunks) {
      const img = this.ensureParcelChunk(chunk.url)
      if (!img.complete || img.naturalWidth <= 0) continue
      const sw = img.naturalWidth
      const sh = img.naturalHeight
      // Preserve source aspect if API ever returns non-square (should be square).
      if (sw === sh) {
        ctx.drawImage(img, chunk.left, chunk.top, chunk.size, chunk.size)
      } else {
        const scale = chunk.size / Math.max(sw, sh)
        const dw = sw * scale
        const dh = sh * scale
        ctx.drawImage(
          img,
          chunk.left + (chunk.size - dw) / 2,
          chunk.top + (chunk.size - dh) / 2,
          dw,
          dh
        )
      }
    }

    // Player marker — always dead center of the HUD.
    ctx.fillStyle = '#57e389'
    ctx.beginPath()
    ctx.arc(cx, cy, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(cx, cy, 5, 0, Math.PI * 2)
    ctx.stroke()

    ctx.restore()

    // Hard white ring.
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = BORDER_PX
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.stroke()
  }
}
