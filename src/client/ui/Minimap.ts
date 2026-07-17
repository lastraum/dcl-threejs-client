import {
  VIEWPORT_DEFAULT_ZOOM,
  centerViewOnParcel,
  mapTileUrlForLod,
  satelliteLodForZoom,
  visibleTiles,
  type MapViewState
} from '../../map/genesisMapViewport'
import type { SatelliteLodLevel } from '../../map/genesisMapTiles'
import type { MapPlayerState } from './settings/MapView'

export type MinimapOptions = {
  getPlayerState: () => MapPlayerState | null
  onClick?: () => void
  /** CSS px diameter (default 224). */
  size?: number
}

const DEFAULT_SIZE = 224
/**
 * Close zoom so we pick denser satellite LODs (L4+).
 * Real detail comes from lod-0/{4,5,6} tiles — not CSS upscale of L3.
 */
const MINIMAP_ZOOM = Math.max(VIEWPORT_DEFAULT_ZOOM + 2, 7)
const BORDER_PX = 2.5

/**
 * Circular Genesis minimap — multi-LOD satellite (genesis-city parcels pyramid).
 * Player always at center; hard white ring.
 */
export class Minimap {
  private readonly root: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly getPlayerState: () => MapPlayerState | null
  private readonly size: number
  private readonly dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2)
  /** key: `${lod}/${tx},${ty}` */
  private readonly tileCache = new Map<string, HTMLImageElement>()
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
    if (rect.height < 1) return
    this.root.style.top = `${Math.round(rect.bottom + gapPx)}px`
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    this.tileCache.clear()
    this.root.remove()
  }

  private ensureTile(lod: SatelliteLodLevel, tx: number, ty: number): HTMLImageElement {
    const key = `${lod}/${tx},${ty}`
    let img = this.tileCache.get(key)
    if (img) return img
    img = new Image()
    img.decoding = 'async'
    img.src = mapTileUrlForLod(lod, tx, ty)
    this.tileCache.set(key, img)
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
        // Sub-parcel pan in level-3 tile space (centerTile is always L3).
        const PARCEL_M = 16
        const localX = ((Number(player.position.x) % PARCEL_M) + PARCEL_M) % PARCEL_M
        const localZ = ((Number(player.position.z) % PARCEL_M) + PARCEL_M) % PARCEL_M
        const L3_CHUNK = 40
        const fx = localX / PARCEL_M - 0.5
        const fy = 0.5 - localZ / PARCEL_M
        this.view = {
          ...this.view,
          centerTileX: this.view.centerTileX + fx / L3_CHUNK,
          centerTileY: this.view.centerTileY + fy / L3_CHUNK
        }
      }
    }

    const tiles = visibleTiles(size, size, this.view)
    const lod = satelliteLodForZoom(this.view.zoom)
    const cx = size / 2
    const cy = size / 2
    const radius = size / 2 - BORDER_PX / 2

    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.clip()

    ctx.fillStyle = 'rgba(10, 14, 20, 0.92)'
    ctx.fillRect(0, 0, size, size)

    for (const tile of tiles) {
      const img = this.ensureTile(tile.lod, tile.tx, tile.ty)
      if (!img.complete || img.naturalWidth <= 0) continue
      ctx.drawImage(img, tile.left, tile.top, tile.size, tile.size)
    }

    // Fallback: if denser LOD tiles still loading, briefly show L3 under them.
    if (lod > 3) {
      let anyReady = false
      for (const tile of tiles) {
        const img = this.tileCache.get(`${tile.lod}/${tile.tx},${tile.ty}`)
        if (img?.complete && img.naturalWidth > 0) {
          anyReady = true
          break
        }
      }
      if (!anyReady) {
        const lowView = { ...this.view, zoom: 5 }
        for (const tile of visibleTiles(size, size, lowView)) {
          const img = this.ensureTile(tile.lod, tile.tx, tile.ty)
          if (!img.complete || img.naturalWidth <= 0) continue
          ctx.drawImage(img, tile.left, tile.top, tile.size, tile.size)
        }
      }
    }

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

    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = BORDER_PX
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.stroke()
  }
}
