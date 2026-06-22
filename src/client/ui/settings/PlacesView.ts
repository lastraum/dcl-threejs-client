import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { RouteTarget } from '../../../dcl/content/route'
import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import {
  PLACES_PAGE_SIZE,
  PLACES_SCENE_CATEGORIES,
  buildUnifiedExplorerItems,
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

export type PlacesViewOptions = {
  onJumpIn?: (target: RouteTarget) => void
  getAuthIdentity?: () => AuthIdentity | null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Places tab — combined Genesis scenes + Worlds explore (dcl-companion HotScenesCrowd parity). */
export class PlacesView {
  readonly root: HTMLElement

  private readonly statusEl: HTMLElement
  private readonly gridEl: HTMLElement
  private readonly sentinelEl: HTMLElement
  private readonly searchInput: HTMLInputElement
  private readonly sortSelect: HTMLSelectElement
  private readonly catBar: HTMLElement
  private readonly subTabs: HTMLElement

  private readonly onJumpIn?: (target: RouteTarget) => void
  private readonly getAuthIdentity?: () => AuthIdentity | null

  private subTab: PlacesSubTab = 'explore'
  private categoryId = 'all'
  private explorerSort: ExplorerSortMode = 'most_users'
  private searchQuery = ''
  private searchDebounced = ''

  private genesisPlaces: DclGenesisPlace[] = []
  private worlds: DclPlacesWorld[] = []
  private placesOffset = 0
  private worldsOffset = 0
  private placesHasMore = true
  private worldsHasMore = true

  private loading = false
  private loadingMore = false
  private error: string | null = null
  private disposed = false
  private searchTimer = 0
  private loadGen = 0
  private observer: IntersectionObserver | null = null

  private readonly faceCache = new Map<string, string | null>()
  private readonly facePending = new Set<string>()

  constructor(opts: PlacesViewOptions = {}) {
    this.onJumpIn = opts.onJumpIn
    this.getAuthIdentity = opts.getAuthIdentity

    this.root = document.createElement('div')
    this.root.className = 'places-view'
    this.root.innerHTML = `
      <header class="places-view__header">
        <h2 class="places-view__title">Explore</h2>
        <div class="places-view__header-actions">
          <select class="places-view__sort" data-sort aria-label="Sort list">
            <option value="most_users">Most users</option>
            <option value="name_az">A–Z</option>
          </select>
          <button type="button" class="places-view__btn places-view__btn--ghost" data-refresh>Refresh</button>
        </div>
      </header>

      <nav class="places-view__subtabs" data-subtabs role="tablist" aria-label="Places sections">
        <button type="button" class="places-view__subtab is-active" data-subtab="explore" role="tab" aria-selected="true">Explore</button>
        <button type="button" class="places-view__subtab" data-subtab="recent" role="tab" aria-selected="false">Recent</button>
        <button type="button" class="places-view__subtab" data-subtab="favorites" role="tab" aria-selected="false">Favorites</button>
      </nav>

      <div class="places-view__toolbar">
        <input
          type="search"
          class="places-view__search"
          data-search
          placeholder="Search places and worlds…"
          aria-label="Search places and worlds"
          autocomplete="off"
          spellcheck="false"
        />
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

    this.statusEl = this.root.querySelector('[data-status]')!
    this.gridEl = this.root.querySelector('[data-grid]')!
    this.sentinelEl = this.root.querySelector('[data-sentinel]')!
    this.searchInput = this.root.querySelector('[data-search]')!
    this.sortSelect = this.root.querySelector('[data-sort]')!
    this.catBar = this.root.querySelector('[data-cat-bar]')!
    this.subTabs = this.root.querySelector('[data-subtabs]')!

    this.buildCategoryPills()
    this.bindEvents()
  }

  mount(): void {
    this.setupInfiniteScroll()
    void this.reloadAll()
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

    this.root.querySelector('[data-refresh]')!.addEventListener('click', () => void this.reloadAll())

    this.subTabs.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-subtab]')
      if (!btn) return
      const tab = btn.dataset.subtab as PlacesSubTab | undefined
      if (!tab) return
      if (tab === 'favorites' && !this.getAuthIdentity?.()) {
        this.setStatus('Connect your wallet to see favorites', 'error')
        return
      }
      this.setSubTab(tab)
    })

    this.root.addEventListener('click', (ev) => {
      const jumpBtn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-jump-route]')
      if (!jumpBtn) return
      const kind = jumpBtn.dataset.jumpKind
      const id = jumpBtn.dataset.jumpId
      if (!kind || !id) return
      if (kind === 'scene') {
        const place = this.genesisPlaces.find((p) => p.id === id)
        if (place) this.onJumpIn?.(genesisPlaceJumpRoute(place))
      } else if (kind === 'world') {
        const world = this.worlds.find((w) => w.id === id)
        if (world) this.onJumpIn?.(placesWorldJumpRoute(world))
      }
    })
  }

  private buildCategoryPills(): void {
    this.catBar.innerHTML = PLACES_SCENE_CATEGORIES.map(
      (c) => `
        <button
          type="button"
          class="places-view__cat-pill${c.id === 'all' ? ' is-active' : ''}"
          data-cat="${escapeHtml(c.id)}"
          aria-pressed="${c.id === 'all'}"
        >
          <span class="places-view__cat-swatch" style="background:${c.swatch}" aria-hidden></span>
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
    const scrollRoot = this.root.closest('.settings-overlay__content')
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void this.loadMore()
      },
      { root: scrollRoot, rootMargin: '240px 0px' }
    )
    this.observer.observe(this.sentinelEl)
  }

  private orderByForTab(): { places: 'most_active' | 'updated_at'; worlds: 'most_active' | 'created_at' } {
    if (this.subTab === 'recent') {
      return { places: 'updated_at', worlds: 'created_at' }
    }
    return { places: 'most_active', worlds: 'most_active' }
  }

  private async reloadAll(): Promise<void> {
    const gen = ++this.loadGen
    this.loading = true
    this.error = null
    this.placesOffset = 0
    this.worldsOffset = 0
    this.placesHasMore = true
    this.worldsHasMore = true
    this.setStatus(this.subTab === 'favorites' ? 'Loading favorites…' : 'Loading places and worlds…', 'loading')
    this.gridEl.innerHTML = ''

    try {
      const identity = this.getAuthIdentity?.() ?? null
      const onlyFavorites = this.subTab === 'favorites'
      const order = this.orderByForTab()
      const q = this.searchDebounced.trim()
      const cat = PLACES_SCENE_CATEGORIES.find((c) => c.id === this.categoryId)

      const placesPromise = fetchDclGenesisPlaces({
        search: q.length >= 3 ? q : undefined,
        orderBy: order.places,
        categories: this.subTab === 'explore' && cat?.slug ? [cat.slug] : undefined,
        limit: PLACES_PAGE_SIZE,
        offset: 0,
        onlyFavorites,
        identity: onlyFavorites ? identity : null
      })

      const worldsPromise = onlyFavorites
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

      const [places, worldsList] = await Promise.all([placesPromise, worldsPromise])
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
    if (this.loading || this.loadingMore) return
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

  private getFilteredItems(): DclExploreItem[] {
    const normalizedSearch = this.searchQuery.trim().toLowerCase()
    const compactSearch = normalizedSearch.replace(/\s/g, '')

    const placesFiltered = this.genesisPlaces.filter((p) =>
      matchesPlaceSearch(p, normalizedSearch, compactSearch)
    )
    const worldsFiltered = this.worlds.filter((w) => matchesWorldSearch(w, normalizedSearch))

    return buildUnifiedExplorerItems(placesFiltered, worldsFiltered, this.explorerSort)
  }

  private renderGrid(): void {
    const emptyEl = this.root.querySelector('[data-empty]') as HTMLElement
    const items = this.getFilteredItems()

    if (items.length === 0) {
      this.gridEl.innerHTML = ''
      emptyEl.hidden = this.loading || Boolean(this.error)
      if (!this.loading && !this.error) {
        if (this.subTab === 'favorites') {
          emptyEl.textContent = 'No favorites yet. Heart places in-world to see them here.'
        } else if (this.searchQuery.trim()) {
          emptyEl.textContent = 'No scenes or worlds match your search.'
        } else {
          emptyEl.textContent = 'No scenes or worlds returned.'
        }
      }
      return
    }

    emptyEl.hidden = true
    this.gridEl.innerHTML = items.map((item) => this.renderCard(item)).join('')
    void this.hydrateFaceUrls(items)
  }

  private renderCard(item: DclExploreItem): string {
    const data = item.kind === 'scene' ? item.place : item.world
    const thumb = data.image
    const owner = placeOwnerAddress(data)
    const ownerShort = formatOwnerShort(owner)
    const like =
      data.likePercent !== null ? `<span class="places-view__card-stat">${data.likePercent}%</span>` : ''
    const location = placeLocationLabel(data)
    const badges: string[] = []
    if (data.highlighted) badges.push('<span class="places-view__badge places-view__badge--featured">Featured</span>')
    if (data.isLive) badges.push('<span class="places-view__badge places-view__badge--live">LIVE</span>')

    const jumpKind = item.kind
    const jumpId = item.kind === 'scene' ? item.place.id : item.world.id

    return `
      <article class="places-view__card" role="listitem">
        <div class="places-view__card-media">
          ${
            thumb
              ? `<img class="places-view__card-img" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />`
              : '<div class="places-view__card-placeholder" aria-hidden></div>'
          }
          ${badges.length > 0 ? `<div class="places-view__card-badges">${badges.join('')}</div>` : ''}
          <span class="places-view__card-count" aria-label="${data.userCount} people here">
            ${data.userCount} ${data.userCount === 1 ? 'person' : 'people'}
          </span>
        </div>
        <div class="places-view__card-body">
          <h3 class="places-view__card-title">${escapeHtml(data.title)}</h3>
          <div class="places-view__card-meta">
            ${
              owner
                ? `<span class="places-view__card-creator" data-face-for="${escapeHtml(owner)}">
                    <span class="places-view__card-avatar" aria-hidden></span>
                    <span class="places-view__card-owner">${escapeHtml(ownerShort ?? owner)}</span>
                  </span>`
                : ''
            }
            ${like}
          </div>
          <div class="places-view__card-footer">
            <span class="places-view__card-location" title="${escapeHtml(location)}">${escapeHtml(location)}</span>
            <button type="button" class="places-view__jump" data-jump-route data-jump-kind="${jumpKind}" data-jump-id="${escapeHtml(jumpId)}">
              Jump In
            </button>
          </div>
        </div>
      </article>
    `
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

      for (const el of this.gridEl.querySelectorAll<HTMLElement>(`[data-face-for="${address}"]`)) {
        const avatar = el.querySelector('.places-view__card-avatar')
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