import {
  fetchItemsPage,
  type MarketplaceItem,
  type MarketplaceOrderBy
} from '../../../marketplace'
import {
  COLLECTIBLES_NAV,
  COLLECTIBLES_PAGE_SIZE,
  findCollectiblesNavNode,
  type CollectiblesCategoryId
} from '../../../marketplace/collectiblesCatalog'
import { createMarketplaceItemCard } from './components/MarketplaceItemCard'

export type CollectiblesViewOptions = {
  onOpenItem: (item: MarketplaceItem) => void
}

type SortId = MarketplaceOrderBy

const SORTS: { id: SortId; label: string }[] = [
  { id: 'newest', label: 'Newest' },
  { id: 'recently_listed', label: 'Recently listed' },
  { id: 'recently_sold', label: 'Recently sold' },
  { id: 'cheapest', label: 'Cheapest' }
]

/**
 * Collectibles browse — sidebar categories + search/sort grid.
 * Better chrome than stock DCL; same marketplace-api power.
 */
export class CollectiblesView {
  readonly root: HTMLElement

  private readonly sidebarEl: HTMLElement
  private readonly gridEl: HTMLElement
  private readonly countEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly searchInput: HTMLInputElement
  private readonly sortSelect: HTMLSelectElement
  private readonly onSaleToggle: HTMLInputElement
  private readonly smartToggle: HTMLInputElement
  private readonly loadMoreBtn: HTMLButtonElement

