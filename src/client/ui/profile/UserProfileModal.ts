import { shortenAddress } from '../../../avatar/displayName'
import { resolveRemotePeerProfile } from '../../../avatar/peerApi'
import type { AvatarProfile } from '../../../avatar/types'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import { fetchUserBadges, type UserBadge } from '../../../social/badgesApi'
import type { SocialService } from '../../../social/SocialService'
import { friendshipActionLabel } from '../../../social/friendshipsApi'
import { AvatarPreviewMini } from './AvatarPreviewMini'
import {
  fetchWearableDisplayCards,
  type WearableDisplayCard,
  wearableRarityBackground,
  wearableRarityLabel,
  WEARABLE_RARITY_COLORS
} from './wearableThumb'

export type UserProfileModalTarget =
  | { kind: 'local' }
  | { kind: 'remote'; address: string }

type TabId = 'overview' | 'badges' | 'photos'

type LoadedProfile = {
  address: string | undefined
  profile: AvatarProfile | null
  displayName: string
  nameColor: string
  claimed: boolean
  isSelf: boolean
  relation: ReturnType<SocialService['getFriendshipRelation']>
  badges: UserBadge[]
  wearables: WearableDisplayCard[]
  profileUrl: string
}

/** Full profile card — opens from context menu, chat, or sidebar. */
export class UserProfileModal {
  private readonly root: HTMLElement
  private readonly backdrop: HTMLElement
  private visible = false
  private target: UserProfileModalTarget | null = null
  private activeTab: TabId = 'overview'
  private preview: AvatarPreviewMini | null = null
  private loadToken = 0
  private loaded: LoadedProfile | null = null
  private avatarAddress: string | null = null

  constructor(
    private readonly session: SessionIdentity,
    private readonly social: SocialService,
    private readonly getPeerUrl: () => string,
    private readonly onHide?: () => void
  ) {
    this.backdrop = document.createElement('div')
    this.backdrop.className = 'user-profile-modal-backdrop'
    this.backdrop.hidden = true
    this.backdrop.addEventListener('click', () => this.hide())

    this.root = document.createElement('div')
    this.root.className = 'user-profile-modal'
    this.root.hidden = true
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', 'User profile')

    document.body.appendChild(this.backdrop)
    document.body.appendChild(this.root)

    window.addEventListener('keydown', this.onKeyDown)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    this.preview?.dispose()
    this.preview = null
    this.root.remove()
    this.backdrop.remove()
  }

  isOpen(): boolean {
    return this.visible
  }

