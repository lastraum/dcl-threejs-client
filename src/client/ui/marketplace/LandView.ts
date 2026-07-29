import { formatMana, shortCreator } from '../../../marketplace/format'
import {
  fetchLandForSaleMap,
  fetchLandPage,
  type LandKind,
  type LandListing,
  type LandOrderBy
} from '../../../marketplace/landApi'
import { LandMapCanvas } from './LandMapCanvas'

export type LandViewOptions = {
  /** Open in-app land detail (2-card layout). */
  onOpenLand: (listing: LandListing) => void
  /** Optional: jump into Genesis at parcel (3D). */
  onJumpInParcel?: (px: number, py: number) => void
}

type LandMode = 'catalog' | 'map'
type KindFilter = LandKind | 'all'

const PAGE = 48

const SORTS: { id: LandOrderBy; label: string }[] = [
  { id: 'newest', label: 'Newest' },
  { id: 'recently_listed', label: 'Recently listed' },
  { id: 'cheapest', label: 'Cheapest' },
  { id: 'name', label: 'Name' }
]

/**
 * Marketplace Land — catalog + map (cyan for-sale overlays).
 * Toolbar: Catalog | Map + search. Left column: filters / selection.
 */
export class LandView {
  readonly root: HTMLElement

  private readonly toolbarEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private mode: LandMode = 'catalog'

  private kind: KindFilter = 'all'
  private search = ''
  private sort: LandOrderBy = 'newest'
  private onSaleOnly = true
  private listings: LandListing[] = []
  private total: number | null = null
  private skip = 0
  private loading = false
  private loadSeq = 0

  private mapListings: LandListing[] = []
  private mapLoading = false
  private mapCanvas: LandMapCanvas | null = null
  private selected: LandListing | null = null

