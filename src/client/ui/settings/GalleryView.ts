import type { AuthIdentity } from '@dcl/crypto/dist/types'
import {
  type DclGalleryImage,
  fetchUserGallery,
  galleryShareOnXUrl,
  groupGalleryByMonth
} from '../../../social/dclGallery'

const X_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`

export type GalleryViewOptions = {
  getWalletAddress?: () => string | null | undefined
  getAuthIdentity?: () => AuthIdentity | null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Gallery tab — Camera Reel photos grouped by month, Share on X via reels link. */
export class GalleryView {
  readonly root: HTMLElement

  private readonly listShell: HTMLElement
  private readonly detailShell: HTMLElement
  private readonly storageLabel: HTMLElement
  private readonly storageBar: HTMLElement
  private readonly sectionsEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly detailImg: HTMLImageElement
  private readonly detailMeta: HTMLElement

  private readonly getWalletAddress?: () => string | null | undefined
  private readonly getAuthIdentity?: () => AuthIdentity | null

  private images: DclGalleryImage[] = []
  private currentImages = 0
  private maxImages = 500
  private selectedId: string | null = null
  private loading = false
  private error: string | null = null
  private disposed = false

  constructor(opts: GalleryViewOptions = {}) {
    this.getWalletAddress = opts.getWalletAddress
    this.getAuthIdentity = opts.getAuthIdentity

    this.root = document.createElement('div')
    this.root.className = 'gallery-view'
    this.root.innerHTML = `
      <div class="gallery-view__list" data-list-shell>
        <header class="gallery-view__header">
          <h2 class="gallery-view__title">Gallery</h2>
          <div class="gallery-view__storage">
            <span class="gallery-view__storage-label" data-storage-label>Storage</span>
            <div class="gallery-view__storage-track" aria-hidden="true">
              <div class="gallery-view__storage-fill" data-storage-bar></div>
            </div>
          </div>
        </header>
        <p class="gallery-view__status" data-status hidden></p>
        <div class="gallery-view__sections" data-sections></div>
      </div>
      <div class="gallery-view__detail" data-detail-shell hidden>
        <header class="gallery-view__detail-header">
          <button type="button" class="gallery-view__back" data-back>← Gallery</button>
          <button type="button" class="gallery-view__share-x" data-share-x>${X_ICON}<span>Share on X</span></button>
        </header>
        <div class="gallery-view__detail-body">
          <img class="gallery-view__detail-img" data-detail-img alt="" />
          <p class="gallery-view__detail-meta" data-detail-meta></p>
        </div>
      </div>
    `

    this.listShell = this.root.querySelector('[data-list-shell]')!
    this.detailShell = this.root.querySelector('[data-detail-shell]')!
    this.storageLabel = this.root.querySelector('[data-storage-label]')!
    this.storageBar = this.root.querySelector('[data-storage-bar]')!
    this.sectionsEl = this.root.querySelector('[data-sections]')!
    this.statusEl = this.root.querySelector('[data-status]')!
    this.detailImg = this.root.querySelector('[data-detail-img]')!
    this.detailMeta = this.root.querySelector('[data-detail-meta]')!

    this.root.querySelector('[data-back]')!.addEventListener('click', () => this.closeDetail())
    this.root.querySelector('[data-share-x]')!.addEventListener('click', () => this.shareSelectedOnX())
    this.sectionsEl.addEventListener('click', (ev) => this.handleSectionClick(ev))
  }

  mount(): void {
    void this.loadGallery()
  }

  dispose(): void {
    this.disposed = true
    this.root.remove()
  }

  private async loadGallery(): Promise<void> {
    const address = this.getWalletAddress?.()?.trim()
    if (!address) {
      this.setStatus('Connect your wallet to view your gallery', 'error')
      this.renderSections()
      return
    }

    this.loading = true
    this.error = null
    this.setStatus('Loading gallery…', 'loading')

    try {
      const data = await fetchUserGallery(address, this.getAuthIdentity?.() ?? null)
      if (this.disposed) return
      this.images = data.images
      this.currentImages = data.currentImages
      this.maxImages = data.maxImages
      this.setStatus(null)
      this.renderStorage()
      this.renderSections()
    } catch (e) {
      if (this.disposed) return
      this.images = []
      this.error = e instanceof Error ? e.message : String(e)
      this.setStatus(this.error, 'error')
      this.renderStorage()
      this.renderSections()
    } finally {
      this.loading = false
    }
  }

  private renderStorage(): void {
    const count = this.currentImages
    const max = this.maxImages
    this.storageLabel.textContent = `Storage ${count}/${max} photos taken`
    const pct = max > 0 ? Math.min(100, (count / max) * 100) : 0
    this.storageBar.style.width = `${pct}%`
  }

  private renderSections(): void {
    if (this.loading) {
      this.sectionsEl.innerHTML = ''
      return
    }

    if (this.images.length === 0) {
      this.sectionsEl.innerHTML = `<p class="gallery-view__empty">${
        this.error ? escapeHtml(this.error) : 'No photos yet — capture moments in-world with the camera.'
      }</p>`
      return
    }

    const sections = groupGalleryByMonth(this.images)
    this.sectionsEl.innerHTML = sections
      .map(
        (section) => `
        <section class="gallery-view__section">
          <h3 class="gallery-view__section-title">${escapeHtml(section.label)}</h3>
          <div class="gallery-view__grid" role="list">
            ${section.images.map((img) => this.renderThumb(img)).join('')}
          </div>
        </section>`
      )
      .join('')
  }

  private renderThumb(img: DclGalleryImage): string {
    const src = img.thumbnailUrl || img.url
    return `
      <button
        type="button"
        class="gallery-view__thumb"
        data-gallery-id="${escapeHtml(img.id)}"
        role="listitem"
        aria-label="Open photo"
      >
        <img class="gallery-view__thumb-img" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" />
      </button>`
  }

  private handleSectionClick(ev: Event): void {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-gallery-id]')
    if (!btn) return
    const id = btn.dataset.galleryId
    if (!id) return
    const image = this.images.find((img) => img.id === id)
    if (image) this.openDetail(image)
  }

  private openDetail(image: DclGalleryImage): void {
    this.selectedId = image.id
    this.listShell.hidden = true
    this.detailShell.hidden = false
    this.root.classList.add('gallery-view--detail')
    this.detailImg.src = image.url || image.thumbnailUrl
    const when = image.dateTime
      ? new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short'
        }).format(new Date(image.dateTime))
      : 'Date unknown'
    this.detailMeta.textContent = when
  }

  private closeDetail(): void {
    this.selectedId = null
    this.detailShell.hidden = true
    this.listShell.hidden = false
    this.root.classList.remove('gallery-view--detail')
    this.detailImg.removeAttribute('src')
  }

  private shareSelectedOnX(): void {
    const image = this.selectedId ? this.images.find((img) => img.id === this.selectedId) : null
    if (!image) return
    window.open(galleryShareOnXUrl(image), '_blank', 'noopener,noreferrer')
  }

  private setStatus(msg: string | null, kind?: 'loading' | 'error'): void {
    if (!msg) {
      this.statusEl.hidden = true
      this.statusEl.textContent = ''
      this.statusEl.className = 'gallery-view__status'
      return
    }
    this.statusEl.hidden = false
    this.statusEl.textContent = msg
    this.statusEl.className = `gallery-view__status gallery-view__status--${kind ?? 'loading'}`
  }
}