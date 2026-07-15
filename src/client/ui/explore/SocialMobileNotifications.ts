import type { LoginResult } from '../../../auth/AuthClient'
import { notificationPrefs } from '../../../social/notificationPrefs'
import { resolveNotificationPeer } from '../../../social/resolveNotificationPeer'
import type { SocialChatEvent, SocialService } from '../../../social/SocialService'
import { isChatImageLine, isChatTextLine } from '../../../social/types'

export type SocialMobileNotificationsOptions = {
  login: LoginResult
  getSocial: () => SocialService | null
  onEnsureSocial?: () => Promise<void>
  onOpenChat?: () => void
  onOpenUserProfile?: (address: string) => void
  /**
   * Skip chat banners while the user is actively reading that channel's thread.
   * `channelKey` is the SocialService key for the incoming message (`scene:…`).
   */
  isChatNotificationSuppressed?: (channelKey: string) => boolean
}

const DESKTOP_MQ = '(min-width: 768px)'
const AUTO_DISMISS_MS = 5000
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
  private readonly onEnsureSocial?: SocialMobileNotificationsOptions['onEnsureSocial']
  private readonly onOpenChat?: SocialMobileNotificationsOptions['onOpenChat']
  private readonly onOpenUserProfile?: SocialMobileNotificationsOptions['onOpenUserProfile']
  private readonly isChatNotificationSuppressed?: SocialMobileNotificationsOptions['isChatNotificationSuppressed']

  private readonly desktopMq = window.matchMedia(DESKTOP_MQ)
  private readonly onDesktopMqChange = (): void => {
    this.host.classList.toggle('social-mobile-notif-host--desktop', this.isDesktop())
  }

  private unsubChannel: (() => void) | null = null
  private unsubFriendship: (() => void) | null = null
  private unsubChat: (() => void) | null = null
  private unsubPrefs: (() => void) | null = null

  private baselineReady = false
  private knownIncoming = new Set<string>()
  private readonly banners: PendingBanner[] = []

  constructor(opts: SocialMobileNotificationsOptions) {
    this.login = opts.login
    this.getSocial = opts.getSocial
    this.onEnsureSocial = opts.onEnsureSocial
    this.onOpenChat = opts.onOpenChat
    this.onOpenUserProfile = opts.onOpenUserProfile
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
      if (!state.enabled) this.clearAll()
    })
    void this.seedBaseline()
  }

  setLogin(login: LoginResult): void {
    this.login = login
    this.baselineReady = false
    this.knownIncoming.clear()
    this.clearAll()
    void this.seedBaseline()
  }

  dispose(): void {
    this.desktopMq.removeEventListener('change', this.onDesktopMqChange)
    this.unsubPrefs?.()
    this.unsubPrefs = null
    this.unbindSocialListeners()
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
      return
    }
    await this.onEnsureSocial?.()
    this.bindSocialListeners()
    const social = this.getSocial()
    if (!social) return
    // Friend requests only for real wallets; guests still get chat banners.
    if (this.login.kind === 'wallet') {
      await social.refreshFriendshipSnapshot()
      this.knownIncoming = new Set(social.getIncomingFriendAddresses())
    } else {
      this.knownIncoming = new Set()
    }
    this.baselineReady = true
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

  private showBanner(el: HTMLElement, id: string): void {
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

    const dismissTimer = window.setTimeout(() => {
      this.dismissBanner(el)
    }, AUTO_DISMISS_MS)

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