  private searchTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(private readonly opts: LandViewOptions) {
    this.root = document.createElement('div')
    this.root.className = 'land-view'
    this.root.innerHTML = `
      <div class="land-view__toolbar-row" data-toolbar>
        <div class="land-view__mode-tabs" role="tablist" aria-label="Land views">
          <button type="button" class="land-view__mode-tab land-view__mode-tab--active" data-mode="catalog" role="tab">
            Catalog
          </button>
          <button type="button" class="land-view__mode-tab" data-mode="map" role="tab">
            Map view
          </button>
        </div>
        <div class="land-view__search-wrap">
          <span class="land-view__search-icon" aria-hidden="true">⌕</span>
          <input
            type="search"
            class="land-view__search"
            data-search
            placeholder="Search land"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="land-view__toolbar-meta">
          <span class="land-view__count" data-count></span>
          <label class="land-view__sort" data-sort-wrap>
            <span>Sort</span>
            <select data-sort></select>
          </label>
        </div>
      </div>
      <div class="land-view__body" data-body></div>
    `
    this.toolbarEl = this.root.querySelector('[data-toolbar]')!
    this.bodyEl = this.root.querySelector('[data-body]')!

    const sortSelect = this.toolbarEl.querySelector('[data-sort]') as HTMLSelectElement
    for (const s of SORTS) {
      const opt = document.createElement('option')
      opt.value = s.id
      opt.textContent = s.label
      sortSelect.appendChild(opt)
    }
    sortSelect.value = this.sort

    for (const btn of this.toolbarEl.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      btn.addEventListener('click', () => {
        const m = btn.dataset.mode as LandMode
        if (m === 'catalog' || m === 'map') this.setMode(m)
      })
    }

    const search = this.toolbarEl.querySelector('[data-search]') as HTMLInputElement
    search.addEventListener('input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(() => {
        this.search = search.value.trim()
        if (this.mode === 'catalog') void this.reloadCatalog(true)
        // Map: filter overlay client-side by name/coords later if needed
      }, 320)
    })

    sortSelect.addEventListener('change', () => {
      this.sort = sortSelect.value as LandOrderBy
      if (this.mode === 'catalog') void this.reloadCatalog(true)
    })
  }

  mount(): void {
    this.syncToolbarMode()
    this.renderModeBody()
    void this.reloadCatalog(true)
    void this.ensureMapListings()
  }

  dispose(): void {
    this.disposed = true
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.mapCanvas?.dispose()
    this.mapCanvas = null
    this.root.remove()
  }

  private setMode(mode: LandMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.syncToolbarMode()
    this.renderModeBody()
    if (mode === 'catalog') void this.reloadCatalog(true)
    else {
      void this.ensureMapListings().then(() => {
        this.mapCanvas?.refreshSales()
        if (this.selected) this.mapCanvas?.focusListing(this.selected)
      })
    }
  }

  private syncToolbarMode(): void {
    for (const btn of this.toolbarEl.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      btn.classList.toggle('land-view__mode-tab--active', btn.dataset.mode === this.mode)
    }
    const sortWrap = this.toolbarEl.querySelector('[data-sort-wrap]') as HTMLElement | null
    if (sortWrap) sortWrap.hidden = this.mode === 'map'
    this.updateCount()
  }

  private renderModeBody(): void {
    this.mapCanvas?.dispose()
    this.mapCanvas = null
    this.bodyEl.replaceChildren()
    this.bodyEl.className =
      this.mode === 'catalog' ? 'land-view__body land-view__body--catalog' : 'land-view__body land-view__body--map'

    if (this.mode === 'catalog') {
      this.renderCatalogShell()
      return
    }
    this.renderMapShell()
  }

  // ── Shared left column ──────────────────────────────────

  private leftColumnHtml(includeMapExtras: boolean): string {
    return `
      <aside class="land-view__sidebar" aria-label="Land options">
        <p class="land-view__sidebar-label">Type</p>
        <div class="land-view__nav" data-kind-nav>
          <button type="button" class="land-view__nav-btn" data-kind="all">All land</button>
          <button type="button" class="land-view__nav-btn" data-kind="parcel">Parcels</button>
          <button type="button" class="land-view__nav-btn" data-kind="estate">Estates</button>
        </div>
        <div class="land-view__filters">
          <p class="land-view__sidebar-label">Filters</p>
          <label class="land-view__toggle">
            <span>On sale</span>
            <input type="checkbox" data-on-sale ${this.onSaleOnly ? 'checked' : ''} />
          </label>
        </div>
        ${
          includeMapExtras
            ? `
        <div class="land-view__map-panel">
          <p class="land-view__sidebar-label">Map</p>
          <p class="land-view__map-hint" data-map-status>Loading sales…</p>
          <div class="land-view__map-legend">
            <div><span class="land-view__swatch land-view__swatch--parcel"></span> Parcel for sale</div>
            <div><span class="land-view__swatch land-view__swatch--estate"></span> Estate</div>
            <div><span class="land-view__swatch land-view__swatch--selected"></span> Selected</div>
          </div>
          <div class="land-view__map-selected" data-selected hidden></div>
        </div>`
            : ''
        }
      </aside>
    `
  }

  private bindSidebarCommon(): void {
    const onSale = this.bodyEl.querySelector('[data-on-sale]') as HTMLInputElement | null
    if (onSale) {
      onSale.checked = this.onSaleOnly
      onSale.addEventListener('change', () => {
        this.onSaleOnly = onSale.checked
        if (this.mode === 'catalog') void this.reloadCatalog(true)
        else {
          // Re-fetch map sales with filter would need API re-query; for now catalog-only
          void this.reloadCatalog(true)
        }
      })
    }
    for (const btn of this.bodyEl.querySelectorAll<HTMLButtonElement>('[data-kind]')) {
      btn.addEventListener('click', () => {
        const k = btn.dataset.kind as KindFilter
        if (k === this.kind) return
        this.kind = k
        this.syncKindNav()
        if (this.mode === 'catalog') void this.reloadCatalog(true)
      })
    }
    this.syncKindNav()
  }

  private syncKindNav(): void {
    for (const btn of this.bodyEl.querySelectorAll<HTMLButtonElement>('[data-kind]')) {
      btn.classList.toggle('land-view__nav-btn--active', btn.dataset.kind === this.kind)
    }
  }

  // ── Catalog ─────────────────────────────────────────────

  private renderCatalogShell(): void {
    this.bodyEl.innerHTML = `
      ${this.leftColumnHtml(false)}
      <div class="land-view__main">
        <p class="land-view__status" data-status hidden></p>
        <div class="land-view__grid" data-grid></div>
        <div class="land-view__footer">
          <button type="button" class="land-view__load-more" data-load-more hidden>Load more</button>
        </div>
      </div>
    `
    this.bindSidebarCommon()
    const loadMore = this.bodyEl.querySelector('[data-load-more]') as HTMLButtonElement
    loadMore.addEventListener('click', () => {
      this.skip = this.listings.length
      void this.reloadCatalog(false)
    })
    this.renderCatalogGrid(true)
    this.updateCount()
  }

  private async reloadCatalog(reset: boolean): Promise<void> {
    const seq = ++this.loadSeq
    if (reset) {
      this.skip = 0
      this.listings = []
      this.total = null
      if (this.mode === 'catalog') this.renderCatalogGrid(true)
    }
    this.loading = true
    this.updateCount()
    const status = this.bodyEl.querySelector('[data-status]') as HTMLElement | null
    if (status) status.hidden = true
    const loadMore = this.bodyEl.querySelector('[data-load-more]') as HTMLButtonElement | null
    if (loadMore) loadMore.hidden = true

    try {
      const page = await fetchLandPage({
        kind: this.kind,
        orderBy: this.sort,
        first: PAGE,
        skip: this.skip,
        isOnSale: this.onSaleOnly ? true : undefined,
        search: this.search || undefined
      })
      if (seq !== this.loadSeq || this.disposed) return
      this.listings = reset ? page.listings : [...this.listings, ...page.listings]
      this.total = page.total
      this.loading = false
      if (this.mode === 'catalog') {
        this.renderCatalogGrid(false)
        this.updateLoadMore()
      }
      this.updateCount()
    } catch (err) {
      if (seq !== this.loadSeq || this.disposed) return
      this.loading = false
      if (status) {
        status.hidden = false
        status.className = 'land-view__status land-view__status--error'
        status.textContent = err instanceof Error ? err.message : 'Could not load land'
      }
      if (this.mode === 'catalog') this.renderCatalogGrid(false)
      this.updateCount()
    }
  }

  private updateCount(): void {
    const el = this.toolbarEl.querySelector('[data-count]')
    if (!el) return
    if (this.mode === 'map') {
      el.textContent = this.mapLoading
        ? 'Loading map…'
        : `${this.mapListings.length.toLocaleString()} on map`
      return
    }
    if (this.loading && !this.listings.length) {
      el.textContent = 'Loading…'
      return
    }
    el.textContent =
      this.total != null
        ? `${this.total.toLocaleString()} listings`
        : `${this.listings.length.toLocaleString()} listings`
  }

  private updateLoadMore(): void {
    const btn = this.bodyEl.querySelector('[data-load-more]') as HTMLButtonElement | null
    if (!btn) return
    const hasMore =
      this.total != null ? this.listings.length < this.total : this.listings.length >= PAGE
    btn.hidden = !hasMore || this.loading
    btn.disabled = this.loading
    btn.textContent = this.loading ? 'Loading…' : 'Load more'
  }

  private renderCatalogGrid(skeletons: boolean): void {
    const grid = this.bodyEl.querySelector('[data-grid]')
    if (!grid) return
    grid.replaceChildren()
    if (skeletons && !this.listings.length) {
      for (let i = 0; i < 12; i++) {
        const sk = document.createElement('div')
        sk.className = 'land-card land-card--skeleton'
        sk.setAttribute('aria-hidden', 'true')
        grid.appendChild(sk)
      }
      return
    }
    if (!this.listings.length && !this.loading) {
      const empty = document.createElement('p')
      empty.className = 'land-view__empty'
      empty.textContent = 'No land matches these filters.'
      grid.appendChild(empty)
      return
    }
    for (const L of this.listings) {
      grid.appendChild(this.makeLandCard(L))
    }
  }

  private makeLandCard(L: LandListing): HTMLElement {
    const el = document.createElement('article')
    el.className = 'land-card'
    el.setAttribute('role', 'button')
    el.tabIndex = 0
    const thumb = L.thumbnail
      ? `<img class="land-card__img" src="${esc(L.thumbnail)}" alt="" loading="lazy" />`
      : `<div class="land-card__img land-card__img--ph" aria-hidden="true"></div>`
    el.innerHTML = `
      <div class="land-card__media">${thumb}
        <span class="land-card__kind">${L.kind === 'estate' ? `Estate · ${L.size}` : 'Parcel'}</span>
      </div>
      <div class="land-card__body">
        <h3 class="land-card__name">${esc(L.name)}</h3>
        <p class="land-card__coords">${L.x}, ${L.y}</p>
        <div class="land-card__row">
          <span class="land-card__price">◆ ${esc(formatMana(L.priceMana))} <small>MANA</small></span>
          ${L.owner ? `<span class="land-card__owner">${esc(shortCreator(L.owner))}</span>` : ''}
        </div>
        <div class="land-card__actions">
          <button type="button" class="land-card__btn" data-map>Map</button>
          <button type="button" class="land-card__btn land-card__btn--primary" data-jump>Jump in</button>
        </div>
      </div>
    `
    const img = el.querySelector('img')
    img?.addEventListener('error', () => {
      img.replaceWith(
        Object.assign(document.createElement('div'), {
          className: 'land-card__img land-card__img--ph',
          ariaHidden: 'true'
        })
      )
    })
    el.querySelector('[data-map]')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.selected = L
      this.setMode('map')
      requestAnimationFrame(() => this.mapCanvas?.focusListing(L))
    })
    el.querySelector('[data-jump]')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.opts.onJumpInParcel?.(L.x, L.y)
    })
    el.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) return
      this.opts.onOpenLand(L)
    })
    return el
  }

  // ── Map ─────────────────────────────────────────────────

  private renderMapShell(): void {
    this.bodyEl.innerHTML = `
      ${this.leftColumnHtml(true)}
      <div class="land-view__map-stage" data-map-stage></div>
    `
    this.bindSidebarCommon()
    const stage = this.bodyEl.querySelector('[data-map-stage]') as HTMLElement
    this.mapCanvas = new LandMapCanvas({
      getListings: () => this.mapListings,
      selectedId: this.selected?.id ?? null,
      onSelect: (L) => {
        this.selected = L
        this.mapCanvas?.setSelectedId(L?.id ?? null)
        this.renderSelectedPanel()
        // Open in-app detail when clicking a for-sale parcel
        if (L) this.opts.onOpenLand(L)
      }
    })
    stage.appendChild(this.mapCanvas.root)
    this.mapCanvas.mount()
    this.renderSelectedPanel()
    if (this.mapLoading) {
      const st = this.bodyEl.querySelector('[data-map-status]')
      if (st) st.textContent = 'Loading sales…'
    } else {
      this.updateMapStatus()
      this.mapCanvas.refreshSales()
      if (this.selected) this.mapCanvas.focusListing(this.selected)
    }
    this.updateCount()
  }

  private async ensureMapListings(): Promise<void> {
    if (this.mapListings.length || this.mapLoading) return
    this.mapLoading = true
    this.updateCount()
    try {
      this.mapListings = await fetchLandForSaleMap(500)
    } catch (err) {
      console.warn('[marketplace/land] map sales failed', err)
      this.mapListings = []
    } finally {
      this.mapLoading = false
      if (!this.disposed) {
        this.updateCount()
        if (this.mode === 'map') {
          this.updateMapStatus()
          this.mapCanvas?.refreshSales()
        }
      }
    }
  }

  private updateMapStatus(): void {
    const st = this.bodyEl.querySelector('[data-map-status]')
    if (!st) return
    const n = this.mapListings.length
    st.textContent = n
      ? `${n.toLocaleString()} listings on overlay`
      : 'No for-sale parcels loaded'
  }

  private renderSelectedPanel(): void {
    const el = this.bodyEl.querySelector('[data-selected]') as HTMLElement | null
    if (!el) return
    const L = this.selected
    if (!L) {
      el.hidden = true
      el.innerHTML = ''
      return
    }
    el.hidden = false
    el.innerHTML = `
      <h3 class="land-view__selected-name">${esc(L.name)}</h3>
      <p class="land-view__selected-meta">${L.kind === 'estate' ? `Estate · ${L.size} parcels` : 'Parcel'} · ${L.x}, ${L.y}</p>
      <p class="land-view__selected-price">◆ ${esc(formatMana(L.priceMana))} MANA</p>
      ${L.owner ? `<p class="land-view__selected-owner">Owner ${esc(shortCreator(L.owner, 12))}</p>` : ''}
      <div class="land-view__selected-actions">
        <button type="button" class="land-card__btn" data-open-sel>Details</button>
        <button type="button" class="land-card__btn land-card__btn--primary" data-jump-sel>Jump in</button>
      </div>
    `
    el.querySelector('[data-open-sel]')?.addEventListener('click', () => this.opts.onOpenLand(L))
    el.querySelector('[data-jump-sel]')?.addEventListener('click', () => {
      this.opts.onJumpInParcel?.(L.x, L.y)
    })
  }
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
