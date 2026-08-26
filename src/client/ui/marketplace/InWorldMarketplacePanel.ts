import type { Address } from 'viem'
import { formatMana, shortAddr } from '../../../lootBag/format'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import {
  classifyCartSource,
  fetchCatalog,
  fetchCatalogItem,
  fetchOpenOrders,
  fetchOwners,
  fetchSales,
  isBatchableSource,
  type CatalogItem,
  type CatalogQuery,
  type MarketplaceOrder
} from './marketplaceApi'
import { checkoutBatchableCart, type CartLine } from './marketplaceCheckout'

export type InWorldMarketplacePanelOptions = {
  getSession: () => SessionIdentity
  onClose?: () => void
}

const PAGE = 24
const RARITIES = ['unique', 'mythic', 'exotic', 'legendary', 'epic', 'rare', 'uncommon', 'common']
const WEARABLE_CATS = [
  'hat',
  'helmet',
  'mask',
  'eyewear',
  'earring',
  'tiara',
  'upper_body',
  'lower_body',
  'feet',
  'hands_wear',
  'skin'
]

const RARITY_CLASS: Record<string, string> = {
  unique: 'rarity-unique',
  mythic: 'rarity-mythic',
  exotic: 'rarity-exotic',
  legendary: 'rarity-legendary',
  epic: 'rarity-epic',
  rare: 'rarity-rare',
  uncommon: 'rarity-uncommon',
  common: 'rarity-common'
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function rarityClass(r: string): string {
  return RARITY_CLASS[r.toLowerCase()] ?? ''
}

type Layer = 'browse' | 'filters' | 'item' | 'cart'

export class InWorldMarketplacePanel {
  readonly element: HTMLDivElement
  private visible = false
  private layer: Layer = 'browse'
  private items: CatalogItem[] = []
  private total = 0
  private loading = false
  private skip = 0
  private query: CatalogQuery = { category: 'wearable', isOnSale: true, sortBy: 'newest' }
  private search = ''
  private rarities = new Set<string>()
  private wearableCategory = ''
  private detail: CatalogItem | null = null
  private detailTab: 'overview' | 'listings' | 'owners' | 'sales' = 'overview'
  private preview3d = false
  private orders: MarketplaceOrder[] = []
  private sales: { type?: string; price: string; buyer?: string; tokenId?: string }[] = []
  private owners: { tokenId: string; owner: string }[] = []
  private cart: CartLine[] = []
  private status = ''
  private readonly onKey: (ev: KeyboardEvent) => void

  constructor(private readonly options: InWorldMarketplacePanelOptions) {
    this.element = document.createElement('div')
    this.element.className = 'iwm-panel'
    this.element.hidden = true
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-label', 'Marketplace')
    this.element.innerHTML = this.shell()
    this.bind()
    this.onKey = (ev) => {
      if (ev.key === 'Escape' && this.visible) this.hide()
    }
    document.body.appendChild(this.element)
  }

  isVisible(): boolean {
    return this.visible
  }

  toggle(): void {
    if (this.visible) this.hide()
    else void this.show()
  }

  async show(): Promise<void> {
    this.visible = true
    this.element.hidden = false
    window.addEventListener('keydown', this.onKey)
    if (this.items.length === 0) await this.reload()
    else this.render()
  }

  hide(): void {
    this.visible = false
    this.element.hidden = true
    window.removeEventListener('keydown', this.onKey)
    this.options.onClose?.()
  }

  dispose(): void {
    this.hide()
    this.element.remove()
  }

  private shell(): string {
    return `
      <header class="iwm-hd">
        <h1>MARKETPLACE</h1>
        <button type="button" class="iwm-cart-btn" data-iwm="cart" title="Cart" aria-label="Cart">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6h15l-1.5 9h-12L5 3H2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="20" r="1.4" fill="currentColor"/><circle cx="18" cy="20" r="1.4" fill="currentColor"/></svg>
          <span class="iwm-cart-badge" data-iwm-badge hidden>0</span>
        </button>
        <button type="button" class="iwm-icon-btn" data-iwm="filters" title="Filters">☰</button>
        <button type="button" class="iwm-icon-btn" data-iwm="close" aria-label="Close">×</button>
      </header>
      <div class="iwm-body" data-iwm-body></div>
    `
  }

  private bind(): void {
    this.element.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement | null
      if (!t) return
      if (t.closest('[data-iwm="close"]')) {
        this.hide()
        return
      }
      if (t.closest('[data-iwm="cart"]')) {
        this.layer = this.layer === 'cart' ? 'browse' : 'cart'
        this.render()
        return
      }
      if (t.closest('[data-iwm="filters"]')) {
        this.layer = this.layer === 'filters' ? 'browse' : 'filters'
        this.render()
        return
      }
      if (t.closest('[data-iwm="back"]')) {
        this.layer = 'browse'
        this.render()
        return
      }
      const tab = t.closest('[data-cat]') as HTMLElement | null
      if (tab?.dataset.cat) {
        this.query.category = tab.dataset.cat as 'wearable' | 'emote'
        void this.reload()
        return
      }
      const card = t.closest('[data-item]') as HTMLElement | null
      if (card?.dataset.item) {
        void this.openItem(card.dataset.item)
        return
      }
      if (t.closest('[data-add]')) {
        ev.stopPropagation()
        if (this.detail) this.addToCart(this.detail)
        return
      }
      if (t.closest('[data-preview]')) {
        const mode = (t.closest('[data-preview]') as HTMLElement).dataset.preview
        this.preview3d = mode === '3d'
        this.render()
        return
      }
      const dtab = t.closest('[data-dtab]') as HTMLElement | null
      if (dtab?.dataset.dtab) {
        this.detailTab = dtab.dataset.dtab as 'overview' | 'listings' | 'owners' | 'sales'
        this.render()
        return
      }
      const rm = t.closest('[data-rm]') as HTMLElement | null
      if (rm?.dataset.rm) {
        this.cart = this.cart.filter((l) => l.key !== rm.dataset.rm)
        this.render()
        return
      }
      if (t.closest('[data-buy-cart]')) {
        void this.buyCart()
        return
      }
      const rar = t.closest('[data-rar]') as HTMLElement | null
      if (rar?.dataset.rar) {
        if (this.rarities.has(rar.dataset.rar)) this.rarities.delete(rar.dataset.rar)
        else this.rarities.add(rar.dataset.rar)
        this.render()
        return
      }
      const wcat = t.closest('[data-wcat]') as HTMLElement | null
      if (wcat?.dataset.wcat) {
        this.wearableCategory = this.wearableCategory === wcat.dataset.wcat ? '' : wcat.dataset.wcat
        this.render()
        return
      }
      if (t.closest('[data-apply-filters]')) {
        this.query.rarities = [...this.rarities]
        this.query.wearableCategory = this.wearableCategory || undefined
        this.layer = 'browse'
        void this.reload()
        return
      }
      if (t.closest('[data-clear-filters]')) {
        this.rarities.clear()
        this.wearableCategory = ''
        this.query.rarities = []
        this.query.wearableCategory = undefined
        this.render()
        return
      }
    })
    this.element.addEventListener('change', (ev) => {
      const t = ev.target as HTMLSelectElement | HTMLInputElement | null
      if (!t) return
      if (t.name === 'sort') {
        this.query.sortBy = t.value
        void this.reload()
      }
      if (t.name === 'onsale') {
        this.query.isOnSale = (t as HTMLInputElement).checked
      }
    })
    this.element.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement | null
      if (!t) return
      if (t.name === 'search') {
        this.search = t.value
      }
      if (t.name === 'beneficiary') this.renderBadgeOnly()
    })
    this.element.addEventListener('keydown', (ev) => {
      const t = ev.target as HTMLInputElement | null
      if (ev.key === 'Enter' && t?.name === 'search') {
        this.query.search = this.search
        void this.reload()
      }
    })
    this.element.addEventListener('scroll', (ev) => {
      const body = ev.target as HTMLElement
      if (!body.classList.contains('iwm-grid')) return
      if (this.loading || this.items.length >= this.total) return
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 80) void this.loadMore()
    }, true)
  }

  private sessionAddr(): string {
    return (this.options.getSession().getAddress() || '').toLowerCase()
  }

  private async reload(): Promise<void> {
    this.skip = 0
    this.loading = true
    this.status = ''
    this.render()
    try {
      const { items, total } = await fetchCatalog({ ...this.query, search: this.search, first: PAGE, skip: 0 })
      this.items = items
      this.total = total
    } catch (err) {
      this.status = err instanceof Error ? err.message : 'Failed to load catalog'
    } finally {
      this.loading = false
      this.render()
    }
  }

  private async loadMore(): Promise<void> {
    this.loading = true
    this.skip += PAGE
    try {
      const { items, total } = await fetchCatalog({ ...this.query, search: this.search, first: PAGE, skip: this.skip })
      this.items = [...this.items, ...items]
      this.total = total
    } catch {
      this.skip -= PAGE
    } finally {
      this.loading = false
      this.render()
    }
  }

  private async openItem(id: string): Promise<void> {
    const fromGrid = this.items.find((i) => i.id === id)
    this.detail = fromGrid ?? null
    this.detailTab = 'overview'
    this.preview3d = false
    this.layer = 'item'
    this.render()
    if (!this.detail) return
    const [full, orders, sales, owners] = await Promise.all([
      fetchCatalogItem(this.detail.contractAddress, this.detail.itemId),
      fetchOpenOrders(this.detail.contractAddress, this.detail.itemId),
      fetchSales(this.detail.contractAddress, this.detail.itemId),
      fetchOwners(this.detail.contractAddress, this.detail.itemId)
    ])
    if (full) this.detail = { ...this.detail, ...full }
    this.orders = orders
    this.sales = sales
    this.owners = owners
    if (this.layer === 'item') this.render()
  }

  private addToCart(item: CatalogItem): void {
    const key = `${item.contractAddress}:${item.itemId}`
    if (this.cart.some((l) => l.key === key)) {
      this.status = 'Already in cart'
      this.render()
      return
    }
    const source = classifyCartSource(item, this.orders[0] ?? null)
    this.cart.push({
      key,
      item,
      source,
      tradeId: item.tradeId ?? this.orders.find((o) => o.tradeId)?.tradeId ?? null
    })
    this.status = 'Added to cart'
    this.render()
  }

  private liveCart(): CartLine[] {
    return this.cart.filter((l) => isBatchableSource(l.source))
  }

  private liveTotalWei(): bigint {
    return this.liveCart().reduce((s, l) => s + BigInt(l.item.price || '0'), 0n)
  }

  private async buyCart(): Promise<void> {
    const addr = (this.element.querySelector('[name="beneficiary"]') as HTMLInputElement | null)?.value.trim() ?? ''
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      this.status = 'Enter a valid 0x wallet'
      this.render()
      return
    }
    const session = this.options.getSession()
    const sessionAddress = this.sessionAddr()
    if (!sessionAddress) {
      this.status = 'Sign in to buy'
      this.render()
      return
    }
    this.status = 'Checking out…'
    this.render()
    try {
      await checkoutBatchableCart({
        lines: this.liveCart(),
        beneficiary: addr.toLowerCase() as Address,
        sessionAddress,
        isGuest: session.isGuest(),
        note: (m) => {
          this.status = m
          this.render()
        }
      })
      const bought = new Set(this.liveCart().map((l) => l.key))
      this.cart = this.cart.filter((l) => !bought.has(l.key))
      this.status = 'Purchase complete'
      this.render()
    } catch (err) {
      this.status = err instanceof Error ? err.message : 'Checkout failed'
      this.render()
    }
  }

  private renderBadgeOnly(): void {
    const badge = this.element.querySelector('[data-iwm-badge]') as HTMLElement | null
    if (!badge) return
    badge.hidden = this.cart.length === 0
    badge.textContent = String(this.cart.length)
  }

  private render(): void {
    const body = this.element.querySelector('[data-iwm-body]')
    if (!body) return
    const cartBtn = this.element.querySelector('[data-iwm="cart"]') as HTMLElement | null
    cartBtn?.classList.toggle('is-on', this.layer === 'cart')
    this.renderBadgeOnly()
    if (this.layer === 'filters') body.innerHTML = this.filtersHtml()
    else if (this.layer === 'item' && this.detail) body.innerHTML = this.itemHtml(this.detail)
    else if (this.layer === 'cart') body.innerHTML = this.cartHtml()
    else body.innerHTML = this.browseHtml()
  }

  private browseHtml(): string {
    const cards = this.items
      .map((it) => {
        const rc = rarityClass(it.rarity)
        const price = it.price && it.price !== '0' ? `${esc(formatMana(it.price))} MANA` : '—'
        const stock = `${it.available}`
        return `<button type="button" class="iwm-card ${rc}" data-item="${esc(it.id)}">
          <div class="iwm-card__img" style="background-image:url('${esc(it.thumbnail)}')"></div>
          <div class="iwm-card__body">
            <div class="iwm-card__name">${esc(it.name)}</div>
            <div class="iwm-card__meta"><span>${price}</span><span>${esc(stock)}</span></div>
          </div>
        </button>`
      })
      .join('')
    const more = this.loading
      ? '<div class="iwm-more">Loading…</div>'
      : this.items.length < this.total
        ? '<div class="iwm-more">Scroll for more</div>'
        : ''
    return `
      <div class="iwm-search"><input name="search" type="search" placeholder="Search wearables, emotes, creators…" value="${esc(this.search)}" /></div>
      <div class="iwm-tabs">
        <button type="button" data-cat="wearable" class="${this.query.category !== 'emote' ? 'is-on' : ''}">Wearables</button>
        <button type="button" data-cat="emote" class="${this.query.category === 'emote' ? 'is-on' : ''}">Emotes</button>
      </div>
      <div class="iwm-toolbar">
        <select name="sort">
          <option value="newest" ${this.query.sortBy === 'newest' ? 'selected' : ''}>Newest</option>
          <option value="cheapest" ${this.query.sortBy === 'cheapest' ? 'selected' : ''}>Cheapest</option>
          <option value="recently_listed" ${this.query.sortBy === 'recently_listed' ? 'selected' : ''}>Recently listed</option>
        </select>
        <span class="iwm-count">${this.total.toLocaleString()} results</span>
      </div>
      ${this.status ? `<div class="iwm-status">${esc(this.status)}</div>` : ''}
      <div class="iwm-grid">${cards}${more}</div>
    `
  }

  private filtersHtml(): string {
    const rar = RARITIES.map(
      (r) =>
        `<button type="button" data-rar="${r}" class="${this.rarities.has(r) ? 'is-on' : ''}">${esc(r)}</button>`
    ).join('')
    const cats = WEARABLE_CATS.map(
      (c) =>
        `<button type="button" data-wcat="${c}" class="${this.wearableCategory === c ? 'is-on' : ''}">${esc(c.replace('_', ' '))}</button>`
    ).join('')
    return `
      <div class="iwm-layer-bar"><button type="button" class="iwm-icon-btn" data-iwm="back">←</button><h2>Filters</h2></div>
      <div class="iwm-layer-body">
        <label class="iwm-toggle">On sale <input type="checkbox" name="onsale" ${this.query.isOnSale !== false ? 'checked' : ''} /></label>
        <h3>Rarity</h3>
        <div class="iwm-pills">${rar}</div>
        <h3>Category</h3>
        <div class="iwm-pills">${cats}</div>
      </div>
      <div class="iwm-layer-foot">
        <button type="button" class="iwm-buy" data-apply-filters>Apply filters</button>
        <button type="button" class="iwm-ghost" data-clear-filters>Clear all</button>
      </div>
    `
  }

  private itemHtml(it: CatalogItem): string {
    const rc = rarityClass(it.rarity)
    const slot = it.data?.wearable?.category ?? it.category
    const desc = it.data?.wearable?.description || it.data?.emote?.description || ''
    const price = `${esc(formatMana(it.price))} MANA`
    const urn = it.urn ?? `urn:decentraland:matic:collections-v2:${it.contractAddress}:${it.itemId}`
    const preview = this.preview3d
      ? `<iframe class="iwm-hero-frame" src="https://wearable-preview.decentraland.org/?urn=${encodeURIComponent(urn)}&background=0e0a18" title="Wearable preview" allow="autoplay"></iframe>`
      : `<img src="${esc(it.thumbnail)}" alt="${esc(it.name)}" />`
    const fav = it.picks?.count ?? 0
    return `
      <div class="iwm-layer-bar"><button type="button" class="iwm-icon-btn" data-iwm="back">←</button><h2>Details</h2></div>
      <div class="iwm-layer-body">
        <div class="iwm-hero ${rc}">
          ${preview}
          <div class="iwm-hero-tools">
            <span class="iwm-fav">♡ ${fav}</span>
            <div class="iwm-mode">
              <button type="button" data-preview="img" class="${this.preview3d ? '' : 'is-on'}">Image</button>
              <button type="button" data-preview="3d" class="${this.preview3d ? 'is-on' : ''}">3D</button>
            </div>
          </div>
        </div>
        <h3 class="iwm-title">${esc(it.name)}</h3>
        <div class="iwm-badges">
          <span class="iwm-badge ${rc}">${esc(it.rarity)}</span>
          <span class="iwm-badge">${esc(slot.replace('_', ' '))}</span>
          <span class="iwm-badge">${esc(it.network || 'MATIC')}</span>
        </div>
        <div class="iwm-who">
          <div><small>Creator</small><b>${esc(shortAddr(it.creator))}</b></div>
          <div><small>Collection</small><b>${esc(it.collectionName || 'Collection')}</b></div>
        </div>
        <div class="iwm-pricebox">
          <div><small>Price</small><strong>${price}</strong></div>
          <div><small>Available</small><strong>${esc(String(it.available))}</strong></div>
        </div>
        <div class="iwm-dtabs">
          <button type="button" data-dtab="overview" class="${this.detailTab === 'overview' ? 'is-on' : ''}">Overview</button>
          <button type="button" data-dtab="listings" class="${this.detailTab === 'listings' ? 'is-on' : ''}">Listings</button>
          <button type="button" data-dtab="owners" class="${this.detailTab === 'owners' ? 'is-on' : ''}">Owners</button>
          <button type="button" data-dtab="sales" class="${this.detailTab === 'sales' ? 'is-on' : ''}">Sales</button>
        </div>
        ${this.detailPane(it, desc)}
        ${this.status ? `<div class="iwm-status">${esc(this.status)}</div>` : ''}
      </div>
      <div class="iwm-layer-foot">
        <button type="button" class="iwm-buy" data-add>Add to cart · ${price}</button>
      </div>
    `
  }

  private detailPane(it: CatalogItem, desc: string): string {
    if (this.detailTab === 'listings') {
      const rows = this.orders.length
        ? this.orders
            .map(
              (o) =>
                `<div class="iwm-row"><div><b>Token #${esc(o.tokenId)}</b><small>${esc(shortAddr(o.owner))}</small></div><div>${esc(formatMana(o.price))} MANA</div></div>`
            )
            .join('')
        : '<p class="iwm-muted">No secondary listings. Store mint is available if in stock.</p>'
      return `<div class="iwm-pane">${rows}</div>`
    }
    if (this.detailTab === 'owners') {
      const rows = this.owners
        .map((o) => `<div class="iwm-row"><div><b>${esc(shortAddr(o.owner))}</b><small>#${esc(o.tokenId)}</small></div></div>`)
        .join('')
      return `<div class="iwm-pane">${rows || '<p class="iwm-muted">No owners indexed yet.</p>'}</div>`
    }
    if (this.detailTab === 'sales') {
      const rows = this.sales
        .map(
          (s) =>
            `<div class="iwm-row"><div><b>${esc(s.type || 'sale')}</b><small>${esc(shortAddr(s.buyer))} · #${esc(s.tokenId || '')}</small></div><div>${esc(formatMana(s.price))} MANA</div></div>`
        )
        .join('')
      return `<div class="iwm-pane">${rows || '<p class="iwm-muted">No sales yet.</p>'}</div>`
    }
    void it
    return `<div class="iwm-pane"><p class="iwm-muted">${desc ? esc(desc) : 'No description from the creator.'}</p></div>`
  }

  private cartHtml(): string {
    const me = this.sessionAddr()
    const rows = this.cart
      .map((l) => {
        const off = !isBatchableSource(l.source)
        const price = `${esc(formatMana(l.item.price))} MANA`
        return `<div class="iwm-cart-line ${off ? 'is-off' : ''} ${rarityClass(l.item.rarity)}">
          <img src="${esc(l.item.thumbnail)}" alt="" />
          <div>
            <b>${esc(l.item.name)}</b>
            <small>${off ? "Can't include in this checkout" : l.source === 'store' ? 'Store mint' : 'Listing'}</small>
            ${off ? '<span class="iwm-note-off">Open on Marketplace</span>' : `<button type="button" class="iwm-rm" data-rm="${esc(l.key)}">Remove</button>`}
          </div>
          <div class="iwm-mana">${price}</div>
        </div>`
      })
      .join('')
    const live = this.liveCart()
    const total = formatMana(this.liveTotalWei())
    const you = me ? ` (you)` : ''
    return `
      <div class="iwm-layer-bar"><button type="button" class="iwm-icon-btn" data-iwm="back">←</button><h2>Cart</h2></div>
      <div class="iwm-layer-body">${rows || '<p class="iwm-muted">Cart is empty.</p>'}</div>
      <div class="iwm-layer-foot">
        <div class="iwm-label">Beneficiary<span data-you-tag>${you}</span></div>
        <div class="iwm-ben"><input name="beneficiary" spellcheck="false" value="${esc(me)}" placeholder="0x…" /></div>
        ${this.status ? `<div class="iwm-status">${esc(this.status)}</div>` : ''}
        <div class="iwm-summary">${live.length} item${live.length === 1 ? '' : 's'} · ${esc(total)} MANA from you</div>
        <button type="button" class="iwm-buy" data-buy-cart ${live.length === 0 ? 'disabled' : ''}>Buy ${live.length} item${live.length === 1 ? '' : 's'} · ${esc(total)} MANA</button>
      </div>
    `
  }
}
