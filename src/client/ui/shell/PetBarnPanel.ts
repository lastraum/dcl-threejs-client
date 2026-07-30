import type { SessionIdentity } from '../../../network/SessionIdentity'
import {
  PETBARN_MAX_GLB_BYTES,
  PETBARN_MAX_THUMB_BYTES,
  PETBARN_POLL_MS,
  addPetFromBarn,
  fetchPetBarnCatalog,
  getCachedPetBarnCatalog,
  isPetBarnAdded,
  petBarnContentUrl,
  submitPetBarnListing,
  type PetBarnCatalog,
  type PetBarnListing
} from '../../../pets/petBarn'
import type { PetCategory } from '../../../pets/types'
import { formatPetByteSize } from '../../../pets/PetLibrary'

export type PetBarnPanelOptions = {
  getSession: () => SessionIdentity
  onClose?: () => void
  /** After user adds a pet to local library */
  onAddedToLibrary?: () => void | Promise<void>
  /** Switch back to My Pets panel */
  onOpenMyPets?: () => void
  /** Publish round-trip lock started/ended (block pets HUD toggle, etc.). */
  onPublishLockChange?: (locked: boolean) => void
}

type View = 'catalog' | 'publish'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Pet Barn marketplace — catalog + thumbnails only until Add.
 */
export class PetBarnPanel {
  readonly element: HTMLDivElement
  private visible = false
  private busy = false
  /** True from publish submit until catalog lists the new pet (or timeout/error). */
  private publishLocked = false
  private view: View = 'catalog'
  private catalog: PetBarnCatalog | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastUpdatedAt = ''
  private filter: 'all' | PetCategory = 'all'
  private searchQuery = ''
  private publishType: PetCategory = 'walking'
  private glbFile: File | null = null
  private thumbFile: File | null = null
  private refreshing = false
  private readonly panelEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly overlayEl: HTMLElement
  private readonly overlayCardEl: HTMLElement
  private readonly overlaySpinnerEl: HTMLElement
  private readonly overlayTitleEl: HTMLElement
  private readonly overlayTextEl: HTMLElement
  private readonly overlayDismissEl: HTMLButtonElement
  private readonly closeBtn: HTMLButtonElement
  private readonly myPetsBtn: HTMLButtonElement
  private readonly onKeyDown: (ev: KeyboardEvent) => void
  /** Center overlay: loading (blocks UI) or result (dismissible). */
  private overlayMode: 'none' | 'loading' | 'error' | 'success' = 'none'

