import type { SessionIdentity } from '../../../network/SessionIdentity'
import type { SocialService } from '../../../social/SocialService'
import { shortenAddress } from '../../../avatar/displayName'

export type FriendsPanelTab = 'friends' | 'requests' | 'blocked'

export type FriendsPanelOptions = {
  getSession: () => SessionIdentity
  getSocial: () => SocialService | null
  /** Open private message thread with peer. */
  onChat?: (address: string, displayName: string) => void
  /** /goto or jump-to-friend when online in world. */
  onJumpIn?: (address: string) => void
  onViewProfile?: (address: string) => void
  onClose?: () => void
  /** Position near the friend-requests sidebar button when possible. */
  anchor?: () => HTMLElement | undefined
}

type FriendRow = {
  address: string
  displayName: string
  faceUrl: string | null
  online: boolean
}

const CHAT_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><path d="M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 18 15.5H10l-3.5 3v-3H5A1.5 1.5 0 0 1 3.5 12V8A1.5 1.5 0 0 1 5 6.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`

const JUMP_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><path d="M5 12h11M12 6l6 6-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const MORE_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>`

const BLOCKED_EMPTY_SVG = `<svg viewBox="0 0 64 64" width="72" height="72" fill="none" aria-hidden="true">
  <rect x="14" y="18" width="36" height="28" rx="8" stroke="currentColor" stroke-width="2.2"/>
  <circle cx="32" cy="30" r="7" stroke="currentColor" stroke-width="2"/>
  <path d="M22 44c1.8-4 5.4-6.5 10-6.5s8.2 2.5 10 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <circle cx="46" cy="20" r="9" fill="rgba(18,16,28,0.98)" stroke="currentColor" stroke-width="2"/>
  <path d="M42 20h8M46 16v8" stroke="currentColor" stroke-width="2" stroke-linecap="round" transform="rotate(45 46 20)"/>
</svg>`

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatRequestDate(d = new Date()): string {
  return d
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .toUpperCase()
}

/**
 * Sidebar Friends panel — Friends / Requests / Blocked tabs (Explorer-style).
 */
export class FriendsPanel {
  readonly element: HTMLDivElement
  private visible = false
  private tab: FriendsPanelTab = 'friends'
  private onlineOpen = true
  private offlineOpen = true
  private busy = false
  private unsubFriendship: (() => void) | null = null
  private unsubProfiles: (() => void) | null = null
  private menuEl: HTMLDivElement | null = null
  private readonly bodyEl: HTMLElement
  private readonly tabsEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly onKeyDown: (ev: KeyboardEvent) => void
  private readonly onDocClick: (ev: MouseEvent) => void

