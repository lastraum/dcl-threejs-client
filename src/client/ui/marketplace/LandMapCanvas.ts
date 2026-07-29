/**
 * Lightweight Genesis satellite map for Marketplace Land — same tiles as /map,
 * with cyan overlays for parcels for sale.
 */

import {
  VIEWPORT_DEFAULT_CENTER_TILE,
  VIEWPORT_DEFAULT_ZOOM,
  VIEWPORT_MAX_ZOOM,
  VIEWPORT_MIN_ZOOM,
  centerViewOnParcel,
  mapTileUrl,
  parcelScreenRect,
  screenPointToParcel,
  visibleTiles,
  type MapViewState
} from '../../../map/genesisMapViewport'
import { formatMana, shortCreator } from '../../../marketplace/format'
import type { LandListing } from '../../../marketplace/landApi'
import { buildParcelSaleIndex } from '../../../marketplace/landApi'

export type LandMapCanvasOptions = {
  getListings: () => LandListing[]
  selectedId?: string | null
  onSelect: (listing: LandListing | null) => void
  /**
   * `preview` = full-bleed detail stage: compact HUD, higher default zoom.
   * Default is the Land catalog map chrome.
   */
  mode?: 'default' | 'preview'
  /** Initial zoom (clamped to viewport min/max). Preview defaults to max zoom. */
  initialZoom?: number
}

export class LandMapCanvas {
  readonly root: HTMLElement
  private readonly viewport: HTMLElement
  private readonly tilesLayer: HTMLElement
  private readonly salesLayer: HTMLElement
  private readonly hudEl: HTMLElement

  private view: MapViewState = {
    zoom: VIEWPORT_DEFAULT_ZOOM,
    centerTileX: VIEWPORT_DEFAULT_CENTER_TILE.x,
    centerTileY: VIEWPORT_DEFAULT_CENTER_TILE.y,
    panX: 0,
    panY: 0
  }

  private selectedId: string | null
  private dragging = false
  private dragStart = { x: 0, y: 0, panX: 0, panY: 0 }
  private moved = false
  private ro: ResizeObserver | null = null
  private raf = 0
  private disposed = false
  private readonly preview: boolean

  constructor(private readonly opts: LandMapCanvasOptions) {
    this.selectedId = opts.selectedId ?? null
    this.preview = opts.mode === 'preview'
    const startZoom = clampZoom(
      opts.initialZoom ?? (this.preview ? VIEWPORT_MAX_ZOOM : VIEWPORT_DEFAULT_ZOOM)
    )
    this.view = { ...this.view, zoom: startZoom }

    this.root = document.createElement('div')
    this.root.className = this.preview ? 'land-map land-map--preview' : 'land-map'
    this.root.innerHTML = `
      <div class="land-map__viewport" data-viewport>
        <div class="land-map__tiles" data-tiles aria-hidden="true"></div>
        <div class="land-map__sales" data-sales aria-hidden="true"></div>
      </div>
      <div class="land-map__hud">
        <span data-hud>${this.preview ? 'Drag · scroll to zoom' : 'Drag to pan · scroll to zoom · cyan = for sale'}</span>
        <div class="land-map__zoom">
          <button type="button" data-zoom-out aria-label="Zoom out">−</button>
          <button type="button" data-zoom-in aria-label="Zoom in">+</button>
        </div>
      </div>
    `
    this.viewport = this.root.querySelector('[data-viewport]')!
    this.tilesLayer = this.root.querySelector('[data-tiles]')!
    this.salesLayer = this.root.querySelector('[data-sales]')!
    this.hudEl = this.root.querySelector('[data-hud]')!

    this.bind()
  }

  mount(): void {
    this.ro = new ResizeObserver(() => this.scheduleRender())
    this.ro.observe(this.viewport)
    this.scheduleRender()
  }

  dispose(): void {
    this.disposed = true
    this.ro?.disconnect()
    this.ro = null
    if (this.raf) cancelAnimationFrame(this.raf)
    this.root.remove()
  }

  setSelectedId(id: string | null): void {
    this.selectedId = id
    this.scheduleRender()
  }

  /** Focus a listing on the map. */
  focusListing(listing: LandListing, zoom?: number): void {
    let next = centerViewOnParcel(this.view, listing.x, listing.y)
    if (zoom != null) next = { ...next, zoom: clampZoom(zoom) }
    this.view = next
    this.selectedId = listing.id
    this.scheduleRender()
  }

  setZoom(zoom: number): void {
    const next = clampZoom(zoom)
    if (next === this.view.zoom) return
    this.view = { ...this.view, zoom: next }
    this.scheduleRender()
  }

  refreshSales(): void {
    this.scheduleRender()
  }