  constructor(private readonly options: PetBarnPanelOptions) {
    this.element = document.createElement('div')
    this.element.id = 'petbarn-panel-wrap'
    this.element.className = 'pets-panel-wrap petbarn-panel-wrap'
    this.element.hidden = true
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-label', 'Pet Barn')
    this.element.innerHTML = `
      <div class="pets-panel petbarn-panel">
        <header class="pets-panel__header">
          <button type="button" class="pets-panel__back" data-my-pets aria-label="My pets">← Pets</button>
          <h2 class="pets-panel__title">Pet Barn</h2>
          <button type="button" class="pets-panel__close" data-close aria-label="Close">×</button>
        </header>
        <p class="pets-panel__status" data-status hidden></p>
        <div class="pets-panel__body petbarn-body" data-body></div>
        <div class="petbarn-overlay" data-publish-overlay hidden>
          <div class="petbarn-overlay__card" role="status" aria-live="polite" data-overlay-card>
            <div class="petbarn-overlay__spinner" data-overlay-spinner aria-hidden="true"></div>
            <div class="petbarn-overlay__error-icon" data-overlay-error-icon hidden aria-hidden="true">!</div>
            <p class="petbarn-overlay__title" data-overlay-title>Publishing…</p>
            <p class="petbarn-overlay__text" data-overlay-text>Please wait</p>
            <button type="button" class="petbarn-overlay__dismiss" data-overlay-dismiss hidden>
              Dismiss
            </button>
          </div>
        </div>
      </div>
    `
    this.panelEl = this.element.querySelector('.petbarn-panel')!
    this.bodyEl = this.element.querySelector('[data-body]')!
    this.statusEl = this.element.querySelector('[data-status]')!
    this.overlayEl = this.element.querySelector('[data-publish-overlay]')!
    this.overlayCardEl = this.element.querySelector('[data-overlay-card]')!
    this.overlaySpinnerEl = this.element.querySelector('[data-overlay-spinner]')!
    this.overlayTitleEl = this.element.querySelector('[data-overlay-title]')!
    this.overlayTextEl = this.element.querySelector('[data-overlay-text]')!
    this.overlayDismissEl = this.element.querySelector('[data-overlay-dismiss]')!
    this.closeBtn = this.element.querySelector('[data-close]')!
    this.myPetsBtn = this.element.querySelector('[data-my-pets]')!

    this.closeBtn.addEventListener('click', () => this.hide())
    this.myPetsBtn.addEventListener('click', () => {
      if (this.publishLocked) return
      this.hide()
      this.options.onOpenMyPets?.()
    })
    this.overlayDismissEl.addEventListener('click', () => this.dismissOverlay())
    this.bodyEl.addEventListener('click', (ev) => void this.onBodyClick(ev))
    this.bodyEl.addEventListener('change', (ev) => this.onBodyChange(ev))
    this.bodyEl.addEventListener('input', (ev) => this.onBodyInput(ev))

    this.onKeyDown = (ev) => {
      if (ev.key !== 'Escape' || !this.visible) return
      if (this.overlayMode === 'loading') {
        ev.preventDefault()
        ev.stopPropagation()
        return
      }
      if (this.overlayMode === 'error' || this.overlayMode === 'success') {
        ev.preventDefault()
        this.dismissOverlay()
        return
      }
      if (this.view === 'publish') {
        this.view = 'catalog'
        void this.render()
        return
      }
      this.hide()
    }

    this.bodyEl.addEventListener('submit', (ev) => {
      const form = (ev.target as HTMLElement).closest('form[data-publish-form]')
      if (!form) return
      ev.preventDefault()
      void this.handlePublish(form as HTMLFormElement)
    })

    document.body.appendChild(this.element)
  }

  dispose(): void {
    this.clearOverlay()
    this.hide()
    this.element.remove()
  }

  isVisible(): boolean {
    return this.visible
  }

  /** True while upload + Worlds deploy round-trip is in progress. */
  isPublishLocked(): boolean {
    return this.publishLocked
  }

  toggle(): void {
    if (this.publishLocked) return
    if (this.visible) this.hide()
    else void this.show()
  }

  async show(): Promise<void> {
    this.visible = true
    if (!this.publishLocked) this.view = 'catalog'
    this.element.hidden = false
    window.addEventListener('keydown', this.onKeyDown)
    this.startPoll()
    // Paint cached catalog immediately if warm from client boot.
    const cached = getCachedPetBarnCatalog()
    if (cached) {
      this.catalog = cached
      this.lastUpdatedAt = cached.updatedAt
      await this.render()
    }
    await this.refreshCatalog()
    await this.render()
  }

  hide(): void {
    if (!this.visible) return
    if (this.publishLocked) return
    if (this.overlayMode === 'error' || this.overlayMode === 'success') this.dismissOverlay()
    this.visible = false
    this.element.hidden = true
    window.removeEventListener('keydown', this.onKeyDown)
    this.stopPoll()
    this.options.onClose?.()
  }

  private setPublishLocked(locked: boolean): void {
    const was = this.publishLocked
    this.publishLocked = locked
    this.panelEl.classList.toggle('is-publish-locked', locked)
    this.closeBtn.disabled = locked
    this.myPetsBtn.disabled = locked
    this.closeBtn.setAttribute('aria-disabled', locked ? 'true' : 'false')
    this.myPetsBtn.setAttribute('aria-disabled', locked ? 'true' : 'false')
    if (was !== locked) this.options.onPublishLockChange?.(locked)
  }

  private showLoadingOverlay(text: string, title = 'Publishing…'): void {
    this.overlayMode = 'loading'
    this.overlayEl.hidden = false
    this.overlayEl.classList.remove('is-error', 'is-success')
    this.overlayCardEl.classList.remove('is-error', 'is-success')
    this.overlaySpinnerEl.hidden = false
    const errIcon = this.overlayEl.querySelector<HTMLElement>('[data-overlay-error-icon]')
    if (errIcon) errIcon.hidden = true
    this.overlayDismissEl.hidden = true
    this.overlayTitleEl.textContent = title
    this.overlayTextEl.textContent = text
    this.setPublishLocked(true)
  }

