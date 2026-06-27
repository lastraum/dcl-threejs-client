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
  private compass: EditorViewportCompass | null = null
  private axisGizmo: EditorAxisGizmo | null = null
  private maxHeightGuide: EditorMaxHeightGuide | null = null
  private projectRoot: ProjectRoot | null = null
  private keyHandler: ((e: KeyboardEvent) => void) | null = null
  private mouseUpHandler: (() => void) | null = null
  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null
  private mouseDownHandler: ((e: MouseEvent) => void) | null = null

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
    cam.far = 8000
    cam.updateProjectionMatrix()
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
    this.compass = new EditorViewportCompass(canvasHost)
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

    this.gridHelper = new THREE.GridHelper(gridSizeM, Math.max(scene.parcels.length, 1) * 16, 0x446688, 0x223344)
    dclToThreePos((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2, this.gridHelper.position)
    const gridMat = this.gridHelper.material
    const materials = Array.isArray(gridMat) ? gridMat : [gridMat]
    for (const mat of materials) {
      mat.transparent = true
      mat.opacity = 0.9
      mat.depthWrite = false
    }
    this.gridHelper.renderOrder = 2
    host.scene.add(this.gridHelper)

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
      }
    })

    this.mouseMoveHandler = (e) => {
      this.sculpt?.handleMouseMove(e, cam, canvas)
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
    this.axisGizmo?.dispose()
    this.axisGizmo = null
    this.maxHeightGuide?.dispose()
    this.maxHeightGuide = null
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
  }

  private mouseHandlersAttached(): boolean {
    return Boolean(this.host && this.mouseMoveHandler)
  }
}