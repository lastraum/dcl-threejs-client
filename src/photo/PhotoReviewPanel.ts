/**
 * Post-capture review: ~3/4 photo preview + ~1/4 Explorer-style detail rail
 * (place, people accordion with wearables, Share / Download / Scrap).
 */

import { fetchProfileFaceUrl } from '../avatar/peerApi'
import {
  fetchWearableDisplayCards,
  filterNonDefaultWearables,
  type WearableDisplayCard
} from '../client/ui/profile/wearableThumb'
import type { PhotoCaptureResult } from './photoCapture'
import { downloadPhotoCapture, sharePhotoCapture } from './photoCapture'
import {
  formatPhotoDate,
  marketplaceItemUrl,
  type PhotoMetadata,
  type PhotoVisiblePerson
} from './photoMetadata'

export type PhotoReviewHandlers = {
  onScrap: () => void
  /**
   * Save to DCL Camera Reel gallery only (no browser download).
   * Throw with a user-facing message on failure.
   */
  onSaveToGallery?: (result: PhotoCaptureResult) => Promise<void>
  onDownload?: (result: PhotoCaptureResult) => void
  onShare?: (result: PhotoCaptureResult) => void
  /** Catalyst / lambdas base for wearable thumbs. */
  peerUrl?: string
}

export class PhotoReviewPanel {
  readonly root: HTMLDivElement
  private result: PhotoCaptureResult | null = null
  private readonly peerUrl: string
  private expanded = new Set<string>()
  private wearableCache = new Map<string, WearableDisplayCard[]>()
  private loadingWearables = new Set<string>()
  private statusTimer = 0
  private saving = false
  private saved = false

