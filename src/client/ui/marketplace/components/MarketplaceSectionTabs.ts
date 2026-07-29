import type { MarketplaceSectionId } from '../../../../dcl/content/route'

export type MarketplaceSectionTabsOptions = {
  active: MarketplaceSectionId
  onChange: (section: MarketplaceSectionId) => void
}

const TABS: { id: MarketplaceSectionId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'collectibles', label: 'Collectibles' },
  { id: 'land', label: 'Land' },
  { id: 'names', label: 'NAMEs' },
  { id: 'my-assets', label: 'My Assets' },
  { id: 'my-lists', label: 'My Lists' }
]

/** DCL-style section tabs under Marketplace shell chrome. */
export class MarketplaceSectionTabs {
  readonly root: HTMLElement

  constructor(private opts: MarketplaceSectionTabsOptions) {
    this.root = document.createElement('nav')
    this.root.className = 'marketplace-section-tabs'
    this.root.setAttribute('aria-label', 'Marketplace sections')
    this.render()
  }

  setActive(section: MarketplaceSectionId): void {
    this.opts = { ...this.opts, active: section }
    this.render()
  }

  private render(): void {
    this.root.replaceChildren()
    for (const tab of TABS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'marketplace-section-tabs__tab'
      btn.dataset.section = tab.id
      const active = tab.id === this.opts.active
      btn.classList.toggle('marketplace-section-tabs__tab--active', active)
      btn.setAttribute('aria-current', active ? 'page' : 'false')
      btn.textContent = tab.label
      btn.addEventListener('click', () => {
        if (tab.id === this.opts.active) return
        this.opts.onChange(tab.id)
      })
      this.root.appendChild(btn)
    }
  }
}
