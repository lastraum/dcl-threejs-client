import * as THREE from 'three'
import { sceneWorldBounds } from '../player/SceneBounds'
import { getProjectMeta, requestProjectRoot } from './localProjects/projectStore'
import type { ProjectRoot } from './localScene/projectRoot'
import { resolveLocalScene, type LocalSceneCache } from './localScene/resolveLocalScene'
import { EditorFlyCamera } from './EditorFlyCamera'
import { EditorTerrainSystem } from './terrain/EditorTerrainSystem'
import { TerrainSculptSession } from './terrain/TerrainSculptSession'
import { TerrainSculptPanel } from './ui/TerrainSculptPanel'
import { loadTerrainFromProject } from './terrain/loadTerrainFromProject'
import { terrainFootprintFromBounds } from './terrain/terrainFootprint'
import { getSessionAssetCache } from '../rendering/AssetCache'
import { SceneHost } from '../rendering/SceneHost'
import { loadCompositeScene, type CompositeSceneHandle } from './composite/loadCompositeScene'
import { EditorViewportCompass } from './EditorViewportCompass'
import { EditorAxisGizmo } from './EditorAxisGizmo'
import { EditorMaxHeightGuide } from './EditorMaxHeightGuide'
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

function addEditorLighting(scene: THREE.Scene): void {
  const hemi = new THREE.HemisphereLight(0xb8d4ff, 0x3d4a2a, 0.55)
  const sun = new THREE.DirectionalLight(0xfff5e8, 1.05)
  sun.position.set(120, 220, 80)
  scene.add(hemi, sun)
}

export class TerrainEditorWorkspace {
  private wrap: HTMLDivElement | null = null
  private host: SceneHost | null = null
  private composite: CompositeSceneHandle | null = null
  private localCache: LocalSceneCache | null = null
  private terrain: EditorTerrainSystem | null = null
  private sculpt: TerrainSculptSession | null = null
  private panel: TerrainSculptPanel | null = null
  private flyCamera: EditorFlyCamera | null = null
  private removeFrameListener: (() => void) | null = null
  private gridHelper: THREE.GridHelper | null = null
  private gridSizeM = 0
  private gridDivisions = 0
  private gridCenterDcl = { x: 0, z: 0 }
  private compass: EditorViewportCompass | null = null
  private heightHud: EditorTerrainHeightHud | null = null
  private cameraReset: EditorCameraResetButton | null = null
  private axisGizmo: EditorAxisGizmo | null = null
  private maxHeightGuide: EditorMaxHeightGuide | null = null
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

    const panelHost = document.createElement('aside')
    panelHost.className = 'editor-workspace-panel'
    const canvasHost = document.createElement('div')
    canvasHost.className = 'editor-workspace-canvas'
    body.appendChild(panelHost)
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
    addEditorLighting(host.scene)

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
      if (this.maxHeightGuide?.getVisible() && this.terrain) {
        this.maxHeightGuide.update(this.terrain.getMaxHeightSample())
      }
    })

    host.start()

    this.terrain = new EditorTerrainSystem(terrainFootprint)
    this.terrain.mount(host.scene)
    const terrainLoad = await loadTerrainFromProject(this.projectId, root, this.terrain)

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

    this.sculpt = new TerrainSculptSession(
      this.projectId,
      this.terrain,
      host.scene,
      widthM,
      depthM,
      bounds.minX,
      bounds.minZ
    )
    await this.sculpt.initialize()

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
    this.panel = new TerrainSculptPanel(panelHost, this.sculpt, () => {}, {
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
        this.sculpt?.persistEditorDraft()
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
      getAvatarScaleGuidesCount: () => this.avatarScaleGuides?.getCountPerParcel() ?? 16,
      getAvatarScaleGuidesPlan: () => this.avatarScaleGuides?.getPlacementPlan(),
      setAvatarScaleGuidesCount: (count) => {
        const guides = this.avatarScaleGuides
        guides?.setCountPerParcel(count)
        if (guides) {
          this.panel?.setAvatarScaleGuidesCount(guides.getCountPerParcel(), guides.getPlacementPlan())
          this.panel?.setAvatarScaleCapNote(guides.isPlacementCapped())
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