  constructor(private readonly handlers: PhotoReviewHandlers) {
    this.peerUrl = (handlers.peerUrl ?? 'https://peer.decentraland.org').replace(/\/$/, '')
    this.root = document.createElement('div')
    this.root.id = 'photo-review'
    this.root.className = 'photo-review'
    this.root.hidden = true
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', 'Photo review')
    document.body.appendChild(this.root)

    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const btn = t.closest('[data-action]') as HTMLElement | null
      if (!btn) return
      const action = btn.getAttribute('data-action')
      if (action === 'scrap') {
        e.preventDefault()
        this.scrap()
      } else if (action === 'save') {
        e.preventDefault()
        void this.save()
      } else if (action === 'download') {
        e.preventDefault()
        this.download()
      } else if (action === 'share') {
        e.preventDefault()
        void this.share()
      } else if (action === 'toggle-person') {
        e.preventDefault()
        const addr = btn.getAttribute('data-address')
        if (addr) void this.togglePerson(addr)
      }
    })
  }

  isOpen(): boolean {
    return !this.root.hidden && !!this.result
  }

  open(result: PhotoCaptureResult): void {
    this.result = result
    this.saving = false
    this.saved = false
    this.expanded.clear()
    this.wearableCache.clear()
    this.loadingWearables.clear()
    // Expand first person by default (Explorer-style).
    const first = result.metadata.visiblePeople[0]
    if (first) {
      this.expanded.add(first.userAddress.toLowerCase())
      void this.ensureWearables(first)
    }
    this.render()
    this.root.hidden = false
    document.body.classList.add('photo-review-open')
    void this.resolveMissingFaces(result.metadata.visiblePeople)
  }

  private async resolveMissingFaces(people: PhotoVisiblePerson[]): Promise<void> {
    const lambdas = this.peerUrl.endsWith('/lambdas') ? this.peerUrl : `${this.peerUrl}/lambdas`
    await Promise.all(
      people.map(async (p) => {
        if (p.faceUrl) return
        const addr = p.userAddress?.toLowerCase()
        if (!addr || !addr.startsWith('0x')) return
        try {
          const url = await fetchProfileFaceUrl(addr, lambdas)
          if (url && this.result) {
            p.faceUrl = url
          }
        } catch {
          /* ignore */
        }
      })
    )
    if (this.isOpen()) this.render()
  }

  close(): void {
    this.result = null
    this.saving = false
    this.saved = false
    this.root.hidden = true
    this.root.innerHTML = ''
    document.body.classList.remove('photo-review-open')
    if (this.statusTimer) {
      window.clearTimeout(this.statusTimer)
      this.statusTimer = 0
    }
  }

  scrap(): void {
    this.close()
    this.handlers.onScrap()
  }

  /** Upload to DCL Camera Reel only — never triggers a local file download. */
  async save(): Promise<void> {
    if (!this.result || this.saving || this.saved) return
    if (!this.handlers.onSaveToGallery) {
      this.flashActionStatus('Gallery save unavailable')
      return
    }
    this.saving = true
    this.syncSaveButton()
    this.flashActionStatus('Saving to gallery…', false)
    try {
      await this.handlers.onSaveToGallery(this.result)
      this.saved = true
      this.flashActionStatus('Saved to gallery', false)
      this.syncSaveButton()
    } catch (err) {
      const msg = err instanceof Error && err.message.trim() ? err.message.trim() : 'Save failed'
      console.warn('[photo-review] gallery save failed', err)
      this.flashActionStatus(msg, false)
    } finally {
      this.saving = false
      this.syncSaveButton()
    }
  }

  download(): void {
    if (!this.result) return
    downloadPhotoCapture(this.result)
    this.handlers.onDownload?.(this.result)
    this.flashActionStatus('Downloaded')
  }

  private syncSaveButton(): void {
    const btn = this.root.querySelector('[data-action="save"]') as HTMLButtonElement | null
    if (!btn) return
    btn.disabled = this.saving || this.saved
    btn.textContent = this.saved ? 'Saved' : this.saving ? 'Saving…' : 'Save'
    btn.classList.toggle('is-saved', this.saved)
  }

  async share(): Promise<void> {
    if (!this.result) return
    try {
      const ok = await sharePhotoCapture(this.result)
      this.handlers.onShare?.(this.result)
      this.flashActionStatus(ok ? 'Shared' : 'Share unavailable — try Download')
    } catch (err) {
      console.warn('[photo-review] share failed', err)
      this.flashActionStatus('Share cancelled')
    }
  }

  dispose(): void {
    this.close()
    this.root.remove()
  }

  private flashActionStatus(text: string, autoClear = true): void {
    const el = this.root.querySelector('[data-action-status]') as HTMLElement | null
    if (!el) return
    el.textContent = text
    if (this.statusTimer) window.clearTimeout(this.statusTimer)
    this.statusTimer = 0
    if (!autoClear || !text) return
    this.statusTimer = window.setTimeout(() => {
      el.textContent = ''
      this.statusTimer = 0
    }, 2200)
  }

  private async togglePerson(address: string): Promise<void> {
    const key = address.toLowerCase()
    if (this.expanded.has(key)) this.expanded.delete(key)
    else this.expanded.add(key)
    const person = this.result?.metadata.visiblePeople.find(
      (p) => p.userAddress.toLowerCase() === key
    )
    if (person && this.expanded.has(key)) void this.ensureWearables(person)
    this.render()
  }

  private async ensureWearables(person: PhotoVisiblePerson): Promise<void> {
    const key = person.userAddress.toLowerCase()
    if (this.wearableCache.has(key) || this.loadingWearables.has(key)) return
    this.loadingWearables.add(key)
    try {
      // Camera Reel style: only non-default (no base-avatars hair/eyes/clothes).
      const urns = filterNonDefaultWearables(person.wearables ?? [])
      const cards = await fetchWearableDisplayCards(urns, this.peerUrl)
      this.wearableCache.set(key, cards)
    } catch (err) {
      console.warn('[photo-review] wearables failed', person.userName, err)
      this.wearableCache.set(key, [])
    } finally {
      this.loadingWearables.delete(key)
      if (this.isOpen()) this.render()
    }
  }

  private render(): void {
    const result = this.result
    if (!result) {
      this.root.innerHTML = ''
      return
    }
    const meta = result.metadata
    const dateLabel = formatPhotoDate(meta.dateTime)
    const placeLabel = meta.scene.name?.trim() || 'Unknown place'
    const parcelLabel = `${meta.scene.parcelX}, ${meta.scene.parcelY}`

    this.root.innerHTML = `
      <div class="photo-review__layout">
        <div class="photo-review__preview">
          <img class="photo-review__image" src="${escapeAttr(result.dataUrl)}" alt="Captured photo" draggable="false" />
        </div>
        <aside class="photo-review__rail">
          <header class="photo-review__header">
            <p class="photo-review__taken">${escapeHtml(dateLabel)} · Taken by <strong>${escapeHtml(meta.userName)}</strong></p>
          </header>

          <section class="photo-review__section">
            <h3 class="photo-review__section-label">Place</h3>
            <div class="photo-review__place">
              <span class="photo-review__place-pin" aria-hidden="true">📍</span>
              <div class="photo-review__place-text">
                <span class="photo-review__place-name">${escapeHtml(placeLabel)}</span>
                <span class="photo-review__place-parcel">${escapeHtml(parcelLabel)}</span>
              </div>
            </div>
          </section>

          <section class="photo-review__section photo-review__section--people">
            <h3 class="photo-review__section-label">People</h3>
            <div class="photo-review__people">
              ${this.renderPeople(meta)}
            </div>
          </section>

          <footer class="photo-review__footer">
            <span class="photo-review__action-status" data-action-status></span>
            <div class="photo-review__actions">
              <button type="button" class="photo-review__btn photo-review__btn--ghost" data-action="scrap">Scrap</button>
              <button type="button" class="photo-review__btn photo-review__btn--secondary" data-action="share">Share</button>
              <button type="button" class="photo-review__btn photo-review__btn--secondary" data-action="download">Download</button>
              <button type="button" class="photo-review__btn photo-review__btn--primary" data-action="save" ${
                this.saved || this.saving ? 'disabled' : ''
              }>${this.saved ? 'Saved' : this.saving ? 'Saving…' : 'Save'}</button>
            </div>
          </footer>
        </aside>
      </div>
    `
  }

  private renderPeople(meta: PhotoMetadata): string {
    const people = meta.visiblePeople
    if (!people.length) {
      return `<p class="photo-review__empty">No people in frame</p>`
    }
    return people.map((p) => this.renderPerson(p)).join('')
  }

  private renderPerson(person: PhotoVisiblePerson): string {
    const key = person.userAddress.toLowerCase()
    const open = this.expanded.has(key)
    const nameColor = person.nameColor?.trim() || '#7dffa8'
    const face = person.faceUrl
      ? `<img class="photo-review__avatar" src="${escapeAttr(person.faceUrl)}" alt="" />`
      : `<span class="photo-review__avatar photo-review__avatar--fallback" aria-hidden="true">${escapeHtml(
          (person.userName || '?').slice(0, 1).toUpperCase()
        )}</span>`
    const claimed = person.hasClaimedName
      ? `<span class="photo-review__claimed" title="Claimed name" aria-label="Claimed name">✓</span>`
      : ''

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
          person.userAddress
        )}" aria-expanded="${open ? 'true' : 'false'}">
          ${face}
          <span class="photo-review__person-name" style="color:${escapeAttr(nameColor)}">${escapeHtml(
            person.userName
          )}${claimed}</span>
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
          : `<span class="photo-review__buy photo-review__buy--disabled" title="Not listed on marketplace">—</span>`
        return `
          <div class="photo-review__item">
            <img class="photo-review__item-thumb" src="${escapeAttr(card.thumbnailUrl)}" alt="" loading="lazy" />
            <span class="photo-review__item-name" title="${escapeAttr(card.name)}">${escapeHtml(card.name)}</span>
            ${buy}
          </div>
        `
      })
      .join('')
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;')
}
