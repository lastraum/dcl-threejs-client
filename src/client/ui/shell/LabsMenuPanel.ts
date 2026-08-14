import type { SidebarIconId } from './icons'
import { SIDEBAR_ICONS } from './icons'

/** Parity+ extras under the Labs rail icon. */
export type LabsMenuItemId = 'live' | 'pets' | 'lootbag' | 'help' | 'dev'

export type LabsMenuItem = {
  id: LabsMenuItemId
  icon: SidebarIconId
  label: string
  shortcut?: string
}

export type LabsMenuPanelOptions = {
  anchor: () => HTMLElement | undefined
  items: readonly LabsMenuItem[]
  onSelect: (id: LabsMenuItemId) => void
  onClose?: () => void
}

/**
 * Flyout under the Labs rail icon — Live, Pets, Loot Bag, Help, Dev.
 * (Settings gear stays Preferences-only.)
 */
export class LabsMenuPanel {
  readonly element: HTMLDivElement
  private visible = false
  private readonly listEl: HTMLDivElement

  constructor(private readonly options: LabsMenuPanelOptions) {
    this.element = document.createElement('div')
    this.element.className = 'labs-menu'
    this.element.hidden = true
    this.element.setAttribute('role', 'menu')
    this.element.setAttribute('aria-label', 'Labs')
    this.element.innerHTML = `
      <header class="labs-menu__header">Labs</header>
      <div class="labs-menu__list" data-list></div>
    `
    this.listEl = this.element.querySelector('[data-list]')!

    for (const item of options.items) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'labs-menu__item'
      btn.setAttribute('role', 'menuitem')
      btn.dataset.menuId = item.id
      const tip = item.shortcut ? `${item.label} [${item.shortcut}]` : item.label
      btn.title = tip
      btn.innerHTML = `
        <span class="labs-menu__icon" aria-hidden="true">${SIDEBAR_ICONS[item.icon]}</span>
        <span class="labs-menu__label">${escapeHtml(item.label)}</span>
        ${
          item.shortcut
            ? `<kbd class="labs-menu__kbd">${escapeHtml(item.shortcut)}</kbd>`
            : ''
        }
      `
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        this.hide()
        this.options.onSelect(item.id)
      })
      this.listEl.appendChild(btn)
    }

    document.body.appendChild(this.element)
    document.addEventListener('click', this.onDocClick, true)
    window.addEventListener('keydown', this.onKeyDown)
  }

  private readonly onDocClick = (ev: MouseEvent): void => {
    if (!this.visible) return
    const t = ev.target as Node | null
    if (this.element.contains(t)) return
    if (this.options.anchor()?.contains(t ?? null)) return
    this.hide()
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && this.visible) this.hide()
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  show(): void {
    this.visible = true
    this.element.hidden = false
    this.positionNearAnchor()
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.element.hidden = true
    this.options.onClose?.()
  }

  isVisible(): boolean {
    return this.visible
  }

  setItemActive(id: LabsMenuItemId, active: boolean): void {
    const el = this.listEl.querySelector(`[data-menu-id="${id}"]`) as HTMLElement | null
    el?.classList.toggle('is-active', active)
  }

  dispose(): void {
    document.removeEventListener('click', this.onDocClick, true)
    window.removeEventListener('keydown', this.onKeyDown)
    this.element.remove()
  }

  private positionNearAnchor(): void {
    const anchor = this.options.anchor()
    const rect = anchor?.getBoundingClientRect()
    const pad = 8
    const menuW = 220
    let left = rect ? rect.right + pad : 56
    let top = rect ? rect.top : 80
    const maxLeft = window.innerWidth - menuW - pad
    const maxTop = window.innerHeight - this.element.offsetHeight - pad
    if (left > maxLeft) left = Math.max(pad, (rect?.left ?? 56) - menuW - pad)
    top = Math.max(pad, Math.min(top, Math.max(pad, maxTop)))
    this.element.style.left = `${Math.round(left)}px`
    this.element.style.top = `${Math.round(top)}px`
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
