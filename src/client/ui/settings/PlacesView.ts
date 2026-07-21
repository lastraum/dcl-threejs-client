import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { RouteTarget } from '../../../dcl/content/route'
import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import { rewriteCatalystUrl } from '../../../network/catalyst/rewriteCatalystUrl'
import {
  EXPLORER_FEATURED_LIMIT,
  EXPLORER_FEATURED_PAGE_SIZE,
  EXPLORER_LIVE_LIMIT,
  PLACES_PAGE_SIZE,
  PLACES_SCENE_CATEGORIES,
  buildUnifiedExplorerItems,
  fetchDclExplorerFeaturedItems,
  fetchDclExplorerLiveItems,
  fetchDclGenesisPlaces,
  fetchDclWorldsWithNameFallback,
  formatOwnerShort,
  genesisPlaceJumpRoute,
  matchesPlaceSearch,
  matchesWorldSearch,
  mergeUniqueById,
  placeLocationLabel,
  placeOwnerAddress,
  placesWorldJumpRoute,
  type DclExploreItem,
  type DclGenesisPlace,
  type DclPlacesWorld,
  type ExplorerSortMode
} from '../../../social/dclPlaces'

type PlacesSubTab = 'explore' | 'recent' | 'favorites'
type CardLayout = 'grid'


