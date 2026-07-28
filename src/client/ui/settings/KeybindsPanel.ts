import { playUiClick } from '../UiSfx'
import {
  formatKeybindCodes,
  formatKeyCodeLabel,
  KEYBIND_META,
  keybinds,
  type KeybindId,
  type KeybindsMap
} from '../../../input/keybinds'

/** US QWERTY layout for the full-screen keybinds editor. */
const KEYBOARD_ROWS: readonly (readonly {
  code: string
  label: string
  wide?: 'wide' | 'space'
}[])[] = [
  [
    { code: 'Escape', label: 'Esc' },
    { code: 'Digit1', label: '1' },
    { code: 'Digit2', label: '2' },
    { code: 'Digit3', label: '3' },
    { code: 'Digit4', label: '4' },
    { code: 'Digit5', label: '5' },
    { code: 'Digit6', label: '6' },
    { code: 'Digit7', label: '7' },
    { code: 'Digit8', label: '8' },
    { code: 'Digit9', label: '9' },
    { code: 'Digit0', label: '0' }
  ],
  [
    { code: 'Tab', label: 'Tab', wide: 'wide' },
    { code: 'KeyQ', label: 'Q' },
    { code: 'KeyW', label: 'W' },
    { code: 'KeyE', label: 'E' },
    { code: 'KeyR', label: 'R' },
    { code: 'KeyT', label: 'T' },
    { code: 'KeyY', label: 'Y' },
    { code: 'KeyU', label: 'U' },
    { code: 'KeyI', label: 'I' },
    { code: 'KeyO', label: 'O' },
    { code: 'KeyP', label: 'P' }
  ],
  [
    { code: 'CapsLock', label: 'Caps', wide: 'wide' },
    { code: 'KeyA', label: 'A' },
    { code: 'KeyS', label: 'S' },
    { code: 'KeyD', label: 'D' },
    { code: 'KeyF', label: 'F' },
    { code: 'KeyG', label: 'G' },
    { code: 'KeyH', label: 'H' },
    { code: 'KeyJ', label: 'J' },
    { code: 'KeyK', label: 'K' },
    { code: 'KeyL', label: 'L' }
  ],
  [
    { code: 'ShiftLeft', label: 'Shift', wide: 'wide' },
    { code: 'KeyZ', label: 'Z' },
    { code: 'KeyX', label: 'X' },
    { code: 'KeyC', label: 'C' },
    { code: 'KeyV', label: 'V' },
    { code: 'KeyB', label: 'B' },
    { code: 'KeyN', label: 'N' },
    { code: 'KeyM', label: 'M' },
    { code: 'ShiftRight', label: 'Shift', wide: 'wide' }
  ],
  [
    { code: 'ControlLeft', label: 'Ctrl', wide: 'wide' },
    { code: 'AltLeft', label: 'Alt', wide: 'wide' },
    { code: 'Space', label: 'Space', wide: 'space' },
    { code: 'AltRight', label: 'Alt', wide: 'wide' },
    { code: 'ControlRight', label: 'Ctrl', wide: 'wide' }
  ]
]

const ARROW_CLUSTER: readonly { code: string; label: string }[] = [
  { code: 'ArrowUp', label: '↑' },
  { code: 'ArrowLeft', label: '←' },
  { code: 'ArrowDown', label: '↓' },
  { code: 'ArrowRight', label: '→' }
]

/**
 * Full-screen keyboard remapper (main overlay) — opened from Preferences → Controls.
 */
const SUBTITLE_IDLE =
  'Select an action, then click any key on the board (or press it). Esc cancels.'

export class KeybindsPanel {
  readonly root: HTMLElement
  private readonly keyboardEl: HTMLElement
  private readonly bindListEl: HTMLElement
  private readonly subtitleEl: HTMLElement
  private readonly keyEls = new Map<string, HTMLButtonElement>()
  private readonly bindRowEls = new Map<KeybindId, HTMLElement>()
  private visible = false
  private unsubKeybinds: (() => void) | null = null
  private listeningId: KeybindId | null = null
  private listenHandler: ((e: KeyboardEvent) => void) | null = null

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'keybinds-overlay'
    this.root.setAttribute('hidden', '')
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-modal', 'true')
    this.root.setAttribute('aria-label', 'Edit keyboard controls')

    this.root.innerHTML = `
      <div class="keybinds-overlay__panel">
        <header class="keybinds-overlay__header">
          <div class="keybinds-overlay__heading">
            <span class="keybinds-overlay__title">Keyboard</span>
            <span class="keybinds-overlay__subtitle" data-subtitle>${SUBTITLE_IDLE}</span>
          </div>
          <button type="button" class="keybinds-overlay__close" aria-label="Close">&times;</button>
        </header>
        <div class="keybinds-overlay__body">
          <p class="keybinds-note">
            Every blue key is remappable — even ones Explorer never used (e.g. map <b>Walk → Tab</b>).
            Defaults match Explorer (WASD, <b>Ctrl = Walk</b>). Rebind Walk off Ctrl to avoid browser <b>Ctrl+W</b> closing the tab.
          </p>
          <div class="keybinds-keyboard" data-keyboard aria-label="Keyboard map"></div>
          <div class="keybinds-list" data-list></div>
          <div class="keybinds-overlay__footer">
            <button type="button" class="gfx-settings__reset-btn" data-reset>Reset to defaults</button>
          </div>
        </div>
      </div>
    `

