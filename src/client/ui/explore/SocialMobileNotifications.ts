import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { LoginResult } from '../../../auth/AuthClient'
import { notificationPrefs } from '../../../social/notificationPrefs'
import { resolveNotificationPeer } from '../../../social/resolveNotificationPeer'
import type { SocialChatEvent, SocialService } from '../../../social/SocialService'
import { isChatImageLine, isChatTextLine } from '../../../social/types'
import {
  CommunityHudToastWatcher,
  type CommunityAnnouncementToast,
  type CommunityVoiceToast
} from './CommunityHudToastWatcher'

export type SocialMobileNotificationsOptions = {
  login: LoginResult
  getSocial: () => SocialService | null
  getAuthIdentity?: () => AuthIdentity | null
  getUserAddress?: () => string | null
  onEnsureSocial?: () => Promise<void>
  onOpenChat?: () => void
  onOpenUserProfile?: (address: string) => void
  /** Open community detail (announcement / voice toast click). */
  onOpenCommunity?: (communityId: string, kind: 'announcement' | 'voice') => void
  /**
   * Skip chat banners while the user is actively reading that channel's thread.
   * `channelKey` is the SocialService key for the incoming message (`scene:…`).
   */
  isChatNotificationSuppressed?: (channelKey: string) => boolean
}

const DESKTOP_MQ = '(min-width: 768px)'
const AUTO_DISMISS_MS = 5000
const COMMUNITY_AUTO_DISMISS_MS = 7000
const MAX_VISIBLE = 3

