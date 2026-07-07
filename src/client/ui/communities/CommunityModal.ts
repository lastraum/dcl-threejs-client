import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import {
  communityThumbnailUrlOrCdnFallback,
  pickCommunityThumbnailUrl
} from '../../../social/memberCommunities'
import { fetchCommunityByIdPublic, fetchCommunityByIdSigned } from '../../../social/socialApi'
import type { CommunityDetail, CommunityListRow } from '../../../social/types'

const MEMBERS_ICON = `<svg class="community-modal-pill-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="9" cy="8" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 17c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="16.5" cy="9" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M13.5 17c.4-1.6 1.7-2.8 3.3-2.8 1 0 1.9.4 2.5 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`

export type CommunityModalOptions = {
  getAuthIdentity?: () => AuthIdentity | null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatMemberCount(count: number | undefined): string {
  if (typeof count !== 'number' || !Number.isFinite(count)) return 'Members'
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M members`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k members`
  return `${count} member${count === 1 ? '' : 's'}`
}

function ownerLabel(data: { ownerName?: string; ownerAddress?: string }): string {
  const name = data.ownerName?.trim()
  if (name) return name
  const addr = data.ownerAddress?.trim()
  if (addr && addr.length >= 10) return `${addr.slice(0, 6)}…${addr.slice(-4)}`
  return 'Community owner'
}

function descriptionParagraphs(raw: string | null | undefined): string[] {
  const text = raw?.trim()
  if (!text) return []
  return text
    .replace(/<[^>]+>/g, '')
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
}

function communityShareUrl(id: string): string {
  const base = `${window.location.origin}/communities`
  return `${base}#${encodeURIComponent(id.trim())}`
}

function mergePreviewAndDetail(preview: CommunityListRow, detail: CommunityDetail | null): CommunityDetail {
  if (!detail) {
    return {
      id: preview.id,
      name: preview.name,
      description: preview.description?.trim() ?? '',
      thumbnails: preview.thumbnails,
      isPrivate: preview.isPrivate,
      memberCount: preview.memberCount,
      ownerAddress: preview.ownerAddress,
      ownerName: preview.ownerName,
      role: preview.role
    }
  }
  return {
    ...detail,
    thumbnails: { ...preview.thumbnails, ...detail.thumbnails },
    memberCount: detail.memberCount ?? preview.memberCount,
    isPrivate: detail.isPrivate ?? preview.isPrivate,
    ownerName: detail.ownerName ?? preview.ownerName,
    ownerAddress: detail.ownerAddress ?? preview.ownerAddress
  }
}

/** Companion-style community info dialog — about, owner, member count (Phase 2.5 lite). */
export class CommunityModal {
  readonly root: HTMLElement

  private readonly getAuthIdentity?: () => AuthIdentity | null
  private readonly onKeyDown: (ev: KeyboardEvent) => void
  private openGen = 0
  private disposed = false

  constructor(opts: CommunityModalOptions = {}) {
    this.getAuthIdentity = opts.getAuthIdentity

    this.root = document.createElement('div')
    this.root.className = 'community-modal-host'
    this.root.hidden = true

    this.onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') this.close()
    }
  }

  mount(): void {
    document.body.appendChild(this.root)
  }

  open(preview: CommunityListRow): void {
    if (this.disposed) return
    const gen = ++this.openGen
    const merged = mergePreviewAndDetail(preview, null)
    this.root.hidden = false
    this.root.innerHTML = this.render(merged, { loading: true })
    this.wire(merged)
    document.addEventListener('keydown', this.onKeyDown)
    document.body.classList.add('community-modal-open')
    this.root.querySelector<HTMLButtonElement>('.community-modal-close')?.focus()
    void this.hydrate(preview, gen)
  }

  close(): void {
    this.openGen++
    this.root.hidden = true
    this.root.innerHTML = ''
    document.removeEventListener('keydown', this.onKeyDown)
    document.body.classList.remove('community-modal-open')
  }

  dispose(): void {
    this.disposed = true
    this.close()
    this.root.remove()
  }

  private async hydrate(preview: CommunityListRow, gen: number): Promise<void> {
    const identity = this.getAuthIdentity?.() ?? null
    let detail: CommunityDetail | null = null
    let detailError: string | null = null
    try {
      detail = identity
        ? await fetchCommunityByIdSigned(identity, preview.id)
        : await fetchCommunityByIdPublic(preview.id)
      if (!detail) detailError = 'Could not load community details'
    } catch (err) {
      detailError = err instanceof Error ? err.message : 'Could not load community details'
    }
    if (this.disposed || this.root.hidden || gen !== this.openGen) return

    const merged = mergePreviewAndDetail(preview, detail)
    this.root.innerHTML = this.render(merged, { loading: false, detailError })
    this.wire(merged)
    void this.hydrateOwnerAvatar(merged, gen)
  }

  private async hydrateOwnerAvatar(merged: CommunityDetail, gen: number): Promise<void> {
    const slot = this.root.querySelector<HTMLElement>('[data-owner-avatar]')
    if (!slot) return
    const addr = merged.ownerAddress?.trim()
    if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return
    const face = await fetchProfileFaceUrl(addr)
    if (this.disposed || this.root.hidden || gen !== this.openGen || !face) return
    slot.innerHTML = `<img class="community-modal-by-avatar" src="${escapeHtml(face)}" alt="" width="32" height="32" />`
  }

  private wire(merged: CommunityDetail): void {
    this.root.querySelector('.community-modal-backdrop')?.addEventListener('click', () => this.close())
    this.root.querySelector('.community-modal-panel')?.addEventListener('click', (e) => e.stopPropagation())
    this.root.querySelector('.community-modal-close')?.addEventListener('click', () => this.close())
    this.root.querySelector('[data-community-copy]')?.addEventListener('click', () => {
      void navigator.clipboard?.writeText(communityShareUrl(merged.id))
    })

    const hero = this.root.querySelector<HTMLImageElement>('.community-modal-hero-img')
    hero?.addEventListener(
      'error',
      () => {
        hero.replaceWith(
          Object.assign(document.createElement('div'), {
            className: 'community-modal-hero-placeholder',
            ariaHidden: 'true'
          })
        )
      },
      { once: true }
    )
  }

  private render(
    merged: CommunityDetail,
    opts: { loading: boolean; detailError?: string | null }
  ): string {
    const thumb = communityThumbnailUrlOrCdnFallback(pickCommunityThumbnailUrl(merged.thumbnails), merged.id)
    const owner = ownerLabel(merged)
    const ownerInitial = owner.charAt(0).toUpperCase() || '?'
    const members = formatMemberCount(merged.memberCount)
    const visibility = merged.isPrivate === true ? 'Private' : merged.isPrivate === false ? 'Public' : 'Community'
    const paragraphs = descriptionParagraphs(merged.description)
    const voiceLive = merged.voiceChatActive === true
    const voiceCount =
      typeof merged.voiceParticipantCount === 'number' && merged.voiceParticipantCount > 0
        ? ` · ${merged.voiceParticipantCount} in voice`
        : ''

    const descBlock =
      paragraphs.length > 0
        ? `<div class="community-modal-desc">${paragraphs.map((p) => `<p class="community-modal-desc-p">${escapeHtml(p)}</p>`).join('')}</div>`
        : `<p class="community-modal-desc-empty">No description yet.</p>`

    const statusHint = opts.loading
      ? `<p class="community-modal-status-hint">Loading details…</p>`
      : opts.detailError
        ? `<p class="community-modal-status-hint community-modal-status-hint--error">${escapeHtml(opts.detailError)}</p>`
        : ''

    return `
      <div class="community-modal-backdrop" role="presentation">
        <div
          class="community-modal-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="community-modal-title"
        >
          <button type="button" class="community-modal-close" aria-label="Close">&times;</button>
          <div class="community-modal-split">
            <div class="community-modal-media">
              ${
                thumb
                  ? `<img class="community-modal-hero-img" src="${escapeHtml(thumb)}" alt="" decoding="async" />`
                  : '<div class="community-modal-hero-placeholder" aria-hidden></div>'
              }
              ${
                voiceLive
                  ? `<span class="community-modal-live-badge" aria-label="Live voice active">
                      <span class="community-modal-live-dot" aria-hidden></span>
                      LIVE VOICE${escapeHtml(voiceCount)}
                    </span>`
                  : ''
              }
            </div>
            <div class="community-modal-detail">
              <h2 id="community-modal-title" class="community-modal-title">${escapeHtml(merged.name)}</h2>
              <p class="community-modal-meta-line">
                <span>${escapeHtml(visibility)}</span>
                <span class="community-modal-meta-dot" aria-hidden>·</span>
                <span>${escapeHtml(members)}</span>
              </p>
              ${statusHint}
              <div class="community-modal-by">
                <span data-owner-avatar>
                  <span class="community-modal-by-fallback" aria-hidden>${escapeHtml(ownerInitial)}</span>
                </span>
                <span class="community-modal-by-text">
                  By <span class="community-modal-by-name">${escapeHtml(owner)}</span>
                </span>
              </div>
              <div class="community-modal-pills">
                <span class="community-modal-pill">${MEMBERS_ICON}${escapeHtml(members)}</span>
                <span class="community-modal-pill">${escapeHtml(visibility)} community</span>
              </div>
              <section class="community-modal-about" aria-label="About">
                <h3 class="community-modal-about-title">About</h3>
                ${descBlock}
              </section>
              <button type="button" class="community-modal-copy-link" data-community-copy>Copy community link</button>
            </div>
          </div>
        </div>
      </div>
    `
  }
}