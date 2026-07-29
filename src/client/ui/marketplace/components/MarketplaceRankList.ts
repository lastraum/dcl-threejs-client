import { escapeHtml, formatMana, rarityClass } from '../../../../marketplace/format'
import type { MarketplaceItem } from '../../../../marketplace/types'

export type MarketplaceRankListOptions = {
  title?: string
  items: MarketplaceItem[]
  loading?: boolean
  emptyMessage?: string
  selectedId?: string | null
  onSelect?: (item: MarketplaceItem) => void
}

/** Side rankings list (#1…n). */
export class MarketplaceRankList {
  readonly root: HTMLElement
  private readonly listEl: HTMLElement
  private readonly titleEl: HTMLElement

  constructor(private opts: MarketplaceRankListOptions) {
    this.root = document.createElement('aside')
    this.root.className = 'marketplace-rank-list'
    this.root.setAttribute('aria-label', opts.title ?? 'Rankings')
    this.root.innerHTML = `
      <header class="marketplace-rank-list__head">
        <h2 class="marketplace-rank-list__title"></h2>
        <span class="marketplace-rank-list__badge">Hot</span>
      </header>
      <ol class="marketplace-rank-list__ol" data-list></ol>
    `
    this.titleEl = this.root.querySelector('.marketplace-rank-list__title')!
    this.listEl = this.root.querySelector('[data-list]')!
    this.render()
  }

  setOptions(partial: Partial<MarketplaceRankListOptions>): void {
    this.opts = { ...this.opts, ...partial }
    this.render()
  }

  private render(): void {
    this.titleEl.textContent = this.opts.title ?? 'Rankings'
    this.listEl.replaceChildren()

    if (this.opts.loading) {
      for (let i = 0; i < 6; i++) {
        const li = document.createElement('li')
        li.className = 'marketplace-rank-list__row marketplace-rank-list__row--skeleton'
        li.setAttribute('aria-hidden', 'true')
        this.listEl.appendChild(li)
      }
      return
    }

    if (!this.opts.items.length) {
      const li = document.createElement('li')
      li.className = 'marketplace-rank-list__empty'
      li.textContent = this.opts.emptyMessage ?? 'No rankings yet'
      this.listEl.appendChild(li)
      return
    }

    this.opts.items.forEach((item, index) => {
      const li = document.createElement('li')
      li.className = 'marketplace-rank-list__row'
      if (item.id === this.opts.selectedId) li.classList.add('marketplace-rank-list__row--selected')
      li.dataset.itemId = item.id
      li.tabIndex = 0
      li.setAttribute('role', 'button')

      const rarity = String(item.rarity || 'common').toLowerCase()
      const thumb = item.thumbnail
        ? `<img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" decoding="async" />`
        : `<span class="marketplace-rank-list__ph" aria-hidden="true"></span>`

      li.innerHTML = `
        <span class="marketplace-rank-list__rank">#${index + 1}</span>
        <span class="marketplace-rank-list__thumb">${thumb}</span>
        <span class="marketplace-rank-list__meta">
          <span class="marketplace-rank-list__name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
          <span class="marketplace-rank-list__sub">
            <span class="marketplace-rank-list__rarity ${rarityClass(rarity)}">${escapeHtml(rarity)}</span>
            <span class="marketplace-rank-list__price">◆ ${escapeHtml(formatMana(item.priceMana))}</span>
          </span>
        </span>
      `

      const img = li.querySelector('img')
      img?.addEventListener('error', () => {
        img.replaceWith(Object.assign(document.createElement('span'), {
          className: 'marketplace-rank-list__ph',
          ariaHidden: 'true'
        }))
      })

      const select = (): void => this.opts.onSelect?.(item)
      li.addEventListener('click', select)
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault()
          select()
        }
      })
      this.listEl.appendChild(li)
    })
  }
}