  async show(target: UserProfileModalTarget): Promise<void> {
    if (document.pointerLockElement) document.exitPointerLock()
    this.target = target
    this.activeTab = 'overview'
    this.loaded = null
    this.avatarAddress = null
    this.renderShell()
    this.visible = true
    this.root.hidden = false
    this.backdrop.hidden = false
    void this.loadContent(true)
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.target = null
    this.loaded = null
    this.avatarAddress = null
    this.loadToken++
    this.preview?.dispose()
    this.preview = null
    this.root.innerHTML = ''
    this.root.hidden = true
    this.backdrop.hidden = true
    this.onHide?.()
  }

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') this.hide()
  }

  private renderShell(): void {
    const label =
      this.target?.kind === 'remote'
        ? shortenAddress(this.target.address)
        : this.session.getAddress()
          ? shortenAddress(this.session.getAddress()!)
          : 'Profile'

    this.root.innerHTML = `
      <header class="user-profile-modal__header">
        <div class="user-profile-modal__header-main">
          <div class="user-profile-modal__title-row">
            <h2 class="user-profile-modal__title user-profile-modal__skeleton-text">${escapeHtml(label)}</h2>
          </div>
          <div class="user-profile-modal__wallet-row user-profile-modal__skeleton-line"></div>
          <div class="user-profile-modal__mutual user-profile-modal__skeleton-line user-profile-modal__skeleton-line--short"></div>
        </div>
        <div class="user-profile-modal__header-actions">
          <button type="button" class="user-profile-modal__close" aria-label="Close profile">×</button>
        </div>
      </header>
      <nav class="user-profile-modal__tabs" aria-label="Profile sections">
        <button type="button" class="user-profile-modal__tab is-active" data-tab="overview">Overview</button>
        <button type="button" class="user-profile-modal__tab" data-tab="badges">Badges</button>
        <button type="button" class="user-profile-modal__tab" data-tab="photos">Photos</button>
      </nav>
      <div class="user-profile-modal__body">
        <div class="user-profile-modal__avatar-stage user-profile-modal__avatar-stage--loading">
          <div class="user-profile-modal__loading-spinner" aria-hidden="true"></div>
        </div>
        <div class="user-profile-modal__content user-profile-modal__content--loading">
          <div class="user-profile-modal__skeleton-block"></div>
          <div class="user-profile-modal__skeleton-block"></div>
          <div class="user-profile-modal__skeleton-block user-profile-modal__skeleton-block--short"></div>
        </div>
      </div>
    `

    this.wireChromeHandlers()
  }

  private wireChromeHandlers(): void {
    this.root.querySelector('.user-profile-modal__close')?.addEventListener('click', () => this.hide())
    for (const tab of this.root.querySelectorAll<HTMLButtonElement>('.user-profile-modal__tab')) {
      tab.addEventListener('click', () => {
        const next = tab.dataset.tab as TabId | undefined
        if (!next || next === this.activeTab) return
        this.activeTab = next
        this.syncTabButtons()
        this.renderContentPanel()
      })
    }
  }

  private syncTabButtons(): void {
    for (const tab of this.root.querySelectorAll<HTMLButtonElement>('.user-profile-modal__tab')) {
      const id = tab.dataset.tab as TabId | undefined
      tab.classList.toggle('is-active', id === this.activeTab)
    }
  }

  private async loadContent(refetch = false): Promise<void> {
    if (!this.target) return
    const token = ++this.loadToken

    if (!refetch && this.loaded) {
      this.renderChrome()
      this.renderContentPanel()
      return
    }

    const peerUrl = this.getPeerUrl()
    let address: string | undefined
    let profile: AvatarProfile | null = null
    let isSelf = false
    let relation = this.social.getFriendshipRelation('')

    if (this.target.kind === 'local') {
      address = this.session.getAddress() ?? undefined
      profile = this.session.getProfile()
      isSelf = true
    } else {
      address = this.target.address.toLowerCase()
      isSelf = address === this.session.getAddress()?.toLowerCase()
      await Promise.all([
        this.social.ensureFriendshipSnapshot(),
        this.social.ensurePeerProfile(address)
      ])
      if (token !== this.loadToken || !this.visible) return
      relation = this.social.getFriendshipRelation(address)
      profile = await resolveRemotePeerProfile(address, peerUrl)
    }

    if (token !== this.loadToken || !this.visible) return

    const peer = address ? this.social.getPeerDisplay(address) : this.social.getLocalDisplay()
    const displayName = profile?.displayName?.trim() || peer.displayName
    const nameColor = profile?.nameColor ?? peer.nameColor
    const claimed = profile?.hasClaimedName ?? false
    const profileUrl = address
      ? `https://decentraland.org/profile/accounts/${address}`
      : 'https://decentraland.org/profile'

    const [badges, wearables] = await Promise.all([
      address ? fetchUserBadges(address) : Promise.resolve([]),
      profile ? fetchWearableDisplayCards(profile.wearables, peerUrl) : Promise.resolve([])
    ])

    if (token !== this.loadToken || !this.visible) return

    this.loaded = {
      address,
      profile,
      displayName,
      nameColor,
      claimed,
      isSelf,
      relation,
      badges,
      wearables,
      profileUrl
    }

    this.renderChrome()
    this.renderContentPanel()
    void this.ensureAvatarPreview(token)
  }

  private renderChrome(): void {
    const data = this.loaded
    if (!data) return

    const { address, displayName, nameColor, claimed, isSelf, relation, profileUrl } = data
    const friendBtn = isSelf ? null : friendshipActionLabel(relation)
    const friendBtnHtml = friendBtn
      ? `<button type="button" class="user-profile-modal__add-friend is-${friendBtn.variant}"${friendBtn.disabled ? ' disabled' : ''}>${escapeHtml(friendBtn.variant === 'add' ? `+ ${friendBtn.label}` : friendBtn.label)}</button>`
      : ''

    const header = this.root.querySelector('.user-profile-modal__header')
    if (!header) return

    header.innerHTML = `
      <div class="user-profile-modal__header-main">
        <div class="user-profile-modal__title-row">
          <h2 class="user-profile-modal__title" style="color:${nameColor}">${escapeHtml(displayName)}</h2>
          ${claimed ? '<span class="user-profile-modal__verified" title="Verified name">✓</span>' : ''}
        </div>
        ${
          address
            ? `<div class="user-profile-modal__wallet-row">
                <code class="user-profile-modal__wallet">${shortenAddress(address)}</code>
                <button type="button" class="user-profile-modal__copy" data-copy="${address}" aria-label="Copy wallet address">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/>
                    <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.6"/>
                  </svg>
                </button>
              </div>`
            : ''
        }
        <div class="user-profile-modal__mutual">${relation === 'friends' ? 'Friend · Scene player' : 'Scene player'}</div>
      </div>
      <div class="user-profile-modal__header-actions">
        ${friendBtnHtml}
        <button type="button" class="user-profile-modal__icon-btn" data-action="external" aria-label="Open on decentraland.org">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 5h5v5M10 14 19 5M19 14v5H5V5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button type="button" class="user-profile-modal__close" aria-label="Close profile">×</button>
      </div>
    `

    header.querySelector('.user-profile-modal__close')?.addEventListener('click', () => this.hide())
    header.querySelector('[data-action="external"]')?.addEventListener('click', () => {
      window.open(profileUrl, '_blank', 'noopener,noreferrer')
    })
    header.querySelector('.user-profile-modal__copy')?.addEventListener('click', async (ev) => {
      if (!address) return
      const btn = ev.currentTarget as HTMLButtonElement
      try {
        await navigator.clipboard.writeText(address)
        btn.classList.add('is-copied')
        setTimeout(() => btn.classList.remove('is-copied'), 1200)
      } catch {
        console.warn('[profile] clipboard copy failed')
      }
    })
    const addFriendBtn = header.querySelector('.user-profile-modal__add-friend') as HTMLButtonElement | null
    addFriendBtn?.addEventListener('click', () => {
      if (addFriendBtn.disabled || !address) return
      console.info('[profile] Add friend — coming soon', address)
    })
  }

  private renderContentPanel(): void {
    const panel = this.root.querySelector('.user-profile-modal__content')
    if (!panel || !this.loaded) return
    panel.classList.remove('user-profile-modal__content--loading')
    panel.innerHTML = this.renderTabBody(this.loaded)
  }

  private async ensureAvatarPreview(token: number): Promise<void> {
    const data = this.loaded
    const stage = this.root.querySelector('.user-profile-modal__avatar-stage') as HTMLElement | null
    if (!stage || !data?.profile) {
      stage?.classList.add('user-profile-modal__avatar-stage--loading')
      return
    }

    const key = data.address ?? 'local'
    if (this.avatarAddress === key && this.preview) {
      stage.classList.remove('user-profile-modal__avatar-stage--loading')
      return
    }

    stage.classList.add('user-profile-modal__avatar-stage--loading')
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (token !== this.loadToken || !this.visible) return

    this.preview?.dispose()
    this.preview = new AvatarPreviewMini(stage)
    this.avatarAddress = key
    try {
      await this.preview.showProfile(data.profile, this.getPeerUrl())
    } finally {
      if (token === this.loadToken && this.visible) {
        stage.classList.remove('user-profile-modal__avatar-stage--loading')
      }
    }
  }

  private renderTabBody(data: LoadedProfile): string {
    if (this.activeTab === 'badges') {
      return this.renderBadgesSection(data.badges, true)
    }
    if (this.activeTab === 'photos') {
      return `<section class="user-profile-modal__section"><h3>Photos</h3><p class="user-profile-modal__empty">Photos coming soon.</p></section>`
    }
    return `
      ${this.renderBadgesSection(data.badges, false)}
      <section class="user-profile-modal__section">
        <h3>About Me</h3>
        <p class="user-profile-modal__about">—</p>
      </section>
      <section class="user-profile-modal__section">
        <h3>Links</h3>
        <p class="user-profile-modal__empty">No links.</p>
      </section>
      <section class="user-profile-modal__section">
        <h3>Equipped Items</h3>
        <div class="user-profile-modal__wearables">${this.renderWearables(data.wearables)}</div>
      </section>
    `
  }

  private renderBadgesSection(badges: UserBadge[], fullTab: boolean): string {
    if (!badges.length) {
      return `<section class="user-profile-modal__section"><h3>Badges</h3><p class="user-profile-modal__empty">No badges yet.</p></section>`
    }
    const items = badges
      .map(
        (badge) => `
          <div class="user-profile-modal__badge" title="${escapeHtml(badge.name)}">
            <img src="${escapeHtml(badge.image)}" alt="${escapeHtml(badge.name)}" loading="lazy" />
          </div>
        `
      )
      .join('')
    const scrollClass = fullTab
      ? 'user-profile-modal__badges-scroll user-profile-modal__badges-scroll--grid'
      : 'user-profile-modal__badges-scroll'
    return `
      <section class="user-profile-modal__section">
        <h3>Badges</h3>
        <div class="${scrollClass}">${items}</div>
      </section>
    `
  }

  private renderWearables(wearables: WearableDisplayCard[]): string {
    if (!wearables.length) {
      return `<p class="user-profile-modal__empty">No equipped wearables loaded.</p>`
    }
    return wearables
      .map((item) => {
        const rarity = item.rarity.toLowerCase()
        const bg = wearableRarityBackground(rarity)
        const color = WEARABLE_RARITY_COLORS[rarity] ?? WEARABLE_RARITY_COLORS.common!
        return `
          <article class="user-profile-modal__wearable is-${escapeHtml(rarity)}" style="--wearable-rarity-bg:${escapeHtml(bg)};--wearable-rarity-color:${escapeHtml(color)}">
            <div class="user-profile-modal__wearable-thumb">
              <img src="${escapeHtml(item.thumbnailUrl)}" alt="${escapeHtml(item.name)}" loading="lazy" />
            </div>
            <div class="user-profile-modal__wearable-name">${escapeHtml(item.name)}</div>
            <div class="user-profile-modal__wearable-rarity">${escapeHtml(wearableRarityLabel(rarity))}</div>
          </article>
        `
      })
      .join('')
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}