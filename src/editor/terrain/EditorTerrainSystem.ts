import * as THREE from 'three'
import { parseParcelKey, parcelWorldOrigin } from '../../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../../dcl/content/types'
import { terrainGlbParcelMeshOffset } from '../../dcl/landscape/Utils/SceneSpace'
import {
  ARENA_WATER_SURFACE_Y,
  clampTerrainExportSegments,
  DEFAULT_TERRAIN_PROCEDURAL_SHADING,
  TERRAIN_ALBEDO_EXPORT_RESOLUTION,
  TERRAIN_BIOME_COLORS,
  TERRAIN_MERGED_EXPORT_MAX_SEGS_PER_AXIS,
  TERRAIN_MERGED_EXPORT_PARCEL_THRESHOLD,
  TERRAIN_SEA_FLOOR_WORLD_Y,
  type TerrainProceduralShading
} from './terrainSculptConstants'
import {
  sampleBilinearU8,
  sampleBilinearWorldY,
  sampleNearestWorldY,
  SCULPT_RESOLUTION
} from './heightmapCodec'
import type { TerrainSceneFootprint } from './terrainFootprint'
import { terrainCompositePosition } from './terrainFootprint'

/** Display mesh segments — lower preview mesh keeps sculpt responsive at idle. */
export const TERRAIN_PREVIEW_SEGMENTS = 256
/** Sharper live stroke preview without full 1024² mesh rebuild cost. */
export const TERRAIN_SHARP_PREVIEW_SEGMENTS = 512

function glslSmoothstep(edge0: number, edge1: number, x: number): number {
  return THREE.MathUtils.smoothstep(x, edge0, edge1)
}

/** Copy a rectangular float grid region (skips work when src === dst). */
function copyFloatRegion(
  dst: Float32Array,
  src: Float32Array,
  resolution: number,
  minIx: number,
  maxIx: number,
  minIz: number,
  maxIz: number
): void {
  if (dst === src) return
  for (let iz = minIz; iz <= maxIz; iz++) {
    const row = iz * resolution
    dst.set(src.subarray(row + minIx, row + maxIx + 1), row + minIx)
  }
}

/** Copy a rectangular byte grid region with channel stride (skips when src === dst). */
function copyU8Region(
  dst: Uint8Array,
  src: Uint8Array,
  resolution: number,
  channels: number,
  minIx: number,
  maxIx: number,
  minIz: number,
  maxIz: number
): void {
  if (dst === src) return
  for (let iz = minIz; iz <= maxIz; iz++) {
    const start = (iz * resolution + minIx) * channels
    const end = (iz * resolution + maxIx + 1) * channels
    dst.set(src.subarray(start, end), start)
  }
}

function heightBandWeight(value: number, fromY: number, toY: number, blendM: number): number {
  const lo = Math.min(fromY, toY)
  const hi = Math.max(fromY, toY)
  const blend = Math.max(0.05, blendM)
  const rise = glslSmoothstep(lo - blend, lo, value)
  const fall = 1 - glslSmoothstep(hi, hi + blend, value)
  return rise * fall
}

