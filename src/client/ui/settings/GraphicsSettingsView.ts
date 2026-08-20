import { clientSettings, FOV_MIN, FOV_MAX } from '../../../rendering/ClientSettings'
import {
  sunEnvironmentSettings,
  SUN_SLIDER_MAX,
  SUN_SLIDER_MIN,
  type SunEnvironmentSettingsState
} from '../../../rendering/SunEnvironmentSettings'
import {
  LANDSCAPE_DISTANCE_DEFAULT_M,
  LANDSCAPE_DISTANCE_MAX_M,
  LANDSCAPE_DISTANCE_MIN_M,
  MAX_SCENE_LIGHTS_CAP,
  RESOLUTION_SCALE_MAX,
  RESOLUTION_SCALE_MIN,
  SCENE_LOAD_RADIUS_DEFAULT_M,
  SCENE_LOAD_RADIUS_MAX_M,
  SCENE_LOAD_RADIUS_MIN_M,
  SHADOWS_DISTANCE_DEFAULT_M,
  SHADOWS_DISTANCE_MAX_M,
  SHADOWS_DISTANCE_MIN_M,
  renderQuality,
  type BloomModePreference,
  type FpsLimitOption,
  type GraphicsPreset,
  type MsaaSamples,
  type RenderQualityOptions,
  type ShadowQuality
} from '../../../rendering/RenderQualitySettings'

type DropdownDef = {
  type: 'dropdown'
  label: string
  options: string[]
  defaultIndex: number
  onChange?: (value: string) => void
  /** UI-only placeholder — not wired to runtime. */
  stub?: boolean
}

type SliderDef = {
  type: 'slider'
  label: string
  min: number
  max: number
  defaultValue: number
  suffix?: string
  onChange?: (value: number) => void
  stub?: boolean
}

type ToggleDef = {
  type: 'toggle'
  label: string
  defaultOn: boolean
  onChange?: (on: boolean) => void
  stub?: boolean
}

type SettingDef = DropdownDef | SliderDef | ToggleDef

type SectionDef = {
  title: string
  items: SettingDef[]
}

/** UI presets — Ultra bundle still exists in store but is not offered in Preferences. */
const PRESET_LABELS = ['Low', 'Medium', 'High', 'Custom'] as const
const SHADOW_LABELS = ['Off', 'Low', 'Medium', 'High', 'Ultra'] as const
const FPS_LABELS = ['30', '60', '120', 'Max'] as const
const MSAA_LABELS = ['Off', '2x', '4x', '8x'] as const
/** Bloom pipeline when Bloom toggle is on — A/B fast (1×) vs selective (2×). */
const BLOOM_MODE_LABELS = ['Auto', 'Fast', 'Selective'] as const

function bloomModeLabel(mode: BloomModePreference): string {
  if (mode === 'fast') return 'Fast'
  if (mode === 'selective') return 'Selective'
  return 'Auto'
}

function parseBloomModeLabel(v: string): BloomModePreference | null {
  const key = v.trim().toLowerCase()
  if (key === 'auto') return 'auto'
  if (key === 'fast') return 'fast'
  if (key === 'selective') return 'selective'
  return null
}

function presetLabel(preset: GraphicsPreset): string {
  // Ultra is not in the Preferences dropdown; surface as Custom.
  if (preset === 'ultra') return 'Custom'
  return preset.charAt(0).toUpperCase() + preset.slice(1)
}

function shadowLabel(q: ShadowQuality): string {
  return q.charAt(0).toUpperCase() + q.slice(1)
}

function fpsLabel(limit: FpsLimitOption): string {
  return limit === 0 ? 'Max' : String(limit)
}

function msaaLabel(samples: MsaaSamples): string {
  return samples === 0 ? 'Off' : `${samples}x`
}

