import * as THREE from 'three'
import { threeToDclPos } from '../../bridge/dclTransform'
import {
  DEFAULT_TERRAIN_EXPORT_SETTINGS,
  DEFAULT_TERRAIN_SCULPT_SETTINGS,
  TERRAIN_BRUSH_RADIUS_MAX_M,
  TERRAIN_BRUSH_RADIUS_MIN_M,
  clampTerrainExportSegments,
  type TerrainExportSettings,
  type TerrainSculptSettings
} from './terrainSculptConstants'
import type { EditorTerrainSystem } from './EditorTerrainSystem'
import {
  applyGrassBrush,
  applyHeightBrush,
  applyLavaBrush,
  applySplatBrush,
  computeBrushRadiusCells,
  smoothKernelRadiusCells
} from './TerrainBrush'
import { SCULPT_RESOLUTION, worldToHeightUv } from './heightmapCodec'
import { TerrainSculptUndoStack } from './TerrainSculptUndoStack'
import type { ProjectRoot } from '../localScene/projectRoot'
import { saveTerrainToProject } from './saveTerrainToProject'
import { saveTerrainDraft } from './terrainEditorStore'

export type TerrainSculptSessionHooks = {
  /** After height stroke ends (or undo/redo height). */
  onHeightCommitted?: () => void
  /** After splat/lava stroke ends (or undo/redo paint). */
  onPaintCommitted?: () => void
  /** After ez-tree grass blade density stroke (or undo/redo). */
  onGrassCommitted?: () => void
}

