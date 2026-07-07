import type { LoginResult } from '../../../auth/AuthClient'
import { CommunityModal } from '../communities/CommunityModal'
import { AvatarPreviewMini } from '../profile/AvatarPreviewMini'
import { loadProfilePageData, profilePageWalletLabel, type ProfilePageData } from '../profile/profilePageData'
import {
  resolveContentImageUrl,
  wearableRarityBackground,
  wearableRarityLabel,
  wearableThumbnailUrl,
  WEARABLE_RARITY_COLORS,
  type WearableDisplayCard
} from '../profile/wearableThumb'
import { communityThumbnailUrl } from '../../../social/memberCommunities'
import type { CommunityListRow } from '../../../social/types'
import { SocialShellTopNav, type SocialShellChromeHandlers, type SocialShellTab } from './SocialShellTopNav'

export type ProfilePageViewOptions = SocialShellChromeHandlers & {
  login: LoginResult
  catalystUrl: string
  onNavigate: (tab: SocialShellTab) => void
}

type ProfileTabId = 'overview' | 'assets' | 'communities' | 'places' | 'photos' | 'referrals'

const PROFILE_TABS: { id: ProfileTabId; label: string; enabled: boolean }[] = [
  { id: 'overview', label: 'Overview', enabled: true },
  { id: 'assets', label: 'My Assets', enabled: false },
  { id: 'communities', label: 'My Communities', enabled: true },
  { id: 'places', label: 'My Places', enabled: false },
  { id: 'photos', label: 'My Photos', enabled: false },
  { id: 'referrals', label: 'Referral Rewards', enabled: false }
]

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

/** Full-screen profile at `/profile` — decentraland.org profile parity (2D shell). */
export class ProfilePageView {
  readonly root: HTMLElement

  private readonly topNav: SocialShellTopNav
  private readonly scrollEl: HTMLElement
  private readonly contentEl: HTMLElement
  private readonly communityModal: CommunityModal
  private login: LoginResult
  private readonly catalystUrl: string
  private activeTab: ProfileTabId = 'overview'
  private loadToken = 0
  private loaded: ProfilePageData | null = null
  private preview: AvatarPreviewMini | null = null
  private avatarAddress: string | null = null
  private communitiesById = new Map<string, CommunityListRow>()

  constructor(opts: ProfilePageViewOptions) {
    this.login = opts.login
    this.catalystUrl = opts.catalystUrl
    this.communityModal = new CommunityModal({
      getAuthIdentity: () => (this.login.kind === 'wallet' ? this.login.identity : null)
    })

    this.root = document.createElement('div')
    this.root.className = 'profile-page-view'

    this.topNav = new SocialShellTopNav({
      activeTab: null,
      login: opts.login,
      onNavigate: opts.onNavigate,
      onLoginChange: opts.onLoginChange,
      onSignOut: opts.onSignOut,
      onOpenSettings: opts.onOpenSettings,
      onOpenBackpack: opts.onOpenBackpack,
      onOpenProfile: opts.onOpenProfile
    })

    this.scrollEl = document.createElement('main')
    this.scrollEl.className = 'profile-page-view__main'
    this.scrollEl.innerHTML = `
      <div class="profile-page-view__loading" data-loading>
        <div class="profile-page-view__spinner" aria-hidden="true"></div>
        <p>Loading profile…</p>
      </div>
      <div class="profile-page-view__shell" data-shell hidden></div>
    `

    this.contentEl = document.createElement('div')
    this.contentEl.className = 'profile-page-view__content'
    this.contentEl.dataset.content = ''

    this.root.appendChild(this.topNav.el)
    this.scrollEl.appendChild(this.contentEl)
    this.root.appendChild(this.scrollEl)
  }

  mount(container: HTMLElement): void {
    document.body.classList.add('profile-route')
    container.innerHTML = ''
    container.appendChild(this.root)
    this.topNav.mount()
    this.communityModal.mount()
    void this.reload()
  }

  setLogin(login: LoginResult): void {
    this.login = login
    this.topNav.setLogin(login)
    void this.reload()
  }

  dispose(): void {
    document.body.classList.remove('profile-route')
    this.preview?.dispose()
    this.preview = null
    this.communityModal.dispose()
    this.topNav.dispose()
    this.root.remove()
  }