type PendingBanner = {
  id: string
  el: HTMLElement
  dismissTimer: number
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Transient toast banners — mobile: full-width from top; desktop: top-right. No nav trigger. */
export class SocialMobileNotifications {
  readonly host: HTMLElement

  private login: LoginResult
  private readonly getSocial: SocialMobileNotificationsOptions['getSocial']
  private readonly getAuthIdentity?: SocialMobileNotificationsOptions['getAuthIdentity']
  private readonly getUserAddress?: SocialMobileNotificationsOptions['getUserAddress']
  private readonly onEnsureSocial?: SocialMobileNotificationsOptions['onEnsureSocial']
  private readonly onOpenChat?: SocialMobileNotificationsOptions['onOpenChat']
  private readonly onOpenUserProfile?: SocialMobileNotificationsOptions['onOpenUserProfile']
  private readonly onOpenCommunity?: SocialMobileNotificationsOptions['onOpenCommunity']
  private readonly isChatNotificationSuppressed?: SocialMobileNotificationsOptions['isChatNotificationSuppressed']

  private readonly desktopMq = window.matchMedia(DESKTOP_MQ)
  private readonly onDesktopMqChange = (): void => {
    this.host.classList.toggle('social-mobile-notif-host--desktop', this.isDesktop())
  }

  private unsubChannel: (() => void) | null = null
  private unsubFriendship: (() => void) | null = null
  private unsubChat: (() => void) | null = null
  private unsubPrefs: (() => void) | null = null
  private communityWatcher: CommunityHudToastWatcher | null = null

  private baselineReady = false
  private knownIncoming = new Set<string>()
  private readonly banners: PendingBanner[] = []

  constructor(opts: SocialMobileNotificationsOptions) {
    this.login = opts.login
    this.getSocial = opts.getSocial
    this.getAuthIdentity = opts.getAuthIdentity
    this.getUserAddress = opts.getUserAddress
    this.onEnsureSocial = opts.onEnsureSocial
    this.onOpenChat = opts.onOpenChat
    this.onOpenUserProfile = opts.onOpenUserProfile
    this.onOpenCommunity = opts.onOpenCommunity
    this.isChatNotificationSuppressed = opts.isChatNotificationSuppressed

    this.host = document.createElement('div')
    this.host.className = 'social-mobile-notif-host'
    this.host.setAttribute('aria-live', 'polite')
    this.host.hidden = true
  }

  mount(): void {
    document.body.appendChild(this.host)
    this.host.classList.toggle('social-mobile-notif-host--desktop', this.isDesktop())
    this.desktopMq.addEventListener('change', this.onDesktopMqChange)
    this.unsubPrefs = notificationPrefs.subscribe((state) => {
      if (!state.enabled) {
        this.clearAll()
        this.communityWatcher?.stop()
      } else {
        this.syncCommunityWatcher()
      }
    })
    void this.seedBaseline()
  }

  setLogin(login: LoginResult): void {
    this.login = login
    this.baselineReady = false
    this.knownIncoming.clear()
    this.clearAll()
    this.communityWatcher?.stop()
    void this.seedBaseline()
  }

  dispose(): void {
    this.desktopMq.removeEventListener('change', this.onDesktopMqChange)
    this.unsubPrefs?.()
    this.unsubPrefs = null
    this.unbindSocialListeners()
    this.communityWatcher?.dispose()
    this.communityWatcher = null
    this.clearAll()
    this.host.remove()
  }

  private isDesktop(): boolean {
    return this.desktopMq.matches
  }

  private isSignedIn(): boolean {
    return this.login.kind === 'wallet' || this.login.kind === 'guest'
  }

  private canShow(): boolean {
    return this.isSignedIn() && notificationPrefs.isEnabled()
  }

  private async seedBaseline(): Promise<void> {
    if (!this.isSignedIn()) {
      this.unbindSocialListeners()
      this.communityWatcher?.stop()
      return
    }
    await this.onEnsureSocial?.()
    this.bindSocialListeners()
    const social = this.getSocial()
    if (!social) {
      this.syncCommunityWatcher()
      return
    }
    // Friend requests only for real wallets; guests still get chat banners.
    if (this.login.kind === 'wallet') {
      await social.refreshFriendshipSnapshot()
      this.knownIncoming = new Set(social.getIncomingFriendAddresses())
    } else {
      this.knownIncoming = new Set()
    }
    this.baselineReady = true
    this.syncCommunityWatcher()
  }

  private syncCommunityWatcher(): void {
    if (this.login.kind !== 'wallet' || !notificationPrefs.isEnabled()) {
      this.communityWatcher?.stop()
      return
    }
    if (!this.communityWatcher) {
      this.communityWatcher = new CommunityHudToastWatcher({
        getAuthIdentity: () => this.getAuthIdentity?.() ?? null,
        getUserAddress: () => this.getUserAddress?.() ?? null,
        getMemberCommunities: () => this.getSocial()?.getCommunities() ?? [],
        onAnnouncement: (t) => this.pushCommunityAnnouncementBanner(t),
        onVoiceStarted: (t) => this.pushCommunityVoiceBanner(t)
      })
    }
    this.communityWatcher.start()
  }

  private pushCommunityAnnouncementBanner(toast: CommunityAnnouncementToast): void {
    if (!this.canShow()) return
    const title = toast.communityDisplayName
    const sub = toast.text || 'New announcement'
    const face = toast.imageUrl
      ? `<img class="social-mobile-notif__avatar-img" src="${escapeHtml(toast.imageUrl)}" alt="" width="40" height="40" loading="lazy" />`
      : `<span class="social-mobile-notif__avatar-fallback" aria-hidden="true">${escapeHtml(
          title.charAt(0).toUpperCase() || 'C'
        )}</span>`

    const banner = document.createElement('button')
    banner.type = 'button'
    banner.className = 'social-mobile-notif'
    banner.setAttribute('aria-label', `Announcement in ${title}: ${sub}`)
    banner.innerHTML = `
      <div class="social-mobile-notif__card">
        <div class="social-mobile-notif__header">
          <span class="social-mobile-notif__app-icon" aria-hidden="true">D</span>
          <span class="social-mobile-notif__app-name">COMMUNITY · ANNOUNCEMENT</span>
          <span class="social-mobile-notif__time">now</span>
        </div>
        <div class="social-mobile-notif__body">
          <span class="social-mobile-notif__avatar">${face}</span>
          <span class="social-mobile-notif__text">
            <span class="social-mobile-notif__title">${escapeHtml(title)}</span>
            <span class="social-mobile-notif__sub">${escapeHtml(sub)}</span>
          </span>
        </div>
      </div>
    `
    banner.addEventListener('click', () => {
      this.dismissBanner(banner)
      this.onOpenCommunity?.(toast.communityId, 'announcement')
    })
    this.showBanner(banner, `c-ann:${toast.communityId}:${Date.now()}`, COMMUNITY_AUTO_DISMISS_MS)
  }

  private pushCommunityVoiceBanner(toast: CommunityVoiceToast): void {
    if (!this.canShow()) return
    const title = toast.communityDisplayName
    const face = toast.imageUrl
      ? `<img class="social-mobile-notif__avatar-img" src="${escapeHtml(toast.imageUrl)}" alt="" width="40" height="40" loading="lazy" />`
      : `<span class="social-mobile-notif__avatar-fallback" aria-hidden="true">${escapeHtml(
          title.charAt(0).toUpperCase() || 'C'
        )}</span>`

    const banner = document.createElement('button')
    banner.type = 'button'
    banner.className = 'social-mobile-notif'
    banner.setAttribute(
      'aria-label',
      `${title} · Voice. Live now — open Communities to listen or join.`
    )
    banner.innerHTML = `
      <div class="social-mobile-notif__card">
        <div class="social-mobile-notif__header">
          <span class="social-mobile-notif__app-icon" aria-hidden="true">D</span>
          <span class="social-mobile-notif__app-name">COMMUNITY · VOICE</span>
          <span class="social-mobile-notif__time">now</span>
        </div>
        <div class="social-mobile-notif__body">
          <span class="social-mobile-notif__avatar">${face}</span>
          <span class="social-mobile-notif__text">
            <span class="social-mobile-notif__title">${escapeHtml(title)} · Voice</span>
            <span class="social-mobile-notif__sub">Live now — open Communities to listen or join.</span>
          </span>
        </div>
      </div>
    `
    banner.addEventListener('click', () => {
      this.dismissBanner(banner)
      this.onOpenCommunity?.(toast.communityId, 'voice')
    })
    this.showBanner(banner, `c-voice:${toast.communityId}:${Date.now()}`, COMMUNITY_AUTO_DISMISS_MS)
  }

  private bindSocialListeners(): void {
    this.unbindSocialListeners()
    const social = this.getSocial()
    if (!social || !this.isSignedIn()) return

    const onChange = (): void => {
      void this.handleSocialChange()
    }
    this.unsubChannel = social.onChannelChange(onChange)
    this.unsubFriendship = social.onFriendshipChange(onChange)
    this.unsubChat = social.onChat((event) => {
      this.handleChatEvent(event)
    })
  }

  private unbindSocialListeners(): void {
    this.unsubChannel?.()
    this.unsubFriendship?.()
    this.unsubChat?.()
    this.unsubChannel = null
    this.unsubFriendship = null
    this.unsubChat = null
  }

  private handleChatEvent(event: SocialChatEvent): void {
    if (!this.baselineReady || !this.canShow()) return
    if (event.line.self) return
    if (this.isChatNotificationSuppressed?.(event.channelKey)) return
    void this.pushMessageBanner(event)
  }

  private async handleSocialChange(): Promise<void> {
    if (!this.baselineReady || !this.canShow()) return
    if (this.login.kind !== 'wallet') return
    const social = this.getSocial()
    if (!social) return

    const incoming = social.getIncomingFriendAddresses()
    for (const address of incoming) {
      if (!this.knownIncoming.has(address)) {
        void this.pushFriendBanner(address)
      }
    }
    this.knownIncoming = new Set(incoming)
  }

  private async pushFriendBanner(address: string): Promise<void> {
    if (!this.canShow()) return

    const peer = await resolveNotificationPeer(address, this.getSocial())
    if (!this.canShow()) return

    const { displayName, faceUrl } = peer
    const initial = displayName.trim().charAt(0).toUpperCase() || '?'
    const avatar = faceUrl
      ? `<img class="social-mobile-notif__avatar-img" src="${escapeHtml(faceUrl)}" alt="" width="40" height="40" loading="lazy" />`
      : `<span class="social-mobile-notif__avatar-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`

    const banner = document.createElement('button')
    banner.type = 'button'
    banner.className = 'social-mobile-notif'
    banner.setAttribute('aria-label', `Friend request from ${displayName}`)
    banner.innerHTML = `
      <div class="social-mobile-notif__card">
        <div class="social-mobile-notif__header">
          <span class="social-mobile-notif__app-icon" aria-hidden="true">D</span>
          <span class="social-mobile-notif__app-name">DECENTRALAND</span>
          <span class="social-mobile-notif__time">now</span>
        </div>
        <div class="social-mobile-notif__body">
          <span class="social-mobile-notif__avatar">${avatar}</span>
          <span class="social-mobile-notif__text">
            <span class="social-mobile-notif__title">${escapeHtml(displayName)}</span>
            <span class="social-mobile-notif__sub">Wants to be friends</span>
          </span>
        </div>
      </div>
    `

    banner.addEventListener('click', () => {
      this.dismissBanner(banner)
      this.onOpenUserProfile?.(peer.address)
    })

    this.showBanner(banner, `friend:${peer.address}`)
  }

  private async resolveMessageSender(
    line: SocialChatEvent['line'],
    social: SocialService | null
  ): Promise<{ address: string; displayName: string; faceUrl: string | null }> {
    let address = line.senderAddress?.trim()
    if (!address && isChatTextLine(line)) {
      const maybeAddress = line.senderName?.trim()
      if (maybeAddress && /^0x[a-f0-9]{40}$/i.test(maybeAddress)) {
        address = maybeAddress
      }
    }
    if (address) return resolveNotificationPeer(address, social)

    const senderLabel = isChatTextLine(line) ? line.senderName?.trim() : ''
    return { address: '', displayName: senderLabel || 'Someone', faceUrl: null }
  }

  private async pushMessageBanner(event: SocialChatEvent): Promise<void> {
    if (!this.canShow()) return
    const line = event.line
    const social = this.getSocial()

    const { displayName, faceUrl } = await this.resolveMessageSender(line, social)
    if (!this.canShow()) return

    let preview = 'Sent a message'
    if (isChatImageLine(line)) preview = 'Sent an image'
    else if (isChatTextLine(line)) preview = line.text.trim() || preview
    if (preview.length > 72) preview = `${preview.slice(0, 69)}…`

    const channelLabel = social?.labelForChannelKey(event.channelKey) ?? 'Chat'
    const channelKind = event.channelKey.startsWith('community:')
      ? 'Community'
      : event.channelKey === 'messages'
        ? 'Private'
        : 'Scene'
    const channelLine = `${channelKind} · ${channelLabel}`

    const initial = displayName.trim().charAt(0).toUpperCase() || '?'
    const avatar = faceUrl
      ? `<img class="social-mobile-notif__avatar-img" src="${escapeHtml(faceUrl)}" alt="" width="40" height="40" loading="lazy" />`
      : `<span class="social-mobile-notif__avatar-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`

    const banner = document.createElement('button')
    banner.type = 'button'
    banner.className = 'social-mobile-notif'
    banner.setAttribute(
      'aria-label',
      `Message from ${displayName} in ${channelLabel}: ${preview}`
    )
    banner.innerHTML = `
      <div class="social-mobile-notif__card">
        <div class="social-mobile-notif__header">
          <span class="social-mobile-notif__app-icon" aria-hidden="true">D</span>
          <span class="social-mobile-notif__app-name">${escapeHtml(channelLine)}</span>
          <span class="social-mobile-notif__time">now</span>
        </div>
        <div class="social-mobile-notif__body">
          <span class="social-mobile-notif__avatar">${avatar}</span>
          <span class="social-mobile-notif__text">
            <span class="social-mobile-notif__title">${escapeHtml(displayName)}</span>
            <span class="social-mobile-notif__sub">${escapeHtml(preview)}</span>
          </span>
        </div>
      </div>
    `

    banner.addEventListener('click', () => {
      this.dismissBanner(banner)
      this.onOpenChat?.()
    })

    this.showBanner(banner, `msg:${line.id}`)
  }

  /**
   * In-world system toast (same card as community announcements).
   * Use a stable `id` to replace an existing banner (e.g. remote avatar progress).
   */
  pushSystemToast(opts: {
    id: string
    title: string
    sub: string
    appName?: string
    /** 0 = stay until replaced/dismissed (progress toasts). */
    dismissMs?: number
    /** Optional click action (e.g. open community chat for a tour toast). */
    onClick?: () => void
  }): void {
    const existing = this.banners.find((b) => b.id === opts.id)
    if (existing) {
      clearTimeout(existing.dismissTimer)
      const titleEl = existing.el.querySelector('.social-mobile-notif__title')
      const subEl = existing.el.querySelector('.social-mobile-notif__sub')
      if (titleEl) titleEl.textContent = opts.title
      if (subEl) subEl.textContent = opts.sub
      const dismissMs = opts.dismissMs ?? AUTO_DISMISS_MS
      if (dismissMs > 0) {
        existing.dismissTimer = window.setTimeout(() => this.dismissBanner(existing.el), dismissMs)
      } else {
        existing.dismissTimer = 0
      }
      return
    }

    const banner = document.createElement('button')
    banner.type = 'button'
    banner.className = 'social-mobile-notif'
    banner.innerHTML = `
      <div class="social-mobile-notif__card">
        <div class="social-mobile-notif__header">
          <span class="social-mobile-notif__app-icon" aria-hidden="true">D</span>
          <span class="social-mobile-notif__app-name">${escapeHtml(opts.appName ?? 'DECENTRALAND')}</span>
          <span class="social-mobile-notif__time">now</span>
        </div>
        <div class="social-mobile-notif__body">
          <span class="social-mobile-notif__avatar"><span class="social-mobile-notif__avatar-fallback" aria-hidden="true">👤</span></span>
          <span class="social-mobile-notif__text">
            <span class="social-mobile-notif__title">${escapeHtml(opts.title)}</span>
            <span class="social-mobile-notif__sub">${escapeHtml(opts.sub)}</span>
          </span>
        </div>
      </div>
    `
    banner.addEventListener('click', () => {
      this.dismissBanner(banner)
      opts.onClick?.()
    })
    this.showBanner(banner, opts.id, opts.dismissMs ?? AUTO_DISMISS_MS)
  }

  /** Remove a system toast by id (e.g. when remote avatar load finishes). */
  dismissSystemToast(id: string): void {
    const existing = this.banners.find((b) => b.id === id)
    if (existing) this.dismissBanner(existing.el)
  }

  private showBanner(el: HTMLElement, id: string, dismissMs = AUTO_DISMISS_MS): void {
    while (this.banners.length >= MAX_VISIBLE) {
      const oldest = this.banners.shift()
      if (oldest) this.dismissBanner(oldest.el, oldest)
    }

    this.host.hidden = false
    this.host.prepend(el)

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.classList.add('social-mobile-notif--visible')
      })
    })

    let dismissTimer = 0
    if (dismissMs > 0) {
      dismissTimer = window.setTimeout(() => {
        this.dismissBanner(el)
      }, dismissMs)
    }

    this.banners.push({ id, el, dismissTimer })
  }

  private dismissBanner(el: HTMLElement, entry?: PendingBanner): void {
    const idx = this.banners.findIndex((b) => b.el === el)
    const banner = entry ?? (idx >= 0 ? this.banners[idx] : null)
    if (banner) {
      clearTimeout(banner.dismissTimer)
      if (idx >= 0) this.banners.splice(idx, 1)
    }

    el.classList.remove('social-mobile-notif--visible')
    window.setTimeout(() => {
      el.remove()
      if (this.banners.length === 0) this.host.hidden = true
    }, 320)
  }

  private clearAll(): void {
    for (const banner of [...this.banners]) {
      clearTimeout(banner.dismissTimer)
      banner.el.remove()
    }
    this.banners.length = 0
    this.host.hidden = true
  }
}