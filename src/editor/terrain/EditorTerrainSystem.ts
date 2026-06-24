import * as THREE from 'three'
import {
  ARENA_WATER_SURFACE_Y,
  DEFAULT_TERRAIN_PROCEDURAL_SHADING,
  TERRAIN_BIOME_COLORS,
  TERRAIN_SEA_FLOOR_WORLD_Y,
  type TerrainProceduralShading
} from './terrainSculptConstants'
import { SCULPT_RESOLUTION } from './heightmapCodec'

function glslSmoothstep(edge0: number, edge1: number, x: number): number {
  return THREE.MathUtils.smoothstep(x, edge0, edge1)
}

/** Parcel-sized sculpt terrain mesh for the editor workspace. */
export class EditorTerrainSystem {
  readonly widthM: number
  readonly depthM: number
  readonly resolution: number
  private readonly group = new THREE.Group()
  private mesh: THREE.Mesh | null = null
  private heights = new Float32Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION)
  private splat = new Uint8Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION * 4)
  private lava = new Uint8Array(SCULPT_RESOLUTION * SCULPT_RESOLUTION)
  private procedural: TerrainProceduralShading = { ...DEFAULT_TERRAIN_PROCEDURAL_SHADING }

  constructor(
    widthM: number,
    depthM: number,
    resolution = SCULPT_RESOLUTION
  ) {
    this.widthM = widthM
    this.depthM = depthM
    this.resolution = resolution
    this.heights.fill(TERRAIN_SEA_FLOOR_WORLD_Y)
    this.buildMesh()
  }

  mount(scene: THREE.Scene): void {
    scene.add(this.group)
  }

  dispose(): void {
    this.group.removeFromParent()
    if (this.mesh) {
      this.mesh.geometry.dispose()
      ;(this.mesh.material as THREE.Material).dispose()
      this.mesh = null
    }
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
    this.updateVertexColors()
  }

  getProceduralShading(): TerrainProceduralShading {
    return { ...this.procedural }
  }

  applySculptHeightBuffer(heights: Float32Array, resolution: number): void {
    if (resolution !== this.resolution || heights.length !== this.heights.length) return
    this.heights.set(heights)
    this.updatePositions()
    this.updateVertexColors()
  }

  applySplatBuffer(splat: Uint8Array, w: number, h: number): void {
    if (w !== this.resolution || h !== this.resolution) return
    this.splat.set(splat)
    this.updateVertexColors()
  }

  applyLavaBuffer(lava: Uint8Array, w: number, h: number): void {
    if (w !== this.resolution || h !== this.resolution) return
    this.lava.set(lava)
    this.updateVertexColors()
  }

  getBuffers(): { heights: Float32Array; splat: Uint8Array; lava: Uint8Array } {
    return { heights: this.heights, splat: this.splat, lava: this.lava }
  }

  setHeights(heights: Float32Array): void {
    this.heights = new Float32Array(heights)
    this.updatePositions()
    this.updateVertexColors()
  }

  setSplat(splat: Uint8Array): void {
    this.splat = new Uint8Array(splat)
    this.updateVertexColors()
  }

  setLava(lava: Uint8Array): void {
    this.lava = new Uint8Array(lava)
    this.updateVertexColors()
  }

  private buildMesh(): void {
    const seg = this.resolution - 1
    const geo = new THREE.PlaneGeometry(this.widthM, this.depthM, seg, seg)
    geo.rotateX(-Math.PI / 2)
    const colors = new Float32Array(geo.attributes.position.count * 3)
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0
    })
    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.name = 'editor-terrain'
    this.group.add(this.mesh)
    this.updatePositions()
    this.updateVertexColors()
  }

  private updatePositions(): void {
    if (!this.mesh) return
    const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute
    const res = this.resolution
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const vi = iz * res + ix
        pos.setY(vi, this.heights[vi]!)
      }
    }
    pos.needsUpdate = true
    this.mesh.geometry.computeVertexNormals()
  }

  private sampleHeightAt(ix: number, iz: number): number {
    const res = this.resolution
    const x0 = Math.max(0, ix - 1)
    const x1 = Math.min(res - 1, ix + 1)
    const z0 = Math.max(0, iz - 1)
    const z1 = Math.min(res - 1, iz + 1)
    const hL = this.heights[iz * res + x0]!
    const hR = this.heights[iz * res + x1]!
    const hD = this.heights[z0 * res + ix]!
    const hU = this.heights[z1 * res + ix]!
    const dx = (hR - hL) / Math.max(this.widthM / res, 0.01)
    const dz = (hU - hD) / Math.max(this.depthM / res, 0.01)
    return Math.hypot(dx, dz)
  }

  private colorForVertex(ix: number, iz: number): THREE.Color {
    const res = this.resolution
    const idx = iz * res + ix
    const h = this.heights[idx]!
    const o = idx * 4
    const sr = this.splat[o]! / 255
    const sg = this.splat[o + 1]! / 255
    const sb = this.splat[o + 2]! / 255
    const sa = this.splat[o + 3]! / 255
    const lavaW = this.lava[idx]! / 255
    const splatSum = sr + sg + sb + sa

    const grass = new THREE.Color(TERRAIN_BIOME_COLORS.grass)
    const dirt = new THREE.Color(TERRAIN_BIOME_COLORS.dirt)
    const rock = new THREE.Color(TERRAIN_BIOME_COLORS.rock)
    const sand = new THREE.Color(TERRAIN_BIOME_COLORS.sand)
    const lava = new THREE.Color(TERRAIN_BIOME_COLORS.lava)

    const out = new THREE.Color()
    if (splatSum > 0.05) {
      out.setRGB(0, 0, 0)
      out.r = grass.r * sr + dirt.r * sg + rock.r * sb + sand.r * sa
      out.g = grass.g * sr + dirt.g * sg + rock.g * sb + sand.g * sa
      out.b = grass.b * sr + dirt.b * sg + rock.b * sb + sand.b * sa
      const inv = 1 / splatSum
      out.multiplyScalar(inv)
    } else {
      const slope = this.sampleHeightAt(ix, iz)
      const sandT = this.procedural.sandEnabled
        ? 1 - glslSmoothstep(
            ARENA_WATER_SURFACE_Y + this.procedural.sandAboveWaterM,
            ARENA_WATER_SURFACE_Y + this.procedural.sandAboveWaterM + this.procedural.sandBandM,
            h
          )
        : 0
      const rockT = glslSmoothstep(this.procedural.rockSlopeStart, this.procedural.rockSlopeEnd, slope)
      out.copy(grass)
      out.lerp(sand, sandT * 0.85)
      out.lerp(rock, rockT * 0.9)
    }
    if (lavaW > 0.01) out.lerp(lava, Math.min(1, lavaW))
    return out
  }

  private updateVertexColors(): void {
    if (!this.mesh) return
    const colors = this.mesh.geometry.attributes.color as THREE.BufferAttribute
    const res = this.resolution
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const vi = iz * res + ix
        const c = this.colorForVertex(ix, iz)
        colors.setXYZ(vi, c.r, c.g, c.b)
      }
    }
    colors.needsUpdate = true
  }

  /** Build visible + collider meshes for GLB export. */
  buildExportMeshes(colliderSegments: number): { visible: THREE.Mesh; collider: THREE.Mesh } {
    const seg = Math.max(8, Math.min(colliderSegments, this.resolution - 1))
    const visGeo = (this.mesh!.geometry as THREE.BufferGeometry).clone()
    const colGeo = new THREE.PlaneGeometry(this.widthM, this.depthM, seg, seg)
    colGeo.rotateX(-Math.PI / 2)
    const res = this.resolution
    const colPos = colGeo.attributes.position as THREE.BufferAttribute
    const colSeg = seg
    for (let iz = 0; iz <= colSeg; iz++) {
      for (let ix = 0; ix <= colSeg; ix++) {
        const u = ix / colSeg
        const v = iz / colSeg
        const hix = Math.floor(u * (res - 1))
        const hiz = Math.floor(v * (res - 1))
        const vi = iz * (colSeg + 1) + ix
        colPos.setY(vi, this.heights[hiz * res + hix]!)
      }
    }
    colPos.needsUpdate = true
    colGeo.computeVertexNormals()

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })
    const visible = new THREE.Mesh(visGeo, mat)
    visible.name = 'terrain_mesh'

    const colMat = new THREE.MeshStandardMaterial({ color: 0x000000, visible: false })
    const collider = new THREE.Mesh(colGeo, colMat)
    collider.name = 'terrain_collider'

    return { visible, collider }
  }
}