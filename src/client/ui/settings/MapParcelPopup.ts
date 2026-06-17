import type { ParcelInfo } from '../../../map/types'

export type MapParcelPopupOptions = {
  mountEl: HTMLElement
  onClose: () => void
  onJumpIn: (px: number, py: number) => void
}

/** Bottom sheet parcel info popup — ported from dcl-neurolink decentraland map. */
export class MapParcelPopup {
  readonly root: HTMLElement
  private readonly onClose: () => void
  private readonly onJumpIn: (px: number, py: number) => void
  private previewUrl: string | null = null
  private parcel: ParcelInfo | null = null
  private loading = false
  private error: string | null = null

  constructor({ mountEl, onClose, onJumpIn }: MapParcelPopupOptions) {
    this.onClose = onClose
    this.onJumpIn = onJumpIn

    this.root = document.createElement('div')
    this.root.className = 'dcl-map__parcel-popup-backdrop'
    this.root.hidden = true
    this.root.addEventListener('click', () => this.onClose())

    mountEl.appendChild(this.root)
  }

  showLoading(): void {
    this.parcel = null
    this.loading = true
    this.error = null
    this.previewUrl = null
    this.render()
    this.root.hidden = false
  }

  showError(message: string): void {
    this.parcel = null
    this.loading = false
    this.error = message
    this.render()
    this.root.hidden = false
  }

  showParcel(parcel: ParcelInfo): void {
    this.parcel = parcel
    this.loading = false
    this.error = null
    this.previewUrl = null
    this.render()
    this.root.hidden = false
  }

  hide(): void {
    this.root.hidden = true
  }

  dispose(): void {
    this.root.remove()
  }

  private render(): void {
    const parcel = this.parcel
    const title = parcel ? parcel.sceneName || parcel.parcelLabel : ''
    const imageSrc = parcel ? this.previewUrl ?? parcel.imageUrl : null

    this.root.innerHTML = `
      <div class="dcl-map__parcel-popup" role="dialog" aria-labelledby="dcl-parcel-popup-title" aria-busy="${this.loading}">
        <button type="button" class="dcl-map__parcel-popup-close" aria-label="Close">&times;</button>
        ${
          this.loading && !parcel
            ? '<p class="dcl-map__parcel-popup-loading">Loading parcel…</p>'
            : this.error && !parcel
              ? `<p class="dcl-map__parcel-popup-error" role="alert">${escapeHtml(this.error)}</p>`
              : parcel
                ? `
            <div class="dcl-map__parcel-popup-preview">
              ${
                imageSrc
                  ? `<img src="${escapeAttr(imageSrc)}" alt="" decoding="async" data-preview />`
                  : '<div class="dcl-map__parcel-popup-preview-fallback" aria-hidden></div>'
              }
            </div>
            <div class="dcl-map__parcel-popup-body">
              <p class="dcl-map__parcel-popup-coords"><span aria-hidden>📍</span> ( ${parcel.px}, ${parcel.py} )</p>
              <h2 id="dcl-parcel-popup-title" class="dcl-map__parcel-popup-name">${escapeHtml(title)}</h2>
              ${parcel.description ? `<p class="dcl-map__parcel-popup-desc">${escapeHtml(parcel.description)}</p>` : ''}
              <button type="button" class="dcl-map__parcel-popup-jump">Jump In</button>
            </div>`
                : ''
        }
      </div>
    `

    this.root.querySelector('.dcl-map__parcel-popup-close')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.onClose()
    })

    const card = this.root.querySelector('.dcl-map__parcel-popup')
    card?.addEventListener('click', (ev) => ev.stopPropagation())

    const img = this.root.querySelector<HTMLImageElement>('[data-preview]')
    if (img && parcel) {
      img.addEventListener('error', () => {
        if (this.previewUrl !== parcel.mapImageUrl) {
          this.previewUrl = parcel.mapImageUrl
          this.render()
        }
      })
    }

    this.root.querySelector('.dcl-map__parcel-popup-jump')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (parcel) this.onJumpIn(parcel.px, parcel.py)
    })
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;')
}
