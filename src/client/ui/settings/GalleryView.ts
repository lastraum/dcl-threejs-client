import type { AuthIdentity } from '@dcl/crypto/dist/types'
import {
  fetchWearableDisplayCards,
  filterNonDefaultWearables,
  type WearableDisplayCard
} from '../profile/wearableThumb'
import { marketplaceItemUrl } from '../../../photo/photoMetadata'
import {
  type CameraReelUploadMetadata,
  type DclGalleryImage,
  type DclGalleryImageDetail,
  deleteGalleryImage,
  fetchGalleryImageDetail,
  fetchUserGallery,
  formatGalleryDateTime,
  galleryReelsUrl,
  galleryShareOnXUrl,
  groupGalleryByMonth,
  updateGalleryImageVisibility
} from '../../../social/dclGallery'
import { PEER_URL } from '../../../avatar/constants'

const X_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`
const LINK_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`
const TRASH_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`
const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`
const DOTS_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>`

export type GalleryViewOptions = {
  getWalletAddress?: () => string | null | undefined
  getAuthIdentity?: () => AuthIdentity | null
  peerUrl?: string
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

type DetailPerson = CameraReelUploadMetadata['visiblePeople'][number]

/** Gallery tab — Camera Reel grid + 3/4 · 1/4 detail (Explorer reel style). */
export class GalleryView {
  readonly root: HTMLElement

  private readonly listShell: HTMLElement
  private readonly detailShell: HTMLElement
  private readonly storageLabel: HTMLElement
  private readonly storageBar: HTMLElement
  private readonly sectionsEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly detailHost: HTMLElement

  private readonly getWalletAddress?: () => string | null | undefined
  private readonly getAuthIdentity?: () => AuthIdentity | null
  private readonly peerUrl: string

  private images: DclGalleryImage[] = []
  private searchQuery = ''
  private searchTimer = 0
  /** image id → lowercased metadata blob for search; built lazily on first query. */
  private readonly metaBlobs = new Map<string, string>()
  private metaIndexRunning = false
  private currentImages = 0
  private maxImages = 500
  private selectedId: string | null = null
  private detail: DclGalleryImageDetail | null = null
  private detailLoading = false
  private detailBusy = false
  private expanded = new Set<string>()
  private wearableCache = new Map<string, WearableDisplayCard[]>()
  private loadingWearables = new Set<string>()
  private statusTimer = 0
  private loading = false
  private error: string | null = null
  private disposed = false
  /** Image id whose ⋮ menu is open (grid only). */
  private menuOpenId: string | null = null

  constructor(opts: GalleryViewOptions = {}) {
    this.getWalletAddress = opts.getWalletAddress
    this.getAuthIdentity = opts.getAuthIdentity
    this.peerUrl = (opts.peerUrl ?? PEER_URL).replace(/\/$/, '')

    this.root = document.createElement('div')
    this.root.className = 'gallery-view'
    this.root.innerHTML = `
      <div class="gallery-view__list" data-list-shell>
        <header class="gallery-view__header">
          <div class="gallery-view__header-left">
            <h2 class="gallery-view__title">Gallery</h2>
          </div>
          <input type="search" class="gallery-view__search" data-search placeholder="Search photos" aria-label="Search photos by people, place, or metadata" autocomplete="off" spellcheck="false" />
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
        <div class="gallery-view__detail-host" data-detail-host></div>
      </div>
    `

    this.listShell = this.root.querySelector('[data-list-shell]')!
    this.detailShell = this.root.querySelector('[data-detail-shell]')!
    this.storageLabel = this.root.querySelector('[data-storage-label]')!
    this.storageBar = this.root.querySelector('[data-storage-bar]')!
    this.sectionsEl = this.root.querySelector('[data-sections]')!
    this.statusEl = this.root.querySelector('[data-status]')!
    this.detailHost = this.root.querySelector('[data-detail-host]')!

    const search = this.root.querySelector('[data-search]') as HTMLInputElement | null
    search?.addEventListener('input', () => {
      window.clearTimeout(this.searchTimer)
      this.searchTimer = window.setTimeout(() => {
        this.searchQuery = search.value
        if (this.searchQuery.trim()) this.ensureMetaIndex()
        this.renderSearchStatus(null, null)
        this.renderSections()
      }, 200)
    })

    this.sectionsEl.addEventListener('click', (ev) => void this.handleSectionClick(ev))
    this.sectionsEl.addEventListener('change', (ev) => void this.handleSectionChange(ev))
    this.detailHost.addEventListener('click', (ev) => void this.handleDetailClick(ev))
    this.detailHost.addEventListener('change', (ev) => void this.handleDetailChange(ev))
    document.addEventListener('pointerdown', this.onDocPointerDown, true)
    document.addEventListener('keydown', this.onDocKeyDown, true)
  }

  mount(): void {
    void this.loadGallery()
  }

  refresh(): void {
    void this.loadGallery()
  }

  dispose(): void {
    this.disposed = true
    document.removeEventListener('pointerdown', this.onDocPointerDown, true)
    document.removeEventListener('keydown', this.onDocKeyDown, true)
    if (this.statusTimer) window.clearTimeout(this.statusTimer)
    window.clearTimeout(this.searchTimer)
    this.root.remove()
  }

  private onDocPointerDown = (ev: PointerEvent): void => {
    if (!this.menuOpenId) return
    const t = ev.target as Node | null
    if (t && this.sectionsEl.contains(t)) {
      const menu = (t as HTMLElement).closest?.('[data-thumb-menu]')
      const dots = (t as HTMLElement).closest?.('[data-action="menu"]')
      if (menu || dots) return
    }
    this.closeMenu()
  }

  private onDocKeyDown = (ev: KeyboardEvent): void => {
    if (ev.code === 'Escape' && this.menuOpenId) {
      this.closeMenu()
      return
    }
    // Detail carousel: Esc back to grid (overlay stays open), arrows step photos.
    if (this.detailShell.hidden) return
    const el = document.activeElement
    const typing =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    if (ev.code === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      this.closeDetail()
      return
    }
    if (typing) return
    if (ev.code === 'ArrowLeft' || ev.code === 'ArrowRight') {
      const target = this.adjacentImage(ev.code === 'ArrowRight' ? 1 : -1)
      if (target) {
        ev.preventDefault()
        void this.openDetail(target)
      }
    }
  }

  /** Neighbor of the open photo within the current (search-filtered) order. */
  private adjacentImage(step: 1 | -1): DclGalleryImage | null {
    if (!this.selectedId) return null
    const order = this.visibleImages()
    const idx = order.findIndex((img) => img.id === this.selectedId)
    if (idx === -1) return null
    return order[idx + step] ?? null
  }

  private closeMenu(): void {
    if (!this.menuOpenId) return
    this.menuOpenId = null
    this.sectionsEl.querySelectorAll('.gallery-view__thumb.is-menu-open').forEach((el) => {
      el.classList.remove('is-menu-open')
    })
    this.sectionsEl.querySelectorAll('[data-thumb-menu]').forEach((el) => {
      el.setAttribute('hidden', '')
    })
  }

  private async loadGallery(): Promise<void> {
    const address = this.getWalletAddress?.()?.trim().toLowerCase()
    if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
      this.images = []
      this.currentImages = 0
      this.loading = false
      this.error = null
      this.setListStatus('Connect your wallet to view your gallery', 'error')
      this.renderStorage()
      this.renderSections()
      return
    }

    this.loading = true
    this.error = null
    this.setListStatus('Loading gallery…', 'loading')
    this.renderSections()

    try {
      const identity = this.getAuthIdentity?.() ?? null
      const data = await fetchUserGallery(address, identity)
      if (this.disposed) return
      this.images = data.images
      this.currentImages = data.currentImages
      this.maxImages = data.maxImages
      this.setListStatus(
        this.images.length === 0
          ? null
          : `${this.images.length} photo${this.images.length === 1 ? '' : 's'}`
      )
      this.renderStorage()
      this.renderSections()
    } catch (e) {
      if (this.disposed) return
      this.images = []
      this.error = e instanceof Error ? e.message : String(e)
      this.setListStatus(this.error, 'error')
      this.renderStorage()
      this.renderSections()
    } finally {
      this.loading = false
    }
  }

  private renderStorage(): void {
    const count = this.currentImages
    const max = this.maxImages
    this.storageLabel.textContent = `Storage ${count}/${max} photos`
    const pct = max > 0 ? Math.min(100, (count / max) * 100) : 0
    this.storageBar.style.width = `${pct}%`
  }

  /**
   * Images matching the top-bar search. Matches against the full Camera Reel
   * metadata blob (taker, wallets, visible people, place name, coords, realm)
   * once indexed; unindexed images fall back to their date string.
   */
  private visibleImages(): DclGalleryImage[] {
    const q = this.searchQuery.trim().toLowerCase()
    if (!q) return this.images
    return this.images.filter((img) => {
      const blob = this.metaBlobs.get(img.id)
      if (blob !== undefined) return blob.includes(q)
      return (
        img.dateTime.toLowerCase().includes(q) ||
        formatGalleryDateTime(img.dateTime, 'short').toLowerCase().includes(q)
      )
    })
  }

  /** Lazily fetch per-image metadata for search (concurrency-limited, cached). */
  private ensureMetaIndex(): void {
    if (this.metaIndexRunning) return
    const pending = this.images.filter((img) => !this.metaBlobs.has(img.id))
    if (!pending.length) return
    this.metaIndexRunning = true
    const total = this.images.length
    let done = total - pending.length
    const worker = async (): Promise<void> => {
      while (pending.length && !this.disposed) {
        const img = pending.shift()!
        try {
          const detail = await fetchGalleryImageDetail(img.id)
          this.metaBlobs.set(
            img.id,
            `${JSON.stringify(detail.metadata)} ${formatGalleryDateTime(img.dateTime, 'short')}`.toLowerCase()
          )
        } catch {
          this.metaBlobs.set(img.id, img.dateTime.toLowerCase())
        }
        done++
        // Progressive refresh while a search is active.
        if (this.searchQuery.trim() && (done % 15 === 0 || !pending.length)) {
          this.renderSearchStatus(done, total)
          this.renderSections()
        }
      }
    }
    void Promise.all(Array.from({ length: 6 }, worker)).finally(() => {
      this.metaIndexRunning = false
      if (!this.disposed && this.searchQuery.trim()) {
        this.renderSearchStatus(null, null)
        this.renderSections()
      }
    })
  }

  private renderSearchStatus(done: number | null, total: number | null): void {
    const q = this.searchQuery.trim()
    if (!q) {
      this.setListStatus(
        this.images.length === 0
          ? null
          : `${this.images.length} photo${this.images.length === 1 ? '' : 's'}`
      )
      return
    }
    const matches = this.visibleImages().length
    const indexing = done !== null && total !== null && done < total ? ` · indexing ${done}/${total}` : ''
    this.setListStatus(`${matches} of ${this.images.length} photos match${indexing}`)
  }

  private renderSections(): void {
    if (this.loading && this.images.length === 0) {
      this.sectionsEl.innerHTML = `
        <section class="gallery-view__section">
          <h3 class="gallery-view__section-title">Loading…</h3>
          <div class="gallery-view__grid" role="list">
            ${Array.from({ length: 8 }, () => `<div class="gallery-view__skeleton" role="presentation"></div>`).join('')}
          </div>
        </section>`
      return
    }

    if (this.images.length === 0) {
      this.sectionsEl.innerHTML = `<div class="gallery-view__empty">
        <p class="gallery-view__empty-title">${
          this.error ? 'Couldn’t load gallery' : 'No photos yet'
        }</p>
        <p class="gallery-view__empty-body">${
          this.error
            ? escapeHtml(this.error)
            : 'Press <kbd>C</kbd> in-world for the camera, then <strong>Save</strong> to add photos here.'
        }</p>
      </div>`
      return
    }

    const visible = this.visibleImages()
    if (visible.length === 0) {
      this.sectionsEl.innerHTML = `<div class="gallery-view__empty">
        <p class="gallery-view__empty-title">No matching photos</p>
        <p class="gallery-view__empty-body">Search covers people, wallets, place names, and photo metadata.</p>
      </div>`
      return
    }

    const sections = groupGalleryByMonth(visible)
    this.sectionsEl.innerHTML = sections
      .map(
        (section) => `
        <section class="gallery-view__section">
          <h3 class="gallery-view__section-title">${escapeHtml(section.label)}
            <span class="gallery-view__section-count">${section.images.length}</span>
          </h3>
          <div class="gallery-view__grid" role="list">
            ${section.images.map((img) => this.renderThumb(img)).join('')}
          </div>
        </section>`
      )
      .join('')

    this.sectionsEl.querySelectorAll<HTMLImageElement>('.gallery-view__thumb-img').forEach((img) => {
      img.addEventListener('error', () => {
        img.classList.add('is-broken')
        img.closest('.gallery-view__thumb')?.classList.add('is-broken')
      })
    })
  }

  private renderThumb(img: DclGalleryImage): string {
    const src = img.thumbnailUrl || img.url
    const when = formatGalleryDateTime(img.dateTime, 'short')
    const menuOpen = this.menuOpenId === img.id
    const pub = img.isPublic
      ? `<span class="gallery-view__thumb-badge" title="Public">Public</span>`
      : ''
    return `
      <div
        class="gallery-view__thumb ${menuOpen ? 'is-menu-open' : ''}"
        data-gallery-id="${escapeHtml(img.id)}"
        role="listitem"
      >
        <button
          type="button"
          class="gallery-view__thumb-open"
          data-action="open"
          data-gallery-id="${escapeHtml(img.id)}"
          aria-label="Open photo from ${escapeHtml(when)}"
        >
          <img
            class="gallery-view__thumb-img"
            src="${escapeHtml(src)}"
            alt=""
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
          />
          ${pub}
          <span class="gallery-view__thumb-date">${escapeHtml(when)}</span>
        </button>
        <button
          type="button"
          class="gallery-view__thumb-dots"
          data-action="menu"
          data-gallery-id="${escapeHtml(img.id)}"
          aria-label="Photo actions"
          aria-haspopup="menu"
          aria-expanded="${menuOpen ? 'true' : 'false'}"
        >${DOTS_ICON}</button>
        <div
          class="gallery-view__menu"
          data-thumb-menu
          data-gallery-id="${escapeHtml(img.id)}"
          role="menu"
          ${menuOpen ? '' : 'hidden'}
        >
          <label class="gallery-view__menu-row gallery-view__menu-row--toggle" role="menuitemcheckbox" aria-checked="${
            img.isPublic ? 'true' : 'false'
          }">
            <span>Set as Public</span>
            <input type="checkbox" data-action="menu-public" data-gallery-id="${escapeHtml(
              img.id
            )}" ${img.isPublic ? 'checked' : ''} />
            <span class="gallery-view__menu-switch" aria-hidden="true"></span>
          </label>
          <button type="button" class="gallery-view__menu-row" role="menuitem" data-action="menu-share" data-gallery-id="${escapeHtml(
            img.id
          )}">
            ${X_ICON}<span>Share on X</span>
          </button>
          <button type="button" class="gallery-view__menu-row" role="menuitem" data-action="menu-link" data-gallery-id="${escapeHtml(
            img.id
          )}">
            ${LINK_ICON}<span>Copy Link</span>
          </button>
          <button type="button" class="gallery-view__menu-row" role="menuitem" data-action="menu-download" data-gallery-id="${escapeHtml(
            img.id
          )}">
            ${DOWNLOAD_ICON}<span>Download</span>
          </button>
          <button type="button" class="gallery-view__menu-row gallery-view__menu-row--danger" role="menuitem" data-action="menu-delete" data-gallery-id="${escapeHtml(
            img.id
          )}">
            ${TRASH_ICON}<span>Delete</span>
          </button>
        </div>
      </div>`
  }

  private async handleSectionClick(ev: Event): Promise<void> {
    const t = (ev.target as HTMLElement).closest('[data-action]') as HTMLElement | null
    if (!t) return
    const action = t.getAttribute('data-action')
    const id = t.getAttribute('data-gallery-id') || t.closest('[data-gallery-id]')?.getAttribute('data-gallery-id')
    if (!action) return

    if (action === 'menu') {
      ev.preventDefault()
      ev.stopPropagation()
      if (!id) return
      if (this.menuOpenId === id) {
        this.closeMenu()
      } else {
        this.menuOpenId = id
        // Re-render so only one menu is open and markup is correct
        this.renderSections()
      }
      return
    }

    if (action === 'open') {
      if (!id) return
      this.closeMenu()
      const image = this.images.find((img) => img.id === id)
      if (image) void this.openDetail(image)
      return
    }

    if (!id) return
    const image = this.images.find((img) => img.id === id)
    if (!image) return

    if (action === 'menu-share') {
      ev.preventDefault()
      this.closeMenu()
      window.open(galleryShareOnXUrl(image), '_blank', 'noopener,noreferrer')
      return
    }
    if (action === 'menu-link') {
      ev.preventDefault()
      await this.copyLinkForId(id, true)
      return
    }
    if (action === 'menu-download') {
      ev.preventDefault()
      this.closeMenu()
      await this.downloadImage(image)
      return
    }
    if (action === 'menu-delete') {
      ev.preventDefault()
      this.closeMenu()
      await this.deleteImageById(id)
    }
  }

  private async handleSectionChange(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement
    if (!(input instanceof HTMLInputElement) || input.getAttribute('data-action') !== 'menu-public') return
    const id = input.getAttribute('data-gallery-id')
    if (!id) return
    await this.setPublicForId(id, input.checked, { fromMenu: true })
  }

  private async openDetail(image: DclGalleryImage): Promise<void> {
    this.selectedId = image.id
    this.detail = null
    this.detailLoading = true
    this.expanded.clear()
    this.wearableCache.clear()
    this.loadingWearables.clear()
    this.listShell.hidden = true
    this.detailShell.hidden = false
    this.root.classList.add('gallery-view--detail')
    this.renderDetailShell(image)

    try {
      const full = await fetchGalleryImageDetail(image.id)
      if (this.disposed || this.selectedId !== image.id) return
      // Prefer list visibility if we already know it; metadata endpoint includes isPublic.
      this.detail = {
        ...full,
        isPublic: full.isPublic || image.isPublic,
        url: full.url || image.url,
        thumbnailUrl: full.thumbnailUrl || image.thumbnailUrl
      }
      // Keep list row in sync
      const idx = this.images.findIndex((i) => i.id === image.id)
      if (idx >= 0) {
        this.images[idx] = {
          id: this.detail.id,
          url: this.detail.url,
          thumbnailUrl: this.detail.thumbnailUrl,
          isPublic: this.detail.isPublic,
          dateTime: this.detail.dateTime || image.dateTime
        }
      }
      const first = this.detail.metadata.visiblePeople[0]
      if (first?.userAddress) {
        this.expanded.add(first.userAddress.toLowerCase())
        void this.ensureWearables(first)
      }
    } catch (err) {
      console.warn('[gallery] detail load failed', err)
      // Fallback shell still shows the photo without people metadata
      this.detail = {
        ...image,
        metadata: {
          userName: 'Unknown',
          userAddress: '',
          dateTime: image.dateTime,
          realm: '',
          scene: { name: 'Unknown place', location: { x: '0', y: '0' } },
          visiblePeople: [],
          placeId: ''
        }
      }
      this.flashDetailStatus(
        err instanceof Error ? err.message : 'Could not load photo details',
        false
      )
    } finally {
      this.detailLoading = false
      if (this.selectedId === image.id) this.renderDetailShell(this.detail ?? image)
    }
  }

  private closeDetail(): void {
    this.selectedId = null
    this.detail = null
    this.detailLoading = false
    this.detailBusy = false
    this.detailHost.innerHTML = ''
    this.detailShell.hidden = true
    this.listShell.hidden = false
    this.root.classList.remove('gallery-view--detail')
  }

  private renderDetailShell(image: DclGalleryImage | DclGalleryImageDetail): void {
    const meta = 'metadata' in image && image.metadata ? image.metadata : null
    const dateLabel = formatGalleryDateTime(meta?.dateTime || image.dateTime, 'medium')
    const takenBy = meta?.userName?.trim() || 'Unknown'
    const placeName = meta?.scene?.name?.trim() || 'Unknown place'
    const parcelX = meta?.scene?.location?.x ?? '?'
    const parcelY = meta?.scene?.location?.y ?? '?'
    const imgSrc = image.url || image.thumbnailUrl
    const reelsUrl = galleryReelsUrl(image.id)
    const isPublic = image.isPublic

    this.detailHost.innerHTML = `
      <div class="gallery-detail">
        <div class="gallery-detail__layout photo-review__layout">
          <div class="gallery-detail__preview photo-review__preview">
            <button type="button" class="gallery-detail__nav gallery-detail__nav--prev" data-action="prev" aria-label="Previous photo" ${this.adjacentImage(-1) ? '' : 'disabled'}>&lsaquo;</button>
            <button type="button" class="gallery-detail__nav gallery-detail__nav--next" data-action="next" aria-label="Next photo" ${this.adjacentImage(1) ? '' : 'disabled'}>&rsaquo;</button>
            <img
              class="gallery-detail__image photo-review__image"
              src="${escapeAttr(imgSrc)}"
              alt="Gallery photo"
              draggable="false"
              referrerpolicy="no-referrer"
              data-detail-img
            />
          </div>
          <aside class="gallery-detail__rail photo-review__rail">
            <header class="photo-review__header">
              <p class="photo-review__taken">${escapeHtml(dateLabel)} · Taken by <strong>${escapeHtml(
                takenBy
              )}</strong></p>
            </header>

            <section class="photo-review__section">
              <h3 class="photo-review__section-label">Place</h3>
              <div class="photo-review__place">
                <span class="photo-review__place-pin" aria-hidden="true">📍</span>
                <div class="photo-review__place-text">
                  <span class="photo-review__place-name">${escapeHtml(placeName)}</span>
                  <span class="photo-review__place-parcel">${escapeHtml(`${parcelX}, ${parcelY}`)}</span>
                </div>
              </div>
            </section>

            <section class="photo-review__section photo-review__section--people">
              <h3 class="photo-review__section-label">People</h3>
              <div class="photo-review__people">
                ${
                  this.detailLoading
                    ? `<p class="photo-review__loading">Loading details…</p>`
                    : this.renderPeople(meta?.visiblePeople ?? [])
                }
              </div>
            </section>

            <footer class="gallery-detail__footer photo-review__footer">
              <span class="photo-review__action-status" data-action-status></span>

              <label class="gallery-detail__public">
                <input type="checkbox" data-action="public" ${isPublic ? 'checked' : ''} ${
                  this.detailBusy ? 'disabled' : ''
                } />
                <span class="gallery-detail__public-ui" aria-hidden="true"></span>
                <span class="gallery-detail__public-label">Set to public</span>
              </label>

              <div class="gallery-detail__actions">
                <button type="button" class="gallery-detail__btn gallery-detail__btn--secondary" data-action="link" title="${escapeAttr(
                  reelsUrl
                )}">
                  ${LINK_ICON}<span>Link</span>
                </button>
                <button type="button" class="gallery-detail__btn gallery-detail__btn--secondary" data-action="share-x">
                  ${X_ICON}<span>Share</span>
                </button>
                <button type="button" class="gallery-detail__btn gallery-detail__btn--secondary" data-action="download">
                  ${DOWNLOAD_ICON}<span>Download</span>
                </button>
                <button type="button" class="gallery-detail__btn gallery-detail__btn--danger" data-action="delete" ${
                  this.detailBusy ? 'disabled' : ''
                } title="Delete from gallery">
                  ${TRASH_ICON}<span>Delete</span>
                </button>
              </div>
            </footer>
          </aside>
        </div>
      </div>
    `

    const img = this.detailHost.querySelector('[data-detail-img]') as HTMLImageElement | null
    if (img) {
      const thumb = image.thumbnailUrl || image.url
      img.onerror = () => {
        if (thumb && img.src !== thumb) {
          img.src = thumb
          return
        }
        img.classList.add('is-broken')
      }
    }
  }

  private renderPeople(people: DetailPerson[]): string {
    if (!people.length) {
      return `<p class="photo-review__empty">No people in frame</p>`
    }
    return people.map((p) => this.renderPerson(p)).join('')
  }

  private renderPerson(person: DetailPerson): string {
    const key = (person.userAddress || person.userName).toLowerCase()
    const open = this.expanded.has(key)
    const face = `<span class="photo-review__avatar photo-review__avatar--fallback" aria-hidden="true">${escapeHtml(
      (person.userName || '?').slice(0, 1).toUpperCase()
    )}</span>`

    let body = ''
    if (open) {
      if (this.loadingWearables.has(key) && !this.wearableCache.has(key)) {
        body = `<div class="photo-review__wearables"><p class="photo-review__loading">Loading items…</p></div>`
      } else {
        const cards = this.wearableCache.get(key) ?? []
        body = `<div class="photo-review__wearables">${this.renderWearables(cards)}</div>`
      }
    }

    return `
      <div class="photo-review__person ${open ? 'is-open' : ''}">
        <button type="button" class="photo-review__person-head" data-action="toggle-person" data-address="${escapeAttr(
          key
        )}" aria-expanded="${open ? 'true' : 'false'}">
          ${face}
          <span class="photo-review__person-name">${escapeHtml(person.userName || 'Unknown')}</span>
          <span class="photo-review__chevron" aria-hidden="true">${open ? '▴' : '▾'}</span>
        </button>
        ${body}
      </div>
    `
  }

  private renderWearables(cards: WearableDisplayCard[]): string {
    if (!cards.length) {
      return `<p class="photo-review__empty photo-review__empty--items">No wearables listed</p>`
    }
    return cards
      .map((card) => {
        const buyUrl = marketplaceItemUrl(card.urn)
        const buy = buyUrl
          ? `<a class="photo-review__buy" href="${escapeAttr(buyUrl)}" target="_blank" rel="noopener noreferrer">BUY</a>`
          : `<span class="photo-review__buy photo-review__buy--disabled">—</span>`
        return `
          <div class="photo-review__item">
            <img class="photo-review__item-thumb" src="${escapeAttr(card.thumbnailUrl)}" alt="" loading="lazy" />
            <span class="photo-review__item-name" title="${escapeAttr(card.name)}">${escapeHtml(
              card.name
            )}</span>
            ${buy}
          </div>
        `
      })
      .join('')
  }

  private async ensureWearables(person: DetailPerson): Promise<void> {
    const key = (person.userAddress || person.userName).toLowerCase()
    if (this.wearableCache.has(key) || this.loadingWearables.has(key)) return
    this.loadingWearables.add(key)
    try {
      const urns = filterNonDefaultWearables(person.wearables ?? [])
      const cards = await fetchWearableDisplayCards(urns, this.peerUrl)
      this.wearableCache.set(key, cards)
    } catch (err) {
      console.warn('[gallery] wearables failed', person.userName, err)
      this.wearableCache.set(key, [])
    } finally {
      this.loadingWearables.delete(key)
      if (this.selectedId && this.detail) this.renderDetailShell(this.detail)
    }
  }

  private async handleDetailClick(ev: Event): Promise<void> {
    const t = (ev.target as HTMLElement).closest('[data-action]') as HTMLElement | null
    if (!t) return
    const action = t.getAttribute('data-action')
    if (!action) return

    if (action === 'back') {
      this.closeDetail()
      return
    }
    if (action === 'prev' || action === 'next') {
      const target = this.adjacentImage(action === 'next' ? 1 : -1)
      if (target) void this.openDetail(target)
      return
    }
    if (action === 'toggle-person') {
      const addr = t.getAttribute('data-address')
      if (!addr) return
      if (this.expanded.has(addr)) this.expanded.delete(addr)
      else {
        this.expanded.add(addr)
        const person = this.detail?.metadata.visiblePeople.find(
          (p) => (p.userAddress || p.userName).toLowerCase() === addr
        )
        if (person) void this.ensureWearables(person)
      }
      if (this.detail) this.renderDetailShell(this.detail)
      return
    }
    if (action === 'link') {
      ev.preventDefault()
      await this.copyLink()
      return
    }
    if (action === 'share-x') {
      ev.preventDefault()
      this.shareSelectedOnX()
      return
    }
    if (action === 'download') {
      ev.preventDefault()
      const image =
        this.detail ??
        (this.selectedId ? this.images.find((img) => img.id === this.selectedId) : null)
      if (image) await this.downloadImage(image)
      return
    }
    if (action === 'delete') {
      ev.preventDefault()
      await this.deleteSelected()
    }
  }

  private async handleDetailChange(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement
    if (!(input instanceof HTMLInputElement) || input.getAttribute('data-action') !== 'public') return
    await this.setPublic(input.checked)
  }

  private async copyLink(): Promise<void> {
    if (!this.selectedId) return
    await this.copyLinkForId(this.selectedId, false)
  }

  private async copyLinkForId(imageId: string, fromMenu: boolean): Promise<void> {
    const url = galleryReelsUrl(imageId)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      } else {
        const ta = document.createElement('textarea')
        ta.value = url
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      }
      if (fromMenu) {
        this.closeMenu()
        this.setListStatus('Link copied', 'info')
        window.setTimeout(() => {
          if (this.images.length > 0) {
            this.setListStatus(
              `${this.images.length} photo${this.images.length === 1 ? '' : 's'}`,
              'info'
            )
          }
        }, 1800)
      } else {
        this.flashDetailStatus('Link copied')
      }
    } catch (err) {
      console.warn('[gallery] copy link failed', err)
      if (fromMenu) this.setListStatus(url, 'error')
      else this.flashDetailStatus(url, false)
    }
  }

  private shareSelectedOnX(): void {
    const image =
      this.detail ??
      (this.selectedId ? this.images.find((img) => img.id === this.selectedId) : null)
    if (!image) return
    window.open(galleryShareOnXUrl(image), '_blank', 'noopener,noreferrer')
  }

  private async downloadImage(image: DclGalleryImage): Promise<void> {
    const src = image.url || image.thumbnailUrl
    if (!src) {
      this.setListStatus('No image URL to download', 'error')
      return
    }
    const filename = `dcl-photo-${image.id.slice(0, 8)}.jpg`
    try {
      const res = await fetch(src, { mode: 'cors' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = filename
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2000)
      if (this.selectedId === image.id) this.flashDetailStatus('Downloaded')
      else this.setListStatus('Downloaded', 'info')
    } catch (err) {
      console.warn('[gallery] download via fetch failed, opening URL', err)
      // Cross-origin fallback — open/save via browser
      window.open(src, '_blank', 'noopener,noreferrer')
    }
  }

  private async setPublic(isPublic: boolean): Promise<void> {
    if (!this.selectedId) return
    await this.setPublicForId(this.selectedId, isPublic, { fromMenu: false })
  }

  private async setPublicForId(
    imageId: string,
    isPublic: boolean,
    opts: { fromMenu: boolean }
  ): Promise<void> {
    if (this.detailBusy) return
    const identity = this.getAuthIdentity?.() ?? null
    if (!identity) {
      if (opts.fromMenu) this.setListStatus('Connect wallet to change visibility', 'error')
      else this.flashDetailStatus('Connect wallet to change visibility', false)
      this.renderSections()
      if (this.detail && this.selectedId === imageId) this.renderDetailShell(this.detail)
      return
    }
    this.detailBusy = true
    if (!opts.fromMenu) {
      this.flashDetailStatus(isPublic ? 'Making public…' : 'Making private…', false)
    }
    try {
      await updateGalleryImageVisibility(imageId, isPublic, identity)
      const idx = this.images.findIndex((i) => i.id === imageId)
      if (idx >= 0) this.images[idx] = { ...this.images[idx]!, isPublic }
      if (this.detail?.id === imageId) this.detail.isPublic = isPublic
      if (opts.fromMenu) {
        // Keep menu open with updated toggle state
        this.menuOpenId = imageId
        this.renderSections()
      } else {
        this.flashDetailStatus(isPublic ? 'Now public' : 'Now private')
        if (this.detail) this.renderDetailShell(this.detail)
      }
    } catch (err) {
      console.warn('[gallery] visibility failed', err)
      const msg = err instanceof Error ? err.message : 'Visibility update failed'
      if (opts.fromMenu) {
        this.setListStatus(msg, 'error')
        this.renderSections()
      } else {
        this.flashDetailStatus(msg, false)
        if (this.detail) this.renderDetailShell(this.detail)
      }
    } finally {
      this.detailBusy = false
    }
  }

  private async deleteSelected(): Promise<void> {
    if (!this.selectedId) return
    await this.deleteImageById(this.selectedId)
  }

  private async deleteImageById(imageId: string): Promise<void> {
    if (this.detailBusy) return
    const identity = this.getAuthIdentity?.() ?? null
    if (!identity) {
      if (this.selectedId === imageId) this.flashDetailStatus('Connect wallet to delete', false)
      else this.setListStatus('Connect wallet to delete', 'error')
      return
    }
    const ok = window.confirm('Delete this photo from your Decentraland gallery? This cannot be undone.')
    if (!ok) return

    this.detailBusy = true
    if (this.selectedId === imageId) this.flashDetailStatus('Deleting…', false)
    try {
      const counts = await deleteGalleryImage(imageId, identity)
      this.images = this.images.filter((img) => img.id !== imageId)
      this.currentImages = counts.currentImages
      this.maxImages = counts.maxImages
      this.renderStorage()
      if (this.selectedId === imageId) this.closeDetail()
      this.menuOpenId = null
      this.renderSections()
      this.setListStatus(
        this.images.length === 0
          ? null
          : `${this.images.length} photo${this.images.length === 1 ? '' : 's'}`
      )
    } catch (err) {
      console.warn('[gallery] delete failed', err)
      const msg = err instanceof Error ? err.message : 'Delete failed'
      if (this.selectedId === imageId) this.flashDetailStatus(msg, false)
      else this.setListStatus(msg, 'error')
    } finally {
      this.detailBusy = false
    }
  }

  private flashDetailStatus(text: string, autoClear = true): void {
    const el = this.detailHost.querySelector('[data-action-status]') as HTMLElement | null
    if (!el) return
    el.textContent = text
    if (this.statusTimer) window.clearTimeout(this.statusTimer)
    this.statusTimer = 0
    if (!autoClear || !text) return
    this.statusTimer = window.setTimeout(() => {
      el.textContent = ''
      this.statusTimer = 0
    }, 2400)
  }

  private setListStatus(msg: string | null, kind?: 'loading' | 'error' | 'info'): void {
    if (!msg) {
      this.statusEl.hidden = true
      this.statusEl.textContent = ''
      this.statusEl.className = 'gallery-view__status'
      return
    }
    this.statusEl.hidden = false
    this.statusEl.textContent = msg
    this.statusEl.className = `gallery-view__status gallery-view__status--${kind ?? 'info'}`
  }
}