  private categoryId: CollectiblesCategoryId = 'wearables'
  private search = ''
  private sort: SortId = 'newest'
  private onSaleOnly = true
  private smartOnly = false
  private items: MarketplaceItem[] = []
  private total: number | null = null
  private skip = 0
  private loading = false
  private loadSeq = 0
  private disposed = false
  private searchTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: CollectiblesViewOptions) {
    this.root = document.createElement('div')
    this.root.className = 'collectibles-view'

    this.root.innerHTML = `
      <aside class="collectibles-view__sidebar" aria-label="Categories">
        <p class="collectibles-view__sidebar-label">Categories</p>
        <div class="collectibles-view__nav" data-nav></div>
        <div class="collectibles-view__filters">
          <p class="collectibles-view__sidebar-label">Filters</p>
          <label class="collectibles-view__toggle">
            <span>On sale</span>
            <input type="checkbox" data-on-sale checked />
          </label>
          <label class="collectibles-view__toggle">
            <span>Smart only</span>
            <input type="checkbox" data-smart />
          </label>
        </div>
      </aside>
      <div class="collectibles-view__main">
        <div class="collectibles-view__toolbar">
          <div class="collectibles-view__search-wrap">
            <span class="collectibles-view__search-icon" aria-hidden="true">⌕</span>
            <input
              type="search"
              class="collectibles-view__search"
              data-search
              placeholder="Search collectibles"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <div class="collectibles-view__toolbar-meta">
            <span class="collectibles-view__count" data-count></span>
            <label class="collectibles-view__sort">
              <span class="collectibles-view__sort-label">Sort</span>
              <select data-sort></select>
            </label>
          </div>
        </div>
        <p class="collectibles-view__status" data-status hidden></p>
        <div class="collectibles-view__grid" data-grid></div>
        <div class="collectibles-view__footer">
          <button type="button" class="collectibles-view__load-more" data-load-more hidden>Load more</button>
        </div>
      </div>
    `

    this.sidebarEl = this.root.querySelector('[data-nav]')!
    this.gridEl = this.root.querySelector('[data-grid]')!
    this.countEl = this.root.querySelector('[data-count]')!
    this.statusEl = this.root.querySelector('[data-status]')!
    this.searchInput = this.root.querySelector('[data-search]')!
    this.sortSelect = this.root.querySelector('[data-sort]')!
    this.onSaleToggle = this.root.querySelector('[data-on-sale]')!
    this.smartToggle = this.root.querySelector('[data-smart]')!
    this.loadMoreBtn = this.root.querySelector('[data-load-more]')!

    for (const s of SORTS) {
      const opt = document.createElement('option')
      opt.value = s.id
      opt.textContent = s.label
      this.sortSelect.appendChild(opt)
    }
    this.sortSelect.value = this.sort

    this.renderNav()
    this.bind()
  }

  mount(): void {
    void this.reload(true)
  }

  dispose(): void {
    this.disposed = true
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.root.remove()
  }

  private bind(): void {
    this.searchInput.addEventListener('input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(() => {
        this.search = this.searchInput.value.trim()
        void this.reload(true)
      }, 320)
    })
    this.sortSelect.addEventListener('change', () => {
      this.sort = this.sortSelect.value as SortId
      void this.reload(true)
    })
    this.onSaleToggle.addEventListener('change', () => {
      this.onSaleOnly = this.onSaleToggle.checked
      void this.reload(true)
    })
    this.smartToggle.addEventListener('change', () => {
      this.smartOnly = this.smartToggle.checked
      void this.reload(true)
    })
    this.loadMoreBtn.addEventListener('click', () => void this.loadMore())
  }

  private renderNav(): void {
    this.sidebarEl.replaceChildren()
    for (const node of COLLECTIBLES_NAV) {
      this.sidebarEl.appendChild(this.navButton(node.id, node.label, false))
      if (node.children?.length) {
        const group = document.createElement('div')
        group.className = 'collectibles-view__nav-children'
        for (const child of node.children) {
          group.appendChild(this.navButton(child.id, child.label, true))
        }
        this.sidebarEl.appendChild(group)
      }
    }
  }

  private navButton(id: CollectiblesCategoryId, label: string, child: boolean): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = child
      ? 'collectibles-view__nav-btn collectibles-view__nav-btn--child'
      : 'collectibles-view__nav-btn'
    btn.textContent = label
    btn.dataset.cat = id
    btn.classList.toggle('collectibles-view__nav-btn--active', id === this.categoryId)
    btn.addEventListener('click', () => {
      if (this.categoryId === id) return
      this.categoryId = id
      this.renderNav()
      void this.reload(true)
    })
    return btn
  }

  private async reload(reset: boolean): Promise<void> {
    const seq = ++this.loadSeq
    if (reset) {
      this.skip = 0
      this.items = []
      this.total = null
      this.renderGrid(true)
    }
    this.loading = true
    this.updateCount()
    this.statusEl.hidden = true
    this.loadMoreBtn.hidden = true

    const node = findCollectiblesNavNode(this.categoryId) ?? COLLECTIBLES_NAV[0]!

    try {
      const page = await fetchItemsPage({
        category: node.apiCategory,
        wearableCategory: node.wearableCategory,
        orderBy: this.sort,
        first: COLLECTIBLES_PAGE_SIZE,
        skip: this.skip,
        isOnSale: this.onSaleOnly ? true : undefined,
        isSmart: this.smartOnly ? true : undefined,
        search: this.search || undefined
      })
      if (seq !== this.loadSeq || this.disposed) return
      this.items = reset ? page.items : [...this.items, ...page.items]
      this.total = page.total
      this.loading = false
      this.renderGrid(false)
      this.updateCount()
      this.updateLoadMore()
    } catch (err) {
      if (seq !== this.loadSeq || this.disposed) return
      this.loading = false
      this.statusEl.hidden = false
      this.statusEl.className = 'collectibles-view__status collectibles-view__status--error'
      this.statusEl.textContent =
        err instanceof Error ? err.message : 'Could not load collectibles'
      this.renderGrid(false)
      this.updateCount()
    }
  }

  private async loadMore(): Promise<void> {
    if (this.loading) return
    this.skip = this.items.length
    await this.reload(false)
  }

  private updateCount(): void {
    if (this.loading && !this.items.length) {
      this.countEl.textContent = 'Loading…'
      return
    }
    if (this.total != null) {
      this.countEl.textContent = `${this.total.toLocaleString()} items`
    } else {
      this.countEl.textContent = `${this.items.length.toLocaleString()} items`
    }
  }

  private updateLoadMore(): void {
    const hasMore =
      this.total != null ? this.items.length < this.total : this.items.length >= COLLECTIBLES_PAGE_SIZE
    this.loadMoreBtn.hidden = !hasMore || this.loading
    this.loadMoreBtn.disabled = this.loading
    this.loadMoreBtn.textContent = this.loading ? 'Loading…' : 'Load more'
  }

  private renderGrid(showSkeletons: boolean): void {
    this.gridEl.replaceChildren()
    if (showSkeletons && !this.items.length) {
      for (let i = 0; i < 12; i++) {
        const sk = document.createElement('div')
        sk.className = 'marketplace-item-card marketplace-item-card--skeleton'
        sk.setAttribute('aria-hidden', 'true')
        this.gridEl.appendChild(sk)
      }
      return
    }
    if (!this.items.length && !this.loading) {
      const empty = document.createElement('p')
      empty.className = 'collectibles-view__empty'
      empty.textContent = 'No items match these filters.'
      this.gridEl.appendChild(empty)
      return
    }
    for (const item of this.items) {
      this.gridEl.appendChild(
        createMarketplaceItemCard({
          item,
          onSelect: (it) => this.opts.onOpenItem(it),
          onBuyStub: (it) => this.opts.onOpenItem(it)
        })
      )
    }
  }
}
