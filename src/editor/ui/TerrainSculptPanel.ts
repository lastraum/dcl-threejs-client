import type { TerrainSculptSession } from '../terrain/TerrainSculptSession'
import type {
  TerrainBrushMode,
  TerrainPaintLayer,
  TerrainProceduralShading,
  TerrainSplatChannel
} from '../terrain/terrainSculptConstants'
import {
  TERRAIN_BIOME_COLORS,
  TERRAIN_BRUSH_RADIUS_MAX_M,
  TERRAIN_BRUSH_RADIUS_MIN_M,
  TERRAIN_EXPORT_SEGMENT_PRESETS,
  TERRAIN_SPLAT_CHANNEL_LABELS,
  TERRAIN_SPLAT_PAINT_UI_ORDER
} from '../terrain/terrainSculptConstants'

export class TerrainSculptPanel {
  private host: HTMLDivElement
  private statusEl: HTMLDivElement
  private layerTabRow: HTMLDivElement
  private heightToolsHost: HTMLDivElement
  private splatToolsHost: HTMLDivElement
  private brushModeButtons = new Map<TerrainBrushMode, HTMLButtonElement>()
  private splatChannelButtons = new Map<TerrainSplatChannel, HTMLButtonElement>()
  private sandFromInput: HTMLInputElement | null = null
  private sandToInput: HTMLInputElement | null = null
  private sandBlendInput: HTMLInputElement | null = null
  private grassFromInput: HTMLInputElement | null = null
  private grassToInput: HTMLInputElement | null = null
  private grassBlendInput: HTMLInputElement | null = null
  private rockFromInput: HTMLInputElement | null = null
  private rockToInput: HTMLInputElement | null = null
  private rockBlendInput: HTMLInputElement | null = null
  private shoreSandCb: HTMLInputElement | null = null
  private maxHeightGuideCb: HTMLInputElement | null = null
  private brushRadiusSlider: HTMLInputElement | null = null
  private brushRadiusValue: HTMLSpanElement | null = null
  private brushStrengthSlider: HTMLInputElement | null = null
  private brushStrengthValue: HTMLSpanElement | null = null
  private exportSegmentsSelect: HTMLSelectElement | null = null
  private shadingLegendEl: HTMLDivElement | null = null
  private readonly shadingInputs = new Set<HTMLInputElement>()
  private unsub: (() => void) | null = null

  constructor(
    parent: HTMLElement,
    private session: TerrainSculptSession,
    private onStatus: (msg: string) => void,
    private refApi?: {
      onSave?: () => void | Promise<void>
      getProceduralShading?: () => TerrainProceduralShading
      setProceduralShading?: (patch: Partial<TerrainProceduralShading>) => void
      getMaxHeightGuideVisible?: () => boolean
      setMaxHeightGuideVisible?: (visible: boolean) => void
    }
  ) {
    this.host = document.createElement('div')
    this.host.className = 'editor-sculpt-panel'
    parent.appendChild(this.host)

    const title = document.createElement('div')
    title.textContent = 'Terrain sculpt'
    title.className = 'editor-sculpt-title'
    this.host.appendChild(title)

    const hint = document.createElement('div')
    hint.textContent =
      'WASD move · Q/E height · Shift sprint · right-drag orbit · scroll zoom · left-drag sculpt/paint · G max height · Cmd/Ctrl+Z undo'
    hint.className = 'editor-sculpt-hint'
    this.host.appendChild(hint)

    this.addViewportControls()
    this.addProceduralShadingControls()

    this.layerTabRow = document.createElement('div')
    this.layerTabRow.className = 'editor-sculpt-tabs'
    this.host.appendChild(this.layerTabRow)
    this.addLayerTabs()
    this.addSharedBrushSliders()

    this.heightToolsHost = document.createElement('div')
    this.heightToolsHost.className = 'editor-sculpt-tools'
    this.host.appendChild(this.heightToolsHost)
    this.addSculptModes()

    this.splatToolsHost = document.createElement('div')
    this.splatToolsHost.className = 'editor-sculpt-tools editor-sculpt-tools--hidden'
    this.host.appendChild(this.splatToolsHost)
    this.addSplatControls()

    this.addExportControls()
    this.addActionButtons()

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'editor-sculpt-status'
    this.host.appendChild(this.statusEl)

    this.unsub = session.subscribe(() => this.syncFromSession())
    this.syncFromSession()
  }