    this.subtitleEl = this.root.querySelector('[data-subtitle]')!
    this.keyboardEl = this.root.querySelector('[data-keyboard]')!
    this.bindListEl = this.root.querySelector('[data-list]')!

    this.buildKeyboard()
    this.buildBindList()

    this.root.querySelector('.keybinds-overlay__close')!.addEventListener('click', () => {
      playUiClick()
      this.hide()
    })
    this.root.querySelector('[data-reset]')!.addEventListener('click', () => {
      playUiClick()
      this.cancelListening()
      keybinds.resetDefaults()
    })
    // Backdrop click (outside panel) closes
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) {
        playUiClick()
        this.hide()
      }
    })
    window.addEventListener('keydown', this.onWindowKeyDown)

    document.body.appendChild(this.root)
  }

  show(): void {
    if (this.visible) return
    this.visible = true
    this.root.removeAttribute('hidden')
    requestAnimationFrame(() => this.root.classList.add('is-open'))
    this.unsubKeybinds?.()
    this.unsubKeybinds = keybinds.subscribe((map) => this.syncKeybinds(map))
    this.syncKeybinds(keybinds.get())
  }

  hide(): void {
    if (!this.visible) return
    this.cancelListening()
    this.visible = false
    this.root.classList.remove('is-open')
    this.unsubKeybinds?.()
    this.unsubKeybinds = null
    setTimeout(() => {
      if (!this.visible) this.root.setAttribute('hidden', '')
    }, 280)
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  isVisible(): boolean {
    return this.visible
  }

  private onWindowKeyDown = (e: KeyboardEvent): void => {
    if (!this.visible) return
    // Listening handler owns Esc while rebinding
    if (this.listeningId) return
    if (e.code === 'Escape') {
      e.preventDefault()
      this.hide()
    }
  }

  private buildKeyboard(): void {
    const main = document.createElement('div')
    main.className = 'keybinds-keyboard__main'

    for (const row of KEYBOARD_ROWS) {
      const rowEl = document.createElement('div')
      rowEl.className = 'keybinds-keyboard__row'
      for (const key of row) {
        rowEl.appendChild(this.makeKeyButton(key.code, key.label, key.wide))
      }
      main.appendChild(rowEl)
    }
    this.keyboardEl.appendChild(main)

    const arrows = document.createElement('div')
    arrows.className = 'keybinds-keyboard__arrows'
    const upRow = document.createElement('div')
    upRow.className = 'keybinds-keyboard__row keybinds-keyboard__row--arrows-up'
    upRow.appendChild(this.makeKeyButton('ArrowUp', '↑'))
    arrows.appendChild(upRow)
    const mid = document.createElement('div')
    mid.className = 'keybinds-keyboard__row'
    for (const k of ARROW_CLUSTER.slice(1)) {
      mid.appendChild(this.makeKeyButton(k.code, k.label))
    }
    arrows.appendChild(mid)
    this.keyboardEl.appendChild(arrows)
  }

  private makeKeyButton(
    code: string,
    label: string,
    wide?: 'wide' | 'space'
  ): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'keybinds-key keybinds-key--remappable'
    if (wide === 'wide') btn.classList.add('keybinds-key--wide')
    if (wide === 'space') btn.classList.add('keybinds-key--space')
    // Escape only cancels rebind — never a bind target.
    if (code === 'Escape') {
      btn.classList.remove('keybinds-key--remappable')
      btn.classList.add('keybinds-key--locked')
      btn.disabled = true
      btn.title = 'Esc cancels rebind'
    }
    btn.dataset.code = code
    btn.innerHTML = `<span class="keybinds-key__glyph">${label}</span><span class="keybinds-key__action" data-role="action"></span>`
    btn.title = code
    btn.addEventListener('click', () => this.onKeyClick(code))
    this.keyEls.set(code, btn)
    return btn
  }

  /** Action selected → click any key to assign. No selection → click bound key to reselect that action. */
  private onKeyClick(code: string): void {
    if (code === 'Escape') return
    playUiClick()
    if (this.listeningId) {
      this.assignCode(this.listeningId, code)
      return
    }
    const existing = keybinds.bindIdForCode(code)
    if (existing) {
      this.startListening(existing)
      return
    }
    this.setSubtitle('Select an action below first, then click a key (or press it).')
  }

  private assignCode(id: KeybindId, code: string): void {
    // Exact physical key from the board — Tab, Caps, etc. all valid.
    const ok = keybinds.setBindFromCode(id, code)
    if (!ok) {
      this.setSubtitle(`Can't bind ${formatKeyCodeLabel(code)} — try another key (Esc to cancel).`)
      return
    }
    this.cancelListening()
  }

  private setSubtitle(text: string, active = false): void {
    this.subtitleEl.textContent = text
    this.subtitleEl.classList.toggle('is-active', active)
  }

  private buildBindList(): void {
    const grid = document.createElement('div')
    grid.className = 'keybinds-list__grid'

    const groups: Array<{ title: string; group: 'movement' | 'actions' }> = [
      { title: 'Movement', group: 'movement' },
      { title: 'Actions', group: 'actions' }
    ]

    for (const g of groups) {
      const col = document.createElement('div')
      col.className = 'keybinds-list__col'
      const head = document.createElement('div')
      head.className = 'keybinds-list__group'
      head.textContent = g.title
      col.appendChild(head)

      for (const meta of KEYBIND_META) {
        if (meta.group !== g.group) continue
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'keybinds-bind-row'
        row.dataset.bindId = meta.id

        const left = document.createElement('div')
        left.className = 'keybinds-bind-row__left'
        const name = document.createElement('span')
        name.className = 'keybinds-bind-row__name'
        name.textContent = meta.label
        const desc = document.createElement('span')
        desc.className = 'keybinds-bind-row__desc'
        desc.textContent = meta.description
        left.appendChild(name)
        left.appendChild(desc)

        const badge = document.createElement('span')
        badge.className = 'keybinds-bind-row__badge'
        badge.dataset.role = 'badge'

        row.appendChild(left)
        row.appendChild(badge)
        row.addEventListener('click', () => {
          playUiClick()
          this.startListening(meta.id)
        })
        col.appendChild(row)
        this.bindRowEls.set(meta.id, row)
      }
      grid.appendChild(col)
    }
    this.bindListEl.appendChild(grid)
  }

  private startListening(id: KeybindId): void {
    this.cancelListening()
    this.listeningId = id
    const meta = keybinds.meta(id)
    this.setSubtitle(
      `Binding ${meta?.label ?? id} — click any blue key or press it. Esc cancels.`,
      true
    )
    this.bindRowEls.get(id)?.classList.add('is-listening')
    this.root.classList.add('is-listening')

    this.listenHandler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (e.repeat) return
      if (e.code === 'Escape') {
        this.cancelListening()
        return
      }
      this.assignCode(id, e.code)
    }
    window.addEventListener('keydown', this.listenHandler, true)
  }

  private cancelListening(): void {
    if (this.listenHandler) {
      window.removeEventListener('keydown', this.listenHandler, true)
      this.listenHandler = null
    }
    if (this.listeningId) {
      this.bindRowEls.get(this.listeningId)?.classList.remove('is-listening')
    }
    this.listeningId = null
    this.root.classList.remove('is-listening')
    this.setSubtitle(SUBTITLE_IDLE)
  }

  private syncKeybinds(map: KeybindsMap): void {
    for (const btn of this.keyEls.values()) {
      btn.classList.remove('is-bound')
      const actionEl = btn.querySelector('[data-role="action"]')
      if (actionEl) actionEl.textContent = ''
      const code = btn.dataset.code ?? ''
      btn.title = code === 'Escape' ? 'Esc cancels rebind' : `${formatKeyCodeLabel(code)} — click to assign when an action is selected`
    }

    for (const meta of KEYBIND_META) {
      const codes = map[meta.id] ?? []
      const badge = this.bindRowEls.get(meta.id)?.querySelector('[data-role="badge"]')
      if (badge) badge.textContent = formatKeybindCodes(codes)

      for (const code of codes) {
        const btn = this.keyEls.get(code)
        if (!btn) continue
        btn.classList.add('is-bound')
        const actionEl = btn.querySelector('[data-role="action"]')
        if (actionEl) actionEl.textContent = meta.label
        btn.title = `${formatKeyCodeLabel(code)} → ${meta.label} (click to rebind)`
      }
    }
  }

  dispose(): void {
    this.hide()
    window.removeEventListener('keydown', this.onWindowKeyDown)
    this.cancelListening()
    this.unsubKeybinds?.()
    this.root.remove()
  }
}

let sharedPanel: KeybindsPanel | null = null

/** Open the shared full-screen keybinds editor (creates on first use). */
export function openKeybindsPanel(): KeybindsPanel {
  if (!sharedPanel) sharedPanel = new KeybindsPanel()
  sharedPanel.show()
  return sharedPanel
}

export function hideKeybindsPanel(): void {
  sharedPanel?.hide()
}

export function disposeKeybindsPanel(): void {
  sharedPanel?.dispose()
  sharedPanel = null
}
