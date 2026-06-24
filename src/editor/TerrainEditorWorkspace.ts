import * as THREE from 'three'
import { World } from '../core/World'
import { sceneWorldBounds } from '../player/SceneBounds'
import { getProjectMeta, requestProjectHandle } from './localProjects/projectStore'
import { resolveLocalScene, type LocalSceneCache } from './localScene/resolveLocalScene'
import { EditorTerrainSystem } from './terrain/EditorTerrainSystem'
import { TerrainSculptSession } from './terrain/TerrainSculptSession'
import { TerrainSculptPanel } from './ui/TerrainSculptPanel'
import { loadTerrainFromProject } from './terrain/loadTerrainFromProject'
import { getSessionAssetCache } from '../rendering/AssetCache'

export type TerrainEditorWorkspaceCallbacks = {
  onBack: () => void
  onReload?: () => void
}

export class TerrainEditorWorkspace {
  private wrap: HTMLDivElement | null = null
  private world: World | null = null
  private localCache: LocalSceneCache | null = null
  private terrain: EditorTerrainSystem | null = null
  private sculpt: TerrainSculptSession | null = null
  private panel: TerrainSculptPanel | null = null
  private gridHelper: THREE.GridHelper | null = null
  private projectHandle: FileSystemDirectoryHandle | null = null
  private keyHandler: ((e: KeyboardEvent) => void) | null = null
  private pointerHandlers: {
    down: (e: PointerEvent) => void
    move: (e: PointerEvent) => void
    up: (e: PointerEvent) => void
  } | null = null

  constructor(
    private container: HTMLElement,
    private projectId: string,
    private callbacks: TerrainEditorWorkspaceCallbacks
  ) {}

  async mount(): Promise<void> {
    const meta = await getProjectMeta(this.projectId)
    const handle = await requestProjectHandle(this.projectId)
    this.projectHandle = handle

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
    status.textContent = 'Loading local scene…'
    canvasHost.appendChild(status)

    this.localCache = await resolveLocalScene(this.projectId, handle)
    const scene = this.localCache.scene
    const bounds = sceneWorldBounds(scene.parcels, scene.baseParcel)
    const widthM = bounds.maxX - bounds.minX
    const depthM = bounds.maxZ - bounds.minZ

    const world = new World(canvasHost)
    this.world = world
    world.enterEditorPreviewMode()

    getSessionAssetCache().setScene(scene)
    await world.loadScene(scene, (msg) => {
      status.textContent = msg
    })
    await world.waitForSceneAssets(scene, (msg) => {
      status.textContent = msg
    })
    await world.prewarmPhysicsColliders(scene, (msg) => {
      status.textContent = msg
    })
    status.remove()
    world.host.focusSpawn(scene)
    world.start()

    this.terrain = new EditorTerrainSystem(widthM, depthM)
    this.terrain.mount(world.host.scene)
    await loadTerrainFromProject(handle, this.terrain)

    this.gridHelper = new THREE.GridHelper(Math.max(widthM, depthM), Math.max(scene.parcels.length, 1) * 16, 0x446688, 0x223344)
    this.gridHelper.position.set(widthM / 2, 0.02, depthM / 2)
    world.host.scene.add(this.gridHelper)

    this.sculpt = new TerrainSculptSession(this.terrain, world.host.scene, widthM, depthM)
    await this.sculpt.initialize()
    this.sculpt.setActive(false)

    const terrainCenter = {
      x: widthM / 2,
      y: 0,
      z: depthM / 2
    }

    this.panel = new TerrainSculptPanel(panelHost, this.sculpt, () => {}, {
      onSave: async () => {
        if (!this.projectHandle || !this.sculpt) return
        this.panel?.setStatus('Saving…')
        try {
          const res = await this.sculpt.saveToProject(this.projectHandle, terrainCenter)
          this.panel?.setStatus(res.message)
        } catch (e) {
          this.panel?.setStatus(e instanceof Error ? e.message : String(e))
        }
      }
    })

    const canvas = world.host.renderer.domElement
    this.pointerHandlers = {
      down: (e) => {
        if (!this.sculpt?.isActive()) return
        if (this.sculpt.handleMouseDown(e as unknown as MouseEvent, world.host.camera, canvas)) {
          e.preventDefault()
          world.host.controls.enabled = false
        }
      },
      move: (e) => {
        if (!this.sculpt) return
        this.sculpt.handleMouseMove(e as unknown as MouseEvent, world.host.camera, canvas)
      },
      up: () => {
        this.sculpt?.handleMouseUp()
        world.host.controls.enabled = !this.sculpt?.isActive()
      }
    }
    canvas.addEventListener('pointerdown', this.pointerHandlers.down)
    canvas.addEventListener('pointermove', this.pointerHandlers.move)
    canvas.addEventListener('pointerup', this.pointerHandlers.up)
    canvas.addEventListener('pointerleave', this.pointerHandlers.up)

    this.keyHandler = (e) => {
      if (e.key === 'b' || e.key === 'B') {
        const next = !this.sculpt!.isActive()
        this.sculpt!.setActive(next)
        world.host.controls.enabled = !next
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) this.sculpt?.redo()
        else this.sculpt?.undo()
      }
    }
    window.addEventListener('keydown', this.keyHandler)
  }

  dispose(): void {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler)
    if (this.pointerHandlers && this.world) {
      const canvas = this.world.host.renderer.domElement
      canvas.removeEventListener('pointerdown', this.pointerHandlers.down)
      canvas.removeEventListener('pointermove', this.pointerHandlers.move)
      canvas.removeEventListener('pointerup', this.pointerHandlers.up)
      canvas.removeEventListener('pointerleave', this.pointerHandlers.up)
    }
    this.panel?.dispose()
    this.sculpt?.dispose()
    this.terrain?.dispose()
    if (this.gridHelper && this.world) {
      this.world.host.scene.remove(this.gridHelper)
      this.gridHelper.dispose()
    }
    this.world?.dispose()
    this.localCache?.revoke()
    this.wrap?.remove()
    this.wrap = null
    this.world = null
    this.localCache = null
    this.terrain = null
    this.sculpt = null
    this.panel = null
    this.projectHandle = null
  }
}