  dispose(): void {
    this.unsub?.()
    this.host.remove()
  }

  syncFromSession(): void {
    this.syncFromSessionInternal()
  }

  setMaxHeightGuideChecked(checked: boolean): void {
    if (this.maxHeightGuideCb) this.maxHeightGuideCb.checked = checked
  }

  private addViewportControls(): void {
    if (!this.refApi?.getMaxHeightGuideVisible || !this.refApi.setMaxHeightGuideVisible) return

    const wrap = document.createElement('div')
    wrap.className = 'editor-sculpt-viewport-box'

    const title = document.createElement('div')
    title.textContent = 'Viewport'
    title.className = 'editor-sculpt-shading-title'
    wrap.appendChild(title)

    const row = document.createElement('label')
    row.className = 'editor-sculpt-check'
    this.maxHeightGuideCb = document.createElement('input')
    this.maxHeightGuideCb.type = 'checkbox'
    this.maxHeightGuideCb.checked = this.refApi.getMaxHeightGuideVisible()
    this.maxHeightGuideCb.addEventListener('change', () => {
      this.refApi!.setMaxHeightGuideVisible!(this.maxHeightGuideCb!.checked)
    })
    row.appendChild(this.maxHeightGuideCb)
    row.append(' Max height guide (axis → peak) — G')
    wrap.appendChild(row)
    this.host.appendChild(wrap)
  }

  private addProceduralShadingControls(): void {
    if (!this.refApi?.getProceduralShading || !this.refApi.setProceduralShading) return

    const wrap = document.createElement('div')
    wrap.className = 'editor-sculpt-shading-box'

    const title = document.createElement('div')
    title.textContent = 'Height shading (preview)'
    title.className = 'editor-sculpt-shading-title'
    wrap.appendChild(title)

    const note = document.createElement('div')
    note.textContent =
      'Procedural sand/grass/rock where splat paint is empty. Set Y from/to bands (m) and blend width per biome. Water line Y=5 m.'
    note.className = 'editor-sculpt-shading-note'
    wrap.appendChild(note)

    const legend = document.createElement('div')
    legend.className = 'editor-sculpt-shading-legend'
    this.shadingLegendEl = legend
    wrap.appendChild(legend)

    const shoreRow = document.createElement('label')
    shoreRow.className = 'editor-sculpt-check'
    this.shoreSandCb = document.createElement('input')
    this.shoreSandCb.type = 'checkbox'
    this.shoreSandCb.checked = this.refApi.getProceduralShading().sandEnabled
    this.shoreSandCb.addEventListener('change', () => {
      this.refApi!.setProceduralShading!({ sandEnabled: this.shoreSandCb!.checked })
      this.updateShadingLegendText()
    })
    shoreRow.appendChild(this.shoreSandCb)
    shoreRow.append(' Shore sand strip')
    wrap.appendChild(shoreRow)

    const shading = this.refApi.getProceduralShading()
    wrap.appendChild(
      this.biomeShadingSection('Sand (Y m)', TERRAIN_BIOME_COLORS.sand, {
        from: { value: shading.sandFromY, min: -2, max: 40, step: 0.1, key: 'sandFromY' },
        to: { value: shading.sandToY, min: -2, max: 40, step: 0.1, key: 'sandToY' },
        blend: { value: shading.sandBlendM, min: 0.1, max: 12, step: 0.05, key: 'sandBlendM', unit: 'm' }
      })
    )
    wrap.appendChild(
      this.biomeShadingSection('Grass (Y m)', TERRAIN_BIOME_COLORS.grass, {
        from: { value: shading.grassFromY, min: -2, max: 120, step: 0.1, key: 'grassFromY' },
        to: { value: shading.grassToY, min: 0, max: 120, step: 0.5, key: 'grassToY' },
        blend: { value: shading.grassBlendM, min: 0.1, max: 16, step: 0.05, key: 'grassBlendM', unit: 'm' }
      })
    )
    wrap.appendChild(
      this.biomeShadingSection('Rock (slope)', TERRAIN_BIOME_COLORS.rock, {
        from: { value: shading.rockSlopeFrom, min: 0, max: 1, step: 0.01, key: 'rockSlopeFrom' },
        to: { value: shading.rockSlopeTo, min: 0, max: 1, step: 0.01, key: 'rockSlopeTo' },
        blend: { value: shading.rockBlend, min: 0.02, max: 0.45, step: 0.01, key: 'rockBlend', unit: 'slope' }
      })
    )

    this.host.appendChild(wrap)
    this.syncShadingLegend()
  }

