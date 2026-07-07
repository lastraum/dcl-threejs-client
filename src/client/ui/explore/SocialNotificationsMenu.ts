import type { LoginResult } from '../../../auth/AuthClient'
import { identityFromAvatarProfile } from '../../../avatar/displayName'
import { fetchProfileCached, fetchProfileFaceUrl } from '../../../avatar/peerApi'
import type { SocialService } from '../../../social/SocialService'
import { SIDEBAR_ICONS } from '../shell/icons'

export type SocialNotificationsMenuOptions = {
  login: LoginResult
  getSocial: () => SocialService | null
  onEnsureSocial?: () => Promise<void>
  onOpenChat?: () => void
  onOpenUserProfile?: (address: string) => void
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Bell + dropdown — friend requests and unread chat (2D social shell, top-right). */
export class SocialNotificationsMenu {
  readonly wrap: HTMLElement

  private readonly bellBtn: HTMLButtonElement
  private readonly badgeEl: HTMLElement
  private readonly menuEl: HTMLElement
  private readonly menuBody: HTMLElement
  private login: LoginResult
  private open = false
  private unsubChannel: (() => void) | null = null
  private unsubFriendship: (() => void) | null = null
  private readonly getSocial: SocialNotificationsMenuOptions['getSocial']
  private readonly onEnsureSocial?: SocialNotificationsMenuOptions['onEnsureSocial']
  private readonly onOpenChat?: SocialNotificationsMenuOptions['onOpenChat']
  private readonly onOpenUserProfile?: SocialNotificationsMenuOptions['onOpenUserProfile']
  private readonly onDocMouseDown: (ev: MouseEvent) => void
  private readonly onKeyDown: (ev: KeyboardEvent) => void
  private readonly onViewportChange = (): void => {
    if (this.open) this.syncDropdownPosition()
  }

  constructor(opts: SocialNotificationsMenuOptions) {
    this.login = opts.login
    this.getSocial = opts.getSocial
    this.onEnsureSocial = opts.onEnsureSocial
    this.onOpenChat = opts.onOpenChat
    this.onOpenUserProfile = opts.onOpenUserProfile

    this.wrap = document.createElement('div')
    this.wrap.className = 'social-notifications-menu'

    this.bellBtn = document.createElement('button')
    this.bellBtn.type = 'button'
    this.bellBtn.className = 'social-notifications-menu__bell'
    this.bellBtn.setAttribute('aria-haspopup', 'menu')
    this.bellBtn.setAttribute('aria-expanded', 'false')
    this.bellBtn.setAttribute('aria-label', 'Notifications')
    this.bellBtn.innerHTML = `<span class="social-notifications-menu__bell-icon" aria-hidden="true">${SIDEBAR_ICONS.notifications}</span>`

    this.badgeEl = document.createElement('span')
    this.badgeEl.className = 'social-notifications-menu__badge'
    this.badgeEl.hidden = true
    this.bellBtn.appendChild(this.badgeEl)

    this.menuEl = document.createElement('div')
    this.menuEl.className = 'social-notifications-menu__dropdown'
    this.menuEl.hidden = true
    this.menuEl.setAttribute('role', 'region')
    this.menuEl.setAttribute('aria-label', 'Notifications')

    this.menuBody = document.createElement('div')
    this.menuBody.className = 'social-notifications-menu__body'
    this.menuEl.appendChild(this.menuBody)

    this.wrap.appendChild(this.bellBtn)
    this.wrap.appendChild(this.menuEl)

    this.bellBtn.addEventListener('click', () => void this.toggle())

    this.onDocMouseDown = (ev: MouseEvent) => {
      if (!this.open) return
      const target = ev.target as Node
      if (!this.wrap.contains(target) && !this.menuEl.contains(target)) this.close()
    }
    this.onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') this.close()
    }
  }

  mount(): void {
    document.addEventListener('mousedown', this.onDocMouseDown)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('resize', this.onViewportChange)
    window.addEventListener('scroll', this.onViewportChange, true)
    this.bindSocialListeners()
    this.updateBadge()
  }

  setLogin(login: LoginResult): void {
    this.login = login
    this.bindSocialListeners()
    this.updateBadge()
    if (this.open) void this.renderMenu()
  }

  dispose(): void {
    document.removeEventListener('mousedown', this.onDocMouseDown)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('resize', this.onViewportChange)
    window.removeEventListener('scroll', this.onViewportChange, true)
    this.unbindSocialListeners()
    this.restoreDropdownParent()
    this.wrap.remove()
  }

  private isWallet(): boolean {
    return this.login.kind === 'wallet'
  }

  private bindSocialListeners(): void {
    this.unbindSocialListeners()
    const social = this.getSocial()
    if (!social || !this.isWallet()) return
    this.unsubChannel = social.onChannelChange(() => {
      this.updateBadge()
      if (this.open) void this.renderMenu()
    })
    this.unsubFriendship = social.onFriendshipChange(() => {
      this.updateBadge()
      if (this.open) void this.renderMenu()
    })
  }

  private unbindSocialListeners(): void {
    this.unsubChannel?.()
    this.unsubFriendship?.()
    this.unsubChannel = null
    this.unsubFriendship = null
  }

  private notificationCount(): number {
    const social = this.getSocial()
    if (!social || !this.isWallet()) return 0
    return social.getIncomingFriendAddresses().length + social.getTotalUnreadCount()
  }

  private updateBadge(): void {
    const count = this.notificationCount()
    if (count > 0) {
      this.badgeEl.hidden = false
      this.badgeEl.textContent = count > 99 ? '99+' : String(count)
      this.bellBtn.setAttribute('aria-label', `${count} notification${count === 1 ? '' : 's'}`)
    } else {
      this.badgeEl.hidden = true
      this.badgeEl.textContent = ''
      this.bellBtn.setAttribute('aria-label', 'Notifications')
    }
  }

  private async toggle(): Promise<void> {
    if (this.open) this.close()
    else await this.openMenu()
  }

  private async openMenu(): Promise<void> {
    if (this.isWallet()) await this.onEnsureSocial?.()
    this.open = true
    this.menuEl.hidden = false
    this.menuEl.classList.add('social-notifications-menu__dropdown--portaled')
    if (this.menuEl.parentElement !== document.body) {
      document.body.appendChild(this.menuEl)
    }
    this.syncDropdownPosition()
    this.bellBtn.classList.add('social-notifications-menu__bell--open')
    this.bellBtn.setAttribute('aria-expanded', 'true')
    if (this.isWallet()) {
      const social = this.getSocial()
      if (social) await social.refreshFriendshipSnapshot()
    }
    await this.renderMenu()
  }

  private close(): void {
    this.open = false
    this.menuEl.hidden = true
    this.menuEl.classList.remove('social-notifications-menu__dropdown--portaled')
    this.restoreDropdownParent()
    this.bellBtn.classList.remove('social-notifications-menu__bell--open')
    this.bellBtn.setAttribute('aria-expanded', 'false')
  }

  private restoreDropdownParent(): void {
    this.menuEl.style.top = ''
    this.menuEl.style.right = ''
    if (this.menuEl.parentElement !== this.wrap) {
      this.wrap.appendChild(this.menuEl)
    }
  }

  private syncDropdownPosition(): void {
    const rect = this.bellBtn.getBoundingClientRect()
    this.menuEl.style.top = `${Math.round(rect.bottom + 10)}px`
    this.menuEl.style.right = `${Math.round(window.innerWidth - rect.right)}px`
  }

  private async renderMenu(): Promise<void> {
    if (!this.isWallet()) {
      this.menuBody.innerHTML = `
        <div class="social-notifications-menu__section">
          <p class="social-notifications-menu__hint">Sign in to see friend requests and chat alerts.</p>
        </div>
      `
      return
    }

    const social = this.getSocial()
    if (!social) {
      this.menuBody.innerHTML =
        '<p class="social-notifications-menu__empty">Notifications unavailable right now.</p>'
      return
    }

    const incoming = social.getIncomingFriendAddresses()
    const unread = social.getTotalUnreadCount()
    const sections: string[] = []

    if (unread > 0) {
      sections.push(`
        <div class="social-notifications-menu__section">
          <h3 class="social-notifications-menu__heading">Chat</h3>
          <button type="button" class="social-notifications-menu__row" data-open-chat>
            <span class="social-notifications-menu__row-icon" aria-hidden="true">${SIDEBAR_ICONS.chat}</span>
            <span class="social-notifications-menu__row-text">
              <span class="social-notifications-menu__row-title">${unread} unread message${unread === 1 ? '' : 's'}</span>
              <span class="social-notifications-menu__row-sub">Open chat</span>
            </span>
          </button>
        </div>
      `)
    }

    if (incoming.length > 0) {
      const rows = await Promise.all(incoming.map((address) => this.renderFriendRow(address)))
      sections.push(`
        <div class="social-notifications-menu__section">
          <h3 class="social-notifications-menu__heading">Friend requests</h3>
          <ul class="social-notifications-menu__list">${rows.join('')}</ul>
        </div>
      `)
    }

    if (sections.length === 0) {
      this.menuBody.innerHTML =
        '<p class="social-notifications-menu__empty">You\'re all caught up — no new notifications.</p>'
    } else {
      this.menuBody.innerHTML = sections.join('')
    }

    this.wireMenu()
    this.updateBadge()
  }

  private async renderFriendRow(address: string): Promise<string> {
    const [profile, faceUrl] = await Promise.all([
      fetchProfileCached(address),
      fetchProfileFaceUrl(address)
    ])
    const displayName = profile
      ? identityFromAvatarProfile(profile, address).displayName
      : `${address.slice(0, 6)}…${address.slice(-4)}`
    const initial = displayName.trim().charAt(0).toUpperCase() || '?'
    const avatar = faceUrl
      ? `<img class="social-notifications-menu__avatar-img" src="${escapeHtml(faceUrl)}" alt="" width="36" height="36" loading="lazy" />`
      : `<span class="social-notifications-menu__avatar-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`

    return `
      <li>
        <div class="social-notifications-menu__row social-notifications-menu__row--friend">
          <span class="social-notifications-menu__avatar">${avatar}</span>
          <span class="social-notifications-menu__row-text">
            <span class="social-notifications-menu__row-title">${escapeHtml(displayName)}</span>
            <span class="social-notifications-menu__row-sub">Wants to be friends</span>
          </span>
          <button type="button" class="social-notifications-menu__action" data-view-profile="${escapeHtml(address)}">View</button>
        </div>
      </li>
    `
  }

  private wireMenu(): void {
    this.menuBody.querySelector('[data-open-chat]')?.addEventListener('click', () => {
      this.close()
      this.onOpenChat?.()
    })

    for (const btn of this.menuBody.querySelectorAll<HTMLButtonElement>('[data-view-profile]')) {
      btn.addEventListener('click', () => {
        const address = btn.dataset.viewProfile?.trim()
        if (!address) return
        this.close()
        this.onOpenUserProfile?.(address)
      })
    }
  }
}