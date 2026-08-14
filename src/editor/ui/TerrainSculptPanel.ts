import type { TerrainSculptSession } from '../terrain/TerrainSculptSession'
import type {
  TerrainBrushMode,
  TerrainProceduralShading,
  TerrainSplatChannel
} from '../terrain/terrainSculptConstants'
import type {
  SceneDesertConfig,
  SceneEnvironmentConfig,
  SceneEnvironmentKind,
  SceneForestConfig,
  SceneLandConfig,
  SceneMountainsConfig,
  SceneSpaceConfig,
  SceneWaterConfig
} from '../../dcl/content/types'
import {
  EDITOR_AVATAR_SCALE_MAX_PER_PARCEL,
  EDITOR_AVATAR_SCALE_MIN_PER_PARCEL,
  formatAvatarScaleCountLabel,
  type AvatarScalePlacementPlan
} from '../EditorAvatarScaleGuides'
import {
  SPACE_SKY_DEFAULTS,
  SPACE_SKY_PRESETS,
  resolveSpaceSettings
} from '../../environment/spaceSkyDefaults'
import {
  DESERT_DEFAULTS,
  DESERT_PRESETS,
  resolveDesertSettings
} from '../../environment/desertDefaults'
import {
  MOUNTAINS_DEFAULTS,
  MOUNTAINS_PRESETS,
  resolveMountainsSettings
} from '../../environment/mountainsDefaults'
import {
  LAND_COLOR_PRESETS,
  LAND_DEFAULTS,
  resolveLandSettings
} from '../../environment/landDefaults'
import {
  FOREST_DEFAULTS,
  FOREST_ROCK_LABELS,
  FOREST_TREE_LABELS,
  resolveForestSettings
} from '../../environment/forestDefaults'
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
import {
  TERRAIN_STARTER_TEMPLATES,
  randomTerrainSeed,
  seedFromString,
  type TerrainStarterTemplateId
} from '../terrain/generateTerrainStarter'
import { LANDSCAPE_ENVIRONMENTS } from '../../dcl/landscape/EnvironmentCatalog'
import {
  readEnvironmentKind,
  waterShowsOceanUi
} from '../terrain/sceneEnvironmentIO'

/** Main-dock secondary rail content. */
type SecondaryRailMode = 'off' | 'materials' | 'biomes' | 'paint' | 'ocean'

const BIOME_DOCK_ITEMS: {
  kind: SceneEnvironmentKind
  label: string
  tip: string
}[] = [
  { kind: 'none', label: '∅', tip: 'none — void / authoring' },
  { kind: 'genesis', label: '🏙', tip: 'genesis — city sky' },
  { kind: 'island', label: '🏝', tip: 'island — shore + water' },
  { kind: 'water', label: '🌊', tip: 'water — open ocean' },
  { kind: 'land', label: '🌾', tip: 'land — infinite ground + grass' },
  { kind: 'forest', label: '🌲', tip: 'forest — trees + grass' },
  { kind: 'desert', label: '🏜', tip: 'desert' },
  // mountains dock icon hidden for now (panel code retained)
  { kind: 'space', label: '🚀', tip: 'space — no water, void sky' }
]