  private showErrorOverlay(message: string, title = 'Publish failed'): void {
    this.overlayMode = 'error'
    this.overlayEl.hidden = false
    this.overlayEl.classList.add('is-error')
    this.overlayEl.classList.remove('is-success')
    this.overlayCardEl.classList.add('is-error')
    this.overlayCardEl.classList.remove('is-success')
    this.overlaySpinnerEl.hidden = true
    const errIcon = this.overlayEl.querySelector<HTMLElement>('[data-overlay-error-icon]')
    if (errIcon) errIcon.hidden = false
    this.overlayDismissEl.hidden = false
    this.overlayDismissEl.textContent = 'Dismiss'
    this.overlayTitleEl.textContent = title
    this.overlayTextEl.textContent = message
    // Unlock HUD / nav so user can leave; overlay stays until dismiss
    this.setPublishLocked(false)
    this.setStatus('')
  }

  private showSuccessOverlay(
    message = 'Queued for Worlds deploy. Catalog updates after GitHub Action finishes.',
    title = 'Published'
  ): void {
    this.overlayMode = 'success'
    this.overlayEl.hidden = false
    this.overlayEl.classList.add('is-success')
    this.overlayEl.classList.remove('is-error')
    this.overlayCardEl.classList.add('is-success')
    this.overlayCardEl.classList.remove('is-error')
    this.overlaySpinnerEl.hidden = true
    const errIcon = this.overlayEl.querySelector<HTMLElement>('[data-overlay-error-icon]')
    if (errIcon) errIcon.hidden = true
    this.overlayDismissEl.hidden = false
    this.overlayDismissEl.textContent = 'Done'
    this.overlayTitleEl.textContent = title
    this.overlayTextEl.textContent = message
    this.setPublishLocked(false)
    this.setStatus('')
  }

  private dismissOverlay(): void {
    const wasSuccess = this.overlayMode === 'success'
    this.clearOverlay()
    if (wasSuccess && this.view === 'publish') {
      this.view = 'catalog'
      void this.refreshCatalog().then(() => {
        this.lastUpdatedAt = this.catalog?.updatedAt ?? this.lastUpdatedAt
        if (this.visible) this.renderCatalog()
      })
    }
  }

  private clearOverlay(): void {
    this.overlayMode = 'none'
    this.overlayEl.hidden = true
    this.overlayEl.classList.remove('is-error', 'is-success')
    this.overlayCardEl.classList.remove('is-error', 'is-success')
    this.overlaySpinnerEl.hidden = false
    const errIcon = this.overlayEl.querySelector<HTMLElement>('[data-overlay-error-icon]')
    if (errIcon) errIcon.hidden = true
    this.overlayDismissEl.hidden = true
    this.overlayDismissEl.textContent = 'Dismiss'
    this.setPublishLocked(false)
  }

