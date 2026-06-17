import type { SidebarIconId } from './icons'
import { SIDEBAR_ICONS } from './icons'

export type SidebarButtonConfig = {
  id: string
  icon: SidebarIconId
  label: string
  badge?: string
  statusDot?: 'online' | 'speaking'
  onClick?: (ev: MouseEvent) => void
}

export class SidebarButton {
  readonly element: HTMLButtonElement
  private active = false
  private badgeEl: HTMLSpanElement | null = null

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
      const dot = document.createElement('span')
      dot.className = `client-sidebar__status client-sidebar__status--${config.statusDot}`
      this.element.appendChild(dot)
    }

    if (config.badge) this.setBadgeText(config.badge)

    this.element.addEventListener('click', (ev) => config.onClick?.(ev))
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
}