function normalizeHexColor(raw: string | undefined, fallback: string): string {
  if (!raw || typeof raw !== 'string') return fallback
  const t = raw.trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) {
    if (t.length === 4) {
      return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`.toLowerCase()
    }
    return t.toLowerCase()
  }
  if (/^[0-9a-f]{6}$/i.test(t)) return `#${t.toLowerCase()}`
  return fallback
}

type FloatPaneId =
  | 'height'
  | 'splat'
  | 'grass'
  | 'env'
  | 'starters'
  | 'ocean'
  | 'shade-water'
  | 'shade-sand'
  | 'shade-grass'
  | 'shade-rock'
  | 'guides'
  | 'project'
  | 'export'

/**
 * Height-materials secondary rail (water/sand/grass/rock elevation colors + export).
 * Guides live on the main dock.
 */
const MATERIAL_SUB_PANES: FloatPaneId[] = [
  'shade-water',
  'shade-sand',
  'shade-grass',
  'shade-rock',
  'export'
]


/** Paint parent dock → second column: surface color + Ez Grass. */
const PAINT_SUB_PANES: FloatPaneId[] = ['splat', 'grass']

export class TerrainSculptPanel {
  private host: HTMLDivElement
  private dockEl: HTMLDivElement
  private subDockEl: HTMLDivElement
  private flyoutEl: HTMLDivElement
  private flyoutTitleEl: HTMLDivElement
  private brushSlidersHost: HTMLDivElement
  private statusEl: HTMLDivElement
  private heightToolsHost: HTMLDivElement
  private startersHost: HTMLDivElement
  private splatToolsHost: HTMLDivElement
  private grassToolsHost: HTMLDivElement
  private shadeWaterHost: HTMLDivElement
  private shadeSandHost: HTMLDivElement
  private shadeGrassHost: HTMLDivElement
  private shadeRockHost: HTMLDivElement
  private guidesHost: HTMLDivElement
  private projectHost: HTMLDivElement
  private exportHost: HTMLDivElement
  private envBox: HTMLDivElement | null = null
  private oceanBox: HTMLDivElement | null = null
  private oceanHintEl: HTMLDivElement | null = null
  private biomeHintEl: HTMLDivElement | null = null
  private oceanJumpBtn: HTMLButtonElement | null = null
  private spacePanelEl: HTMLDivElement | null = null
  private desertPanelEl: HTMLDivElement | null = null
  private mountainsPanelEl: HTMLDivElement | null = null
  private windShaderRowEl: HTMLElement | null = null
  private dryBiomeNoteEl: HTMLDivElement | null = null
  private spaceSkyColor: HTMLInputElement | null = null
  private spaceNebulaColor: HTMLInputElement | null = null
  private spaceRimColor: HTMLInputElement | null = null
  private spaceStarsCb: HTMLInputElement | null = null
  private spaceStarDensity: HTMLInputElement | null = null
  private spaceStarBrightness: HTMLInputElement | null = null
  private spaceAmbient: HTMLInputElement | null = null
  private spaceRimIntensity: HTMLInputElement | null = null
  private spaceFogDensity: HTMLInputElement | null = null
  private spaceTwinkle: HTMLInputElement | null = null
  private desertSandColor: HTMLInputElement | null = null
  private desertRockDensity: HTMLInputElement | null = null
  private desertPerlinScale: HTMLInputElement | null = null
  private desertPerlinThreshold: HTMLInputElement | null = null
  private desertHaze: HTMLInputElement | null = null
  private desertDustStormCb: HTMLInputElement | null = null
  private desertDustIntensity: HTMLInputElement | null = null
  private desertTumbleweedsCb: HTMLInputElement | null = null
  private desertTumbleweedCount: HTMLInputElement | null = null
  private desertAcrossParcelsCb: HTMLInputElement | null = null
  private desertDunesCb: HTMLInputElement | null = null
  private desertDunesOnParcelsCb: HTMLInputElement | null = null
  private desertDuneHeight: HTMLInputElement | null = null
  private desertDuneWidth: HTMLInputElement | null = null
  private desertDuneLength: HTMLInputElement | null = null
  private desertDuneWind: HTMLInputElement | null = null
  private desertDuneRipple: HTMLInputElement | null = null
  private landPanelEl: HTMLDivElement | null = null
  private landGroundColor: HTMLInputElement | null = null
  private landGrassColor: HTMLInputElement | null = null
  private landGrassDensitySlider: HTMLInputElement | null = null
  private landGrassDensityValue: HTMLSpanElement | null = null
  private forestPanelEl: HTMLDivElement | null = null
  private forestTreeSliders: HTMLInputElement[] = []
  private forestTreeValues: HTMLSpanElement[] = []
  private forestRockSliders: HTMLInputElement[] = []
  private forestRockValues: HTMLSpanElement[] = []
  private forestBushSlider: HTMLInputElement | null = null
  private forestBushValue: HTMLSpanElement | null = null
  private forestGroundColor: HTMLInputElement | null = null
  private forestGrassColor: HTMLInputElement | null = null
  private forestPatchTimer = 0
  private pendingForest: SceneForestConfig = {}
  private mtRockDensity: HTMLInputElement | null = null
  private mtTreeDensity: HTMLInputElement | null = null
  private mtBackdropDensity: HTMLInputElement | null = null
  private mtHaze: HTMLInputElement | null = null
  private mtHazeColor: HTMLInputElement | null = null
  private mtPeakSnowCb: HTMLInputElement | null = null
  private spacePatchTimer = 0
  private pendingSpace: SceneSpaceConfig = {}
  private desertPatchTimer = 0
  private pendingDesert: SceneDesertConfig = {}
  private landPatchTimer = 0
  private pendingLand: SceneLandConfig = {}
  private mountainsPatchTimer = 0
  private pendingMountains: SceneMountainsConfig = {}
  private secondaryRail: SecondaryRailMode = 'off'
  private materialsGroupEl: HTMLDivElement | null = null
  private biomeGroupEl: HTMLDivElement | null = null
  private paintGroupEl: HTMLDivElement | null = null
  private oceanGroupEl: HTMLDivElement | null = null
  private subDockButtons = new Map<string, HTMLButtonElement>()
  private biomeDockButtons = new Map<SceneEnvironmentKind, HTMLButtonElement>()
  private subDockLayoutHandler: (() => void) | null = null
  private envWindShaderCb: HTMLInputElement | null = null
  private envWaterEnabled: HTMLInputElement | null = null
  private envFftCb: HTMLInputElement | null = null
  private envAmpInput: HTMLInputElement | null = null
  private envWindInput: HTMLInputElement | null = null
  private envDisplaceInput: HTMLInputElement | null = null
  private envChoppyInput: HTMLInputElement | null = null
  private envFftResSelect: HTMLSelectElement | null = null
  private envMeshResSelect: HTMLSelectElement | null = null
  private envSimHzInput: HTMLInputElement | null = null
  private envFoamThreshInput: HTMLInputElement | null = null
  private envSpecInput: HTMLInputElement | null = null
  private envDeepColor: HTMLInputElement | null = null
  private envShallowColor: HTMLInputElement | null = null
  private openPane: FloatPaneId | null = 'height'
  private oceanPatchTimer = 0
  private pendingOcean: SceneWaterConfig = {}
  private dockButtons = new Map<string, HTMLButtonElement>()
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
  /** Ez Grass tab — plant blade tint (not procedural surface grassColor). */
  private ezGrassBladeColorInput: HTMLInputElement | null = null
  private maxHeightGuideCb: HTMLInputElement | null = null
  private gridCb: HTMLInputElement | null = null
  private waterPlaneCb: HTMLInputElement | null = null
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
  /** Terrain height starters (Minecraft-like). */
  private starterSelected: TerrainStarterTemplateId = 'rolling-hills'
  private starterSeedInput: HTMLInputElement | null = null
  private starterMatchBiomeCb: HTMLInputElement | null = null
  private starterTemplateButtons = new Map<TerrainStarterTemplateId, HTMLButtonElement>()

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
      getWaterPlaneVisible?: () => boolean
      setWaterPlaneVisible?: (visible: boolean) => void
      getAvatarScaleGuidesCount?: () => number
      getAvatarScaleGuidesPlan?: () => AvatarScalePlacementPlan | undefined
      setAvatarScaleGuidesCount?: (count: number) => void
      getEnvironment?: () => SceneEnvironmentConfig
      patchEnvironment?: (
        patch: Partial<SceneEnvironmentConfig> & {
          water?: SceneWaterConfig | null
          replaceWater?: boolean
          space?: SceneSpaceConfig | null
          replaceSpace?: boolean
          desert?: SceneDesertConfig | null
          replaceDesert?: boolean
          land?: SceneLandConfig | null
          replaceLand?: boolean
          forest?: SceneForestConfig | null
          replaceForest?: boolean
          mountains?: SceneMountainsConfig | null
          replaceMountains?: boolean
        }
      ) => void | Promise<void>
      focusEnvironment?: () => void
    }
  ) {
    // Full-viewport floating UI (no side column).
    this.host = document.createElement('div')
    this.host.className = 'editor-float-ui'
    parent.appendChild(this.host)

    this.dockEl = document.createElement('div')
    this.dockEl.className = 'editor-viewport-dock'
    this.dockEl.setAttribute('role', 'toolbar')
    this.dockEl.setAttribute('aria-label', 'Terrain tools')
    this.host.appendChild(this.dockEl)
    this.buildDock()

    this.subDockEl = document.createElement('div')
    this.subDockEl.className = 'editor-viewport-dock editor-viewport-dock--sub editor-viewport-dock--sub-hidden'
    this.subDockEl.setAttribute('role', 'toolbar')
    this.subDockEl.setAttribute('aria-label', 'Terrain tools')
    this.host.appendChild(this.subDockEl)
    this.buildSubDock()
    this.subDockLayoutHandler = () => this.layoutSecondaryDock()
    window.addEventListener('resize', this.subDockLayoutHandler)

    this.flyoutEl = document.createElement('div')
    this.flyoutEl.className = 'editor-float-flyout'
    this.host.appendChild(this.flyoutEl)

    const head = document.createElement('div')
    head.className = 'editor-float-flyout-head'
    this.flyoutTitleEl = document.createElement('div')
    this.flyoutTitleEl.className = 'editor-sculpt-title'
    this.flyoutTitleEl.textContent = 'Sculpt'
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'editor-float-flyout-close'
    closeBtn.textContent = '×'
    closeBtn.title = 'Close panel'
    closeBtn.addEventListener('click', () => this.setOpenPane(null))
    head.appendChild(this.flyoutTitleEl)
    head.appendChild(closeBtn)
    this.flyoutEl.appendChild(head)

    this.brushSlidersHost = document.createElement('div')
    this.brushSlidersHost.className = 'editor-float-brush'
    this.flyoutEl.appendChild(this.brushSlidersHost)
    this.addSharedBrushSliders(this.brushSlidersHost)

    this.heightToolsHost = document.createElement('div')
    this.heightToolsHost.className = 'editor-sculpt-tools'
    this.flyoutEl.appendChild(this.heightToolsHost)
    this.addSculptModes()

    this.startersHost = document.createElement('div')
    this.startersHost.className = 'editor-sculpt-tools editor-sculpt-tools--hidden'
    this.flyoutEl.appendChild(this.startersHost)
    this.addTerrainStarters(this.startersHost)

    this.splatToolsHost = document.createElement('div')
    this.splatToolsHost.className = 'editor-sculpt-tools editor-sculpt-tools--hidden'
    this.flyoutEl.appendChild(this.splatToolsHost)
    this.addSplatControls()

    this.grassToolsHost = document.createElement('div')
    this.grassToolsHost.className = 'editor-sculpt-tools editor-sculpt-tools--hidden'
    this.flyoutEl.appendChild(this.grassToolsHost)
    this.addGrassControls()

    this.envBox = document.createElement('div')
    this.envBox.className = 'editor-env-box editor-sculpt-tools--hidden'
    this.flyoutEl.appendChild(this.envBox)
    this.addBiomeControls(this.envBox)

    this.oceanBox = document.createElement('div')
    this.oceanBox.className = 'editor-env-box editor-sculpt-tools--hidden'
    this.flyoutEl.appendChild(this.oceanBox)
    this.addOceanFftControls(this.oceanBox)

    this.shadeWaterHost = document.createElement('div')
    this.shadeWaterHost.className = 'editor-sculpt-tools editor-sculpt-tools--hidden'
    this.flyoutEl.appendChild(this.shadeWaterHost)
    this.shadeSandHost = document.createElement('div')
    this.shadeSandHost.className = 'editor-sculpt-tools editor-sculpt-tools--hidden'
    this.flyoutEl.appendChild(this.shadeSandHost)
    this.shadeGrassHost = document.createElement('div')
    this.shadeGrassHost.className = 'editor-sculpt-tools editor-sculpt-tools--hidden'
    this.flyoutEl.appendChild(this.shadeGrassHost)
    this.shadeRockHost = document.createElement('div')
    this.shadeRockHost.className = 'editor-sculpt-tools editor-sculpt-tools--hidden'
    this.flyoutEl.appendChild(this.shadeRockHost)
    this.addSplitShadingControls()

    this.guidesHost = document.createElement('div')
    this.guidesHost.className = 'editor-sculpt-tools editor-sculpt-tools--hidden'
    this.flyoutEl.appendChild(this.guidesHost)
    this.addViewportControls(this.guidesHost)

    this.projectHost = document.createElement('div')
    this.projectHost.className = 'editor-sculpt-tools editor-sculpt-tools--hidden'
    this.flyoutEl.appendChild(this.projectHost)
    this.addActionButtons(this.projectHost)

    this.exportHost = document.createElement('div')
    this.exportHost.className = 'editor-sculpt-tools editor-sculpt-tools--hidden'
    this.flyoutEl.appendChild(this.exportHost)
    this.addExportControls(this.exportHost)

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'editor-float-status'
    this.host.appendChild(this.statusEl)

    this.unsub = session.subscribe(() => this.syncFromSession())
    this.syncFromSession()
    this.syncEnvironmentUi()
    this.setOpenPane('height')
  }

  /** Open floating Environment pane (dock / external). */
  focusEnvironmentSection(): void {
    this.setOpenPane('env')
  }

  /** Open FFTOCEAN tweak pane. */
  focusOceanSection(): void {
    this.setOpenPane('ocean')
  }

  /** Dock / workspace calls this for tool activation. */
  openToolPane(id: FloatPaneId | 'grid' | 'water' | null): void {
    if (id === 'grid' || id === 'water' || id === null) return
    this.setOpenPane(id)
  }

  dispose(): void {
    if (this.oceanPatchTimer) window.clearTimeout(this.oceanPatchTimer)
    if (this.spacePatchTimer) window.clearTimeout(this.spacePatchTimer)
    if (this.desertPatchTimer) window.clearTimeout(this.desertPatchTimer)
    if (this.landPatchTimer) window.clearTimeout(this.landPatchTimer)
    if (this.forestPatchTimer) window.clearTimeout(this.forestPatchTimer)
    if (this.mountainsPatchTimer) window.clearTimeout(this.mountainsPatchTimer)
    if (this.subDockLayoutHandler) {
      window.removeEventListener('resize', this.subDockLayoutHandler)
      this.subDockLayoutHandler = null
    }
    this.unsub?.()
    this.host.remove()
  }

  syncFromSession(): void {
    this.syncFromSessionInternal()
  }

  private buildDock(): void {
    // Icons in the dock; hover tip (data-tip) carries the name.
    // Order: sculpt → biome → starters → paint → guides → ocean / materials → project (save/undo/redo).
    // Grid under Guides. Water preview under Ocean. Save/undo/redo under ⚙ Project.
    const groups: { id: string; label: string; tip: string }[][] = [
      [{ id: 'height', label: '⛰', tip: 'Sculpt height' }],
      [{ id: 'env', label: '🌍', tip: 'Biome picker (second icon row)' }],
      [
        {
          id: 'starters',
          label: '🎲',
          tip: 'Terrain starters — seed height templates · clear seeded'
        }
      ],
      [{ id: 'paint', label: '🎨', tip: 'Paint — color & Ez Grass (second icon row)' }],
      [{ id: 'guides', label: '📐', tip: 'Guides · grid · scale refs' }],
      [
        { id: 'ocean', label: '🌊', tip: 'Water settings — FFTOCEAN + preview (second icon row)' },
        {
          id: 'materials',
          label: '🧱',
          tip: 'Height materials — water · sand · grass · rock by elevation · export'
        }
      ],
      [{ id: 'project', label: '⚙', tip: 'Project — save · undo · redo' }]
    ]
    groups.forEach((group, gi) => {
      if (gi > 0) {
        const sep = document.createElement('div')
        sep.className = 'editor-viewport-dock-sep'
        sep.setAttribute('aria-hidden', 'true')
        this.dockEl.appendChild(sep)
      }
      for (const t of group) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'editor-viewport-dock-btn'
        btn.dataset.tool = t.id
        btn.dataset.tip = t.tip
        btn.setAttribute('aria-label', t.tip)
        const icon = document.createElement('span')
        icon.className = 'editor-viewport-dock-icon'
        icon.textContent = t.label
        btn.appendChild(icon)
        btn.addEventListener('click', () => this.onDockClick(t.id))
        this.dockButtons.set(t.id, btn)
        this.dockEl.appendChild(btn)
      }
    })
  }

  private onDockClick(id: string): void {
    if (id === 'grid') {
      const next = !(this.refApi?.getGridVisible?.() ?? false)
      this.refApi?.setGridVisible?.(next)
      this.syncDockToggles()
      return
    }
    if (id === 'water') {
      const next = !(this.refApi?.getWaterPlaneVisible?.() ?? false)
      this.refApi?.setWaterPlaneVisible?.(next)
      this.syncDockToggles()
      return
    }
    if (id === 'materials') {
      if (this.secondaryRail === 'materials') {
        this.secondaryRail = 'off'
        if (this.openPane && MATERIAL_SUB_PANES.includes(this.openPane)) {
          this.setOpenPane(null)
        } else {
          this.syncSecondaryRail()
          this.syncDockHighlight()
        }
      } else {
        this.secondaryRail = 'materials'
        this.syncSecondaryRail()
        this.syncDockHighlight()
      }
      return
    }
    if (id === 'paint') {
      if (this.secondaryRail === 'paint') {
        this.secondaryRail = 'off'
        if (this.openPane && PAINT_SUB_PANES.includes(this.openPane)) {
          this.setOpenPane(null)
        } else {
          this.syncSecondaryRail()
          this.syncDockHighlight()
        }
      } else {
        // Open paint rail + color tools by default (keep grass if already painting blades).
        const preferGrass = this.openPane === 'grass' || this.session.getSettings().paintLayer === 'grass'
        this.secondaryRail = 'paint'
        this.setOpenPane(preferGrass ? 'grass' : 'splat')
      }
      return
    }
    if (id === 'env') {
      if (this.openPane === 'env' && this.secondaryRail === 'biomes') {
        this.secondaryRail = 'off'
        this.setOpenPane(null)
      } else {
        this.secondaryRail = 'biomes'
        this.setOpenPane('env')
      }
      return
    }
    if (id === 'ocean') {
      if (this.openPane === 'ocean' && this.secondaryRail === 'ocean') {
        this.secondaryRail = 'off'
        this.setOpenPane(null)
      } else {
        this.secondaryRail = 'ocean'
        this.setOpenPane('ocean')
      }
      return
    }
    if (
      id === 'height' ||
      id === 'starters' ||
      id === 'splat' ||
      id === 'grass' ||
      id === 'guides' ||
      id === 'project' ||
      MATERIAL_SUB_PANES.includes(id as FloatPaneId)
    ) {
      if (MATERIAL_SUB_PANES.includes(id as FloatPaneId)) {
        this.secondaryRail = 'materials'
      } else if (PAINT_SUB_PANES.includes(id as FloatPaneId)) {
        this.secondaryRail = 'paint'
      } else if (id === 'height' || id === 'starters' || id === 'guides' || id === 'project') {
        // Top-level panes — hide secondary rails that don't belong.
        this.secondaryRail = 'off'
      }
      if (this.openPane === id) this.setOpenPane(null)
      else this.setOpenPane(id as FloatPaneId)
    }
  }

  private buildSubDock(): void {
    this.paintGroupEl = document.createElement('div')
    this.paintGroupEl.className =
      'editor-viewport-dock-group editor-viewport-dock-group--hidden'
    this.paintGroupEl.dataset.rail = 'paint'
    const paintTools: { id: FloatPaneId; label: string; tip: string }[] = [
      { id: 'splat', label: '🖌', tip: 'Paint surface color' },
      { id: 'grass', label: '🌿', tip: 'Ez Grass blades' }
    ]
    for (const t of paintTools) {
      const btn = this.makeDockIconBtn(t.id, t.label, t.tip, () => this.onDockClick(t.id))
      this.subDockButtons.set(t.id, btn)
      this.paintGroupEl.appendChild(btn)
    }
    this.subDockEl.appendChild(this.paintGroupEl)

    // Water settings (🌊 main) → second column: preview on/off
    this.oceanGroupEl = document.createElement('div')
    this.oceanGroupEl.className =
      'editor-viewport-dock-group editor-viewport-dock-group--hidden'
    this.oceanGroupEl.dataset.rail = 'ocean'
    const waterBtn = this.makeDockIconBtn('water', '💧', 'Water preview on/off', () =>
      this.onDockClick('water')
    )
    this.subDockButtons.set('water', waterBtn)
    this.oceanGroupEl.appendChild(waterBtn)
    this.subDockEl.appendChild(this.oceanGroupEl)

    this.materialsGroupEl = document.createElement('div')
    this.materialsGroupEl.className = 'editor-viewport-dock-group'
    this.materialsGroupEl.dataset.rail = 'materials'
    const tools: { id: FloatPaneId; label: string; tip: string }[] = [
      { id: 'shade-water', label: '🌊', tip: 'Water material — color by elevation' },
      { id: 'shade-sand', label: '🏖', tip: 'Sand material — color by elevation' },
      { id: 'shade-grass', label: '🍀', tip: 'Grass material — color by elevation' },
      { id: 'shade-rock', label: '🪨', tip: 'Rock material — color by elevation' },
      { id: 'export', label: '📤', tip: 'Export mesh density' }
    ]
    for (const t of tools) {
      const btn = this.makeDockIconBtn(t.id, t.label, t.tip, () => this.onDockClick(t.id))
      this.subDockButtons.set(t.id, btn)
      this.materialsGroupEl.appendChild(btn)
    }
    this.subDockEl.appendChild(this.materialsGroupEl)

    this.biomeGroupEl = document.createElement('div')
    this.biomeGroupEl.className = 'editor-viewport-dock-group editor-viewport-dock-group--hidden'
    this.biomeGroupEl.dataset.rail = 'biomes'
    for (const t of BIOME_DOCK_ITEMS) {
      const btn = this.makeDockIconBtn(`biome-${t.kind}`, t.label, t.tip, () =>
        this.applyBiomeKind(t.kind)
      )
      this.biomeDockButtons.set(t.kind, btn)
      this.biomeGroupEl.appendChild(btn)
    }
    this.subDockEl.appendChild(this.biomeGroupEl)
  }

  private makeDockIconBtn(
    toolId: string,
    label: string,
    tip: string,
    onClick: () => void
  ): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'editor-viewport-dock-btn'
    btn.dataset.tool = toolId
    btn.dataset.tip = tip
    btn.setAttribute('aria-label', tip)
    const icon = document.createElement('span')
    icon.className = 'editor-viewport-dock-icon'
    icon.textContent = label
    btn.appendChild(icon)
    btn.addEventListener('click', onClick)
    return btn
  }

  private biomePanelTitle(kind: SceneEnvironmentKind): string {
    if (kind === 'space') return 'Space'
    if (kind === 'desert') return 'Desert'
    if (kind === 'mountains') return 'Mountains'
    if (kind === 'island') return 'Island'
    if (kind === 'water') return 'Water'
    if (kind === 'forest') return 'Forest'
    if (kind === 'land') return 'Land'
    if (kind === 'genesis') return 'Genesis'
    return 'Biome'
  }

  // mountains dock icon is hidden — if scene.json still has mountains, panel still works

  private applyBiomeKind(kind: SceneEnvironmentKind): void {
    this.secondaryRail = 'biomes'
    // Fire save/rebuild; UI must not wait on async patch or panels stick on the old biome.
    void this.refApi?.patchEnvironment?.({ kind })

    // Force panel content for the *clicked* kind immediately (getEnvironment may still be old).
    this.secondaryRail = 'biomes'
    this.openPane = 'env'
    this.flyoutEl.classList.remove('editor-float-flyout--hidden')
    this.flyoutEl.classList.add('editor-float-flyout--open')
    this.flyoutEl.setAttribute('aria-hidden', 'false')
    this.flyoutTitleEl.textContent = this.biomePanelTitle(kind)
    this.brushSlidersHost.classList.add('editor-sculpt-tools--hidden')
    this.heightToolsHost.classList.add('editor-sculpt-tools--hidden')
    this.startersHost.classList.add('editor-sculpt-tools--hidden')
    this.splatToolsHost.classList.add('editor-sculpt-tools--hidden')
    this.grassToolsHost.classList.add('editor-sculpt-tools--hidden')
    this.envBox?.classList.remove('editor-sculpt-tools--hidden')
    this.oceanBox?.classList.add('editor-sculpt-tools--hidden')
    this.shadeWaterHost.classList.add('editor-sculpt-tools--hidden')
    this.shadeSandHost.classList.add('editor-sculpt-tools--hidden')
    this.shadeGrassHost.classList.add('editor-sculpt-tools--hidden')
    this.shadeRockHost.classList.add('editor-sculpt-tools--hidden')
    this.guidesHost.classList.add('editor-sculpt-tools--hidden')
    this.projectHost.classList.add('editor-sculpt-tools--hidden')
    this.exportHost.classList.add('editor-sculpt-tools--hidden')
    this.syncSecondaryRail()
    this.syncEnvironmentUi(kind)
    this.syncDockHighlight()
    // Optimistic biome icon highlight (patchEnvironment is async).
    for (const [k, btn] of this.biomeDockButtons) {
      const on = k === kind
      btn.classList.toggle('editor-viewport-dock-btn--active', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    this.layoutSecondaryDock()

    const profile = LANDSCAPE_ENVIRONMENTS[kind]
    this.onStatus(
      kind === 'space'
        ? 'Biome: space · atmosphere panel'
        : kind === 'desert'
          ? 'Biome: desert · dunes / sand / dust'
          : kind === 'land'
            ? 'Biome: land · ground color'
            : kind === 'mountains'
              ? 'Biome: mountains · density + haze'
              : profile?.showWater
                ? `Biome: ${kind}`
                : `Biome: ${kind} · water off`
    )
  }

  private isSecondaryRailVisible(): boolean {
    if (
      this.secondaryRail === 'materials' ||
      this.secondaryRail === 'biomes' ||
      this.secondaryRail === 'paint' ||
      this.secondaryRail === 'ocean'
    ) {
      return true
    }
    if (this.openPane !== null && MATERIAL_SUB_PANES.includes(this.openPane)) return true
    if (this.openPane !== null && PAINT_SUB_PANES.includes(this.openPane)) return true
    if (this.openPane === 'env') return true
    if (this.openPane === 'ocean') return true
    return false
  }

  private syncSecondaryRail(): void {
    // Keep rail mode coherent with open pane.
    if (this.openPane && MATERIAL_SUB_PANES.includes(this.openPane)) {
      this.secondaryRail = 'materials'
    } else if (this.openPane && PAINT_SUB_PANES.includes(this.openPane)) {
      this.secondaryRail = 'paint'
    } else if (this.openPane === 'ocean') {
      this.secondaryRail = 'ocean'
    } else if (this.openPane === 'env' && this.secondaryRail === 'off') {
      this.secondaryRail = 'biomes'
    }

    const mode = this.secondaryRail
    const show = this.isSecondaryRailVisible()
    this.subDockEl.classList.toggle('editor-viewport-dock--sub-hidden', !show)
    // Layout flag name is historical — any secondary rail open shifts the flyout.
    this.host.classList.toggle('editor-float-ui--settings-open', show)

    this.materialsGroupEl?.classList.toggle(
      'editor-viewport-dock-group--hidden',
      mode !== 'materials'
    )
    this.biomeGroupEl?.classList.toggle('editor-viewport-dock-group--hidden', mode !== 'biomes')
    this.paintGroupEl?.classList.toggle('editor-viewport-dock-group--hidden', mode !== 'paint')
    this.oceanGroupEl?.classList.toggle('editor-viewport-dock-group--hidden', mode !== 'ocean')
    this.subDockEl.setAttribute(
      'aria-label',
      mode === 'biomes'
        ? 'Biome picker'
        : mode === 'paint'
          ? 'Paint tools'
          : mode === 'ocean'
            ? 'Water settings'
            : mode === 'materials'
              ? 'Height materials'
              : 'Terrain tools'
    )

    if (show) {
      // Two frames: un-hide + group display swap need layout before measure.
      requestAnimationFrame(() => {
        this.layoutSecondaryDock()
        requestAnimationFrame(() => this.layoutSecondaryDock())
      })
    } else {
      this.flyoutEl.style.left = ''
    }
  }

  /**
   * Pin the secondary icon rail immediately to the right of the main dock
   * (same vertical center), and shift the flyout past both rails.
   */
  private layoutSecondaryDock(): void {
    const hostRect = this.host.getBoundingClientRect()
    const mainRect = this.dockEl.getBoundingClientRect()
    if (hostRect.width <= 0 || mainRect.width <= 0) return

    const railGap = 8
    const flyoutGap = 14
    const subLeft = mainRect.right - hostRect.left + railGap
    this.subDockEl.style.left = `${Math.round(subLeft)}px`
    this.subDockEl.style.top = '50%'
    this.subDockEl.style.transform = this.subDockEl.classList.contains(
      'editor-viewport-dock--sub-hidden'
    )
      ? 'translateY(-50%) translateX(-6px)'
      : 'translateY(-50%)'

    if (!this.isSecondaryRailVisible()) {
      this.flyoutEl.style.left = ''
      return
    }

    // Prefer the visible group so we don't measure a collapsed rail.
    const activeGroup =
      this.secondaryRail === 'biomes'
        ? this.biomeGroupEl
        : this.secondaryRail === 'materials'
          ? this.materialsGroupEl
          : this.secondaryRail === 'paint'
            ? this.paintGroupEl
            : this.secondaryRail === 'ocean'
              ? this.oceanGroupEl
              : null
    const groupRect = activeGroup?.getBoundingClientRect()
    const subRect = this.subDockEl.getBoundingClientRect()
    const anchorRight =
      groupRect && groupRect.width > 0
        ? groupRect.right
        : subRect.width > 0
          ? subRect.right
          : mainRect.right
    const flyoutLeft = Math.max(
      mainRect.right - hostRect.left + railGap + 54 + flyoutGap,
      anchorRight - hostRect.left + flyoutGap
    )
    this.flyoutEl.style.left = `${Math.round(flyoutLeft)}px`
  }

  private setOpenPane(id: FloatPaneId | null): void {
    this.openPane = id
    if (id && MATERIAL_SUB_PANES.includes(id)) this.secondaryRail = 'materials'
    else if (id && PAINT_SUB_PANES.includes(id)) this.secondaryRail = 'paint'
    else if (id === 'env') this.secondaryRail = 'biomes'
    else if (id === 'ocean') this.secondaryRail = 'ocean'
    else if (id === 'height' || id === 'starters' || id === 'guides' || id === 'project') {
      this.secondaryRail = 'off'
    }
    else if (
      id === null &&
      (this.secondaryRail === 'biomes' ||
        this.secondaryRail === 'paint' ||
        this.secondaryRail === 'ocean')
    ) {
      this.secondaryRail = 'off'
    }
    this.syncSecondaryRail()

    const hidden = id === null
    this.flyoutEl.classList.toggle('editor-float-flyout--hidden', hidden)
    this.flyoutEl.classList.toggle('editor-float-flyout--open', !hidden)
    this.flyoutEl.setAttribute('aria-hidden', hidden ? 'true' : 'false')

    if (id === 'height') {
      this.session.patchSettings({ paintLayer: 'height' })
      this.flyoutTitleEl.textContent = 'Sculpt'
    } else if (id === 'starters') {
      this.flyoutTitleEl.textContent = 'Starters'
    } else if (id === 'splat') {
      this.session.patchSettings({ paintLayer: 'splat' })
      this.flyoutTitleEl.textContent = 'Paint'
    } else if (id === 'grass') {
      this.session.patchSettings({ paintLayer: 'grass' })
      this.flyoutTitleEl.textContent = 'Ez Grass'
    } else if (id === 'env') {
      const k = readEnvironmentKind(this.refApi?.getEnvironment?.() ?? { kind: 'none' })
      this.flyoutTitleEl.textContent = this.biomePanelTitle(k)
      this.syncEnvironmentUi()
    } else if (id === 'ocean') {
      this.flyoutTitleEl.textContent = 'FFTOCEAN'
      this.syncEnvironmentUi()
    } else if (id === 'shade-water') {
      this.flyoutTitleEl.textContent = 'Water material'
    } else if (id === 'shade-sand') {
      this.flyoutTitleEl.textContent = 'Sand material'
    } else if (id === 'shade-grass') {
      this.flyoutTitleEl.textContent = 'Grass material'
    } else if (id === 'shade-rock') {
      this.flyoutTitleEl.textContent = 'Rock material'
    } else if (id === 'guides') {
      this.flyoutTitleEl.textContent = 'Guides'
    } else if (id === 'project') {
      this.flyoutTitleEl.textContent = 'Project'
    } else if (id === 'export') {
      this.flyoutTitleEl.textContent = 'Export'
    }

    const brush = id === 'height' || id === 'splat' || id === 'grass'
    this.brushSlidersHost.classList.toggle('editor-sculpt-tools--hidden', !brush)
    this.heightToolsHost.classList.toggle('editor-sculpt-tools--hidden', id !== 'height')
    this.startersHost.classList.toggle('editor-sculpt-tools--hidden', id !== 'starters')
    this.splatToolsHost.classList.toggle('editor-sculpt-tools--hidden', id !== 'splat')
    this.grassToolsHost.classList.toggle('editor-sculpt-tools--hidden', id !== 'grass')
    this.envBox?.classList.toggle('editor-sculpt-tools--hidden', id !== 'env')
    this.oceanBox?.classList.toggle('editor-sculpt-tools--hidden', id !== 'ocean')
    this.shadeWaterHost.classList.toggle('editor-sculpt-tools--hidden', id !== 'shade-water')
    this.shadeSandHost.classList.toggle('editor-sculpt-tools--hidden', id !== 'shade-sand')
    this.shadeGrassHost.classList.toggle('editor-sculpt-tools--hidden', id !== 'shade-grass')
    this.shadeRockHost.classList.toggle('editor-sculpt-tools--hidden', id !== 'shade-rock')
    this.guidesHost.classList.toggle('editor-sculpt-tools--hidden', id !== 'guides')
    this.projectHost.classList.toggle('editor-sculpt-tools--hidden', id !== 'project')
    this.exportHost.classList.toggle('editor-sculpt-tools--hidden', id !== 'export')

    this.syncDockHighlight()
    this.syncFromSessionInternal()
    // Content swap can change flyout size; re-pin past the secondary rail.
    if (this.isSecondaryRailVisible()) {
      requestAnimationFrame(() => this.layoutSecondaryDock())
    }
  }

  private syncDockHighlight(): void {
    const layer = this.session.getSettings().paintLayer
    for (const [toolId, btn] of this.dockButtons) {
      let on = false
      if (toolId === 'height') {
        on = this.openPane === 'height' || (this.openPane === null && layer === 'height')
      } else if (toolId === 'starters') {
        on = this.openPane === 'starters'
      } else if (toolId === 'paint') {
        on =
          this.secondaryRail === 'paint' ||
          this.openPane === 'splat' ||
          this.openPane === 'grass' ||
          (this.openPane === null && (layer === 'splat' || layer === 'grass'))
      } else if (toolId === 'env') {
        on = this.openPane === 'env' || this.secondaryRail === 'biomes'
      } else if (toolId === 'ocean') {
        on = this.openPane === 'ocean' || this.secondaryRail === 'ocean'
      } else if (toolId === 'guides' || toolId === 'project') {
        on = this.openPane === toolId
      } else if (toolId === 'materials') {
        on =
          this.secondaryRail === 'materials' ||
          (this.openPane !== null && MATERIAL_SUB_PANES.includes(this.openPane))
      }
      btn.classList.toggle('editor-viewport-dock-btn--active', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    for (const [toolId, btn] of this.subDockButtons) {
      // Water preview is a toggle (on = visible), not an open pane.
      if (toolId === 'water') continue
      const on = this.openPane === toolId
      btn.classList.toggle('editor-viewport-dock-btn--active', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    const curKind = readEnvironmentKind(this.refApi?.getEnvironment?.() ?? { kind: 'none' })
    for (const [kind, btn] of this.biomeDockButtons) {
      const on = kind === curKind
      btn.classList.toggle('editor-viewport-dock-btn--active', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    this.syncDockToggles()
  }

  private syncDockToggles(): void {
    // Water preview lives on the ocean secondary rail (not main dock).
    // Grid lives under Guides checkbox — no main-dock icon.
    const waterBtn = this.subDockButtons.get('water') ?? this.dockButtons.get('water')
    const waterOn = this.refApi?.getWaterPlaneVisible?.() ?? false
    waterBtn?.classList.toggle('editor-viewport-dock-btn--on', waterOn)
    waterBtn?.setAttribute('aria-pressed', waterOn ? 'true' : 'false')
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
    this.syncDockToggles()
  }

  setWaterPlaneChecked(checked: boolean): void {
    if (this.waterPlaneCb) this.waterPlaneCb.checked = checked
    this.syncDockToggles()
  }

  setAvatarScaleCapNote(capped: boolean): void {
    if (this.avatarScaleCapNote) {
      this.avatarScaleCapNote.hidden = !capped
    }
  }

  private addViewportControls(parent: HTMLElement): void {
    const hasMaxHeight =
      this.refApi?.getMaxHeightGuideVisible && this.refApi.setMaxHeightGuideVisible
    const hasGrid = this.refApi?.getGridVisible && this.refApi.setGridVisible
    const hasWater = this.refApi?.getWaterPlaneVisible && this.refApi.setWaterPlaneVisible
    const hasAvatarScale =
      this.refApi?.getAvatarScaleGuidesVisible && this.refApi.setAvatarScaleGuidesVisible
    if (!hasMaxHeight && !hasGrid && !hasWater && !hasAvatarScale) return

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

    if (hasWater) {
      const row = document.createElement('label')
      row.className = 'editor-sculpt-check'
      this.waterPlaneCb = document.createElement('input')
      this.waterPlaneCb.type = 'checkbox'
      this.waterPlaneCb.checked = this.refApi!.getWaterPlaneVisible!()
      this.waterPlaneCb.addEventListener('change', () => {
        this.refApi!.setWaterPlaneVisible!(this.waterPlaneCb!.checked)
      })
      row.appendChild(this.waterPlaneCb)
      row.append(' Water line (surface plane)')
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

    parent.appendChild(wrap)
  }

  private addSplitShadingControls(): void {
    if (!this.refApi?.getProceduralShading || !this.refApi.setProceduralShading) return
    const shading = this.refApi.getProceduralShading()

    this.shadeWaterHost.appendChild(
      this.biomeShadingSection('Water', 'waterColor', shading.waterColor, {
        from: { value: shading.waterFromY, min: -2, max: 40, step: 0.1, key: 'waterFromY' },
        to: { value: shading.waterToY, min: -2, max: 40, step: 0.1, key: 'waterToY' },
        blend: { value: shading.waterBlendM, min: 0.1, max: 12, step: 0.05, key: 'waterBlendM', unit: 'm' }
      })
    )
    const waterNote = document.createElement('div')
    waterNote.className = 'editor-sculpt-hint editor-sculpt-hint--compact'
    waterNote.textContent = 'Water To = ocean / “to water” sculpt height'
    this.shadeWaterHost.appendChild(waterNote)

    this.shadeSandHost.appendChild(
      this.biomeShadingSection('Sand', 'sandColor', shading.sandColor, {
        from: { value: shading.sandFromY, min: -2, max: 40, step: 0.1, key: 'sandFromY' },
        to: { value: shading.sandToY, min: -2, max: 40, step: 0.1, key: 'sandToY' },
        blend: { value: shading.sandBlendM, min: 0.1, max: 12, step: 0.05, key: 'sandBlendM', unit: 'm' }
      })
    )
    this.shadeGrassHost.appendChild(
      this.biomeShadingSection('Grass', 'grassColor', shading.grassColor, {
        from: { value: shading.grassFromY, min: -2, max: 120, step: 0.1, key: 'grassFromY' },
        to: { value: shading.grassToY, min: 0, max: 120, step: 0.5, key: 'grassToY' },
        blend: { value: shading.grassBlendM, min: 0.1, max: 16, step: 0.05, key: 'grassBlendM', unit: 'm' }
      })
    )
    this.shadeRockHost.appendChild(
      this.biomeShadingSection('Rock', 'rockColor', shading.rockColor, {
        from: { value: shading.rockFromY, min: 0, max: 120, step: 0.5, key: 'rockFromY' },
        to: { value: shading.rockToY, min: 0, max: 120, step: 0.5, key: 'rockToY' },
        blend: { value: shading.rockBlendM, min: 0.1, max: 16, step: 0.05, key: 'rockBlendM', unit: 'm' }
      })
    )
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

  private addBiomeControls(box: HTMLDivElement): void {
    if (!this.refApi?.getEnvironment || !this.refApi.patchEnvironment) {
      box.appendChild(this.hintEl('Environment API not wired'))
      return
    }

    // Biome pick is the left icon rail only — no duplicate dropdown.
    this.biomeHintEl = document.createElement('div')
    this.biomeHintEl.className = 'editor-sculpt-hint editor-sculpt-hint--compact'
    this.biomeHintEl.dataset.role = 'biome-hint'
    box.appendChild(this.biomeHintEl)

    // —— Per-biome settings panels (only one visible at a time)
    this.spacePanelEl = document.createElement('div')
    this.spacePanelEl.className = 'editor-space-panel editor-sculpt-tools--hidden'
    this.addSpaceControls(this.spacePanelEl)
    box.appendChild(this.spacePanelEl)

    this.desertPanelEl = document.createElement('div')
    this.desertPanelEl.className = 'editor-desert-panel editor-sculpt-tools--hidden'
    this.addDesertControls(this.desertPanelEl)
    box.appendChild(this.desertPanelEl)

    this.landPanelEl = document.createElement('div')
    this.landPanelEl.className = 'editor-land-panel editor-sculpt-tools--hidden'
    this.addLandControls(this.landPanelEl)
    box.appendChild(this.landPanelEl)

    this.forestPanelEl = document.createElement('div')
    this.forestPanelEl.className = 'editor-forest-panel editor-sculpt-tools--hidden'
    this.addForestControls(this.forestPanelEl)
    box.appendChild(this.forestPanelEl)

    this.mountainsPanelEl = document.createElement('div')
    this.mountainsPanelEl.className = 'editor-mountains-panel editor-sculpt-tools--hidden'
    this.addMountainsControls(this.mountainsPanelEl)
    box.appendChild(this.mountainsPanelEl)

    const windWrap = document.createElement('div')
    this.envWindShaderCb = this.envCheckRow(windWrap, 'Ez Grass wind shader', (on) => {
      void this.refApi!.patchEnvironment!({ windShader: on })
      this.onStatus(on ? 'windShader on (reload play to feel wind)' : 'windShader off')
    })
    this.windShaderRowEl = windWrap
    box.appendChild(windWrap)

    this.oceanJumpBtn = document.createElement('button')
    this.oceanJumpBtn.type = 'button'
    this.oceanJumpBtn.className = 'editor-sculpt-btn editor-sculpt-btn--primary'
    this.oceanJumpBtn.textContent = 'Open FFTOCEAN tweaks →'
    this.oceanJumpBtn.title = 'Wave settings for island / water / mountains'
    this.oceanJumpBtn.addEventListener('click', () => this.setOpenPane('ocean'))
    box.appendChild(this.oceanJumpBtn)

    this.dryBiomeNoteEl = this.hintEl(
      'This biome has no ocean. Island / water / mountains turn water on. 💧 force-toggles preview.'
    )
    box.appendChild(this.dryBiomeNoteEl)
  }

  private addSpaceControls(box: HTMLDivElement): void {
    const title = document.createElement('div')
    title.className = 'editor-sculpt-shading-biome-title'
    title.textContent = 'Space atmosphere'
    box.appendChild(title)

    box.appendChild(
      this.hintEl('Live in editor · writes environment.space · play client starfield')
    )

    const presets = document.createElement('div')
    presets.className = 'editor-sculpt-row'
    presets.style.flexWrap = 'wrap'
    for (const p of SPACE_SKY_PRESETS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'editor-sculpt-btn'
      btn.textContent = p.label
      btn.title = p.id
      btn.addEventListener('click', () => {
        this.pendingSpace = {}
        if (this.spacePatchTimer) window.clearTimeout(this.spacePatchTimer)
        this.spacePatchTimer = 0
        void this.refApi?.patchEnvironment?.({ space: { ...p.space }, replaceSpace: true })
        this.syncEnvironmentUi()
        this.onStatus(`Space preset: ${p.label}`)
      })
      presets.appendChild(btn)
    }
    box.appendChild(presets)

    const colorRow = document.createElement('div')
    colorRow.className = 'editor-sculpt-row'
    colorRow.style.alignItems = 'center'
    colorRow.style.flexWrap = 'wrap'
    colorRow.style.gap = '10px'

    const skyL = document.createElement('label')
    skyL.className = 'editor-sculpt-check'
    skyL.style.display = 'flex'
    skyL.style.alignItems = 'center'
    skyL.style.gap = '6px'
    skyL.append('Void')
    this.spaceSkyColor = document.createElement('input')
    this.spaceSkyColor.type = 'color'
    this.spaceSkyColor.addEventListener('input', () => {
      this.patchSpace({ skyColor: this.spaceSkyColor!.value })
    })
    skyL.appendChild(this.spaceSkyColor)

    const nebL = document.createElement('label')
    nebL.className = 'editor-sculpt-check'
    nebL.style.display = 'flex'
    nebL.style.alignItems = 'center'
    nebL.style.gap = '6px'
    nebL.append('Nebula')
    this.spaceNebulaColor = document.createElement('input')
    this.spaceNebulaColor.type = 'color'
    this.spaceNebulaColor.addEventListener('input', () => {
      this.patchSpace({ nebulaColor: this.spaceNebulaColor!.value })
    })
    nebL.appendChild(this.spaceNebulaColor)

    const rimL = document.createElement('label')
    rimL.className = 'editor-sculpt-check'
    rimL.style.display = 'flex'
    rimL.style.alignItems = 'center'
    rimL.style.gap = '6px'
    rimL.append('Rim')
    this.spaceRimColor = document.createElement('input')
    this.spaceRimColor.type = 'color'
    this.spaceRimColor.addEventListener('input', () => {
      this.patchSpace({ rimColor: this.spaceRimColor!.value })
    })
    rimL.appendChild(this.spaceRimColor)

    colorRow.appendChild(skyL)
    colorRow.appendChild(nebL)
    colorRow.appendChild(rimL)
    box.appendChild(colorRow)

    this.spaceStarsCb = this.envCheckRow(box, 'Starfield', (on) => {
      this.patchSpace({ stars: on })
    })

    this.spaceStarDensity = this.envSliderRow(box, 'Star density', 0, 1, 0.01, 0.65, (v) => {
      this.patchSpace({ starDensity: v })
    })
    this.spaceStarBrightness = this.envSliderRow(box, 'Star brightness', 0, 2, 0.05, 1, (v) => {
      this.patchSpace({ starBrightness: v })
    })
    this.spaceTwinkle = this.envSliderRow(box, 'Twinkle', 0, 4, 0.05, 1, (v) => {
      this.patchSpace({ twinkle: v })
    })
    this.spaceAmbient = this.envSliderRow(box, 'Ambient fill', 0, 2, 0.05, 0.35, (v) => {
      this.patchSpace({ ambient: v })
    })
    this.spaceRimIntensity = this.envSliderRow(box, 'Rim intensity', 0, 3, 0.05, 0.85, (v) => {
      this.patchSpace({ rimIntensity: v })
    })
    this.spaceFogDensity = this.envSliderRow(box, 'Depth fog', 0, 0.05, 0.001, 0.008, (v) => {
      this.patchSpace({ fogDensity: v })
    })

    const resetRow = document.createElement('div')
    resetRow.className = 'editor-sculpt-row'
    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'editor-sculpt-btn'
    resetBtn.textContent = 'Reset space defaults'
    resetBtn.addEventListener('click', () => {
      this.pendingSpace = {}
      if (this.spacePatchTimer) window.clearTimeout(this.spacePatchTimer)
      this.spacePatchTimer = 0
      const space: SceneSpaceConfig = { ...SPACE_SKY_DEFAULTS }
      void this.refApi?.patchEnvironment?.({ space, replaceSpace: true })
      this.syncEnvironmentUi()
      this.onStatus('Space atmosphere reset')
    })
    resetRow.appendChild(resetBtn)
    box.appendChild(resetRow)
  }

  private patchSpace(space: SceneSpaceConfig): void {
    if (!this.refApi?.patchEnvironment) return
    this.pendingSpace = { ...this.pendingSpace, ...space }
    if (this.spacePatchTimer) window.clearTimeout(this.spacePatchTimer)
    this.spacePatchTimer = window.setTimeout(() => {
      this.spacePatchTimer = 0
      const cur = this.refApi!.getEnvironment?.()?.space ?? {}
      const merged = { ...cur, ...this.pendingSpace }
      this.pendingSpace = {}
      void this.refApi!.patchEnvironment!({ space: merged })
    }, 120)
  }

  private addDesertControls(box: HTMLDivElement): void {
    const title = document.createElement('div')
    title.className = 'editor-sculpt-shading-biome-title'
    title.textContent = 'Desert'
    box.appendChild(title)
    box.appendChild(
      this.hintEl(
        'Same client landscape as play (gold plane + rocks + dust) · rebuilds on change'
      )
    )

    const presets = document.createElement('div')
    presets.className = 'editor-sculpt-row'
    presets.style.flexWrap = 'wrap'
    for (const p of DESERT_PRESETS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'editor-sculpt-btn'
      btn.textContent = p.label
      btn.addEventListener('click', () => {
        this.pendingDesert = {}
        if (this.desertPatchTimer) window.clearTimeout(this.desertPatchTimer)
        this.desertPatchTimer = 0
        void this.refApi?.patchEnvironment?.({ desert: { ...p.desert }, replaceDesert: true })
        this.syncEnvironmentUi()
        this.onStatus(`Desert preset: ${p.label}`)
      })
      presets.appendChild(btn)
    }
    box.appendChild(presets)

    const colorRow = document.createElement('div')
    colorRow.className = 'editor-sculpt-row'
    colorRow.style.alignItems = 'center'
    const sandL = document.createElement('label')
    sandL.className = 'editor-sculpt-check'
    sandL.style.display = 'flex'
    sandL.style.alignItems = 'center'
    sandL.style.gap = '6px'
    sandL.append('Sand color')
    this.desertSandColor = document.createElement('input')
    this.desertSandColor.type = 'color'
    this.desertSandColor.addEventListener('input', () => {
      this.patchDesert({ sandColor: this.desertSandColor!.value })
    })
    sandL.appendChild(this.desertSandColor)
    colorRow.appendChild(sandL)
    box.appendChild(colorRow)

    this.desertRockDensity = this.envSliderRow(box, 'Rock density', 0, 2, 0.05, 1, (v) => {
      this.patchDesert({ rockDensity: v })
    })
    this.desertPerlinScale = this.envSliderRow(box, 'Perlin scale', 0.05, 2, 0.05, 0.55, (v) => {
      this.patchDesert({ perlinScale: v })
    })
    this.desertPerlinThreshold = this.envSliderRow(
      box,
      'Perlin threshold',
      0,
      1,
      0.01,
      0.42,
      (v) => this.patchDesert({ perlinThreshold: v })
    )
    this.desertHaze = this.envSliderRow(box, 'Sand haze', 0, 0.04, 0.001, 0.006, (v) => {
      this.patchDesert({ haze: v })
    })

    this.desertDustStormCb = this.envCheckRow(box, 'Dust storm', (on) => {
      this.patchDesert({ dustStorm: on })
    })
    this.desertDustIntensity = this.envSliderRow(box, 'Dust intensity', 0, 1, 0.05, 0.55, (v) => {
      this.patchDesert({ dustIntensity: v })
    })
    this.desertTumbleweedsCb = this.envCheckRow(box, 'Tumbleweeds', (on) => {
      this.patchDesert({ tumbleweeds: on })
    })
    this.desertTumbleweedCount = this.envSliderRow(box, 'Tumbleweed count', 0, 80, 1, 12, (v) => {
      this.patchDesert({ tumbleweedCount: Math.round(v) })
    })
    this.desertAcrossParcelsCb = this.envCheckRow(
      box,
      'Dust / tumbleweeds on my parcels too',
      (on) => {
        this.patchDesert({ acrossParcels: on })
      }
    )
    box.appendChild(
      this.hintEl(
        'Rocks scatter to the horizon (forest-style). Uncheck “on my parcels” to keep FX only on outer dunes.'
      )
    )

    const duneTitle = document.createElement('div')
    duneTitle.className = 'editor-sculpt-shading-biome-title'
    duneTitle.textContent = 'Dunes'
    box.appendChild(duneTitle)
    this.desertDunesCb = this.envCheckRow(box, 'Perlin dunes', (on) => {
      this.patchDesert({ dunes: on })
    })
    this.desertDunesOnParcelsCb = this.envCheckRow(
      box,
      'Dunes on scene parcels',
      (on) => {
        this.patchDesert({ dunesOnParcels: on })
      }
    )
    this.desertDuneHeight = this.envSliderRow(box, 'Dune height (m)', 0, 16, 0.05, 1.1, (v) => {
      this.patchDesert({ duneHeight: v })
    })
    this.desertDuneWidth = this.envSliderRow(box, 'Dune width (m)', 4, 80, 1, 22, (v) => {
      this.patchDesert({ duneWidth: v })
    })
    this.desertDuneLength = this.envSliderRow(box, 'Dune length (m)', 8, 200, 1, 70, (v) => {
      this.patchDesert({ duneLength: v })
    })
    this.desertDuneWind = this.envSliderRow(box, 'Wind / ridge °', 0, 360, 1, 25, (v) => {
      this.patchDesert({ duneWindDeg: v })
    })
    this.desertDuneRipple = this.envSliderRow(box, 'Ripple', 0, 1, 0.05, 0.35, (v) => {
      this.patchDesert({ duneRipple: v })
    })

    const resetRow = document.createElement('div')
    resetRow.className = 'editor-sculpt-row'
    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'editor-sculpt-btn'
    resetBtn.textContent = 'Reset desert defaults'
    resetBtn.addEventListener('click', () => {
      this.pendingDesert = {}
      if (this.desertPatchTimer) window.clearTimeout(this.desertPatchTimer)
      this.desertPatchTimer = 0
      void this.refApi?.patchEnvironment?.({
        desert: { ...DESERT_DEFAULTS },
        replaceDesert: true
      })
      this.syncEnvironmentUi()
      this.onStatus('Desert reset')
    })
    resetRow.appendChild(resetBtn)
    box.appendChild(resetRow)
  }

  private patchDesert(desert: SceneDesertConfig): void {
    if (!this.refApi?.patchEnvironment) return
    this.pendingDesert = { ...this.pendingDesert, ...desert }
    if (this.desertPatchTimer) window.clearTimeout(this.desertPatchTimer)
    this.desertPatchTimer = window.setTimeout(() => {
      this.desertPatchTimer = 0
      const cur = this.refApi!.getEnvironment?.()?.desert ?? {}
      const merged = { ...cur, ...this.pendingDesert }
      this.pendingDesert = {}
      void this.refApi!.patchEnvironment!({ desert: merged })
    }, 120)
  }

  private addLandControls(box: HTMLDivElement): void {
    const title = document.createElement('div')
    title.className = 'editor-sculpt-shading-biome-title'
    title.textContent = 'Land ground'
    box.appendChild(title)

    const presets = document.createElement('div')
    presets.className = 'editor-sculpt-row'
    presets.style.flexWrap = 'wrap'
    for (const p of LAND_COLOR_PRESETS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'editor-sculpt-btn'
      btn.textContent = p.label
      btn.style.borderLeft = `4px solid ${p.groundColor}`
      btn.addEventListener('click', () => {
        this.pendingLand = {}
        if (this.landPatchTimer) window.clearTimeout(this.landPatchTimer)
        this.landPatchTimer = 0
        // Keep density when swapping color presets; set matching ground + grass tints.
        const density = this.refApi?.getEnvironment?.()?.land?.grassDensity
        void this.refApi?.patchEnvironment?.({
          land: {
            groundColor: p.groundColor,
            grassColor: p.grassColor,
            ...(typeof density === 'number' ? { grassDensity: density } : {})
          },
          replaceLand: true
        })
        this.syncEnvironmentUi()
        this.onStatus(`Land: ${p.label}`)
      })
      presets.appendChild(btn)
    }
    box.appendChild(presets)

    const colorRow = document.createElement('div')
    colorRow.className = 'editor-sculpt-row'
    colorRow.style.alignItems = 'center'
    colorRow.style.flexWrap = 'wrap'
    colorRow.style.gap = '12px'

    const groundLbl = document.createElement('label')
    groundLbl.className = 'editor-sculpt-check'
    groundLbl.style.display = 'flex'
    groundLbl.style.alignItems = 'center'
    groundLbl.style.gap = '6px'
    groundLbl.append('Ground color')
    this.landGroundColor = document.createElement('input')
    this.landGroundColor.type = 'color'
    this.landGroundColor.addEventListener('input', () => {
      this.patchLand({ groundColor: this.landGroundColor!.value })
    })
    groundLbl.appendChild(this.landGroundColor)
    colorRow.appendChild(groundLbl)

    const grassLbl = document.createElement('label')
    grassLbl.className = 'editor-sculpt-check'
    grassLbl.style.display = 'flex'
    grassLbl.style.alignItems = 'center'
    grassLbl.style.gap = '6px'
    grassLbl.title =
      'Blade tint for outer land-biome grass patches (environment.land.grassColor). Not paint Ez Grass.'
    grassLbl.append('Grass color')
    this.landGrassColor = document.createElement('input')
    this.landGrassColor.type = 'color'
    this.landGrassColor.addEventListener('input', () => {
      this.patchLand({ grassColor: this.landGrassColor!.value })
    })
    grassLbl.appendChild(this.landGrassColor)
    colorRow.appendChild(grassLbl)
    box.appendChild(colorRow)

    // Outer grass patch density (land biome ez-tree field — not author paint).
    const densityRow = this.sliderRow(
      'Grass patch density',
      0,
      2,
      LAND_DEFAULTS.grassDensity,
      (v) => {
        this.patchLand({ grassDensity: v })
        this.onStatus(`Land grass density ×${v.toFixed(2)}`)
      }
    )
    this.landGrassDensitySlider = densityRow.querySelector('input') as HTMLInputElement
    this.landGrassDensityValue = densityRow.querySelector('span') as HTMLSpanElement
    densityRow.title =
      'How dense outer land-biome grass patches are (environment.land.grassDensity). Does not affect paint Ez Grass.'
    box.appendChild(densityRow)

    const resetRow = document.createElement('div')
    resetRow.className = 'editor-sculpt-row'
    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'editor-sculpt-btn'
    resetBtn.textContent = 'Reset land defaults'
    resetBtn.addEventListener('click', () => {
      this.pendingLand = {}
      if (this.landPatchTimer) window.clearTimeout(this.landPatchTimer)
      this.landPatchTimer = 0
      void this.refApi?.patchEnvironment?.({
        land: { ...LAND_DEFAULTS },
        replaceLand: true
      })
      this.syncEnvironmentUi()
      this.onStatus('Land reset')
    })
    resetRow.appendChild(resetBtn)
    box.appendChild(resetRow)
  }

  private patchLand(land: SceneLandConfig): void {
    if (!this.refApi?.patchEnvironment) return
    this.pendingLand = { ...this.pendingLand, ...land }
    if (this.landPatchTimer) window.clearTimeout(this.landPatchTimer)
    this.landPatchTimer = window.setTimeout(() => {
      this.landPatchTimer = 0
      const cur = this.refApi!.getEnvironment?.()?.land ?? {}
      const merged = { ...cur, ...this.pendingLand }
      this.pendingLand = {}
      void this.refApi!.patchEnvironment!({ land: merged })
    }, 120)
  }

  private addForestControls(box: HTMLDivElement): void {
    const title = document.createElement('div')
    title.className = 'editor-sculpt-shading-biome-title'
    title.textContent = 'Forest'
    box.appendChild(title)

    // Ground color — same solid plane as land biome.
    const groundTitle = document.createElement('div')
    groundTitle.className = 'editor-sculpt-title'
    groundTitle.textContent = 'Ground'
    box.appendChild(groundTitle)

    const groundPresets = document.createElement('div')
    groundPresets.className = 'editor-sculpt-row'
    groundPresets.style.flexWrap = 'wrap'
    for (const p of LAND_COLOR_PRESETS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'editor-sculpt-btn'
      btn.textContent = p.label
      btn.style.borderLeft = `4px solid ${p.groundColor}`
      btn.addEventListener('click', () => {
        this.patchForest({ groundColor: p.groundColor, grassColor: p.grassColor })
        if (this.forestGroundColor) this.forestGroundColor.value = p.groundColor
        if (this.forestGrassColor) this.forestGrassColor.value = p.grassColor
        this.onStatus(`Forest: ${p.label}`)
      })
      groundPresets.appendChild(btn)
    }
    box.appendChild(groundPresets)

    const groundRow = document.createElement('div')
    groundRow.className = 'editor-sculpt-row'
    groundRow.style.alignItems = 'center'
    groundRow.style.flexWrap = 'wrap'
    groundRow.style.gap = '12px'

    const groundLbl = document.createElement('label')
    groundLbl.className = 'editor-sculpt-check'
    groundLbl.style.display = 'flex'
    groundLbl.style.alignItems = 'center'
    groundLbl.style.gap = '6px'
    groundLbl.append('Ground color')
    this.forestGroundColor = document.createElement('input')
    this.forestGroundColor.type = 'color'
    this.forestGroundColor.addEventListener('input', () => {
      this.patchForest({ groundColor: this.forestGroundColor!.value })
    })
    groundLbl.appendChild(this.forestGroundColor)
    groundRow.appendChild(groundLbl)

    const grassLbl = document.createElement('label')
    grassLbl.className = 'editor-sculpt-check'
    grassLbl.style.display = 'flex'
    grassLbl.style.alignItems = 'center'
    grassLbl.style.gap = '6px'
    grassLbl.title =
      'Blade tint for outer forest grass patches (environment.forest.grassColor). Not paint Ez Grass.'
    grassLbl.append('Grass color')
    this.forestGrassColor = document.createElement('input')
    this.forestGrassColor.type = 'color'
    this.forestGrassColor.addEventListener('input', () => {
      this.patchForest({ grassColor: this.forestGrassColor!.value })
    })
    grassLbl.appendChild(this.forestGrassColor)
    groundRow.appendChild(grassLbl)
    box.appendChild(groundRow)

    const treesTitle = document.createElement('div')
    treesTitle.className = 'editor-sculpt-title'
    treesTitle.textContent = 'Trees'
    treesTitle.style.cssText = 'margin-top:8px'
    box.appendChild(treesTitle)

    this.forestTreeSliders = []
    this.forestTreeValues = []
    for (let i = 0; i < FOREST_TREE_LABELS.length; i++) {
      const idx = i
      const row = this.sliderRow(
        FOREST_TREE_LABELS[i]!,
        0,
        2,
        FOREST_DEFAULTS.treeDensity[i] ?? 1,
        (v) => {
          const cur = resolveForestSettings(this.refApi?.getEnvironment?.()?.forest)
          const treeDensity = [...cur.treeDensity]
          treeDensity[idx] = v
          this.patchForest({ treeDensity })
          this.onStatus(`${FOREST_TREE_LABELS[idx]} density ×${v.toFixed(2)}`)
        }
      )
      this.forestTreeSliders.push(row.querySelector('input') as HTMLInputElement)
      this.forestTreeValues.push(row.querySelector('span') as HTMLSpanElement)
      box.appendChild(row)
    }

    const rocksTitle = document.createElement('div')
    rocksTitle.className = 'editor-sculpt-title'
    rocksTitle.textContent = 'Rocks'
    rocksTitle.style.cssText = 'margin-top:8px'
    box.appendChild(rocksTitle)

    this.forestRockSliders = []
    this.forestRockValues = []
    for (let i = 0; i < FOREST_ROCK_LABELS.length; i++) {
      const idx = i
      const row = this.sliderRow(
        FOREST_ROCK_LABELS[i]!,
        0,
        2,
        FOREST_DEFAULTS.rockDensity[i] ?? 1,
        (v) => {
          const cur = resolveForestSettings(this.refApi?.getEnvironment?.()?.forest)
          const rockDensity = [...cur.rockDensity]
          rockDensity[idx] = v
          this.patchForest({ rockDensity })
          this.onStatus(`${FOREST_ROCK_LABELS[idx]} density ×${v.toFixed(2)}`)
        }
      )
      this.forestRockSliders.push(row.querySelector('input') as HTMLInputElement)
      this.forestRockValues.push(row.querySelector('span') as HTMLSpanElement)
      box.appendChild(row)
    }

    const bushRow = this.sliderRow('Bushes', 0, 2, FOREST_DEFAULTS.bushDensity, (v) => {
      this.patchForest({ bushDensity: v })
      this.onStatus(`Bush density ×${v.toFixed(2)}`)
    })
    this.forestBushSlider = bushRow.querySelector('input') as HTMLInputElement
    this.forestBushValue = bushRow.querySelector('span') as HTMLSpanElement
    bushRow.style.marginTop = '8px'
    box.appendChild(bushRow)

    const resetRow = document.createElement('div')
    resetRow.className = 'editor-sculpt-row'
    resetRow.style.marginTop = '8px'
    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'editor-sculpt-btn'
    resetBtn.textContent = 'Reset forest defaults'
    resetBtn.addEventListener('click', () => {
      this.pendingForest = {}
      if (this.forestPatchTimer) window.clearTimeout(this.forestPatchTimer)
      this.forestPatchTimer = 0
      void this.refApi?.patchEnvironment?.({
        forest: {
          groundColor: FOREST_DEFAULTS.groundColor,
          grassColor: FOREST_DEFAULTS.grassColor,
          treeDensity: [...FOREST_DEFAULTS.treeDensity],
          rockDensity: [...FOREST_DEFAULTS.rockDensity],
          bushDensity: FOREST_DEFAULTS.bushDensity
        },
        replaceForest: true
      })
      this.syncEnvironmentUi()
      this.onStatus('Forest defaults reset')
    })
    resetRow.appendChild(resetBtn)
    box.appendChild(resetRow)
  }

  private patchForest(forest: SceneForestConfig): void {
    if (!this.refApi?.patchEnvironment) return
    this.pendingForest = { ...this.pendingForest, ...forest }
    if (forest.treeDensity) this.pendingForest.treeDensity = [...forest.treeDensity]
    if (forest.rockDensity) this.pendingForest.rockDensity = [...forest.rockDensity]
    if (this.forestPatchTimer) window.clearTimeout(this.forestPatchTimer)
    this.forestPatchTimer = window.setTimeout(() => {
      this.forestPatchTimer = 0
      const cur = resolveForestSettings(this.refApi!.getEnvironment?.()?.forest)
      const merged: SceneForestConfig = {
        groundColor:
          typeof this.pendingForest.groundColor === 'string'
            ? this.pendingForest.groundColor
            : cur.groundColor,
        grassColor:
          typeof this.pendingForest.grassColor === 'string'
            ? this.pendingForest.grassColor
            : cur.grassColor,
        treeDensity: this.pendingForest.treeDensity
          ? [...this.pendingForest.treeDensity]
          : [...cur.treeDensity],
        rockDensity: this.pendingForest.rockDensity
          ? [...this.pendingForest.rockDensity]
          : [...cur.rockDensity],
        bushDensity:
          typeof this.pendingForest.bushDensity === 'number'
            ? this.pendingForest.bushDensity
            : cur.bushDensity
      }
      this.pendingForest = {}
      void this.refApi!.patchEnvironment!({ forest: merged })
    }, 140)
  }

  private addMountainsControls(box: HTMLDivElement): void {
    const title = document.createElement('div')
    title.className = 'editor-sculpt-shading-biome-title'
    title.textContent = 'Mountains'
    box.appendChild(title)
    box.appendChild(
      this.hintEl('Haze live in editor · prop density applies on play client reload')
    )

    const presets = document.createElement('div')
    presets.className = 'editor-sculpt-row'
    presets.style.flexWrap = 'wrap'
    for (const p of MOUNTAINS_PRESETS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'editor-sculpt-btn'
      btn.textContent = p.label
      btn.addEventListener('click', () => {
        this.pendingMountains = {}
        if (this.mountainsPatchTimer) window.clearTimeout(this.mountainsPatchTimer)
        this.mountainsPatchTimer = 0
        void this.refApi?.patchEnvironment?.({
          mountains: { ...p.mountains },
          replaceMountains: true
        })
        this.syncEnvironmentUi()
        this.onStatus(`Mountains preset: ${p.label}`)
      })
      presets.appendChild(btn)
    }
    box.appendChild(presets)

    this.mtRockDensity = this.envSliderRow(box, 'Rock density', 0, 2, 0.05, 1, (v) => {
      this.patchMountains({ rockDensity: v })
    })
    this.mtTreeDensity = this.envSliderRow(box, 'Tree density', 0, 2, 0.05, 1, (v) => {
      this.patchMountains({ treeDensity: v })
    })
    this.mtBackdropDensity = this.envSliderRow(box, 'Backdrop peaks', 0, 2, 0.05, 1, (v) => {
      this.patchMountains({ backdropDensity: v })
    })
    this.mtHaze = this.envSliderRow(box, 'Mountain haze', 0, 0.04, 0.001, 0.01, (v) => {
      this.patchMountains({ haze: v })
    })

    const hazeColorRow = document.createElement('div')
    hazeColorRow.className = 'editor-sculpt-row'
    hazeColorRow.style.alignItems = 'center'
    const hazeL = document.createElement('label')
    hazeL.className = 'editor-sculpt-check'
    hazeL.style.display = 'flex'
    hazeL.style.alignItems = 'center'
    hazeL.style.gap = '6px'
    hazeL.append('Haze color')
    this.mtHazeColor = document.createElement('input')
    this.mtHazeColor.type = 'color'
    this.mtHazeColor.addEventListener('input', () => {
      this.patchMountains({ hazeColor: this.mtHazeColor!.value })
    })
    hazeL.appendChild(this.mtHazeColor)
    hazeColorRow.appendChild(hazeL)
    box.appendChild(hazeColorRow)

    this.mtPeakSnowCb = this.envCheckRow(box, 'Peak snow ambient', (on) => {
      this.patchMountains({ peakSnow: on })
    })

    const jump = document.createElement('button')
    jump.type = 'button'
    jump.className = 'editor-sculpt-btn editor-sculpt-btn--primary'
    jump.textContent = 'Open FFTOCEAN (shore water) →'
    jump.addEventListener('click', () => this.setOpenPane('ocean'))
    box.appendChild(jump)

    const resetRow = document.createElement('div')
    resetRow.className = 'editor-sculpt-row'
    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'editor-sculpt-btn'
    resetBtn.textContent = 'Reset mountains defaults'
    resetBtn.addEventListener('click', () => {
      this.pendingMountains = {}
      if (this.mountainsPatchTimer) window.clearTimeout(this.mountainsPatchTimer)
      this.mountainsPatchTimer = 0
      void this.refApi?.patchEnvironment?.({
        mountains: { ...MOUNTAINS_DEFAULTS },
        replaceMountains: true
      })
      this.syncEnvironmentUi()
      this.onStatus('Mountains reset')
    })
    resetRow.appendChild(resetBtn)
    box.appendChild(resetRow)
  }

  private patchMountains(mountains: SceneMountainsConfig): void {
    if (!this.refApi?.patchEnvironment) return
    this.pendingMountains = { ...this.pendingMountains, ...mountains }
    if (this.mountainsPatchTimer) window.clearTimeout(this.mountainsPatchTimer)
    this.mountainsPatchTimer = window.setTimeout(() => {
      this.mountainsPatchTimer = 0
      const cur = this.refApi!.getEnvironment?.()?.mountains ?? {}
      const merged = { ...cur, ...this.pendingMountains }
      this.pendingMountains = {}
      void this.refApi!.patchEnvironment!({ mountains: merged })
    }, 120)
  }

  /** Dedicated 🌊 panel — full dallapozza / FFTOCEAN knobs. */
  private addOceanFftControls(box: HTMLDivElement): void {
    if (!this.refApi?.getEnvironment || !this.refApi.patchEnvironment) {
      box.appendChild(this.hintEl('Environment API not wired'))
      return
    }

    box.appendChild(
      this.hintEl(
        'Writes environment.water · island/water biomes. Mesh off = no water (not Water.js fallback).'
      )
    )

    this.oceanHintEl = document.createElement('div')
    this.oceanHintEl.className = 'editor-sculpt-hint editor-sculpt-hint--compact'
    this.oceanHintEl.dataset.role = 'ocean-hint'
    box.appendChild(this.oceanHintEl)

    this.envWaterEnabled = this.envCheckRow(box, 'Water mesh on (master)', (on) => {
      this.patchOcean({ enabled: on }, true)
    })
    this.envFftCb = this.envCheckRow(box, 'FFTOCEAN / dallapozza (WebGL2)', (on) => {
      this.patchOcean({ fft: on }, true)
    })

    // Core wave energy
    this.envAmpInput = this.envSliderRow(box, 'Amplitude', 0, 0.05, 0.001, 0.01, (v) => {
      this.patchOcean({ amplitude: v }, true)
    })
    this.envWindInput = this.envSliderRow(box, 'Wind speed', 0, 40, 0.5, 15, (v) => {
      this.patchOcean({ windSpeed: v }, true)
    })
    this.envDisplaceInput = this.envSliderRow(box, 'Displacement scale', 0, 5, 0.05, 1, (v) => {
      this.patchOcean({ displacementScale: v }, true)
    })
    this.envChoppyInput = this.envSliderRow(box, 'Choppy (peaks)', 0, 5, 0.05, 2, (v) => {
      this.patchOcean({ choppyScale: v }, true)
    })

    // Quality / sim
    this.envFftResSelect = this.envSelectRow(
      box,
      'FFT resolution',
      [32, 64, 128, 256, 512].map((n) => ({ value: String(n), label: String(n) })),
      '128',
      (v) => this.patchOcean({ fftResolution: Number(v) }, true)
    )
    this.envMeshResSelect = this.envSelectRow(
      box,
      'Mesh resolution',
      [64, 128, 256, 384, 512].map((n) => ({ value: String(n), label: String(n) })),
      '256',
      (v) => this.patchOcean({ meshResolution: Number(v) }, true)
    )
    this.envSimHzInput = this.envSliderRow(box, 'Sim Hz', 5, 60, 1, 15, (v) => {
      this.patchOcean({ simulationHz: v }, true)
    })

    // Look
    this.envFoamThreshInput = this.envSliderRow(box, 'Foam threshold', 0, 2, 0.05, 0.4, (v) => {
      this.patchOcean({ foamThreshold: v }, true)
    })
    this.envSpecInput = this.envSliderRow(box, 'Specular', 0, 12, 0.1, 4.7, (v) => {
      this.patchOcean({ specularIntensity: v }, true)
    })

    const colorRow = document.createElement('div')
    colorRow.className = 'editor-sculpt-row'
    colorRow.style.alignItems = 'center'
    const deepL = document.createElement('label')
    deepL.className = 'editor-sculpt-check'
    deepL.style.display = 'flex'
    deepL.style.alignItems = 'center'
    deepL.style.gap = '6px'
    deepL.append('Deep')
    this.envDeepColor = document.createElement('input')
    this.envDeepColor.type = 'color'
    this.envDeepColor.addEventListener('input', () => {
      this.patchOcean({ waterDeep: this.envDeepColor!.value }, true)
    })
    deepL.appendChild(this.envDeepColor)
    const shallowL = document.createElement('label')
    shallowL.className = 'editor-sculpt-check'
    shallowL.style.display = 'flex'
    shallowL.style.alignItems = 'center'
    shallowL.style.gap = '6px'
    shallowL.append('Shallow')
    this.envShallowColor = document.createElement('input')
    this.envShallowColor.type = 'color'
    this.envShallowColor.addEventListener('input', () => {
      this.patchOcean({ waterShallow: this.envShallowColor!.value }, true)
    })
    shallowL.appendChild(this.envShallowColor)
    colorRow.appendChild(deepL)
    colorRow.appendChild(shallowL)
    box.appendChild(colorRow)

    const note = document.createElement('div')
    note.className = 'editor-sculpt-hint editor-sculpt-hint--compact'
    note.textContent =
      'Surface height: ⚙ → Water To. FFT off = Water.js only. Mesh off = nothing. 💧 = viewport hide.'
    box.appendChild(note)

    const resetRow = document.createElement('div')
    resetRow.className = 'editor-sculpt-row'
    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'editor-sculpt-btn'
    resetBtn.textContent = 'Reset FFTOCEAN defaults'
    resetBtn.title = 'Restore dallapozza defaults (amplitude, wind, colors, …)'
    resetBtn.addEventListener('click', () => this.resetOceanDefaults())
    resetRow.appendChild(resetBtn)
    box.appendChild(resetRow)
  }

  private resetOceanDefaults(): void {
    // Match FFT_OCEAN_DEFAULTS / SceneWaterConfig field names (dallapozza).
    const water: SceneWaterConfig = {
      enabled: true,
      fft: true,
      amplitude: 0.01,
      windSpeed: 15,
      windDirection: { x: 0.4, z: 0.8 },
      displacementScale: 1,
      choppyScale: 2,
      fftResolution: 128,
      meshResolution: 256,
      simulationHz: 15,
      clipLevels: 5,
      waterDeep: '#52b9e5',
      waterShallow: '#59cdff',
      foamThreshold: 0.4,
      foamScale: 7,
      foamPower: 0.5,
      specularIntensity: 4.7
    }
    this.pendingOcean = {}
    if (this.oceanPatchTimer) window.clearTimeout(this.oceanPatchTimer)
    this.oceanPatchTimer = 0
    // Full replace so stale custom water keys don't linger after reset.
    void this.refApi?.patchEnvironment?.({ water, replaceWater: true })
    this.syncEnvironmentUi()
    this.onStatus('FFTOCEAN reset to defaults')
  }

  private hintEl(text: string): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'editor-sculpt-hint editor-sculpt-hint--compact'
    el.textContent = text
    return el
  }

  /** Debounced merge write of environment.water + rebuild preview. */
  private patchOcean(water: SceneWaterConfig, _rebuild: boolean): void {
    if (!this.refApi?.patchEnvironment) return
    this.pendingOcean = { ...this.pendingOcean, ...water }
    if (this.oceanPatchTimer) window.clearTimeout(this.oceanPatchTimer)
    this.oceanPatchTimer = window.setTimeout(() => {
      this.oceanPatchTimer = 0
      const cur = this.refApi!.getEnvironment?.()?.water ?? {}
      const merged = { ...cur, ...this.pendingOcean }
      this.pendingOcean = {}
      void this.refApi!.patchEnvironment!({ water: merged })
    }, 150)
  }

  private envCheckRow(
    parent: HTMLElement,
    label: string,
    onChange: (on: boolean) => void
  ): HTMLInputElement {
    const row = document.createElement('label')
    row.className = 'editor-sculpt-check'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.addEventListener('change', () => onChange(cb.checked))
    row.appendChild(cb)
    row.append(` ${label}`)
    parent.appendChild(row)
    return cb
  }

  private envSliderRow(
    parent: HTMLElement,
    label: string,
    min: number,
    max: number,
    step: number,
    initial: number,
    onChange: (v: number) => void
  ): HTMLInputElement {
    const wrap = document.createElement('div')
    wrap.className = 'editor-sculpt-slider'
    const head = document.createElement('div')
    head.style.display = 'flex'
    head.style.justifyContent = 'space-between'
    head.style.gap = '8px'
    const lbl = document.createElement('label')
    lbl.textContent = label
    const val = document.createElement('span')
    val.textContent = String(initial)
    head.appendChild(lbl)
    head.appendChild(val)
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    input.value = String(initial)
    input.addEventListener('input', () => {
      const v = Number(input.value)
      val.textContent = Number.isInteger(step) ? String(v) : v.toFixed(step < 0.01 ? 3 : 2)
      if (Number.isFinite(v)) onChange(v)
    })
    wrap.appendChild(head)
    wrap.appendChild(input)
    parent.appendChild(wrap)
    return input
  }

  private envSelectRow(
    parent: HTMLElement,
    label: string,
    options: { value: string; label: string }[],
    initial: string,
    onChange: (v: string) => void
  ): HTMLSelectElement {
    const wrap = document.createElement('label')
    wrap.className = 'editor-env-field'
    const cap = document.createElement('span')
    cap.className = 'editor-env-field-label'
    cap.textContent = label
    wrap.appendChild(cap)
    const select = document.createElement('select')
    select.className = 'editor-env-select'
    for (const o of options) {
      const opt = document.createElement('option')
      opt.value = o.value
      opt.textContent = o.label
      select.appendChild(opt)
    }
    select.value = initial
    select.addEventListener('change', () => onChange(select.value))
    wrap.appendChild(select)
    parent.appendChild(wrap)
    return select
  }

  /**
   * @param kindOverride Use when switching biomes before async patchEnvironment finishes,
   * so the correct sub-panel (desert vs land vs space) shows immediately.
   */
  private syncEnvironmentUi(kindOverride?: SceneEnvironmentKind): void {
    const env = this.refApi?.getEnvironment?.() ?? { kind: kindOverride ?? 'none' }
    const kind = kindOverride ?? readEnvironmentKind(env)
    const profile = LANDSCAPE_ENVIRONMENTS[kind]
    const showOcean = waterShowsOceanUi(kind)
    const isSpace = kind === 'space'
    const isDesert = kind === 'desert'
    const isLand = kind === 'land'
    const isForest = kind === 'forest'
    const isMountains = kind === 'mountains'

    if (this.biomeHintEl) {
      if (isSpace) {
        this.biomeHintEl.textContent =
          'Space · water off · void / stars / rim below (live preview)'
      } else if (isDesert) {
        this.biomeHintEl.textContent =
          'Desert · dunes, sand, rocks, dust & tumbleweeds'
      } else if (isLand) {
        // Controls below are self-explanatory — no banner copy.
        this.biomeHintEl.textContent = ''
      } else if (isForest) {
        this.biomeHintEl.textContent = ''
      } else if (isMountains) {
        this.biomeHintEl.textContent =
          'Mountains · prop density + haze · shore water via FFT below'
      } else if (kind === 'island' || kind === 'water') {
        this.biomeHintEl.textContent =
          `${kind} · ocean on · use 🌊 for FFT waves · 💧 toggles preview`
      } else if (kind === 'genesis') {
        this.biomeHintEl.textContent = 'Genesis · city sky · no ocean / no empty-land clutter'
      } else if (kind === 'none') {
        this.biomeHintEl.textContent = 'None · void sky · authoring blank'
      } else {
        this.biomeHintEl.textContent = `Biome “${kind}” · showWater=${profile?.showWater ?? false}`
      }
      this.biomeHintEl.hidden = !this.biomeHintEl.textContent.trim()
    }

    this.spacePanelEl?.classList.toggle('editor-sculpt-tools--hidden', !isSpace)
    this.desertPanelEl?.classList.toggle('editor-sculpt-tools--hidden', !isDesert)
    this.landPanelEl?.classList.toggle('editor-sculpt-tools--hidden', !isLand)
    this.forestPanelEl?.classList.toggle('editor-sculpt-tools--hidden', !isForest)
    this.mountainsPanelEl?.classList.toggle('editor-sculpt-tools--hidden', !isMountains)
    // Mountains has its own FFT jump inside panel; hide generic jump for mountains.
    this.oceanJumpBtn?.classList.toggle(
      'editor-sculpt-tools--hidden',
      !showOcean || isMountains
    )
    this.windShaderRowEl?.classList.toggle(
      'editor-sculpt-tools--hidden',
      isSpace || isDesert || isMountains || !(isLand || isForest)
    )
    this.dryBiomeNoteEl?.classList.toggle(
      'editor-sculpt-tools--hidden',
      showOcean || isSpace || isDesert || isLand || isForest || isMountains
    )

    if (this.envWindShaderCb) {
      this.envWindShaderCb.checked = env.windShader !== false
    }

    const setRangeEl = (el: HTMLInputElement | null, v: number) => {
      if (!el) return
      el.value = String(v)
      const span = el.parentElement?.querySelector('span')
      if (span && el.type === 'range') {
        const step = Number(el.step) || 1
        span.textContent = Number.isInteger(step) ? String(v) : v.toFixed(step < 0.01 ? 3 : 2)
      }
    }

    // Space atmosphere controls
    const sp = resolveSpaceSettings(env.space)
    if (this.spaceSkyColor) this.spaceSkyColor.value = normalizeHexColor(sp.skyColor, '#020208')
    if (this.spaceNebulaColor) {
      this.spaceNebulaColor.value = normalizeHexColor(sp.nebulaColor, '#1a0a3a')
    }
    if (this.spaceRimColor) this.spaceRimColor.value = normalizeHexColor(sp.rimColor, '#6ecbff')
    if (this.spaceStarsCb) this.spaceStarsCb.checked = sp.stars
    setRangeEl(this.spaceStarDensity, sp.starDensity)
    setRangeEl(this.spaceStarBrightness, sp.starBrightness)
    setRangeEl(this.spaceTwinkle, sp.twinkle)
    setRangeEl(this.spaceAmbient, sp.ambient)
    setRangeEl(this.spaceRimIntensity, sp.rimIntensity)
    setRangeEl(this.spaceFogDensity, sp.fogDensity)

    // Desert
    const ds = resolveDesertSettings(env.desert)
    if (this.desertSandColor) {
      this.desertSandColor.value = normalizeHexColor(ds.sandColor, '#d4a858')
    }
    setRangeEl(this.desertRockDensity, ds.rockDensity)
    setRangeEl(this.desertPerlinScale, ds.perlinScale)
    setRangeEl(this.desertPerlinThreshold, ds.perlinThreshold)
    setRangeEl(this.desertHaze, ds.haze)
    if (this.desertDustStormCb) this.desertDustStormCb.checked = ds.dustStorm
    setRangeEl(this.desertDustIntensity, ds.dustIntensity)
    if (this.desertTumbleweedsCb) this.desertTumbleweedsCb.checked = ds.tumbleweeds
    setRangeEl(this.desertTumbleweedCount, ds.tumbleweedCount)
    if (this.desertAcrossParcelsCb) this.desertAcrossParcelsCb.checked = ds.acrossParcels
    if (this.desertDunesCb) this.desertDunesCb.checked = ds.dunes
    if (this.desertDunesOnParcelsCb) this.desertDunesOnParcelsCb.checked = ds.dunesOnParcels
    setRangeEl(this.desertDuneHeight, ds.duneHeight)
    setRangeEl(this.desertDuneWidth, ds.duneWidth)
    setRangeEl(this.desertDuneLength, ds.duneLength)
    setRangeEl(this.desertDuneWind, ds.duneWindDeg)
    setRangeEl(this.desertDuneRipple, ds.duneRipple)

    // Land
    const land = resolveLandSettings(env.land)
    if (this.landGroundColor) {
      this.landGroundColor.value = normalizeHexColor(land.groundColor, '#c43c2c')
    }
    if (this.landGrassColor) {
      this.landGrassColor.value = normalizeHexColor(land.grassColor, LAND_DEFAULTS.grassColor)
    }
    if (this.landGrassDensitySlider) {
      this.landGrassDensitySlider.value = String(land.grassDensity)
    }
    if (this.landGrassDensityValue) {
      this.landGrassDensityValue.textContent = land.grassDensity.toFixed(2)
    }

    // Forest
    const forest = resolveForestSettings(env.forest)
    if (this.forestGroundColor) {
      this.forestGroundColor.value = normalizeHexColor(forest.groundColor, FOREST_DEFAULTS.groundColor)
    }
    if (this.forestGrassColor) {
      this.forestGrassColor.value = normalizeHexColor(forest.grassColor, FOREST_DEFAULTS.grassColor)
    }
    for (let i = 0; i < this.forestTreeSliders.length; i++) {
      const v = forest.treeDensity[i] ?? 1
      const sl = this.forestTreeSliders[i]
      const val = this.forestTreeValues[i]
      if (sl) sl.value = String(v)
      if (val) val.textContent = v.toFixed(2)
    }
    for (let i = 0; i < this.forestRockSliders.length; i++) {
      const v = forest.rockDensity[i] ?? 1
      const sl = this.forestRockSliders[i]
      const val = this.forestRockValues[i]
      if (sl) sl.value = String(v)
      if (val) val.textContent = v.toFixed(2)
    }
    if (this.forestBushSlider) this.forestBushSlider.value = String(forest.bushDensity)
    if (this.forestBushValue) this.forestBushValue.textContent = forest.bushDensity.toFixed(2)

    // Mountains
    const mt = resolveMountainsSettings(env.mountains)
    setRangeEl(this.mtRockDensity, mt.rockDensity)
    setRangeEl(this.mtTreeDensity, mt.treeDensity)
    setRangeEl(this.mtBackdropDensity, mt.backdropDensity)
    setRangeEl(this.mtHaze, mt.haze)
    if (this.mtHazeColor) this.mtHazeColor.value = normalizeHexColor(mt.hazeColor, '#9bb0c4')
    if (this.mtPeakSnowCb) this.mtPeakSnowCb.checked = mt.peakSnow

    if (this.oceanHintEl) {
      if (kind === 'island') {
        this.oceanHintEl.textContent =
          'Island = circle (parcel centre → corner) + thin beach · open beaches = water biome'
      } else if (kind === 'water') {
        this.oceanHintEl.textContent =
          'Open ocean · FFT on = dallapozza GPGPU · height = Water To (🧱 Height materials)'
      } else if (kind === 'mountains') {
        this.oceanHintEl.textContent = 'Mountains water · FFT on for GPGPU waves'
      } else {
        this.oceanHintEl.textContent = `Biome “${kind}” has no ocean — pick 🏝 / 🌊 / 🏔 on the biome rail`
      }
    }
    // Keep ocean knobs full brightness even on dry biomes — the hint covers “no ocean”.
    this.oceanBox?.classList.remove('editor-env-water--inactive')

    for (const [k, btn] of this.biomeDockButtons) {
      const on = k === kind
      btn.classList.toggle('editor-viewport-dock-btn--active', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    }

    const w: SceneWaterConfig = env.water ?? {}
    if (this.envWaterEnabled) this.envWaterEnabled.checked = w.enabled !== false
    if (this.envFftCb) this.envFftCb.checked = w.fft !== false
    const setRange = (el: HTMLInputElement | null, v: number | undefined, fallback: number) => {
      if (!el) return
      const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
      el.value = String(n)
      const span = el.parentElement?.querySelector('span')
      if (span && el.type === 'range') {
        const step = Number(el.step) || 1
        span.textContent = Number.isInteger(step) ? String(n) : n.toFixed(step < 0.01 ? 3 : 2)
      }
    }
    setRange(this.envAmpInput, w.amplitude, 0.01)
    setRange(this.envWindInput, w.windSpeed, 15)
    setRange(this.envDisplaceInput, w.displacementScale, 1)
    setRange(this.envChoppyInput, w.choppyScale, 2)
    setRange(this.envSimHzInput, w.simulationHz, 15)
    setRange(this.envFoamThreshInput, w.foamThreshold, 0.4)
    setRange(this.envSpecInput, w.specularIntensity, 4.7)
    if (this.envFftResSelect) {
      this.envFftResSelect.value = String(w.fftResolution ?? 128)
    }
    if (this.envMeshResSelect) {
      this.envMeshResSelect.value = String(w.meshResolution ?? 256)
    }
    if (this.envDeepColor) {
      this.envDeepColor.value = normalizeHexColor(w.waterDeep, '#52b9e5')
    }
    if (this.envShallowColor) {
      this.envShallowColor.value = normalizeHexColor(w.waterShallow, '#59cdff')
    }
  }

  private addGrassControls(): void {
    const note = document.createElement('div')
    note.className = 'editor-sculpt-hint editor-sculpt-hint--compact'
    note.textContent = 'Ez-tree blades · ThreejsClient only · plant / erase / color'
    this.grassToolsHost.appendChild(note)

    const colorRow = document.createElement('div')
    colorRow.className = 'editor-sculpt-row'
    colorRow.style.alignItems = 'center'
    colorRow.style.gap = '10px'

    const colorLabel = document.createElement('label')
    colorLabel.className = 'editor-sculpt-check'
    colorLabel.textContent = 'Blade color'
    colorLabel.style.display = 'flex'
    colorLabel.style.alignItems = 'center'
    colorLabel.style.gap = '8px'

    this.ezGrassBladeColorInput = document.createElement('input')
    this.ezGrassBladeColorInput.type = 'color'
    this.ezGrassBladeColorInput.value = terrainColorToHex(this.session.getSettings().grassColor)
    this.ezGrassBladeColorInput.title = 'Color for newly planted blades'
    this.ezGrassBladeColorInput.addEventListener('input', () => {
      const hex = terrainColorFromHex(this.ezGrassBladeColorInput!.value)
      this.session.patchSettings({ paintLayer: 'grass', grassColor: hex, splatErase: false })
      this.session.refreshBrushRing()
      this.onStatus(`Ez Grass color ${this.ezGrassBladeColorInput!.value}`)
    })
    colorLabel.appendChild(this.ezGrassBladeColorInput)
    colorRow.appendChild(colorLabel)

    // Quick presets (green / dry / dark / default red-grass).
    const presets: { hex: number; label: string }[] = [
      { hex: 0x5a9e4a, label: 'Meadow' },
      { hex: 0xc4a35a, label: 'Dry' },
      { hex: 0x2f5c28, label: 'Dark' },
      { hex: 0xd44831, label: 'Default' }
    ]
    for (const p of presets) {
      const sw = document.createElement('button')
      sw.type = 'button'
      sw.title = p.label
      sw.className = 'editor-sculpt-swatch'
      sw.style.background = terrainColorToHex(p.hex)
      sw.addEventListener('click', () => {
        this.session.patchSettings({ paintLayer: 'grass', grassColor: p.hex, splatErase: false })
        if (this.ezGrassBladeColorInput) {
          this.ezGrassBladeColorInput.value = terrainColorToHex(p.hex)
        }
        this.session.refreshBrushRing()
        this.onStatus(`Ez Grass: ${p.label}`)
      })
      colorRow.appendChild(sw)
    }
    this.grassToolsHost.appendChild(colorRow)

    const row = document.createElement('div')
    row.className = 'editor-sculpt-row'

    const plant = document.createElement('button')
    plant.type = 'button'
    plant.textContent = 'Plant blades'
    plant.className = 'editor-sculpt-btn'
    plant.addEventListener('click', () => {
      this.session.patchSettings({ paintLayer: 'grass', splatErase: false })
      this.onStatus('Ez Grass: plant blades')
    })
    row.appendChild(plant)

    const erase = document.createElement('button')
    erase.type = 'button'
    erase.textContent = 'Erase blades'
    erase.className = 'editor-sculpt-btn'
    erase.addEventListener('click', () => {
      this.session.patchSettings({ paintLayer: 'grass', splatErase: true })
      this.onStatus('Ez Grass: erase blades')
    })
    row.appendChild(erase)

    this.grassToolsHost.appendChild(row)
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
    this.addSculptClearActions(this.heightToolsHost)
  }

  /** Reset heightmap / clear paint+grass — undoable. */
  private addSculptClearActions(parent: HTMLElement): void {
    const box = document.createElement('div')
    box.style.cssText =
      'margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.12)'

    const title = document.createElement('div')
    title.className = 'editor-sculpt-title'
    title.textContent = 'Reset'
    title.style.cssText = 'font-size:12px;margin-bottom:6px;opacity:0.9'
    box.appendChild(title)

    const hint = document.createElement('div')
    hint.style.cssText = 'font-size:11px;opacity:0.65;margin-bottom:8px;line-height:1.35'
    hint.textContent = 'Undo restores. Does not change biome. Save to bake.'
    box.appendChild(hint)

    const row = document.createElement('div')
    row.className = 'editor-sculpt-row'
    row.style.cssText = 'flex-wrap:wrap;gap:6px'

    const resetH = document.createElement('button')
    resetH.type = 'button'
    resetH.className = 'editor-sculpt-btn'
    resetH.textContent = 'Reset heights'
    resetH.title = 'Flatten heightmap to seafloor (under ocean). Keeps paint & grass.'
    resetH.addEventListener('click', () => {
      if (
        !window.confirm(
          'Reset all heights to seafloor?\n\nPaint and grass stay. Undo restores the previous heightmap.'
        )
      ) {
        return
      }
      this.session.resetHeightsToSeafloor()
      this.onStatus('Heights reset to seafloor')
    })
    row.appendChild(resetH)

    const clearPaint = document.createElement('button')
    clearPaint.type = 'button'
    clearPaint.className = 'editor-sculpt-btn'
    clearPaint.textContent = 'Clear paint & grass'
    clearPaint.title = 'Remove splat materials, lava, and ez-tree grass. Keeps heights.'
    clearPaint.addEventListener('click', () => {
      if (
        !window.confirm(
          'Clear all surface paint, lava, and grass blades?\n\nHeights stay. Undo restores paint & grass.'
        )
      ) {
        return
      }
      this.session.clearPaintAndGrass()
      this.onStatus('Paint, lava, and grass cleared')
    })
    row.appendChild(clearPaint)

    const resetAll = document.createElement('button')
    resetAll.type = 'button'
    resetAll.className = 'editor-sculpt-btn'
    resetAll.textContent = 'Reset all'
    resetAll.title = 'Seafloor heights + no paint + no grass'
    resetAll.addEventListener('click', () => {
      if (
        !window.confirm(
          'Reset everything?\n\n• Heights → seafloor\n• Paint / lava / grass → cleared\n\nUndo restores the previous state.'
        )
      ) {
        return
      }
      this.session.resetAllSculpt()
      this.onStatus('All sculpt data reset')
    })
    row.appendChild(resetAll)

    box.appendChild(row)
    parent.appendChild(box)
  }

  /**
   * Minecraft-like height starters — top-level dock pane (🎲).
   * Fills sculpt buffers; biome dock stays backdrop-only unless “match biome” is on.
   * Confirm if dirty · undo restores · Save still bakes terrain.glb.
   */
  private addTerrainStarters(parent: HTMLElement): void {
    const box = document.createElement('div')
    box.className = 'editor-terrain-starters'
    box.style.cssText = 'display:flex;flex-direction:column;gap:8px'

    const hint = document.createElement('div')
    hint.className = 'editor-sculpt-hint'
    hint.textContent =
      'Seed a height template across the parcel footprint. Undo restores. Save bakes terrain.glb. Biome icons never wipe height.'
    box.appendChild(hint)

    const cards = document.createElement('div')
    cards.className = 'editor-sculpt-row'
    cards.style.cssText = 'flex-wrap:wrap;gap:6px'
    for (const t of TERRAIN_STARTER_TEMPLATES) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'editor-sculpt-btn'
      btn.textContent = `${t.emoji} ${t.label}`
      btn.title = t.tip
      btn.addEventListener('click', () => {
        this.starterSelected = t.id
        this.syncStarterTemplateHighlight()
        this.onStatus(`Starter: ${t.label}`)
      })
      this.starterTemplateButtons.set(t.id, btn)
      cards.appendChild(btn)
    }
    box.appendChild(cards)
    this.syncStarterTemplateHighlight()

    const seedRow = document.createElement('div')
    seedRow.style.cssText =
      'display:flex;align-items:center;gap:6px;flex-wrap:wrap'
    const seedLab = document.createElement('label')
    seedLab.textContent = 'Seed'
    seedLab.style.cssText = 'font-size:11px;opacity:0.8'
    const seedIn = document.createElement('input')
    seedIn.type = 'text'
    seedIn.className = 'editor-sculpt-input'
    seedIn.value = String(randomTerrainSeed())
    seedIn.placeholder = 'number or pizza-island'
    seedIn.style.cssText = 'flex:1;min-width:100px;font-size:12px;padding:4px 6px'
    this.starterSeedInput = seedIn
    const reroll = document.createElement('button')
    reroll.type = 'button'
    reroll.className = 'editor-sculpt-btn'
    reroll.textContent = '↻'
    reroll.title = 'Re-roll seed'
    reroll.addEventListener('click', () => {
      if (this.starterSeedInput) this.starterSeedInput.value = String(randomTerrainSeed())
    })
    seedRow.appendChild(seedLab)
    seedRow.appendChild(seedIn)
    seedRow.appendChild(reroll)
    box.appendChild(seedRow)

    const matchRow = document.createElement('label')
    matchRow.style.cssText =
      'display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer'
    const matchCb = document.createElement('input')
    matchCb.type = 'checkbox'
    // Off by default — starters only rewrite the heightmap; keep current biome.
    matchCb.checked = false
    this.starterMatchBiomeCb = matchCb
    matchRow.appendChild(matchCb)
    matchRow.appendChild(
      document.createTextNode('Also switch biome to match starter (optional)')
    )
    matchRow.title =
      'Off (default): seed only populates heights on your current biome. On: also sets environment.kind.'
    box.appendChild(matchRow)

    const apply = document.createElement('button')
    apply.type = 'button'
    apply.className = 'editor-sculpt-btn editor-sculpt-btn--primary'
    apply.textContent = 'Apply starter'
    apply.style.cssText = 'width:100%'
    apply.addEventListener('click', () => this.applySelectedTerrainStarter())
    box.appendChild(apply)

    // Clear seeded terrain (heights + paint + grass from starters / sculpt).
    const resetBox = document.createElement('div')
    resetBox.style.cssText =
      'margin-top:4px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.12);display:flex;flex-direction:column;gap:6px'
    const resetTitle = document.createElement('div')
    resetTitle.className = 'editor-sculpt-title'
    resetTitle.textContent = 'Reset'
    resetTitle.style.cssText = 'font-size:12px;opacity:0.9'
    resetBox.appendChild(resetTitle)
    const resetHint = document.createElement('div')
    resetHint.className = 'editor-sculpt-hint'
    resetHint.textContent =
      'Wipe seeded height + paint + grass back to empty seafloor. Does not change biome. Undo restores.'
    resetBox.appendChild(resetHint)
    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'editor-sculpt-btn'
    resetBtn.textContent = 'Clear all seeded'
    resetBtn.title = 'Seafloor heights + clear paint / lava / grass (undoable)'
    resetBtn.style.cssText = 'width:100%'
    resetBtn.addEventListener('click', () => this.clearAllSeededTerrain())
    resetBox.appendChild(resetBtn)
    box.appendChild(resetBox)

    parent.appendChild(box)
  }

  /** Wipe starter/sculpt seed result → seafloor heights + no paint/grass. Undoable. */
  private clearAllSeededTerrain(): void {
    if (
      !window.confirm(
        'Clear all seeded terrain?\n\n• Heights → seafloor\n• Paint / lava / grass → cleared\n\nBiome stays the same. Undo restores the previous state.'
      )
    ) {
      return
    }
    this.session.resetAllSculpt()
    this.onStatus('Cleared all seeded terrain (heights + paint + grass)')
  }

  private syncStarterTemplateHighlight(): void {
    for (const [id, btn] of this.starterTemplateButtons) {
      const on = id === this.starterSelected
      btn.classList.toggle('editor-sculpt-btn--active', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
  }

  private applySelectedTerrainStarter(): void {
    const seedRaw = this.starterSeedInput?.value?.trim() || String(randomTerrainSeed())
    const seed = seedFromString(seedRaw)
    if (this.starterSeedInput) this.starterSeedInput.value = String(seed)

    if (this.session.isSculptDirty()) {
      const ok = window.confirm(
        'Replace current sculpt with this starter?\n\nUndo will restore the previous heightmap. Save still bakes terrain.glb when you are ready.'
      )
      if (!ok) {
        this.onStatus('Starter cancelled')
        return
      }
    }

    const result = this.session.applyTerrainStarter({
      templateId: this.starterSelected,
      seed
    })
    if (!result.ok) {
      this.onStatus(result.message)
      return
    }

    const meta = TERRAIN_STARTER_TEMPLATES.find((t) => t.id === this.starterSelected)
    // Optional only — height seeds never force a biome by default.
    if (this.starterMatchBiomeCb?.checked && meta) {
      void this.refApi?.patchEnvironment?.({ kind: meta.matchKind })
    }

    const cols = Math.max(1, Math.round(result.widthM / 16))
    const rows = Math.max(1, Math.round(result.depthM / 16))
    const biomeNote = this.starterMatchBiomeCb?.checked
      ? ` · biome → ${meta?.matchKind ?? '?'}`
      : ' · biome unchanged'
    this.onStatus(
      `Applied ${result.label} · seed ${result.seed} · ${cols}×${rows} parcels (${result.widthM.toFixed(0)}×${result.depthM.toFixed(0)}m)${biomeNote}`
    )
  }

  private addSharedBrushSliders(parent: HTMLElement): void {
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
    parent.appendChild(radiusRow)

    const strengthRow = this.sliderRow('Strength', 0.05, 1, settings.brushStrength, (v) => {
      this.session.patchSettings({ brushStrength: v })
    })
    this.brushStrengthSlider = strengthRow.querySelector('input') as HTMLInputElement
    this.brushStrengthValue = strengthRow.querySelector('span') as HTMLSpanElement
    parent.appendChild(strengthRow)
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

  private addExportControls(parent: HTMLElement): void {
    const wrap = document.createElement('div')
    wrap.className = 'editor-sculpt-shading-box'

    const title = document.createElement('div')
    title.textContent = 'Export'
    title.className = 'editor-sculpt-shading-title'
    wrap.appendChild(title)

    const row = document.createElement('div')
    row.className = 'editor-sculpt-shading-row'
    const label = document.createElement('label')
    label.textContent = 'Segs / parcel'
    const select = document.createElement('select')
    select.className = 'editor-sculpt-select'
    for (const segs of TERRAIN_EXPORT_SEGMENT_PRESETS) {
      const opt = document.createElement('option')
      opt.value = String(segs)
      const spacingCm = Math.round((16 / segs) * 100)
      opt.textContent = `${segs} (~${spacingCm} cm)`
      select.appendChild(opt)
    }
    select.addEventListener('change', () => {
      const segs = Number(select.value)
      this.session.patchExportSettings({ exportSegmentsPerParcel: segs })
      this.onStatus(`Export: ${segs} segs/parcel`)
    })
    this.exportSegmentsSelect = select
    row.appendChild(label)
    row.appendChild(select)
    wrap.appendChild(row)
    parent.appendChild(wrap)
  }

  /** Project pane: undo / redo / save (moved off Guides). */
  private addActionButtons(parent: HTMLElement): void {
    const row = document.createElement('div')
    row.className = 'editor-sculpt-row'
    row.style.flexWrap = 'wrap'
    row.style.gap = '6px'
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
    save.textContent = 'Save'
    save.className = 'editor-sculpt-btn editor-sculpt-btn--primary'
    save.addEventListener('click', () => void this.refApi?.onSave?.())
    row.appendChild(undo)
    row.appendChild(redo)
    row.appendChild(save)
    parent.appendChild(row)
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
    this.syncDockHighlight()
    this.syncShadingLegend()

    for (const [mode, btn] of this.brushModeButtons) {
      this.paintBtnActive(btn, s.paintLayer === 'height' && s.brushMode === mode)
    }

    for (const ch of TERRAIN_SPLAT_PAINT_UI_ORDER) {
      const btn = this.splatChannelButtons.get(ch)
      if (!btn) continue
      const on = s.paintLayer === 'splat' && s.splatChannel === ch
      btn.classList.toggle('editor-sculpt-swatch--active', on)
    }

    if (this.ezGrassBladeColorInput) {
      const next = terrainColorToHex(s.grassColor)
      if (this.ezGrassBladeColorInput.value.toLowerCase() !== next.toLowerCase()) {
        this.ezGrassBladeColorInput.value = next
      }
    }

    if (this.openPane === null) {
      // keep last status
    } else if (s.paintLayer === 'height' && this.openPane === 'height') {
      this.statusEl.textContent = `Sculpt · ${s.brushMode}`
    } else if (s.paintLayer === 'grass' && this.openPane === 'grass') {
      this.statusEl.textContent = s.splatErase
        ? 'Ez Grass · erase'
        : `Ez Grass · ${terrainColorToHex(s.grassColor)}`
    } else if (s.paintLayer === 'splat' && this.openPane === 'splat') {
      this.statusEl.textContent = `Paint · ${TERRAIN_SPLAT_CHANNEL_LABELS[s.splatChannel]}`
    }
  }

  private paintBtnActive(btn: HTMLButtonElement, on: boolean): void {
    btn.classList.toggle('editor-sculpt-btn--active', on)
  }

  setStatus(msg: string): void {
    this.statusEl.textContent = msg
    this.onStatus(msg)
  }
}