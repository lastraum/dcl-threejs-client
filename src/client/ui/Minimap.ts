import {
  VIEWPORT_DEFAULT_ZOOM,
  centerViewOnParcel,
  mapTileUrlForLod,
  parcelScreenRect,
  satelliteLodForZoom,
  visibleTiles,
  type MapViewState
} from '../../map/genesisMapViewport'
import type { SatelliteLodLevel } from '../../map/genesisMapTiles'
import type { MapPlayerState, MinimapPeerDot } from './settings/MapView'

export type MinimapOptions = {
  getPlayerState: () => MapPlayerState | null
  /** Remote peers in Genesis meters (red dots). */
  getPeers?: () => MinimapPeerDot[]
  onClick?: () => void
  /** CSS px diameter (default 224). */
  size?: number
  /** Mount into location-map stack (Explorer-style panel) instead of document.body. */
  host?: HTMLElement
}

const DEFAULT_SIZE = 224
/**
 * Close zoom so we pick denser satellite LODs (L4+).
 * Real detail comes from lod-0/{4,5,6} tiles — not CSS upscale of L3.
 */
const MINIMAP_ZOOM = Math.max(VIEWPORT_DEFAULT_ZOOM + 2, 7)
/** Single white ring drawn on canvas (not CSS — avoids double border with HUD glass). */
const BORDER_PX = 2
const PARCEL_M = 16

/**
 * Circular Genesis minimap — multi-LOD satellite, green facing triangle for local
 * player, red dots for other peers in the scene.
 */
export class Minimap {
  private readonly root: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly getPlayerState: () => MapPlayerState | null
  private readonly getPeers: () => MinimapPeerDot[]
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

  constructor({
    getPlayerState,
    getPeers,
    onClick,
    size = DEFAULT_SIZE,
    host
  }: MinimapOptions) {
    this.getPlayerState = getPlayerState
    this.getPeers = getPeers ?? (() => [])
    this.size = size

    this.root = document.createElement('div')
    this.root.id = 'minimap'
    this.root.className = host ? 'minimap minimap--in-stack' : 'minimap'
    this.root.innerHTML = `<canvas width="${size}" height="${size}" aria-label="Genesis City minimap"></canvas>`

    this.canvas = this.root.querySelector('canvas')!
    this.canvas.width = Math.round(size * this.dpr)
    this.canvas.height = Math.round(size * this.dpr)
    // Fill the stack slot (CSS size) so the circle matches glass width — no side “frame”.
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.canvas.style.display = 'block'
    this.canvas.style.borderRadius = '50%'

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

    // Stack host wraps circle in a slide tray; otherwise fixed-position on body.
    if (host) {
      const tray = document.createElement('div')
      tray.className = 'location-map-stack__map'
      tray.appendChild(this.root)
      host.appendChild(tray)
    } else {
      document.body.appendChild(this.root)
    }

    const tick = (): void => {
      if (this.disposed) return
      this.render()
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  setVisible(visible: boolean): void {
    // Stack visibility is owned by the location-map-stack host.
    if (this.root.closest('.location-map-stack')) return
    this.root.hidden = !visible
  }

  /** @deprecated Stack layout owns placement — no-op when mounted in location-map-stack. */
  placeBelow(anchor: HTMLElement, gapPx = 8): void {
    if (this.root.closest('.location-map-stack')) return
    if (this.root.hidden || anchor.hidden) return
    const rect = anchor.getBoundingClientRect()
    if (rect.height < 1) return
    this.root.style.top = `${Math.round(rect.bottom + gapPx)}px`
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    this.tileCache.clear()
    const tray = this.root.parentElement
    if (tray?.classList.contains('location-map-stack__map')) {
      tray.remove()
    } else {
      this.root.remove()
    }
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

    // Other players in this scene — red dots (before local marker so we stay on top).
    this.drawPeerDots(ctx, size)

    // Local player — green triangle, tip = avatar facing (not camera).
    this.drawPlayerTriangle(ctx, cx, cy, player?.facingYaw ?? 0)

    ctx.restore()

    // One ring only (on the bitmap). CSS must not add another border.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
    ctx.lineWidth = BORDER_PX
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.stroke()
  }

  /**
   * White triangle — tip points visual avatar facing (incl. while moving).
   * `mapAngle` is canvas radians from getMinimapFacingAngle (0 = north / up).
   */
  private drawPlayerTriangle(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    mapAngle: number
  ): void {
    const r = 14 // 2× previous (7)
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(mapAngle)
    ctx.beginPath()
    ctx.moveTo(0, -r) // tip (north at mapAngle 0)
    ctx.lineTo(r * 0.72, r * 0.62)
    ctx.lineTo(0, r * 0.28)
    ctx.lineTo(-r * 0.72, r * 0.62)
    ctx.closePath()
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 1.75
    ctx.stroke()
    ctx.restore()
  }

  private drawPeerDots(ctx: CanvasRenderingContext2D, size: number): void {
    const peers = this.getPeers()
    if (!peers.length) return

    for (const peer of peers) {
      const px = Math.floor(peer.x / PARCEL_M)
      const py = Math.floor(peer.z / PARCEL_M)
      const parcelKey = `${px},${py}`
      const pos = { x: peer.x, y: 0, z: peer.z }
      // Reuse map projection (player-centered view).
      const rect = peerScreenRect(parcelKey, pos, size, size, this.view)
      if (!rect) continue
      // Clip roughly to circle interior
      const dx = rect.cx - size / 2
      const dy = rect.cy - size / 2
      if (dx * dx + dy * dy > (size / 2 - 6) ** 2) continue

      ctx.fillStyle = '#e85d5d'
      ctx.beginPath()
      ctx.arc(rect.cx, rect.cy, 3.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(rect.cx, rect.cy, 3.5, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}

/** Screen center of a peer using the same parcel + sub-parcel math as the map. */
function peerScreenRect(
  parcelKey: string,
  position: { x: number; y: number; z: number },
  viewW: number,
  viewH: number,
  view: MapViewState
): { cx: number; cy: number } | null {
  const m = /^(-?\d+),(-?\d+)$/.exec(parcelKey.trim())
  if (!m) return null
  const px = parseInt(m[1]!, 10)
  const py = parseInt(m[2]!, 10)
  const base = parcelScreenRect(px, py, viewW, viewH, view)
  if (!base) return null
  const localX = ((Number(position.x) % PARCEL_M) + PARCEL_M) % PARCEL_M
  const localZ = ((Number(position.z) % PARCEL_M) + PARCEL_M) % PARCEL_M
  const fx = localX / PARCEL_M
  const fy = 1 - localZ / PARCEL_M
  return {
    cx: base.left + base.size * fx,
    cy: base.top + base.size * fy
  }
}