/** Parcel-sized sculpt terrain mesh for the editor workspace. */
export class EditorTerrainSystem {
  private footprintState: TerrainSceneFootprint
  readonly resolution: number
  readonly previewSegments: number
  private activeSegments: number
  private readonly group = new THREE.Group()
  private mesh: THREE.Mesh | null = null
  private heights = new Float32Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION)
  private splat = new Uint8Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION * 4)
  private lava = new Uint8Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION)
  private procedural: TerrainProceduralShading = { ...DEFAULT_TERRAIN_PROCEDURAL_SHADING }
  private strokeOpen = false
  /** Nearest-cell preview while sculpting (avoids bilinear “smoothing” on raise/lower). */
  private sharpStrokePreview = false
  private readonly lambertMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide
  })
  private readonly biomeColors = {
    grass: new THREE.Color(TERRAIN_BIOME_COLORS.grass),
    dirt: new THREE.Color(TERRAIN_BIOME_COLORS.dirt),
    rock: new THREE.Color(TERRAIN_BIOME_COLORS.rock),
    sand: new THREE.Color(TERRAIN_BIOME_COLORS.sand),
    lava: new THREE.Color(TERRAIN_BIOME_COLORS.lava),
    water: new THREE.Color(TERRAIN_BIOME_COLORS.water)
  }
  private readonly colorScratch = {
    procedural: new THREE.Color(),
    painted: new THREE.Color()
  }

  constructor(
    footprint: TerrainSceneFootprint,
    resolution = SCULPT_RESOLUTION,
    previewSegments = TERRAIN_PREVIEW_SEGMENTS
  ) {
    this.footprintState = footprint
    this.resolution = resolution
    this.previewSegments = previewSegments
    this.activeSegments = previewSegments
    this.heights.fill(TERRAIN_SEA_FLOOR_WORLD_Y)
    this.syncBiomeColorsFromProcedural()
    this.buildMesh()
  }

  get footprint(): TerrainSceneFootprint {
    return this.footprintState
  }

  get originX(): number {
    return this.footprintState.originX
  }

  get originZ(): number {
    return this.footprintState.originZ
  }

  get widthM(): number {
    return this.footprintState.widthM
  }

  get depthM(): number {
    return this.footprintState.depthM
  }

  /** Sync deploy footprint from scene.json (base parcel may differ from first parcel). */
  applyFootprint(footprint: TerrainSceneFootprint): void {
    this.footprintState = footprint
  }

  getCompositePosition(): { x: number; y: number; z: number } {
    return terrainCompositePosition(this.footprintState)
  }

  mount(scene: THREE.Scene): void {
    scene.add(this.group)
  }

  dispose(): void {
    this.group.removeFromParent()
    if (this.mesh) {
      this.mesh.geometry.dispose()
      this.mesh = null
    }
    this.lambertMat.dispose()
  }

  getTerrainMeshForRaycast(): THREE.Object3D {
    return this.mesh ?? this.group
  }

  copyActiveHeightGrid(resolution: number): Float32Array | null {
    if (resolution !== this.resolution) return null
    return new Float32Array(this.heights)
  }

  getHeightmapImageData(): ImageData | null {
    return null
  }

  setProceduralShading(patch: Partial<TerrainProceduralShading>): void {
    this.procedural = { ...this.procedural, ...patch }
    this.syncBiomeColorsFromProcedural()
    this.updateVertexColors()
  }

  getProceduralShading(): TerrainProceduralShading {
    return { ...this.procedural }
  }

  /** Bilinear height + slope at a DCL world XZ — matches preview vertex-color shading. */
  probeSurfaceAtDcl(dclX: number, dclZ: number): { heightM: number; slope: number } {
    const u = Math.max(0, Math.min(1, (dclX - this.originX) / this.widthM))
    const v = Math.max(0, Math.min(1, (dclZ - this.originZ) / this.depthM))
    const heightM = sampleBilinearWorldY(this.heights, this.resolution, u, v)
    const ix = Math.round(u * (this.resolution - 1))
    const iz = Math.round(v * (this.resolution - 1))
    const slope = this.sampleSlopeAt(ix, iz)
    return { heightM, slope }
  }

  beginSculptStroke(sharpPreview = true): void {
    this.strokeOpen = true
    this.sharpStrokePreview = sharpPreview
    // Positions-only during stroke — skip normals/colors until endSculptStroke.
    if (sharpPreview && this.activeSegments !== TERRAIN_SHARP_PREVIEW_SEGMENTS) {
      this.setMeshSegments(TERRAIN_SHARP_PREVIEW_SEGMENTS, { skipNormals: true, skipColors: true })
    }
  }

  endSculptStroke(): void {
    this.strokeOpen = false
    this.sharpStrokePreview = false
    if (this.activeSegments !== this.previewSegments) {
      this.setMeshSegments(this.previewSegments)
    } else {
      this.rebuildPreviewPositions()
      this.finalizePreviewMesh()
    }
  }

  beginPaintStroke(): void {
    this.strokeOpen = true
    this.sharpStrokePreview = false
    // Paint only needs colors in the dab region; avoid full-mesh color rebuild at stroke start.
    if (this.activeSegments !== TERRAIN_SHARP_PREVIEW_SEGMENTS) {
      this.setMeshSegments(TERRAIN_SHARP_PREVIEW_SEGMENTS, { skipNormals: true })
    }
  }

  endPaintStroke(splat: Uint8Array, lava: Uint8Array): void {
    if (splat.length === this.splat.length) this.splat.set(splat)
    if (lava.length === this.lava.length) this.lava.set(lava)
    this.strokeOpen = false
    this.sharpStrokePreview = false
    if (this.activeSegments !== this.previewSegments) {
      this.setMeshSegments(this.previewSegments)
    }
    this.updateVertexColors()
  }

  getMaxHeightSample(): { maxY: number; peakX: number; peakZ: number } {
    const res = this.resolution
    let maxY = this.heights[0]!
    let peakIx = 0
    let peakIz = 0
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const h = this.heights[iz * res + ix]!
        if (h > maxY) {
          maxY = h
          peakIx = ix
          peakIz = iz
        }
      }
    }
    const peakX = this.originX + (peakIx / Math.max(res - 1, 1)) * this.widthM
    const peakZ = this.originZ + (peakIz / Math.max(res - 1, 1)) * this.depthM
    return { maxY, peakX, peakZ }
  }

  /**
   * Water biome: put the heightmap under the ocean unless the user has real relief.
   *
   * Sinks flat “tan plates”:
   * - old seafloor Y=0 (above MSL −1.35)
   * - “To water” rafts at MSL
   * - Flat Land starter (constant height, little variance)
   *
   * Keeps island / rolling hills / mountains (height range ≥ ~2.5m of real relief).
   */
  sinkUnraisedSeafloorForOpenOcean(): boolean {
    const msl = ARENA_WATER_SURFACE_Y
    let maxY = -Infinity
    let minY = Infinity
    let sum = 0
    const n = this.heights.length
    for (let i = 0; i < n; i++) {
      const h = this.heights[i]!
      if (h > maxY) maxY = h
      if (h < minY) minY = h
      sum += h
    }
    const range = maxY - minY
    const mean = sum / Math.max(1, n)
    // Real sculpted/starters have multi-metre relief. Plates are nearly constant Y.
    const isFlatPlate = range < 2.5
    const plateNearSea = mean > msl - 1 && mean < msl + 10

    // Already deep seafloor — just hide color if needed.
    if (maxY < msl - 0.5) {
      this.syncOpenOceanMeshVisibility()
      return false
    }
    // Keep maps with real hills/cliffs.
    if (!isFlatPlate || !plateNearSea) {
      this.syncOpenOceanMeshVisibility()
      return false
    }

    this.heights.fill(TERRAIN_SEA_FLOOR_WORLD_Y)
    this.rebuildPreviewPositions()
    this.finalizePreviewMesh()
    this.syncOpenOceanMeshVisibility()
    return true
  }

  /**
   * Hide sculpt mesh color when fully submerged so open ocean isn’t fighting a plate.
   * Mesh stays raycastable (visible=true, colorWrite=false).
   */
  syncOpenOceanMeshVisibility(): void {
    const { maxY } = this.getMaxHeightSample()
    const above = maxY > ARENA_WATER_SURFACE_Y + 0.2
    if (!this.mesh) return
    this.mesh.visible = true
    if (above) {
      this.lambertMat.colorWrite = true
      this.lambertMat.depthWrite = true
      this.lambertMat.transparent = false
      this.lambertMat.opacity = 1
    } else {
      this.lambertMat.colorWrite = false
      this.lambertMat.depthWrite = false
      this.lambertMat.transparent = true
      this.lambertMat.opacity = 0
    }
    this.lambertMat.needsUpdate = true
  }

  /** Force every cell to deep seafloor and stop drawing the plate. */
  fillSeafloor(): void {
    this.heights.fill(TERRAIN_SEA_FLOOR_WORLD_Y)
    this.rebuildPreviewPositions()
    this.finalizePreviewMesh()
    this.syncOpenOceanMeshVisibility()
  }

  /** Restore normal opaque land draw (leave water biome). */
  restoreFullMeshDraw(): void {
    if (!this.mesh) return
    this.mesh.visible = true
    this.lambertMat.colorWrite = true
    this.lambertMat.depthWrite = true
    this.lambertMat.transparent = false
    this.lambertMat.opacity = 1
    this.lambertMat.needsUpdate = true
  }

  applySculptHeightBuffer(heights: Float32Array, resolution: number): void {
    if (resolution !== this.resolution || heights.length !== this.heights.length) return
    if (heights !== this.heights) this.heights.set(heights)
    this.rebuildPreviewPositions()
    if (!this.strokeOpen) {
      this.finalizePreviewMesh()
    }
  }

  /** Fast dab preview — dirty-rect height copy + positions only (no normals until stroke ends). */
  applySculptHeightDab(
    heights: Float32Array,
    resolution: number,
    centerIx: number,
    centerIz: number,
    radiusCells: number
  ): void {
    if (resolution !== this.resolution || heights.length !== this.heights.length) return
    const margin = 2
    const minIx = Math.max(0, centerIx - Math.ceil(radiusCells) - margin)
    const maxIx = Math.min(resolution - 1, centerIx + Math.ceil(radiusCells) + margin)
    const minIz = Math.max(0, centerIz - Math.ceil(radiusCells) - margin)
    const maxIz = Math.min(resolution - 1, centerIz + Math.ceil(radiusCells) + margin)
    copyFloatRegion(this.heights, heights, resolution, minIx, maxIx, minIz, maxIz)
    this.updatePreviewRegion(minIx, maxIx, minIz, maxIz)
  }

  applySplatBuffer(splat: Uint8Array, w: number, h: number): void {
    if (w !== this.resolution || h !== this.resolution) return
    if (splat !== this.splat) this.splat.set(splat)
    this.updateVertexColors()
  }

  /** Live splat preview — dirty-rect buffer copy + vertex colors in the dab region only. */
  applySplatDab(
    splat: Uint8Array,
    lava: Uint8Array,
    w: number,
    h: number,
    centerIx: number,
    centerIz: number,
    radiusCells: number
  ): void {
    if (w !== this.resolution || h !== this.resolution) return
    const margin = 2
    const minIx = Math.max(0, centerIx - Math.ceil(radiusCells) - margin)
    const maxIx = Math.min(this.resolution - 1, centerIx + Math.ceil(radiusCells) + margin)
    const minIz = Math.max(0, centerIz - Math.ceil(radiusCells) - margin)
    const maxIz = Math.min(this.resolution - 1, centerIz + Math.ceil(radiusCells) + margin)
    copyU8Region(this.splat, splat, this.resolution, 4, minIx, maxIx, minIz, maxIz)
    copyU8Region(this.lava, lava, this.resolution, 1, minIx, maxIx, minIz, maxIz)
    this.updateVertexColorRegion(minIx, maxIx, minIz, maxIz)
  }

  applyLavaBuffer(lava: Uint8Array, w: number, h: number): void {
    if (w !== this.resolution || h !== this.resolution) return
    if (lava !== this.lava) this.lava.set(lava)
    this.updateVertexColors()
  }

  getBuffers(): { heights: Float32Array; splat: Uint8Array; lava: Uint8Array } {
    return { heights: this.heights, splat: this.splat, lava: this.lava }
  }

  /**
   * Heightfield raycast in Three space — avoids dense mesh triangle tests while sculpting.
   * Ray is converted to DCL XZ (Y shared), then stepped over the footprint.
   */
  raycastHeightfield(
    rayOrigin: THREE.Vector3,
    rayDir: THREE.Vector3,
    out = new THREE.Vector3()
  ): THREE.Vector3 | null {
    // Three ↔ DCL: X is mirrored.
    const ox = -rayOrigin.x
    const oy = rayOrigin.y
    const oz = rayOrigin.z
    const dx = -rayDir.x
    const dy = rayDir.y
    const dz = rayDir.z
    const dirLen = Math.hypot(dx, dy, dz)
    if (dirLen < 1e-8) return null
    const inv = 1 / dirLen
    const ndx = dx * inv
    const ndy = dy * inv
    const ndz = dz * inv

    const minX = this.originX
    const maxX = this.originX + this.widthM
    const minZ = this.originZ
    const maxZ = this.originZ + this.depthM

    // XZ AABB hit range along the ray.
    let tMin = 0
    let tMax = 4000
    if (Math.abs(ndx) > 1e-8) {
      const t1 = (minX - ox) / ndx
      const t2 = (maxX - ox) / ndx
      tMin = Math.max(tMin, Math.min(t1, t2))
      tMax = Math.min(tMax, Math.max(t1, t2))
    } else if (ox < minX || ox > maxX) {
      return null
    }
    if (Math.abs(ndz) > 1e-8) {
      const t1 = (minZ - oz) / ndz
      const t2 = (maxZ - oz) / ndz
      tMin = Math.max(tMin, Math.min(t1, t2))
      tMax = Math.min(tMax, Math.max(t1, t2))
    } else if (oz < minZ || oz > maxZ) {
      return null
    }
    if (tMax < tMin || tMax < 0) return null
    tMin = Math.max(0, tMin)

    const cellM = Math.min(this.widthM, this.depthM) / Math.max(this.resolution - 1, 1)
    const step = Math.max(0.35, cellM * 0.85)
    let prevT = tMin
    let prevAbove: boolean | null = null
    let hitT: number | null = null

    for (let t = tMin; t <= tMax; t += step) {
      const wx = ox + ndx * t
      const wy = oy + ndy * t
      const wz = oz + ndz * t
      const u = (wx - this.originX) / this.widthM
      const v = (wz - this.originZ) / this.depthM
      if (u < 0 || u > 1 || v < 0 || v > 1) {
        prevT = t
        continue
      }
      const terrainY = sampleBilinearWorldY(this.heights, this.resolution, u, v)
      const above = wy >= terrainY
      if (prevAbove === true && !above) {
        // Binary refine between prevT and t.
        let lo = prevT
        let hi = t
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) * 0.5
          const mx = ox + ndx * mid
          const my = oy + ndy * mid
          const mz = oz + ndz * mid
          const mu = (mx - this.originX) / this.widthM
          const mv = (mz - this.originZ) / this.depthM
          const ty = sampleBilinearWorldY(this.heights, this.resolution, mu, mv)
          if (my >= ty) lo = mid
          else hi = mid
        }
        hitT = (lo + hi) * 0.5
        break
      }
      // Ray starts under / on surface — take first sample.
      if (prevAbove === null && !above) {
        hitT = t
        break
      }
      prevAbove = above
      prevT = t
    }

    if (hitT == null) return null
    const hx = ox + ndx * hitT
    const hz = oz + ndz * hitT
    const hu = Math.max(0, Math.min(1, (hx - this.originX) / this.widthM))
    const hv = Math.max(0, Math.min(1, (hz - this.originZ) / this.depthM))
    const hy = sampleBilinearWorldY(this.heights, this.resolution, hu, hv)
    return out.set(-hx, hy, hz)
  }

  setHeights(heights: Float32Array): void {
    this.heights = new Float32Array(heights)
    this.rebuildPreviewPositions()
    this.finalizePreviewMesh()
  }

  setSplat(splat: Uint8Array): void {
    this.splat = new Uint8Array(splat)
    this.updateVertexColors()
  }

  setLava(lava: Uint8Array): void {
    this.lava = new Uint8Array(lava)
    this.updateVertexColors()
  }

  private syncBiomeColorsFromProcedural(): void {
    this.biomeColors.grass.setHex(this.procedural.grassColor)
    this.biomeColors.sand.setHex(this.procedural.sandColor)
    this.biomeColors.rock.setHex(this.procedural.rockColor)
    this.biomeColors.water.setHex(this.procedural.waterColor)
  }

  private buildMesh(): void {
    const geo = this.createTerrainGeometry(this.activeSegments)
    this.mesh = new THREE.Mesh(geo, this.lambertMat)
    this.mesh.name = 'editor-terrain'
    // Match ECS terrain GLB: mirror X so preview aligns with composite entities (dclToThree).
    this.mesh.scale.x = -1
    this.group.add(this.mesh)
    this.rebuildPreviewPositions()
    this.updateVertexColors()
    this.finalizePreviewMesh()
  }

  private createTerrainGeometry(segs: number): THREE.PlaneGeometry {
    const geo = new THREE.PlaneGeometry(this.widthM, this.depthM, segs, segs)
    geo.rotateX(-Math.PI / 2)
    geo.translate(this.originX + this.widthM / 2, 0, this.originZ + this.depthM / 2)
    const colors = new Float32Array(geo.attributes.position.count * 3)
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return geo
  }

  private setMeshSegments(
    segs: number,
    opts?: { skipNormals?: boolean; skipColors?: boolean }
  ): void {
    if (!this.mesh || this.activeSegments === segs) return
    this.activeSegments = segs
    const oldGeo = this.mesh.geometry
    this.mesh.geometry = this.createTerrainGeometry(segs)
    oldGeo.dispose()
    this.rebuildPreviewPositions()
    if (!opts?.skipColors) this.updateVertexColors()
    if (!opts?.skipNormals) this.mesh.geometry.computeVertexNormals()
  }

  /** Heightmap U for a preview mesh column — DCL X rises with column after `mesh.scale.x = -1`. */
  private heightmapUAtMeshCol(col: number, segs: number): number {
    return col / segs
  }

  private rebuildPreviewPositions(): void {
    if (!this.mesh) return
    const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute
    const segs = this.activeSegments
    for (let row = 0; row <= segs; row++) {
      for (let col = 0; col <= segs; col++) {
        const vertIdx = row * (segs + 1) + col
        const u = this.heightmapUAtMeshCol(col, segs)
        const v = row / segs
        pos.setY(vertIdx, this.samplePreviewWorldY(u, v))
      }
    }
    pos.needsUpdate = true
  }

  private updatePreviewRegion(minIx: number, maxIx: number, minIz: number, maxIz: number): void {
    if (!this.mesh) return
    const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute
    const segs = this.activeSegments
    const res = this.resolution
    const minU = Math.max(0, minIx / (res - 1))
    const maxU = Math.min(1, maxIx / (res - 1))
    const minV = Math.max(0, minIz / (res - 1))
    const maxV = Math.min(1, maxIz / (res - 1))
    const col0 = Math.max(0, Math.floor(minU * segs) - 1)
    const col1 = Math.min(segs, Math.ceil(maxU * segs) + 1)
    const row0 = Math.max(0, Math.floor(minV * segs) - 1)
    const row1 = Math.min(segs, Math.ceil(maxV * segs) + 1)

    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) {
        const vertIdx = row * (segs + 1) + col
        const u = this.heightmapUAtMeshCol(col, segs)
        const v = row / segs
        pos.setY(vertIdx, this.samplePreviewWorldY(u, v))
      }
    }
    pos.needsUpdate = true
  }

  private finalizePreviewMesh(): void {
    if (!this.mesh) return
    this.mesh.geometry.computeVertexNormals()
    this.updateVertexColors()
  }

  private samplePreviewWorldY(u: number, v: number): number {
    const res = this.resolution
    if (this.strokeOpen && this.sharpStrokePreview) {
      return sampleNearestWorldY(this.heights, res, u, v)
    }
    return sampleBilinearWorldY(this.heights, res, u, v)
  }

  /** Slope 0–1 — matches genesis `genesisTerrainAlbedo` / `sampleGrassPlacementWeight`. */
  private sampleSlopeAt(ix: number, iz: number): number {
    const res = this.resolution
    const ds = 0.85
    const cellW = this.widthM / Math.max(res - 1, 1)
    const cellD = this.depthM / Math.max(res - 1, 1)
    const dIx = Math.max(1, Math.round(ds / cellW))
    const dIz = Math.max(1, Math.round(ds / cellD))
    const x0 = Math.max(0, ix - dIx)
    const x1 = Math.min(res - 1, ix + dIx)
    const z0 = Math.max(0, iz - dIz)
    const z1 = Math.min(res - 1, iz + dIz)
    const hx = this.heights[iz * res + x1]! - this.heights[iz * res + x0]!
    const hz = this.heights[z1 * res + ix]! - this.heights[z0 * res + ix]!
    const grad = Math.sqrt(hx * hx + hz * hz) / (2 * ds)
    return THREE.MathUtils.clamp(grad, 0, 1)
  }

  private proceduralColorAt(
    u: number,
    v: number,
    h: number,
    out: THREE.Color
  ): THREE.Color {
    const res = this.resolution
    const fu = Math.max(0, Math.min(1, u)) * (res - 1)
    const fv = Math.max(0, Math.min(1, v)) * (res - 1)
    const slope = this.sampleSlopeAt(Math.round(fu), Math.round(fv))
    const { grass, sand, rock, water } = this.biomeColors
    const sandW =
      heightBandWeight(h, this.procedural.sandFromY, this.procedural.sandToY, this.procedural.sandBlendM) *
      (1 - slope * 0.08)
    const waterW =
      heightBandWeight(h, this.procedural.waterFromY, this.procedural.waterToY, this.procedural.waterBlendM) *
      (1 - sandW * 0.85)
    const grassW = heightBandWeight(
      h,
      this.procedural.grassFromY,
      this.procedural.grassToY,
      this.procedural.grassBlendM
    )
    const rockW =
      heightBandWeight(h, this.procedural.rockFromY, this.procedural.rockToY, this.procedural.rockBlendM) *
      (1 - sandW * 0.85)
    out.copy(grass)
    out.multiplyScalar(THREE.MathUtils.clamp(grassW, 0.15, 1))
    out.lerp(water, THREE.MathUtils.clamp(waterW, 0, 1))
    out.lerp(sand, THREE.MathUtils.clamp(sandW, 0, 1))
    out.lerp(rock, THREE.MathUtils.clamp(rockW, 0, 1))
    return out
  }

  private splatColorAt(
    sr: number,
    sg: number,
    sb: number,
    sa: number,
    splatSum: number,
    out: THREE.Color
  ): THREE.Color {
    const { grass, dirt, rock, sand } = this.biomeColors
    if (splatSum <= 1e-6) {
      out.setRGB(0, 0, 0)
      return out
    }
    out.setRGB(0, 0, 0)
    out.r = grass.r * sr + dirt.r * sg + rock.r * sb + sand.r * sa
    out.g = grass.g * sr + dirt.g * sg + rock.g * sb + sand.g * sa
    out.b = grass.b * sr + dirt.b * sg + rock.b * sb + sand.b * sa
    out.multiplyScalar(1 / splatSum)
    return out
  }

  private colorForVertexAtUv(u: number, v: number, out: THREE.Color): THREE.Color {
    const res = this.resolution
    const h = sampleBilinearWorldY(this.heights, res, u, v)
    const sr = sampleBilinearU8(this.splat, res, u, v, 4, 0)
    const sg = sampleBilinearU8(this.splat, res, u, v, 4, 1)
    const sb = sampleBilinearU8(this.splat, res, u, v, 4, 2)
    const sa = sampleBilinearU8(this.splat, res, u, v, 4, 3)
    const lavaW = sampleBilinearU8(this.lava, res, u, v)
    const splatSum = sr + sg + sb + sa
    const { lava } = this.biomeColors
    this.proceduralColorAt(u, v, h, this.colorScratch.procedural)
    this.splatColorAt(sr, sg, sb, sa, splatSum, this.colorScratch.painted)
    const paintW = THREE.MathUtils.smoothstep(0.02, 0.22, splatSum)
    out.copy(this.colorScratch.procedural)
    if (paintW > 0) out.lerp(this.colorScratch.painted, paintW)
    if (lavaW > 0.01) out.lerp(lava, Math.min(1, lavaW))
    return out
  }

  private updateVertexColors(): void {
    if (!this.mesh) return
    const colors = this.mesh.geometry.attributes.color as THREE.BufferAttribute
    const segs = this.activeSegments
    const tmp = new THREE.Color()
    for (let row = 0; row <= segs; row++) {
      for (let col = 0; col <= segs; col++) {
        const vertIdx = row * (segs + 1) + col
        const u = this.heightmapUAtMeshCol(col, segs)
        const v = row / segs
        const c = this.colorForVertexAtUv(u, v, tmp)
        colors.setXYZ(vertIdx, c.r, c.g, c.b)
      }
    }
    colors.needsUpdate = true
  }

  private updateVertexColorRegion(minIx: number, maxIx: number, minIz: number, maxIz: number): void {
    if (!this.mesh) return
    const colors = this.mesh.geometry.attributes.color as THREE.BufferAttribute
    const segs = this.activeSegments
    const res = this.resolution
    const minU = Math.max(0, minIx / (res - 1))
    const maxU = Math.min(1, maxIx / (res - 1))
    const minV = Math.max(0, minIz / (res - 1))
    const maxV = Math.min(1, maxIz / (res - 1))
    const col0 = Math.max(0, Math.floor(minU * segs) - 1)
    const col1 = Math.min(segs, Math.ceil(maxU * segs) + 1)
    const row0 = Math.max(0, Math.floor(minV * segs) - 1)
    const row1 = Math.min(segs, Math.ceil(maxV * segs) + 1)
    const tmp = new THREE.Color()

    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) {
        const vertIdx = row * (segs + 1) + col
        const u = this.heightmapUAtMeshCol(col, segs)
        const v = row / segs
        const c = this.colorForVertexAtUv(u, v, tmp)
        colors.setXYZ(vertIdx, c.r, c.g, c.b)
      }
    }
    colors.needsUpdate = true
  }

  private gridUvAtWorld(worldX: number, worldZ: number): { u: number; v: number } {
    return {
      u: (worldX - this.originX) / this.widthM,
      v: (worldZ - this.originZ) / this.depthM
    }
  }

  /** Footprint-sized albedo — embedded in terrain.glb for Unity Explorer (no vertex-paint support). */
  private buildFootprintAlbedoTexture(): THREE.DataTexture {
    const res = TERRAIN_ALBEDO_EXPORT_RESOLUTION
    const data = new Uint8Array(res * res * 4)
    const tmp = new THREE.Color()
    for (let iz = 0; iz < res; iz++) {
      const v = iz / Math.max(res - 1, 1)
      for (let ix = 0; ix < res; ix++) {
        const u = ix / Math.max(res - 1, 1)
        const c = this.colorForVertexAtUv(u, v, tmp)
        const o = (iz * res + ix) * 4
        data[o] = Math.round(c.r * 255)
        data[o + 1] = Math.round(c.g * 255)
        data[o + 2] = Math.round(c.b * 255)
        data[o + 3] = 255
      }
    }
    const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType)
    tex.name = 'terrain_albedo'
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    return tex
  }

  private buildParcelExportGeometry(
    parcelWorldX: number,
    parcelWorldZ: number,
    segments: number,
    withFootprintUv: boolean
  ): THREE.BufferGeometry {
    const seg = Math.max(4, Math.min(segments, this.resolution - 1))
    const geo = new THREE.PlaneGeometry(PARCEL_SIZE, PARCEL_SIZE, seg, seg)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute
    const res = this.resolution
    const uv = withFootprintUv ? (geo.attributes.uv as THREE.BufferAttribute) : null
    const half = PARCEL_SIZE / 2

    for (let row = 0; row <= seg; row++) {
      for (let col = 0; col <= seg; col++) {
        const vi = row * (seg + 1) + col
        const localX = pos.getX(vi)
        const localZ = pos.getZ(vi)
        const worldX = parcelWorldX + localX + half
        const worldZ = parcelWorldZ + localZ + half
        const { u, v } = this.gridUvAtWorld(worldX, worldZ)
        pos.setY(vi, sampleBilinearWorldY(this.heights, res, u, v))
        if (uv) uv.setXY(vi, u, v)
      }
    }
    pos.needsUpdate = true
    if (uv) uv.needsUpdate = true
    geo.computeVertexNormals()
    return geo
  }

  usesMergedExportMesh(): boolean {
    return this.footprint.parcels.length > TERRAIN_MERGED_EXPORT_PARCEL_THRESHOLD
  }

  /** One 16×16 m plane per parcel — or one capped footprint mesh on very large scenes. */
  buildExportMeshes(exportSegmentsPerParcel: number): THREE.Group {
    if (this.usesMergedExportMesh()) {
      return this.buildMergedFootprintExportMeshes(exportSegmentsPerParcel)
    }
    const root = new THREE.Group()
    root.name = 'terrain_root'
    root.userData.dclAuthorTerrainRoot = true
    const base = parseParcelKey(this.footprint.baseParcel)
    const parcels = [...this.footprint.parcels].sort((a, b) => {
      const pa = parseParcelKey(a)
      const pb = parseParcelKey(b)
      return pa.y - pb.y || pa.x - pb.x
    })

    const albedoMap = this.buildFootprintAlbedoTexture()
    const visibleMat = new THREE.MeshStandardMaterial({
      name: 'Terrain_Albedo_MAT',
      color: 0xffffff,
      map: albedoMap,
      metalness: 0,
      roughness: 1,
      side: THREE.DoubleSide
    })

    for (const key of parcels) {
      const parcel = parseParcelKey(key)
      const world = parcelWorldOrigin(parcel, base)
      const meshOffset = terrainGlbParcelMeshOffset(world.x, world.z, this.originX, this.originZ)
      const safeKey = key.replace(',', '_')

      const visibleGeo = this.buildParcelExportGeometry(world.x, world.z, exportSegmentsPerParcel, true)
      const visible = new THREE.Mesh(visibleGeo, visibleMat)
      visible.name = `terrain_mesh_${safeKey}`
      visible.userData.dclAuthorTerrain = true
      visible.position.set(meshOffset.x, meshOffset.y, meshOffset.z)
      visible.scale.x = -1
      root.add(visible)
    }

    return root
  }

  /** Single footprint mesh — avoids O(parcel count) geometry allocation on huge scenes. */
  private buildMergedFootprintExportMeshes(exportSegmentsPerParcel: number): THREE.Group {
    const root = new THREE.Group()
    root.name = 'terrain_root'
    root.userData.dclAuthorTerrainRoot = true

    const seg = clampTerrainExportSegments(exportSegmentsPerParcel)
    const cols = Math.max(1, Math.round(this.widthM / PARCEL_SIZE))
    const rows = Math.max(1, Math.round(this.depthM / PARCEL_SIZE))
    const segsX = Math.min(TERRAIN_MERGED_EXPORT_MAX_SEGS_PER_AXIS, cols * seg)
    const segsZ = Math.min(TERRAIN_MERGED_EXPORT_MAX_SEGS_PER_AXIS, rows * seg)

    const albedoMap = this.buildFootprintAlbedoTexture()
    const visibleMat = new THREE.MeshStandardMaterial({
      name: 'Terrain_Albedo_MAT',
      color: 0xffffff,
      map: albedoMap,
      metalness: 0,
      roughness: 1,
      side: THREE.DoubleSide
    })

    const geo = new THREE.PlaneGeometry(this.widthM, this.depthM, segsX, segsZ)
    geo.rotateX(-Math.PI / 2)
    geo.translate(this.originX + this.widthM / 2, 0, this.originZ + this.depthM / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute
    const uv = geo.attributes.uv as THREE.BufferAttribute
    const res = this.resolution

    for (let row = 0; row <= segsZ; row++) {
      for (let col = 0; col <= segsX; col++) {
        const vi = row * (segsX + 1) + col
        const worldX = pos.getX(vi)
        const worldZ = pos.getZ(vi)
        const { u, v } = this.gridUvAtWorld(worldX, worldZ)
        pos.setY(vi, sampleBilinearWorldY(this.heights, res, u, v))
        uv.setXY(vi, u, v)
      }
    }
    pos.needsUpdate = true
    uv.needsUpdate = true
    geo.computeVertexNormals()

    const visible = new THREE.Mesh(geo, visibleMat)
    visible.name = 'terrain_mesh_merged'
    visible.userData.dclAuthorTerrain = true
    visible.scale.x = -1
    root.add(visible)

    return root
  }
}