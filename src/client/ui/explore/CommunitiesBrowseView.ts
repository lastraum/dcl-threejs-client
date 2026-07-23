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
import type { CommunityDetail, CommunityListRow } from '../../../social/types'
import type { CommunityFollowController } from '../../../social/CommunityFollowController'
import {
  fetchActiveCommunityVoiceChats,
  type ActiveCommunityVoiceChat
} from '../../../network/gatekeeper/communityVoice'
import { followTargetLabel } from '../../../social/communityFollowWire'
import type { RouteTarget } from '../../../dcl/content/route'

export type CommunitiesBrowseViewOptions = {
  getAuthIdentity?: () => AuthIdentity | null
  getUserAddress?: () => string | null
  /** Open community text channel (dock / in-world chat). */
  onOpenChat?: (community: CommunityDetail) => void
  /** Reports the browse total after each load (embedded overlay title count). */
  onBrowseCount?: (total: number) => void
  /** Fired after a successful Social API join (refresh shell member lists). */
  onJoinedCommunity?: (community: CommunityListRow) => void
  getFollow?: () => CommunityFollowController | null
  getCurrentRoute?: () => RouteTarget | null
}

const SEARCH_DEBOUNCE_MS = 280
const ACTIVE_VOICE_POLL_MS = 45_000

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
  private readonly activeVoiceSection: HTMLElement
  private readonly activeVoiceRow: HTMLElement
  private readonly activeToursSection: HTMLElement
  private readonly activeToursRow: HTMLElement
  private readonly communityModal: CommunityModal
  private readonly getAuthIdentity?: () => AuthIdentity | null
  private readonly getFollow?: () => CommunityFollowController | null
  private readonly onBrowseCount?: (total: number) => void
  private readonly onJoinedCommunity?: (community: CommunityListRow) => void
  private communitiesById = new Map<string, CommunityListRow>()
  private mineById = new Map<string, CommunityListRow>()
  private selectedMineId: string | null = null
  private searchQuery = ''
  private searchDebounced = ''
  private searchTimer = 0
  private voicePollTimer = 0
  private loadGen = 0
  private disposed = false
  private joiningId: string | null = null
  private unsubFollow: (() => void) | null = null
  private activeVoice: ActiveCommunityVoiceChat[] = []

  constructor(opts: CommunitiesBrowseViewOptions = {}) {
    this.getAuthIdentity = opts.getAuthIdentity
    this.getFollow = opts.getFollow
    this.onBrowseCount = opts.onBrowseCount
    this.onJoinedCommunity = opts.onJoinedCommunity
    this.communityModal = new CommunityModal({
      getAuthIdentity: opts.getAuthIdentity,
      getUserAddress: opts.getUserAddress,
      onOpenChat: opts.onOpenChat,
      getFollow: opts.getFollow,
      getCurrentRoute: opts.getCurrentRoute
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
        <div class="communities-browse-view__live" data-live-sections>
          <section class="communities-browse-view__live-section" data-active-voice hidden>
            <h2 class="communities-browse-view__live-title">
              <span class="communities-browse-view__live-dot communities-browse-view__live-dot--voice" aria-hidden></span>
              Active Voice Streams
            </h2>
            <div class="communities-browse-view__live-row" data-active-voice-row role="list"></div>
          </section>
          <section class="communities-browse-view__live-section" data-active-tours hidden>
            <h2 class="communities-browse-view__live-title">
              <span class="communities-browse-view__live-dot communities-browse-view__live-dot--tour" aria-hidden></span>
              Active Tours
            </h2>
            <div class="communities-browse-view__live-row" data-active-tours-row role="list"></div>
          </section>
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
    this.activeVoiceSection = this.root.querySelector('[data-active-voice]')!
    this.activeVoiceRow = this.root.querySelector('[data-active-voice-row]')!
    this.activeToursSection = this.root.querySelector('[data-active-tours]')!
    this.activeToursRow = this.root.querySelector('[data-active-tours-row]')!

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
    void this.refreshActiveVoice()
    this.voicePollTimer = window.setInterval(() => void this.refreshActiveVoice(), ACTIVE_VOICE_POLL_MS)
    this.wireFollowLive()
    this.renderActiveTours()
  }

  dispose(): void {
    this.disposed = true
    window.clearTimeout(this.searchTimer)
    if (this.voicePollTimer) window.clearInterval(this.voicePollTimer)
    this.voicePollTimer = 0
    this.unsubFollow?.()
    this.unsubFollow = null
    this.communityModal.dispose()
    this.root.remove()
  }

  private wireFollowLive(): void {
    this.unsubFollow?.()
    this.unsubFollow = null
    const follow = this.getFollow?.()
    if (!follow) return
    this.unsubFollow = follow.subscribe(() => {
      if (!this.disposed) this.renderActiveTours()
    })
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
      this.onBrowseCount?.(total)

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
      // Names/thumbs may resolve after browse load.
      this.renderActiveVoice()
      this.renderActiveTours()
    } catch (err) {
      if (this.disposed || gen !== this.loadGen) return
      this.statusEl.hidden = false
      this.statusEl.textContent = err instanceof Error ? err.message : 'Could not load communities'
      this.statusEl.className = 'communities-browse-view__status communities-browse-view__status--error'
    }
  }

  private async refreshActiveVoice(): Promise<void> {
    const identity = this.getAuthIdentity?.() ?? null
    if (!identity) {
      this.activeVoice = []
      this.renderActiveVoice()
      return
    }
    try {
      this.activeVoice = await fetchActiveCommunityVoiceChats(identity)
    } catch {
      this.activeVoice = []
    }
    if (this.disposed) return
    this.renderActiveVoice()
  }

  private renderActiveVoice(): void {
    if (this.activeVoice.length === 0) {
      this.activeVoiceSection.hidden = true
      this.activeVoiceRow.innerHTML = ''
      return
    }
    this.activeVoiceSection.hidden = false
    this.activeVoiceRow.innerHTML = this.activeVoice
      .map((v) => {
        const row =
          this.communitiesById.get(v.communityId) ??
          this.mineById.get(v.communityId) ??
          [...this.communitiesById.values()].find(
            (c) => c.id.toLowerCase() === v.communityId.toLowerCase()
          )
        const name = (v.communityName || row?.name || 'Community').trim()
        const thumb =
          v.communityImage?.trim() ||
          communityDisplayImageUrl(v.communityId, row?.thumbnails)
        const initial = name.charAt(0).toUpperCase() || '?'
        const people = v.participantCount > 0 ? `${v.participantCount} live` : 'Live'
        return `
          <button type="button" class="communities-browse-view__live-chip" role="listitem"
            data-live-voice-id="${escapeHtml(v.communityId)}" title="Open ${escapeHtml(name)}">
            <span class="communities-browse-view__live-chip-media">
              ${
                thumb
                  ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />`
                  : `<span class="communities-browse-view__live-chip-fallback" aria-hidden>${escapeHtml(initial)}</span>`
              }
              <span class="communities-browse-view__live-chip-badge" aria-hidden>●</span>
            </span>
            <span class="communities-browse-view__live-chip-text">
              <span class="communities-browse-view__live-chip-name">${escapeHtml(name)}</span>
              <span class="communities-browse-view__live-chip-meta">${escapeHtml(people)}</span>
            </span>
          </button>`
      })
      .join('')
    this.wireImages(this.activeVoiceRow)
    for (const btn of this.activeVoiceRow.querySelectorAll<HTMLButtonElement>('[data-live-voice-id]')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.liveVoiceId
        if (!id) return
        this.openCommunityById(id, btn.querySelector('.communities-browse-view__live-chip-name')?.textContent ?? 'Community', {
          autoJoinVoice: true
        })
      })
    }
  }

  private renderActiveTours(): void {
    const follow = this.getFollow?.()
    const sessions = follow?.listSessions() ?? []
    if (sessions.length === 0) {
      this.activeToursSection.hidden = true
      this.activeToursRow.innerHTML = ''
      return
    }
    this.activeToursSection.hidden = false
    this.activeToursRow.innerHTML = sessions
      .map((s) => {
        const row =
          this.communitiesById.get(s.communityId) ??
          this.mineById.get(s.communityId) ??
          [...this.mineById.values()].find((c) => c.id.toLowerCase() === s.communityId) ??
          [...this.communitiesById.values()].find((c) => c.id.toLowerCase() === s.communityId)
        const name = (row?.name || 'Community').trim()
        const thumb = communityDisplayImageUrl(s.communityId, row?.thumbnails)
        const initial = name.charAt(0).toUpperCase() || '?'
        const stop = followTargetLabel(s.lastTarget)
        const leading = follow?.isLeading(s.communityId)
        const following = follow?.isFollowing(s.communityId)
        const meta = leading
          ? stop
            ? `Leading · ${stop}`
            : 'Leading'
          : following
            ? stop
              ? `Following · ${stop}`
              : 'Following'
            : stop
              ? `Tour · ${stop}`
              : 'Tour live'
        const flag = s.flagDataUrl ? ' · 🚩' : ''
        return `
          <button type="button" class="communities-browse-view__live-chip communities-browse-view__live-chip--tour" role="listitem"
            data-live-tour-id="${escapeHtml(s.communityId)}" title="Open ${escapeHtml(name)}">
            <span class="communities-browse-view__live-chip-media">
              ${
                thumb
                  ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />`
                  : `<span class="communities-browse-view__live-chip-fallback" aria-hidden>${escapeHtml(initial)}</span>`
              }
              <span class="communities-browse-view__live-chip-badge communities-browse-view__live-chip-badge--tour" aria-hidden>🚩</span>
            </span>
            <span class="communities-browse-view__live-chip-text">
              <span class="communities-browse-view__live-chip-name">${escapeHtml(name)}</span>
              <span class="communities-browse-view__live-chip-meta">${escapeHtml(meta)}${flag}</span>
            </span>
          </button>`
      })
      .join('')
    this.wireImages(this.activeToursRow)
    for (const btn of this.activeToursRow.querySelectorAll<HTMLButtonElement>('[data-live-tour-id]')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.liveTourId
        if (!id) return
        this.openCommunityById(
          id,
          btn.querySelector('.communities-browse-view__live-chip-name')?.textContent ?? 'Community'
        )
      })
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
  openCommunityById(
    id: string,
    fallbackName = 'Community',
    opts: { autoJoinVoice?: boolean } = {}
  ): void {
    const key = id.trim()
    if (!key) return
    const row =
      this.communitiesById.get(key) ??
      this.mineById.get(key) ??
      [...this.communitiesById.values()].find((c) => c.id.toLowerCase() === key.toLowerCase()) ??
      [...this.mineById.values()].find((c) => c.id.toLowerCase() === key.toLowerCase())
    if (row) {
      this.openCommunity(row.id, opts)
      return
    }
    this.communityModal.open(
      {
        id: key,
        name: fallbackName
      },
      opts
    )
  }

  private openCommunity(id: string, opts: { autoJoinVoice?: boolean } = {}): void {
    const row = this.communitiesById.get(id) ?? this.mineById.get(id)
    if (!row) return
    this.selectedMineId = id
    this.syncSidebarSelection()
    this.communityModal.open(row, opts)
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
      this.setStatus('Sign in (wallet or guest) to join communities', 'error')
      return
    }
    this.joiningId = id
    btn.disabled = true
    btn.textContent = 'JOINING…'
    btn.title = ''
    this.setStatus('Joining community…', 'loading')
    const result = await joinCommunitySigned(identity, id)
    this.joiningId = null
    if (this.disposed) return
    if (!result.ok) {
      btn.disabled = false
      btn.textContent = 'JOIN'
      btn.title = result.error
      this.setStatus(`Could not join: ${result.error}`, 'error')
      return
    }
    // Promote into mine list and refresh CTAs.
    const row = this.communitiesById.get(id)
    const joined: CommunityListRow | null = row
      ? { ...row, role: row.role ?? 'member' }
      : { id, name: 'Community', role: 'member' }
    this.mineById.set(id, joined)
    this.setStatus('Joined — opening community…', 'ok')
    this.onJoinedCommunity?.(joined)
    await this.loadMine()
    void this.loadBrowse()
    this.openCommunity(id)
  }

  private setStatus(message: string, tone: 'loading' | 'error' | 'ok' | 'info' = 'info'): void {
    this.statusEl.hidden = !message
    this.statusEl.textContent = message
    this.statusEl.className = `communities-browse-view__status communities-browse-view__status--${tone}`
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