  private bind(): void {
    this.viewport.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return
      this.dragging = true
      this.moved = false
      this.dragStart = {
        x: ev.clientX,
        y: ev.clientY,
        panX: this.view.panX,
        panY: this.view.panY
      }
      this.viewport.setPointerCapture(ev.pointerId)
    })
    this.viewport.addEventListener('pointermove', (ev) => {
      if (!this.dragging) return
      const dx = ev.clientX - this.dragStart.x
      const dy = ev.clientY - this.dragStart.y
      if (Math.abs(dx) + Math.abs(dy) > 4) this.moved = true
      // Match MapView: drag right moves map content left (grab-the-map feel).
      this.view = {
        ...this.view,
        panX: this.dragStart.panX - dx,
        panY: this.dragStart.panY - dy
      }
      this.scheduleRender()
    })
    const endDrag = (ev: PointerEvent): void => {
      if (!this.dragging) return
      this.dragging = false
      try {
        this.viewport.releasePointerCapture(ev.pointerId)
      } catch {
        /* ignore */
      }
      if (!this.moved) this.handleClick(ev)
    }
    this.viewport.addEventListener('pointerup', endDrag)
    this.viewport.addEventListener('pointercancel', endDrag)

    this.viewport.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault()
        const dir = ev.deltaY > 0 ? -1 : 1
        this.zoomBy(dir)
      },
      { passive: false }
    )

    this.root.querySelector('[data-zoom-in]')?.addEventListener('click', () => this.zoomBy(1))
    this.root.querySelector('[data-zoom-out]')?.addEventListener('click', () => this.zoomBy(-1))
  }

  private zoomBy(delta: number): void {
    const next = clampZoom(this.view.zoom + delta)
    if (next === this.view.zoom) return
    this.view = { ...this.view, zoom: next }
    this.scheduleRender()
  }

  private handleClick(ev: PointerEvent): void {
    const rect = this.viewport.getBoundingClientRect()
    const sx = ev.clientX - rect.left
    const sy = ev.clientY - rect.top
    const parcel = screenPointToParcel(sx, sy, rect.width, rect.height, this.view)
    if (!parcel) {
      this.opts.onSelect(null)
      return
    }
    const index = buildParcelSaleIndex(this.opts.getListings())
    const hit = index.get(`${parcel.px},${parcel.py}`) ?? null
    this.opts.onSelect(hit)
    this.hudEl.textContent = hit
      ? `${hit.name} · ◆ ${formatMana(hit.priceMana)} · ${parcel.px},${parcel.py}`
      : `Parcel ${parcel.px}, ${parcel.py}${hit ? '' : ' · not listed'}`
    this.scheduleRender()
  }

  private scheduleRender(): void {
    if (this.disposed) return
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.render()
    })
  }

  private render(): void {
    if (this.disposed) return
    const w = this.viewport.clientWidth
    const h = this.viewport.clientHeight
    if (w < 8 || h < 8) return

    // Satellite tiles (same source as Map nav)
    const tiles = visibleTiles(w, h, this.view)
    this.tilesLayer.replaceChildren()
    for (const t of tiles) {
      const img = document.createElement('img')
      img.className = 'land-map__tile'
      img.draggable = false
      img.alt = ''
      img.src = mapTileUrl(this.view.zoom, t.tx, t.ty)
      img.style.left = `${t.left}px`
      img.style.top = `${t.top}px`
      img.style.width = `${t.size}px`
      img.style.height = `${t.size}px`
      this.tilesLayer.appendChild(img)
    }

    // Cyan sale overlays
    const listings = this.opts.getListings()
    const selectedId = this.selectedId
    this.salesLayer.replaceChildren()
    // Limit DOM nodes: only parcels near viewport
    let drawn = 0
    const maxDraw = 800
    for (const L of listings) {
      for (const p of L.parcels) {
        if (drawn >= maxDraw) break
        const r = parcelScreenRect(p.x, p.y, w, h, this.view)
        if (!r || r.size < 1.5) continue
        const cell = document.createElement('div')
        cell.className = 'land-map__sale'
        if (L.id === selectedId) cell.classList.add('land-map__sale--selected')
        if (L.kind === 'estate') cell.classList.add('land-map__sale--estate')
        cell.style.left = `${r.left}px`
        cell.style.top = `${r.top}px`
        cell.style.width = `${Math.max(2, r.size)}px`
        cell.style.height = `${Math.max(2, r.size)}px`
        cell.title = `${L.name} · ◆ ${formatMana(L.priceMana)}${L.owner ? ` · ${shortCreator(L.owner)}` : ''}`
        this.salesLayer.appendChild(cell)
        drawn++
      }
      if (drawn >= maxDraw) break
    }
  }
}

function clampZoom(z: number): number {
  return Math.min(VIEWPORT_MAX_ZOOM, Math.max(VIEWPORT_MIN_ZOOM, z))
}
