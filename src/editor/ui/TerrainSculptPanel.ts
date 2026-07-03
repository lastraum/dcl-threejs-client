import type { TerrainSculptSession } from '../terrain/TerrainSculptSession'
import type {
  TerrainBrushMode,
  TerrainPaintLayer,
  TerrainProceduralShading,
  TerrainSplatChannel
} from '../terrain/terrainSculptConstants'
import {
  EDITOR_AVATAR_SCALE_MAX_PER_PARCEL,
  EDITOR_AVATAR_SCALE_MIN_PER_PARCEL,
  formatAvatarScaleCountLabel,
  type AvatarScalePlacementPlan
} from '../EditorAvatarScaleGuides'
import {
  TERRAIN_BIOME_COLORS,
  TERRAIN_BRUSH_RADIUS_MAX_M,
  TERRAIN_BRUSH_RADIUS_MIN_M,
  TERRAIN_EXPORT_SEGMENT_PRESETS,
  TERRAIN_SPLAT_CHANNEL_LABELS,
  TERRAIN_SPLAT_PAINT_UI_ORDER,
  terrainColorFromHex,
  terrainColorToHex
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
  private waterColorInput: HTMLInputElement | null = null
  private waterFromInput: HTMLInputElement | null = null
  private waterToInput: HTMLInputElement | null = null
  private waterBlendInput: HTMLInputElement | null = null
  private sandColorInput: HTMLInputElement | null = null
  private grassColorInput: HTMLInputElement | null = null
  private rockColorInput: HTMLInputElement | null = null
  private maxHeightGuideCb: HTMLInputElement | null = null
  private gridCb: HTMLInputElement | null = null
  private avatarScaleGuidesCb: HTMLInputElement | null = null
  private avatarScaleCountSlider: HTMLInputElement | null = null
  private avatarScaleCountValue: HTMLSpanElement | null = null
  private avatarScaleCapNote: HTMLDivElement | null = null
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
      getAvatarScaleGuidesVisible?: () => boolean
      setAvatarScaleGuidesVisible?: (visible: boolean) => void
      getGridVisible?: () => boolean
      setGridVisible?: (visible: boolean) => void
      getAvatarScaleGuidesCount?: () => number
      getAvatarScaleGuidesPlan?: () => AvatarScalePlacementPlan | undefined
      setAvatarScaleGuidesCount?: (count: number) => void
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
      'WASD move · Space up · Shift down · Q/E rotate · Alt sprint · right-drag orbit · scroll zoom · left-drag sculpt/paint · G max height · B avatar scale · Cmd/Ctrl+Z undo'
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

  setAvatarScaleGuidesChecked(checked: boolean): void {
    if (this.avatarScaleGuidesCb) this.avatarScaleGuidesCb.checked = checked
  }

  setAvatarScaleGuidesCount(count: number, plan?: AvatarScalePlacementPlan): void {
    if (this.avatarScaleCountSlider) {
      this.avatarScaleCountSlider.value = String(count)
    }
    if (this.avatarScaleCountValue) {
      this.avatarScaleCountValue.textContent = formatAvatarScaleCountLabel(count, plan)
    }
  }

  setGridChecked(checked: boolean): void {
    if (this.gridCb) this.gridCb.checked = checked
  }

  setAvatarScaleCapNote(capped: boolean): void {
    if (this.avatarScaleCapNote) {
      this.avatarScaleCapNote.hidden = !capped
    }
  }

  private addViewportControls(): void {
    const hasMaxHeight =
      this.refApi?.getMaxHeightGuideVisible && this.refApi.setMaxHeightGuideVisible
    const hasGrid = this.refApi?.getGridVisible && this.refApi.setGridVisible
    const hasAvatarScale =
      this.refApi?.getAvatarScaleGuidesVisible && this.refApi.setAvatarScaleGuidesVisible
    if (!hasMaxHeight && !hasGrid && !hasAvatarScale) return

    const wrap = document.createElement('div')
    wrap.className = 'editor-sculpt-viewport-box'

    const title = document.createElement('div')
    title.textContent = 'Viewport'
    title.className = 'editor-sculpt-shading-title'
    wrap.appendChild(title)

    if (hasMaxHeight) {
      const row = document.createElement('label')
      row.className = 'editor-sculpt-check'
      this.maxHeightGuideCb = document.createElement('input')
      this.maxHeightGuideCb.type = 'checkbox'
      this.maxHeightGuideCb.checked = this.refApi!.getMaxHeightGuideVisible!()
      this.maxHeightGuideCb.addEventListener('change', () => {
        this.refApi!.setMaxHeightGuideVisible!(this.maxHeightGuideCb!.checked)
      })
      row.appendChild(this.maxHeightGuideCb)
      row.append(' Max height guide (axis → peak) — G')
      wrap.appendChild(row)
    }

    if (hasGrid) {
      const row = document.createElement('label')
      row.className = 'editor-sculpt-check'
      this.gridCb = document.createElement('input')
      this.gridCb.type = 'checkbox'
      this.gridCb.checked = this.refApi!.getGridVisible!()
      this.gridCb.addEventListener('change', () => {
        this.refApi!.setGridVisible!(this.gridCb!.checked)
      })
      row.appendChild(this.gridCb)
      row.append(' Parcel grid (1 m)')
      wrap.appendChild(row)
    }

    if (hasAvatarScale) {
      const row = document.createElement('label')
      row.className = 'editor-sculpt-check'
      this.avatarScaleGuidesCb = document.createElement('input')
      this.avatarScaleGuidesCb.type = 'checkbox'
      this.avatarScaleGuidesCb.checked = this.refApi!.getAvatarScaleGuidesVisible!()
      this.avatarScaleGuidesCb.addEventListener('change', () => {
        this.refApi!.setAvatarScaleGuidesVisible!(this.avatarScaleGuidesCb!.checked)
      })
      row.appendChild(this.avatarScaleGuidesCb)
      row.append(' BaseMale mannequins — B')
      wrap.appendChild(row)

      const initialCount = this.refApi!.getAvatarScaleGuidesCount?.() ?? 16
      const countRow = this.sliderRow(
        'Mannequins per parcel',
        EDITOR_AVATAR_SCALE_MIN_PER_PARCEL,
        EDITOR_AVATAR_SCALE_MAX_PER_PARCEL,
        initialCount,
        (v) => {
          this.refApi!.setAvatarScaleGuidesCount?.(Math.round(v))
        },
        1,
        formatAvatarScaleCountLabel
      )
      this.avatarScaleCountSlider = countRow.querySelector('input') as HTMLInputElement
      this.avatarScaleCountValue = countRow.querySelector('span') as HTMLSpanElement
      if (this.avatarScaleCountValue) {
        this.avatarScaleCountValue.textContent = formatAvatarScaleCountLabel(
          initialCount,
          this.refApi!.getAvatarScaleGuidesPlan?.()
        )
      }
      wrap.appendChild(countRow)

      this.avatarScaleCapNote = document.createElement('div')
      this.avatarScaleCapNote.className = 'editor-sculpt-hint'
      this.avatarScaleCapNote.hidden = true
      this.avatarScaleCapNote.textContent =
        'Large scene: mannequin count capped for performance (max 8k instances).'
      wrap.appendChild(this.avatarScaleCapNote)
    }

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
      'Procedural biomes use height Y (m). Water To = surface for shading + “to water” sculpt. Splat paint overrides empty areas.'
    note.className = 'editor-sculpt-shading-note'
    wrap.appendChild(note)

    const legend = document.createElement('div')
    legend.className = 'editor-sculpt-shading-legend'
    this.shadingLegendEl = legend
    wrap.appendChild(legend)

    const shading = this.refApi.getProceduralShading()
    wrap.appendChild(
      this.biomeShadingSection('Water', 'waterColor', shading.waterColor, {
        from: { value: shading.waterFromY, min: -2, max: 40, step: 0.1, key: 'waterFromY' },
        to: { value: shading.waterToY, min: -2, max: 40, step: 0.1, key: 'waterToY' },
        blend: { value: shading.waterBlendM, min: 0.1, max: 12, step: 0.05, key: 'waterBlendM', unit: 'm' }
      })
    )

    wrap.appendChild(
      this.biomeShadingSection('Sand', 'sandColor', shading.sandColor, {
        from: { value: shading.sandFromY, min: -2, max: 40, step: 0.1, key: 'sandFromY' },
        to: { value: shading.sandToY, min: -2, max: 40, step: 0.1, key: 'sandToY' },
        blend: { value: shading.sandBlendM, min: 0.1, max: 12, step: 0.05, key: 'sandBlendM', unit: 'm' }
      })
    )
    wrap.appendChild(
      this.biomeShadingSection('Grass', 'grassColor', shading.grassColor, {
        from: { value: shading.grassFromY, min: -2, max: 120, step: 0.1, key: 'grassFromY' },
        to: { value: shading.grassToY, min: 0, max: 120, step: 0.5, key: 'grassToY' },
        blend: { value: shading.grassBlendM, min: 0.1, max: 16, step: 0.05, key: 'grassBlendM', unit: 'm' }
      })
    )
    wrap.appendChild(
      this.biomeShadingSection('Rock', 'rockColor', shading.rockColor, {
        from: { value: shading.rockFromY, min: 0, max: 120, step: 0.5, key: 'rockFromY' },
        to: { value: shading.rockToY, min: 0, max: 120, step: 0.5, key: 'rockToY' },
        blend: { value: shading.rockBlendM, min: 0.1, max: 16, step: 0.05, key: 'rockBlendM', unit: 'm' }
      })
    )

    this.host.appendChild(wrap)
    this.syncShadingLegend()
  }

  private updateShadingLegendText(): void {
    if (!this.shadingLegendEl || !this.refApi?.getProceduralShading) return
    const s = this.refApi.getProceduralShading()
    this.shadingLegendEl.innerHTML = `
      <span class="editor-sculpt-legend-chip" style="background:${terrainColorToHex(s.waterColor)}">Water</span>
      <span>Y ${s.waterFromY.toFixed(1)}–${s.waterToY.toFixed(1)} ±${s.waterBlendM.toFixed(1)}m</span>
      <span class="editor-sculpt-legend-chip" style="background:${terrainColorToHex(s.sandColor)}">Sand</span>
      <span>Y ${s.sandFromY.toFixed(1)}–${s.sandToY.toFixed(1)} ±${s.sandBlendM.toFixed(1)}m</span>
      <span class="editor-sculpt-legend-chip" style="background:${terrainColorToHex(s.grassColor)}">Grass</span>
      <span>Y ${s.grassFromY.toFixed(1)}–${s.grassToY.toFixed(1)} ±${s.grassBlendM.toFixed(1)}m</span>
      <span class="editor-sculpt-legend-chip" style="background:${terrainColorToHex(s.rockColor)}">Rock</span>
      <span>Y ${s.rockFromY.toFixed(1)}–${s.rockToY.toFixed(1)} ±${s.rockBlendM.toFixed(1)}m</span>
    `
  }

  private formatShadingNumber(value: number, step: number): string {
    if (step >= 1) return String(Math.round(value))
    if (step >= 0.1) return value.toFixed(1)
    return value.toFixed(2)
  }

  private shadingInputStep(input: HTMLInputElement | null): number {
    if (!input) return 0.1
    const step = Number(input.dataset.step)
    return Number.isFinite(step) && step > 0 ? step : 0.1
  }

  private shadingInputUiScale(input: HTMLInputElement | null): number {
    if (!input) return 1
    const scale = Number(input.dataset.uiScale)
    return Number.isFinite(scale) && scale > 0 ? scale : 1
  }

  private getShadingFieldValue(key: keyof TerrainProceduralShading): number {
    const shading = this.refApi?.getProceduralShading?.()
    if (!shading) return 0
    return shading[key] as number
  }

  private parseShadingNumber(
    raw: string,
    field: { min: number; max: number; step: number; key: keyof TerrainProceduralShading }
  ): number | null {
    const trimmed = raw.trim()
    if (!trimmed || trimmed === '-' || trimmed === '.' || trimmed === '-.' || trimmed.endsWith('.')) {
      return null
    }
    const value = Number(trimmed)
    if (!Number.isFinite(value)) return null
    return Math.max(field.min, Math.min(field.max, value))
  }

  private syncShadingInput(input: HTMLInputElement | null, storedValue: number): void {
    if (!input || this.shadingInputs.has(input)) return
    const scale = this.shadingInputUiScale(input)
    input.value = this.formatShadingNumber(storedValue * scale, this.shadingInputStep(input))
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
    this.syncShadingInput(this.rockFromInput, s.rockFromY)
    this.syncShadingInput(this.rockToInput, s.rockToY)
    if (this.rockBlendInput) this.rockBlendInput.value = String(s.rockBlendM)
    this.syncShadingInput(this.waterFromInput, s.waterFromY)
    this.syncShadingInput(this.waterToInput, s.waterToY)
    if (this.waterBlendInput) this.waterBlendInput.value = String(s.waterBlendM)
    this.syncColorInput(this.waterColorInput, s.waterColor)
    this.syncColorInput(this.sandColorInput, s.sandColor)
    this.syncColorInput(this.grassColorInput, s.grassColor)
    this.syncColorInput(this.rockColorInput, s.rockColor)
    this.syncSplatSwatchColors()
  }

  private syncColorInput(input: HTMLInputElement | null, color: number): void {
    if (!input || this.shadingInputs.has(input)) return
    input.value = terrainColorToHex(color)
  }

  private biomeSectionTitle(title: string): HTMLDivElement {
    const head = document.createElement('div')
    head.className = 'editor-sculpt-shading-biome-title'
    head.textContent = title
    return head
  }

  private syncSplatSwatchColors(): void {
    if (!this.refApi?.getProceduralShading) return
    const s = this.refApi.getProceduralShading()
    for (const ch of TERRAIN_SPLAT_PAINT_UI_ORDER) {
      const btn = this.splatChannelButtons.get(ch)
      if (!btn) continue
      btn.style.background = terrainColorToHex(this.channelColor(ch, s))
    }
  }

  private colorPickerRow(
    label: string,
    color: number,
    colorKey: 'waterColor' | 'sandColor' | 'grassColor' | 'rockColor'
  ): HTMLDivElement {
    const row = document.createElement('div')
    row.className = 'editor-sculpt-shading-row'
    const lbl = document.createElement('label')
    lbl.textContent = label
    const input = document.createElement('input')
    input.type = 'color'
    input.className = 'editor-sculpt-color-input'
    input.value = terrainColorToHex(color)
    input.addEventListener('focus', () => this.shadingInputs.add(input))
    input.addEventListener('blur', () => this.shadingInputs.delete(input))
    input.addEventListener('input', () => {
      const next = terrainColorFromHex(input.value)
      this.refApi!.setProceduralShading!({ [colorKey]: next })
      this.updateShadingLegendText()
      this.syncSplatSwatchColors()
    })
    lbl.appendChild(input)
    row.appendChild(lbl)
    return row
  }

  private biomeShadingSection(
    title: string,
    colorKey: 'waterColor' | 'sandColor' | 'grassColor' | 'rockColor',
    color: number,
    fields: {
      from: {
        value: number
        min: number
        max: number
        step: number
        key: keyof TerrainProceduralShading
        uiScale?: number
      }
      to: {
        value: number
        min: number
        max: number
        step: number
        key: keyof TerrainProceduralShading
        uiScale?: number
      }
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

    section.appendChild(this.biomeSectionTitle(title))
    section.appendChild(this.colorPickerRow('Color', color, colorKey))

    if (colorKey === 'waterColor') {
      this.waterColorInput = section.querySelector('input[type=color]') as HTMLInputElement
    }
    if (colorKey === 'sandColor') {
      this.sandColorInput = section.querySelector('input[type=color]') as HTMLInputElement
    }
    if (colorKey === 'grassColor') {
      this.grassColorInput = section.querySelector('input[type=color]') as HTMLInputElement
    }
    if (colorKey === 'rockColor') {
      this.rockColorInput = section.querySelector('input[type=color]') as HTMLInputElement
    }

    const fromToRow = this.shadingFromToPairRow(fields.from, fields.to, (v) => {
      this.refApi!.setProceduralShading!({ [fields.from.key]: v })
      this.updateShadingLegendText()
    }, (v) => {
      this.refApi!.setProceduralShading!({ [fields.to.key]: v })
      this.updateShadingLegendText()
    })
    section.appendChild(fromToRow.row)

    if (fields.from.key === 'waterFromY') this.waterFromInput = fromToRow.fromInput
    if (fields.from.key === 'sandFromY') this.sandFromInput = fromToRow.fromInput
    if (fields.from.key === 'grassFromY') this.grassFromInput = fromToRow.fromInput
    if (fields.from.key === 'rockFromY') this.rockFromInput = fromToRow.fromInput
    if (fields.to.key === 'waterToY') this.waterToInput = fromToRow.toInput
    if (fields.to.key === 'sandToY') this.sandToInput = fromToRow.toInput
    if (fields.to.key === 'grassToY') this.grassToInput = fromToRow.toInput
    if (fields.to.key === 'rockToY') this.rockToInput = fromToRow.toInput

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
    if (fields.blend.key === 'waterBlendM') this.waterBlendInput = blendInput
    if (fields.blend.key === 'sandBlendM') this.sandBlendInput = blendInput
    if (fields.blend.key === 'grassBlendM') this.grassBlendInput = blendInput
    if (fields.blend.key === 'rockBlendM') this.rockBlendInput = blendInput
    section.appendChild(blendRow)

    return section
  }

  private createShadingNumberInput(
    field: {
      value: number
      min: number
      max: number
      step: number
      key: keyof TerrainProceduralShading
      uiScale?: number
    },
    onChange: (v: number) => void
  ): HTMLInputElement {
    const uiScale = field.uiScale ?? 1
    const input = document.createElement('input')
    input.type = 'text'
    input.inputMode = 'decimal'
    input.autocomplete = 'off'
    input.className = 'editor-sculpt-shading-number'
    input.dataset.step = String(field.step)
    input.dataset.uiScale = String(uiScale)
    input.value = this.formatShadingNumber(field.value * uiScale, field.step)
    input.addEventListener('focus', () => this.shadingInputs.add(input))
    input.addEventListener('blur', () => {
      this.shadingInputs.delete(input)
      const parsed = this.parseShadingNumber(input.value, field)
      if (parsed === null) {
        input.value = this.formatShadingNumber(this.getShadingFieldValue(field.key) * uiScale, field.step)
        return
      }
      input.value = this.formatShadingNumber(parsed, field.step)
      onChange(parsed / uiScale)
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur()
    })
    return input
  }

  private shadingFromToPairRow(
    fromField: {
      value: number
      min: number
      max: number
      step: number
      key: keyof TerrainProceduralShading
      uiScale?: number
    },
    toField: {
      value: number
      min: number
      max: number
      step: number
      key: keyof TerrainProceduralShading
      uiScale?: number
    },
    onFromChange: (v: number) => void,
    onToChange: (v: number) => void
  ): { row: HTMLDivElement; fromInput: HTMLInputElement; toInput: HTMLInputElement } {
    const row = document.createElement('div')
    row.className = 'editor-sculpt-shading-row editor-sculpt-shading-from-to'

    const fromLabel = document.createElement('label')
    fromLabel.textContent = 'From'
    const fromInput = this.createShadingNumberInput(fromField, onFromChange)
    fromLabel.appendChild(fromInput)

    const toLabel = document.createElement('label')
    toLabel.textContent = 'To'
    const toInput = this.createShadingNumberInput(toField, onToChange)
    toLabel.appendChild(toInput)

    row.appendChild(fromLabel)
    row.appendChild(toLabel)
    return { row, fromInput, toInput }
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

  private channelColor(ch: TerrainSplatChannel, shading?: TerrainProceduralShading): number {
    const colors = shading ?? this.refApi?.getProceduralShading?.()
    switch (ch) {
      case 0:
        return colors?.grassColor ?? TERRAIN_BIOME_COLORS.grass
      case 1:
        return TERRAIN_BIOME_COLORS.dirt
      case 2:
        return colors?.rockColor ?? TERRAIN_BIOME_COLORS.rock
      case 3:
        return colors?.sandColor ?? TERRAIN_BIOME_COLORS.sand
      case 4:
        return TERRAIN_BIOME_COLORS.lava
      default:
        return colors?.grassColor ?? TERRAIN_BIOME_COLORS.grass
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
      btn.style.background = terrainColorToHex(this.channelColor(ch))
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
    step = (max - min) / 100,
    formatValue?: (v: number) => string
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
    const format = formatValue ?? ((v: number) => v.toFixed(step < 0.1 ? 2 : 1))
    val.textContent = format(initial)
    input.addEventListener('input', () => {
      const v = Number(input.value)
      val.textContent = format(v)
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