  constructor(private readonly options: FriendsPanelOptions) {
    this.element = document.createElement('div')
    this.element.className = 'friends-panel'
    this.element.hidden = true
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-label', 'Friends')
    this.element.innerHTML = `
      <header class="friends-panel__header">
        <nav class="friends-panel__tabs" data-tabs>
          <button type="button" class="friends-panel__tab is-active" data-tab="friends">Friends</button>
          <button type="button" class="friends-panel__tab" data-tab="requests">
            Requests <span class="friends-panel__tab-badge" data-req-badge hidden>0</span>
          </button>
          <button type="button" class="friends-panel__tab" data-tab="blocked">Blocked</button>
        </nav>
        <button type="button" class="friends-panel__close" data-close aria-label="Close">×</button>
      </header>
      <p class="friends-panel__status" data-status hidden></p>
      <div class="friends-panel__body" data-body></div>
    `
    this.tabsEl = this.element.querySelector('[data-tabs]')!
    this.bodyEl = this.element.querySelector('[data-body]')!
    this.statusEl = this.element.querySelector('[data-status]')!

    this.element.querySelector('[data-close]')!.addEventListener('click', () => this.hide())
    this.tabsEl.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]')
      if (!btn) return
      const tab = btn.dataset.tab as FriendsPanelTab
      if (tab) this.setTab(tab)
    })

    this.bodyEl.addEventListener('click', (ev) => this.onBodyClick(ev))

    this.onKeyDown = (ev) => {
      if (ev.key === 'Escape' && this.visible) this.hide()
    }
    this.onDocClick = (ev) => {
      if (!this.visible) return
      const t = ev.target as Node
      if (this.element.contains(t)) return
      if (this.menuEl?.contains(t)) return
      const anchor = this.options.anchor?.()
      if (anchor?.contains(t)) return
      this.hide()
    }

    document.body.appendChild(this.element)
  }

  dispose(): void {
    this.hide()
    this.unsubFriendship?.()
    this.unsubFriendship = null
    this.closeRowMenu()
    this.element.remove()
    window.removeEventListener('keydown', this.onKeyDown)
    document.removeEventListener('click', this.onDocClick, true)
  }

  isVisible(): boolean {
    return this.visible
  }

  toggle(): void {
    if (this.visible) this.hide()
    else void this.show()
  }

  async show(tab: FriendsPanelTab = this.tab): Promise<void> {
    this.tab = tab
    this.visible = true
    this.element.hidden = false
    this.positionPanel()
    window.addEventListener('keydown', this.onKeyDown)
    // Delay so the opening click doesn't immediately close.
    setTimeout(() => document.addEventListener('click', this.onDocClick, true), 0)

    const social = this.options.getSocial()
    this.unsubFriendship?.()
    this.unsubProfiles?.()
    this.unsubFriendship = social?.onFriendshipChange(() => this.render()) ?? null
    this.unsubProfiles = social?.onPeerProfileChange(() => this.render()) ?? null

    this.render()
    this.setStatus('Loading…')
    try {
      await social?.ensureFriendshipSnapshot()
      this.setStatus('')
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err))
    }
    this.render()
    this.syncRequestBadge()
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.element.hidden = true
    this.closeRowMenu()
    this.unsubFriendship?.()
    this.unsubFriendship = null
    this.unsubProfiles?.()
    this.unsubProfiles = null
    window.removeEventListener('keydown', this.onKeyDown)
    document.removeEventListener('click', this.onDocClick, true)
    this.options.onClose?.()
  }

  private setTab(tab: FriendsPanelTab): void {
    this.tab = tab
    this.closeRowMenu()
    for (const btn of this.tabsEl.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      btn.classList.toggle('is-active', btn.dataset.tab === tab)
    }
    this.render()
  }

  private setStatus(msg: string): void {
    this.statusEl.hidden = !msg
    this.statusEl.textContent = msg
  }

  /** Chat-panel shell slot — CSS owns left/bottom/width/height (no JS anchor offset). */
  private positionPanel(): void {
    this.element.style.left = ''
    this.element.style.top = ''
    this.element.style.right = ''
    this.element.style.bottom = ''
  }

  private syncRequestBadge(): void {
    const social = this.options.getSocial()
    const n = social?.getIncomingFriendAddresses().length ?? 0
    const badge = this.tabsEl.querySelector<HTMLElement>('[data-req-badge]')
    if (!badge) return
    if (n > 0) {
      badge.hidden = false
      badge.textContent = String(n)
    } else {
      badge.hidden = true
    }
  }

  private buildFriendRows(): { online: FriendRow[]; offline: FriendRow[] } {
    const social = this.options.getSocial()
    if (!social) return { online: [], offline: [] }
    const onlineSet = social.getOnlineFriendAddresses()
    const online: FriendRow[] = []
    const offline: FriendRow[] = []
    for (const address of social.getFriendAddresses()) {
      const peer = social.getPeerDisplay(address)
      const row: FriendRow = {
        address,
        displayName: peer.displayName,
        faceUrl: peer.faceUrl,
        online: onlineSet.has(address)
      }
      if (row.online) online.push(row)
      else offline.push(row)
    }
    online.sort((a, b) => a.displayName.localeCompare(b.displayName))
    offline.sort((a, b) => a.displayName.localeCompare(b.displayName))
    return { online, offline }
  }

  private render(): void {
    this.syncRequestBadge()
    for (const btn of this.tabsEl.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      btn.classList.toggle('is-active', btn.dataset.tab === this.tab)
    }

    if (this.tab === 'friends') this.renderFriends()
    else if (this.tab === 'requests') this.renderRequests()
    else this.renderBlocked()
  }

  private avatarHtml(faceUrl: string | null, name: string): string {
    if (faceUrl) {
      return `<img class="friends-panel__avatar" src="${escapeHtml(faceUrl)}" alt="" />`
    }
    const letter = (name.trim()[0] || '?').toUpperCase()
    return `<span class="friends-panel__avatar friends-panel__avatar--fallback">${escapeHtml(letter)}</span>`
  }

  private renderFriends(): void {
    const { online, offline } = this.buildFriendRows()
    const total = online.length + offline.length
    if (total === 0) {
      this.bodyEl.innerHTML = `
        <div class="friends-panel__empty">
          <p class="friends-panel__empty-title">No friends yet</p>
          <p class="friends-panel__empty-copy">Add friends from their profile menu in-world or chat.</p>
        </div>`
      return
    }

    this.bodyEl.innerHTML = `
      <section class="friends-panel__section">
        <button type="button" class="friends-panel__section-head" data-toggle-online aria-expanded="${this.onlineOpen}">
          <span class="friends-panel__chevron" aria-hidden="true">${this.onlineOpen ? '▾' : '▸'}</span>
          <span>ONLINE (${online.length})</span>
        </button>
        <div class="friends-panel__section-body" ${this.onlineOpen ? '' : 'hidden'}>
          ${online.map((r) => this.friendRowHtml(r)).join('') || `<p class="friends-panel__muted">No friends online</p>`}
        </div>
      </section>
      <section class="friends-panel__section">
        <button type="button" class="friends-panel__section-head" data-toggle-offline aria-expanded="${this.offlineOpen}">
          <span class="friends-panel__chevron" aria-hidden="true">${this.offlineOpen ? '▾' : '▸'}</span>
          <span>OFFLINE (${offline.length})</span>
        </button>
        <div class="friends-panel__section-body" ${this.offlineOpen ? '' : 'hidden'}>
          ${offline.map((r) => this.friendRowHtml(r)).join('') || `<p class="friends-panel__muted">No offline friends</p>`}
        </div>
      </section>
    `
  }

  private friendRowHtml(row: FriendRow): string {
    const jump = row.online
      ? `<button type="button" class="friends-panel__icon-btn" data-jump="${escapeHtml(row.address)}" title="Jump in" aria-label="Jump in">${JUMP_SVG}</button>`
      : ''
    return `
      <div class="friends-panel__row" data-friend-row data-address="${escapeHtml(row.address)}" data-online="${row.online ? '1' : '0'}">
        <div class="friends-panel__row-main">
          ${this.avatarHtml(row.faceUrl, row.displayName)}
          <div class="friends-panel__row-text">
            <div class="friends-panel__name">
              ${escapeHtml(row.displayName)}
              ${row.online ? '<span class="friends-panel__online-dot" title="Online"></span>' : ''}
            </div>
            <div class="friends-panel__sub">${row.online ? 'Online' : 'Offline'}</div>
          </div>
        </div>
        <div class="friends-panel__row-actions">
          <button type="button" class="friends-panel__icon-btn" data-chat="${escapeHtml(row.address)}" title="Chat" aria-label="Chat">${CHAT_SVG}</button>
          ${jump}
          <button type="button" class="friends-panel__icon-btn friends-panel__more" data-more="${escapeHtml(row.address)}" title="More" aria-label="More">${MORE_SVG}</button>
        </div>
      </div>
    `
  }

  private renderRequests(): void {
    const social = this.options.getSocial()
    const incoming = social?.getIncomingFriendAddresses() ?? []
    const outgoing = social?.getOutgoingFriendAddresses() ?? []
    const dateLabel = formatRequestDate()

    const recvRows = incoming
      .map((address) => {
        const peer = social!.getPeerDisplay(address)
        return `
          <div class="friends-panel__row friends-panel__row--request" data-req-row data-address="${escapeHtml(address)}">
            <div class="friends-panel__row-main">
              ${this.avatarHtml(peer.faceUrl, peer.displayName)}
              <div class="friends-panel__row-text">
                <div class="friends-panel__name">${escapeHtml(peer.displayName)}</div>
              </div>
            </div>
            <div class="friends-panel__row-meta">
              <span class="friends-panel__date">${dateLabel}</span>
              <div class="friends-panel__req-actions">
                <button type="button" class="friends-panel__btn friends-panel__btn--ghost" data-reject="${escapeHtml(address)}">Delete</button>
                <button type="button" class="friends-panel__btn friends-panel__btn--accept" data-accept="${escapeHtml(address)}">Accept</button>
                <button type="button" class="friends-panel__icon-btn friends-panel__more" data-more-req="${escapeHtml(address)}" title="More" aria-label="More">${MORE_SVG}</button>
              </div>
            </div>
          </div>
        `
      })
      .join('')

    this.bodyEl.innerHTML = `
      <section class="friends-panel__section">
        <div class="friends-panel__section-label">RECEIVED (${incoming.length})</div>
        <div class="friends-panel__section-body is-open">
          ${recvRows || `<p class="friends-panel__muted">No requests</p>`}
        </div>
      </section>
      <section class="friends-panel__section">
        <div class="friends-panel__section-label">SENT (${outgoing.length})</div>
        <div class="friends-panel__section-body is-open">
          ${
            outgoing.length
              ? outgoing
                  .map((address) => {
                    const peer = social!.getPeerDisplay(address)
                    return `
                      <div class="friends-panel__row" data-address="${escapeHtml(address)}">
                        <div class="friends-panel__row-main">
                          ${this.avatarHtml(peer.faceUrl, peer.displayName)}
                          <div class="friends-panel__row-text">
                            <div class="friends-panel__name">${escapeHtml(peer.displayName)}</div>
                            <div class="friends-panel__sub">Pending</div>
                          </div>
                        </div>
                        <div class="friends-panel__row-actions">
                          <button type="button" class="friends-panel__btn friends-panel__btn--ghost" data-cancel="${escapeHtml(address)}">Cancel</button>
                        </div>
                      </div>
                    `
                  })
                  .join('')
              : `<p class="friends-panel__muted">No requests</p>`
          }
        </div>
      </section>
    `
  }

  private renderBlocked(): void {
    // Block list API not wired yet — match Explorer empty state.
    this.bodyEl.innerHTML = `
      <div class="friends-panel__empty friends-panel__empty--blocked">
        <div class="friends-panel__empty-icon">${BLOCKED_EMPTY_SVG}</div>
        <p class="friends-panel__empty-title">No Blocked Accounts</p>
        <p class="friends-panel__empty-copy">
          If you block someone, you will not be able to see each other in-world or exchange
          messages. You will also not see each other's names or messages in public chats.
        </p>
        <p class="friends-panel__empty-copy friends-panel__empty-copy--dim">
          The option to block an account is available in the ⋮ menu on their Profile or when you
          click on their name in the Chat.
        </p>
      </div>
    `
  }

  private onBodyClick(ev: MouseEvent): void {
    const t = (ev.target as HTMLElement).closest<HTMLElement>(
      '[data-toggle-online],[data-toggle-offline],[data-chat],[data-jump],[data-more],[data-accept],[data-reject],[data-cancel],[data-more-req]'
    )
    if (!t) return

    if (t.hasAttribute('data-toggle-online')) {
      this.onlineOpen = !this.onlineOpen
      this.render()
      return
    }
    if (t.hasAttribute('data-toggle-offline')) {
      this.offlineOpen = !this.offlineOpen
      this.render()
      return
    }

    const chat = t.getAttribute('data-chat')
    if (chat) {
      const social = this.options.getSocial()
      const name = social?.getPeerDisplay(chat).displayName ?? shortenAddress(chat)
      this.options.onChat?.(chat, name)
      return
    }
    const jump = t.getAttribute('data-jump')
    if (jump) {
      this.options.onJumpIn?.(jump)
      return
    }
    const more = t.getAttribute('data-more')
    if (more) {
      this.openFriendMenu(more, t)
      return
    }
    const moreReq = t.getAttribute('data-more-req')
    if (moreReq) {
      this.openRequestMenu(moreReq, t)
      return
    }
    const accept = t.getAttribute('data-accept')
    if (accept) {
      void this.runAction(() => this.options.getSocial()?.acceptFriendRequest(accept))
      return
    }
    const reject = t.getAttribute('data-reject')
    if (reject) {
      void this.runAction(() => this.options.getSocial()?.rejectFriendRequest(reject))
      return
    }
    const cancel = t.getAttribute('data-cancel')
    if (cancel) {
      void this.runAction(() => this.options.getSocial()?.removeFriend(cancel))
    }
  }

  private async runAction(fn: () => Promise<void> | void | undefined): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.setStatus('')
    try {
      await fn()
      this.render()
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      this.busy = false
    }
  }

  private closeRowMenu(): void {
    this.menuEl?.remove()
    this.menuEl = null
  }

  private openFriendMenu(address: string, anchor: HTMLElement): void {
    this.closeRowMenu()
    const social = this.options.getSocial()
    const peer = social?.getPeerDisplay(address)
    const name = peer?.displayName ?? shortenAddress(address)
    const menu = document.createElement('div')
    menu.className = 'friends-panel__context'
    menu.innerHTML = `
      <button type="button" data-act="profile">View Profile</button>
      <button type="button" data-act="chat">Chat</button>
      <button type="button" data-act="jump" ${anchor.closest('[data-online="1"]') ? '' : 'hidden'}>Jump to Location</button>
      <button type="button" data-act="remove" class="is-danger">Remove Friend</button>
      <button type="button" data-act="block" class="is-danger">Block</button>
    `
    menu.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')
      if (!btn) return
      const act = btn.dataset.act
      this.closeRowMenu()
      if (act === 'profile') this.options.onViewProfile?.(address)
      else if (act === 'chat') this.options.onChat?.(address, name)
      else if (act === 'jump') this.options.onJumpIn?.(address)
      else if (act === 'remove') void this.runAction(() => social?.removeFriend(address))
      else if (act === 'block') console.info('[friends] block — profile menu (API TBD)', address)
    })
    document.body.appendChild(menu)
    this.menuEl = menu
    const r = anchor.getBoundingClientRect()
    menu.style.left = `${Math.min(r.right - 200, window.innerWidth - 210)}px`
    menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 200)}px`
  }

  private openRequestMenu(address: string, anchor: HTMLElement): void {
    this.closeRowMenu()
    const social = this.options.getSocial()
    const menu = document.createElement('div')
    menu.className = 'friends-panel__context'
    menu.innerHTML = `
      <button type="button" data-act="profile">View Profile</button>
      <button type="button" data-act="accept">Accept</button>
      <button type="button" data-act="reject" class="is-danger">Delete</button>
    `
    menu.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')
      if (!btn) return
      const act = btn.dataset.act
      this.closeRowMenu()
      if (act === 'profile') this.options.onViewProfile?.(address)
      else if (act === 'accept') void this.runAction(() => social?.acceptFriendRequest(address))
      else if (act === 'reject') void this.runAction(() => social?.rejectFriendRequest(address))
    })
    document.body.appendChild(menu)
    this.menuEl = menu
    const r = anchor.getBoundingClientRect()
    menu.style.left = `${Math.min(r.right - 180, window.innerWidth - 190)}px`
    menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 160)}px`
  }
}