function parseMsaaLabel(label: string): MsaaSamples | null {
  if (label === 'Off') return 0
  const m = /^(\d+)x$/i.exec(label.trim())
  if (!m) return null
  const n = Number(m[1])
  if (n === 2 || n === 4 || n === 8) return n
  return null
}

function indexOfLabel(options: readonly string[], label: string, fallback: number): number {
  const i = options.indexOf(label)
  return i >= 0 ? i : fallback
}

function buildSections(rq: RenderQualityOptions): SectionDef[] {
  return [
    {
      title: 'General',
      items: [
        {
          type: 'dropdown',
          label: 'Graphics Preset',
          options: [...PRESET_LABELS],
          defaultIndex: indexOfLabel(PRESET_LABELS, presetLabel(rq.preset), 1),
          onChange: (v) => {
            const key = v.toLowerCase()
            if (key === 'custom') return
            if (key === 'low' || key === 'medium' || key === 'high') {
              renderQuality.applyPreset(key)
            }
          }
        }
      ]
    },
    {
      title: 'Display',
      items: [
        {
          type: 'dropdown',
          label: 'Resolution',
          options: ['1920x1080', '2560x1440', '3014x1952', '3840x2160'],
          defaultIndex: 2,
          stub: true
        },
        {
          type: 'slider',
          label: 'Resolution Scale',
          min: RESOLUTION_SCALE_MIN,
          max: RESOLUTION_SCALE_MAX,
          defaultValue: rq.resolutionScale,
          suffix: '%',
          onChange: (v) => renderQuality.setResolutionScale(v)
        },
        {
          type: 'toggle',
          label: 'Auto quality (FPS)',
          defaultOn: rq.adaptiveQualityEnabled,
          onChange: (on) => renderQuality.setAdaptiveQualityEnabled(on)
        },
        {
          type: 'slider',
          label: 'Field of View',
          min: FOV_MIN,
          max: FOV_MAX,
          defaultValue: clientSettings.getFov(),
          suffix: '°',
          onChange: (v) => clientSettings.setFov(v)
        },
        { type: 'toggle', label: 'Fullscreen', defaultOn: false, stub: true },
        {
          type: 'dropdown',
          label: 'FPS Limit',
          options: [...FPS_LABELS],
          defaultIndex: indexOfLabel(FPS_LABELS, fpsLabel(rq.fpsLimit), 1),
          onChange: (v) => {
            if (v === 'Max') {
              renderQuality.setFpsLimit(0)
              return
            }
            const n = Number(v)
            if (n === 30 || n === 60 || n === 120) renderQuality.setFpsLimit(n)
          }
        }
        // VSync omitted: browsers always rAF-composite; toggle would not free-run or tear.
      ]
    },
    {
      title: 'Post Processing',
      items: [
        {
          type: 'dropdown',
          label: 'MSAA',
          options: [...MSAA_LABELS],
          defaultIndex: indexOfLabel(MSAA_LABELS, msaaLabel(rq.msaaSamples), 2),
          onChange: (v) => {
            const samples = parseMsaaLabel(v)
            if (samples !== null) renderQuality.setMsaaSamples(samples)
          }
        },
        {
          type: 'toggle',
          label: 'HDR',
          defaultOn: rq.hdrEnabled,
          onChange: (on) => renderQuality.setHdrEnabled(on)
        },
        {
          type: 'toggle',
          label: 'Bloom',
          defaultOn: rq.bloomEnabled,
          onChange: (on) => renderQuality.setBloomEnabled(on)
        },
        {
          type: 'dropdown',
          // Only used while Bloom is on. Auto = tier+mesh heuristic; Fast = 1× scene; Selective = 2×.
          label: 'Bloom mode',
          options: [...BLOOM_MODE_LABELS],
          defaultIndex: indexOfLabel(BLOOM_MODE_LABELS, bloomModeLabel(rq.bloomMode ?? 'fast'), 1),
          onChange: (v) => {
            const mode = parseBloomModeLabel(v)
            if (mode) renderQuality.setBloomMode(mode)
          }
        },
        { type: 'toggle', label: 'Avatar Outline', defaultOn: false, stub: true }
      ]
    },
    {
      title: 'Toon shaders',
      items: [
        {
          type: 'toggle',
          label: 'Avatar toon shading',
          defaultOn: rq.avatarToonEnabled,
          onChange: (on) => renderQuality.setAvatarToonEnabled(on)
        }
        // Room for future knobs: band thresholds, albedo mix, matte clamp, etc.
      ]
    },
    {
      title: 'Landscape and Foliage',
      items: [
        {
          type: 'slider',
          // Warm/visual ring: composites + roads + empty. Live workers stay 20 m enter (capped).
          label: 'Scene Distance',
          min: SCENE_LOAD_RADIUS_MIN_M,
          max: SCENE_LOAD_RADIUS_MAX_M,
          defaultValue: rq.sceneLoadRadiusM ?? SCENE_LOAD_RADIUS_DEFAULT_M,
          suffix: ' m',
          onChange: (v) => renderQuality.setSceneLoadRadiusM(v)
        },
        {
          type: 'slider',
          label: 'Landscape Distance',
          min: LANDSCAPE_DISTANCE_MIN_M,
          max: LANDSCAPE_DISTANCE_MAX_M,
          defaultValue: rq.landscapeDistanceM ?? LANDSCAPE_DISTANCE_DEFAULT_M,
          suffix: ' m',
          onChange: (v) => renderQuality.setLandscapeDistanceM(v)
        }
      ]
    },
    {
      title: 'Scene Lighting',
      items: [
        {
          type: 'toggle',
          label: 'Enable Scene Lights',
          defaultOn: rq.sceneLightsEnabled,
          onChange: (on) => renderQuality.setSceneLightsEnabled(on)
        },
        {
          type: 'slider',
          label: 'Max Lights in a Scene',
          min: 0,
          max: MAX_SCENE_LIGHTS_CAP,
          defaultValue: rq.maxSceneLights,
          onChange: (v) => renderQuality.setMaxSceneLights(v)
        }
      ]
    },
    {
      title: 'Shadows',
      items: [
        {
          type: 'dropdown',
          label: 'Quality',
          options: [...SHADOW_LABELS],
          defaultIndex: indexOfLabel(SHADOW_LABELS, shadowLabel(rq.shadowQuality), 3),
          onChange: (v) => {
            const key = v.toLowerCase() as ShadowQuality
            if (key === 'off' || key === 'low' || key === 'medium' || key === 'high' || key === 'ultra') {
              renderQuality.setShadowQuality(key)
            }
          }
        },
        {
          type: 'toggle',
          label: 'Avatar shadows',
          defaultOn: rq.avatarShadowsEnabled ?? true,
          onChange: (on) => renderQuality.setAvatarShadowsEnabled(on)
        },
        {
          type: 'toggle',
          label: 'Environment shadows',
          defaultOn: rq.environmentShadowsEnabled ?? true,
          onChange: (on) => renderQuality.setEnvironmentShadowsEnabled(on)
        },
        {
          type: 'slider',
          label: 'Shadows Distance',
          min: SHADOWS_DISTANCE_MIN_M,
          max: SHADOWS_DISTANCE_MAX_M,
          defaultValue: rq.shadowsDistanceM ?? SHADOWS_DISTANCE_DEFAULT_M,
          suffix: ' m',
          onChange: (v) => renderQuality.setShadowsDistanceM(v)
        }
      ]
    },
    {
      title: 'Other',
      items: [
        { type: 'toggle', label: 'Play current scene streams only', defaultOn: true, stub: true }
      ]
    },
    {
      title: 'Advanced',
      items: [
        {
          type: 'toggle',
          // On: every bound primary clip advances every frame (smooth plaza).
          // Off: distance sleep + fair sampling (cheaper CBD, can freeze mid-pose far/off-screen).
          label: 'Full-rate scene animators',
          defaultOn: rq.primaryFullRateAnimators ?? false,
          onChange: (on) => renderQuality.setPrimaryFullRateAnimators(on)
        }
      ]
    },
    {
      title: 'Physics',
      items: [
        { type: 'toggle', label: 'Jiggle Bones', defaultOn: false, stub: true }
      ]
    }
  ]
}

