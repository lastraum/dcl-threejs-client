import type { SidebarIconId } from './icons'
import { SIDEBAR_ICONS } from './icons'

export type SidebarStatusDot = 'online' | 'speaking' | 'muted' | 'off'

export type SidebarButtonConfig = {
  id: string
  icon: SidebarIconId
  label: string
  /** Compact key badge shown as `Label [K]` (Explorer HUD hover tip). */
  shortcut?: string
  badge?: string
  statusDot?: SidebarStatusDot
  onClick?: (ev: MouseEvent) => void
}

export function formatSidebarTooltip(label: string, shortcut?: string | null): string {
  const key = shortcut?.trim()
  return key ? `${label} [${key}]` : label
}

export class SidebarButton {
  readonly element: HTMLButtonElement
  private active = false
  private badgeEl: HTMLSpanElement | null = null
  private statusEl: HTMLSpanElement | null = null
  private shortcut: string | null = null
  private label: string
  private restricted = false

  constructor(config: SidebarButtonConfig) {
    this.element = document.createElement('button')
    this.element.type = 'button'
    this.element.className = 'client-sidebar__btn'
    this.element.dataset.action = config.id
    this.shortcut = config.shortcut?.trim() || null
    this.label = config.label
    this.setTitle(config.label)

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

    this.element.addEventListener('click', (ev) => {
      if (this.restricted) {
        ev.preventDefault()
        ev.stopPropagation()
        return
      }
      config.onClick?.(ev)
    })
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
    this.label = label
    if (this.restricted) return
    const tip = formatSidebarTooltip(label, this.shortcut)
    this.element.dataset.tooltip = tip
    this.element.classList.remove('has-multiline-tooltip')
    this.element.removeAttribute('title')
    this.element.setAttribute('aria-label', tip)
  }

  /**
   * Scene feature restriction (e.g. portableExperiences disabled).
   * Keeps pointer-events so the restriction tooltip still shows on hover;
   * clicks are swallowed by the click handler.
   */
  setRestricted(restricted: boolean, message?: string): void {
    this.restricted = restricted
    this.element.classList.toggle('is-restricted', restricted)
    if (restricted) {
      const tip = (message ?? 'This scene is restricting the use of some features').trim()
      this.element.disabled = false
      this.element.classList.remove('is-disabled')
      this.element.dataset.tooltip = tip
      this.element.classList.add('has-multiline-tooltip')
      this.element.removeAttribute('title')
      this.element.setAttribute('aria-label', tip)
      this.element.setAttribute('aria-disabled', 'true')
      this.setActive(false)
      this.setTalking(false)
      this.setBadge(null)
    } else {
      this.element.removeAttribute('aria-disabled')
      this.element.classList.remove('has-multiline-tooltip')
      this.setTitle(this.label)
    }
  }

  isRestricted(): boolean {
    return this.restricted
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

  /** Live transmit feedback (e.g. hold T / Speak) — green border. */
  setTalking(on: boolean): void {
    this.element.classList.toggle('is-talking', on)
  }

  setDisabled(disabled: boolean): void {
    this.element.disabled = disabled
    this.element.classList.toggle('is-disabled', disabled)
    if (disabled) {
      this.setActive(false)
      this.setTalking(false)
    }
  }
}
