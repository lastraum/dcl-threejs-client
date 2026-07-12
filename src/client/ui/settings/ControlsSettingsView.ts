import {
  clientSettings,
  MOUSE_SENSITIVITY_MAX,
  MOUSE_SENSITIVITY_MIN,
  type ClientSettingsState
} from '../../../rendering/ClientSettings'

/** Preferences → Controls — mouse look sensitivity (and future binds). */
export class ControlsSettingsView {
  readonly root: HTMLElement
  private readonly sensInput: HTMLInputElement
  private readonly sensLabel: HTMLSpanElement
  private readonly unsubscribe?: () => void
  private syncing = false

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'gfx-settings'

    const scroll = document.createElement('div')
    scroll.className = 'gfx-settings__scroll'

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
    scroll.appendChild(section)
    this.root.appendChild(scroll)

    this.unsubscribe = clientSettings.subscribe((state) => this.sync(state))
    apply()
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
