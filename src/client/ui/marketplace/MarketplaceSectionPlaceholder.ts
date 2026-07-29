import type { MarketplaceSectionId } from '../../../dcl/content/route'

const COPY: Record<Exclude<MarketplaceSectionId, 'overview' | 'collectibles' | 'land'>, string> = {
  names: 'NAME claim & trade will land here after Collectibles.',
  'my-assets': 'Your owned wearables & emotes — wallet inventory view coming soon.',
  'my-lists': 'Saved lists & watchlists — coming soon.'
}

const TITLES: Record<Exclude<MarketplaceSectionId, 'overview' | 'collectibles' | 'land'>, string> = {
  names: 'NAMEs',
  'my-assets': 'My Assets',
  'my-lists': 'My Lists'
}

export class MarketplaceSectionPlaceholder {
  readonly root: HTMLElement

  constructor(section: Exclude<MarketplaceSectionId, 'overview' | 'collectibles' | 'land'>) {
    this.root = document.createElement('div')
    this.root.className = 'marketplace-section-placeholder'
    this.root.innerHTML = `
      <div class="marketplace-section-placeholder__card">
        <h2 class="marketplace-section-placeholder__title">${TITLES[section]}</h2>
        <p class="marketplace-section-placeholder__text">${COPY[section]}</p>
      </div>
    `
  }

  dispose(): void {
    this.root.remove()
  }
}
