import {
  chatChannelPrefs,
  type ChatNotificationPing
} from '../../../social/chatChannelPrefs'
import { chatTranslationSettings } from '../../../social/translation'

const ICONS = {
  bell: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3a5 5 0 0 0-5 5v2.2c0 .7-.2 1.4-.6 2L5 15h14l-1.4-2.8c-.4-.6-.6-1.3-.6-2V8a5 5 0 0 0-5-5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 18a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  translate: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h7M7.5 5v1a8 8 0 0 0 8 8h.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M5 19h14M13 9l3.5 10M20.5 19 17 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M7 15H6a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 6 3h9A1.5 1.5 0 0 1 16.5 4.5V6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M8 7l1 12h6l1-12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5 10 17l9-10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

const PING_OPTIONS: Array<{ mode: ChatNotificationPing; label: string }> = [
  { mode: 'all', label: 'All Messages' },
  { mode: 'mentions', label: 'Mentions Only' },
  { mode: 'none', label: 'None' }
]

export type ChatChannelMenuHandlers = {
  getChannelKey: () => string
  onAutoTranslateChange?: (enabled: boolean) => void
  /** Copy visible chat transcript for this channel to the clipboard. */
  onCopyChat?: () => void | Promise<void>
  onDeleteHistory?: () => void
  onClose?: () => void
}

/**
 * Explorer-style channel ⋮ menu:
 * Notification Ping › · Auto-Translate toggle · Delete Chat History
 */
export class ChatChannelMenu {
  private readonly root: HTMLElement
  private readonly backdrop: HTMLElement
  private readonly handlers: ChatChannelMenuHandlers
  private open = false
  private submenuOpen = false

  constructor(handlers: ChatChannelMenuHandlers) {
    this.handlers = handlers

    this.backdrop = document.createElement('div')
    this.backdrop.className = 'chat-channel-menu-backdrop'
    this.backdrop.hidden = true
    this.backdrop.addEventListener('click', () => this.hide())

    this.root = document.createElement('div')
    this.root.className = 'chat-channel-menu'
    this.root.hidden = true
    this.root.setAttribute('role', 'menu')
    this.root.addEventListener('click', (e) => e.stopPropagation())

    document.body.appendChild(this.backdrop)
    document.body.appendChild(this.root)

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('resize', this.onDismiss)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('resize', this.onDismiss)
    this.root.remove()
    this.backdrop.remove()
  }

  isOpen(): boolean {
    return this.open
  }

  toggle(anchor: HTMLElement): void {
    if (this.open) this.hide()
    else this.show(anchor)
  }

  show(anchor: HTMLElement): void {
    this.submenuOpen = false
    this.render()
    this.open = true
    this.root.hidden = false
    this.backdrop.hidden = false
    this.position(anchor)
  }

  hide(): void {
    if (!this.open) return
    this.open = false
    this.submenuOpen = false
    this.root.hidden = true
    this.backdrop.hidden = true
    this.root.innerHTML = ''
    this.handlers.onClose?.()
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.open) {
      e.preventDefault()
      this.hide()
    }
  }

  private onDismiss = (): void => {
    if (this.open) this.hide()
  }

  private render(): void {
    this.root.innerHTML = ''
    const channelKey = this.handlers.getChannelKey()
    const autoOn = chatTranslationSettings.getAutoTranslate(channelKey)
    const ping = chatChannelPrefs.getNotificationPing(channelKey)

    // Notification Ping row
    const pingRow = document.createElement('button')
    pingRow.type = 'button'
    pingRow.className = 'chat-channel-menu__row chat-channel-menu__row--submenu'
    pingRow.setAttribute('role', 'menuitem')
    pingRow.innerHTML = `
      <span class="chat-channel-menu__icon">${ICONS.bell}</span>
      <span class="chat-channel-menu__label">Notification Ping</span>
      <span class="chat-channel-menu__chevron">${ICONS.chevron}</span>
    `
    pingRow.addEventListener('click', (e) => {
      e.stopPropagation()
      this.submenuOpen = !this.submenuOpen
      this.render()
      // Reposition after submenu expands height
      const rect = this.root.getBoundingClientRect()
      if (rect.bottom > window.innerHeight - 8) {
        this.root.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`
      }
    })
    this.root.appendChild(pingRow)

    if (this.submenuOpen) {
      const sub = document.createElement('div')
      sub.className = 'chat-channel-menu__submenu'
      for (const opt of PING_OPTIONS) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'chat-channel-menu__row chat-channel-menu__row--sub'
        btn.setAttribute('role', 'menuitemradio')
        btn.setAttribute('aria-checked', opt.mode === ping ? 'true' : 'false')
        btn.innerHTML = `
          <span class="chat-channel-menu__check">${opt.mode === ping ? ICONS.check : ''}</span>
          <span class="chat-channel-menu__label">${opt.label}</span>
        `
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          chatChannelPrefs.setNotificationPing(channelKey, opt.mode)
          this.render()
        })
        sub.appendChild(btn)
      }
      this.root.appendChild(sub)
    }

    // Auto-Translate toggle
    const autoRow = document.createElement('button')
    autoRow.type = 'button'
    autoRow.className = 'chat-channel-menu__row'
    autoRow.setAttribute('role', 'menuitemcheckbox')
    autoRow.setAttribute('aria-checked', autoOn ? 'true' : 'false')
    autoRow.innerHTML = `
      <span class="chat-channel-menu__icon">${ICONS.translate}</span>
      <span class="chat-channel-menu__label">Auto-Translate</span>
      <span class="chat-channel-menu__switch${autoOn ? ' is-on' : ''}" aria-hidden="true">
        <span class="chat-channel-menu__switch-knob"></span>
      </span>
    `
    autoRow.addEventListener('click', (e) => {
      e.stopPropagation()
      const next = chatTranslationSettings.toggleAutoTranslate(channelKey)
      this.handlers.onAutoTranslateChange?.(next)
      this.render()
    })
    this.root.appendChild(autoRow)

    // Copy chat transcript
    if (this.handlers.onCopyChat) {
      const copyRow = document.createElement('button')
      copyRow.type = 'button'
      copyRow.className = 'chat-channel-menu__row'
      copyRow.setAttribute('role', 'menuitem')
      copyRow.innerHTML = `
        <span class="chat-channel-menu__icon">${ICONS.copy}</span>
        <span class="chat-channel-menu__label">Copy Chat</span>
      `
      copyRow.addEventListener('click', (e) => {
        e.stopPropagation()
        this.hide()
        void this.handlers.onCopyChat?.()
      })
      this.root.appendChild(copyRow)
    }

    // Delete Chat History
    const delRow = document.createElement('button')
    delRow.type = 'button'
    delRow.className = 'chat-channel-menu__row chat-channel-menu__row--danger'
    delRow.setAttribute('role', 'menuitem')
    delRow.innerHTML = `
      <span class="chat-channel-menu__icon">${ICONS.trash}</span>
      <span class="chat-channel-menu__label">Delete Chat History</span>
    `
    delRow.addEventListener('click', (e) => {
      e.stopPropagation()
      this.hide()
      this.handlers.onDeleteHistory?.()
    })
    this.root.appendChild(delRow)
  }

  private position(anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect()
    const menuW = 240
    let left = r.right - menuW
    let top = r.bottom + 6
    if (left < 8) left = 8
    if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8
    this.root.style.left = `${left}px`
    this.root.style.top = `${top}px`
    // Flip up if overflowing bottom
    requestAnimationFrame(() => {
      const h = this.root.offsetHeight
      if (top + h > window.innerHeight - 8) {
        this.root.style.top = `${Math.max(8, r.top - h - 6)}px`
      }
    })
  }
}
