import {
  clientSettings,
  MOUSE_SENSITIVITY_MAX,
  MOUSE_SENSITIVITY_MIN,
  type ClientSettingsState
} from '../../../rendering/ClientSettings'
import {
  formatKeybindCodes,
  formatKeyCodeLabel,
  KEYBIND_META,
  keybinds,
  type KeybindId,
  type KeybindsMap
} from '../../../input/keybinds'

/** Compact keyboard layout for the Controls panel (US QWERTY). */
const KEYBOARD_ROWS: readonly (readonly { code: string; label: string; wide?: 'wide' | 'space' | 'tall' }[])[] =
  [
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

/** Preferences → Controls — mouse look + remappable DCL keyboard actions. */
export class ControlsSettingsView {
  readonly root: HTMLElement
  private sensInput!: HTMLInputElement
  private sensLabel!: HTMLSpanElement
  private readonly bindListEl: HTMLElement
  private readonly keyboardEl: HTMLElement
  private readonly listenHint: HTMLElement
  private readonly keyEls = new Map<string, HTMLButtonElement>()
  private readonly bindRowEls = new Map<KeybindId, HTMLElement>()
  private readonly unsubs: Array<() => void> = []
  private syncing = false
  private listeningId: KeybindId | null = null
  private listenHandler: ((e: KeyboardEvent) => void) | null = null

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'gfx-settings'

    const scroll = document.createElement('div')
    scroll.className = 'gfx-settings__scroll'

    // —— Mouse ——
    scroll.appendChild(this.buildMouseSection())

    // —— Keyboard map ——
    const kbSection = document.createElement('section')
    kbSection.className = 'gfx-settings__section'
    const kbTitle = document.createElement('h3')
    kbTitle.className = 'gfx-settings__section-title'
    kbTitle.textContent = 'Keyboard'
    kbSection.appendChild(kbTitle)

    const note = document.createElement('p')
    note.className = 'keybinds-note'
    note.innerHTML =
      'Click an action, then press a key to rebind. Defaults match Explorer (WASD, <b>Ctrl = Walk</b>). ' +
      'On Windows/Linux, <b>Ctrl+W</b> closes the browser tab — rebind Walk or Forward if that conflicts.'
    kbSection.appendChild(note)

    this.listenHint = document.createElement('div')
    this.listenHint.className = 'keybinds-listen'
    this.listenHint.hidden = true
    kbSection.appendChild(this.listenHint)

    this.keyboardEl = document.createElement('div')
    this.keyboardEl.className = 'keybinds-keyboard'
    this.keyboardEl.setAttribute('aria-label', 'Keyboard map')
    this.buildKeyboard()
    kbSection.appendChild(this.keyboardEl)

    // —— Bind list ——
    this.bindListEl = document.createElement('div')
    this.bindListEl.className = 'keybinds-list'
    this.buildBindList()
    kbSection.appendChild(this.bindListEl)

    const actions = document.createElement('div')
    actions.className = 'gfx-settings__actions'
    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'gfx-settings__reset-btn'
    resetBtn.textContent = 'Reset keybinds'
    resetBtn.addEventListener('click', () => {
      this.cancelListening()
      keybinds.resetDefaults()
    })
    actions.appendChild(resetBtn)
    kbSection.appendChild(actions)

    scroll.appendChild(kbSection)
    this.root.appendChild(scroll)

    this.unsubs.push(clientSettings.subscribe((state) => this.syncMouse(state)))
    this.unsubs.push(keybinds.subscribe((map) => this.syncKeybinds(map)))
    this.syncKeybinds(keybinds.get())
  }

  private buildMouseSection(): HTMLElement {
    const section = document.createElement('section')
    section.className = 'gfx-settings__section'

    const title = document.createElement('h3')
    title.className = 'gfx-settings__section-title'
    title.textContent = 'Mouse'
    section.appendChild(title)

    const grid = document.createElement('div')
    grid.className = 'gfx-settings__grid'

    const row = document.createElement('div')
    row.className = 'gfx-settings__row'

    const name = document.createElement('span')
    name.className = 'gfx-settings__label'
    name.textContent = 'Mouse Sensitivity'
    row.appendChild(name)

    const wrap = document.createElement('div')
    wrap.className = 'gfx-settings__slider-wrap'

    const prevBtn = document.createElement('button')
    prevBtn.type = 'button'
    prevBtn.className = 'gfx-settings__slider-btn'
    prevBtn.textContent = '‹'
    prevBtn.setAttribute('aria-label', 'Decrease sensitivity')

    const nextBtn = document.createElement('button')
    nextBtn.type = 'button'
    nextBtn.className = 'gfx-settings__slider-btn'
    nextBtn.textContent = '›'
    nextBtn.setAttribute('aria-label', 'Increase sensitivity')

    this.sensInput = document.createElement('input')
    this.sensInput.type = 'range'
    this.sensInput.className = 'gfx-settings__slider'
    this.sensInput.min = String(MOUSE_SENSITIVITY_MIN)
    this.sensInput.max = String(MOUSE_SENSITIVITY_MAX)
    this.sensInput.value = String(clientSettings.getMouseSensitivity())

    this.sensLabel = document.createElement('span')
    this.sensLabel.className = 'gfx-settings__slider-value'

    const step = 5
    const apply = () => {
      const v = Number(this.sensInput.value)
      this.sensLabel.textContent = `${v}%`
      this.setSliderPct(this.sensInput, MOUSE_SENSITIVITY_MIN, MOUSE_SENSITIVITY_MAX)
      if (!this.syncing) clientSettings.setMouseSensitivity(v)
    }

    this.sensInput.addEventListener('input', apply)
    prevBtn.addEventListener('click', () => {
      this.sensInput.value = String(
        Math.max(MOUSE_SENSITIVITY_MIN, Number(this.sensInput.value) - step)
      )
      apply()
    })
    nextBtn.addEventListener('click', () => {
      this.sensInput.value = String(
        Math.min(MOUSE_SENSITIVITY_MAX, Number(this.sensInput.value) + step)
      )
      apply()
    })

    wrap.appendChild(prevBtn)
    wrap.appendChild(this.sensInput)
    wrap.appendChild(nextBtn)
    wrap.appendChild(this.sensLabel)
    row.appendChild(wrap)
    grid.appendChild(row)
    section.appendChild(grid)
    apply()
    return section
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

  private makeKeyButton(code: string, label: string, wide?: 'wide' | 'space' | 'tall'): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'keybinds-key'
    if (wide === 'wide') btn.classList.add('keybinds-key--wide')
    if (wide === 'space') btn.classList.add('keybinds-key--space')
    btn.dataset.code = code
    btn.textContent = label
    btn.title = code
    btn.addEventListener('click', () => {
      const id = keybinds.bindIdForCode(code)
      if (id) this.startListening(id)
    })
    this.keyEls.set(code, btn)
    // Mirror pair highlights for left/right modifiers
    if (code === 'ControlRight' || code === 'ShiftRight' || code === 'AltRight') {
      // still register
    }
    return btn
  }

  private buildBindList(): void {
    const groups: Array<{ title: string; group: 'movement' | 'actions' }> = [
      { title: 'Movement', group: 'movement' },
      { title: 'Actions', group: 'actions' }
    ]
    for (const g of groups) {
      const head = document.createElement('div')
      head.className = 'keybinds-list__group'
      head.textContent = g.title
      this.bindListEl.appendChild(head)

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
        row.addEventListener('click', () => this.startListening(meta.id))
        this.bindListEl.appendChild(row)
        this.bindRowEls.set(meta.id, row)
      }
    }
  }

  private startListening(id: KeybindId): void {
    this.cancelListening()
    this.listeningId = id
    const meta = keybinds.meta(id)
    this.listenHint.hidden = false
    this.listenHint.textContent = `Press a key for ${meta?.label ?? id}… (Esc to cancel)`
    this.bindRowEls.get(id)?.classList.add('is-listening')

    this.listenHandler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (e.repeat) return
      if (e.code === 'Escape') {
        this.cancelListening()
        return
      }
      const ok = keybinds.setBindFromCode(id, e.code)
      if (!ok) {
        this.listenHint.textContent = `Can't bind ${formatKeyCodeLabel(e.code)} — try another key (Esc to cancel)`
        return
      }
      this.cancelListening()
    }
    // Capture so rebind wins over game input / browser while panel is open
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
    this.listenHint.hidden = true
    this.listenHint.textContent = ''
  }

  private syncMouse(state: ClientSettingsState): void {
    this.syncing = true
    try {
      this.sensInput.value = String(state.mouseSensitivity)
      this.sensLabel.textContent = `${state.mouseSensitivity}%`
      this.setSliderPct(this.sensInput, MOUSE_SENSITIVITY_MIN, MOUSE_SENSITIVITY_MAX)
    } finally {
      this.syncing = false
    }
  }

  private syncKeybinds(map: KeybindsMap): void {
    // Reset key highlights
    for (const btn of this.keyEls.values()) {
      btn.classList.remove('is-bound', 'is-walk', 'is-move', 'is-action')
      btn.removeAttribute('data-bind-label')
      const base = btn.dataset.code
      // restore glyph from layout — keep textContent as constructed
      void base
    }

    for (const meta of KEYBIND_META) {
      const codes = map[meta.id] ?? []
      const badge = this.bindRowEls.get(meta.id)?.querySelector('[data-role="badge"]')
      if (badge) badge.textContent = formatKeybindCodes(codes)

      for (const code of codes) {
        // Also light pair if only one side stored
        const codesToLight = [code]
        if (code === 'ControlLeft') codesToLight.push('ControlRight')
        if (code === 'ControlRight') codesToLight.push('ControlLeft')
        if (code === 'ShiftLeft') codesToLight.push('ShiftRight')
        if (code === 'ShiftRight') codesToLight.push('ShiftLeft')

        for (const c of codesToLight) {
          const btn = this.keyEls.get(c)
          if (!btn) continue
          btn.classList.add('is-bound')
          if (meta.group === 'movement') {
            if (meta.id === 'walk') btn.classList.add('is-walk')
            else btn.classList.add('is-move')
          } else {
            btn.classList.add('is-action')
          }
          btn.title = `${formatKeyCodeLabel(c)} → ${meta.label} (${meta.description})`
          btn.dataset.bindLabel = meta.label
        }
      }
    }
  }

  private setSliderPct(slider: HTMLInputElement, min: number, max: number): void {
    const value = Number(slider.value)
    const span = max - min
    const pct = span <= 0 ? 0 : ((value - min) / span) * 100
    slider.style.setProperty('--pct', `${pct}%`)
  }

  dispose(): void {
    this.cancelListening()
    for (const u of this.unsubs) u()
    this.unsubs.length = 0
    this.root.remove()
  }
}
