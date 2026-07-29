import type { MarketplaceKind } from '../../../../marketplace/types'

export type MarketplaceCategoryChipsOptions = {
  active: MarketplaceKind | 'all'
  onChange: (kind: MarketplaceKind) => void
}

const CHIPS: { kind: MarketplaceKind; label: string }[] = [
  { kind: 'wearable', label: 'Wearables' },
  { kind: 'emote', label: 'Emotes' },
  { kind: 'name', label: 'Names' },
  { kind: 'land', label: 'Land' }
]

export class MarketplaceCategoryChips {
  readonly root: HTMLElement

  constructor(private opts: MarketplaceCategoryChipsOptions) {
    this.root = document.createElement('div')
    this.root.className = 'marketplace-category-chips'
    this.root.setAttribute('role', 'tablist')
    this.root.setAttribute('aria-label', 'Marketplace categories')
    this.render()
  }

  setActive(kind: MarketplaceKind | 'all'): void {
    this.opts = { ...this.opts, active: kind }
    this.render()
  }

  private render(): void {
    this.root.replaceChildren()
    for (const chip of CHIPS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'marketplace-category-chips__chip'
      btn.dataset.kind = chip.kind
      btn.setAttribute('role', 'tab')
      const active = this.opts.active === chip.kind || (this.opts.active === 'all' && chip.kind === 'wearable')
      btn.classList.toggle('marketplace-category-chips__chip--active', active)
      btn.setAttribute('aria-selected', active ? 'true' : 'false')
      btn.textContent = chip.label
      btn.addEventListener('click', () => this.opts.onChange(chip.kind))
      this.root.appendChild(btn)
    }
  }
}
