import {
  soundSettings,
  VOLUME_MIN,
  VOLUME_MAX,
  type SoundSettingsState
} from '../../../rendering/SoundSettings'
import { micDeviceService, type MicDeviceOption } from './MicDeviceService'

type SliderDef = {
  type: 'slider'
  label: string
  key: keyof Pick<
    SoundSettingsState,
    'masterVolume' | 'uiSfxVolume' | 'voiceChatVolume' | 'inWorldMusicSfxVolume' | 'avatarEmotesVolume'
  >
  hooked?: boolean
}

type ToggleDef = {
  type: 'toggle'
  label: string
  key: 'muteMicInBackground'
  hooked?: boolean
}

type SectionDef = {
  title: string
  items: Array<SliderDef | ToggleDef | { type: 'mic' }>
}

const SECTIONS: SectionDef[] = [
  {
    title: 'Volume',
    items: [
      { type: 'slider', label: 'Master Volume', key: 'masterVolume', hooked: true },
      { type: 'slider', label: 'UI SFX', key: 'uiSfxVolume' },
      { type: 'slider', label: 'Voice Chat & Streams', key: 'voiceChatVolume' },
      { type: 'slider', label: 'In World Music & SFX', key: 'inWorldMusicSfxVolume', hooked: true },
      { type: 'slider', label: 'Avatar & Emotes SFX', key: 'avatarEmotesVolume' }
    ]
  },
  {
    title: 'Microphone',
    items: [{ type: 'mic' }, { type: 'toggle', label: 'Mute Mic in Background', key: 'muteMicInBackground' }]
  }
]

type BoundSlider = {
  key: SliderDef['key']
  input: HTMLInputElement
  valueLabel: HTMLSpanElement
  min: number
  max: number
}

export class SoundsSettingsView {
  readonly root: HTMLElement
  private readonly boundSliders: BoundSlider[] = []
  private micSelect: HTMLSelectElement | null = null
  private muteMicToggle: HTMLInputElement | null = null
  private readonly unsubscribeSound?: () => void
  private readonly unsubscribeMics?: () => void

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'gfx-settings'

    const scrollArea = document.createElement('div')
    scrollArea.className = 'gfx-settings__scroll'

    for (const section of SECTIONS) {
      scrollArea.appendChild(this.buildSection(section))
    }