type BoundControl =
  | { kind: 'slider'; input: HTMLInputElement; label: HTMLSpanElement; suffix?: string; min: number; max: number; name: string }
  | { kind: 'toggle'; input: HTMLInputElement; name: string }
  | { kind: 'dropdown'; select: HTMLSelectElement; name: string }

export class GraphicsSettingsView {
  readonly root: HTMLElement
  private readonly boundControls: BoundControl[] = []
  private readonly unsubscribeSun?: () => void
  private readonly unsubscribeQuality?: () => void
  private syncing = false

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'gfx-settings'

    const scrollArea = document.createElement('div')
    scrollArea.className = 'gfx-settings__scroll'

    for (const section of buildSections(renderQuality.getOptions())) {
      scrollArea.appendChild(this.buildSection(section))
    }
    scrollArea.appendChild(this.buildLightingSection())

    this.root.appendChild(scrollArea)
    this.unsubscribeSun = sunEnvironmentSettings.subscribe((state) => this.syncSunControls(state))
    this.unsubscribeQuality = renderQuality.subscribe((opts) => this.syncQualityControls(opts))
  }

  private buildLightingSection(): HTMLElement {
    const lighting = sunEnvironmentSettings.get()
    const section: SectionDef = {
      title: 'Lighting',
      items: [
        {
          type: 'slider',
          label: 'Scene Sun Light',
          min: SUN_SLIDER_MIN,
          max: SUN_SLIDER_MAX,
          defaultValue: lighting.sceneSunLight,
          suffix: '%',
          onChange: (v) => sunEnvironmentSettings.set({ sceneSunLight: v })
        },
        {
          type: 'slider',
          label: 'Exposure',
          min: SUN_SLIDER_MIN,
          max: SUN_SLIDER_MAX,
          defaultValue: lighting.exposure,
          suffix: '%',
          onChange: (v) => sunEnvironmentSettings.set({ exposure: v })
        },
        {
          type: 'slider',
          label: 'Scene Moon Light',
          min: SUN_SLIDER_MIN,
          max: SUN_SLIDER_MAX,
          defaultValue: lighting.sceneMoonLight,
          suffix: '%',
          onChange: (v) => sunEnvironmentSettings.set({ sceneMoonLight: v })
        },
        {
          type: 'slider',
          label: 'Moon Exposure',
          min: SUN_SLIDER_MIN,
          max: SUN_SLIDER_MAX,
          defaultValue: lighting.moonExposure,
          suffix: '%',
          onChange: (v) => sunEnvironmentSettings.set({ moonExposure: v })
        }
      ]
    }
    const el = this.buildSection(section)

    const actions = document.createElement('div')
    actions.className = 'gfx-settings__actions'
    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'gfx-settings__reset-btn'
    resetBtn.textContent = 'Reset lighting'
    resetBtn.title = 'Restore Scene Sun Light, Exposure, Moon Light, and Moon Exposure to defaults'
    resetBtn.addEventListener('click', () => sunEnvironmentSettings.reset())
    actions.appendChild(resetBtn)
    el.appendChild(actions)

    return el
  }

  private syncSunControls(state: SunEnvironmentSettingsState): void {
    const values: Record<string, string> = {
      'Scene Sun Light': String(state.sceneSunLight),
      Exposure: String(state.exposure),
      'Scene Moon Light': String(state.sceneMoonLight),
      'Moon Exposure': String(state.moonExposure)
    }

    for (const control of this.boundControls) {
      if (control.kind !== 'slider') continue
      if (values[control.name] === undefined) continue
      control.input.value = values[control.name]!
      control.label.textContent = `${values[control.name]}${control.suffix ?? ''}`
      this.setSliderPct(control.input, control.min, control.max)
    }
  }

  private syncQualityControls(opts: RenderQualityOptions): void {
    this.syncing = true
    try {
      for (const control of this.boundControls) {
        switch (control.name) {
          case 'Graphics Preset':
            if (control.kind === 'dropdown') control.select.value = presetLabel(opts.preset)
            break
          case 'Resolution Scale':
            if (control.kind === 'slider') {
              control.input.value = String(opts.resolutionScale)
              control.label.textContent = `${opts.resolutionScale}${control.suffix ?? ''}`
              this.setSliderPct(control.input, control.min, control.max)
            }
            break
          case 'Auto quality (FPS)':
            if (control.kind === 'toggle') control.input.checked = opts.adaptiveQualityEnabled
            break
          case 'FPS Limit':
            if (control.kind === 'dropdown') control.select.value = fpsLabel(opts.fpsLimit)
            break
          case 'MSAA':
            if (control.kind === 'dropdown') control.select.value = msaaLabel(opts.msaaSamples)
            break
          case 'HDR':
            if (control.kind === 'toggle') control.input.checked = opts.hdrEnabled
            break
          case 'Bloom':
            if (control.kind === 'toggle') control.input.checked = opts.bloomEnabled
            break
          case 'Bloom mode':
            if (control.kind === 'dropdown') {
              control.select.value = bloomModeLabel(opts.bloomMode ?? 'fast')
            }
            break
          case 'Avatar toon shading':
            if (control.kind === 'toggle') control.input.checked = opts.avatarToonEnabled
            break
          case 'Enable Scene Lights':
            if (control.kind === 'toggle') control.input.checked = opts.sceneLightsEnabled
            break
          case 'Max Lights in a Scene':
            if (control.kind === 'slider') {
              control.input.value = String(opts.maxSceneLights)
              control.label.textContent = `${opts.maxSceneLights}${control.suffix ?? ''}`
              this.setSliderPct(control.input, control.min, control.max)
            }
            break
          case 'Quality':
            if (control.kind === 'dropdown') control.select.value = shadowLabel(opts.shadowQuality)
            break
          case 'Avatar shadows':
            if (control.kind === 'toggle') control.input.checked = opts.avatarShadowsEnabled ?? true
            break
          case 'Environment shadows':
            if (control.kind === 'toggle') {
              control.input.checked = opts.environmentShadowsEnabled ?? true
            }
            break
          case 'Scene Distance':
            if (control.kind === 'slider') {
              control.input.value = String(opts.sceneLoadRadiusM)
              control.label.textContent = `${opts.sceneLoadRadiusM}${control.suffix ?? ''}`
              this.setSliderPct(control.input, control.min, control.max)
            }
            break
          case 'Landscape Distance':
            if (control.kind === 'slider') {
              control.input.value = String(opts.landscapeDistanceM)
              control.label.textContent = `${opts.landscapeDistanceM}${control.suffix ?? ''}`
              this.setSliderPct(control.input, control.min, control.max)
            }
            break
          case 'Shadows Distance':
            if (control.kind === 'slider') {
              control.input.value = String(opts.shadowsDistanceM)
              control.label.textContent = `${opts.shadowsDistanceM}${control.suffix ?? ''}`
              this.setSliderPct(control.input, control.min, control.max)
            }
            break
          case 'Full-rate scene animators':
            if (control.kind === 'toggle') {
              control.input.checked = opts.primaryFullRateAnimators ?? false
            }
            break
        }
      }
    } finally {
      this.syncing = false
    }
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
    if (def.stub) {
      row.title = 'Not wired yet — UI placeholder'
      row.style.opacity = '0.55'
    }

    const label = document.createElement('span')
    label.className = 'gfx-settings__label'
    label.textContent = def.stub ? `${def.label} (soon)` : def.label
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
    if (def.stub) select.disabled = true
    for (let i = 0; i < def.options.length; i++) {
      const opt = document.createElement('option')
      opt.value = def.options[i]!
      opt.textContent = def.options[i]!
      if (i === def.defaultIndex) opt.selected = true
      select.appendChild(opt)
    }

    if (def.onChange && !def.stub) {
      select.addEventListener('change', () => {
        if (this.syncing) return
        def.onChange?.(select.value)
      })
    }

    // Custom is display-only when auto-inferred
    if (def.label === 'Graphics Preset') {
      const customOpt = select.querySelector('option[value="Custom"]') as HTMLOptionElement | null
      if (customOpt) customOpt.disabled = true
    }

    const chevron = document.createElement('span')
    chevron.className = 'gfx-settings__chevron'
    chevron.innerHTML = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`

    wrap.appendChild(select)
    wrap.appendChild(chevron)
    this.boundControls.push({ kind: 'dropdown', select, name: def.label })
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
    if (def.stub) prevBtn.disabled = true

    const nextBtn = document.createElement('button')
    nextBtn.type = 'button'
    nextBtn.className = 'gfx-settings__slider-btn'
    nextBtn.textContent = '›'
    nextBtn.setAttribute('aria-label', 'Increase')
    if (def.stub) nextBtn.disabled = true

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.className = 'gfx-settings__slider'
    slider.min = String(def.min)
    slider.max = String(def.max)
    slider.value = String(def.defaultValue)
    if (def.stub) slider.disabled = true

    const valueLabel = document.createElement('span')
    valueLabel.className = 'gfx-settings__slider-value'
    valueLabel.textContent = `${def.defaultValue}${def.suffix ?? ''}`

    const step = Math.max(1, Math.round((def.max - def.min) / 100))

    const updateLabel = () => {
      valueLabel.textContent = `${slider.value}${def.suffix ?? ''}`
      this.setSliderPct(slider, def.min, def.max)
      if (!this.syncing && !def.stub) def.onChange?.(Number(slider.value))
    }

    slider.addEventListener('input', updateLabel)
    prevBtn.addEventListener('click', () => {
      if (def.stub) return
      slider.value = String(Math.max(def.min, Number(slider.value) - step))
      updateLabel()
    })
    nextBtn.addEventListener('click', () => {
      if (def.stub) return
      slider.value = String(Math.min(def.max, Number(slider.value) + step))
      updateLabel()
    })

    wrap.appendChild(prevBtn)
    wrap.appendChild(slider)
    wrap.appendChild(nextBtn)
    wrap.appendChild(valueLabel)
    this.setSliderPct(slider, def.min, def.max)
    this.boundControls.push({
      kind: 'slider',
      input: slider,
      label: valueLabel,
      suffix: def.suffix,
      min: def.min,
      max: def.max,
      name: def.label
    })
    return wrap
  }

  private setSliderPct(slider: HTMLInputElement, min: number, max: number): void {
    const value = Number(slider.value)
    const span = max - min
    const pct = span <= 0 ? 0 : ((value - min) / span) * 100
    slider.style.setProperty('--pct', `${pct}%`)
  }

  private buildToggle(def: ToggleDef): HTMLElement {
    const label = document.createElement('label')
    label.className = 'gfx-settings__toggle'

    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = def.defaultOn
    if (def.stub) input.disabled = true

    const track = document.createElement('span')
    track.className = 'gfx-settings__toggle-track'

    input.addEventListener('change', () => {
      if (this.syncing || def.stub) return
      def.onChange?.(input.checked)
    })

    label.appendChild(input)
    label.appendChild(track)
    this.boundControls.push({ kind: 'toggle', input, name: def.label })
    return label
  }

  dispose(): void {
    this.unsubscribeSun?.()
    this.unsubscribeQuality?.()
    this.root.remove()
  }
}
