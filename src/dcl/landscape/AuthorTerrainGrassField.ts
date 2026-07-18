import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { dclToThreePos } from '../../bridge/dclTransform'
import type { ResolvedScene } from '../content/types'
import { EZ_TREE_GRASS, EZ_TREE_GRASS_TINT_RGB } from './landscapeAssets'
import { grassInstanceColor } from './groundGlbTint'
import { simplex2d } from './simplex2d'
import { mulberry32 } from './Utils/SeededRandom'
import { sampleBilinearWorldY } from '../../editor/terrain/heightmapCodec'
import { appendGrassWindShader, setGrassWindElapsed } from './grassWindShader'
import {
  loadAuthorTerrainBuffers,
  type AuthorTerrainBuffers
} from './loadAuthorTerrainBuffers'
import type { EzTreeGrassFieldHandle } from './EzTreeGrassField'

const WORLD_SIZE_MULTIPLIER = 0.12
const BLADE_SIZE = { x: 5, y: 4, z: 5 }
const BLADE_VAR = { x: 1, y: 2, z: 1 }
const SAMPLE_STEP_M = 1.15
const GRASS_THRESHOLD = 0.28
const MAX_SLOPE = 0.55
const LOD_NEAR_M = 80
const LOD_FAR_M = 420
const LOD_MIN_FRACTION = 0.18

const GRASS_TINT = new THREE.Color(
  EZ_TREE_GRASS_TINT_RGB.r / 255,
  EZ_TREE_GRASS_TINT_RGB.g / 255,
  EZ_TREE_GRASS_TINT_RGB.b / 255
)

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
      throw new Error('author-terrain grass: expected Mesh in grass.glb')
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
  return THREE.MathUtils.clamp(Math.sqrt(hx * hx + hz * hz) / (2 * ds), 0, 1)
}

/** Place ez-tree blade GLBs from density + RGB plant colors + heights. */
function collectAuthorBlades(buffers: AuthorTerrainBuffers, seed: number): Blade[] {
  const { heights, grass, grassRgb, resolution, originX, originZ, widthM, depthM } = buffers
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
      const grassW = grass[iz * resolution + ix]! / 255
      if (grassW < GRASS_THRESHOLD) continue

      const slope = sampleSlope(heights, resolution, ix, iz, widthM, depthM)
      if (slope > MAX_SLOPE) continue

      const rng = mulberry32(((iz * 73856093) ^ (ix * 19349663) ^ seed) >>> 0)
      if (rng() > grassW * 0.95) continue

      const y = sampleBilinearWorldY(heights, resolution, u, v)
      const three = dclToThreePos(dclX, y, dclZ)
      const m = WORLD_SIZE_MULTIPLIER

      let color: THREE.Color
      const c = (iz * resolution + ix) * 3
      if (grassRgb.length >= c + 3) {
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
        scaleX: (BLADE_VAR.x * rng() + BLADE_SIZE.x) * m,
        scaleY: (BLADE_VAR.y * rng() + BLADE_SIZE.y) * m,
        scaleZ: (BLADE_VAR.z * rng() + BLADE_SIZE.z) * m,
        color
      })
    }
  }
  return blades
}

