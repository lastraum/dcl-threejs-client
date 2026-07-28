import {
  clientSettings,
  MOUSE_SENSITIVITY_MAX,
  MOUSE_SENSITIVITY_MIN,
  type ClientSettingsState
} from '../../../rendering/ClientSettings'
import { playUiClick } from '../UiSfx'
import { openKeybindsPanel } from './KeybindsPanel'

/** Preferences → Controls — mouse look + entry point to full-screen keybinds editor. */
export class ControlsSettingsView {
  readonly root: HTMLElement
  private sensInput!: HTMLInputElement
  private sensLabel!: HTMLSpanElement
  private readonly unsubscribe?: () => void
  private syncing = false

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'gfx-settings'

    const scroll = document.createElement('div')
    scroll.className = 'gfx-settings__scroll'

    // —— Mouse ——
    scroll.appendChild(this.buildMouseSection())

    // —— Keyboard entry ——
    const kbSection = document.createElement('section')
    kbSection.className = 'gfx-settings__section'

    const title = document.createElement('h3')
    title.className = 'gfx-settings__section-title'
    title.textContent = 'Keyboard'
    kbSection.appendChild(title)

    const note = document.createElement('p')
    note.className = 'keybinds-note'
    note.textContent =
      'Remap movement and action keys (WASD, Walk, E/F, …). Useful when browser shortcuts clash — e.g. Ctrl+W closes the tab while DCL uses Ctrl for Walk.'
    kbSection.appendChild(note)

    const row = document.createElement('div')
    row.className = 'gfx-settings__row'

    const label = document.createElement('span')
    label.className = 'gfx-settings__label'
    label.textContent = 'Key bindings'
    row.appendChild(label)

    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'gfx-settings__action-btn'
    editBtn.textContent = 'Edit keys'
    editBtn.addEventListener('click', () => {
      playUiClick()
      openKeybindsPanel()
    })
    row.appendChild(editBtn)

    const grid = document.createElement('div')
    grid.className = 'gfx-settings__grid'
    grid.appendChild(row)
    kbSection.appendChild(grid)

    scroll.appendChild(kbSection)
    this.root.appendChild(scroll)

    this.unsubscribe = clientSettings.subscribe((state) => this.sync(state))
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

  private sync(state: ClientSettingsState): void {
    this.syncing = true
    try {
      this.sensInput.value = String(state.mouseSensitivity)
      this.sensLabel.textContent = `${state.mouseSensitivity}%`
      this.setSliderPct(this.sensInput, MOUSE_SENSITIVITY_MIN, MOUSE_SENSITIVITY_MAX)
    } finally {
      this.syncing = false
    }
  }

  private setSliderPct(slider: HTMLInputElement, min: number, max: number): void {
    const value = Number(slider.value)
    const span = max - min
    const pct = span <= 0 ? 0 : ((value - min) / span) * 100
    slider.style.setProperty('--pct', `${pct}%`)
  }

  dispose(): void {
    this.unsubscribe?.()
    this.root.remove()
  }
}
