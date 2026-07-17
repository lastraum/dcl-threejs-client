import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { CommunityModal } from '../communities/CommunityModal'
import {
  communityDisplayImageUrl,
  enrichCommunityThumbnailFromDetail
} from '../../../social/communityThumbnails'
import {
  fetchCommunitiesBrowsePublic,
  fetchCommunitiesBrowseSigned,
  fetchMemberCommunitiesSigned,
  joinCommunitySigned
} from '../../../social/socialApi'
import type { CommunityListRow } from '../../../social/types'

export type CommunitiesBrowseViewOptions = {
  getAuthIdentity?: () => AuthIdentity | null
  getUserAddress?: () => string | null
}

const SEARCH_DEBOUNCE_MS = 280

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatMemberCountShort(count: number | undefined): string {
  if (typeof count !== 'number' || !Number.isFinite(count)) return '—'
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M Members`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k Members`
  return `${count} Member${count === 1 ? '' : 's'}`
}

function formatRole(role: string | undefined): string {
  const r = (role ?? 'member').trim().toLowerCase()
  if (r === 'owner') return 'Owner'
  if (r === 'moderator' || r === 'mod') return 'Moderator'
  if (r === 'member') return 'Member'
  if (!r || r === 'none') return ''
  return r.charAt(0).toUpperCase() + r.slice(1)
}

function ownerLabel(c: CommunityListRow): string {
  const name = c.ownerName?.trim()
  if (name) return name
  const addr = c.ownerAddress?.trim()
  if (addr && addr.length >= 10) return `${addr.slice(0, 6)}…${addr.slice(-4)}`
  return 'Community'
}

/**
 * Explorer-style communities shell: left rail (My Communities) + browse grid.
 * Used by Settings → Communities and `/communities`.
 */
export class CommunitiesBrowseView {
  readonly root: HTMLElement

  private readonly sidebarListEl: HTMLElement
  private readonly sidebarEmptyEl: HTMLElement
  private readonly mineCountEl: HTMLElement
  private readonly gridEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly emptyEl: HTMLElement
  private readonly countEl: HTMLElement
  private readonly searchInput: HTMLInputElement
  private readonly communityModal: CommunityModal
  private readonly getAuthIdentity?: () => AuthIdentity | null
  private communitiesById = new Map<string, CommunityListRow>()
  private mineById = new Map<string, CommunityListRow>()
  private selectedMineId: string | null = null
  private searchQuery = ''
  private searchDebounced = ''
  private searchTimer = 0
  private loadGen = 0
  private disposed = false
  private joiningId: string | null = null

