import { clientSettings, FOV_MIN, FOV_MAX } from '../../../rendering/ClientSettings'

type DropdownDef = {
  type: 'dropdown'
  label: string
  options: string[]
  defaultIndex: number
}

type SliderDef = {
  type: 'slider'
  label: string
  min: number
  max: number
  defaultValue: number
  suffix?: string
  onChange?: (value: number) => void
}

type ToggleDef = {
  type: 'toggle'
  label: string
  defaultOn: boolean
}

type SettingDef = DropdownDef | SliderDef | ToggleDef

type SectionDef = {
  title: string
  items: SettingDef[]
}

const SECTIONS: SectionDef[] = [
  {
    title: 'General',
    items: [
      { type: 'dropdown', label: 'Graphics Preset', options: ['Low', 'Medium', 'High', 'Ultra', 'Custom'], defaultIndex: 2 }
    ]
  },
  {
    title: 'Display',
    items: [
      { type: 'dropdown', label: 'Resolution', options: ['1920x1080', '2560x1440', '3014x1952', '3840x2160'], defaultIndex: 2 },
      { type: 'slider', label: 'Resolution Scale', min: 0, max: 200, defaultValue: 120, suffix: '%' },
      { type: 'slider', label: 'Field of View', min: FOV_MIN, max: FOV_MAX, defaultValue: clientSettings.getFov(), suffix: '°', onChange: (v) => clientSettings.setFov(v) },
      { type: 'toggle', label: 'Fullscreen', defaultOn: false },
      { type: 'dropdown', label: 'FPS Limit', options: ['30', '60', '120', 'Max'], defaultIndex: 1 },
      { type: 'toggle', label: 'VSync', defaultOn: true }
    ]
  },
  {
    title: 'Post Processing',
    items: [
      { type: 'dropdown', label: 'MSAA', options: ['Off', '2x', '4x', '8x'], defaultIndex: 2 },
      { type: 'toggle', label: 'HDR', defaultOn: true },
      { type: 'toggle', label: 'Bloom', defaultOn: true },
      { type: 'toggle', label: 'Avatar Outline', defaultOn: false }
    ]
  },
  {
    title: 'Landscape and Foliage',
    items: [
      { type: 'slider', label: 'Scene Distance', min: 0, max: 200, defaultValue: 100 },
      { type: 'slider', label: 'Landscape Distance', min: 0, max: 10000, defaultValue: 7000 }
    ]
  },
  {
    title: 'Sun',
    items: [
      { type: 'toggle', label: 'Sun Shadows', defaultOn: true },
      { type: 'toggle', label: 'Sun Lens Flare', defaultOn: true }
    ]
  },
  {
    title: 'Scene Lighting',
    items: [
      { type: 'toggle', label: 'Enable Scene Lights', defaultOn: true },
      { type: 'slider', label: 'Max Lights in a Scene', min: 0, max: 20, defaultValue: 10 }
    ]
  },
  {
    title: 'Shadows',
    items: [
      { type: 'dropdown', label: 'Quality', options: ['Off', 'Low', 'Medium', 'High', 'Ultra'], defaultIndex: 3 },
      { type: 'slider', label: 'Shadows Distance', min: 0, max: 200, defaultValue: 100 }
    ]
  },
  {
    title: 'Other',
    items: [
      { type: 'toggle', label: 'Play current scene streams only', defaultOn: true }
    ]
  },
  {
    title: 'Physics',
    items: [
      { type: 'toggle', label: 'Jiggle Bones', defaultOn: false }
    ]
  }
]

export class GraphicsSettingsView {
  readonly root: HTMLElement

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'gfx-settings'

    const scrollArea = document.createElement('div')
    scrollArea.className = 'gfx-settings__scroll'

    for (const section of SECTIONS) {
      scrollArea.appendChild(this.buildSection(section))
    }

    this.root.appendChild(scrollArea)
  }

  private buildSection(section: SectionDef): HTMLElement {
    const el = document.createElement('section')
    el.className = 'gfx-settings__section'

    const header = document.createElement('h3')
    header.className = 'gfx-settings__section-title'
    header.textContent = section.title
    el.appendChild(header)

    const grid = document.createElement('div')
    grid.className = 'gfx-settings__grid'

    for (const item of section.items) {
      grid.appendChild(this.buildItem(item))
    }

    el.appendChild(grid)
    return el
  }

  private buildItem(def: SettingDef): HTMLElement {
    const row = document.createElement('div')
    row.className = 'gfx-settings__row'

    const label = document.createElement('span')
    label.className = 'gfx-settings__label'
    label.textContent = def.label
    row.appendChild(label)

    switch (def.type) {
      case 'dropdown':
        row.appendChild(this.buildDropdown(def))
        break
      case 'slider':
        row.appendChild(this.buildSlider(def))
        break
      case 'toggle':
        row.appendChild(this.buildToggle(def))
        break
    }

    return row
  }

  private buildDropdown(def: DropdownDef): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'gfx-settings__dropdown'

    const select = document.createElement('select')
    select.className = 'gfx-settings__select'
    for (let i = 0; i < def.options.length; i++) {
      const opt = document.createElement('option')
      opt.value = def.options[i]!
      opt.textContent = def.options[i]!
      if (i === def.defaultIndex) opt.selected = true
      select.appendChild(opt)
    }

    const chevron = document.createElement('span')
    chevron.className = 'gfx-settings__chevron'
    chevron.innerHTML = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`

    wrap.appendChild(select)
    wrap.appendChild(chevron)
    return wrap
  }

  private buildSlider(def: SliderDef): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'gfx-settings__slider-wrap'

    const prevBtn = document.createElement('button')
    prevBtn.type = 'button'
    prevBtn.className = 'gfx-settings__slider-btn'
    prevBtn.textContent = '‹'
    prevBtn.setAttribute('aria-label', 'Decrease')

    const nextBtn = document.createElement('button')
    nextBtn.type = 'button'
    nextBtn.className = 'gfx-settings__slider-btn'
    nextBtn.textContent = '›'
    nextBtn.setAttribute('aria-label', 'Increase')

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.className = 'gfx-settings__slider'
    slider.min = String(def.min)
    slider.max = String(def.max)
    slider.value = String(def.defaultValue)

    const valueLabel = document.createElement('span')
    valueLabel.className = 'gfx-settings__slider-value'
    valueLabel.textContent = `${def.defaultValue}${def.suffix ?? ''}`

    const step = Math.max(1, Math.round((def.max - def.min) / 100))

    const updateLabel = () => {
      valueLabel.textContent = `${slider.value}${def.suffix ?? ''}`
      def.onChange?.(Number(slider.value))
    }

    slider.addEventListener('input', updateLabel)
    prevBtn.addEventListener('click', () => {
      slider.value = String(Math.max(def.min, Number(slider.value) - step))
      updateLabel()
    })
    nextBtn.addEventListener('click', () => {
      slider.value = String(Math.min(def.max, Number(slider.value) + step))
      updateLabel()
    })

    wrap.appendChild(prevBtn)
    wrap.appendChild(slider)
    wrap.appendChild(nextBtn)
    wrap.appendChild(valueLabel)
    return wrap
  }

  private buildToggle(def: ToggleDef): HTMLElement {
    const label = document.createElement('label')
    label.className = 'gfx-settings__toggle'

    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = def.defaultOn

    const track = document.createElement('span')
    track.className = 'gfx-settings__toggle-track'

    label.appendChild(input)
    label.appendChild(track)
    return label
  }

  dispose(): void {
    this.root.remove()
  }
}
