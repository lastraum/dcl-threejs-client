import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { dclToThreePos } from '../../bridge/dclTransform'
import { EZ_TREE_GRASS, EZ_TREE_GRASS_TINT_RGB } from '../../dcl/landscape/landscapeAssets'
import { grassInstanceColor } from '../../dcl/landscape/groundGlbTint'
import { simplex2d } from '../../dcl/landscape/simplex2d'
import { mulberry32 } from '../../dcl/landscape/Utils/SeededRandom'
import { appendGrassWindShader, setGrassWindElapsed } from '../../dcl/landscape/grassWindShader'
import { sampleBilinearWorldY } from './heightmapCodec'

/** Match ez-tree grass sizing used by outdoor EzTreeGrassField. */
const WORLD_SIZE_MULTIPLIER = 0.12
const BLADE_SIZE = { x: 5, y: 4, z: 5 }
const BLADE_VAR = { x: 1, y: 2, z: 1 }

const GRASS_TINT = new THREE.Color(
  EZ_TREE_GRASS_TINT_RGB.r / 255,
  EZ_TREE_GRASS_TINT_RGB.g / 255,
  EZ_TREE_GRASS_TINT_RGB.b / 255
)

/** Max blades in the editor preview (keeps paint responsive). */
/** Grid step in metres for grass candidate samples. */
const SAMPLE_STEP_M = 1.15
/** Density mask threshold 0–1 (dedicated grass.png / session grass mask). */
const GRASS_THRESHOLD = 0.12
/** Skip blades on steep slopes. */
const MAX_SLOPE = 0.55

type Blade = {
  x: number
  y: number
  z: number
  rotY: number
  scaleX: number
  scaleY: number
  scaleZ: number
  color: THREE.Color
}

let meshTemplate: THREE.Mesh | null = null
let loadPromise: Promise<THREE.Mesh> | null = null

async function fetchGrassMesh(): Promise<THREE.Mesh> {
  if (meshTemplate) return meshTemplate
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const loader = new GLTFLoader()
    const gltf = await loader.loadAsync(EZ_TREE_GRASS.glb)
    const mesh = gltf.scene.children[0]
    if (!(mesh instanceof THREE.Mesh) || !mesh.geometry) {
      throw new Error('editor grass: expected Mesh in grass.glb')
    }
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    if (mat && 'map' in mat && mat.map instanceof THREE.Texture) {
      mat.map.colorSpace = THREE.SRGBColorSpace
    }
    meshTemplate = mesh
    return mesh
  })()
  return loadPromise
}

function createGrassMaterial(map: THREE.Texture, windShader: boolean): THREE.MeshPhongMaterial {
  // Base white so instanceColor (from grass-color.png / picker) drives tint.
  const material = new THREE.MeshPhongMaterial({
    map,
    color: 0xffffff,
    emissive: 0x222222,
    emissiveIntensity: 0.05,
    transparent: false,
    alphaTest: 0.5,
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide
  })
  if (windShader) appendGrassWindShader(material, true)
  return material
}

function sampleSlope(
  heights: Float32Array,
  resolution: number,
  ix: number,
  iz: number,
  widthM: number,
  depthM: number
): number {
  const ds = 0.85
  const cellW = widthM / Math.max(resolution - 1, 1)
  const cellD = depthM / Math.max(resolution - 1, 1)
  const dIx = Math.max(1, Math.round(ds / cellW))
  const dIz = Math.max(1, Math.round(ds / cellD))
  const x0 = Math.max(0, ix - dIx)
  const x1 = Math.min(resolution - 1, ix + dIx)
  const z0 = Math.max(0, iz - dIz)
  const z1 = Math.min(resolution - 1, iz + dIz)
  const hx = heights[iz * resolution + x1]! - heights[iz * resolution + x0]!
  const hz = heights[z1 * resolution + ix]! - heights[z0 * resolution + ix]!
  const grad = Math.sqrt(hx * hx + hz * hz) / (2 * ds)
  return THREE.MathUtils.clamp(grad, 0, 1)
}

