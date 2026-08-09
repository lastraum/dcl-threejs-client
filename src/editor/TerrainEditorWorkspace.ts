import * as THREE from 'three'
import { sceneWorldBounds } from '../player/SceneBounds'
import { getProjectMeta, requestProjectRoot } from './localProjects/projectStore'
import type { ProjectRoot } from './localScene/projectRoot'
import { resolveLocalScene, type LocalSceneCache } from './localScene/resolveLocalScene'
import { EditorFlyCamera } from './EditorFlyCamera'
import { EditorTerrainSystem } from './terrain/EditorTerrainSystem'
import { EditorBiomeWater } from './terrain/EditorBiomeWater'
import { EditorGrassPaint } from './terrain/EditorGrassPaint'
import { TerrainSculptSession } from './terrain/TerrainSculptSession'
import { TerrainSculptPanel } from './ui/TerrainSculptPanel'
import { loadTerrainFromProject } from './terrain/loadTerrainFromProject'
import { terrainFootprintFromBounds } from './terrain/terrainFootprint'
import {
  loadProjectEnvironment,
  patchProjectEnvironment,
  readEnvironmentKind
} from './terrain/sceneEnvironmentIO'
import { readEnvironmentWindShader } from '../dcl/landscape/readEnvironmentWindShader'
import { LANDSCAPE_ENVIRONMENTS } from '../dcl/landscape/EnvironmentCatalog'
import { buildParcelLandscape } from '../dcl/landscape/Systems/RenderGroundSystem'
import { allHashesForProfile } from '../dcl/landscape/EnvironmentCatalog'
import { catalystAssetUrl } from '../dcl/landscape/Data/EmptyLandCatalog'
import { resolveFftOceanSettings } from '../environment/fftOcean/readFftOceanOverride'
import { SpaceSkyField } from '../environment/SpaceSkyField'
import { DclGenesisSky } from '../environment/DclGenesisSky'
import { celestialDirection } from '../environment/sunCycleSampler'
import type { DesertAtmosphere } from '../environment/DesertAtmosphere'
import { resolveMountainsSettings } from '../environment/mountainsDefaults'
import { resolveDesertSettings } from '../environment/desertDefaults'
import type {
  ResolvedScene,
  SceneEnvironmentConfig,
  SceneEnvironmentKind,
  SceneMetadata
} from '../dcl/content/types'
import { getSessionAssetCache } from '../rendering/AssetCache'
import { SceneHost } from '../rendering/SceneHost'
import { loadCompositeScene, type CompositeSceneHandle } from './composite/loadCompositeScene'
import { EditorViewportCompass } from './EditorViewportCompass'
import { EditorAxisGizmo } from './EditorAxisGizmo'
import { EditorMaxHeightGuide } from './EditorMaxHeightGuide'
import { EditorWorldBoundaryOutline } from './EditorWorldBoundaryOutline'
import { EditorAvatarScaleGuides } from './EditorAvatarScaleGuides'
import { EditorTerrainHeightHud } from './ui/EditorTerrainHeightHud'
import { EditorCameraResetButton } from './ui/EditorCameraResetButton'
import { PARCEL_SIZE } from '../dcl/content/types'
import { dclBoundsToThreeDisplay, dclToThreePos } from '../bridge/dclTransform'


export type TerrainEditorWorkspaceCallbacks = {
  onBack: () => void
  onReload?: () => void
}

function isTypingInField(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable
}

function addEditorLighting(scene: THREE.Scene): {
  hemi: THREE.HemisphereLight
  sun: THREE.DirectionalLight
} {
  const hemi = new THREE.HemisphereLight(0xb8d4ff, 0x3d4a2a, 0.55)
  const sun = new THREE.DirectionalLight(0xfff5e8, 1.05)
  sun.position.set(120, 220, 80)
  scene.add(hemi, sun)
  return { hemi, sun }
}

/** Midday TOD for editor outdoor sky (seconds since 00:00). */
const EDITOR_SKY_SECONDS = 12 * 3600
const _editorCelestial = new THREE.Vector3()