function createMaterial(map: THREE.Texture, windShader: boolean): THREE.MeshPhongMaterial {
  // White base so instanceColor (grass-color.png) drives tint.
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

/**
 * ez-tree grass.glb blades on editor-authored terrain (any `environment` kind).
 * Driven by deployable grass.png density + heightmap.heights.bin from the Grass tool.
 */
export async function buildAuthorTerrainGrassField(
  scene: ResolvedScene,
  options?: { windShader?: boolean; onProgress?: (msg: string) => void }
): Promise<EzTreeGrassFieldHandle | null> {
  const buffers = await loadAuthorTerrainBuffers(scene)
  if (!buffers) return null

  const windShader = options?.windShader !== false
  const seed = 17
  const blades = collectAuthorBlades(buffers, seed)
  if (!blades.length) {
    options?.onProgress?.('author-terrain grass: no blades (use Grass tab to plant)')
    return null
  }

  options?.onProgress?.(
    `author-terrain grass: ${blades.length} blades${windShader ? ' + windShader' : ''}`
  )
  console.info(
    `[windShader] author-terrain grass (${blades.length} blades, env=${String(scene.landscapeEnvironment)}) wind=${windShader}`
  )

  const source = await fetchGrassMesh()
  const mat = Array.isArray(source.material) ? source.material[0] : source.material
  const map = mat && 'map' in mat && mat.map instanceof THREE.Texture ? mat.map : null
  if (!map) throw new Error('author-terrain grass: missing texture')

  const grassMaterial = createMaterial(map, windShader)
  const grassMesh = new THREE.InstancedMesh(source.geometry, grassMaterial, blades.length)
  grassMesh.name = 'landscape:author-terrain-grass'
  grassMesh.castShadow = false
  grassMesh.receiveShadow = true
  grassMesh.count = blades.length
  grassMesh.frustumCulled = false

  const dummy = new THREE.Object3D()
  const sortedByDist = blades.map((inst) => ({ inst, distSq: 0 }))
  for (let i = 0; i < blades.length; i++) {
    const b = blades[i]!
    dummy.position.set(b.x, b.y, b.z)
    dummy.rotation.set(0, b.rotY, 0)
    dummy.scale.set(b.scaleX, b.scaleY, b.scaleZ)
    dummy.updateMatrix()
    grassMesh.setMatrixAt(i, dummy.matrix)
    grassMesh.setColorAt(i, b.color)
  }
  grassMesh.instanceMatrix.needsUpdate = true
  if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true

  const group = new THREE.Group()
  group.name = 'landscape:author-terrain-grass-field'
  group.add(grassMesh)

  const centerThree = new THREE.Vector3()
  dclToThreePos(
    buffers.originX + buffers.widthM * 0.5,
    0,
    buffers.originZ + buffers.depthM * 0.5,
    centerThree
  )

  let lastLodUpdate = 0
  const update = (elapsed: number, cameraPos: THREE.Vector3): void => {
    if (windShader) setGrassWindElapsed(grassMaterial, elapsed)

    const now = performance.now()
    if (now - lastLodUpdate < 120) return
    lastLodUpdate = now

    const camDist = cameraPos.distanceTo(centerThree)
    const lodT = THREE.MathUtils.clamp((camDist - LOD_NEAR_M) / (LOD_FAR_M - LOD_NEAR_M), 0, 1)
    const lodFraction = THREE.MathUtils.lerp(1, LOD_MIN_FRACTION, lodT * lodT)
    const targetCount = Math.max(1, Math.floor(blades.length * lodFraction))

    for (let i = 0; i < sortedByDist.length; i++) {
      const inst = sortedByDist[i]!.inst
      const dx = inst.x - cameraPos.x
      const dz = inst.z - cameraPos.z
      sortedByDist[i]!.distSq = dx * dx + dz * dz
    }
    sortedByDist.sort((a, b) => a.distSq - b.distSq)

    for (let i = 0; i < targetCount; i++) {
      const { inst } = sortedByDist[i]!
      dummy.position.set(inst.x, inst.y, inst.z)
      dummy.rotation.set(0, inst.rotY, 0)
      dummy.scale.set(inst.scaleX, inst.scaleY, inst.scaleZ)
      dummy.updateMatrix()
      grassMesh.setMatrixAt(i, dummy.matrix)
      grassMesh.setColorAt(i, inst.color)
    }
    grassMesh.count = targetCount
    grassMesh.instanceMatrix.needsUpdate = true
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true
  }

  const dispose = (): void => {
    grassMaterial.dispose()
    grassMesh.dispose()
    group.removeFromParent()
  }

  group.userData.grassInstanceCount = blades.length
  return { group, update, dispose }
}

/** Merge two grass field handles into one World-facing handle. */
export function combineGrassHandles(
  a: EzTreeGrassFieldHandle | null,
  b: EzTreeGrassFieldHandle | null
): EzTreeGrassFieldHandle | null {
  if (a && !b) return a
  if (b && !a) return b
  if (!a || !b) return null
  const group = new THREE.Group()
  group.name = 'landscape:combined-grass'
  group.add(a.group)
  group.add(b.group)
  return {
    group,
    update: (elapsed, cameraPos) => {
      a.update(elapsed, cameraPos)
      b.update(elapsed, cameraPos)
    },
    dispose: () => {
      a.dispose()
      b.dispose()
      group.removeFromParent()
    }
  }
}
