import { shortenAddress } from '../../../avatar/displayName'
import { resolveRemotePeerProfile } from '../../../avatar/peerApi'
import type { AvatarProfile } from '../../../avatar/types'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import { fetchUserBadges, type UserBadge } from '../../../social/badgesApi'
import {
  type DclGalleryImage,
  fetchUserGallery,
  formatGalleryDateTime,
  galleryReelsUrl,
  parseGalleryDateTime
} from '../../../social/dclGallery'
import type { SocialService } from '../../../social/SocialService'
import { friendshipActionLabel } from '../../../social/friendshipsApi'
import { AvatarPreviewMini } from './AvatarPreviewMini'
import { fetchEmoteDisplayCards, type EmoteDisplayCard } from './emoteCards'
import {
  fetchWearableDisplayCards,
  renderRarityCard,
  resolveContentImageUrl,
  type WearableDisplayCard,
  wearableThumbnailUrl
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
  emotes: EmoteDisplayCard[]
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
  private photos: DclGalleryImage[] = []
  private photosState: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
  private photosError: string | null = null
  /** Address the loaded photos belong to, so a re-opened modal refetches. */
  private photosAddress: string | null = null

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
    this.resetPhotos()
    this.renderShell()
    this.visible = true
    document.body.appendChild(this.backdrop)
    document.body.appendChild(this.root)
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
    this.resetPhotos()
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

    // Photo tiles are re-rendered on every state change — delegate from the
    // panel, which survives until the next renderShell().
    this.root.querySelector('.user-profile-modal__content')?.addEventListener('click', (ev) => {
      const tile = (ev.target as HTMLElement).closest('[data-photo-url]') as HTMLElement | null
      const url = tile?.getAttribute('data-photo-url')
      if (url) window.open(url, '_blank', 'noopener,noreferrer')
    })
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

    const peerUrl = this.getPeerUrl().replace(/\/$/, '') || 'https://peer.decentraland.org'
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

    const [badges, wearables, emotes] = await Promise.all([
      address ? fetchUserBadges(address) : Promise.resolve([]),
      profile ? fetchWearableDisplayCards(profile.wearables, peerUrl) : Promise.resolve([]),
      profile ? fetchEmoteDisplayCards(profile.emotes, peerUrl) : Promise.resolve([])
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
      emotes,
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

    if (this.activeTab !== 'photos') return
    if (this.photosState === 'idle') {
      void this.loadPhotos()
      return
    }
    for (const img of panel.querySelectorAll<HTMLImageElement>('.user-profile-modal__photo-img')) {
      img.addEventListener('error', () => img.classList.add('is-broken'))
    }
  }

  private resetPhotos(): void {
    this.photos = []
    this.photosState = 'idle'
    this.photosError = null
    this.photosAddress = null
  }

  /**
   * Camera Reel gallery for the profile being viewed. Own profile uses the
   * signed identity (private photos included); other players are fetched
   * unsigned, so the service only returns photos they marked public.
   */
  private async loadPhotos(): Promise<void> {
    const data = this.loaded
    const address = data?.address?.trim().toLowerCase()
    const token = this.loadToken

    if (!address) {
      this.photos = []
      this.photosState = 'ready'
      this.photosAddress = null
      if (this.activeTab === 'photos') this.renderContentPanel()
      return
    }

    this.photosAddress = address
    this.photosState = 'loading'
    this.photosError = null
    if (this.activeTab === 'photos') this.renderContentPanel()

    try {
      const identity = data?.isSelf ? this.session.getAuthIdentity() : null
      const gallery = await fetchUserGallery(address, identity)
      if (token !== this.loadToken || !this.visible || this.photosAddress !== address) return
      this.photos = [...gallery.images].sort(
        (a, b) =>
          (parseGalleryDateTime(b.dateTime)?.getTime() ?? 0) -
          (parseGalleryDateTime(a.dateTime)?.getTime() ?? 0)
      )
      this.photosState = 'ready'
    } catch (err) {
      if (token !== this.loadToken || !this.visible || this.photosAddress !== address) return
      console.warn('[profile] gallery load failed', address, err)
      this.photos = []
      this.photosError = err instanceof Error ? err.message : String(err)
      this.photosState = 'error'
    }

    if (this.activeTab === 'photos') this.renderContentPanel()
  }

  private async ensureAvatarPreview(token: number): Promise<void> {
    const data = this.loaded
    const stage = this.root.querySelector('.user-profile-modal__avatar-stage') as HTMLElement | null
    if (!stage) return
    if (!data?.profile) {
      // Peer profile never resolved — a spinner that never stops reads as a hang.
      this.setAvatarStageState(stage, 'empty')
      return
    }

    const key = data.address ?? 'local'
    if (this.avatarAddress === key && this.preview) {
      this.setAvatarStageState(stage, 'ready')
      return
    }

    this.setAvatarStageState(stage, 'loading')
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (token !== this.loadToken || !this.visible) return

    this.preview?.dispose()
    const preview = new AvatarPreviewMini(stage)
    this.preview = preview
    this.avatarAddress = key
    let shown = false
    try {
      shown = await preview.showProfile(data.profile, this.getPeerUrl())
    } finally {
      if (this.preview === preview && this.visible) {
        if (!shown) this.avatarAddress = null
        this.setAvatarStageState(stage, shown ? 'ready' : 'empty')
      }
    }
  }

  /** Spinner, avatar, or "unavailable" — the stage always leaves the loading state. */
  private setAvatarStageState(stage: HTMLElement, state: 'loading' | 'ready' | 'empty'): void {
    stage.classList.toggle('user-profile-modal__avatar-stage--loading', state === 'loading')
    const note = stage.querySelector('.user-profile-modal__avatar-empty')
    if (state !== 'empty') {
      note?.remove()
      return
    }
    if (note) return
    const el = document.createElement('p')
    el.className = 'user-profile-modal__avatar-empty'
    el.textContent = 'Avatar preview unavailable'
    stage.appendChild(el)
  }

  private renderTabBody(data: LoadedProfile): string {
    if (this.activeTab === 'badges') {
      return this.renderBadgesSection(data.badges, true)
    }
    if (this.activeTab === 'photos') {
      return this.renderPhotosSection(data)
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
      <section class="user-profile-modal__section">
        <h3>Emotes</h3>
        <div class="user-profile-modal__wearables">${this.renderEmotes(data.emotes)}</div>
      </section>
    `
  }

  private renderPhotosSection(data: LoadedProfile): string {
    const shell = (heading: string, body: string): string =>
      `<section class="user-profile-modal__section"><h3>${heading}</h3>${body}</section>`

    if (this.photosState === 'idle' || this.photosState === 'loading') {
      const skeletons = Array.from(
        { length: 6 },
        () => `<div class="user-profile-modal__photo-skeleton" role="presentation"></div>`
      ).join('')
      return shell('Photos', `<div class="user-profile-modal__photos">${skeletons}</div>`)
    }

    if (this.photosState === 'error') {
      return shell(
        'Photos',
        `<p class="user-profile-modal__empty">${escapeHtml(
          this.photosError || 'Could not load photos.'
        )}</p>`
      )
    }

    if (!this.photos.length) {
      const empty = data.isSelf
        ? 'No photos yet. Press <kbd>C</kbd> in-world for the camera, then Save.'
        : 'No public photos. Only photos this player marked public are visible here.'
      return shell('Photos', `<p class="user-profile-modal__empty">${empty}</p>`)
    }

    const tiles = this.photos
      .map((photo) => {
        const when = formatGalleryDateTime(photo.dateTime, 'short')
        const src = photo.thumbnailUrl || photo.url
        // Match /profile My Photos: private images only appear on own gallery (signed fetch).
        const visibility = photo.isPublic
          ? ''
          : `<span class="user-profile-modal__photo-private" title="Only you can see this photo">Private</span>`
        return `
          <button
            type="button"
            class="user-profile-modal__photo"
            data-photo-url="${escapeHtml(galleryReelsUrl(photo.id))}"
            title="${escapeHtml(when)}"
            aria-label="Open photo from ${escapeHtml(when)}"
          >
            <img
              class="user-profile-modal__photo-img"
              src="${escapeHtml(src)}"
              alt=""
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
            />
            ${visibility}
            <span class="user-profile-modal__photo-date">${escapeHtml(when)}</span>
          </button>`
      })
      .join('')

    const heading = `Photos <span class="user-profile-modal__count">${this.photos.length}</span>`
    return shell(heading, `<div class="user-profile-modal__photos">${tiles}</div>`)
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
    const peerUrl = this.getPeerUrl().replace(/\/$/, '') || 'https://peer.decentraland.org'
    return wearables
      .map((item) =>
        renderRarityCard({
          name: item.name,
          rarity: item.rarity,
          thumbnailUrl:
            resolveContentImageUrl(item.thumbnailUrl, peerUrl) ??
            wearableThumbnailUrl(item.urn, peerUrl),
          fallbackThumbnailUrl: wearableThumbnailUrl(item.urn, peerUrl)
        })
      )
      .join('')
  }

  private renderEmotes(emotes: EmoteDisplayCard[]): string {
    if (!emotes.length) {
      return `<p class="user-profile-modal__empty">No emotes equipped.</p>`
    }
    const peerUrl = this.getPeerUrl().replace(/\/$/, '') || 'https://peer.decentraland.org'
    return [...emotes]
      .sort((a, b) => a.slot - b.slot)
      .map((item) =>
        renderRarityCard({
          name: item.name,
          rarity: item.rarity,
          thumbnailUrl:
            resolveContentImageUrl(item.thumbnailUrl, peerUrl) ??
            wearableThumbnailUrl(item.urn, peerUrl),
          fallbackThumbnailUrl: wearableThumbnailUrl(item.urn, peerUrl),
          badge: String(item.slot + 1),
          badgeTitle: `Emote wheel slot ${item.slot + 1}`
        })
      )
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