  private async reload(): Promise<void> {
    const token = ++this.loadToken
    const loading = this.scrollEl.querySelector('[data-loading]') as HTMLElement | null
    const shell = this.scrollEl.querySelector('[data-shell]') as HTMLElement | null

    this.preview?.dispose()
    this.preview = null
    this.avatarAddress = null

    if (this.login.kind !== 'wallet') {
      loading?.setAttribute('hidden', '')
      shell?.removeAttribute('hidden')
      this.contentEl.innerHTML = `
        <section class="profile-page-view__guest">
          <h2>Sign in to view your profile</h2>
          <p>Use the account menu in the top right to connect your wallet.</p>
        </section>
      `
      return
    }

    loading?.removeAttribute('hidden')
    shell?.setAttribute('hidden', '')
    this.contentEl.innerHTML = ''

    const data = await loadProfilePageData({
      address: this.login.address,
      peerUrl: this.catalystUrl,
      identity: this.login.identity
    })
    if (token !== this.loadToken) return

    this.loaded = data
    this.communitiesById = new Map(data.communities.map((c) => [c.id, c]))
    loading?.setAttribute('hidden', '')
    shell?.removeAttribute('hidden')
    this.renderPage()
  }

  private renderPage(): void {
    const data = this.loaded
    if (!data) return

    const shell = this.scrollEl.querySelector('[data-shell]') as HTMLElement | null
    if (!shell) return

    shell.innerHTML = `
      <header class="profile-page-view__hero">
        <div class="profile-page-view__hero-main">
          <div class="profile-page-view__avatar-wrap">
            ${
              data.faceUrl
                ? `<img class="profile-page-view__avatar" src="${escapeHtml(data.faceUrl)}" alt="" width="88" height="88" decoding="async" />`
                : `<span class="profile-page-view__avatar profile-page-view__avatar--fallback" aria-hidden="true">${escapeHtml(data.displayName.slice(0, 1).toUpperCase())}</span>`
            }
          </div>
          <div class="profile-page-view__identity">
            <div class="profile-page-view__title-row">
              <h1 class="profile-page-view__name" style="color:${escapeHtml(data.nameColor)}">${escapeHtml(data.displayName)}</h1>
              ${data.claimed ? '<span class="profile-page-view__verified" title="Verified name">✓</span>' : ''}
            </div>
            <div class="profile-page-view__wallet-row">
              <code class="profile-page-view__wallet">${escapeHtml(profilePageWalletLabel(data.address))}</code>
              <button type="button" class="profile-page-view__copy" data-copy-wallet aria-label="Copy wallet address">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/>
                  <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.6"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div class="profile-page-view__hero-actions">
          <button type="button" class="profile-page-view__cta profile-page-view__cta--primary" disabled title="Coming soon">Manage World</button>
          <button type="button" class="profile-page-view__cta profile-page-view__cta--ghost" disabled title="Coming soon">Friends</button>
          <button type="button" class="profile-page-view__cta profile-page-view__cta--ghost" disabled title="Coming soon">Invite Friends</button>
          <button type="button" class="profile-page-view__icon-btn" data-open-external aria-label="Open on decentraland.org" title="Open on decentraland.org">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 5h5v5M10 14 19 5M19 14v5H5V5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </header>
      <nav class="profile-page-view__tabs" role="tablist" aria-label="Profile sections">
        ${PROFILE_TABS.map(
          (tab) => `
            <button
              type="button"
              class="profile-page-view__tab${tab.id === this.activeTab ? ' profile-page-view__tab--active' : ''}"
              role="tab"
              data-profile-tab="${tab.id}"
              ${tab.enabled ? '' : 'disabled'}
              aria-selected="${tab.id === this.activeTab ? 'true' : 'false'}"
            >${escapeHtml(tab.label)}</button>
          `
        ).join('')}
      </nav>
    `

    this.renderTabPanel()
    this.wireHero(shell, data)
  }

