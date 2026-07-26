export type PetContextMenuAction = 'view-info' | 'disable' | 'view-owner' | 'report'

export type PetContextMenuTarget =
  | { kind: 'local'; name: string; category: string; hash: string }
  | { kind: 'remote'; name: string; category: string; hash: string; ownerAddress: string }

export type PetContextMenuHandlers = {
  onAction: (action: PetContextMenuAction, target: PetContextMenuTarget) => void
  onHide?: () => void
}

/** Explorer-style context menu for pets (own vs remote). */
export class PetContextMenu {
  private readonly root: HTMLElement
  private readonly backdrop: HTMLElement
  private open = false
  private target: PetContextMenuTarget | null = null

  constructor(private readonly handlers: PetContextMenuHandlers) {
    this.backdrop = document.createElement('div')
    this.backdrop.className = 'user-context-menu-backdrop'
    this.backdrop.hidden = true
    this.backdrop.addEventListener('click', () => this.hide())
    this.backdrop.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.hide()
    })

    this.root = document.createElement('div')
    this.root.className = 'user-context-menu pet-context-menu'
    this.root.hidden = true
    this.root.setAttribute('role', 'menu')

    document.body.appendChild(this.backdrop)
    document.body.appendChild(this.root)

    window.addEventListener('keydown', this.onKeyDown)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    this.root.remove()
    this.backdrop.remove()
  }

  isOpen(): boolean {
    return this.open
  }

  show(target: PetContextMenuTarget, clientX: number, clientY: number): void {
    this.target = target
    this.render(target)

    const panelWidth = 280
    const panelHeight = this.root.offsetHeight || 280
    const left = Math.min(Math.max(8, clientX), window.innerWidth - panelWidth - 8)
    const top = Math.min(Math.max(8, clientY), window.innerHeight - panelHeight - 8)
    this.root.style.left = `${left}px`
    this.root.style.top = `${top}px`

    this.open = true
    this.root.hidden = false
    this.backdrop.hidden = false
  }

  hide(): void {
    if (!this.open) return
    this.open = false
    this.target = null
    this.root.innerHTML = ''
    this.root.hidden = true
    this.backdrop.hidden = true
    this.handlers.onHide?.()
  }

  private render(target: PetContextMenuTarget): void {
    const title = target.kind === 'local' ? 'Your pet' : 'Pet'
    const sub = [
      escapeHtml(target.name),
      target.category,
      `${target.hash.slice(0, 8)}…`
    ].join(' · ')

    const actions: { action: PetContextMenuAction; label: string }[] = [
      { action: 'view-info', label: 'Pet info' }
    ]
    if (target.kind === 'local') {
      actions.push({ action: 'disable', label: 'Disable pet' })
    } else {
      actions.push({ action: 'view-owner', label: 'View owner profile' })
      actions.push({ action: 'report', label: 'Report (coming soon)' })
    }

    this.root.innerHTML = `
      <div class="user-context-menu__header">
        <div class="user-context-menu__name">${escapeHtml(title)}</div>
        <div class="user-context-menu__address">${sub}</div>
      </div>
      <div class="user-context-menu__actions">
        ${actions
          .map(
            (a) =>
              `<button type="button" class="user-context-menu__row" data-action="${a.action}" role="menuitem">${escapeHtml(a.label)}</button>`
          )
          .join('')}
      </div>
    `

    this.root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action as PetContextMenuAction
        const t = this.target
        this.hide()
        if (t && action) this.handlers.onAction(action, t)
      })
    })
  }

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && this.open) this.hide()
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