export class TerrainSculptSession {
  readonly resolution = SCULPT_RESOLUTION
  private heights: Float32Array = new Float32Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION)
  private splat: Uint8Array = new Uint8Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION * 4)
  private lava: Uint8Array = new Uint8Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION)
  /** ez-tree blade density 0–255 per cell (not albedo splat). */
  private grass: Uint8Array = new Uint8Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION)
  /** Packed RGB plant colors (res²×3), 0 when empty. */
  private grassRgb: Uint8Array = new Uint8Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION * 3)
  private settings: TerrainSculptSettings = { ...DEFAULT_TERRAIN_SCULPT_SETTINGS }
  private exportSettings: TerrainExportSettings = { ...DEFAULT_TERRAIN_EXPORT_SETTINGS }
  private readonly undoStack = new TerrainSculptUndoStack()
  private active = false
  private strokeOpen = false
  private flattenTargetY = 0
  private readonly raycaster = new THREE.Raycaster()
  private readonly mouse = new THREE.Vector2()
  private brushRing: THREE.Mesh | null = null
  private brushCamera: THREE.Camera | null = null
  private lastBrushPoint: THREE.Vector3 | null = null
  private listeners = new Set<() => void>()
  private strokeRaf = 0
  private strokePending = false
  private pendingCamera: THREE.Camera | null = null
  private hoveredSurfaceProbe: { heightM: number; slope: number } | null = null
  private strokeLayer: TerrainSculptSettings['paintLayer'] | null = null

  constructor(
    private readonly projectId: string,
    private readonly terrain: EditorTerrainSystem,
    private readonly scene: THREE.Scene,
    private readonly arenaWidthM: number,
    private readonly arenaDepthM: number,
    private readonly arenaOriginX: number,
    private readonly arenaOriginZ: number,
    private readonly hooks: TerrainSculptSessionHooks = {}
  ) {}

  getSettings(): TerrainSculptSettings {
    return { ...this.settings }
  }

  getExportSettings(): TerrainExportSettings {
    return { ...this.exportSettings }
  }

  setExportSettings(settings: TerrainExportSettings): void {
    this.exportSettings = {
      exportSegmentsPerParcel: clampTerrainExportSegments(settings.exportSegmentsPerParcel)
    }
    this.notify()
  }

  patchExportSettings(patch: Partial<TerrainExportSettings>): void {
    if (patch.exportSegmentsPerParcel !== undefined) {
      patch.exportSegmentsPerParcel = clampTerrainExportSegments(patch.exportSegmentsPerParcel)
    }
    this.exportSettings = { ...this.exportSettings, ...patch }
    this.notify()
    this.persistEditorDraft()
  }

  setBrushCamera(camera: THREE.Camera): void {
    this.brushCamera = camera
    this.refreshBrushRing()
  }

  refreshBrushRing(): void {
    if (!this.brushCamera) return
    this.syncBrushRingScale()
    if (this.lastBrushPoint) {
      this.placeBrushRing(this.lastBrushPoint)
      return
    }
    this.updateBrushRing(this.brushCamera)
  }

  patchSettings(patch: Partial<TerrainSculptSettings>): void {
    const layerChanged = patch.paintLayer !== undefined && patch.paintLayer !== this.settings.paintLayer
    if (patch.brushSizeM !== undefined) {
      patch.brushSizeM = Math.max(
        TERRAIN_BRUSH_RADIUS_MIN_M,
        Math.min(TERRAIN_BRUSH_RADIUS_MAX_M, patch.brushSizeM)
      )
    }
    this.settings = { ...this.settings, ...patch }
    if (layerChanged && this.strokeOpen) {
      this.endStroke()
    }
    this.notify()
    this.refreshBrushRing()
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    for (const cb of this.listeners) cb()
  }

  async initialize(): Promise<void> {
    // Share live buffers with the terrain system so dabs avoid full 1024² copies.
    this.bindSharedBuffers()
    this.pushPreview()
  }

  /** Re-bind to terrain-owned height/splat/lava; grass stays session-owned. */
  private bindSharedBuffers(): void {
    const buffers = this.terrain.getBuffers()
    this.heights = buffers.heights
    this.splat = buffers.splat
    this.lava = buffers.lava
  }

  getGrassMask(): Uint8Array {
    return this.grass
  }

  getGrassRgb(): Uint8Array {
    return this.grassRgb
  }

  setGrassMask(grass: Uint8Array, grassRgb?: Uint8Array): void {
    if (grass.length !== this.grass.length) return
    this.grass = new Uint8Array(grass)
    if (grassRgb && grassRgb.length === this.grassRgb.length) {
      this.grassRgb = new Uint8Array(grassRgb)
    }
  }

  setActive(active: boolean): void {
    this.active = active
    if (this.brushRing) this.brushRing.visible = active
    if (!active) this.endStroke()
    this.refreshBrushRing()
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
    const snap = this.undoStack.undo({
      heights: this.heights,
      splat: this.splat,
      lava: this.lava,
      grass: this.grass,
      grassRgb: this.grassRgb
    })
    if (!snap) return
    this.terrain.applySculptHeightBuffer(snap.heights, this.resolution)
    this.terrain.applySplatBuffer(snap.splat, this.resolution, this.resolution)
    this.terrain.applyLavaBuffer(snap.lava, this.resolution, this.resolution)
    this.bindSharedBuffers()
    this.grass = new Uint8Array(snap.grass)
    this.grassRgb = new Uint8Array(snap.grassRgb)
    this.persistDraft()
    this.hooks.onHeightCommitted?.()
    this.hooks.onPaintCommitted?.()
    this.hooks.onGrassCommitted?.()
  }

  redo(): void {
    const snap = this.undoStack.redo({
      heights: this.heights,
      splat: this.splat,
      lava: this.lava,
      grass: this.grass,
      grassRgb: this.grassRgb
    })
    if (!snap) return
    this.terrain.applySculptHeightBuffer(snap.heights, this.resolution)
    this.terrain.applySplatBuffer(snap.splat, this.resolution, this.resolution)
    this.terrain.applyLavaBuffer(snap.lava, this.resolution, this.resolution)
    this.bindSharedBuffers()
    this.grass = new Uint8Array(snap.grass)
    this.grassRgb = new Uint8Array(snap.grassRgb)
    this.persistDraft()
    this.hooks.onHeightCommitted?.()
    this.hooks.onPaintCommitted?.()
    this.hooks.onGrassCommitted?.()
  }

  async saveToProject(root: ProjectRoot): Promise<{ ok: boolean; message: string }> {
    const res = await saveTerrainToProject(
      this.projectId,
      root,
      this.terrain,
      this.getExportSettings(),
      this.grass,
      this.grassRgb
    )
    return { ok: res.ok, message: res.message }
  }

  /** Persist sculpt buffers + procedural shading to IndexedDB for this project. */
  persistEditorDraft(): void {
    void saveTerrainDraft(this.projectId, {
      resolution: this.resolution,
      heights: this.heights,
      splat: this.splat,
      lava: this.lava,
      grass: this.grass,
      grassRgb: this.grassRgb,
      proceduralShading: this.terrain.getProceduralShading(),
      exportSettings: this.getExportSettings()
    })
  }

  private persistDraft(): void {
    this.persistEditorDraft()
  }

  dispose(): void {
    if (this.strokeRaf) cancelAnimationFrame(this.strokeRaf)
    this.strokeRaf = 0
    this.strokePending = false
    if (this.brushRing) {
      this.scene.remove(this.brushRing)
      this.brushRing.geometry.dispose()
      ;(this.brushRing.material as THREE.Material).dispose()
      this.brushRing = null
    }
  }

  handleMouseDown(event: MouseEvent, camera: THREE.Camera, canvas: HTMLCanvasElement): boolean {
    if (!this.active || event.button !== 0) return false
    this.brushCamera = camera
    this.updateMouse(event, canvas)
    this.updateBrushRing(camera)
    this.strokeOpen = true
    this.strokeLayer = this.settings.paintLayer
    if (this.settings.paintLayer === 'height') {
      const sharp = this.settings.brushMode !== 'smooth'
      this.terrain.beginSculptStroke(sharp)
    } else if (this.settings.paintLayer === 'splat') {
      this.terrain.beginPaintStroke()
    }
    this.undoStack.pushSnapshot(this.heights, this.splat, this.lava, this.grass, this.grassRgb)
    if (this.settings.brushMode === 'flatten' && this.settings.paintLayer === 'height') {
      this.flattenTargetY = this.sampleHeightAtPointer(camera) ?? this.flattenTargetY
    }
    this.applyStroke(camera)
    return true
  }

  handleMouseMove(event: MouseEvent, camera: THREE.Camera, canvas: HTMLCanvasElement): void {
    if (!this.active) return
    this.brushCamera = camera
    this.updateMouse(event, canvas)
    this.updateBrushRing(camera)
    if (this.strokeOpen) this.scheduleStroke(camera)
  }

  clearHoveredSurfaceProbe(): void {
    this.hoveredSurfaceProbe = null
  }

  getHoveredSurfaceProbe(): { heightM: number; slope: number } | null {
    return this.hoveredSurfaceProbe
  }

  handleMouseUp(): void {
    this.endStroke()
  }

  private endStroke(): void {
    if (this.strokeRaf) {
      cancelAnimationFrame(this.strokeRaf)
      this.strokeRaf = 0
    }
    if (this.strokePending && this.pendingCamera) {
      this.applyStroke(this.pendingCamera)
    }
    this.strokePending = false
    this.pendingCamera = null
    const layer = this.strokeLayer
    if (this.strokeOpen && layer === 'height') {
      this.terrain.endSculptStroke()
      this.hooks.onHeightCommitted?.()
    } else if (this.strokeOpen && layer === 'splat') {
      this.terrain.endPaintStroke(this.splat, this.lava)
      this.hooks.onPaintCommitted?.()
    } else if (this.strokeOpen && layer === 'grass') {
      this.hooks.onGrassCommitted?.()
    }
    this.strokeOpen = false
    this.strokeLayer = null
    this.persistDraft()
  }

  private scheduleStroke(camera: THREE.Camera): void {
    this.pendingCamera = camera
    if (this.strokePending) return
    this.strokePending = true
    this.strokeRaf = requestAnimationFrame(() => {
      this.strokeRaf = 0
      this.strokePending = false
      const cam = this.pendingCamera
      this.pendingCamera = null
      if (this.strokeOpen && cam) this.applyStroke(cam)
    })
  }

  private updateMouse(event: MouseEvent, canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect()
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.mouse.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
  }

  private raycastWorldPoint(camera: THREE.Camera): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.mouse, camera)
    // Heightfield step raycast — much cheaper than dense preview mesh triangles.
    return this.terrain.raycastHeightfield(this.raycaster.ray.origin, this.raycaster.ray.direction)
  }

  private dclPointFromRaycast(p: THREE.Vector3): { x: number; z: number } {
    const dcl = threeToDclPos(p.x, p.y, p.z)
    return { x: dcl.x, z: dcl.z }
  }

  private heightAtRaycastPoint(p: THREE.Vector3): number {
    const dcl = this.dclPointFromRaycast(p)
    return this.terrain.probeSurfaceAtDcl(dcl.x, dcl.z).heightM
  }

  private probeAtRaycastPoint(p: THREE.Vector3): { heightM: number; slope: number } {
    const dcl = this.dclPointFromRaycast(p)
    const sampled = this.terrain.probeSurfaceAtDcl(dcl.x, dcl.z)
    return { heightM: p.y, slope: sampled.slope }
  }

  private sampleHeightAtPointer(camera: THREE.Camera): number | null {
    const p = this.raycastWorldPoint(camera)
    if (!p) return null
    return this.heightAtRaycastPoint(p)
  }

  private applyStroke(camera: THREE.Camera): void {
    const p = this.raycastWorldPoint(camera)
    if (!p) return
    const dcl = this.dclPointFromRaycast(p)
    const grid = worldToHeightUv(
      dcl.x,
      dcl.z,
      this.resolution,
      this.arenaWidthM,
      this.arenaDepthM,
      this.arenaOriginX,
      this.arenaOriginZ
    )
    const { ix, iz, fx, fz } = grid
    const radiusCells = computeBrushRadiusCells(
      this.settings.brushSizeM,
      this.arenaWidthM,
      this.arenaDepthM,
      this.resolution
    )

    if (this.settings.paintLayer === 'splat') {
      if (this.settings.splatChannel === 4) {
        applyLavaBrush(
          this.lava,
          this.resolution,
          fx,
          fz,
          this.arenaWidthM,
          this.arenaDepthM,
          this.settings.brushSizeM,
          this.settings.brushStrength,
          this.settings.splatErase
        )
      } else {
        applySplatBrush(
          this.splat,
          this.resolution,
          fx,
          fz,
          this.arenaWidthM,
          this.arenaDepthM,
          this.settings.brushSizeM,
          this.settings.brushStrength,
          this.settings.splatChannel,
          this.settings.splatErase
        )
      }
      this.terrain.applySplatDab(
        this.splat,
        this.lava,
        this.resolution,
        this.resolution,
        ix,
        iz,
        radiusCells
      )
      return
    }

    if (this.settings.paintLayer === 'grass') {
      const hex = this.settings.grassColor & 0xffffff
      applyGrassBrush(
        this.grass,
        this.grassRgb,
        this.resolution,
        fx,
        fz,
        this.arenaWidthM,
        this.arenaDepthM,
        this.settings.brushSizeM,
        this.settings.brushStrength,
        this.settings.splatErase,
        {
          r: (hex >> 16) & 0xff,
          g: (hex >> 8) & 0xff,
          b: hex & 0xff
        }
      )
      // Live blade preview while stroking (debounced by RAF scheduleStroke).
      this.hooks.onGrassCommitted?.()
      return
    }

    const isSmooth = this.settings.brushMode === 'smooth'
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
        waterLevelY: this.terrain.getProceduralShading().waterToY
      },
      this.flattenTargetY
    )
    const previewRadius = isSmooth
      ? radiusCells + smoothKernelRadiusCells(radiusCells)
      : radiusCells
    this.terrain.applySculptHeightDab(
      this.heights,
      this.resolution,
      ix,
      iz,
      previewRadius
    )
  }

  private pushPreview(): void {
    this.terrain.applySculptHeightBuffer(this.heights, this.resolution)
    this.terrain.applySplatBuffer(this.splat, this.resolution, this.resolution)
    this.terrain.applyLavaBuffer(this.lava, this.resolution, this.resolution)
    this.bindSharedBuffers()
  }

  private brushRadiusM(): number {
    return Math.max(TERRAIN_BRUSH_RADIUS_MIN_M, this.settings.brushSizeM)
  }

  private brushRingColor(): number {
    if (this.settings.paintLayer === 'grass') {
      return this.settings.splatErase ? 0xaa4422 : this.settings.grassColor & 0xffffff
    }
    if (this.settings.paintLayer === 'splat') {
      switch (this.settings.splatChannel) {
        case 0:
          return 0x5a9e4a
        case 1:
          return 0x8b6914
        case 2:
          return 0x8a8a8a
        case 3:
          return 0xd4b878
        case 4:
          return 0xe85a0a
        default:
          return 0x44ffaa
      }
    }
    return 0x44ffaa
  }

  private ensureBrushRing(): void {
    if (this.brushRing) return
    const geo = new THREE.RingGeometry(0.92, 1, 64)
    const mat = new THREE.MeshBasicMaterial({
      color: this.brushRingColor(),
      transparent: true,
      opacity: 0.65,
      depthTest: false,
      side: THREE.DoubleSide
    })
    this.brushRing = new THREE.Mesh(geo, mat)
    this.brushRing.rotation.x = -Math.PI / 2
    this.brushRing.renderOrder = 999
    this.brushRing.visible = this.active
    this.scene.add(this.brushRing)
  }

  private syncBrushRingScale(): void {
    this.ensureBrushRing()
    if (!this.brushRing) return
    const r = this.brushRadiusM()
    this.brushRing.scale.set(r, r, 1)
    ;(this.brushRing.material as THREE.MeshBasicMaterial).color.setHex(this.brushRingColor())
  }

  private placeBrushRing(point: THREE.Vector3): void {
    if (!this.brushRing) return
    this.brushRing.visible = this.active
    this.brushRing.position.set(point.x, point.y + 0.2, point.z)
  }

  private updateBrushRing(camera: THREE.Camera): void {
    if (!this.active) return
    this.syncBrushRingScale()
    if (!this.brushRing) return
    const p = this.raycastWorldPoint(camera)
    if (!p) {
      this.hoveredSurfaceProbe = null
      if (!this.lastBrushPoint) this.brushRing.visible = false
      return
    }
    this.hoveredSurfaceProbe = this.probeAtRaycastPoint(p)
    this.lastBrushPoint = p
    this.placeBrushRing(p)
  }
}