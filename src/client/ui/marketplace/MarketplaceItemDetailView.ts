import {
  escapeHtml,
  formatBodyShapes,
  formatMana,
  formatRelativeTime,
  formatSaleType,
  itemRefFromMarketplaceItem,
  loadItemDetail,
  rarityClass,
  shortCreator,
  type MarketplaceItem,
  type MarketplaceItemDetailData,
  type MarketplaceListing,
  type MarketplaceOffer,
  type MarketplaceOwnerRow,
  type MarketplaceSale
} from '../../../marketplace'
import { MarketplaceRail } from './components/MarketplaceRail'

export type MarketplaceItemDetailViewOptions = {
  contractAddress: string
  itemId: string
  onBack: () => void
  onOpenItem: (item: MarketplaceItem) => void
}

type PanelTab = 'description' | 'listings' | 'owners' | 'offers' | 'sales'

function formatCategoryLabel(category: string): string {
  const c = category.trim()
  if (!c) return ''
  return c
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function creatorAvatarHtml(address: string | null): string {
  if (!address) {
    return `<span class="marketplace-item-panel__avatar marketplace-item-panel__avatar--empty" aria-hidden="true"></span>`
  }
  const a = address.toLowerCase()
  // Stable hue from address
  let h = 0
  for (let i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0
  const hue = h % 360
  const initials = a.slice(2, 4).toUpperCase()
  return `<span class="marketplace-item-panel__avatar" style="--avatar-hue:${hue}" aria-hidden="true">${escapeHtml(initials)}</span>`
}

/**
 * Asset detail — stage | glass card (mockup #1), collection strip in stage footer.
 */
export class MarketplaceItemDetailView {
  readonly root: HTMLElement

  private readonly contentEl: HTMLElement
  private readonly moreRail: MarketplaceRail
  private data: MarketplaceItemDetailData | null = null
  private panelTab: PanelTab = 'description'
  private loadSeq = 0
  private disposed = false

  constructor(private readonly opts: MarketplaceItemDetailViewOptions) {
    this.root = document.createElement('div')
    this.root.className = 'marketplace-item-detail'

    this.contentEl = document.createElement('div')
    this.contentEl.className = 'marketplace-item-detail__content'

    this.moreRail = new MarketplaceRail({
      title: 'More from collection',
      items: [],
      loading: true,
      onSelect: (item) => this.opts.onOpenItem(item),
      onBuyStub: (item) => this.onBuyStub(item)
    })
    this.moreRail.root.classList.add('marketplace-rail--stage-footer')

    this.root.appendChild(this.contentEl)
  }

  mount(): void {
    void this.reload()
  }

  dispose(): void {
    this.disposed = true
    this.moreRail.root.remove()
    this.root.remove()
  }

  private async reload(): Promise<void> {
    const seq = ++this.loadSeq
    this.renderLoading()

    try {
      const data = await loadItemDetail(this.opts.contractAddress, this.opts.itemId)
      if (seq !== this.loadSeq || this.disposed) return
      this.data = data
      this.panelTab = 'description'
      this.renderDetail()
      this.moreRail.setOptions({
        items: data.moreFromCollection,
        loading: false,
        emptyMessage: 'No other items in this collection',
        onSelect: (item) => this.opts.onOpenItem(item),
        onBuyStub: (item) => this.onBuyStub(item)
      })
      this.mountStageCollection()
    } catch (err) {
      if (seq !== this.loadSeq || this.disposed) return
      this.data = null
      this.renderError(err instanceof Error ? err.message : 'Could not load this item')
    }
  }

  private mountStageCollection(): void {
    const mount = this.contentEl.querySelector('[data-stage-collection]')
    if (!mount) return
    mount.replaceChildren()
    mount.appendChild(this.moreRail.root)
  }

  private renderLoading(): void {
    this.contentEl.innerHTML = `
      <button type="button" class="marketplace-item-detail__back" data-back>← Back</button>
      <div class="marketplace-item-detail__hero marketplace-item-detail__hero--loading">
        <div class="marketplace-item-stage marketplace-item-stage--skeleton" aria-hidden="true"></div>
        <div class="marketplace-item-detail__side">
          <div class="marketplace-item-panel marketplace-item-panel--skeleton" aria-hidden="true"></div>
          <div class="marketplace-item-info marketplace-item-info--skeleton" aria-hidden="true"></div>
        </div>
      </div>
    `
    this.bindBack()
  }

  private renderError(message: string): void {
    this.contentEl.innerHTML = `
      <button type="button" class="marketplace-item-detail__back" data-back>← Back</button>
      <div class="marketplace-item-detail__error">
        <p class="marketplace-item-detail__error-title">Item unavailable</p>
        <p class="marketplace-item-detail__error-body">${escapeHtml(message)}</p>
        <button type="button" class="marketplace-item-detail__cta marketplace-item-detail__cta--primary" data-back>
          Back to Discover
        </button>
      </div>
    `
    this.bindBack()
  }

  private renderDetail(): void {
    const item = this.data?.item
    if (!item) return

    const rarity = String(item.rarity || 'common').toLowerCase()
    const shapes = formatBodyShapes(item.bodyShapes)
    const categoryLabel = formatCategoryLabel(item.category)
    const stock =
      item.available != null
        ? `<span class="marketplace-item-panel__stock">${escapeHtml(String(item.available))} left</span>`
        : ''
    const thumb = item.thumbnail
      ? `<img class="marketplace-item-stage__art" src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.name)}" />`
      : `<div class="marketplace-item-stage__art-ph" aria-hidden="true"></div>`

    const nList = this.data?.listings.length ?? 0
    const nOwn = this.data?.owners.length ?? 0
    const nOff = this.data?.offers.length ?? 0
    const nSales = this.data?.sales.length ?? 0

    const chips: string[] = []
    if (shapes) chips.push(`<span class="marketplace-item-panel__chip">${escapeHtml(shapes)}</span>`)
    if (categoryLabel)
      chips.push(`<span class="marketplace-item-panel__chip">${escapeHtml(categoryLabel)}</span>`)
    if (item.isSmart) chips.push(`<span class="marketplace-item-panel__chip">Smart</span>`)

    this.contentEl.innerHTML = `
      <button type="button" class="marketplace-item-detail__back" data-back>← Back</button>
      <div class="marketplace-item-detail__hero">
        <section class="marketplace-item-stage" aria-label="Item preview">
          <div class="marketplace-item-stage__main">
            <div class="marketplace-item-stage__glow" aria-hidden="true"></div>
            <div class="marketplace-item-stage__beams" aria-hidden="true"></div>
            <div class="marketplace-item-stage__pedestal" aria-hidden="true"></div>
            ${thumb}
          </div>
          <div class="marketplace-item-stage__collection" data-stage-collection></div>
        </section>

        <div class="marketplace-item-detail__side">
          <section class="marketplace-item-panel" aria-label="Purchase">
            <h1 class="marketplace-item-panel__title">${escapeHtml(item.name)}</h1>
            ${
              item.creator
                ? `<div class="marketplace-item-panel__by">
                    ${creatorAvatarHtml(item.creator)}
                    <p class="marketplace-item-panel__creator">by <span>${escapeHtml(shortCreator(item.creator, 12))}</span></p>
                  </div>`
                : ''
            }

            <div class="marketplace-item-panel__rarity-row">
              <span class="marketplace-item-panel__rarity ${rarityClass(rarity)}">${escapeHtml(rarity)}</span>
              ${chips.join('')}
            </div>

            <div class="marketplace-item-panel__price-block">
              <p class="marketplace-item-panel__price">
                <span class="marketplace-item-panel__mana-icon" aria-hidden="true">◆</span>
                ${escapeHtml(formatMana(item.priceMana))}
                <span class="marketplace-item-panel__mana-unit">MANA</span>
              </p>
              ${stock}
            </div>

            <div class="marketplace-item-panel__actions">
              <button type="button" class="marketplace-item-detail__cta marketplace-item-detail__cta--primary" data-buy>
                Buy now
              </button>
              <button type="button" class="marketplace-item-detail__cta marketplace-item-detail__cta--ghost" data-offer>
                Make offer
              </button>
            </div>
          </section>

          <section class="marketplace-item-info" aria-label="Item information">
            <div class="marketplace-item-info__tabs" role="tablist">
              <button type="button" class="marketplace-item-info__tab" role="tab" data-ptab="description">Description</button>
              <button type="button" class="marketplace-item-info__tab" role="tab" data-ptab="listings">
                Listings${nList ? ` <span>${nList}</span>` : ''}
              </button>
              <button type="button" class="marketplace-item-info__tab" role="tab" data-ptab="owners">
                Owners${nOwn ? ` <span>${nOwn}</span>` : ''}
              </button>
              <button type="button" class="marketplace-item-info__tab" role="tab" data-ptab="offers">
                Offers${nOff ? ` <span>${nOff}</span>` : ''}
              </button>
              <button type="button" class="marketplace-item-info__tab" role="tab" data-ptab="sales">
                Sales${nSales ? ` <span>${nSales}</span>` : ''}
              </button>
            </div>
            <div class="marketplace-item-info__body" data-panel-body></div>
          </section>
        </div>
      </div>
    `

    const img = this.contentEl.querySelector('.marketplace-item-stage__art') as HTMLImageElement | null
    img?.addEventListener('error', () => {
      img.replaceWith(
        Object.assign(document.createElement('div'), {
          className: 'marketplace-item-stage__art-ph',
          ariaHidden: 'true'
        })
      )
    })

    this.bindBack()
    this.contentEl.querySelector('[data-buy]')?.addEventListener('click', () => this.onBuyStub(item))
    this.contentEl.querySelector('[data-offer]')?.addEventListener('click', () => {
      console.info('[marketplace] Make offer not implemented yet', { id: item.id, name: item.name })
    })

    for (const btn of this.contentEl.querySelectorAll<HTMLButtonElement>('[data-ptab]')) {
      btn.addEventListener('click', () => {
        const t = btn.dataset.ptab as PanelTab
        if (
          t === 'description' ||
          t === 'listings' ||
          t === 'owners' ||
          t === 'offers' ||
          t === 'sales'
        ) {
          this.panelTab = t
          this.syncPanelTabs()
        }
      })
    }
    this.syncPanelTabs()
  }

  private syncPanelTabs(): void {
    for (const btn of this.contentEl.querySelectorAll<HTMLButtonElement>('[data-ptab]')) {
      const active = btn.dataset.ptab === this.panelTab
      btn.classList.toggle('marketplace-item-info__tab--active', active)
      btn.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    const body = this.contentEl.querySelector('[data-panel-body]')
    if (!body || !this.data) return

    switch (this.panelTab) {
      case 'description':
        body.innerHTML = this.descriptionHtml(this.data.item)
        break
      case 'listings':
        body.innerHTML = this.listingsHtml(this.data.listings)
        break
      case 'owners':
        body.innerHTML = this.ownersHtml(this.data.owners)
        break
      case 'offers':
        body.innerHTML = this.offersHtml(this.data.offers)
        break
      case 'sales':
        body.innerHTML = this.salesHtml(this.data.sales)
        break
    }
  }

  private descriptionHtml(item: MarketplaceItem): string {
    const desc = item.description?.trim()
    if (desc) return `<p class="marketplace-item-info__desc">${escapeHtml(desc)}</p>`
    return `<p class="marketplace-item-info__desc marketplace-item-info__desc--muted">No description for this item.</p>`
  }

  private emptyHtml(message: string): string {
    return `<p class="marketplace-item-info__empty">${escapeHtml(message)}</p>`
  }

  private listingsHtml(listings: MarketplaceListing[]): string {
    if (!listings.length) return this.emptyHtml('No open listings right now.')
    const rows = listings
      .map(
        (l) => `
      <tr>
        <td><span class="marketplace-item-info__mono">${escapeHtml(shortCreator(l.owner, 10))}</span></td>
        <td>#${escapeHtml(l.issuedId ?? l.tokenId ?? '—')}</td>
        <td class="marketplace-item-info__td-price">◆ ${escapeHtml(formatMana(l.priceMana))}</td>
        <td>${escapeHtml(l.expiresAt ? formatRelativeTime(l.expiresAt) : '—')}</td>
      </tr>`
      )
      .join('')
    return `
      <div class="marketplace-item-info__scroll">
        <table class="marketplace-item-info__table">
          <thead>
            <tr><th>Owner</th><th>Issue</th><th>Price</th><th>Expires</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
  }

  private ownersHtml(owners: MarketplaceOwnerRow[]): string {
    if (!owners.length) return this.emptyHtml('No owners loaded yet.')
    const rows = owners
      .map(
        (o) => `
      <tr>
        <td><span class="marketplace-item-info__mono">${escapeHtml(shortCreator(o.owner, 10))}</span></td>
        <td>#${escapeHtml(o.issuedId ?? o.tokenId ?? '—')}</td>
        <td>${o.hasActiveOrder ? '<span class="marketplace-item-info__pill">Listed</span>' : '—'}</td>
      </tr>`
      )
      .join('')
    return `
      <div class="marketplace-item-info__scroll">
        <table class="marketplace-item-info__table">
          <thead>
            <tr><th>Owner</th><th>Issue</th><th>Status</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
  }

  private offersHtml(offers: MarketplaceOffer[]): string {
    if (!offers.length) return this.emptyHtml('No open offers on this item.')
    const rows = offers
      .map(
        (o) => `
      <tr>
        <td><span class="marketplace-item-info__mono">${escapeHtml(shortCreator(o.bidder, 10))}</span></td>
        <td class="marketplace-item-info__td-price">◆ ${escapeHtml(formatMana(o.priceMana))}</td>
        <td>${escapeHtml(o.expiresAt ? formatRelativeTime(o.expiresAt) : '—')}</td>
      </tr>`
      )
      .join('')
    return `
      <div class="marketplace-item-info__scroll">
        <table class="marketplace-item-info__table">
          <thead>
            <tr><th>Bidder</th><th>Offer</th><th>Expires</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
  }

  private salesHtml(sales: MarketplaceSale[]): string {
    if (!sales.length) return this.emptyHtml('No recent sales.')
    const rows = sales
      .map(
        (s) => `
      <tr>
        <td>${escapeHtml(formatSaleType(s.type))}</td>
        <td class="marketplace-item-info__td-price">◆ ${escapeHtml(formatMana(s.priceMana))}</td>
        <td>
          <span class="marketplace-item-info__mono">${escapeHtml(shortCreator(s.seller))}</span>
          →
          <span class="marketplace-item-info__mono">${escapeHtml(shortCreator(s.buyer))}</span>
        </td>
        <td>${escapeHtml(formatRelativeTime(s.timestamp))}</td>
      </tr>`
      )
      .join('')
    return `
      <div class="marketplace-item-info__scroll">
        <table class="marketplace-item-info__table">
          <thead>
            <tr><th>Type</th><th>Price</th><th>From → To</th><th>When</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
  }

  private bindBack(): void {
    for (const el of this.contentEl.querySelectorAll('[data-back]')) {
      el.addEventListener('click', () => this.opts.onBack())
    }
  }

  private onBuyStub(item: MarketplaceItem): void {
    console.info('[marketplace] Buy not implemented yet', {
      id: item.id,
      name: item.name,
      priceMana: item.priceMana,
      ref: itemRefFromMarketplaceItem(item)
    })
  }
}
