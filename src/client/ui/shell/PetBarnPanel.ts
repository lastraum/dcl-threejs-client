import type { SessionIdentity } from '../../../network/SessionIdentity'
import {
  PETBARN_MAX_GLB_BYTES,
  PETBARN_MAX_THUMB_BYTES,
  PETBARN_POLL_MS,
  PETBARN_PUBLISH_POLL_MS,
  PETBARN_PUBLISH_TIMEOUT_MS,
  addPetFromBarn,
  fetchPetBarnCatalog,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  private readonly panelEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly overlayEl: HTMLElement
  private readonly overlayTextEl: HTMLElement
  private readonly closeBtn: HTMLButtonElement
  private readonly myPetsBtn: HTMLButtonElement
  private readonly onKeyDown: (ev: KeyboardEvent) => void

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
          <div class="petbarn-overlay__card" role="status" aria-live="polite">
            <div class="petbarn-overlay__spinner" aria-hidden="true"></div>
            <p class="petbarn-overlay__title" data-overlay-title>Publishing…</p>
            <p class="petbarn-overlay__text" data-overlay-text>Please wait</p>
          </div>
        </div>
      </div>
    `
    this.panelEl = this.element.querySelector('.petbarn-panel')!
    this.bodyEl = this.element.querySelector('[data-body]')!
    this.statusEl = this.element.querySelector('[data-status]')!
    this.overlayEl = this.element.querySelector('[data-publish-overlay]')!
    this.overlayTextEl = this.element.querySelector('[data-overlay-text]')!
    this.closeBtn = this.element.querySelector('[data-close]')!
    this.myPetsBtn = this.element.querySelector('[data-my-pets]')!

    this.closeBtn.addEventListener('click', () => this.hide())
    this.myPetsBtn.addEventListener('click', () => {
      if (this.publishLocked) return
      this.hide()
      this.options.onOpenMyPets?.()
    })
    this.bodyEl.addEventListener('click', (ev) => void this.onBodyClick(ev))
    this.bodyEl.addEventListener('change', (ev) => this.onBodyChange(ev))
    this.bodyEl.addEventListener('input', (ev) => this.onBodyInput(ev))

    this.onKeyDown = (ev) => {
      if (ev.key !== 'Escape' || !this.visible) return
      if (this.publishLocked) {
        ev.preventDefault()
        ev.stopPropagation()
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
    this.setPublishLocked(false)
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
    await this.refreshCatalog()
    await this.render()
  }

  hide(): void {
    if (!this.visible) return
    if (this.publishLocked) return
    this.visible = false
    this.element.hidden = true
    window.removeEventListener('keydown', this.onKeyDown)
    this.stopPoll()
    this.options.onClose?.()
  }

  private setPublishLocked(locked: boolean, overlayText?: string): void {
    const was = this.publishLocked
    this.publishLocked = locked
    this.panelEl.classList.toggle('is-publish-locked', locked)
    this.overlayEl.hidden = !locked
    this.closeBtn.disabled = locked
    this.myPetsBtn.disabled = locked
    this.closeBtn.setAttribute('aria-disabled', locked ? 'true' : 'false')
    this.myPetsBtn.setAttribute('aria-disabled', locked ? 'true' : 'false')
    if (locked && overlayText) this.setOverlayMessage(overlayText)
    if (!locked) {
      const title = this.overlayEl.querySelector<HTMLElement>('[data-overlay-title]')
      if (title) title.textContent = 'Publishing…'
    }
    if (was !== locked) this.options.onPublishLockChange?.(locked)
  }

  private setOverlayMessage(text: string, title = 'Publishing…'): void {
    const titleEl = this.overlayEl.querySelector<HTMLElement>('[data-overlay-title]')
    if (titleEl) titleEl.textContent = title
    this.overlayTextEl.textContent = text
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

  private async refreshCatalog(): Promise<void> {
    try {
      this.catalog = await fetchPetBarnCatalog()
      if (!this.lastUpdatedAt) this.lastUpdatedAt = this.catalog.updatedAt
    } catch (err) {
      console.warn('[petBarn] catalog fetch failed', err)
      if (!this.catalog) {
        this.setStatus(err instanceof Error ? err.message : 'Failed to load catalog')
      }
    }
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
    return `
      <div class="petbarn-toolbar">
        <div class="petbarn-filters">
          <button type="button" class="petbarn-filter${this.filter === 'all' ? ' is-active' : ''}" data-filter="all">All</button>
          <button type="button" class="petbarn-filter${this.filter === 'walking' ? ' is-active' : ''}" data-filter="walking">Walking</button>
          <button type="button" class="petbarn-filter${this.filter === 'flying' ? ' is-active' : ''}" data-filter="flying">Flying</button>
        </div>
        <button type="button" class="petbarn-publish-chip" data-open-publish>Publish</button>
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
      .sort((a, b) => (b.deployedAt || '').localeCompare(a.deployedAt || ''))
      .map((p) => this.cardHtml(p, base))
      .join('')

    this.bodyEl.innerHTML = `
      ${toolbar}
      <div class="petbarn-grid">${cards}</div>
      <p class="petbarn-footnote">Thumbnails only — GLB downloads when you Add.</p>
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
          <div class="petbarn-card__meta">${anims} anim${anims === 1 ? '' : 's'} · ${formatPetByteSize(p.sizeBytes || 0)}</div>
        </div>
        <button
          type="button"
          class="petbarn-card__add"
          data-add="${escapeHtml(p.id)}"
          ${added ? 'disabled' : ''}
        >${added ? 'Added' : 'Add'}</button>
      </article>
    `
  }

  private renderPublish(): void {
    const creatorDefault = escapeHtml(this.displayName())
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
        <label class="petbarn-field">
          <span>GLB (max ${formatPetByteSize(PETBARN_MAX_GLB_BYTES)})</span>
          <input type="file" name="glb" accept=".glb,model/gltf-binary" required data-glb />
        </label>
        <label class="petbarn-field">
          <span>Thumbnail (compressed to ≤ ${formatPetByteSize(PETBARN_MAX_THUMB_BYTES)})</span>
          <input type="file" name="thumb" accept="image/*" required data-thumb />
        </label>
        <p class="petbarn-footnote">Open publish — deploys to petbarn.dcl.eth after CI. No approval step.</p>
        <button type="submit" class="petbarn-publish-btn" data-publish-submit>Publish to Pet Barn</button>
      </form>
    `
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
      this.glbFile = t.files?.[0] ?? null
    }
    if (t.matches?.('[data-thumb]')) {
      this.thumbFile = t.files?.[0] ?? null
    }
  }

  private async onBodyClick(ev: MouseEvent): Promise<void> {
    const t = ev.target as HTMLElement

    if (this.publishLocked) return

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

    const addBtn = t.closest<HTMLElement>('[data-add]')
    if (addBtn) {
      const id = addBtn.dataset.add
      if (id) await this.handleAdd(id, addBtn)
      return
    }
  }

  private async handleAdd(barnId: string, btn: HTMLElement): Promise<void> {
    if (this.busy) return
    const listing = this.catalog?.pets.find((p) => p.id === barnId)
    if (!listing || !this.catalog) {
      this.setStatus('Listing not found in catalog')
      return
    }
    this.busy = true
    btn.setAttribute('disabled', 'true')
    const prev = btn.textContent
    btn.textContent = '…'
    this.setStatus(`Downloading ${listing.petName}…`)
    try {
      const result = await addPetFromBarn(listing, this.catalog.contentBaseUrl, this.wallet())
      if (!result.ok) {
        this.setStatus(result.error)
        btn.textContent = prev
        btn.removeAttribute('disabled')
        return
      }
      this.setStatus(
        result.alreadyAdded
          ? `${listing.petName} already in your library.`
          : `Added ${listing.petName} to your pets.`
      )
      btn.textContent = 'Added'
      await this.options.onAddedToLibrary?.()
      if (this.view === 'catalog') this.renderCatalogPreservingSearchFocus()
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
    if (!glb || !thumb) {
      this.setStatus('GLB and thumbnail are required')
      return
    }

    this.busy = true
    this.setPublishLocked(true, 'Compressing thumbnail & uploading…')
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
        this.setPublishLocked(false)
        this.setStatus(result.error)
        return
      }

      this.glbFile = null
      this.thumbFile = null
      this.setOverlayMessage(
        `Queued as ${result.id}. Waiting for Worlds deploy…`,
        'Almost there…'
      )
      this.setStatus('')

      const listed = await this.waitForCatalogListing(result.id)
      if (listed) {
        this.setStatus(`${listed.petName} is live in the Pet Barn.`)
        this.setPublishLocked(false)
        this.view = 'catalog'
        this.searchQuery = ''
        this.filter = 'all'
        await this.refreshCatalog()
        this.lastUpdatedAt = this.catalog?.updatedAt ?? this.lastUpdatedAt
        this.renderCatalog()
        return
      }

      // Timeout — still unlock; pet may appear on next poll
      this.setPublishLocked(false)
      this.setStatus(
        `Queued ${result.id}, but catalog is still updating. Stay open or check back in a minute.`
      )
      this.view = 'catalog'
      await this.refreshCatalog()
      this.renderCatalog()
    } catch (err) {
      this.setPublishLocked(false)
      this.setStatus(err instanceof Error ? err.message : 'Publish failed')
    } finally {
      this.busy = false
      if (submitBtn) submitBtn.disabled = false
    }
  }

  /** Poll until barn id appears in catalog, or timeout. */
  private async waitForCatalogListing(id: string): Promise<PetBarnListing | null> {
    const deadline = Date.now() + PETBARN_PUBLISH_TIMEOUT_MS
    let attempt = 0
    while (Date.now() < deadline && this.visible && this.publishLocked) {
      attempt += 1
      try {
        const catalog = await fetchPetBarnCatalog()
        this.catalog = catalog
        const hit = catalog.pets.find((p) => p.id === id)
        if (hit) return hit
      } catch (err) {
        console.warn('[petBarn] publish wait catalog poll failed', err)
      }
      const leftSec = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      this.setOverlayMessage(
        `Deploying to petbarn.dcl.eth… (check ${attempt}, ~${leftSec}s left)`,
        'Deploying…'
      )
      await sleep(PETBARN_PUBLISH_POLL_MS)
    }
    return null
  }
}
