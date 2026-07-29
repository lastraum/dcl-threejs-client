import type { MarketplaceItem } from '../../../../marketplace/types'
import { createMarketplaceItemCard } from './MarketplaceItemCard'

export type MarketplaceRailOptions = {
  title: string
  items: MarketplaceItem[]
  loading?: boolean
  emptyMessage?: string
  selectedId?: string | null
  onSelect?: (item: MarketplaceItem) => void
  onBuyStub?: (item: MarketplaceItem) => void
}

/** Horizontal scrolling product rail. */
export class MarketplaceRail {
  readonly root: HTMLElement
  private readonly track: HTMLElement
  private readonly titleEl: HTMLElement

  constructor(private opts: MarketplaceRailOptions) {
    this.root = document.createElement('section')
    this.root.className = 'marketplace-rail'
    this.root.innerHTML = `
      <header class="marketplace-rail__head">
        <h2 class="marketplace-rail__title"></h2>
      </header>
      <div class="marketplace-rail__track" data-track></div>
    `
    this.titleEl = this.root.querySelector('.marketplace-rail__title')!
    this.track = this.root.querySelector('[data-track]')!
    this.render()
  }

  setOptions(partial: Partial<MarketplaceRailOptions>): void {
    this.opts = { ...this.opts, ...partial }
    this.render()
  }

  private render(): void {
    this.titleEl.textContent = this.opts.title
    this.track.replaceChildren()

    if (this.opts.loading) {
      for (let i = 0; i < 5; i++) {
        const sk = document.createElement('div')
        sk.className = 'marketplace-item-card marketplace-item-card--skeleton'
        sk.setAttribute('aria-hidden', 'true')
        this.track.appendChild(sk)
      }
      return
    }

    if (!this.opts.items.length) {
      const empty = document.createElement('p')
      empty.className = 'marketplace-rail__empty'
      empty.textContent = this.opts.emptyMessage ?? 'Nothing here yet'
      this.track.appendChild(empty)
      return
    }

    for (const item of this.opts.items) {
      this.track.appendChild(
        createMarketplaceItemCard({
          item,
          selected: item.id === this.opts.selectedId,
          onSelect: this.opts.onSelect,
          onBuyStub: this.opts.onBuyStub
        })
      )
    }
  }
}