  private renderTabPanel(): void {
    const data = this.loaded
    if (!data) return

    if (this.activeTab === 'overview') {
      this.contentEl.innerHTML = `
        <section class="profile-page-view__panel">
          <div class="profile-page-view__overview-layout">
            <div class="profile-page-view__avatar-stage profile-page-view__avatar-stage--loading" data-avatar-stage aria-label="3D avatar preview"></div>
            <div class="profile-page-view__overview-main">
              ${this.renderBadgesBlock(data)}
              <section class="profile-page-view__block">
                <h2 class="profile-page-view__block-title">About</h2>
                <p class="profile-page-view__about">${this.renderAbout(data.description)}</p>
              </section>
              <section class="profile-page-view__block">
                <h2 class="profile-page-view__block-title">Equipped Items</h2>
                <div class="profile-page-view__equipped">${this.renderEquipped(data.wearables)}</div>
              </section>
            </div>
          </div>
        </section>
      `
      void this.ensureAvatarPreview(this.loadToken)
      return
    }

    if (this.activeTab === 'communities') {
      this.preview?.dispose()
      this.preview = null
      this.avatarAddress = null
      this.contentEl.innerHTML = this.renderCommunitiesTab(data)
      this.wireCommunities()
      return
    }

    this.preview?.dispose()
    this.preview = null
    this.avatarAddress = null
    this.contentEl.innerHTML = `
      <section class="profile-page-view__panel profile-page-view__panel--placeholder">
        <p>This section is coming soon.</p>
      </section>
    `
  }

  private renderAbout(description: string | null): string {
    const text = description?.trim()
    if (!text) return '—'
    return escapeHtml(text)
  }

  private renderCommunitiesTab(data: ProfilePageData): string {
    if (!data.communities.length) {
      return `
        <section class="profile-page-view__panel profile-page-view__panel--communities">
          <header class="profile-page-view__communities-head">
            <h2 class="profile-page-view__communities-title">My Communities</h2>
          </header>
          <p class="profile-page-view__empty">No communities yet.</p>
        </section>
      `
    }

    const items = data.communities.map((c) => this.renderCommunityCard(c)).join('')
    return `
      <section class="profile-page-view__panel profile-page-view__panel--communities">
        <header class="profile-page-view__communities-head">
          <h2 class="profile-page-view__communities-title">My Communities</h2>
          <span class="profile-page-view__communities-count">${data.communities.length} communit${data.communities.length === 1 ? 'y' : 'ies'}</span>
        </header>
        <div class="profile-page-view__communities-grid" role="list">${items}</div>
      </section>
    `
  }