  private updateShadingLegendText(): void {
    if (!this.shadingLegendEl || !this.refApi?.getProceduralShading) return
    const s = this.refApi.getProceduralShading()
    this.shadingLegendEl.innerHTML = `
      <span class="editor-sculpt-legend-chip" style="background:#${TERRAIN_BIOME_COLORS.sand.toString(16).padStart(6, '0')}">Sand</span>
      <span>Y ${s.sandFromY.toFixed(1)}–${s.sandToY.toFixed(1)} ±${s.sandBlendM.toFixed(1)}m</span>
      <span class="editor-sculpt-legend-chip" style="background:#${TERRAIN_BIOME_COLORS.grass.toString(16).padStart(6, '0')}">Grass</span>
      <span>Y ${s.grassFromY.toFixed(1)}–${s.grassToY.toFixed(1)} ±${s.grassBlendM.toFixed(1)}m</span>
      <span class="editor-sculpt-legend-chip" style="background:#${TERRAIN_BIOME_COLORS.rock.toString(16).padStart(6, '0')}">Rock</span>
      <span>${s.rockSlopeFrom.toFixed(2)}–${s.rockSlopeTo.toFixed(2)} ±${s.rockBlend.toFixed(2)}</span>
    `
  }

  private syncShadingInput(input: HTMLInputElement | null, value: number): void {
    if (!input || this.shadingInputs.has(input)) return
    input.value = String(value)
  }

  private syncShadingLegend(): void {
    if (!this.refApi?.getProceduralShading) return
    const s = this.refApi.getProceduralShading()
    this.updateShadingLegendText()
    this.syncShadingInput(this.sandFromInput, s.sandFromY)
    this.syncShadingInput(this.sandToInput, s.sandToY)
    if (this.sandBlendInput) this.sandBlendInput.value = String(s.sandBlendM)
    this.syncShadingInput(this.grassFromInput, s.grassFromY)
    this.syncShadingInput(this.grassToInput, s.grassToY)
    if (this.grassBlendInput) this.grassBlendInput.value = String(s.grassBlendM)
    this.syncShadingInput(this.rockFromInput, s.rockSlopeFrom)
    this.syncShadingInput(this.rockToInput, s.rockSlopeTo)
    if (this.rockBlendInput) this.rockBlendInput.value = String(s.rockBlend)
    if (this.shoreSandCb) this.shoreSandCb.checked = s.sandEnabled
  }

