import { escapeHtml, formatMana, rarityClass, shortCreator } from '../../../../marketplace/format'
import type { MarketplaceItem } from '../../../../marketplace/types'

export type MarketplaceItemCardOptions = {
  item: MarketplaceItem
  selected?: boolean
  onSelect?: (item: MarketplaceItem) => void
  onBuyStub?: (item: MarketplaceItem) => void
}

/** Compact glass product card for rails / grids. */
export function createMarketplaceItemCard(opts: MarketplaceItemCardOptions): HTMLElement {
  const { item } = opts
  const el = document.createElement('article')
  el.className = 'marketplace-item-card'
  el.dataset.itemId = item.id
  if (opts.selected) el.classList.add('marketplace-item-card--selected')
  el.setAttribute('role', 'button')
  el.tabIndex = 0

  const rarity = String(item.rarity || 'common').toLowerCase()
  const mana = formatMana(item.priceMana)
  const thumb = item.thumbnail
    ? `<img class="marketplace-item-card__thumb-img" src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" decoding="async" />`
    : `<div class="marketplace-item-card__thumb-ph" aria-hidden="true"></div>`

  const creator = item.creator
    ? `<span class="marketplace-item-card__creator">${escapeHtml(shortCreator(item.creator))}</span>`
    : ''

  el.innerHTML = `
    <div class="marketplace-item-card__thumb">
      ${thumb}
      <span class="marketplace-item-card__rarity ${rarityClass(rarity)}">${escapeHtml(rarity)}</span>
    </div>
    <div class="marketplace-item-card__body">
      <h3 class="marketplace-item-card__name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h3>
      ${creator}
      <div class="marketplace-item-card__row">
        <span class="marketplace-item-card__price">
          <span class="marketplace-item-card__mana-icon" aria-hidden="true">◆</span>
          ${escapeHtml(mana)}
          <span class="marketplace-item-card__mana-label">MANA</span>
        </span>
        <button type="button" class="marketplace-item-card__buy" data-buy>Buy</button>
      </div>
    </div>
  `

  const img = el.querySelector('.marketplace-item-card__thumb-img') as HTMLImageElement | null
  img?.addEventListener('error', () => {
    img.replaceWith(
      Object.assign(document.createElement('div'), {
        className: 'marketplace-item-card__thumb-ph',
        ariaHidden: 'true'
      })
    )
  })

  const select = (): void => opts.onSelect?.(item)
  el.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement
    if (t.closest('[data-buy]')) return
    select()
  })
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      select()
    }
  })

  el.querySelector('[data-buy]')?.addEventListener('click', (ev) => {
    ev.stopPropagation()
    opts.onBuyStub?.(item)
  })

  return el
}

export function setMarketplaceItemCardSelected(el: HTMLElement, selected: boolean): void {
  el.classList.toggle('marketplace-item-card--selected', selected)
}