  private startPoll(): void {
    this.stopPoll()
    this.pollTimer = setInterval(() => {
      if (!this.visible || this.view !== 'catalog') return
      void this.refreshCatalog().then(() => {
        if (this.catalog && this.catalog.updatedAt !== this.lastUpdatedAt) {
          this.lastUpdatedAt = this.catalog.updatedAt
          void this.render()
        }
      })
    }, PETBARN_POLL_MS)
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private setStatus(msg: string): void {
    this.statusEl.hidden = !msg
    this.statusEl.textContent = msg
  }

  private wallet(): string | null {
    return this.options.getSession().getAddress()?.toLowerCase() ?? null
  }

  private displayName(): string {
    const profile = this.options.getSession().getProfile()
    const name = profile?.displayName?.trim()
    if (name) return name.slice(0, 64)
    const addr = this.wallet()
    return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : ''
  }

  private async refreshCatalog(opts?: { manual?: boolean }): Promise<void> {
    const manual = opts?.manual === true
    if (manual) {
      if (this.refreshing) return
      this.refreshing = true
      this.syncRefreshButton()
    }
    try {
      this.catalog = await fetchPetBarnCatalog()
      this.lastUpdatedAt = this.catalog.updatedAt
      if (manual) this.setStatus('')
    } catch (err) {
      console.warn('[petBarn] catalog fetch failed', err)
      const msg = err instanceof Error ? err.message : 'Failed to load catalog'
      if (!this.catalog || manual) this.setStatus(msg)
    } finally {
      if (manual) {
        this.refreshing = false
        this.syncRefreshButton()
      }
    }
  }

  private syncRefreshButton(): void {
    const btn = this.bodyEl.querySelector<HTMLButtonElement>('[data-refresh-catalog]')
    if (!btn) return
    btn.disabled = this.refreshing || this.publishLocked
    btn.classList.toggle('is-busy', this.refreshing)
    btn.setAttribute('aria-busy', this.refreshing ? 'true' : 'false')
    btn.title = this.refreshing ? 'Refreshing…' : 'Refresh catalog'
  }

  private async render(): Promise<void> {
    if (this.view === 'publish') {
      this.renderPublish()
      return
    }
    this.renderCatalog()
  }

  private toolbarHtml(): string {
    const q = escapeHtml(this.searchQuery)
    const refreshBusy = this.refreshing ? ' is-busy' : ''
    const refreshDisabled = this.refreshing || this.publishLocked ? ' disabled' : ''
    return `
      <div class="petbarn-toolbar">
        <div class="petbarn-filters">
          <button type="button" class="petbarn-filter${this.filter === 'all' ? ' is-active' : ''}" data-filter="all">All</button>
          <button type="button" class="petbarn-filter${this.filter === 'walking' ? ' is-active' : ''}" data-filter="walking">Walking</button>
          <button type="button" class="petbarn-filter${this.filter === 'flying' ? ' is-active' : ''}" data-filter="flying">Flying</button>
        </div>
        <div class="petbarn-toolbar__actions">
          <button
            type="button"
            class="petbarn-refresh-chip${refreshBusy}"
            data-refresh-catalog
            title="${this.refreshing ? 'Refreshing…' : 'Refresh catalog'}"
            aria-label="Refresh catalog"
            aria-busy="${this.refreshing ? 'true' : 'false'}"
            ${refreshDisabled}
          >↻</button>
          <button type="button" class="petbarn-publish-chip" data-open-publish>Publish</button>
        </div>
      </div>
      <div class="petbarn-search-wrap">
        <input
          type="search"
          class="petbarn-search"
          data-search
          placeholder="Search pets or creators…"
          value="${q}"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
    `
  }

  private filteredPets(): PetBarnListing[] {
    const q = this.searchQuery.trim().toLowerCase()
    return (this.catalog?.pets ?? []).filter((p) => {
      if (this.filter !== 'all' && p.type !== this.filter) return false
      if (!q) return true
      const hay = `${p.petName} ${p.creatorName}`.toLowerCase()
      return hay.includes(q)
    })
  }

  private renderCatalog(): void {
    const toolbar = this.toolbarHtml()
    const base = this.catalog?.contentBaseUrl ?? ''
    const pets = this.filteredPets()

    if (!this.catalog) {
      this.bodyEl.innerHTML = `${toolbar}<div class="pets-panel__empty">Loading catalog…</div>`
      return
    }
    if (!(this.catalog.pets ?? []).length) {
      this.bodyEl.innerHTML = `${toolbar}<div class="pets-panel__empty">No pets in the barn yet. Be the first to Publish.</div>`
      return
    }
    if (!pets.length) {
      this.bodyEl.innerHTML = `${toolbar}<div class="pets-panel__empty">No pets match your filters.</div>`
      return
    }

    const cards = pets
      .slice()
      .sort((a, b) =>
        a.petName.localeCompare(b.petName, undefined, { sensitivity: 'base' })
      )
      .map((p) => this.cardHtml(p, base))
      .join('')

    this.bodyEl.innerHTML = `
      ${toolbar}
      <div class="petbarn-grid">${cards}</div>
    `
  }

  private cardHtml(p: PetBarnListing, contentBaseUrl: string): string {
    const thumbUrl = petBarnContentUrl(contentBaseUrl, p.thumbnailCid)
    const added = isPetBarnAdded(p.id)
    const typeLabel = p.type === 'flying' ? 'Flying' : 'Walking'
    const anims = p.animationCount ?? 0
    return `
      <article class="petbarn-card${added ? ' is-added' : ''}" data-barn-id="${escapeHtml(p.id)}">
        <div class="petbarn-card__thumb-wrap">
          <img
            class="petbarn-card__thumb"
            src="${escapeHtml(thumbUrl)}"
            alt=""
            loading="lazy"
            decoding="async"
            width="160"
            height="160"
          />
        </div>
        <div class="petbarn-card__info">
          <div class="petbarn-card__name">${escapeHtml(p.petName)}</div>
          <div class="petbarn-card__meta">${escapeHtml(p.creatorName)} · ${typeLabel}</div>
          <div class="petbarn-card__meta">${anims} anim${anims === 1 ? '' : 's'}</div>
        </div>
        <button
          type="button"
          class="petbarn-card__add"
          data-add="${escapeHtml(p.id)}"
          ${added ? 'disabled' : ''}
        >${added ? 'Added' : 'Add'}</button>
        <div class="petbarn-card__overlay" data-card-overlay hidden>
          <div class="petbarn-card__overlay-inner">
            <div class="petbarn-card__spinner" data-card-spinner aria-hidden="true"></div>
            <p class="petbarn-card__overlay-msg" data-card-overlay-msg></p>
            <button type="button" class="petbarn-card__overlay-close" data-card-overlay-close hidden>
              Close
            </button>
          </div>
        </div>
      </article>
    `
  }

  private setCardOverlay(
    card: HTMLElement,
    state: 'loading' | 'success' | 'error',
    message: string
  ): void {
    const overlay = card.querySelector<HTMLElement>('[data-card-overlay]')
    const spinner = card.querySelector<HTMLElement>('[data-card-spinner]')
    const msg = card.querySelector<HTMLElement>('[data-card-overlay-msg]')
    const close = card.querySelector<HTMLButtonElement>('[data-card-overlay-close]')
    if (!overlay || !msg) return
    overlay.hidden = false
    card.classList.add('has-overlay')
    overlay.dataset.state = state
    msg.textContent = message
    if (spinner) spinner.hidden = state !== 'loading'
    if (close) close.hidden = state === 'loading'
  }

  private clearCardOverlay(card: HTMLElement): void {
    const overlay = card.querySelector<HTMLElement>('[data-card-overlay]')
    if (!overlay) return
    overlay.hidden = true
    delete overlay.dataset.state
    card.classList.remove('has-overlay')
  }

  private renderPublish(): void {
    const creatorDefault = escapeHtml(this.displayName())
    const glbLabel = this.glbFile
      ? `${this.glbFile.name} · ${formatPetByteSize(this.glbFile.size)}`
      : 'Drop .glb here or click to browse'
    const thumbLabel = this.thumbFile
      ? `${this.thumbFile.name} · ${formatPetByteSize(this.thumbFile.size)}`
      : 'Drop image here or click to browse'
    this.bodyEl.innerHTML = `
      <div class="petbarn-publish-head">
        <button type="button" class="petbarn-back-catalog" data-back-catalog>← Catalog</button>
      </div>
      <form class="petbarn-publish" data-publish-form>
        <label class="petbarn-field">
          <span>Pet name</span>
          <input type="text" name="petName" maxlength="64" required placeholder="Spark" />
        </label>
        <label class="petbarn-field">
          <span>Creator name</span>
          <input type="text" name="creatorName" maxlength="64" required value="${creatorDefault}" placeholder="Your name" />
        </label>
        <div class="petbarn-field">
          <span>Type</span>
          <div class="petbarn-type-row">
            <button type="button" class="petbarn-filter${this.publishType === 'walking' ? ' is-active' : ''}" data-pub-type="walking">Walking</button>
            <button type="button" class="petbarn-filter${this.publishType === 'flying' ? ' is-active' : ''}" data-pub-type="flying">Flying</button>
          </div>
        </div>
        <div class="petbarn-field">
          <span>3D model · max ${formatPetByteSize(PETBARN_MAX_GLB_BYTES)}</span>
          <div
            class="petbarn-dropzone${this.glbFile ? ' has-file' : ''}"
            data-dropzone="glb"
            tabindex="0"
            role="button"
            aria-label="Upload GLB model"
          >
            <input type="file" name="glb" accept=".glb,model/gltf-binary" hidden data-glb />
            <div class="petbarn-dropzone__icon" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M12 3v10m0 0 3.5-3.5M12 13 8.5 9.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M5 16.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="petbarn-dropzone__title">GLB model</div>
            <div class="petbarn-dropzone__hint" data-glb-label>${escapeHtml(glbLabel)}</div>
          </div>
        </div>
        <div class="petbarn-field">
          <span>Thumbnail · compressed to ≤ ${formatPetByteSize(PETBARN_MAX_THUMB_BYTES)}</span>
          <div
            class="petbarn-dropzone petbarn-dropzone--thumb${this.thumbFile ? ' has-file' : ''}"
            data-dropzone="thumb"
            tabindex="0"
            role="button"
            aria-label="Upload thumbnail image"
          >
            <input type="file" name="thumb" accept="image/*" hidden data-thumb />
            <div class="petbarn-dropzone__preview" data-thumb-preview hidden></div>
            <div class="petbarn-dropzone__icon" data-thumb-icon aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" stroke-width="1.7"/>
                <circle cx="9" cy="10.5" r="1.6" fill="currentColor"/>
                <path d="M5.5 17.5 10 13l3 3 2.5-2.5 3 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div class="petbarn-dropzone__title">Thumbnail</div>
            <div class="petbarn-dropzone__hint" data-thumb-label>${escapeHtml(thumbLabel)}</div>
          </div>
        </div>
        <button type="submit" class="petbarn-publish-btn" data-publish-submit>Publish to Pet Barn</button>
      </form>
    `
    this.bindDropzones()
    void this.refreshThumbPreview()
  }

  private bindDropzones(): void {
    for (const zone of this.bodyEl.querySelectorAll<HTMLElement>('[data-dropzone]')) {
      const kind = zone.dataset.dropzone as 'glb' | 'thumb'
      const input = zone.querySelector<HTMLInputElement>(
        kind === 'glb' ? '[data-glb]' : '[data-thumb]'
      )
      if (!input) continue

      const openPicker = () => {
        if (this.publishLocked) return
        input.click()
      }

      zone.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).closest('input')) return
        openPicker()
      })
      zone.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault()
          openPicker()
        }
      })

      zone.addEventListener('dragenter', (ev) => {
        ev.preventDefault()
        zone.classList.add('is-dragover')
      })
      zone.addEventListener('dragover', (ev) => {
        ev.preventDefault()
        zone.classList.add('is-dragover')
      })
      zone.addEventListener('dragleave', (ev) => {
        if (!zone.contains(ev.relatedTarget as Node)) {
          zone.classList.remove('is-dragover')
        }
      })
      zone.addEventListener('drop', (ev) => {
        ev.preventDefault()
        zone.classList.remove('is-dragover')
        if (this.publishLocked) return
        const file = ev.dataTransfer?.files?.[0]
        if (!file) return
        void this.applyPublishFile(kind, file)
      })
    }
  }

  private async applyPublishFile(kind: 'glb' | 'thumb', file: File): Promise<void> {
    if (kind === 'glb') {
      const name = file.name.toLowerCase()
      if (!name.endsWith('.glb') && !name.endsWith('.gltf')) {
        this.setStatus('Model must be a .glb file')
        return
      }
      if (file.size > PETBARN_MAX_GLB_BYTES) {
        this.setStatus(`GLB must be ≤ ${formatPetByteSize(PETBARN_MAX_GLB_BYTES)}`)
        return
      }
      this.glbFile = file
      this.setStatus('')
      this.updateGlbDropzoneUi()
      return
    }

    if (!file.type.startsWith('image/') && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
      this.setStatus('Thumbnail must be an image')
      return
    }
    this.thumbFile = file
    this.setStatus('')
    this.updateThumbDropzoneUi()
    await this.refreshThumbPreview()
  }

  private updateGlbDropzoneUi(): void {
    const zone = this.bodyEl.querySelector<HTMLElement>('[data-dropzone="glb"]')
    const label = this.bodyEl.querySelector<HTMLElement>('[data-glb-label]')
    if (!zone || !label) return
    zone.classList.toggle('has-file', !!this.glbFile)
    label.textContent = this.glbFile
      ? `${this.glbFile.name} · ${formatPetByteSize(this.glbFile.size)}`
      : 'Drop .glb here or click to browse'
  }

  private updateThumbDropzoneUi(): void {
    const zone = this.bodyEl.querySelector<HTMLElement>('[data-dropzone="thumb"]')
    const label = this.bodyEl.querySelector<HTMLElement>('[data-thumb-label]')
    if (!zone || !label) return
    zone.classList.toggle('has-file', !!this.thumbFile)
    label.textContent = this.thumbFile
      ? `${this.thumbFile.name} · ${formatPetByteSize(this.thumbFile.size)}`
      : 'Drop image here or click to browse'
  }

  private async refreshThumbPreview(): Promise<void> {
    const preview = this.bodyEl.querySelector<HTMLElement>('[data-thumb-preview]')
    const icon = this.bodyEl.querySelector<HTMLElement>('[data-thumb-icon]')
    if (!preview) return
    preview.replaceChildren()
    if (!this.thumbFile) {
      preview.hidden = true
      if (icon) icon.hidden = false
      return
    }
    const url = URL.createObjectURL(this.thumbFile)
    const img = document.createElement('img')
    img.className = 'petbarn-dropzone__preview-img'
    img.alt = ''
    img.src = url
    img.onload = () => URL.revokeObjectURL(url)
    img.onerror = () => URL.revokeObjectURL(url)
    preview.appendChild(img)
    preview.hidden = false
    if (icon) icon.hidden = true
  }

  private onBodyInput(ev: Event): void {
    const t = ev.target as HTMLInputElement
    if (t.matches?.('[data-search]')) {
      this.searchQuery = t.value
      // Re-filter without full remount of search (keep focus): rebuild grid only
      this.renderCatalogPreservingSearchFocus()
    }
  }

  private renderCatalogPreservingSearchFocus(): void {
    const active = document.activeElement
    const wasSearch = active?.matches?.('[data-search]')
    const selStart = wasSearch ? (active as HTMLInputElement).selectionStart : null
    const selEnd = wasSearch ? (active as HTMLInputElement).selectionEnd : null
    this.renderCatalog()
    if (wasSearch) {
      const input = this.bodyEl.querySelector<HTMLInputElement>('[data-search]')
      if (input) {
        input.focus()
        if (selStart != null && selEnd != null) {
          try {
            input.setSelectionRange(selStart, selEnd)
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  private onBodyChange(ev: Event): void {
    const t = ev.target as HTMLInputElement
    if (t.matches?.('[data-glb]')) {
      const file = t.files?.[0]
      if (file) void this.applyPublishFile('glb', file)
      else {
        this.glbFile = null
        this.updateGlbDropzoneUi()
      }
      return
    }
    if (t.matches?.('[data-thumb]')) {
      const file = t.files?.[0]
      if (file) void this.applyPublishFile('thumb', file)
      else {
        this.thumbFile = null
        this.updateThumbDropzoneUi()
        void this.refreshThumbPreview()
      }
    }
  }

  private async onBodyClick(ev: MouseEvent): Promise<void> {
    const t = ev.target as HTMLElement

    if (this.publishLocked) return

    if (t.closest('[data-refresh-catalog]')) {
      void this.handleManualRefresh()
      return
    }

    if (t.closest('[data-open-publish]')) {
      this.view = 'publish'
      void this.render()
      return
    }

    if (t.closest('[data-back-catalog]')) {
      this.view = 'catalog'
      void this.render()
      return
    }

    const filterBtn = t.closest<HTMLElement>('[data-filter]')
    if (filterBtn) {
      const f = filterBtn.dataset.filter as 'all' | PetCategory
      if (f === 'all' || f === 'walking' || f === 'flying') {
        this.filter = f
        this.renderCatalogPreservingSearchFocus()
      }
      return
    }

    const pubType = t.closest<HTMLElement>('[data-pub-type]')
    if (pubType) {
      const ty = pubType.dataset.pubType as PetCategory
      if (ty === 'walking' || ty === 'flying') {
        this.publishType = ty
        this.renderPublish()
      }
      return
    }

    const closeOverlay = t.closest<HTMLElement>('[data-card-overlay-close]')
    if (closeOverlay) {
      const card = closeOverlay.closest<HTMLElement>('.petbarn-card')
      if (card) {
        this.clearCardOverlay(card)
        const addBtn = card.querySelector<HTMLButtonElement>('[data-add]')
        if (addBtn && isPetBarnAdded(card.dataset.barnId || '')) {
          addBtn.disabled = true
          addBtn.textContent = 'Added'
          card.classList.add('is-added')
        }
      }
      return
    }

    const addBtn = t.closest<HTMLElement>('[data-add]')
    if (addBtn) {
      const id = addBtn.dataset.add
      if (id) await this.handleAdd(id, addBtn)
      return
    }
  }

  private async handleManualRefresh(): Promise<void> {
    if (this.refreshing || this.publishLocked) return
    await this.refreshCatalog({ manual: true })
    if (this.view === 'catalog' && this.visible) {
      this.renderCatalogPreservingSearchFocus()
    }
  }

  private async handleAdd(barnId: string, btn: HTMLElement): Promise<void> {
    if (this.busy) return
    const listing = this.catalog?.pets.find((p) => p.id === barnId)
    const card = btn.closest<HTMLElement>('.petbarn-card')
    if (!listing || !this.catalog) {
      if (card) this.setCardOverlay(card, 'error', 'Listing not found in catalog')
      return
    }
    this.busy = true
    btn.setAttribute('disabled', 'true')
    if (card) this.setCardOverlay(card, 'loading', 'Adding…')
    try {
      const result = await addPetFromBarn(listing, this.catalog.contentBaseUrl, this.wallet())
      if (!result.ok) {
        if (card) this.setCardOverlay(card, 'error', result.error)
        else this.setStatus(result.error)
        btn.removeAttribute('disabled')
        return
      }
      const msg = result.alreadyAdded
        ? `${listing.petName} is already in your pets.`
        : `Added ${listing.petName} to your pets.`
      if (card) this.setCardOverlay(card, 'success', msg)
      btn.textContent = 'Added'
      await this.options.onAddedToLibrary?.()
    } finally {
      this.busy = false
    }
  }

  private async handlePublish(form: HTMLFormElement): Promise<void> {
    if (this.busy || this.publishLocked) return
    const fd = new FormData(form)
    const petName = String(fd.get('petName') || '')
    const creatorName = String(fd.get('creatorName') || '')
    const glb =
      this.glbFile ||
      (form.querySelector<HTMLInputElement>('[data-glb]')?.files?.[0] ?? null)
    const thumb =
      this.thumbFile ||
      (form.querySelector<HTMLInputElement>('[data-thumb]')?.files?.[0] ?? null)
    if (!petName.trim() || !creatorName.trim()) {
      this.showErrorOverlay('Pet name and creator name are required.', 'Missing info')
      return
    }
    if (!glb || !thumb) {
      this.showErrorOverlay('Add a GLB model and a thumbnail image before publishing.', 'Missing files')
      return
    }

    this.busy = true
    this.showLoadingOverlay('Compressing thumbnail & uploading…')
    const submitBtn = form.querySelector<HTMLButtonElement>('[data-publish-submit]')
    if (submitBtn) submitBtn.disabled = true

    try {
      const result = await submitPetBarnListing({
        petName,
        creatorName,
        type: this.publishType,
        glb,
        thumb,
        wallet: this.wallet() || undefined
      })
      if (!result.ok) {
        this.showErrorOverlay(result.error, 'Publish failed')
        return
      }

      // Success = Worker accepted the queue (GitHub commit). Worlds deploy is async CI.
      this.glbFile = null
      this.thumbFile = null
      this.showSuccessOverlay(
        'Queued for Worlds deploy. Catalog updates after GitHub Action finishes.',
        'Published'
      )
    } catch (err) {
      this.showErrorOverlay(err instanceof Error ? err.message : 'Publish failed', 'Publish failed')
    } finally {
      this.busy = false
      if (submitBtn) submitBtn.disabled = false
    }
  }
}
