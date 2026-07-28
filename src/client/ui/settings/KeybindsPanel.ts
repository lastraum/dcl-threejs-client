import { playUiClick } from '../UiSfx'
import {
  formatKeybindCodes,
  formatKeyCodeLabel,
  KEYBIND_META,
  keybinds,
  type KeybindId,
  type KeybindsMap
} from '../../../input/keybinds'
import {
  KEYBOARD_ARROWS,
  KEYBOARD_BOARD,
  KEYBOARD_LAYOUTS,
  KEYBOARD_NUMPAD,
  layoutKeyLabel,
  loadKeyboardLayoutId,
  saveKeyboardLayoutId,
  type KeyboardKeySpec,
  type KeyboardLayoutId,
  type KeyWide
} from '../../../input/keyboardLayouts'

/**
 * Full-screen keyboard remapper (main overlay) — opened from Preferences → Controls.
 *
 * Physical KeyboardEvent.code is always the bind identity. Layout only changes
 * the glyphs painted on each key (AZERTY/QWERTZ/…), not what the OS reports.
 */
const SUBTITLE_IDLE =
  'Select an action, then click any key on the board (or press it). Esc cancels.'

export class KeybindsPanel {
  readonly root: HTMLElement
  private readonly keyboardEl: HTMLElement
  private readonly bindListEl: HTMLElement
  private readonly subtitleEl: HTMLElement
  private readonly layoutSelect: HTMLSelectElement
  private readonly keyEls = new Map<string, HTMLButtonElement>()
  private readonly bindRowEls = new Map<KeybindId, HTMLElement>()
  private visible = false
  private unsubKeybinds: (() => void) | null = null
  private listeningId: KeybindId | null = null
  private listenHandler: ((e: KeyboardEvent) => void) | null = null
  private layoutId: KeyboardLayoutId = loadKeyboardLayoutId()

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
          <div class="keybinds-overlay__header-right">
            <label class="keybinds-layout">
              <span class="keybinds-layout__label">Layout</span>
              <select class="keybinds-layout__select" data-layout aria-label="Keyboard layout"></select>
            </label>
            <button type="button" class="keybinds-overlay__close" aria-label="Close">&times;</button>
          </div>
        </header>
        <div class="keybinds-overlay__body">
          <p class="keybinds-note">
            Full keyboard — every blue key is remappable (including Tab, Caps, numpad).
            Layout only changes the labels (AZERTY / QWERTZ / …); binds use physical key position so they stay consistent across OS layouts.
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
    this.layoutSelect = this.root.querySelector('[data-layout]')!

    for (const layout of KEYBOARD_LAYOUTS) {
      const opt = document.createElement('option')
      opt.value = layout.id
      opt.textContent = layout.label
      opt.title = layout.description
      this.layoutSelect.appendChild(opt)
    }
    this.layoutSelect.value = this.layoutId
    this.layoutSelect.addEventListener('change', () => {
      const next = this.layoutSelect.value as KeyboardLayoutId
      this.layoutId = next
      saveKeyboardLayoutId(next)
      this.refreshKeyLabels()
      this.syncKeybinds(keybinds.get())
      playUiClick()
    })

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
    if (this.listeningId) return
    if (e.code === 'Escape') {
      e.preventDefault()
      this.hide()
    }
  }

  private buildKeyboard(): void {
    this.keyboardEl.innerHTML = ''
    this.keyEls.clear()

    const main = document.createElement('div')
    main.className = 'keybinds-keyboard__main'
    for (const row of KEYBOARD_BOARD) {
      const rowEl = document.createElement('div')
      rowEl.className = 'keybinds-keyboard__row'
      for (const key of row) {
        rowEl.appendChild(this.makeKeyButton(key))
      }
      main.appendChild(rowEl)
    }
    this.keyboardEl.appendChild(main)

    const side = document.createElement('div')
    side.className = 'keybinds-keyboard__side'

    const arrows = document.createElement('div')
    arrows.className = 'keybinds-keyboard__arrows'
    const upRow = document.createElement('div')
    upRow.className = 'keybinds-keyboard__row keybinds-keyboard__row--arrows-up'
    upRow.appendChild(this.makeKeyButton(KEYBOARD_ARROWS[0]!))
    arrows.appendChild(upRow)
    const mid = document.createElement('div')
    mid.className = 'keybinds-keyboard__row'
    for (const k of KEYBOARD_ARROWS.slice(1)) {
      mid.appendChild(this.makeKeyButton(k))
    }
    arrows.appendChild(mid)
    side.appendChild(arrows)

    const numpad = document.createElement('div')
    numpad.className = 'keybinds-keyboard__numpad'
    for (const row of KEYBOARD_NUMPAD) {
      const rowEl = document.createElement('div')
      rowEl.className = 'keybinds-keyboard__row keybinds-keyboard__row--numpad'
      for (const key of row) {
        rowEl.appendChild(this.makeKeyButton(key))
      }
      numpad.appendChild(rowEl)
    }
    side.appendChild(numpad)

    this.keyboardEl.appendChild(side)
    this.refreshKeyLabels()
  }

  private makeKeyButton(spec: KeyboardKeySpec): HTMLButtonElement {
    const { code, wide, locked } = spec
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'keybinds-key'
    if (!locked) btn.classList.add('keybinds-key--remappable')
    if (wide) btn.classList.add(wideClass(wide))
    if (locked || code === 'Escape') {
      btn.classList.remove('keybinds-key--remappable')
      btn.classList.add('keybinds-key--locked')
      btn.disabled = true
      btn.title = 'Esc cancels rebind'
    }
    btn.dataset.code = code
    btn.innerHTML = `<span class="keybinds-key__glyph" data-role="glyph"></span><span class="keybinds-key__action" data-role="action"></span>`
    if (!btn.disabled) {
      btn.addEventListener('click', () => this.onKeyClick(code))
    }
    this.keyEls.set(code, btn)
    return btn
  }

  private refreshKeyLabels(): void {
    for (const [code, btn] of this.keyEls) {
      const glyph = btn.querySelector('[data-role="glyph"]')
      if (glyph) glyph.textContent = layoutKeyLabel(this.layoutId, code)
    }
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
      if (code === 'Escape' || btn.classList.contains('keybinds-key--locked')) {
        btn.title = 'Esc cancels rebind'
      } else {
        const glyph = layoutKeyLabel(this.layoutId, code)
        btn.title = `${glyph} (${code}) — click to assign when an action is selected`
      }
    }

    for (const meta of KEYBIND_META) {
      const codes = map[meta.id] ?? []
      const badge = this.bindRowEls.get(meta.id)?.querySelector('[data-role="badge"]')
      if (badge) {
        // Show layout-aware glyphs when possible
        badge.textContent = codes.length
          ? codes.map((c) => layoutKeyLabel(this.layoutId, c)).join(' / ')
          : formatKeybindCodes(codes)
      }

      for (const code of codes) {
        const btn = this.keyEls.get(code)
        if (!btn) continue
        btn.classList.add('is-bound')
        const actionEl = btn.querySelector('[data-role="action"]')
        if (actionEl) actionEl.textContent = meta.label
        const glyph = layoutKeyLabel(this.layoutId, code)
        btn.title = `${glyph} → ${meta.label} (click to rebind)`
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

function wideClass(wide: KeyWide): string {
  switch (wide) {
    case 'wide':
      return 'keybinds-key--wide'
    case 'wider':
      return 'keybinds-key--wider'
    case 'space':
      return 'keybinds-key--space'
    case 'enter':
      return 'keybinds-key--enter'
    case 'shift':
      return 'keybinds-key--shift'
    default:
      return ''
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
