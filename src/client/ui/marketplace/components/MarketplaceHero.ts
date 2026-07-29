import { escapeHtml, formatMana, rarityClass } from '../../../../marketplace/format'
import type { MarketplaceItem } from '../../../../marketplace/types'

export type MarketplaceHeroOptions = {
  item: MarketplaceItem | null
  loading?: boolean
  onSelect?: (item: MarketplaceItem) => void
}

/** Discover hero banner. */
export class MarketplaceHero {
  readonly root: HTMLElement

  constructor(private opts: MarketplaceHeroOptions) {
    this.root = document.createElement('section')
    this.root.className = 'marketplace-hero'
    this.render()
  }

  setOptions(partial: Partial<MarketplaceHeroOptions>): void {
    this.opts = { ...this.opts, ...partial }
    this.render()
  }

  private render(): void {
    if (this.opts.loading) {
      this.root.classList.add('marketplace-hero--loading')
      this.root.innerHTML = `
        <div class="marketplace-hero__copy">
          <p class="marketplace-hero__eyebrow">Marketplace</p>
          <h1 class="marketplace-hero__title">Discover the Metaverse Closet</h1>
          <p class="marketplace-hero__sub marketplace-hero__sub--skeleton">Loading featured drop…</p>
        </div>
        <div class="marketplace-hero__stage marketplace-hero__stage--skeleton" aria-hidden="true"></div>
      `
      return
    }

    this.root.classList.remove('marketplace-hero--loading')
    const item = this.opts.item
    if (!item) {
      this.root.innerHTML = `
        <div class="marketplace-hero__copy">
          <p class="marketplace-hero__eyebrow">Marketplace</p>
          <h1 class="marketplace-hero__title">Discover the Metaverse Closet</h1>
          <p class="marketplace-hero__sub">Browse trending wearables &amp; emotes from the Decentraland marketplace.</p>
        </div>
        <div class="marketplace-hero__stage marketplace-hero__stage--empty" aria-hidden="true">
          <div class="marketplace-hero__glow"></div>
        </div>
      `
      return
    }

    const rarity = String(item.rarity || 'common').toLowerCase()
    const thumb = item.thumbnail
      ? `<img class="marketplace-hero__art" src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.name)}" />`
      : `<div class="marketplace-hero__art-ph" aria-hidden="true"></div>`

    this.root.innerHTML = `
      <div class="marketplace-hero__copy">
        <p class="marketplace-hero__eyebrow">Featured</p>
        <h1 class="marketplace-hero__title">Discover the Metaverse Closet</h1>
        <p class="marketplace-hero__drop">
          <span class="marketplace-hero__drop-label">Spotlight</span>
          <span class="marketplace-hero__drop-name">${escapeHtml(item.name)}</span>
        </p>
        <div class="marketplace-hero__meta">
          <span class="marketplace-hero__rarity ${rarityClass(rarity)}">${escapeHtml(rarity)}</span>
          <span class="marketplace-hero__price">◆ ${escapeHtml(formatMana(item.priceMana))} MANA</span>
        </div>
        <button type="button" class="marketplace-hero__cta" data-hero-select>View item</button>
      </div>
      <div class="marketplace-hero__stage">
        <div class="marketplace-hero__glow" aria-hidden="true"></div>
        <div class="marketplace-hero__pedestal" aria-hidden="true"></div>
        ${thumb}
      </div>
    `

    const img = this.root.querySelector('.marketplace-hero__art') as HTMLImageElement | null
    img?.addEventListener('error', () => {
      img.replaceWith(
        Object.assign(document.createElement('div'), {
          className: 'marketplace-hero__art-ph',
          ariaHidden: 'true'
        })
      )
    })

    this.root.querySelector('[data-hero-select]')?.addEventListener('click', () => {
      if (this.opts.item) this.opts.onSelect?.(this.opts.item)
    })
  }
}