function collectBlades(
  heights: Float32Array,
  grassMask: Uint8Array,
  grassRgb: Uint8Array | null,
  resolution: number,
  originX: number,
  originZ: number,
  widthM: number,
  depthM: number,
  seed: number
): Blade[] {
  const blades: Blade[] = []
  const step = SAMPLE_STEP_M
  const cols = Math.max(1, Math.ceil(widthM / step))
  const rows = Math.max(1, Math.ceil(depthM / step))
  const tintScratch = new THREE.Color()

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const dclX = originX + (col + 0.5) * step + simplex2d(col * 0.37, row * 0.41) * 0.35
      const dclZ = originZ + (row + 0.5) * step + simplex2d(col * 0.29, row * 0.33) * 0.35
      if (dclX < originX || dclX > originX + widthM || dclZ < originZ || dclZ > originZ + depthM) {
        continue
      }
      const u = (dclX - originX) / widthM
      const v = (dclZ - originZ) / depthM
      const ix = Math.round(u * (resolution - 1))
      const iz = Math.round(v * (resolution - 1))
      const grassW = grassMask[iz * resolution + ix]! / 255
      if (grassW < GRASS_THRESHOLD) continue

      const slope = sampleSlope(heights, resolution, ix, iz, widthM, depthM)
      if (slope > MAX_SLOPE) continue

      const rng = mulberry32(((iz * 73856093) ^ (ix * 19349663) ^ seed) >>> 0)
      if (rng() > grassW * 0.95) continue

      const y = sampleBilinearWorldY(heights, resolution, u, v)
      const three = dclToThreePos(dclX, y, dclZ)
      const m = WORLD_SIZE_MULTIPLIER
      const scaleX = (BLADE_VAR.x * rng() + BLADE_SIZE.x) * m
      const scaleY = (BLADE_VAR.y * rng() + BLADE_SIZE.y) * m
      const scaleZ = (BLADE_VAR.z * rng() + BLADE_SIZE.z) * m

      let color: THREE.Color
      if (grassRgb && grassRgb.length >= (iz * resolution + ix + 1) * 3) {
        const c = (iz * resolution + ix) * 3
        const r = grassRgb[c]! / 255
        const g = grassRgb[c + 1]! / 255
        const b = grassRgb[c + 2]! / 255
        if (r + g + b > 0.02) {
          tintScratch.setRGB(r, g, b)
          color = grassInstanceColor(rng, tintScratch)
        } else {
          color = grassInstanceColor(rng, GRASS_TINT)
        }
      } else {
        color = grassInstanceColor(rng, GRASS_TINT)
      }

      blades.push({
        x: three.x,
        y: three.y,
        z: three.z,
        rotY: rng() * Math.PI * 2,
        scaleX,
        scaleY,
        scaleZ,
        color
      })
    }
  }
  return blades
}

/**
 * Editor ez-tree grass blade GLBs from the dedicated Grass density mask.
 * Not heightmap/splat albedo paint.
 */
export class EditorGrassPaint {
  readonly group = new THREE.Group()
  private mesh: THREE.InstancedMesh | null = null
  private material: THREE.MeshPhongMaterial | null = null
  private geometry: THREE.BufferGeometry | null = null
  private capacity = 0
  private elapsed = 0
  private rebuildToken = 0
  private ready = false
  private windShader: boolean
  private readonly seed: number

  private constructor(windShader: boolean, seed: number) {
    this.windShader = windShader
    this.seed = seed
    this.group.name = 'editor-ez-tree-grass'
  }

  static async create(opts?: { windShader?: boolean; seed?: number }): Promise<EditorGrassPaint> {
    // Default on — matches client readEnvironmentWindShader.
    const field = new EditorGrassPaint(opts?.windShader !== false, opts?.seed ?? 42)
    const source = await fetchGrassMesh()
    const mat = Array.isArray(source.material) ? source.material[0] : source.material
    const map =
      mat && 'map' in mat && mat.map instanceof THREE.Texture ? mat.map : null
    if (!map) throw new Error('editor grass: missing texture map')
    field.material = createGrassMaterial(map, field.windShader)
    field.geometry = source.geometry
    field.ready = true
    return field
  }

  mount(scene: THREE.Scene): void {
    scene.add(this.group)
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  /** Rebuild blades from height + density + optional RGB plant colors. */
  rebuild(
    heights: Float32Array,
    grassMask: Uint8Array,
    resolution: number,
    originX: number,
    originZ: number,
    widthM: number,
    depthM: number,
    grassRgb?: Uint8Array | null
  ): void {
    if (!this.ready || !this.material || !this.geometry) return
    const token = ++this.rebuildToken
    const blades = collectBlades(
      heights,
      grassMask,
      grassRgb ?? null,
      resolution,
      originX,
      originZ,
      widthM,
      depthM,
      this.seed
    )
    if (token !== this.rebuildToken) return

    this.ensureCapacity(Math.max(blades.length, 1))
    if (!this.mesh) return

    const dummy = new THREE.Object3D()
    for (let i = 0; i < blades.length; i++) {
      const b = blades[i]!
      dummy.position.set(b.x, b.y, b.z)
      dummy.rotation.set(0, b.rotY, 0)
      dummy.scale.set(b.scaleX, b.scaleY, b.scaleZ)
      dummy.updateMatrix()
      this.mesh.setMatrixAt(i, dummy.matrix)
      this.mesh.setColorAt(i, b.color)
    }
    this.mesh.count = blades.length
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    this.group.userData.grassInstanceCount = blades.length
  }

  /** Grow InstancedMesh only when blade count exceeds current capacity (no hard max). */
  private ensureCapacity(count: number): void {
    if (!this.geometry || !this.material) return
    if (this.mesh && this.capacity >= count) return

    if (this.mesh) {
      this.group.remove(this.mesh)
      this.mesh.dispose()
      this.mesh = null
    }
    // Small headroom so stroke rebuilds don't thrash realloc every dab.
    this.capacity = Math.max(count, Math.ceil(count * 1.15))
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, this.capacity)
    this.mesh.name = 'editor-ez-tree-grass:instances'
    this.mesh.count = 0
    this.mesh.castShadow = false
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.group.add(this.mesh)
  }

  update(delta: number): void {
    this.elapsed += delta
    if (this.windShader) setGrassWindElapsed(this.material, this.elapsed)
  }

  dispose(): void {
    this.mesh?.dispose()
    this.material?.dispose()
    this.group.removeFromParent()
    this.mesh = null
    this.material = null
    this.geometry = null
    this.capacity = 0
  }
}
