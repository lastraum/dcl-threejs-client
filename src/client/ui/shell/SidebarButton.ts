import type { SidebarIconId } from './icons'
import { SIDEBAR_ICONS } from './icons'

export type SidebarStatusDot = 'online' | 'speaking' | 'muted' | 'off'

export type SidebarButtonConfig = {
  id: string
  icon: SidebarIconId
  label: string
  badge?: string
  statusDot?: SidebarStatusDot
  onClick?: (ev: MouseEvent) => void
}

export class SidebarButton {
  readonly element: HTMLButtonElement
  private active = false
  private badgeEl: HTMLSpanElement | null = null
  private statusEl: HTMLSpanElement | null = null

  constructor(config: SidebarButtonConfig) {
    this.element = document.createElement('button')
    this.element.type = 'button'
    this.element.className = 'client-sidebar__btn'
    this.element.dataset.action = config.id
    this.element.title = config.label
    this.element.setAttribute('aria-label', config.label)

    const icon = document.createElement('span')
    icon.className = 'client-sidebar__icon'
    icon.innerHTML = SIDEBAR_ICONS[config.icon]

    this.element.appendChild(icon)

    if (config.statusDot) {
      this.statusEl = document.createElement('span')
      this.statusEl.className = `client-sidebar__status client-sidebar__status--${config.statusDot}`
      this.element.appendChild(this.statusEl)
    }

    if (config.badge) this.setBadgeText(config.badge)

    this.element.addEventListener('click', (ev) => config.onClick?.(ev))
  }

  setStatusDot(kind: SidebarStatusDot | null): void {
    if (!kind) {
      this.statusEl?.remove()
      this.statusEl = null
      return
    }
    if (!this.statusEl) {
      this.statusEl = document.createElement('span')
      this.element.appendChild(this.statusEl)
    }
    this.statusEl.className = `client-sidebar__status client-sidebar__status--${kind}`
  }

  setTitle(label: string): void {
    this.element.title = label
    this.element.setAttribute('aria-label', label)
  }

  setBadge(count: number | null): void {
    const n = count ?? 0
    if (n <= 0) {
      this.badgeEl?.remove()
      this.badgeEl = null
      return
    }
    this.setBadgeText(n > 99 ? '99+' : String(n))
  }

  private setBadgeText(text: string): void {
    if (!this.badgeEl) {
      this.badgeEl = document.createElement('span')
      this.badgeEl.className = 'client-sidebar__badge'
      this.element.appendChild(this.badgeEl)
    }
    this.badgeEl.textContent = text
  }

  setActive(on: boolean): void {
    this.active = on
    this.element.classList.toggle('is-active', on)
  }

  isActive(): boolean {
    return this.active
  }

  setDisabled(disabled: boolean): void {
    this.element.disabled = disabled
    this.element.classList.toggle('is-disabled', disabled)
    if (disabled) this.setActive(false)
  }
}