  private renderCommunityCard(c: CommunityListRow): string {
    const thumb = communityThumbnailUrl(c.id)
    const initial = c.name.trim().charAt(0).toUpperCase() || '?'
    const privacy = c.isPrivate ? '<span class="profile-page-view__community-privacy">Private</span>' : ''

    return `
      <button
        type="button"
        class="profile-page-view__community-card"
        role="listitem"
        data-community-id="${escapeHtml(c.id)}"
        aria-label="${escapeHtml(c.name)}"
      >
        <span class="profile-page-view__community-card-media">
          ${
            thumb
              ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />`
              : `<span class="profile-page-view__community-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`
          }
        </span>
        <span class="profile-page-view__community-card-body">
          <span class="profile-page-view__community-card-name">${escapeHtml(c.name)}</span>
          <span class="profile-page-view__community-card-meta">${escapeHtml(formatMemberCount(c.memberCount))}</span>
          ${privacy}
        </span>
      </button>
    `
  }

  private renderBadgesBlock(data: ProfilePageData): string {
    if (!data.badges.length) {
      return `
        <section class="profile-page-view__block">
          <div class="profile-page-view__block-head">
            <h2 class="profile-page-view__block-title">Badges</h2>
          </div>
          <p class="profile-page-view__empty">No badges yet.</p>
        </section>
      `
    }

    const items = data.badges
      .map(
        (badge) => `
          <figure class="profile-page-view__badge" title="${escapeHtml(badge.name)}">
            <img src="${escapeHtml(badge.image)}" alt="${escapeHtml(badge.name)}" loading="lazy" />
            <figcaption>${escapeHtml(badge.name)}</figcaption>
          </figure>
        `
      )
      .join('')

    return `
      <section class="profile-page-view__block">
        <div class="profile-page-view__block-head">
          <h2 class="profile-page-view__block-title">Badges</h2>
          <button type="button" class="profile-page-view__edit-btn" disabled title="Coming soon">Edit</button>
        </div>
        <div class="profile-page-view__badges">${items}</div>
      </section>
    `
  }

  private renderEquipped(wearables: WearableDisplayCard[]): string {
    if (!wearables.length) {
      return `<p class="profile-page-view__empty">No equipped wearables loaded.</p>`
    }

    const peerUrl = this.catalystUrl.replace(/\/$/, '') || 'https://peer.decentraland.org'
    return wearables
      .map((item) => {
        const rarity = item.rarity.toLowerCase()
        const bg = wearableRarityBackground(rarity)
        const color = WEARABLE_RARITY_COLORS[rarity] ?? WEARABLE_RARITY_COLORS.common!
        const thumb =
          resolveContentImageUrl(item.thumbnailUrl, peerUrl) ?? wearableThumbnailUrl(item.urn, peerUrl)
        const fallback = escapeHtml(wearableThumbnailUrl(item.urn, peerUrl))
        return `
          <article class="profile-page-view__wearable is-${escapeHtml(rarity)}" style="--wearable-rarity-bg:${escapeHtml(bg)};--wearable-rarity-color:${escapeHtml(color)}">
            <div class="profile-page-view__wearable-thumb">
              <img src="${escapeHtml(thumb)}" alt="${escapeHtml(item.name)}" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'" />
            </div>
            <div class="profile-page-view__wearable-name">${escapeHtml(item.name)}</div>
            <div class="profile-page-view__wearable-rarity">${escapeHtml(wearableRarityLabel(rarity))}</div>
          </article>
        `
      })
      .join('')
  }

  private wireCommunities(): void {
    for (const img of this.contentEl.querySelectorAll<HTMLImageElement>('.profile-page-view__community-card-media img')) {
      img.addEventListener('error', () => {
        const btn = img.closest('.profile-page-view__community-card')
        const name = btn?.querySelector('.profile-page-view__community-card-name')?.textContent?.trim() ?? '?'
        const initial = name.charAt(0).toUpperCase() || '?'
        const icon = img.parentElement
        if (!icon) return
        icon.innerHTML = `<span class="profile-page-view__community-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`
      })
    }

    for (const btn of this.contentEl.querySelectorAll<HTMLButtonElement>('[data-community-id]')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.communityId
        if (!id) return
        const row = this.communitiesById.get(id)
        if (row) this.communityModal.open(row)
      })
    }
  }

  private async ensureAvatarPreview(token: number): Promise<void> {
    const data = this.loaded
    const stage = this.contentEl.querySelector('[data-avatar-stage]') as HTMLElement | null
    if (!stage || !data?.profile) {
      stage?.classList.add('profile-page-view__avatar-stage--loading')
      return
    }

    const key = data.address
    if (this.avatarAddress === key && this.preview) {
      stage.classList.remove('profile-page-view__avatar-stage--loading')
      return
    }

    stage.classList.add('profile-page-view__avatar-stage--loading')
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (token !== this.loadToken) return

    this.preview?.dispose()
    this.preview = new AvatarPreviewMini(stage)
    this.avatarAddress = key
    const peerUrl = this.catalystUrl.replace(/\/$/, '') || 'https://peer.decentraland.org'
    try {
      await this.preview.showProfile(data.profile, peerUrl, { zoom: 2 })
    } finally {
      if (token === this.loadToken) {
        stage.classList.remove('profile-page-view__avatar-stage--loading')
      }
    }
  }

  private wireHero(shell: HTMLElement, data: ProfilePageData): void {
    shell.querySelector('[data-copy-wallet]')?.addEventListener('click', async () => {
      const btn = shell.querySelector('[data-copy-wallet]') as HTMLButtonElement | null
      try {
        await navigator.clipboard.writeText(data.address)
        btn?.classList.add('is-copied')
        window.setTimeout(() => btn?.classList.remove('is-copied'), 1200)
      } catch {
        console.warn('[profile] clipboard copy failed')
      }
    })

    shell.querySelector('[data-open-external]')?.addEventListener('click', () => {
      window.open(data.profileUrl, '_blank', 'noopener,noreferrer')
    })

    for (const tab of shell.querySelectorAll<HTMLButtonElement>('[data-profile-tab]')) {
      tab.addEventListener('click', () => {
        if (tab.disabled) return
        const id = tab.dataset.profileTab as ProfileTabId | undefined
        if (!id) return
        this.activeTab = id
        for (const btn of shell.querySelectorAll<HTMLButtonElement>('[data-profile-tab]')) {
          const active = btn.dataset.profileTab === id
          btn.classList.toggle('profile-page-view__tab--active', active)
          btn.setAttribute('aria-selected', active ? 'true' : 'false')
        }
        this.renderTabPanel()
      })
    }
  }
}