  private biomeShadingSection(
    title: string,
    color: number,
    fields: {
      from: { value: number; min: number; max: number; step: number; key: keyof TerrainProceduralShading }
      to: { value: number; min: number; max: number; step: number; key: keyof TerrainProceduralShading }
      blend: {
        value: number
        min: number
        max: number
        step: number
        key: keyof TerrainProceduralShading
        unit: 'm' | 'slope'
      }
    }
  ): HTMLDivElement {
    const section = document.createElement('div')
    section.className = 'editor-sculpt-shading-biome'

    const head = document.createElement('div')
    head.className = 'editor-sculpt-shading-biome-title'
    const chip = document.createElement('span')
    chip.className = 'editor-sculpt-legend-chip'
    chip.style.background = `#${color.toString(16).padStart(6, '0')}`
    chip.textContent = title.split(' ')[0]!
    head.appendChild(chip)
    head.append(title)
    section.appendChild(head)

    const fromRow = this.shadingFromToRow('From', fields.from, (v) => {
      this.refApi!.setProceduralShading!({ [fields.from.key]: v })
      this.updateShadingLegendText()
    })
    const toRow = this.shadingFromToRow('To', fields.to, (v) => {
      this.refApi!.setProceduralShading!({ [fields.to.key]: v })
      this.updateShadingLegendText()
    })
    section.appendChild(fromRow.row)
    section.appendChild(toRow.row)

    if (fields.from.key === 'sandFromY') this.sandFromInput = fromRow.input
    if (fields.from.key === 'grassFromY') this.grassFromInput = fromRow.input
    if (fields.from.key === 'rockSlopeFrom') this.rockFromInput = fromRow.input
    if (fields.to.key === 'sandToY') this.sandToInput = toRow.input
    if (fields.to.key === 'grassToY') this.grassToInput = toRow.input
    if (fields.to.key === 'rockSlopeTo') this.rockToInput = toRow.input

    const blendLabel =
      fields.blend.unit === 'm' ? 'Blend width (m)' : 'Blend width (slope)'
    const blendRow = this.sliderRow(
      blendLabel,
      fields.blend.min,
      fields.blend.max,
      fields.blend.value,
      (v) => {
        this.refApi!.setProceduralShading!({ [fields.blend.key]: v })
        this.updateShadingLegendText()
      },
      fields.blend.step
    )
    const blendInput = blendRow.querySelector('input') as HTMLInputElement
    if (fields.blend.key === 'sandBlendM') this.sandBlendInput = blendInput
    if (fields.blend.key === 'grassBlendM') this.grassBlendInput = blendInput
    if (fields.blend.key === 'rockBlend') this.rockBlendInput = blendInput
    section.appendChild(blendRow)

    return section
  }

  private shadingFromToRow(
    label: string,
    field: { value: number; min: number; max: number; step: number },
    onChange: (v: number) => void
  ): { row: HTMLDivElement; input: HTMLInputElement } {
    const row = document.createElement('div')
    row.className = 'editor-sculpt-shading-row'
    const lbl = document.createElement('label')
    lbl.textContent = label
    const input = document.createElement('input')
    input.type = 'text'
    input.inputMode = 'decimal'
    input.autocomplete = 'off'
    input.className = 'editor-sculpt-shading-number'
    input.value = String(field.value)
    input.addEventListener('focus', () => this.shadingInputs.add(input))
    input.addEventListener('blur', () => {
      this.shadingInputs.delete(input)
      const v = Number(input.value.trim())
      if (!Number.isFinite(v)) {
        input.value = String(field.value)
        return
      }
      const clamped = Math.max(field.min, Math.min(field.max, v))
      input.value = String(clamped)
      onChange(clamped)
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur()
    })
    lbl.appendChild(input)
    row.appendChild(lbl)
    return { row, input }
  }

