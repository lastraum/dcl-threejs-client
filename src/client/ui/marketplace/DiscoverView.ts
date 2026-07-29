import {
  DISCOVER_UNSUPPORTED_COPY,
  loadDiscover,
  type DiscoverData,
  type MarketplaceItem,
  type MarketplaceKind
} from '../../../marketplace'
import { MarketplaceCategoryChips } from './components/MarketplaceCategoryChips'
import { MarketplaceHero } from './components/MarketplaceHero'
import { MarketplaceRail } from './components/MarketplaceRail'
import { MarketplaceRankList } from './components/MarketplaceRankList'

export type DiscoverViewOptions = {
  onOpenItem: (item: MarketplaceItem) => void
}

/**
 * Marketplace Discover — hero, category chips, trending/newest rails, side rankings.
 * Hydrates from marketplace-api via shared store.
 */
export class DiscoverView {
  readonly root: HTMLElement

  private readonly hero: MarketplaceHero
  private readonly chips: MarketplaceCategoryChips
  private readonly trendingRail: MarketplaceRail
  private readonly newestRail: MarketplaceRail
  private readonly ranks: MarketplaceRankList
  private readonly statusEl: HTMLElement
  private readonly mainCol: HTMLElement

  private kind: MarketplaceKind = 'wearable'
  private data: DiscoverData | null = null
  private selectedId: string | null = null
  private loadSeq = 0
  private disposed = false

  constructor(private readonly opts: DiscoverViewOptions) {
    this.root = document.createElement('div')
    this.root.className = 'discover-view'

    this.hero = new MarketplaceHero({
      item: null,
      loading: true,
      onSelect: (item) => this.openItem(item)
    })

    this.chips = new MarketplaceCategoryChips({
      active: this.kind,
      onChange: (kind) => void this.setKind(kind)
    })

    this.trendingRail = new MarketplaceRail({
      title: 'Trending',
      items: [],
      loading: true,
      onSelect: (item) => this.openItem(item),
      onBuyStub: (item) => this.onBuyStub(item)
    })

    this.newestRail = new MarketplaceRail({
      title: 'Newest',
      items: [],
      loading: true,
      onSelect: (item) => this.openItem(item),
      onBuyStub: (item) => this.onBuyStub(item)
    })

    this.ranks = new MarketplaceRankList({
      title: 'Rankings',
      items: [],
      loading: true,
      onSelect: (item) => this.openItem(item)
    })

    this.statusEl = document.createElement('p')
    this.statusEl.className = 'discover-view__status'
    this.statusEl.hidden = true

    this.mainCol = document.createElement('div')
    this.mainCol.className = 'discover-view__main'
    this.mainCol.appendChild(this.hero.root)
    this.mainCol.appendChild(this.chips.root)
    this.mainCol.appendChild(this.statusEl)
    this.mainCol.appendChild(this.trendingRail.root)
    this.mainCol.appendChild(this.newestRail.root)

    const layout = document.createElement('div')
    layout.className = 'discover-view__layout'
    layout.appendChild(this.mainCol)
    layout.appendChild(this.ranks.root)

    this.root.appendChild(layout)
  }

  mount(): void {
    void this.reload()
  }

  dispose(): void {
    this.disposed = true
    this.root.remove()
  }

  private async setKind(kind: MarketplaceKind): Promise<void> {
    if (this.kind === kind && this.data) return
    this.kind = kind
    this.chips.setActive(kind)
    this.selectedId = null
    await this.reload()
  }

  private async reload(): Promise<void> {
    const seq = ++this.loadSeq
    this.applyLoadingUi()

    if (this.kind === 'name' || this.kind === 'land') {
      if (seq !== this.loadSeq || this.disposed) return
      this.data = {
        trending: [],
        newest: [],
        rankings: [],
        byId: new Map(),
        hero: null
      }
      this.statusEl.hidden = false
      this.statusEl.textContent = DISCOVER_UNSUPPORTED_COPY[this.kind]
      this.statusEl.classList.add('discover-view__status--info')
      this.applyDataUi()
      return
    }

    this.statusEl.hidden = true
    this.statusEl.classList.remove('discover-view__status--info', 'discover-view__status--error')

    try {
      const data = await loadDiscover({ kind: this.kind })
      if (seq !== this.loadSeq || this.disposed) return
      this.data = data
      this.applyDataUi()
    } catch (err) {
      if (seq !== this.loadSeq || this.disposed) return
      this.data = {
        trending: [],
        newest: [],
        rankings: [],
        byId: new Map(),
        hero: null
      }
      this.statusEl.hidden = false
      this.statusEl.classList.add('discover-view__status--error')
      this.statusEl.textContent =
        err instanceof Error ? `Could not load marketplace: ${err.message}` : 'Could not load marketplace'
      this.applyDataUi()
    }
  }

  private applyLoadingUi(): void {
    this.hero.setOptions({ item: null, loading: true })
    this.trendingRail.setOptions({ items: [], loading: true })
    this.newestRail.setOptions({ items: [], loading: true })
    this.ranks.setOptions({ items: [], loading: true })
  }

  private applyDataUi(): void {
    const d = this.data
    this.hero.setOptions({
      item: d?.hero ?? null,
      loading: false,
      onSelect: (item) => this.openItem(item)
    })
    this.trendingRail.setOptions({
      items: d?.trending ?? [],
      loading: false,
      selectedId: this.selectedId,
      emptyMessage: 'No trending items right now',
      onSelect: (item) => this.openItem(item),
      onBuyStub: (item) => this.onBuyStub(item)
    })
    this.newestRail.setOptions({
      items: d?.newest ?? [],
      loading: false,
      selectedId: this.selectedId,
      emptyMessage: 'No new items right now',
      onSelect: (item) => this.openItem(item),
      onBuyStub: (item) => this.onBuyStub(item)
    })
    this.ranks.setOptions({
      items: d?.rankings ?? [],
      loading: false,
      selectedId: this.selectedId,
      emptyMessage: 'No rankings yet',
      onSelect: (item) => this.openItem(item)
    })
  }

  private openItem(item: MarketplaceItem): void {
    this.selectedId = item.id
    this.applyDataUi()
    this.opts.onOpenItem(item)
  }

  private onBuyStub(item: MarketplaceItem): void {
    // Buy from rail still opens detail (purchase flow later)
    this.openItem(item)
  }
}