export class TerrainEditorWorkspace {
  private wrap: HTMLDivElement | null = null
  private host: SceneHost | null = null
  private composite: CompositeSceneHandle | null = null
  private localCache: LocalSceneCache | null = null
  private terrain: EditorTerrainSystem | null = null
  private editorWater: EditorBiomeWater | null = null
  private editorGrass: EditorGrassPaint | null = null
  private spaceSky: SpaceSkyField | null = null
  /** Outdoor Genesis sky dome (island / water / land / …) — not used for space. */
  private outdoorSky: DclGenesisSky | null = null
  private outdoorSkyLoad: Promise<void> | null = null
  /** Same landscape group the play client builds (`buildParcelLandscape`). */
  private landscapeRoot: THREE.Group | null = null
  private desertAtmo: DesertAtmosphere | null = null
  private landscapeRebuildTimer = 0
  private landscapeBuildGen = 0
  private editorHemi: THREE.HemisphereLight | null = null
  private editorSun: THREE.DirectionalLight | null = null
  private grassRebuildRaf = 0
  private sculpt: TerrainSculptSession | null = null
  private panel: TerrainSculptPanel | null = null
  private flyCamera: EditorFlyCamera | null = null
  private removeFrameListener: (() => void) | null = null
  private sceneEnv: SceneEnvironmentConfig = { kind: 'none' }
  private gridHelper: THREE.GridHelper | null = null
  private gridSizeM = 0
  private gridDivisions = 0
  private gridCenterDcl = { x: 0, z: 0 }
  private compass: EditorViewportCompass | null = null
  private heightHud: EditorTerrainHeightHud | null = null
  private cameraReset: EditorCameraResetButton | null = null
  private axisGizmo: EditorAxisGizmo | null = null
  private maxHeightGuide: EditorMaxHeightGuide | null = null
  /** True rectangular world footprint outline (+ parcel lines when small enough). */
  private worldBoundary: EditorWorldBoundaryOutline | null = null
  private avatarScaleGuides: EditorAvatarScaleGuides | null = null
  private projectRoot: ProjectRoot | null = null
  private keyHandler: ((e: KeyboardEvent) => void) | null = null
  private mouseUpHandler: (() => void) | null = null
  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null
  private mouseDownHandler: ((e: MouseEvent) => void) | null = null
  private mouseLeaveHandler: (() => void) | null = null

  constructor(
    private container: HTMLElement,
    private projectId: string,
    private callbacks: TerrainEditorWorkspaceCallbacks
  ) {}