    this.root.appendChild(scrollArea)
    micDeviceService.bindDeviceChange()
    void this.bootstrapMics()
    this.unsubscribeSound = soundSettings.subscribe((state) => this.syncFromStore(state))
    this.unsubscribeMics = micDeviceService.subscribe((devices) => this.syncMicOptions(devices))
    this.syncFromStore(soundSettings.get())
  }

  private async bootstrapMics(): Promise<void> {
    await micDeviceService.refresh()
    const hasLabels = micDeviceService.getDevices().some((d) => d.label && !d.label.startsWith('Microphone '))
    if (!hasLabels) await micDeviceService.ensurePermission()
    await micDeviceService.refresh()
    this.syncMicSelection(soundSettings.get().microphoneDeviceId)
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
      if (item.type === 'mic') {
        grid.appendChild(this.buildMicRow())
        continue
      }
      grid.appendChild(this.buildItem(item))
    }

    el.appendChild(grid)
    return el
  }

  private buildItem(def: SliderDef | ToggleDef): HTMLElement {
    const row = document.createElement('div')
    row.className = 'gfx-settings__row'
    if (def.hooked !== true) row.classList.add('gfx-settings__row--pending')

    const label = document.createElement('span')
    label.className = 'gfx-settings__label'
    label.textContent = def.label
    row.appendChild(label)

    if (def.type === 'slider') {
      row.appendChild(this.buildSlider(def))
    } else {
      row.appendChild(this.buildToggle(def))
    }

    return row
  }

  private buildMicRow(): HTMLElement {
    const row = document.createElement('div')
    row.className = 'gfx-settings__row gfx-settings__row--pending'

    const label = document.createElement('span')
    label.className = 'gfx-settings__label'
    label.textContent = 'Microphone'
    row.appendChild(label)

    const wrap = document.createElement('div')
    wrap.className = 'gfx-settings__dropdown gfx-settings__dropdown--wide'

    const select = document.createElement('select')
    select.className = 'gfx-settings__select'
    select.setAttribute('aria-label', 'Microphone')
    select.addEventListener('change', () => {
      soundSettings.set({ microphoneDeviceId: select.value })
    })
    select.addEventListener('mousedown', () => {
      void micDeviceService.ensurePermission().then(() => micDeviceService.refresh())
    })

    const chevron = document.createElement('span')
    chevron.className = 'gfx-settings__chevron'
    chevron.innerHTML = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`

    wrap.appendChild(select)
    wrap.appendChild(chevron)
    row.appendChild(wrap)
    this.micSelect = select
    return row
  }

  private buildSlider(def: SliderDef): HTMLElement {
    const initial = soundSettings.get()[def.key]
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
    slider.min = String(VOLUME_MIN)
    slider.max = String(VOLUME_MAX)
    slider.value = String(initial)

    const valueLabel = document.createElement('span')
    valueLabel.className = 'gfx-settings__slider-value'
    valueLabel.textContent = `${initial}%`

    const step = 5

    const updateLabel = () => {
      const value = Number(slider.value)
      valueLabel.textContent = `${value}%`
      this.setSliderPct(slider, VOLUME_MIN, VOLUME_MAX)
      soundSettings.set({ [def.key]: value })
    }

    slider.addEventListener('input', updateLabel)
    prevBtn.addEventListener('click', () => {
      slider.value = String(Math.max(VOLUME_MIN, Number(slider.value) - step))
      updateLabel()
    })
    nextBtn.addEventListener('click', () => {
      slider.value = String(Math.min(VOLUME_MAX, Number(slider.value) + step))
      updateLabel()
    })

    wrap.appendChild(prevBtn)
    wrap.appendChild(slider)
    wrap.appendChild(nextBtn)
    wrap.appendChild(valueLabel)
    this.setSliderPct(slider, VOLUME_MIN, VOLUME_MAX)
    this.boundSliders.push({
      key: def.key,
      input: slider,
      valueLabel,
      min: VOLUME_MIN,
      max: VOLUME_MAX
    })
    return wrap
  }

  private buildToggle(def: ToggleDef): HTMLElement {
    const label = document.createElement('label')
    label.className = 'gfx-settings__toggle'

    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = soundSettings.get()[def.key]
    input.addEventListener('change', () => {
      soundSettings.set({ [def.key]: input.checked })
    })

    const track = document.createElement('span')
    track.className = 'gfx-settings__toggle-track'

    label.appendChild(input)
    label.appendChild(track)
    if (def.key === 'muteMicInBackground') this.muteMicToggle = input
    return label
  }

  private syncFromStore(state: SoundSettingsState): void {
    const sliderValues: Record<SliderDef['key'], string> = {
      masterVolume: String(state.masterVolume),
      uiSfxVolume: String(state.uiSfxVolume),
      voiceChatVolume: String(state.voiceChatVolume),
      inWorldMusicSfxVolume: String(state.inWorldMusicSfxVolume),
      avatarEmotesVolume: String(state.avatarEmotesVolume)
    }

    for (const control of this.boundSliders) {
      const value = sliderValues[control.key]
      control.input.value = value
      control.valueLabel.textContent = `${value}%`
      this.setSliderPct(control.input, control.min, control.max)
    }

    this.syncMicSelection(state.microphoneDeviceId)

    if (this.muteMicToggle) this.muteMicToggle.checked = state.muteMicInBackground
  }

  private syncMicOptions(devices: MicDeviceOption[]): void {
    const select = this.micSelect
    if (!select) return

    const previous = select.value
    select.innerHTML = ''

    for (const device of devices) {
      const opt = document.createElement('option')
      opt.value = device.deviceId
      opt.textContent = device.label
      select.appendChild(opt)
    }

    this.syncMicSelection(previous || soundSettings.get().microphoneDeviceId)
  }

  private syncMicSelection(deviceId: string): void {
    const select = this.micSelect
    if (!select) return
    const options = [...select.options]
    const match = options.find((o) => o.value === deviceId)
    if (match) {
      select.value = deviceId
      return
    }
    if (options[0]) select.value = options[0].value
  }

  private setSliderPct(slider: HTMLInputElement, min: number, max: number): void {
    const value = Number(slider.value)
    const span = max - min
    const pct = span <= 0 ? 0 : ((value - min) / span) * 100
    slider.style.setProperty('--pct', `${pct}%`)
  }

  dispose(): void {
    this.unsubscribeSound?.()
    this.unsubscribeMics?.()
    micDeviceService.unbindDeviceChange()
    this.root.remove()
  }
}