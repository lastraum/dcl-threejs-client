import * as THREE from 'three'
import {
  ARENA_WATER_SURFACE_Y,
  DEFAULT_TERRAIN_SCULPT_SETTINGS,
  type TerrainSculptSettings
} from './terrainSculptConstants'
import type { EditorTerrainSystem } from './EditorTerrainSystem'
import { applyHeightBrush, applyLavaBrush, applySplatBrush } from './TerrainBrush'
import { SCULPT_RESOLUTION, worldToHeightIndex } from './heightmapCodec'
import { TerrainSculptUndoStack } from './TerrainSculptUndoStack'
import { saveTerrainToProject } from './saveTerrainToProject'

export class TerrainSculptSession {
  readonly resolution = SCULPT_RESOLUTION
  private heights = new Float32Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION)
  private splat = new Uint8Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION * 4)
  private lava = new Uint8Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION)
  private settings: TerrainSculptSettings = { ...DEFAULT_TERRAIN_SCULPT_SETTINGS }
  private readonly undoStack = new TerrainSculptUndoStack()
  private active = false
  private strokeOpen = false
  private flattenTargetY = 0
  private readonly raycaster = new THREE.Raycaster()
  private readonly mouse = new THREE.Vector2()
  private brushRing: THREE.Mesh | null = null
  private listeners = new Set<() => void>()

  constructor(
    private readonly terrain: EditorTerrainSystem,
    private readonly scene: THREE.Scene,
    private readonly arenaWidthM: number,
    private readonly arenaDepthM: number,
    private readonly waterLevelY = ARENA_WATER_SURFACE_Y
  ) {}

  getSettings(): TerrainSculptSettings {
    return { ...this.settings }
  }

  patchSettings(patch: Partial<TerrainSculptSettings>): void {
    this.settings = { ...this.settings, ...patch }
    this.notify()
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    for (const cb of this.listeners) cb()
  }

  async initialize(): Promise<void> {
    const fromTerrain = this.terrain.copyActiveHeightGrid(this.resolution)
    if (fromTerrain) {
      this.heights = new Float32Array(fromTerrain)
    }
    const buffers = this.terrain.getBuffers()
    this.splat = new Uint8Array(buffers.splat)
    this.lava = new Uint8Array(buffers.lava)
    this.pushPreview()
  }

  setActive(active: boolean): void {
    this.active = active
    if (this.brushRing) this.brushRing.visible = active
    if (!active) this.endStroke()
  }

  isActive(): boolean {
    return this.active
  }

  canUndo(): boolean {
    return this.undoStack.canUndo()
  }

  canRedo(): boolean {
    return this.undoStack.canRedo()
  }

  undo(): void {
    const snap = this.undoStack.undo({ heights: this.heights, splat: this.splat, lava: this.lava })
    if (!snap) return
    this.heights = new Float32Array(snap.heights)
    this.splat = new Uint8Array(snap.splat)
    this.lava = new Uint8Array(snap.lava)
    this.pushPreview()
  }

  redo(): void {
    const snap = this.undoStack.redo({ heights: this.heights, splat: this.splat, lava: this.lava })
    if (!snap) return
    this.heights = new Float32Array(snap.heights)
    this.splat = new Uint8Array(snap.splat)
    this.lava = new Uint8Array(snap.lava)
    this.pushPreview()
  }

  async saveToProject(
    root: FileSystemDirectoryHandle,
    terrainPosition: { x: number; y: number; z: number }
  ): Promise<{ ok: boolean; message: string }> {
    const res = await saveTerrainToProject(root, this.terrain, terrainPosition)
    return { ok: res.ok, message: res.message }
  }

  dispose(): void {
    if (this.brushRing) {
      this.scene.remove(this.brushRing)
      this.brushRing.geometry.dispose()
      ;(this.brushRing.material as THREE.Material).dispose()
      this.brushRing = null
    }
  }

  handleMouseDown(event: MouseEvent, camera: THREE.Camera, canvas: HTMLCanvasElement): boolean {
    if (!this.active || event.button !== 0) return false
    this.updateMouse(event, canvas)
    this.strokeOpen = true
    this.undoStack.pushSnapshot(this.heights, this.splat, this.lava)
    if (this.settings.brushMode === 'flatten' && this.settings.paintLayer === 'height') {
      this.flattenTargetY = this.sampleHeightAtPointer(camera) ?? this.flattenTargetY
    }
    this.applyStroke(camera)
    return true
  }

  handleMouseMove(event: MouseEvent, camera: THREE.Camera, canvas: HTMLCanvasElement): void {
    if (!this.active) return
    this.updateMouse(event, canvas)
    this.updateBrushRing(camera)
    if (this.strokeOpen) this.applyStroke(camera)
  }

  handleMouseUp(): void {
    this.endStroke()
  }

  private endStroke(): void {
    this.strokeOpen = false
  }

  private updateMouse(event: MouseEvent, canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect()
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.mouse.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
  }

  private raycastWorldPoint(camera: THREE.Camera): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.mouse, camera)
    const mesh = this.terrain.getTerrainMeshForRaycast()
    const hits = this.raycaster.intersectObject(mesh, false)
    return hits[0]?.point ?? null
  }

  private sampleHeightAtPointer(camera: THREE.Camera): number | null {
    const p = this.raycastWorldPoint(camera)
    if (!p) return null
    const { ix, iz } = worldToHeightIndex(p.x, p.z, this.resolution, this.arenaWidthM, this.arenaDepthM)
    return this.heights[iz * this.resolution + ix]!
  }

  private applyStroke(camera: THREE.Camera): void {
    const p = this.raycastWorldPoint(camera)
    if (!p) return
    const { ix, iz } = worldToHeightIndex(p.x, p.z, this.resolution, this.arenaWidthM, this.arenaDepthM)

    if (this.settings.paintLayer === 'splat') {
      if (this.settings.splatChannel === 4) {
        applyLavaBrush(
          this.lava,
          this.resolution,
          ix,
          iz,
          this.arenaWidthM,
          this.settings.brushSizeM,
          this.settings.brushStrength,
          this.settings.splatErase
        )
      } else {
        applySplatBrush(
          this.splat,
          this.resolution,
          ix,
          iz,
          this.arenaWidthM,
          this.settings.brushSizeM,
          this.settings.brushStrength,
          this.settings.splatChannel,
          this.settings.splatErase
        )
      }
      this.terrain.applySplatBuffer(this.splat, this.resolution, this.resolution)
      this.terrain.applyLavaBuffer(this.lava, this.resolution, this.resolution)
      return
    }

    applyHeightBrush(
      this.heights,
      this.resolution,
      ix,
      iz,
      this.arenaWidthM,
      this.arenaDepthM,
      {
        sizeM: this.settings.brushSizeM,
        strength: this.settings.brushStrength,
        mode: this.settings.brushMode,
        waterLevelY: this.waterLevelY
      },
      this.flattenTargetY
    )
    this.pushPreview()
  }

  private pushPreview(): void {
    this.terrain.applySculptHeightBuffer(this.heights, this.resolution)
    this.terrain.applySplatBuffer(this.splat, this.resolution, this.resolution)
    this.terrain.applyLavaBuffer(this.lava, this.resolution, this.resolution)
  }

  private ensureBrushRing(): void {
    if (this.brushRing) return
    const geo = new THREE.RingGeometry(0.92, 1, 48)
    const mat = new THREE.MeshBasicMaterial({
      color: 0x44ffaa,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      side: THREE.DoubleSide
    })
    this.brushRing = new THREE.Mesh(geo, mat)
    this.brushRing.rotation.x = -Math.PI / 2
    this.brushRing.renderOrder = 999
    this.brushRing.visible = this.active
    this.scene.add(this.brushRing)
  }

  private updateBrushRing(camera: THREE.Camera): void {
    this.ensureBrushRing()
    if (!this.brushRing) return
    const p = this.raycastWorldPoint(camera)
    if (!p) {
      this.brushRing.visible = false
      return
    }
    this.brushRing.visible = this.active
    const r = this.settings.brushSizeM * 0.5
    this.brushRing.position.set(p.x, p.y + 0.15, p.z)
    this.brushRing.scale.set(r, r, 1)
  }
}