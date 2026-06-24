import type { TerrainSculptSession } from '../terrain/TerrainSculptSession'
import type {
  TerrainBrushMode,
  TerrainProceduralShading,
  TerrainSplatChannel
} from '../terrain/terrainSculptConstants'
import {
  TERRAIN_BIOME_COLORS,
  TERRAIN_SPLAT_CHANNEL_LABELS,
  TERRAIN_SPLAT_PAINT_UI_ORDER
} from '../terrain/terrainSculptConstants'

export class TerrainSculptPanel {
  private host: HTMLDivElement
  private statusEl: HTMLDivElement
  private heightToolsHost: HTMLDivElement
  private splatToolsHost: HTMLDivElement
  private brushModeButtons = new Map<TerrainBrushMode, HTMLButtonElement>()
  private splatChannelButtons = new Map<TerrainSplatChannel, HTMLButtonElement>()
  private unsub: (() => void) | null = null

  constructor(
    parent: HTMLElement,
    private session: TerrainSculptSession,
    private onStatus: (msg: string) => void,
    private refApi?: {
      getProceduralShading?: () => TerrainProceduralShading
      setProceduralShading?: (patch: Partial<TerrainProceduralShading>) => void
      onSave?: () => void | Promise<void>
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
    hint.textContent = 'B — toggle sculpt · Left-drag brush · Orbit when sculpt off'
    hint.className = 'editor-sculpt-hint'
    this.host.appendChild(hint)

    this.addLayerTabs()
    this.heightToolsHost = document.createElement('div')
    this.heightToolsHost.className = 'editor-sculpt-tools'
    this.host.appendChild(this.heightToolsHost)
    this.addSculptModes()
    this.addHeightSliders()

    this.splatToolsHost = document.createElement('div')
    this.splatToolsHost.className = 'editor-sculpt-tools editor-sculpt-tools--hidden'
    this.host.appendChild(this.splatToolsHost)
    this.addSplatControls()

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

  private addLayerTabs(): void {
    const row = document.createElement('div')
    row.className = 'editor-sculpt-tabs'
    const heightBtn = this.makeTab('Height', () => this.session.patchSettings({ paintLayer: 'height' }))
    const splatBtn = this.makeTab('Splat', () => this.session.patchSettings({ paintLayer: 'splat' }))
    row.appendChild(heightBtn)
    row.appendChild(splatBtn)
    this.host.appendChild(row)
  }

  private makeTab(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = label
    btn.className = 'editor-sculpt-tab'
    btn.addEventListener('click', onClick)
    return btn
  }

  private addSculptModes(): void {
    const modes: TerrainBrushMode[] = ['raise', 'lower', 'smooth', 'flatten', 'towater']
    const row = document.createElement('div')
    row.className = 'editor-sculpt-row'
    for (const mode of modes) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = mode
      btn.className = 'editor-sculpt-btn'
      btn.addEventListener('click', () => this.session.patchSettings({ brushMode: mode, paintLayer: 'height' }))
      this.brushModeButtons.set(mode, btn)
      row.appendChild(btn)
    }
    this.heightToolsHost.appendChild(row)
  }

  private addHeightSliders(): void {
    this.heightToolsHost.appendChild(this.sliderRow('Brush size (m)', 4, 80, 24, (v) => this.session.patchSettings({ brushSizeM: v })))
    this.heightToolsHost.appendChild(this.sliderRow('Strength', 0.05, 1, 0.55, (v) => this.session.patchSettings({ brushStrength: v })))
  }

  private addSplatControls(): void {
    const row = document.createElement('div')
    row.className = 'editor-sculpt-row'
    for (const ch of TERRAIN_SPLAT_PAINT_UI_ORDER) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = TERRAIN_SPLAT_CHANNEL_LABELS[ch]
      btn.className = 'editor-sculpt-btn'
      if (ch < 4) {
        const colors = [TERRAIN_BIOME_COLORS.grass, TERRAIN_BIOME_COLORS.dirt, TERRAIN_BIOME_COLORS.rock, TERRAIN_BIOME_COLORS.sand, TERRAIN_BIOME_COLORS.lava]
        btn.style.borderColor = `#${colors[ch]!.toString(16).padStart(6, '0')}`
      }
      btn.addEventListener('click', () => this.session.patchSettings({ splatChannel: ch, paintLayer: 'splat' }))
      this.splatChannelButtons.set(ch, btn)
      row.appendChild(btn)
    }
    this.splatToolsHost.appendChild(row)
    this.splatToolsHost.appendChild(this.sliderRow('Brush size (m)', 4, 80, 24, (v) => this.session.patchSettings({ brushSizeM: v })))
    this.splatToolsHost.appendChild(this.sliderRow('Strength', 0.05, 1, 0.55, (v) => this.session.patchSettings({ brushStrength: v })))
    const erase = document.createElement('label')
    erase.className = 'editor-sculpt-check'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.addEventListener('change', () => this.session.patchSettings({ splatErase: cb.checked }))
    erase.appendChild(cb)
    erase.append(' Erase')
    this.splatToolsHost.appendChild(erase)
  }

  private sliderRow(
    label: string,
    min: number,
    max: number,
    initial: number,
    onChange: (v: number) => void
  ): HTMLDivElement {
    const row = document.createElement('div')
    row.className = 'editor-sculpt-slider'
    const lbl = document.createElement('label')
    lbl.textContent = label
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = String((max - min) / 100)
    input.value = String(initial)
    const val = document.createElement('span')
    val.textContent = String(initial)
    input.addEventListener('input', () => {
      const v = Number(input.value)
      val.textContent = v.toFixed(2)
      onChange(v)
    })
    row.appendChild(lbl)
    row.appendChild(input)
    row.appendChild(val)
    return row
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

  private syncFromSession(): void {
    const s = this.session.getSettings()
    this.heightToolsHost.classList.toggle('editor-sculpt-tools--hidden', s.paintLayer !== 'height')
    this.splatToolsHost.classList.toggle('editor-sculpt-tools--hidden', s.paintLayer !== 'splat')
    for (const [mode, btn] of this.brushModeButtons) {
      btn.classList.toggle('editor-sculpt-btn--active', s.paintLayer === 'height' && s.brushMode === mode)
    }
    for (const [ch, btn] of this.splatChannelButtons) {
      btn.classList.toggle('editor-sculpt-btn--active', s.paintLayer === 'splat' && s.splatChannel === ch)
    }
    this.statusEl.textContent = this.session.isActive() ? 'Sculpt active (B to toggle)' : 'Orbit mode (B to sculpt)'
  }

  setStatus(msg: string): void {
    this.statusEl.textContent = msg
    this.onStatus(msg)
  }
}