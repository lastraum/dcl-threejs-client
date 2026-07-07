import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { CommunityModal } from '../communities/CommunityModal'
import {
  communityDisplayImageUrl,
  enrichCommunityThumbnailFromDetail
} from '../../../social/communityThumbnails'
import { fetchCommunitiesBrowsePublic, fetchCommunitiesBrowseSigned } from '../../../social/socialApi'
import type { CommunityListRow } from '../../../social/types'

export type CommunitiesBrowseViewOptions = {
  getAuthIdentity?: () => AuthIdentity | null
}

const SEARCH_DEBOUNCE_MS = 280

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

/** Browse grid for `/communities` — public Social API list (Phase 2.5). */
export class CommunitiesBrowseView {
  readonly root: HTMLElement

  private readonly gridEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly emptyEl: HTMLElement
  private readonly countEl: HTMLElement
  private readonly searchInput: HTMLInputElement
  private readonly communityModal: CommunityModal
  private readonly getAuthIdentity?: () => AuthIdentity | null
  private communitiesById = new Map<string, CommunityListRow>()
  private searchQuery = ''
  private searchDebounced = ''
  private searchTimer = 0
  private loadGen = 0
  private disposed = false

  constructor(opts: CommunitiesBrowseViewOptions = {}) {
    this.getAuthIdentity = opts.getAuthIdentity
    this.communityModal = new CommunityModal({ getAuthIdentity: opts.getAuthIdentity })

    this.root = document.createElement('div')
    this.root.className = 'communities-browse-view'
    this.root.innerHTML = `
      <header class="communities-browse-view__header">
        <h1 class="communities-browse-view__title">Communities</h1>
        <p class="communities-browse-view__subtitle">Discover groups hosting hangouts, voice, and events across Decentraland.</p>
      </header>
      <div class="communities-browse-view__toolbar">
        <label class="communities-browse-view__search-wrap">
          <span class="communities-browse-view__search-label">Search communities</span>
          <input
            type="search"
            class="communities-browse-view__search"
            data-search
            placeholder="Search communities…"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
      </div>
      <p class="communities-browse-view__status" data-status hidden></p>
      <div class="communities-browse-view__results">
        <p class="communities-browse-view__count" data-count hidden></p>
        <div class="communities-browse-view__grid" data-grid role="list"></div>
        <p class="communities-browse-view__empty" data-empty hidden>No communities match your search.</p>
      </div>
    `

    this.gridEl = this.root.querySelector('[data-grid]')!
    this.statusEl = this.root.querySelector('[data-status]')!
    this.emptyEl = this.root.querySelector('[data-empty]')!
    this.countEl = this.root.querySelector('[data-count]')!
    this.searchInput = this.root.querySelector('[data-search]')!

    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value
      window.clearTimeout(this.searchTimer)
      this.searchTimer = window.setTimeout(() => {
        this.searchDebounced = this.searchQuery
        void this.load()
      }, SEARCH_DEBOUNCE_MS)
    })
  }

  mount(): void {
    this.communityModal.mount()
    void this.load()
  }

  dispose(): void {
    this.disposed = true
    window.clearTimeout(this.searchTimer)
    this.communityModal.dispose()
    this.root.remove()
  }

  private async load(): Promise<void> {
    const gen = ++this.loadGen
    this.statusEl.hidden = false
    this.statusEl.textContent = 'Loading communities…'
    this.statusEl.className = 'communities-browse-view__status communities-browse-view__status--loading'
    this.gridEl.innerHTML = ''
    this.countEl.hidden = true
    this.emptyEl.hidden = true

    const q = this.searchDebounced.trim()

    try {
      const identity = this.getAuthIdentity?.() ?? null
      const { communities, total } = identity
        ? await fetchCommunitiesBrowseSigned(identity, { limit: 120, search: q || undefined })
        : await fetchCommunitiesBrowsePublic({ limit: 120, search: q || undefined })
      if (this.disposed || gen !== this.loadGen) return
      this.statusEl.hidden = true
      if (communities.length === 0) {
        if (q) {
          this.emptyEl.hidden = false
        } else {
          this.gridEl.innerHTML =
            '<p class="communities-browse-view__empty communities-browse-view__empty--inline">No communities found yet. Check back soon!</p>'
        }
        return
      }
      this.communitiesById = new Map(communities.map((c) => [c.id, c]))
      this.countEl.hidden = false
      this.countEl.textContent = `${total} communit${total === 1 ? 'y' : 'ies'}`
      this.gridEl.innerHTML = communities.map((c) => this.renderCard(c)).join('')
      this.wireImages()
      this.wireCards()
    } catch (err) {
      if (this.disposed || gen !== this.loadGen) return
      this.statusEl.hidden = false
      this.statusEl.textContent = err instanceof Error ? err.message : 'Could not load communities'
      this.statusEl.className = 'communities-browse-view__status communities-browse-view__status--error'
    }
  }

  private renderCard(c: CommunityListRow): string {
    const thumb = communityDisplayImageUrl(c.id, c.thumbnails)
    const initial = c.name.trim().charAt(0).toUpperCase() || '?'
    const privacy = c.isPrivate ? '<span class="communities-browse-view__badge">Private</span>' : ''

    return `
      <article
        class="communities-browse-view__card communities-browse-view__card--interactive"
        role="listitem"
        tabindex="0"
        data-community-id="${escapeHtml(c.id)}"
        aria-label="${escapeHtml(c.name)}"
      >
        <div class="communities-browse-view__card-media">
          ${
            thumb
              ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />`
              : `<span class="communities-browse-view__card-fallback" aria-hidden>${escapeHtml(initial)}</span>`
          }
        </div>
        <div class="communities-browse-view__card-body">
          <h2 class="communities-browse-view__card-name">${escapeHtml(c.name)}</h2>
          <p class="communities-browse-view__card-meta">${escapeHtml(formatMemberCount(c.memberCount))}</p>
          ${privacy}
        </div>
      </article>
    `
  }

  private wireCards(): void {
    for (const card of this.gridEl.querySelectorAll<HTMLElement>('[data-community-id]')) {
      const open = () => {
        const id = card.dataset.communityId
        if (!id) return
        const row = this.communitiesById.get(id)
        if (row) this.communityModal.open(row)
      }
      card.addEventListener('click', open)
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault()
          open()
        }
      })
    }
  }

  private wireImages(): void {
    for (const img of this.gridEl.querySelectorAll<HTMLImageElement>('img')) {
      img.addEventListener(
        'error',
        () => {
          void this.onCardImageError(img)
        },
        { once: true }
      )
    }
  }

  private async onCardImageError(img: HTMLImageElement): Promise<void> {
    const card = img.closest<HTMLElement>('.communities-browse-view__card')
    const communityId = card?.dataset.communityId?.trim()
    if (communityId) {
      try {
        const enriched = await enrichCommunityThumbnailFromDetail(communityId, this.getAuthIdentity)
        if (enriched && enriched !== img.src && !this.disposed) {
          img.addEventListener(
            'error',
            () => this.replaceCardImageWithFallback(img),
            { once: true }
          )
          img.src = enriched
          return
        }
      } catch {
        /* fall through to letter fallback */
      }
    }
    this.replaceCardImageWithFallback(img)
  }

  private replaceCardImageWithFallback(img: HTMLImageElement): void {
    const initial =
      img.closest('.communities-browse-view__card')
        ?.querySelector('.communities-browse-view__card-name')
        ?.textContent?.trim()
        .charAt(0)
        .toUpperCase() || '?'
    img.replaceWith(
      Object.assign(document.createElement('span'), {
        className: 'communities-browse-view__card-fallback',
        textContent: initial,
        ariaHidden: 'true'
      })
    )
  }
}