  constructor(opts: CommunitiesBrowseViewOptions = {}) {
    this.getAuthIdentity = opts.getAuthIdentity
    this.communityModal = new CommunityModal({
      getAuthIdentity: opts.getAuthIdentity,
      getUserAddress: opts.getUserAddress
    })

    this.root = document.createElement('div')
    this.root.className = 'communities-browse-view'
    this.root.innerHTML = `
      <aside class="communities-browse-view__sidebar" aria-label="My communities">
        <button type="button" class="communities-browse-view__create" data-create disabled title="Coming soon">
          + CREATE A COMMUNITY
        </button>
        <button type="button" class="communities-browse-view__invites" data-invites disabled title="Coming soon">
          <span>Invites &amp; Requests</span>
          <span class="communities-browse-view__chevron" aria-hidden>›</span>
        </button>
        <div class="communities-browse-view__mine-head">
          <h2 class="communities-browse-view__mine-title">My Communities</h2>
          <span class="communities-browse-view__mine-count" data-mine-count></span>
        </div>
        <div class="communities-browse-view__sidebar-list" data-sidebar-list role="list"></div>
        <p class="communities-browse-view__sidebar-empty" data-sidebar-empty hidden>
          Sign in to see communities you belong to.
        </p>
      </aside>
      <div class="communities-browse-view__main">
        <div class="communities-browse-view__main-head">
          <h1 class="communities-browse-view__browse-title" data-count>Browse Communities</h1>
          <label class="communities-browse-view__search-wrap">
            <span class="communities-browse-view__search-label">Search</span>
            <input
              type="search"
              class="communities-browse-view__search"
              data-search
              placeholder="Search"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
        </div>
        <p class="communities-browse-view__status" data-status hidden></p>
        <div class="communities-browse-view__grid" data-grid role="list"></div>
        <p class="communities-browse-view__empty" data-empty hidden>No communities match your search.</p>
      </div>
    `

    this.sidebarListEl = this.root.querySelector('[data-sidebar-list]')!
    this.sidebarEmptyEl = this.root.querySelector('[data-sidebar-empty]')!
    this.mineCountEl = this.root.querySelector('[data-mine-count]')!
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
        void this.loadBrowse()
      }, SEARCH_DEBOUNCE_MS)
    })
  }

  mount(): void {
    this.communityModal.mount()
    void this.loadMine()
    void this.loadBrowse()
  }

  dispose(): void {
    this.disposed = true
    window.clearTimeout(this.searchTimer)
    this.communityModal.dispose()
    this.root.remove()
  }

  private async loadMine(): Promise<void> {
    const identity = this.getAuthIdentity?.() ?? null
    this.sidebarListEl.innerHTML = ''
    this.mineCountEl.textContent = ''

    if (!identity) {
      this.sidebarEmptyEl.hidden = false
      this.sidebarEmptyEl.textContent = 'Sign in to see communities you belong to.'
      return
    }

    this.sidebarEmptyEl.hidden = true
    try {
      const { communities } = await fetchMemberCommunitiesSigned(identity)
      if (this.disposed) return
      this.mineById = new Map(communities.map((c) => [c.id, c]))
      for (const c of communities) this.communitiesById.set(c.id, c)

      if (communities.length === 0) {
        this.sidebarEmptyEl.hidden = false
        this.sidebarEmptyEl.textContent = "You're not in any communities yet."
        this.mineCountEl.textContent = ''
        return
      }

      this.mineCountEl.textContent = String(communities.length)
      this.sidebarListEl.innerHTML = communities.map((c) => this.renderSidebarRow(c)).join('')
      this.wireSidebar()
      this.wireSidebarImages()
      // Refresh browse CTAs if browse already loaded.
      if (this.gridEl.children.length) void this.loadBrowse()
    } catch {
      if (this.disposed) return
      this.sidebarEmptyEl.hidden = false
      this.sidebarEmptyEl.textContent = 'Could not load your communities.'
    }
  }

  private async loadBrowse(): Promise<void> {
    const gen = ++this.loadGen
    this.statusEl.hidden = false
    this.statusEl.textContent = 'Loading communities…'
    this.statusEl.className = 'communities-browse-view__status communities-browse-view__status--loading'
    this.gridEl.innerHTML = ''
    this.emptyEl.hidden = true

    const q = this.searchDebounced.trim()

    try {
      const identity = this.getAuthIdentity?.() ?? null
      const { communities, total } = identity
        ? await fetchCommunitiesBrowseSigned(identity, { limit: 120, search: q || undefined })
        : await fetchCommunitiesBrowsePublic({ limit: 120, search: q || undefined })
      if (this.disposed || gen !== this.loadGen) return
      this.statusEl.hidden = true
      this.countEl.textContent = `Browse Communities (${total})`

      if (communities.length === 0) {
        this.emptyEl.hidden = false
        this.emptyEl.textContent = q
          ? 'No communities match your search.'
          : 'No communities found yet. Check back soon!'
        return
      }

      for (const c of communities) this.communitiesById.set(c.id, c)
      this.gridEl.innerHTML = communities.map((c) => this.renderCard(c)).join('')
      this.wireImages(this.gridEl)
      this.wireCards()
    } catch (err) {
      if (this.disposed || gen !== this.loadGen) return
      this.statusEl.hidden = false
      this.statusEl.textContent = err instanceof Error ? err.message : 'Could not load communities'
      this.statusEl.className = 'communities-browse-view__status communities-browse-view__status--error'
    }
  }

  private renderSidebarRow(c: CommunityListRow): string {
    const thumb = communityDisplayImageUrl(c.id, c.thumbnails)
    const initial = c.name.trim().charAt(0).toUpperCase() || '?'
    const role = formatRole(c.role)
    const selected = this.selectedMineId === c.id ? ' is-selected' : ''
    return `
      <button
        type="button"
        class="communities-browse-view__nav-row${selected}"
        role="listitem"
        data-community-id="${escapeHtml(c.id)}"
      >
        <span class="communities-browse-view__nav-media">
          ${
            thumb
              ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />`
              : `<span class="communities-browse-view__nav-fallback" aria-hidden>${escapeHtml(initial)}</span>`
          }
        </span>
        <span class="communities-browse-view__nav-text">
          <span class="communities-browse-view__nav-name">${escapeHtml(c.name)}</span>
          ${
            role
              ? `<span class="communities-browse-view__nav-role">${escapeHtml(role)}</span>`
              : ''
          }
        </span>
      </button>
    `
  }

  private renderCard(c: CommunityListRow): string {
    const thumb = communityDisplayImageUrl(c.id, c.thumbnails)
    const initial = c.name.trim().charAt(0).toUpperCase() || '?'
    const joined = this.mineById.has(c.id)
    const privacy = c.isPrivate === true ? 'Private' : 'Public'
    const members = formatMemberCountShort(c.memberCount)
    const owner = ownerLabel(c)
    const ctaLabel = joined ? 'VIEW' : 'JOIN'
    const ctaClass = joined
      ? 'communities-browse-view__cta communities-browse-view__cta--view'
      : 'communities-browse-view__cta communities-browse-view__cta--join'
    const busy = this.joiningId === c.id

    return `
      <article
        class="communities-browse-view__card"
        role="listitem"
        data-community-id="${escapeHtml(c.id)}"
      >
        <button type="button" class="communities-browse-view__card-hit" data-card-open aria-label="${escapeHtml(c.name)}">
          <div class="communities-browse-view__card-media">
            ${
              thumb
                ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />`
                : `<span class="communities-browse-view__card-fallback" aria-hidden>${escapeHtml(initial)}</span>`
            }
          </div>
          <div class="communities-browse-view__card-body">
            <h2 class="communities-browse-view__card-name">${escapeHtml(c.name)}</h2>
            <p class="communities-browse-view__card-owner">${escapeHtml(owner)}</p>
            <p class="communities-browse-view__card-meta">
              <span class="communities-browse-view__meta-privacy">${escapeHtml(privacy)}</span>
              <span class="communities-browse-view__meta-sep" aria-hidden>·</span>
              <span>${escapeHtml(members)}</span>
            </p>
          </div>
        </button>
        <div class="communities-browse-view__card-actions">
          <button
            type="button"
            class="${ctaClass}"
            data-cta="${joined ? 'view' : 'join'}"
            data-community-id="${escapeHtml(c.id)}"
            ${busy ? 'disabled' : ''}
          >${busy ? 'JOINING…' : ctaLabel}</button>
        </div>
      </article>
    `
  }

  /** Open community modal by id (HUD toast / deep link). */
  openCommunityById(id: string, fallbackName = 'Community'): void {
    const key = id.trim()
    if (!key) return
    const row =
      this.communitiesById.get(key) ??
      this.mineById.get(key) ??
      [...this.communitiesById.values()].find((c) => c.id.toLowerCase() === key.toLowerCase()) ??
      [...this.mineById.values()].find((c) => c.id.toLowerCase() === key.toLowerCase())
    if (row) {
      this.openCommunity(row.id)
      return
    }
    this.communityModal.open({
      id: key,
      name: fallbackName
    })
  }

  private openCommunity(id: string): void {
    const row = this.communitiesById.get(id) ?? this.mineById.get(id)
    if (!row) return
    this.selectedMineId = id
    this.syncSidebarSelection()
    this.communityModal.open(row)
  }

  private syncSidebarSelection(): void {
    for (const row of this.sidebarListEl.querySelectorAll<HTMLElement>('.communities-browse-view__nav-row')) {
      row.classList.toggle('is-selected', row.dataset.communityId === this.selectedMineId)
    }
  }

  private wireSidebar(): void {
    for (const row of this.sidebarListEl.querySelectorAll<HTMLElement>('[data-community-id]')) {
      row.addEventListener('click', () => {
        const id = row.dataset.communityId
        if (id) this.openCommunity(id)
      })
    }
  }

  private wireCards(): void {
    for (const card of this.gridEl.querySelectorAll<HTMLElement>('.communities-browse-view__card')) {
      const id = card.dataset.communityId
      if (!id) continue
      card.querySelector('[data-card-open]')?.addEventListener('click', () => this.openCommunity(id))
      const cta = card.querySelector<HTMLButtonElement>('[data-cta]')
      cta?.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const action = cta.dataset.cta
        if (action === 'view') {
          this.openCommunity(id)
          return
        }
        if (action === 'join') void this.handleJoin(id, cta)
      })
    }
  }

  private async handleJoin(id: string, btn: HTMLButtonElement): Promise<void> {
    const identity = this.getAuthIdentity?.() ?? null
    if (!identity) {
      btn.title = 'Sign in to join'
      return
    }
    this.joiningId = id
    btn.disabled = true
    btn.textContent = 'JOINING…'
    const result = await joinCommunitySigned(identity, id)
    this.joiningId = null
    if (this.disposed) return
    if (!result.ok) {
      btn.disabled = false
      btn.textContent = 'JOIN'
      btn.title = result.error
      return
    }
    // Promote into mine list and refresh CTAs.
    const row = this.communitiesById.get(id)
    if (row) {
      this.mineById.set(id, { ...row, role: row.role ?? 'member' })
    }
    await this.loadMine()
    void this.loadBrowse()
    this.openCommunity(id)
  }

  private wireImages(root: HTMLElement): void {
    for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
      img.addEventListener(
        'error',
        () => {
          void this.onImageError(img)
        },
        { once: true }
      )
    }
  }

  private wireSidebarImages(): void {
    this.wireImages(this.sidebarListEl)
  }

  private async onImageError(img: HTMLImageElement): Promise<void> {
    const card = img.closest<HTMLElement>('[data-community-id]')
    const communityId = card?.dataset.communityId?.trim()
    if (communityId) {
      try {
        const enriched = await enrichCommunityThumbnailFromDetail(communityId, this.getAuthIdentity)
        if (enriched && enriched !== img.src && !this.disposed) {
          img.addEventListener('error', () => this.replaceImageFallback(img), { once: true })
          img.src = enriched
          return
        }
      } catch {
        /* fall through */
      }
    }
    this.replaceImageFallback(img)
  }

  private replaceImageFallback(img: HTMLImageElement): void {
    const host = img.closest('[data-community-id]')
    const name =
      host?.querySelector('.communities-browse-view__card-name, .communities-browse-view__nav-name')
        ?.textContent?.trim()
        .charAt(0)
        .toUpperCase() || '?'
    const isNav = Boolean(img.closest('.communities-browse-view__nav-media'))
    img.replaceWith(
      Object.assign(document.createElement('span'), {
        className: isNav
          ? 'communities-browse-view__nav-fallback'
          : 'communities-browse-view__card-fallback',
        textContent: name,
        ariaHidden: 'true'
      })
    )
  }
}