  private addLayerTabs(): void {
    const layers: { id: TerrainPaintLayer; label: string }[] = [
      { id: 'height', label: 'Sculpt' },
      { id: 'splat', label: 'Paint' }
    ]
    for (const layer of layers) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = layer.label
      btn.className = 'editor-sculpt-tab'
      btn.dataset.layer = layer.id
      btn.addEventListener('click', () => {
        this.session.patchSettings({ paintLayer: layer.id })
        this.onStatus(layer.id === 'height' ? 'Sculpt height' : 'Paint splat materials')
      })
      this.layerTabRow.appendChild(btn)
    }
  }

  private addSculptModes(): void {
    const wrap = document.createElement('div')
    wrap.className = 'editor-sculpt-row'
    const modes: { id: TerrainBrushMode; label: string }[] = [
      { id: 'raise', label: 'Raise' },
      { id: 'lower', label: 'Lower' },
      { id: 'smooth', label: 'Smooth' },
      { id: 'flatten', label: 'Flatten' },
      { id: 'towater', label: 'To water' }
    ]
    for (const mode of modes) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = mode.label
      btn.className = 'editor-sculpt-btn'
      btn.addEventListener('click', () => {
        this.session.patchSettings({ paintLayer: 'height', brushMode: mode.id })
        this.onStatus(`Sculpt: ${mode.label}`)
      })
      this.brushModeButtons.set(mode.id, btn)
      wrap.appendChild(btn)
    }
    this.heightToolsHost.appendChild(wrap)
  }

  private addSharedBrushSliders(): void {
    const settings = this.session.getSettings()
    const radiusRow = this.sliderRow(
      'Radius (m)',
      TERRAIN_BRUSH_RADIUS_MIN_M,
      TERRAIN_BRUSH_RADIUS_MAX_M,
      settings.brushSizeM,
      (v) => {
        this.session.patchSettings({ brushSizeM: v })
        this.session.refreshBrushRing()
      }
    )
    this.brushRadiusSlider = radiusRow.querySelector('input') as HTMLInputElement
    this.brushRadiusValue = radiusRow.querySelector('span') as HTMLSpanElement
    this.host.appendChild(radiusRow)

    const strengthRow = this.sliderRow('Strength', 0.05, 1, settings.brushStrength, (v) => {
      this.session.patchSettings({ brushStrength: v })
    })
    this.brushStrengthSlider = strengthRow.querySelector('input') as HTMLInputElement
    this.brushStrengthValue = strengthRow.querySelector('span') as HTMLSpanElement
    this.host.appendChild(strengthRow)
  }

  private channelColor(ch: TerrainSplatChannel): number {
    switch (ch) {
      case 0:
        return TERRAIN_BIOME_COLORS.grass
      case 1:
        return TERRAIN_BIOME_COLORS.dirt
      case 2:
        return TERRAIN_BIOME_COLORS.rock
      case 3:
        return TERRAIN_BIOME_COLORS.sand
      case 4:
        return TERRAIN_BIOME_COLORS.lava
      default:
        return TERRAIN_BIOME_COLORS.grass
    }
  }

  private addSplatControls(): void {
    const row = document.createElement('div')
    row.className = 'editor-sculpt-swatch-row'
    for (const ch of TERRAIN_SPLAT_PAINT_UI_ORDER) {
      const label = TERRAIN_SPLAT_CHANNEL_LABELS[ch]!
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.title = label
      btn.className = 'editor-sculpt-swatch'
      btn.style.background = `#${this.channelColor(ch).toString(16).padStart(6, '0')}`
      btn.addEventListener('click', () => {
        this.session.patchSettings({ paintLayer: 'splat', splatChannel: ch })
        this.onStatus(`Paint: ${label}`)
      })
      this.splatChannelButtons.set(ch, btn)
      row.appendChild(btn)
    }

    const erase = document.createElement('label')
    erase.className = 'editor-sculpt-check'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.addEventListener('change', () => this.session.patchSettings({ splatErase: cb.checked }))
    erase.appendChild(cb)
    erase.append(' Erase')
    row.appendChild(erase)
    this.splatToolsHost.appendChild(row)
  }

  private sliderRow(
    label: string,
    min: number,
    max: number,
    initial: number,
    onChange: (v: number) => void,
    step = (max - min) / 100
  ): HTMLDivElement {
    const row = document.createElement('div')
    row.className = 'editor-sculpt-slider'
    const lbl = document.createElement('label')
    lbl.textContent = label
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    input.value = String(initial)
    const val = document.createElement('span')
    val.textContent = initial.toFixed(step < 0.1 ? 2 : 1)
    input.addEventListener('input', () => {
      const v = Number(input.value)
      val.textContent = v.toFixed(step < 0.1 ? 2 : 1)
      onChange(v)
    })
    row.appendChild(lbl)
    row.appendChild(input)
    row.appendChild(val)
    return row
  }

  private addExportControls(): void {
    const wrap = document.createElement('div')
    wrap.className = 'editor-sculpt-shading-box'

    const title = document.createElement('div')
    title.textContent = 'Deploy export'
    title.className = 'editor-sculpt-shading-title'
    wrap.appendChild(title)

    const note = document.createElement('div')
    note.className = 'editor-sculpt-shading-note'
    note.textContent =
      'terrain.glb mesh density per parcel. Lower = smaller deploy; sculpt preview stays full resolution.'
    wrap.appendChild(note)

    const row = document.createElement('div')
    row.className = 'editor-sculpt-shading-row'
    const label = document.createElement('label')
    label.textContent = 'Segments / parcel'
    const select = document.createElement('select')
    select.className = 'editor-sculpt-select'
    for (const segs of TERRAIN_EXPORT_SEGMENT_PRESETS) {
      const opt = document.createElement('option')
      opt.value = String(segs)
      const spacingCm = Math.round((16 / segs) * 100)
      opt.textContent = `${segs} (~${spacingCm} cm / vertex)`
      select.appendChild(opt)
    }
    select.addEventListener('change', () => {
      const segs = Number(select.value)
      this.session.patchExportSettings({ exportSegmentsPerParcel: segs })
      this.onStatus(`Export: ${segs} segments per parcel`)
    })
    this.exportSegmentsSelect = select
    row.appendChild(label)
    row.appendChild(select)
    wrap.appendChild(row)
    this.host.appendChild(wrap)
  }

  private addActionButtons(): void {
    const row = document.createElement('div')
    row.className = 'editor-sculpt-row'
    const undo = document.createElement('button')
    undo.type = 'button'
    undo.textContent = 'Undo'
    undo.className = 'editor-sculpt-btn'
    undo.addEventListener('click', () => this.session.undo())
    const redo = document.createElement('button')
    redo.type = 'button'
    redo.textContent = 'Redo'
    redo.className = 'editor-sculpt-btn'
    redo.addEventListener('click', () => this.session.redo())
    const save = document.createElement('button')
    save.type = 'button'
    save.textContent = 'Save to project'
    save.className = 'editor-sculpt-btn editor-sculpt-btn--primary'
    save.addEventListener('click', () => void this.refApi?.onSave?.())
    row.appendChild(undo)
    row.appendChild(redo)
    row.appendChild(save)
    this.host.appendChild(row)
  }

  private syncFromSessionInternal(): void {
    const s = this.session.getSettings()
    if (this.brushRadiusSlider && this.brushRadiusValue) {
      this.brushRadiusSlider.value = String(s.brushSizeM)
      this.brushRadiusValue.textContent = s.brushSizeM.toFixed(1)
    }
    if (this.brushStrengthSlider && this.brushStrengthValue) {
      this.brushStrengthSlider.value = String(s.brushStrength)
      this.brushStrengthValue.textContent = s.brushStrength.toFixed(2)
    }
    if (this.exportSegmentsSelect) {
      this.exportSegmentsSelect.value = String(this.session.getExportSettings().exportSegmentsPerParcel)
    }
    this.session.refreshBrushRing()
    this.paintActiveTab(s.paintLayer)
    this.heightToolsHost.classList.toggle('editor-sculpt-tools--hidden', s.paintLayer !== 'height')
    this.splatToolsHost.classList.toggle('editor-sculpt-tools--hidden', s.paintLayer !== 'splat')

    for (const [mode, btn] of this.brushModeButtons) {
      this.paintBtnActive(btn, s.paintLayer === 'height' && s.brushMode === mode)
    }

    for (const ch of TERRAIN_SPLAT_PAINT_UI_ORDER) {
      const btn = this.splatChannelButtons.get(ch)
      if (!btn) continue
      const on = s.paintLayer === 'splat' && s.splatChannel === ch
      btn.classList.toggle('editor-sculpt-swatch--active', on)
    }

    this.statusEl.textContent =
      s.paintLayer === 'height'
        ? `Sculpt — ${s.brushMode}`
        : `Paint — ${TERRAIN_SPLAT_CHANNEL_LABELS[s.splatChannel]}`
  }

  private paintActiveTab(active: TerrainPaintLayer): void {
    for (const btn of this.layerTabRow.querySelectorAll('button')) {
      const el = btn as HTMLButtonElement
      this.paintBtnActive(el, el.dataset.layer === active)
    }
  }

  private paintBtnActive(btn: HTMLButtonElement, on: boolean): void {
    btn.classList.toggle('editor-sculpt-btn--active', on)
    btn.classList.toggle('editor-sculpt-tab--active', on)
  }

  setStatus(msg: string): void {
    this.statusEl.textContent = msg
    this.onStatus(msg)
  }
}