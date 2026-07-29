import { escapeHtml, formatMana, shortCreator } from '../../../marketplace/format'
import {
  fetchLandByToken,
  fetchLandPage,
  type LandListing
} from '../../../marketplace/landApi'
import { VIEWPORT_MAX_ZOOM } from '../../../map/genesisMapViewport'
import { LandMapCanvas } from './LandMapCanvas'

export type LandDetailViewOptions = {
  contractAddress: string
  tokenId: string
  onBack: () => void
  onOpenLand: (listing: LandListing) => void
  onJumpInParcel?: (px: number, py: number) => void
}

type InfoTab = 'description' | 'parcels' | 'nearby'

function creatorAvatarHtml(address: string | null): string {
  if (!address) {
    return `<span class="marketplace-item-panel__avatar marketplace-item-panel__avatar--empty" aria-hidden="true"></span>`
  }
  const a = address.toLowerCase()
  let h = 0
  for (let i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0
  const hue = h % 360
  const initials = a.slice(2, 4).toUpperCase()
  return `<span class="marketplace-item-panel__avatar" style="--avatar-hue:${hue}" aria-hidden="true">${escapeHtml(initials)}</span>`
}

/**
 * Land NFT detail — same 2-card column pattern as wearable detail.
 * Left stage: full-bleed Genesis satellite map (same tiles as Land map), zoomed on parcel.
 * Route: `/marketplace/contracts/:addr/tokens/:tokenId`
 */
export class LandDetailView {
  readonly root: HTMLElement
  private readonly contentEl: HTMLElement
  private listing: LandListing | null = null
  private nearby: LandListing[] = []
  private tab: InfoTab = 'description'
  private loadSeq = 0
  private disposed = false
  private mapCanvas: LandMapCanvas | null = null

  constructor(private readonly opts: LandDetailViewOptions) {
    this.root = document.createElement('div')
    this.root.className = 'marketplace-item-detail land-detail'
    this.contentEl = document.createElement('div')
    this.contentEl.className = 'marketplace-item-detail__content'
    this.root.appendChild(this.contentEl)
  }

  mount(): void {
    void this.reload()
  }

  dispose(): void {
    this.disposed = true
    this.disposeMap()
    this.root.remove()
  }

  private disposeMap(): void {
    this.mapCanvas?.dispose()
    this.mapCanvas = null
  }

  private async reload(): Promise<void> {
    const seq = ++this.loadSeq
    this.disposeMap()
    this.renderLoading()
    try {
      const listing = await fetchLandByToken(this.opts.contractAddress, this.opts.tokenId)
      if (seq !== this.loadSeq || this.disposed) return
      if (!listing) throw new Error('Land listing not found')
      this.listing = listing
      this.tab = 'description'
      this.renderDetail()
      // Nearby for-sale (same kind)
      void fetchLandPage({
        kind: listing.kind,
        isOnSale: true,
        orderBy: 'cheapest',
        first: 12
      })
        .then((page) => {
          if (seq !== this.loadSeq || this.disposed) return
          this.nearby = page.listings.filter((L) => L.id !== listing.id).slice(0, 8)
          this.syncTabs()
        })
        .catch(() => {
          /* ignore */
        })
    } catch (err) {
      if (seq !== this.loadSeq || this.disposed) return
      this.renderError(err instanceof Error ? err.message : 'Could not load land')
    }
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
    this.disposeMap()
    this.contentEl.innerHTML = `
      <button type="button" class="marketplace-item-detail__back" data-back>← Back</button>
      <div class="marketplace-item-detail__error">
        <p class="marketplace-item-detail__error-title">Land unavailable</p>
        <p class="marketplace-item-detail__error-body">${escapeHtml(message)}</p>
        <button type="button" class="marketplace-item-detail__cta marketplace-item-detail__cta--primary" data-back>
          Back to Land
        </button>
      </div>
    `
    this.bindBack()
  }

  private renderDetail(): void {
    const L = this.listing
    if (!L) return

    this.disposeMap()

    const kindLabel = L.kind === 'estate' ? `Estate · ${L.size} parcels` : 'Parcel'
    const stock = L.isOnSale
      ? `<span class="marketplace-item-panel__stock">On sale</span>`
      : `<span class="marketplace-item-panel__stock">Not listed</span>`

    const nParcels = L.parcels.length
    const nNear = this.nearby.length

    this.contentEl.innerHTML = `
      <button type="button" class="marketplace-item-detail__back" data-back>← Back</button>
      <div class="marketplace-item-detail__hero">
        <section class="marketplace-item-stage land-detail__stage" aria-label="Parcel map">
          <div class="marketplace-item-stage__main land-detail__map-host" data-map-host></div>
          <p class="land-detail__stage-coords">${L.x}, ${L.y}</p>
        </section>

        <div class="marketplace-item-detail__side">
          <section class="marketplace-item-panel" aria-label="Purchase">
            <h1 class="marketplace-item-panel__title">${escapeHtml(L.name)}</h1>
            ${
              L.owner
                ? `<div class="marketplace-item-panel__by">
                    ${creatorAvatarHtml(L.owner)}
                    <p class="marketplace-item-panel__creator">owner <span>${escapeHtml(shortCreator(L.owner, 12))}</span></p>
                  </div>`
                : ''
            }

            <div class="marketplace-item-panel__rarity-row">
              <span class="marketplace-item-panel__chip">${escapeHtml(kindLabel)}</span>
              <span class="marketplace-item-panel__chip">${L.x}, ${L.y}</span>
              ${L.kind === 'estate' ? `<span class="marketplace-item-panel__chip">${nParcels} tiles</span>` : ''}
            </div>

            <div class="marketplace-item-panel__price-block">
              <p class="marketplace-item-panel__price">
                <span class="marketplace-item-panel__mana-icon" aria-hidden="true">◆</span>
                ${escapeHtml(formatMana(L.priceMana))}
                <span class="marketplace-item-panel__mana-unit">MANA</span>
              </p>
              ${stock}
            </div>

            <div class="marketplace-item-panel__actions">
              <button type="button" class="marketplace-item-detail__cta marketplace-item-detail__cta--primary" data-buy>
                Buy with MANA
              </button>
              <button type="button" class="marketplace-item-detail__cta marketplace-item-detail__cta--ghost" data-jump>
                Jump in
              </button>
            </div>
          </section>

          <section class="marketplace-item-info" aria-label="Land information">
            <div class="marketplace-item-info__tabs" role="tablist">
              <button type="button" class="marketplace-item-info__tab" role="tab" data-ltab="description">Description</button>
              <button type="button" class="marketplace-item-info__tab" role="tab" data-ltab="parcels">
                Parcels${nParcels ? ` <span>${nParcels}</span>` : ''}
              </button>
              <button type="button" class="marketplace-item-info__tab" role="tab" data-ltab="nearby">
                Nearby${nNear ? ` <span>${nNear}</span>` : ''}
              </button>
            </div>
            <div class="marketplace-item-info__body" data-info-body></div>
          </section>
        </div>
      </div>
    `

    this.mountMap(L)

    this.bindBack()
    this.contentEl.querySelector('[data-buy]')?.addEventListener('click', () => {
      console.info('[marketplace/land] Buy not implemented yet', {
        id: L.id,
        name: L.name,
        priceMana: L.priceMana
      })
    })
    this.contentEl.querySelector('[data-jump]')?.addEventListener('click', () => {
      this.opts.onJumpInParcel?.(L.x, L.y)
    })

    for (const btn of this.contentEl.querySelectorAll<HTMLButtonElement>('[data-ltab]')) {
      btn.addEventListener('click', () => {
        const t = btn.dataset.ltab as InfoTab
        if (t === 'description' || t === 'parcels' || t === 'nearby') {
          this.tab = t
          this.syncTabs()
        }
      })
    }
    this.syncTabs()
  }

  private mountMap(listing: LandListing): void {
    const host = this.contentEl.querySelector('[data-map-host]') as HTMLElement | null
    if (!host) return

    this.mapCanvas = new LandMapCanvas({
      mode: 'preview',
      initialZoom: VIEWPORT_MAX_ZOOM,
      selectedId: listing.id,
      getListings: () => (this.listing ? [this.listing] : []),
      onSelect: (hit) => {
        // Stay on this detail page; just update HUD. Jump via button.
        if (hit && hit.id !== this.listing?.id) {
          /* ignore other listings in preview — only this parcel is indexed */
        }
      }
    })
    host.appendChild(this.mapCanvas.root)
    this.mapCanvas.mount()
    this.mapCanvas.focusListing(listing, VIEWPORT_MAX_ZOOM)
  }

  private syncTabs(): void {
    for (const btn of this.contentEl.querySelectorAll<HTMLButtonElement>('[data-ltab]')) {
      const active = btn.dataset.ltab === this.tab
      btn.classList.toggle('marketplace-item-info__tab--active', active)
      btn.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    const body = this.contentEl.querySelector('[data-info-body]')
    if (!body || !this.listing) return

    if (this.tab === 'description') {
      const d = this.listing.description?.trim()
      body.innerHTML = d
        ? `<p class="marketplace-item-info__desc">${escapeHtml(d)}</p>`
        : `<p class="marketplace-item-info__desc marketplace-item-info__desc--muted">No description for this land.</p>
           <p class="marketplace-item-info__desc marketplace-item-info__desc--muted">Coords ${this.listing.x}, ${this.listing.y} · ${this.listing.kind === 'estate' ? `${this.listing.size} parcels` : '1 parcel'}.</p>`
      return
    }

    if (this.tab === 'parcels') {
      const rows = this.listing.parcels
        .map(
          (p) =>
            `<tr><td class="marketplace-item-info__mono">${p.x}, ${p.y}</td>
             <td><button type="button" class="land-detail__mini-btn" data-jump-xy="${p.x},${p.y}">Jump in</button></td></tr>`
        )
        .join('')
      body.innerHTML = `
        <div class="marketplace-item-info__scroll">
          <table class="marketplace-item-info__table">
            <thead><tr><th>Coords</th><th></th></tr></thead>
            <tbody>${rows || `<tr><td colspan="2">No parcels</td></tr>`}</tbody>
          </table>
        </div>`
      for (const btn of body.querySelectorAll<HTMLButtonElement>('[data-jump-xy]')) {
        btn.addEventListener('click', () => {
          const [x, y] = (btn.dataset.jumpXy ?? '').split(',').map(Number)
          if (Number.isFinite(x) && Number.isFinite(y)) this.opts.onJumpInParcel?.(x, y)
        })
      }
      return
    }

    // nearby
    if (!this.nearby.length) {
      body.innerHTML = `<p class="marketplace-item-info__empty">No nearby listings loaded.</p>`
      return
    }
    body.innerHTML = `<div class="land-detail__nearby" data-nearby></div>`
    const wrap = body.querySelector('[data-nearby]')!
    for (const N of this.nearby) {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'land-detail__nearby-card'
      card.innerHTML = `
        <span class="land-detail__nearby-name">${escapeHtml(N.name)}</span>
        <span class="land-detail__nearby-meta">${N.x}, ${N.y} · ◆ ${escapeHtml(formatMana(N.priceMana))}</span>
      `
      card.addEventListener('click', () => this.opts.onOpenLand(N))
      wrap.appendChild(card)
    }
  }

  private bindBack(): void {
    for (const el of this.contentEl.querySelectorAll('[data-back]')) {
      el.addEventListener('click', () => this.opts.onBack())
    }
  }
}