  async mount(): Promise<void> {
    const meta = await getProjectMeta(this.projectId)
    const root = await requestProjectRoot(this.projectId)
    this.projectRoot = root

    this.wrap = document.createElement('div')
    this.wrap.className = 'editor-workspace'
    this.container.appendChild(this.wrap)

    const topBar = document.createElement('div')
    topBar.className = 'editor-workspace-topbar'
    const back = document.createElement('button')
    back.type = 'button'
    back.textContent = '← Projects'
    back.addEventListener('click', () => this.callbacks.onBack())
    const title = document.createElement('span')
    title.textContent = meta?.name ?? 'Scene editor'
    title.className = 'editor-workspace-title'
    topBar.appendChild(back)
    topBar.appendChild(title)
    this.wrap.appendChild(topBar)

    const body = document.createElement('div')
    body.className = 'editor-workspace-body'
    this.wrap.appendChild(body)

    const canvasHost = document.createElement('div')
    canvasHost.className = 'editor-workspace-canvas'
    body.appendChild(canvasHost)

    const status = document.createElement('div')
    status.className = 'editor-workspace-loading'
    status.textContent = 'Loading composite…'
    canvasHost.appendChild(status)

    this.localCache = await resolveLocalScene(this.projectId, root)
    const scene = this.localCache.scene
    const bounds = sceneWorldBounds(scene.parcels, scene.baseParcel)
    const widthM = bounds.maxX - bounds.minX
    const depthM = bounds.maxZ - bounds.minZ
    const displayBounds = dclBoundsToThreeDisplay(bounds)
    const gridSizeM = Math.max(widthM, depthM)
    const terrainFootprint = terrainFootprintFromBounds(scene.parcels, scene.baseParcel, bounds)

    const host = new SceneHost(canvasHost)
    this.host = host
    host.setOrbitEnabled(false)
    host.controls.enabled = false
    const lights = addEditorLighting(host.scene)
    this.editorHemi = lights.hemi
    this.editorSun = lights.sun

    const cam = host.camera
    cam.fov = 60
    cam.near = 0.05
    host.configureViewDistance(bounds)

    const assets = getSessionAssetCache()
    assets.setScene(scene)

    this.composite = await loadCompositeScene(scene, assets, host.scene, root, {
      onProgress: (msg) => {
        status.textContent = msg
      }
    })

    status.remove()

    const canvas = host.renderer.domElement
    canvas.tabIndex = 0
    canvas.style.outline = 'none'
    canvas.addEventListener('mousedown', () => canvas.focus())
    host.bindViewport(canvasHost, (w, h) => this.flyCamera?.onResize(w, h))
    this.flyCamera = new EditorFlyCamera(cam, canvas)
    this.flyCamera.onResize(canvasHost.clientWidth, canvasHost.clientHeight)
    this.flyCamera.focusSouthFacingNorth(displayBounds, scene.spawn.y)
    cam.far = Math.max(
      cam.far,
      EditorFlyCamera.overviewFarPlaneM(displayBounds, cam.fov)
    )
    cam.near = Math.min(0.5, cam.far / 50_000)
    cam.updateProjectionMatrix()
    this.compass = new EditorViewportCompass(canvasHost)
    this.heightHud = new EditorTerrainHeightHud(canvasHost)
    this.cameraReset = new EditorCameraResetButton(canvasHost, {
      onZoomIn: () => this.flyCamera?.zoomIn(),
      onZoomOut: () => this.flyCamera?.zoomOut(),
      onReset: () => this.flyCamera?.resetView()
    })
    this.removeFrameListener = host.addFrameListener((delta) => {
      this.flyCamera?.update(delta)
      this.compass?.updateFromCamera(cam, this.flyCamera)
      this.editorWater?.update(delta, cam)
      this.editorGrass?.update(delta)
      this.spaceSky?.update(delta, cam)
      this.tickOutdoorSky(delta, cam)
      this.desertAtmo?.update(delta)
      if (this.maxHeightGuide?.getVisible() && this.terrain) {
        this.maxHeightGuide.update(this.terrain.getMaxHeightSample())
      }
    })

    host.start()

    this.terrain = new EditorTerrainSystem(terrainFootprint)
    this.terrain.mount(host.scene)
    const terrainLoad = await loadTerrainFromProject(this.projectId, root, this.terrain)

    this.sceneEnv = await loadProjectEnvironment(root)
    const windShader = readEnvironmentWindShader({ environment: this.sceneEnv })
    try {
      const shading = this.terrain.getProceduralShading()
      this.editorWater = new EditorBiomeWater(
        host.scene,
        scene.parcels,
        scene.baseParcel,
        {
          widthM,
          depthM,
          originX: bounds.minX,
          originZ: bounds.minZ
        },
        host.renderer,
        () =>
          resolveFftOceanSettings({
            environment: this.sceneEnv
          } as SceneMetadata)
      )
      const kind = readEnvironmentKind(this.sceneEnv)
      const profile = LANDSCAPE_ENVIRONMENTS[kind]
      this.editorWater.setBorderPadding(profile.borderPadding)
      if (kind !== 'island' && kind !== 'mountains' && kind !== 'water') {
        this.editorWater.setWaterLevel(shading.waterToY)
      }
      this.editorWater.setWaterColor(shading.waterColor)
      await this.editorWater.applyKind(kind)
      void this.rebuildClientLandscapePreview()
    } catch (e) {
      console.warn('[editor] biome water unavailable', e)
    }
    try {
      // Editor always previews wind when flag is set; still builds blades without wind otherwise.
      this.editorGrass = await EditorGrassPaint.create({ windShader, seed: 17 })
      this.editorGrass.mount(host.scene)
    } catch (e) {
      console.warn('[editor] ez-tree grass paint unavailable', e)
    }

    const parcelCols = Math.max(1, Math.round(widthM / PARCEL_SIZE))
    const parcelRows = Math.max(1, Math.round(depthM / PARCEL_SIZE))
    const MAX_GRID_DIVISIONS = 2048
    this.gridSizeM = gridSizeM
    this.gridDivisions = Math.min(Math.max(parcelCols, parcelRows) * 16, MAX_GRID_DIVISIONS)
    this.gridCenterDcl = { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 }
    if (scene.parcels.length <= 256) {
      this.ensureGridHelper(host.scene)
      if (this.gridHelper) this.gridHelper.visible = true
    }

    const axisLen = Math.min(14, Math.max(8, Math.min(widthM, depthM) * 0.4))
    const axisOrigin = dclToThreePos(bounds.minX + 0.15, 0.12, bounds.minZ + 0.15)
    this.axisGizmo = new EditorAxisGizmo(axisOrigin.x, axisOrigin.y, axisOrigin.z, axisLen)
    this.axisGizmo.mount(host.scene)

    this.maxHeightGuide = new EditorMaxHeightGuide(
      bounds.minX + 0.15,
      bounds.minZ + 0.15,
      bounds.minX,
      bounds.maxX
    )
    this.maxHeightGuide.mount(host.scene)

    // Full world boundary from scene parcels (not square GridHelper max-span).
    this.worldBoundary = new EditorWorldBoundaryOutline(bounds, {
      showParcelLines: scene.parcels.length <= 400
    })
    this.worldBoundary.mount(host.scene)

    this.sculpt = new TerrainSculptSession(
      this.projectId,
      this.terrain,
      host.scene,
      widthM,
      depthM,
      bounds.minX,
      bounds.minZ,
      {
        onHeightCommitted: () => this.scheduleGrassRebuild(),
        onGrassCommitted: () => this.scheduleGrassRebuild()
      }
    )
    await this.sculpt.initialize()
    if (terrainLoad.grass) this.sculpt.setGrassMask(terrainLoad.grass, terrainLoad.grassRgb)
    this.scheduleGrassRebuild()

    this.avatarScaleGuides = new EditorAvatarScaleGuides(terrainFootprint, (dclX, dclZ) =>
      this.terrain!.probeSurfaceAtDcl(dclX, dclZ).heightM
    )
    this.avatarScaleGuides.mount(host.scene)

    if (terrainLoad.exportSettings) {
      this.sculpt.setExportSettings(terrainLoad.exportSettings)
    }
    this.sculpt.setBrushCamera(cam)
    this.sculpt.subscribe(() => this.sculpt?.refreshBrushRing())
    this.sculpt.setActive(true)

    const terrain = this.terrain
    this.panel = new TerrainSculptPanel(canvasHost, this.sculpt, () => {}, {
      onSave: async () => {
        if (!this.projectRoot || !this.sculpt) return
        this.panel?.setStatus('Saving…')
        try {
          const res = await this.sculpt.saveToProject(this.projectRoot)
          this.panel?.setStatus(res.message)
        } catch (e) {
          this.panel?.setStatus(e instanceof Error ? e.message : String(e))
        }
      },
      getProceduralShading: () => terrain.getProceduralShading(),
      setProceduralShading: (patch) => {
        terrain.setProceduralShading(patch)
        const s = terrain.getProceduralShading()
        // Island / water / mountains: ocean Y pinned in EditorBiomeWater (client sea level).
        const kind = readEnvironmentKind(this.sceneEnv)
        if (kind !== 'island' && kind !== 'mountains' && kind !== 'water') {
          this.editorWater?.setWaterLevel(s.waterToY)
        }
        this.editorWater?.setWaterColor(s.waterColor)
        this.sculpt?.persistEditorDraft()
        if (
          patch.grassFromY !== undefined ||
          patch.grassToY !== undefined ||
          patch.waterToY !== undefined
        ) {
          this.scheduleGrassRebuild()
        }
      },
      getMaxHeightGuideVisible: () => this.maxHeightGuide?.getVisible() ?? false,
      setMaxHeightGuideVisible: (visible) => {
        this.maxHeightGuide?.setVisible(visible)
        if (visible && this.terrain) {
          this.maxHeightGuide?.update(this.terrain.getMaxHeightSample())
        }
        this.panel?.setMaxHeightGuideChecked(visible)
      },
      getAvatarScaleGuidesVisible: () => this.avatarScaleGuides?.getVisible() ?? false,
      setAvatarScaleGuidesVisible: (visible) => {
        this.avatarScaleGuides?.setVisible(visible)
        this.panel?.setAvatarScaleGuidesChecked(visible)
        const guides = this.avatarScaleGuides
        if (guides) {
          this.panel?.setAvatarScaleGuidesCount(guides.getCountPerParcel(), guides.getPlacementPlan())
          this.panel?.setAvatarScaleCapNote(guides.isPlacementCapped())
        }
      },
      getGridVisible: () => this.gridHelper?.visible ?? false,
      setGridVisible: (visible) => {
        if (visible) this.ensureGridHelper(this.host?.scene)
        if (this.gridHelper) this.gridHelper.visible = visible
        this.panel?.setGridChecked(visible)
      },
      getWaterPlaneVisible: () => this.editorWater?.groupVisible ?? false,
      setWaterPlaneVisible: (visible) => {
        this.editorWater?.setUserVisible(visible)
        this.panel?.setWaterPlaneChecked(visible)
      },
      getAvatarScaleGuidesCount: () => this.avatarScaleGuides?.getCountPerParcel() ?? 16,
      getAvatarScaleGuidesPlan: () => this.avatarScaleGuides?.getPlacementPlan(),
      setAvatarScaleGuidesCount: (count) => {
        const guides = this.avatarScaleGuides
        guides?.setCountPerParcel(count)
        if (guides) {
          this.panel?.setAvatarScaleGuidesCount(guides.getCountPerParcel(), guides.getPlacementPlan())
          this.panel?.setAvatarScaleCapNote(guides.isPlacementCapped())
        }
      },
      getEnvironment: () => ({ ...this.sceneEnv }),
      patchEnvironment: async (patch: Partial<SceneEnvironmentConfig> & {
        water?: SceneEnvironmentConfig['water'] | null
        replaceWater?: boolean
        space?: SceneEnvironmentConfig['space'] | null
        replaceSpace?: boolean
        desert?: SceneEnvironmentConfig['desert'] | null
        replaceDesert?: boolean
        land?: SceneEnvironmentConfig['land'] | null
        replaceLand?: boolean
        mountains?: SceneEnvironmentConfig['mountains'] | null
        replaceMountains?: boolean
      }) => {
        if (!this.projectRoot) return
        try {
          this.sceneEnv = await patchProjectEnvironment(this.projectRoot, patch)
          const kind = readEnvironmentKind(this.sceneEnv)
          const profile = LANDSCAPE_ENVIRONMENTS[kind]
          this.editorWater?.setBorderPadding(profile.borderPadding)
          // Island / water / mountains pin sea level inside applyKind.
          // Land-style plane biomes use sculpt Water To.
          if (kind !== 'island' && kind !== 'mountains' && kind !== 'water') {
            const waterY = terrain.getProceduralShading().waterToY
            this.editorWater?.setWaterLevel(waterY)
          }
          // Open ocean: sink never-raised heightmaps so the seafloor sits under water.
          if (kind === 'water') {
            const sunk = terrain.sinkUnraisedSeafloorForOpenOcean()
            if (sunk) this.sculpt?.persistEditorDraft()
          }
          await this.editorWater?.applyKind(kind)
          // Rebuild the same landscape the play client uses for this environment.kind.
          this.scheduleClientLandscapePreview()
          // Match catalog: space / land / forest / desert / genesis / none have no water.
          if (profile.showWater) {
            this.editorWater?.setUserVisible(true)
            this.panel?.setWaterPlaneChecked(true)
          } else {
            this.editorWater?.setUserVisible(false)
            this.panel?.setWaterPlaneChecked(false)
          }
          const backend = this.editorWater?.getBackend() ?? 'none'
          const backendLabel =
            backend === 'fft'
              ? 'FFTOCEAN (dallapozza)'
              : backend === 'water.js'
                ? 'Water.js fallback'
                : backend === 'plane'
                  ? 'sculpt plane'
                  : 'off'
          const waterYLabel =
            kind === 'island' || kind === 'mountains'
              ? 'island sea'
              : `Y=${terrain.getProceduralShading().waterToY.toFixed(1)}`
          this.panel?.setStatus(
            kind === 'space'
              ? `space · void sky + stars · saved to scene.json`
              : kind === 'desert'
                ? `desert · client landscape · saved to scene.json`
                : kind === 'mountains'
                  ? `mountains · client landscape · saved to scene.json`
                  : profile.showWater
                    ? `${kind} · ${backendLabel} · ${waterYLabel} · saved to scene.json`
                    : `${kind} · no water · saved to scene.json`
          )
        } catch (e) {
          this.panel?.setStatus(e instanceof Error ? e.message : String(e))
        }
      }
    })

    this.mouseMoveHandler = (e) => {
      this.sculpt?.handleMouseMove(e, cam, canvas)
      this.heightHud?.setProbe(this.sculpt?.getHoveredSurfaceProbe() ?? null)
    }
    this.mouseLeaveHandler = () => {
      this.sculpt?.clearHoveredSurfaceProbe()
      this.heightHud?.setProbe(null)
    }
    this.mouseUpHandler = () => {
      this.sculpt?.handleMouseUp()
    }
    this.mouseDownHandler = (e) => {
      if (e.button !== 0) return
      if (this.sculpt?.handleMouseDown(e, cam, canvas)) {
        e.preventDefault()
      }
    }

    canvas.addEventListener('mousemove', this.mouseMoveHandler)
    canvas.addEventListener('mouseleave', this.mouseLeaveHandler)
    canvas.addEventListener('mousedown', this.mouseDownHandler)
    window.addEventListener('mouseup', this.mouseUpHandler)

    this.keyHandler = (e) => {
      if (isTypingInField()) return
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) this.sculpt?.redo()
        else this.sculpt?.undo()
        return
      }
      if (e.code === 'KeyG') {
        e.preventDefault()
        const next = !(this.maxHeightGuide?.getVisible() ?? false)
        this.maxHeightGuide?.setVisible(next)
        if (next && this.terrain) {
          this.maxHeightGuide?.update(this.terrain.getMaxHeightSample())
        }
        this.panel?.setMaxHeightGuideChecked(next)
        return
      }
      if (e.code === 'KeyB') {
        e.preventDefault()
        const guides = this.avatarScaleGuides
        const next = !(guides?.getVisible() ?? false)
        guides?.setVisible(next)
        this.panel?.setAvatarScaleGuidesChecked(next)
        if (guides) {
          this.panel?.setAvatarScaleGuidesCount(guides.getCountPerParcel(), guides.getPlacementPlan())
          this.panel?.setAvatarScaleCapNote(guides.isPlacementCapped())
        }
      }
    }
    window.addEventListener('keydown', this.keyHandler)
  }

  dispose(): void {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler)
    if (this.grassRebuildRaf) cancelAnimationFrame(this.grassRebuildRaf)
    this.grassRebuildRaf = 0
    this.removeFrameListener?.()
    this.removeFrameListener = null
    this.flyCamera?.dispose()
    this.flyCamera = null
    if (this.mouseHandlersAttached()) {
      const canvas = this.host!.renderer.domElement
      if (this.mouseMoveHandler) canvas.removeEventListener('mousemove', this.mouseMoveHandler)
      if (this.mouseLeaveHandler) canvas.removeEventListener('mouseleave', this.mouseLeaveHandler)
      if (this.mouseDownHandler) canvas.removeEventListener('mousedown', this.mouseDownHandler)
      if (this.mouseUpHandler) window.removeEventListener('mouseup', this.mouseUpHandler)
    }
    this.panel?.dispose()
    this.sculpt?.dispose()
    this.editorGrass?.dispose()
    this.editorGrass = null
    this.editorWater?.dispose()
    this.editorWater = null
    if (this.landscapeRebuildTimer) window.clearTimeout(this.landscapeRebuildTimer)
    this.landscapeRebuildTimer = 0
    this.landscapeBuildGen++
    this.clearClientLandscapePreview()
    this.spaceSky?.dispose()
    this.spaceSky = null
    this.disposeOutdoorSky()
    this.editorHemi = null
    this.editorSun = null
    this.terrain?.dispose()
    this.composite?.dispose()
    this.composite = null
    this.compass?.dispose()
    this.compass = null
    this.heightHud?.dispose()
    this.heightHud = null
    this.cameraReset?.dispose()
    this.cameraReset = null
    this.axisGizmo?.dispose()
    this.axisGizmo = null
    this.maxHeightGuide?.dispose()
    this.worldBoundary?.dispose()
    this.worldBoundary = null
    this.maxHeightGuide = null
    this.avatarScaleGuides?.dispose()
    this.avatarScaleGuides = null
    if (this.gridHelper && this.host) {
      this.host.scene.remove(this.gridHelper)
      this.gridHelper.dispose()
    }
    this.host?.dispose()
    this.localCache?.revoke()
    this.wrap?.remove()
    this.wrap = null
    this.host = null
    this.localCache = null
    this.terrain = null
    this.sculpt = null
    this.panel = null
    this.projectRoot = null
    this.mouseMoveHandler = null
    this.mouseDownHandler = null
    this.mouseUpHandler = null
    this.mouseLeaveHandler = null
  }

  private mouseHandlersAttached(): boolean {
    return Boolean(this.host && this.mouseMoveHandler)
  }

  /**
   * Debounced rebuild of the same landscape the play client uses
   * (`buildParcelLandscape` + environment.kind / .desert / .mountains / .space).
   */
  private scheduleClientLandscapePreview(): void {
    // Sand color can update live without a full rebuild.
    this.applyLiveDesertSandColor()
    if (this.landscapeRebuildTimer) window.clearTimeout(this.landscapeRebuildTimer)
    this.landscapeRebuildTimer = window.setTimeout(() => {
      this.landscapeRebuildTimer = 0
      void this.rebuildClientLandscapePreview()
    }, 280)
  }

  private applyLiveDesertSandColor(): void {
    if (readEnvironmentKind(this.sceneEnv) !== 'desert' || !this.landscapeRoot) return
    const hex = resolveDesertSettings(this.sceneEnv.desert).sandColor
    this.landscapeRoot.traverse((obj) => {
      if (obj.name !== 'desert-gold:plane' || !(obj instanceof THREE.Mesh)) return
      const mat = obj.material
      if (mat && !Array.isArray(mat) && 'color' in mat) {
        ;(mat as THREE.MeshStandardMaterial).color.set(hex)
      }
    })
  }

  private clearClientLandscapePreview(): void {
    const scene = this.host?.scene
    // Prefer structured dispose for dust / tumbleweeds if present.
    const atmo = this.landscapeRoot?.userData?.desertAtmosphere as
      | { dispose?: () => void }
      | undefined
    atmo?.dispose?.()
    this.desertAtmo = null
    if (this.landscapeRoot) {
      this.landscapeRoot.removeFromParent()
      this.landscapeRoot.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
          obj.geometry?.dispose()
          const m = (obj as THREE.Mesh).material
          if (Array.isArray(m)) m.forEach((x) => x.dispose())
          else (m as THREE.Material | undefined)?.dispose?.()
        }
      })
      this.landscapeRoot = null
    }
    if (scene) {
      scene.fog = null
    }
  }

  /**
   * Mount the real client landscape for the current environment.kind —
   * desert gold plane, padding rocks, island shore, etc. No editor-only discs.
   */
  private async rebuildClientLandscapePreview(): Promise<void> {
    const host = this.host
    const local = this.localCache
    if (!host || !local) return

    const gen = ++this.landscapeBuildGen
    const kind = readEnvironmentKind(this.sceneEnv)
    const threeScene = host.scene

    // Space sky is separate (EnvironmentSystem path) — keep that live.
    if (kind === 'space') {
      this.clearClientLandscapePreview()
      this.hideOutdoorSky()
      if (!this.spaceSky) {
        this.spaceSky = SpaceSkyField.create(this.sceneEnv.space)
        this.spaceSky.mount(threeScene)
      } else {
        this.spaceSky.applySettings(this.sceneEnv.space)
        this.spaceSky.applyToScene(threeScene)
      }
      if (this.editorHemi) this.editorHemi.intensity = 0.12
      if (this.editorSun) this.editorSun.intensity = 0.18
      return
    }

    this.spaceSky?.unmount(threeScene)
    this.spaceSky?.dispose()
    this.spaceSky = null
    // Soft fallback while Genesis dome textures load (was pure black void).
    threeScene.background = new THREE.Color(0x87b8e8)
    void this.ensureOutdoorSky(threeScene)

    // none / genesis: no empty-land landscape (matches client catalog)
    if (kind === 'none' || kind === 'genesis') {
      this.clearClientLandscapePreview()
      if (this.editorHemi) {
        this.editorHemi.intensity = 0.55
        this.editorHemi.color.set(0xb8d4ff)
      }
      if (this.editorSun) this.editorSun.intensity = 1.05
      return
    }

    this.panel?.setStatus(`Building ${kind} landscape (client path)…`)

    try {
      const profile = LANDSCAPE_ENVIRONMENTS[kind]
      const assets = getSessionAssetCache()
      assets.setScene(local.scene)

      // Preload decoration GLBs the same way LandscapeSystem does.
      const hashes = allHashesForProfile(profile)
      if (hashes.length) {
        await assets.preload(hashes.map((hash) => ({ url: catalystAssetUrl(hash), hash })))
      }
      if (gen !== this.landscapeBuildGen) return

      // Resolved scene matching play client: real environment.kind + fields.
      // Use world source so sparse desert decoration runs (same props as worlds).
      const previewScene: ResolvedScene = {
        ...local.scene,
        landscapeEnvironment: kind as SceneEnvironmentKind,
        metadata: {
          ...local.scene.metadata,
          environment: { ...this.sceneEnv, kind }
        },
        source: { kind: 'world', worldName: 'editor-biome-preview', entityId: 'editor-preview' }
      }

      const root = await buildParcelLandscape(previewScene, assets, (msg) => {
        if (gen === this.landscapeBuildGen) this.panel?.setStatus(msg)
      })
      if (gen !== this.landscapeBuildGen) {
        root.removeFromParent()
        return
      }

      this.clearClientLandscapePreview()
      this.landscapeRoot = root
      // Sit under author terrain / sculpt mesh
      root.renderOrder = -5
      threeScene.add(root)

      this.desertAtmo =
        (root.userData.desertAtmosphere as DesertAtmosphere | undefined) ?? null
      if (this.desertAtmo) {
        this.desertAtmo.applyToScene(threeScene)
      }

      if (kind === 'mountains') {
        const m = resolveMountainsSettings(this.sceneEnv.mountains)
        if (m.haze > 0.0001) {
          threeScene.fog = new THREE.FogExp2(m.hazeColor, m.haze)
        }
        if (this.editorHemi) {
          this.editorHemi.intensity = m.peakSnow ? 0.62 : 0.5
          this.editorHemi.color.set(m.peakSnow ? 0xd8e8ff : 0xb8d4ff)
        }
        if (this.editorSun) this.editorSun.intensity = 1.0
      } else if (kind === 'desert') {
        if (this.editorHemi) {
          this.editorHemi.intensity = 0.45
          this.editorHemi.color.set(0xffe8c0)
        }
        if (this.editorSun) this.editorSun.intensity = 1.15
      } else {
        if (this.editorHemi) {
          this.editorHemi.intensity = 0.55
          this.editorHemi.color.set(0xb8d4ff)
        }
        if (this.editorSun) this.editorSun.intensity = 1.05
      }

      this.panel?.setStatus(`${kind} · client landscape ready`)
    } catch (e) {
      console.warn('[editor] client landscape preview failed', e)
      this.panel?.setStatus(
        e instanceof Error ? e.message : 'Landscape preview failed'
      )
    }
  }

  /**
   * Play-client Genesis sky dome for outdoor biomes (island / water / land / desert / …).
   * Space uses {@link SpaceSkyField} instead.
   */
  private async ensureOutdoorSky(scene: THREE.Scene): Promise<void> {
    const show = (sky: DclGenesisSky): void => {
      sky.mesh.visible = true
      if (sky.mesh.parent !== scene) scene.add(sky.mesh)
      // Dome owns the look — clear solid fallback once ready.
      scene.background = null
    }

    const existing = this.outdoorSky
    if (existing) {
      show(existing)
      return
    }

    if (!this.outdoorSkyLoad) {
      this.outdoorSkyLoad = (async () => {
        const sky = new DclGenesisSky()
        try {
          await sky.loadTextures()
        } catch (e) {
          console.warn('[editor] outdoor sky textures failed — solid fallback', e)
          sky.dispose()
          return
        }
        this.outdoorSky = sky
        scene.add(sky.mesh)
        scene.background = null
        // First paint at midday so the viewport is not empty until the next frame.
        celestialDirection(EDITOR_SKY_SECONDS, _editorCelestial)
        sky.update(EDITOR_SKY_SECONDS, _editorCelestial, 0, false)
      })().finally(() => {
        this.outdoorSkyLoad = null
      })
    }

    await this.outdoorSkyLoad
    const ready = this.outdoorSky
    if (ready) show(ready)
  }

  private tickOutdoorSky(delta: number, camera: THREE.Camera): void {
    const sky = this.outdoorSky
    if (!sky || !sky.mesh.visible) return
    sky.mesh.position.copy(camera.position)
    celestialDirection(EDITOR_SKY_SECONDS, _editorCelestial)
    sky.update(EDITOR_SKY_SECONDS, _editorCelestial, delta, false)
  }

  private hideOutdoorSky(): void {
    const sky = this.outdoorSky
    if (sky) sky.mesh.visible = false
  }

  private disposeOutdoorSky(): void {
    const sky = this.outdoorSky
    if (sky) {
      sky.mesh.removeFromParent()
      sky.dispose()
    }
    this.outdoorSky = null
    this.outdoorSkyLoad = null
  }

  private scheduleGrassRebuild(): void {
    if (this.grassRebuildRaf) return
    this.grassRebuildRaf = requestAnimationFrame(() => {
      this.grassRebuildRaf = 0
      this.rebuildEditorGrass()
    })
  }

  private rebuildEditorGrass(): void {
    if (!this.editorGrass || !this.terrain || !this.sculpt) return
    const buffers = this.terrain.getBuffers()
    this.editorGrass.rebuild(
      buffers.heights,
      this.sculpt.getGrassMask(),
      this.terrain.resolution,
      this.terrain.originX,
      this.terrain.originZ,
      this.terrain.widthM,
      this.terrain.depthM,
      this.sculpt.getGrassRgb()
    )
  }

  /** Lazy — large scenes skip grid GPU buffers until the user enables it. */
  private ensureGridHelper(scene: THREE.Scene | undefined): void {
    if (!scene || this.gridHelper || this.gridSizeM <= 0) return

    const grid = new THREE.GridHelper(this.gridSizeM, this.gridDivisions, 0x446688, 0x223344)
    dclToThreePos(this.gridCenterDcl.x, 0, this.gridCenterDcl.z, grid.position)
    const gridMat = grid.material
    const materials = Array.isArray(gridMat) ? gridMat : [gridMat]
    for (const mat of materials) {
      mat.transparent = true
      mat.opacity = 0.9
      mat.depthWrite = false
    }
    grid.renderOrder = 2
    grid.visible = false
    scene.add(grid)
    this.gridHelper = grid
  }
}