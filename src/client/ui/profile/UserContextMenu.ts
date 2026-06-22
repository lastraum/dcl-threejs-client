import { shortenAddress } from '../../../avatar/displayName'
import type { PeerChatProfile } from '../../../social/ChatPeerProfiles'

export type UserContextMenuAction =
  | 'add-friend'
  | 'view-profile'
  | 'chat'
  | 'call'
  | 'hush'
  | 'gift'
  | 'report'
  | 'block'

export type UserContextMenuHandlers = {
  onAction: (action: UserContextMenuAction, address: string) => void
}

type MenuRow =
  | { kind: 'action'; action: UserContextMenuAction; label: string; icon: string; danger?: boolean }
  | { kind: 'divider' }

const MENU_ROWS: MenuRow[] = [
  { kind: 'action', action: 'add-friend', label: 'Add Friend', icon: 'add-friend' },
  { kind: 'action', action: 'view-profile', label: 'View Profile', icon: 'view-profile' },
  { kind: 'action', action: 'chat', label: 'Chat', icon: 'chat' },
  { kind: 'action', action: 'call', label: 'Call', icon: 'call' },
  { kind: 'action', action: 'hush', label: 'Hush', icon: 'hush' },
  { kind: 'action', action: 'gift', label: 'Gift', icon: 'gift' },
  { kind: 'divider' },
  { kind: 'action', action: 'report', label: 'Report', icon: 'report', danger: true },
  { kind: 'action', action: 'block', label: 'Block', icon: 'block', danger: true }
]

const ICONS: Record<string, string> = {
  'add-friend': `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z" stroke="currentColor" stroke-width="1.6"/><path d="M4 20a8 8 0 0 1 16 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M19 8v6M16 11h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  'view-profile': `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.6"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V7a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  call: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6.5 4.8c.5 2.2 1.6 4.2 3.2 5.8s3.6 2.7 5.8 3.2l2-2.1a1 1 0 0 1 1-.2c1.1.4 2.3.6 3.5.6a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1C10.3 20 4 13.7 4 5a1 1 0 0 1 1-1h3.4a1 1 0 0 1 1 1c0 1.2.2 2.4.6 3.5a1 1 0 0 1-.2 1Z" stroke="currentColor" stroke-width="1.6"/></svg>`,
  hush: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 9v6h4l5 4V5L9 9H5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M16 9l4 4M20 9l-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  gift: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="10" width="18" height="11" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M12 10v11M3 14h18M8.5 10C7 10 6 8.8 6 7.5S7 5 8.5 5 11 6.2 11 7.5 10 10 8.5 10ZM15.5 10C17 10 18 8.8 18 7.5S17 5 15.5 5 13 6.2 13 7.5 14 10 15.5 10Z" stroke="currentColor" stroke-width="1.6"/></svg>`,
  report: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 4v16M5 4l11 4-11 4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  block: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M7 17 17 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.6"/></svg>`
}

/** Explorer-style user context menu — opens at cursor on name pill right-click. */
export class UserContextMenu {
  private readonly root: HTMLElement
  private readonly backdrop: HTMLElement
  private open = false
  private address: string | null = null

  constructor(private readonly handlers: UserContextMenuHandlers) {
    this.backdrop = document.createElement('div')
    this.backdrop.className = 'user-context-menu-backdrop'
    this.backdrop.hidden = true
    this.backdrop.addEventListener('click', () => this.hide())
    this.backdrop.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.hide()
    })

    this.root = document.createElement('div')
    this.root.className = 'user-context-menu'
    this.root.hidden = true
    this.root.setAttribute('role', 'menu')

    document.body.appendChild(this.backdrop)
    document.body.appendChild(this.root)

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('scroll', this.onDismiss, true)
    window.addEventListener('resize', this.onDismiss)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('scroll', this.onDismiss, true)
    window.removeEventListener('resize', this.onDismiss)
    this.root.remove()
    this.backdrop.remove()
  }

  isOpen(): boolean {
    return this.open
  }

  show(address: string, peer: PeerChatProfile, clientX: number, clientY: number): void {
    const key = address.toLowerCase()
    this.address = key
    this.renderHeader(key, peer)
    this.renderActions()

    const panelWidth = 280
    const panelHeight = this.root.offsetHeight || 420
    const left = Math.min(Math.max(8, clientX), window.innerWidth - panelWidth - 8)
    const top = Math.min(Math.max(8, clientY), window.innerHeight - panelHeight - 8)

    this.root.style.left = `${left}px`
    this.root.style.top = `${top}px`

    this.open = true
    this.root.hidden = false
    this.backdrop.hidden = false
  }

  hide(): void {
    this.open = false
    this.address = null
    this.root.hidden = true
    this.backdrop.hidden = true
  }

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') this.hide()
  }

  private onDismiss = (): void => {
    if (this.open) this.hide()
  }

  private renderHeader(address: string, peer: PeerChatProfile): void {
    const face = peer.faceUrl
      ? `<img class="user-context-menu__face" src="${peer.faceUrl}" alt="" decoding="async" />`
      : `<div class="user-context-menu__face user-context-menu__face--fallback">${peer.displayName.charAt(0).toUpperCase()}</div>`

    this.root.innerHTML = `
      <header class="user-context-menu__header">
        <div class="user-context-menu__face-ring">${face}</div>
        <div class="user-context-menu__meta">
          <div class="user-context-menu__name" style="color:${peer.nameColor}">${escapeHtml(peer.displayName)}</div>
          <div class="user-context-menu__wallet-row">
            <code class="user-context-menu__wallet">${shortenAddress(address)}</code>
            <button type="button" class="user-context-menu__copy" data-copy="${address}" aria-label="Copy wallet address">
              ${ICONS.copy}
            </button>
          </div>
        </div>
      </header>
      <button type="button" class="user-context-menu__add-friend" data-action="add-friend">
        <span class="user-context-menu__add-icon" aria-hidden="true">+</span>
        Add Friend
      </button>
      <div class="user-context-menu__list" role="none"></div>
    `

    this.root.querySelector('.user-context-menu__copy')?.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      const btn = ev.currentTarget as HTMLButtonElement
      try {
        await navigator.clipboard.writeText(address)
        btn.classList.add('is-copied')
        setTimeout(() => btn.classList.remove('is-copied'), 1200)
      } catch {
        console.warn('[profile] clipboard copy failed')
      }
    })

    this.root.querySelector('.user-context-menu__add-friend')?.addEventListener('click', () => {
      if (!this.address) return
      this.handlers.onAction('add-friend', this.address)
      this.hide()
    })
  }

  private renderActions(): void {
    const list = this.root.querySelector('.user-context-menu__list')
    if (!list) return
    list.innerHTML = ''

    for (const row of MENU_ROWS) {
      if (row.kind === 'divider') {
        const divider = document.createElement('div')
        divider.className = 'user-context-menu__divider'
        list.appendChild(divider)
        continue
      }
      if (row.action === 'add-friend') continue

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `user-context-menu__item${row.danger ? ' is-danger' : ''}`
      btn.dataset.action = row.action
      btn.setAttribute('role', 'menuitem')
      btn.innerHTML = `
        <span class="user-context-menu__item-icon">${ICONS[row.icon] ?? ''}</span>
        <span class="user-context-menu__item-label">${row.label}</span>
      `
      btn.addEventListener('click', () => {
        if (!this.address) return
        this.handlers.onAction(row.action, this.address)
        this.hide()
      })
      list.appendChild(btn)
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}