export type PlacesViewOptions = {
  onJumpIn?: (target: RouteTarget) => void
  onOpenScene?: (target: RouteTarget) => void
  getAuthIdentity?: () => AuthIdentity | null
  scrollRoot?: HTMLElement | null
  variant?: 'overlay' | 'explorer'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const OVERLAY_SHELL = `
  <header class="places-view__header">
    <div class="places-view__header-actions">
      <select class="places-view__sort" data-sort aria-label="Sort list">
        <option value="most_users">Most users</option>
        <option value="name_az">A–Z</option>
      </select>
    </div>
  </header>
  <nav class="places-view__subtabs" data-subtabs role="tablist" aria-label="Places sections">
    <button type="button" class="places-view__subtab is-active" data-subtab="explore" role="tab" aria-selected="true">Explore</button>
    <button type="button" class="places-view__subtab" data-subtab="recent" role="tab" aria-selected="false">Recent</button>
    <button type="button" class="places-view__subtab" data-subtab="favorites" role="tab" aria-selected="false">Favorites</button>
  </nav>
  <div class="places-view__toolbar">
    <input type="search" class="places-view__search" data-search placeholder="Search places and worlds…" aria-label="Search places and worlds" autocomplete="off" spellcheck="false" />
  </div>
  <div class="places-view__cat-bar" data-cat-bar role="toolbar" aria-label="Filter by category"></div>
  <p class="places-view__status" data-status hidden></p>
  <div class="places-view__results" data-results>
    <div class="places-view__grid" data-grid role="list"></div>
    <p class="places-view__empty" data-empty hidden>No scenes or worlds match your search.</p>
    <p class="places-view__load-more" data-load-more hidden>Loading more…</p>
    <div class="places-view__sentinel" data-sentinel aria-hidden></div>
  </div>
`

const EXPLORER_SHELL = `
  <section class="places-view__spotlight" aria-label="Highlighted scenes">
    <div class="places-view__spotlight-block">
      <h2 class="places-view__spotlight-title places-view__spotlight-title--live">Live Now</h2>
      <div class="places-view__carousel places-view__carousel--live" data-live-row role="list"></div>
      <p class="places-view__spotlight-muted" data-live-empty hidden>Nothing live right now.</p>
    </div>
    <div class="places-view__spotlight-block places-view__spotlight-block--featured">
      <div class="places-view__spotlight-head">
        <h2 class="places-view__spotlight-title">Featured Places</h2>
        <div class="places-view__featured-nav">
          <button type="button" class="places-view__featured-nav-btn" data-featured-prev aria-label="Previous featured page" disabled>&lsaquo;</button>
          <button type="button" class="places-view__featured-nav-btn" data-featured-next aria-label="Next featured page">&rsaquo;</button>
        </div>
      </div>
      <div class="places-view__carousel places-view__carousel--featured" data-featured-row role="list"></div>
    </div>
  </section>
  <section class="places-view__browse" aria-label="Browse all places">
    <div class="places-view__browse-head">
      <nav class="places-view__subtabs places-view__subtabs--browse" data-subtabs role="tablist" aria-label="Places sections">
        <button type="button" class="places-view__subtab is-active" data-subtab="explore" role="tab" aria-selected="true">Explore All</button>
        <button type="button" class="places-view__subtab" data-subtab="favorites" role="tab" aria-selected="false">Favourites</button>
        <button type="button" class="places-view__subtab" data-subtab="recent" role="tab" aria-selected="false">My Places</button>
      </nav>
      <div class="places-view__browse-filters">
        <input type="search" class="places-view__search" data-search placeholder="Search places" aria-label="Search places" autocomplete="off" spellcheck="false" />
        <select class="places-view__sort" data-sort aria-label="Sort list">
          <option value="most_users">Most visiting now</option>
          <option value="name_az">A–Z</option>
        </select>
      </div>
    </div>
    <div class="places-view__cat-bar" data-cat-bar role="toolbar" aria-label="Filter by category"></div>
    <p class="places-view__status" data-status hidden></p>
    <div class="places-view__results" data-results>
      <div class="places-view__grid" data-grid role="list"></div>
      <p class="places-view__empty" data-empty hidden>No scenes or worlds match your search.</p>
      <p class="places-view__load-more" data-load-more hidden>Loading more…</p>
      <div class="places-view__sentinel" data-sentinel aria-hidden></div>
    </div>
  </section>
`

/** Places tab — Genesis scenes + Worlds (overlay + full-page explorer). */
export class PlacesView {
  readonly root: HTMLElement

  private readonly statusEl: HTMLElement
  private readonly gridEl: HTMLElement
  private readonly sentinelEl: HTMLElement
  private readonly searchInput: HTMLInputElement
  private readonly sortSelect: HTMLSelectElement
  private readonly catBar: HTMLElement
  private readonly subTabs: HTMLElement
  private readonly liveRowEl: HTMLElement | null
  private readonly featuredRowEl: HTMLElement | null
  private readonly featuredPrevBtn: HTMLButtonElement | null
  private readonly featuredNextBtn: HTMLButtonElement | null
  private readonly liveEmptyEl: HTMLElement | null

  private featuredItemsAll: DclExploreItem[] = []
  private featuredPage = 0

  private readonly onJumpIn?: (target: RouteTarget) => void
  private readonly onOpenScene?: (target: RouteTarget) => void
  private readonly getAuthIdentity?: () => AuthIdentity | null
  private readonly scrollRoot?: HTMLElement | null
  private readonly variant: 'overlay' | 'explorer'

  private subTab: PlacesSubTab = 'explore'
  private categoryId = 'all'
  private explorerSort: ExplorerSortMode = 'most_users'
  private searchQuery = ''
  private searchDebounced = ''

  private genesisPlaces: DclGenesisPlace[] = []
  private worlds: DclPlacesWorld[] = []
  private readonly itemById = new Map<string, DclExploreItem>()

  private placesOffset = 0
  private worldsOffset = 0
  private placesHasMore = true
  private worldsHasMore = true

  private loading = false
  private loadingMore = false
  private spotlightLoading = false
  private error: string | null = null
  private disposed = false
  private searchTimer = 0
  private loadGen = 0
  private observer: IntersectionObserver | null = null

  private readonly faceCache = new Map<string, string | null>()
  private readonly facePending = new Set<string>()

  constructor(opts: PlacesViewOptions = {}) {
    this.onJumpIn = opts.onJumpIn
    this.onOpenScene = opts.onOpenScene
    this.getAuthIdentity = opts.getAuthIdentity
    this.scrollRoot = opts.scrollRoot
    this.variant = opts.variant ?? 'overlay'

    this.root = document.createElement('div')
    this.root.className = `places-view${this.variant === 'explorer' ? ' places-view--explorer' : ''}`
    this.root.innerHTML = this.variant === 'explorer' ? EXPLORER_SHELL : OVERLAY_SHELL

    this.statusEl = this.root.querySelector('[data-status]')!
    this.gridEl = this.root.querySelector('[data-grid]')!
    this.sentinelEl = this.root.querySelector('[data-sentinel]')!
    this.searchInput = this.root.querySelector('[data-search]')!
    this.sortSelect = this.root.querySelector('[data-sort]')!
    this.catBar = this.root.querySelector('[data-cat-bar]')!
    this.subTabs = this.root.querySelector('[data-subtabs]')!
    this.liveRowEl = this.root.querySelector('[data-live-row]')
    this.featuredRowEl = this.root.querySelector('[data-featured-row]')
    this.featuredPrevBtn = this.root.querySelector('[data-featured-prev]')
    this.featuredNextBtn = this.root.querySelector('[data-featured-next]')
    this.liveEmptyEl = this.root.querySelector('[data-live-empty]')

    this.buildCategoryPills()
    this.bindEvents()
  }

  mount(): void {
    this.setupInfiniteScroll()
    if (this.variant === 'explorer') void this.reloadSpotlight()
    void this.reloadAll()
  }

  refreshAfterAuthChange(): Promise<void> {
    if (this.variant === 'explorer') void this.reloadSpotlight()
    return this.reloadAll()
  }

  dispose(): void {
    this.disposed = true
    window.clearTimeout(this.searchTimer)
    this.observer?.disconnect()
    this.observer = null
    this.root.remove()
  }

  private bindEvents(): void {
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value
      window.clearTimeout(this.searchTimer)
      this.searchTimer = window.setTimeout(() => {
        this.searchDebounced = this.searchQuery
        void this.reloadAll()
      }, 350)
    })

    this.sortSelect.addEventListener('change', () => {
      this.explorerSort = this.sortSelect.value as ExplorerSortMode
      this.renderGrid()
    })

    this.root.querySelector('[data-refresh]')?.addEventListener('click', () => {
      if (this.variant === 'explorer') void this.reloadSpotlight()
      void this.reloadAll()
    })

    this.featuredPrevBtn?.addEventListener('click', () => {
      if (this.featuredPage <= 0) return
      this.featuredPage -= 1
      this.renderFeaturedPage()
    })
    this.featuredNextBtn?.addEventListener('click', () => {
      const maxPage = Math.ceil(this.featuredItemsAll.length / EXPLORER_FEATURED_PAGE_SIZE) - 1
      if (this.featuredPage >= maxPage) return
      this.featuredPage += 1
      this.renderFeaturedPage()
    })

    this.subTabs.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-subtab]')
      if (!btn) return
      const tab = btn.dataset.subtab as PlacesSubTab | undefined
      if (!tab) return
      if (tab === 'favorites' && !this.getAuthIdentity?.()) {
        this.setStatus('Connect your wallet to see favourites', 'error')
        return
      }
      this.setSubTab(tab)
    })

    this.root.addEventListener('click', (ev) => {
      const jumpBtn = (ev.target as HTMLElement).closest<HTMLElement>('[data-jump-route]')
      if (!jumpBtn) return
      const kind = jumpBtn.dataset.jumpKind
      const id = jumpBtn.dataset.jumpId
      if (!kind || !id) return
      const item = this.itemById.get(`${kind}:${id}`)
      if (!item) return
      const open = this.onOpenScene ?? this.onJumpIn
      if (item.kind === 'scene') open?.(genesisPlaceJumpRoute(item.place))
      else open?.(placesWorldJumpRoute(item.world))
    })
  }

  private buildCategoryPills(): void {
    this.catBar.innerHTML = PLACES_SCENE_CATEGORIES.map(
      (c) => `
        <button type="button" class="places-view__cat-pill${c.id === 'all' ? ' is-active' : ''}" data-cat="${escapeHtml(c.id)}" aria-pressed="${c.id === 'all'}" style="--cat-color:${c.swatch}">
          <span class="places-view__cat-label">${escapeHtml(c.label)}</span>
        </button>
      `
    ).join('')

    this.catBar.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-cat]')
      if (!btn) return
      const id = btn.dataset.cat
      if (!id) return
      this.categoryId = id
      for (const pill of this.catBar.querySelectorAll<HTMLButtonElement>('[data-cat]')) {
        const active = pill.dataset.cat === id
        pill.classList.toggle('is-active', active)
        pill.setAttribute('aria-pressed', String(active))
      }
      void this.reloadAll()
    })
  }

  private setSubTab(tab: PlacesSubTab): void {
    this.subTab = tab
    if (this.variant === 'explorer' && tab === 'explore') {
      this.explorerSort = 'most_users'
      this.sortSelect.value = 'most_users'
    }
    for (const btn of this.subTabs.querySelectorAll<HTMLButtonElement>('[data-subtab]')) {
      const active = btn.dataset.subtab === tab
      btn.classList.toggle('is-active', active)
      btn.setAttribute('aria-selected', String(active))
    }
    const showCats = tab === 'explore'
    this.catBar.hidden = !showCats
    this.searchInput.disabled = tab === 'favorites' && !this.getAuthIdentity?.()
    void this.reloadAll()
  }

  private setupInfiniteScroll(): void {
    const scrollRoot =
      this.scrollRoot ?? this.root.closest('.settings-overlay__content') ?? this.root.closest('.explorer-view__main')
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void this.loadMore()
      },
      { root: scrollRoot, rootMargin: '240px 0px' }
    )
    this.observer.observe(this.sentinelEl)
  }

  private orderByForTab(): { places: 'most_active' | 'updated_at'; worlds: 'most_active' | 'created_at' } {
    if (this.subTab === 'recent') return { places: 'updated_at', worlds: 'created_at' }
    return { places: 'most_active', worlds: 'most_active' }
  }

  private async reloadSpotlight(): Promise<void> {
    if (this.variant !== 'explorer' || !this.liveRowEl || !this.featuredRowEl) return
    this.spotlightLoading = true
    this.liveRowEl.innerHTML = ''
    this.featuredRowEl.innerHTML = ''
    if (this.liveEmptyEl) this.liveEmptyEl.hidden = true

    try {
      const [live, featured] = await Promise.all([
        fetchDclExplorerLiveItems(EXPLORER_LIVE_LIMIT),
        fetchDclExplorerFeaturedItems(EXPLORER_FEATURED_LIMIT)
      ])
      if (this.disposed) return

      this.registerItems(live)
      this.registerItems(featured)

      this.liveRowEl.innerHTML = live.map((item) => this.renderLiveCard(item)).join('')
      this.featuredItemsAll = featured
      this.featuredPage = 0
      this.renderFeaturedPage()

      if (this.liveEmptyEl) this.liveEmptyEl.hidden = live.length > 0
      void this.hydrateFaceUrls([...live, ...featured])
    } catch {
      if (this.liveEmptyEl) {
        this.liveEmptyEl.hidden = false
        this.liveEmptyEl.textContent = 'Could not load live places.'
      }
    } finally {
      this.spotlightLoading = false
    }
  }

  private async reloadAll(): Promise<void> {
    const gen = ++this.loadGen
    this.loading = true
    this.error = null
    this.placesOffset = 0
    this.worldsOffset = 0
    this.placesHasMore = true
    this.worldsHasMore = true
    this.setStatus(this.subTab === 'favorites' ? 'Loading favourites…' : 'Loading places and worlds…', 'loading')
    this.gridEl.innerHTML = ''

    try {
      const identity = this.getAuthIdentity?.() ?? null
      const onlyFavorites = this.subTab === 'favorites'
      const order = this.orderByForTab()
      const q = this.searchDebounced.trim()
      const cat = PLACES_SCENE_CATEGORIES.find((c) => c.id === this.categoryId)

      const [places, worldsList] = await Promise.all([
        fetchDclGenesisPlaces({
          search: q.length >= 3 ? q : undefined,
          orderBy: order.places,
          categories: this.subTab === 'explore' && cat?.slug ? [cat.slug] : undefined,
          limit: PLACES_PAGE_SIZE,
          offset: 0,
          onlyFavorites,
          identity: onlyFavorites ? identity : null
        }),
        onlyFavorites
          ? fetchDclWorldsWithNameFallback({
              orderBy: order.worlds,
              limit: PLACES_PAGE_SIZE,
              offset: 0,
              onlyFavorites: true,
              identity
            })
          : fetchDclWorldsWithNameFallback({
              search: q.length > 0 ? q : undefined,
              orderBy: order.worlds,
              limit: PLACES_PAGE_SIZE,
              offset: 0
            })
      ])
      if (this.disposed || gen !== this.loadGen) return

      this.genesisPlaces = places
      this.worlds = worldsList
      this.placesOffset = places.length
      this.worldsOffset = worldsList.length
      this.placesHasMore = places.length >= PLACES_PAGE_SIZE
      this.worldsHasMore = worldsList.length >= PLACES_PAGE_SIZE
      this.setStatus(null)
      this.renderGrid()
    } catch (e) {
      if (this.disposed || gen !== this.loadGen) return
      this.genesisPlaces = []
      this.worlds = []
      this.error = e instanceof Error ? e.message : String(e)
      this.setStatus(this.error, 'error')
      this.renderGrid()
    } finally {
      if (gen === this.loadGen) this.loading = false
    }
  }

  private async loadMore(): Promise<void> {
    if (this.loading || this.loadingMore || this.spotlightLoading) return
    if (!this.placesHasMore && !this.worldsHasMore) return

    const gen = this.loadGen
    this.loadingMore = true
    const loadMoreEl = this.root.querySelector('[data-load-more]') as HTMLElement
    loadMoreEl.hidden = false

    try {
      const identity = this.getAuthIdentity?.() ?? null
      const onlyFavorites = this.subTab === 'favorites'
      const order = this.orderByForTab()
      const q = this.searchDebounced.trim()
      const cat = PLACES_SCENE_CATEGORIES.find((c) => c.id === this.categoryId)

      const tasks: Promise<void>[] = []

      if (this.placesHasMore) {
        tasks.push(
          fetchDclGenesisPlaces({
            search: q.length >= 3 ? q : undefined,
            orderBy: order.places,
            categories: this.subTab === 'explore' && cat?.slug ? [cat.slug] : undefined,
            limit: PLACES_PAGE_SIZE,
            offset: this.placesOffset,
            onlyFavorites,
            identity: onlyFavorites ? identity : null
          }).then((data) => {
            if (this.disposed || gen !== this.loadGen) return
            this.genesisPlaces = mergeUniqueById(this.genesisPlaces, data)
            this.placesOffset += data.length
            this.placesHasMore = data.length >= PLACES_PAGE_SIZE
          })
        )
      }

      if (this.worldsHasMore) {
        tasks.push(
          fetchDclWorldsWithNameFallback({
            search: onlyFavorites ? undefined : q.length > 0 ? q : undefined,
            orderBy: order.worlds,
            limit: PLACES_PAGE_SIZE,
            offset: this.worldsOffset,
            onlyFavorites,
            identity: onlyFavorites ? identity : null
          }).then((data) => {
            if (this.disposed || gen !== this.loadGen) return
            this.worlds = mergeUniqueById(this.worlds, data)
            this.worldsOffset += data.length
            this.worldsHasMore = data.length >= PLACES_PAGE_SIZE
          })
        )
      }

      await Promise.all(tasks)
      if (this.disposed || gen !== this.loadGen) return
      this.renderGrid()
    } catch {
      // keep existing results on pagination errors
    } finally {
      this.loadingMore = false
      loadMoreEl.hidden = true
    }
  }

  private registerItems(items: DclExploreItem[]): void {
    for (const item of items) {
      const id = item.kind === 'scene' ? item.place.id : item.world.id
      this.itemById.set(`${item.kind}:${id}`, item)
    }
  }

  private getFilteredItems(): DclExploreItem[] {
    const normalizedSearch = this.searchQuery.trim().toLowerCase()
    const compactSearch = normalizedSearch.replace(/\s/g, '')
    const placesFiltered = this.genesisPlaces.filter((p) =>
      matchesPlaceSearch(p, normalizedSearch, compactSearch)
    )
    const worldsFiltered = this.worlds.filter((w) => matchesWorldSearch(w, normalizedSearch))
    const sort =
      this.variant === 'explorer' && this.subTab === 'explore' ? 'most_users' : this.explorerSort
    return buildUnifiedExplorerItems(placesFiltered, worldsFiltered, sort)
  }

  private renderGrid(): void {
    const emptyEl = this.root.querySelector('[data-empty]') as HTMLElement
    const items = this.getFilteredItems()
    this.registerItems(items)

    if (items.length === 0) {
      this.gridEl.innerHTML = ''
      emptyEl.hidden = this.loading || Boolean(this.error)
      if (!this.loading && !this.error) {
        if (this.subTab === 'favorites') {
          emptyEl.textContent = 'No favourites yet. Heart places in-world to see them here.'
        } else if (this.searchQuery.trim()) {
          emptyEl.textContent = 'No scenes or worlds match your search.'
        } else {
          emptyEl.textContent = 'No scenes or worlds returned.'
        }
      }
      return
    }

    emptyEl.hidden = true
    this.gridEl.innerHTML = items.map((item) => this.renderCard(item, 'grid')).join('')
    void this.hydrateFaceUrls(items)
  }

  private renderFeaturedPage(): void {
    if (!this.featuredRowEl) return

    const pageCount = Math.max(1, Math.ceil(this.featuredItemsAll.length / EXPLORER_FEATURED_PAGE_SIZE))
    if (this.featuredPage >= pageCount) this.featuredPage = pageCount - 1
    if (this.featuredPage < 0) this.featuredPage = 0

    const start = this.featuredPage * EXPLORER_FEATURED_PAGE_SIZE
    const pageItems = this.featuredItemsAll.slice(start, start + EXPLORER_FEATURED_PAGE_SIZE)
    this.featuredRowEl.innerHTML = pageItems.map((item) => this.renderPillCard(item)).join('')

    if (this.featuredPrevBtn) {
      this.featuredPrevBtn.disabled = this.featuredPage <= 0
    }
    if (this.featuredNextBtn) {
      this.featuredNextBtn.disabled =
        this.featuredItemsAll.length === 0 || this.featuredPage >= pageCount - 1
    }

    void this.hydrateFaceUrls(pageItems)
  }

  private renderMediaTopBadges(data: { userCount: number; highlighted?: boolean }): string {
    const start: string[] = []
    if (data.highlighted) {
      start.push('<span class="places-view__badge places-view__badge--featured">Featured</span>')
    }

    const crowdPill =
      data.userCount > 0
        ? `
          <span class="places-view__crowd-pill" aria-label="${data.userCount} people here">
            <span class="places-view__crowd-pill-dot" aria-hidden="true"></span>
            <svg class="places-view__crowd-pill-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path fill="currentColor" d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-3.31 0-6 1.57-6 3.5V19h12v-1.5C18 15.57 15.31 14 12 14z"/>
            </svg>
            ${data.userCount}
          </span>
        `
        : ''

    if (start.length === 0 && !crowdPill) return ''

    return `
      <div class="places-view__live-top">
        ${start.length > 0 ? `<div class="places-view__live-top-start">${start.join('')}</div>` : '<span></span>'}
        ${crowdPill}
      </div>
    `
  }

  private visitActionLabel(): string {
    return this.onOpenScene ? 'Visit' : 'Jump In'
  }

  /** Up to three category chips in the pill colors; "+N" for the rest. Worlds carry no categories. */
  private categoryPillsHtml(item: DclExploreItem): string {
    if (item.kind !== 'scene') return ''
    const cats = item.place.categories.flatMap((slug) => {
      const def = PLACES_SCENE_CATEGORIES.find((c) => c.slug === slug)
      return def ? [def] : []
    })
    if (!cats.length) return ''
    const shown = cats.slice(0, 3)
    const extra = cats.length - shown.length
    return `<span class="places-view__card-cats" aria-label="Categories">${shown
      .map(
        (c) =>
          `<span class="places-view__card-cat" style="--cat-color:${c.swatch}">${escapeHtml(c.label)}</span>`
      )
      .join('')}${extra > 0 ? `<span class="places-view__card-cat places-view__card-cat--more">+${extra}</span>` : ''}</span>`
  }

  private renderVisitButton(jumpKind: string, jumpId: string): string {
    const label = this.visitActionLabel()
    return `
      <button
        type="button"
        class="places-view__card-visit"
        data-jump-route
        data-jump-kind="${jumpKind}"
        data-jump-id="${escapeHtml(jumpId)}"
      >${label}</button>
    `
  }

  private creatorFallbackLabel(item: DclExploreItem): string {
    if (item.kind === 'world') {
      const short = item.world.worldName.replace(/\.dcl\.eth$/i, '').trim()
      return short || item.world.title
    }
    return item.place.title
  }

  private renderCreatorFooter(
    item: DclExploreItem,
    owner: string | null,
    ownerShort: string | null,
    location: string
  ): string {
    const fallback = this.creatorFallbackLabel(item)
    const label = ownerShort ?? owner ?? fallback
    const initials = label.slice(0, 2).toUpperCase()
    const faceAttr = owner ? ` data-face-for="${escapeHtml(owner.toLowerCase())}"` : ''

    return `
      <div class="places-view__card-footer places-view__card-footer--live">
        <span class="places-view__card-creator"${faceAttr}>
          <span class="places-view__card-avatar" aria-hidden>${owner ? '' : escapeHtml(initials)}</span>
          <span class="places-view__card-owner">${escapeHtml(label)}</span>
        </span>
        <span class="places-view__card-location" title="${escapeHtml(location)}">${escapeHtml(location)}</span>
      </div>
    `
  }

  private renderLiveCard(item: DclExploreItem): string {
    const data = item.kind === 'scene' ? item.place : item.world
    const thumb = this.sceneThumbUrl(data.image)
    const location = placeLocationLabel(data)
    const jumpKind = item.kind
    const jumpId = item.kind === 'scene' ? item.place.id : item.world.id

    return `
      <article class="places-view__card places-view__card--live-tile" role="listitem">
        <div class="places-view__card-media">
          ${
            thumb
              ? `<img class="places-view__card-img" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />`
              : '<div class="places-view__card-placeholder" aria-hidden></div>'
          }
          ${this.renderMediaTopBadges({ userCount: data.userCount, highlighted: data.highlighted })}
        </div>
        <div class="places-view__card-body places-view__card-body--live">
          <div class="places-view__card-action">
            <div class="places-view__card-info places-view__card-info--live">
              <h3 class="places-view__card-title">${escapeHtml(data.title)}</h3>
              <span class="places-view__card-location" title="${escapeHtml(location)}">${escapeHtml(location)}</span>
            </div>
            ${this.renderVisitButton(jumpKind, jumpId)}
          </div>
        </div>
      </article>
    `
  }

  private renderPillCard(item: DclExploreItem): string {
    const data = item.kind === 'scene' ? item.place : item.world
    const thumb = this.sceneThumbUrl(data.image)
    const owner = placeOwnerAddress(data)
    const ownerShort = formatOwnerShort(owner)
    const location = placeLocationLabel(data)
    const jumpKind = item.kind
    const jumpId = item.kind === 'scene' ? item.place.id : item.world.id

    return `
      <article class="places-view__pill places-view__pill--featured-rect" role="listitem">
        <div class="places-view__pill-thumb">
          ${
            thumb
              ? `<img class="places-view__pill-img" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />`
              : '<div class="places-view__pill-placeholder" aria-hidden></div>'
          }
          ${data.highlighted ? '<span class="places-view__pill-featured">Featured</span>' : ''}
        </div>
        <div class="places-view__pill-body">
          <h3 class="places-view__pill-title">${escapeHtml(data.title)}</h3>
          ${
            owner
              ? `<div class="places-view__pill-creator" data-face-for="${escapeHtml(owner)}">
                  <span class="places-view__pill-avatar" aria-hidden></span>
                  <span class="places-view__pill-by">By <em>${escapeHtml(ownerShort ?? owner)}</em></span>
                </div>`
              : ''
          }
          <span class="places-view__pill-coords" title="${escapeHtml(location)}">
            <svg class="places-view__pill-pin" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path fill="currentColor" d="M12 2a6 6 0 0 0-6 6c0 4.2 6 12 6 12s6-7.8 6-12a6 6 0 0 0-6-6zm0 8.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/>
            </svg>
            ${escapeHtml(location)}
          </span>
        </div>
        ${this.renderVisitButton(jumpKind, jumpId)}
      </article>
    `
  }

  private renderCard(item: DclExploreItem, layout: CardLayout): string {
    const data = item.kind === 'scene' ? item.place : item.world
    const thumb = this.sceneThumbUrl(data.image)
    const owner = placeOwnerAddress(data)
    const ownerShort = formatOwnerShort(owner)
    const ownerLabel = ownerShort ? `By ${ownerShort}` : ''
    const like =
      data.likePercent !== null ? `<span class="places-view__card-stat">${data.likePercent}%</span>` : ''
    const location = placeLocationLabel(data)
    const jumpKind = item.kind
    const jumpId = item.kind === 'scene' ? item.place.id : item.world.id
    const actionLabel = this.onOpenScene ? 'Visit' : 'Jump In'

    if (this.variant === 'explorer') {
      const topBadges = this.renderMediaTopBadges({
        userCount: data.userCount,
        highlighted: data.highlighted
      })

      return `
        <article class="places-view__card places-view__card--${layout}" role="listitem">
          <div class="places-view__card-media">
            ${
              thumb
                ? `<img class="places-view__card-img" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />`
                : '<div class="places-view__card-placeholder" aria-hidden></div>'
            }
            ${topBadges}
          </div>
          <div class="places-view__card-body places-view__card-body--grid">
            <h3 class="places-view__card-title">${escapeHtml(data.title)}</h3>
            <div class="places-view__card-action">
              ${this.renderCreatorFooter(item, owner, ownerShort, location)}
              ${this.renderVisitButton(jumpKind, jumpId)}
            </div>
          </div>
        </article>
      `
    }

    const badges: string[] = []
    if (data.highlighted) {
      badges.push('<span class="places-view__badge places-view__badge--featured">Featured</span>')
    }
    return `
      <article class="places-view__card places-view__card--${layout}" role="listitem">
        <div class="places-view__card-media">
          ${
            thumb
              ? `<img class="places-view__card-img" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />`
              : '<div class="places-view__card-placeholder" aria-hidden></div>'
          }
          ${badges.length > 0 ? `<div class="places-view__card-badges">${badges.join('')}</div>` : ''}
          <span class="places-view__card-count" aria-label="${data.userCount} people here">${data.userCount}</span>
        </div>
        <div class="places-view__card-body">
          <h3 class="places-view__card-title">${escapeHtml(data.title)}</h3>
          <div class="places-view__card-meta">
            ${
              owner
                ? `<span class="places-view__card-creator" data-face-for="${escapeHtml(owner)}">
                    <span class="places-view__card-avatar" aria-hidden></span>
                    <span class="places-view__card-owner">${escapeHtml(ownerLabel || owner)}</span>
                  </span>`
                : ''
            }
            ${like}
          </div>
          <div class="places-view__card-footer">
            <span class="places-view__card-location" title="${escapeHtml(location)}">${escapeHtml(location)}</span>
            <span class="places-view__card-footer-right">
              ${this.categoryPillsHtml(item)}
              <button type="button" class="places-view__jump" data-jump-route data-jump-kind="${jumpKind}" data-jump-id="${escapeHtml(jumpId)}">${actionLabel}</button>
            </span>
          </div>
        </div>
      </article>
    `
  }

  private sceneThumbUrl(raw: string | null | undefined): string | null {
    return rewriteCatalystUrl(raw)
  }

  private async hydrateFaceUrls(items: DclExploreItem[]): Promise<void> {
    const addresses = new Set<string>()
    for (const item of items) {
      const addr = placeOwnerAddress(item.kind === 'scene' ? item.place : item.world)
      if (addr) addresses.add(addr.toLowerCase())
    }

    for (const address of addresses) {
      if (this.faceCache.has(address) || this.facePending.has(address)) continue
      this.facePending.add(address)
      const faceUrl = await fetchProfileFaceUrl(address)
      this.faceCache.set(address, faceUrl)
      this.facePending.delete(address)
      if (this.disposed) return

      for (const el of this.root.querySelectorAll<HTMLElement>(`[data-face-for="${address}"]`)) {
        const avatar =
          el.querySelector('.places-view__card-avatar') ?? el.querySelector('.places-view__pill-avatar')
        if (!avatar) continue
        if (faceUrl) {
          avatar.innerHTML = `<img src="${escapeHtml(faceUrl)}" alt="" loading="lazy" />`
        } else {
          avatar.textContent = address.slice(2, 4).toUpperCase()
        }
      }
    }
  }

  private setStatus(msg: string | null, kind?: 'loading' | 'error'): void {
    if (!msg) {
      this.statusEl.hidden = true
      this.statusEl.textContent = ''
      this.statusEl.className = 'places-view__status'
      return
    }
    this.statusEl.hidden = false
    this.statusEl.textContent = msg
    this.statusEl.className = `places-view__status places-view__status--${kind ?? 'loading'}`
  }
}