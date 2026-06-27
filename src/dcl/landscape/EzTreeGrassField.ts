import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { parseParcelKey } from '../content/parseParcel'
import { PARCEL_SIZE } from '../content/types'
import { dclToThreePos } from '../../bridge/dclTransform'
import { EZ_TREE_GRASS, EZ_TREE_GRASS_TINT_RGB } from './landscapeAssets'
import { grassInstanceColor } from './groundGlbTint'
import { distributedParcelPositions } from './parcelDistribution'
import { OUTER_SCATTER_RADIUS_PARCELS, outerDistanceFalloff, parcelDistFromScene } from './scatterFalloff'
import { simplex2d } from './simplex2d'
import type { OuterScatterContext } from './Systems/InfiniteGround'
import { hashParcelCoords, mulberry32, pickInt } from './Utils/SeededRandom'
import { dclSceneToLandscapeThree, EMPTY_LAND_GROUND_OFFSET, parcelKeyFromDclScene } from './Utils/SceneSpace'
import { sceneParcelBounds } from './Utils/ParcelGrid'

/**
 * Mirrors ez-tree `GrassOptions` defaults.
 * @see https://github.com/dgreenheck/ez-tree/blob/main/src/app/grass.js
 */
/** Blade count vs original ez-tree field scatter. */
const GRASS_DENSITY_MULTIPLIER = 5

const GRASS_OPTIONS = {
  maxInstanceCount: 14000 * GRASS_DENSITY_MULTIPLIER,
  /** Simplex patch size (metres) — same as ez-tree `scale`. */
  patchScale: 100,
  patchiness: 0.7,
  size: { x: 5, y: 4, z: 5 },
  sizeVariation: { x: 1, y: 2, z: 1 },
  windStrength: { x: 0.3, y: 0, z: 0.3 },
  windFrequency: 1.0,
  windScale: 400.0,
  /**
   * ez-tree renders in a ~500 m open field at size 5–6; DCL parcels are 16 m.
   * Keeps blade height ~0.8–1.2 m while preserving relative size variation.
   */
  worldSizeMultiplier: 0.12
} as const

const GRASS_BLADE_TINT = new THREE.Color(
  EZ_TREE_GRASS_TINT_RGB.r / 255,
  EZ_TREE_GRASS_TINT_RGB.g / 255,
  EZ_TREE_GRASS_TINT_RGB.b / 255
)

const LOD_NEAR_M = 80
const LOD_FAR_M = 420
const LOD_MIN_FRACTION = 0.18

type GrassInstance = {
  x: number
  y: number
  z: number
  rotY: number
  scaleX: number
  scaleY: number
  scaleZ: number
  color: THREE.Color
}

export type EzTreeGrassFieldHandle = {
  group: THREE.Group
  update: (elapsed: number, cameraPos: THREE.Vector3) => void
  dispose: () => void
}

let grassMeshTemplate: THREE.Mesh | null = null
let grassLoadPromise: Promise<THREE.Mesh> | null = null

function extractMaterialMap(material: THREE.Material | THREE.Material[]): THREE.Texture | null {
  const mat = Array.isArray(material) ? material[0] : material
  if (!mat) return null
  if ('map' in mat && mat.map instanceof THREE.Texture) return mat.map
  return null
}

/** ez-tree `fetchAssets` — first child of grass.glb scene. */
async function fetchGrassMesh(): Promise<THREE.Mesh> {
  if (grassMeshTemplate) return grassMeshTemplate
  if (grassLoadPromise) return grassLoadPromise

  grassLoadPromise = (async () => {
    const loader = new GLTFLoader()
    const gltf = await loader.loadAsync(EZ_TREE_GRASS.glb)
    const mesh = gltf.scene.children[0]
    if (!(mesh instanceof THREE.Mesh) || !mesh.geometry) {
      throw new Error('ez-tree grass.glb: expected Mesh as scene.children[0]')
    }
    const map = extractMaterialMap(mesh.material)
    if (!map) throw new Error('ez-tree grass.glb: material.map missing')
    map.colorSpace = THREE.SRGBColorSpace
    grassMeshTemplate = mesh
    return mesh
  })()

  return grassLoadPromise
}

/** ez-tree `generateGrass` material — tinted to match parcel ground GLB. */
function createGrassMaterial(map: THREE.Texture, groundTint: THREE.Color): THREE.MeshPhongMaterial {
  const emissive = groundTint.clone().multiplyScalar(0.42)
  const material = new THREE.MeshPhongMaterial({
    map,
    emissive,
    emissiveIntensity: 0.06,
    transparent: false,
    alphaTest: 0.5,
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide
  })
  material.color.copy(groundTint).multiplyScalar(0.72)
  appendWindShader(material, true)
  return material
}

/** ez-tree `appendWindShader` — instanced grass path. */
function appendWindShader(material: THREE.MeshPhongMaterial, instanced: boolean): void {
  material.customProgramCacheKey = () => `ez-tree-grass-wind:${instanced ? 'i' : 's'}`
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 }
    shader.uniforms.uWindStrength = { value: GRASS_OPTIONS.windStrength }
    shader.uniforms.uWindFrequency = { value: GRASS_OPTIONS.windFrequency }
    shader.uniforms.uWindScale = { value: GRASS_OPTIONS.windScale }

    shader.vertexShader =
      `
      uniform float uTime;
      uniform vec3 uWindStrength;
      uniform float uWindFrequency;
      uniform float uWindScale;
      ` + shader.vertexShader

    shader.vertexShader = shader.vertexShader.replace(
      `void main() {`,
      `
        vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
        float simplex2d(vec2 v) {
          const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
          vec2 i = floor(v + dot(v, C.yy));
          vec2 x0 = v - i + dot(i, C.xx);
          vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
          vec4 x12 = x0.xyxy + C.xxzz;
          x12.xy -= i1;
          i = mod289(i);
          vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
          vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
          m = m * m; m = m * m;
          vec3 x = 2.0 * fract(p * C.www) - 1.0;
          vec3 h = abs(x) - 0.5;
          vec3 ox = floor(x + 0.5);
          vec3 a0 = x - ox;
          m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
          vec3 g;
          g.x = a0.x * x0.x + h.x * x0.y;
          g.yz = a0.yz * x12.xz + h.yz * x12.yw;
          return 130.0 * dot(m, g);
        }
        void main() {`
    )

    const vertexShader = instanced
      ? `
        vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0);
        float windOffset = 2.0 * 3.14 * simplex2d((modelMatrix * mvPosition).xz / uWindScale);
        vec3 windSway = position.y * uWindStrength *
          sin(uTime * uWindFrequency + windOffset) *
          cos(uTime * 1.4 * uWindFrequency + windOffset);
        mvPosition.xyz += windSway;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
      `
      : `
        vec4 mvPosition = vec4(transformed, 1.0);
        float windOffset = 2.0 * 3.14 * simplex2d((modelMatrix * mvPosition).xz / uWindScale);
        vec3 windSway = 0.2 * position.y * uWindStrength *
          sin(uTime * uWindFrequency + windOffset) *
          cos(uTime * 1.4 * uWindFrequency + windOffset);
        mvPosition.xyz += windSway;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
      `

    shader.vertexShader = shader.vertexShader.replace(`#include <project_vertex>`, vertexShader)
    material.userData.shader = shader
  }
}

/** ez-tree patchiness gate: `simplex2d` + `patchiness` threshold. */
function grassPassesPatchiness(dclX: number, dclZ: number, rng: () => number): boolean {
  const n = 0.5 + 0.5 * simplex2d(dclX / GRASS_OPTIONS.patchScale, dclZ / GRASS_OPTIONS.patchScale)
  if (n > GRASS_OPTIONS.patchiness && rng() + 0.6 > GRASS_OPTIONS.patchiness) return false
  return true
}

function grassInstanceScale(rng: () => number): { x: number; y: number; z: number } {
  const m = GRASS_OPTIONS.worldSizeMultiplier
  const { size, sizeVariation } = GRASS_OPTIONS
  return {
    x: (sizeVariation.x * rng() + size.x) * m,
    y: (sizeVariation.y * rng() + size.y) * m,
    z: (sizeVariation.z * rng() + size.z) * m
  }
}

function collectGrassInstances(
  ctx: OuterScatterContext,
  sceneParcels: string[],
  sceneSeed: number,
  borderPadding: number,
  groundTint: THREE.Color
): GrassInstance[] {
  const instances: GrassInstance[] = []
  const sceneParcelSet = new Set(sceneParcels)
  const sceneBounds = sceneParcelBounds(sceneParcels)
  const base = ctx.base

  let minPx = Infinity
  let maxPx = -Infinity
  let minPy = Infinity
  let maxPy = -Infinity
  for (const key of sceneParcels) {
    const p = parseParcelKey(key)
    minPx = Math.min(minPx, p.x)
    maxPx = Math.max(maxPx, p.x)
    minPy = Math.min(minPy, p.y)
    maxPy = Math.max(maxPy, p.y)
  }
  if (!Number.isFinite(minPx)) minPx = maxPx = minPy = maxPy = 0
  const cx = Math.floor((minPx + maxPx) * 0.5)
  const cy = Math.floor((minPy + maxPy) * 0.5)

  for (let py = cy - OUTER_SCATTER_RADIUS_PARCELS; py <= cy + OUTER_SCATTER_RADIUS_PARCELS; py++) {
    for (let px = cx - OUTER_SCATTER_RADIUS_PARCELS; px <= cx + OUTER_SCATTER_RADIUS_PARCELS; px++) {
      const key = `${px},${py}`
      if (sceneParcelSet.has(key)) continue

      const dist = parcelDistFromScene(px, py, sceneBounds)
      const falloff = outerDistanceFalloff(dist, borderPadding)
      if (falloff < 0.05) continue

      const rng = mulberry32(hashParcelCoords(px, py, sceneSeed + 31))
      const origin = { x: (px - base.x) * PARCEL_SIZE, z: (py - base.y) * PARCEL_SIZE }

      const patch = simplex2d(px * 0.19, py * 0.19)
      const density = falloff * (0.5 + (patch * 0.5 + 0.5) * 0.5)
      if (density < 0.1) continue

      const grassMax = Math.max(1, Math.round(14 * GRASS_DENSITY_MULTIPLIER * density))
      const grassCount = pickInt(rng, 0, grassMax)
      const positions = distributedParcelPositions(rng, grassCount, {
        inset: 0.35,
        minSeparation: 1.1 / Math.sqrt(GRASS_DENSITY_MULTIPLIER)
      })

      for (const pos of positions) {
        const dclX = origin.x + pos.x
        const dclZ = origin.z + pos.z
        const cellKey = parcelKeyFromDclScene(dclX, dclZ, base)
        if (sceneParcelSet.has(cellKey)) continue

        const grassRng = mulberry32(hashParcelCoords(Math.floor(dclX), Math.floor(dclZ), sceneSeed + 5))
        if (!grassPassesPatchiness(dclX, dclZ, grassRng)) continue

        const three = dclSceneToLandscapeThree(dclX, dclZ, base)
        const scale = grassInstanceScale(grassRng)
        const color = grassInstanceColor(grassRng, groundTint)

        instances.push({
          x: three.x,
          y: EMPTY_LAND_GROUND_OFFSET.y,
          z: three.z,
          rotY: grassRng() * Math.PI * 2,
          scaleX: scale.x,
          scaleY: scale.y,
          scaleZ: scale.z,
          color
        })

        if (instances.length >= GRASS_OPTIONS.maxInstanceCount) return instances
      }
    }
  }

  return instances
}

/**
 * ez-tree grass on empty DCL parcels — material, wind, and patchiness from grass.js.
 * @see https://github.com/dgreenheck/ez-tree/blob/main/src/app/grass.js
 */
export async function buildEzTreeGrassField(
  ctx: OuterScatterContext,
  sceneParcels: string[],
  sceneSeed: number,
  borderPadding: number,
  onProgress?: (msg: string) => void
): Promise<EzTreeGrassFieldHandle | null> {
  const instances = collectGrassInstances(ctx, sceneParcels, sceneSeed, borderPadding, GRASS_BLADE_TINT)
  if (!instances.length) return null

  onProgress?.(`ez-tree grass: ${instances.length} instances`)

  const sourceMesh = await fetchGrassMesh()
  const map = extractMaterialMap(sourceMesh.material)
  if (!map) throw new Error('ez-tree grass: texture unavailable after load')

  const grassMaterial = createGrassMaterial(map, GRASS_BLADE_TINT)
  const grassMesh = new THREE.InstancedMesh(sourceMesh.geometry, grassMaterial, instances.length)
  grassMesh.name = 'landscape:ez-tree-grass'
  grassMesh.receiveShadow = true
  grassMesh.castShadow = true
  grassMesh.count = instances.length

  const dummy = new THREE.Object3D()
  const sortedByDist = instances.map((inst) => ({ inst, distSq: 0 }))

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i]!
    dummy.position.set(inst.x, inst.y, inst.z)
    dummy.rotation.set(0, inst.rotY, 0)
    dummy.scale.set(inst.scaleX, inst.scaleY, inst.scaleZ)
    dummy.updateMatrix()
    grassMesh.setMatrixAt(i, dummy.matrix)
    grassMesh.setColorAt(i, inst.color)
  }
  grassMesh.instanceMatrix.needsUpdate = true
  if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true

  const group = new THREE.Group()
  group.name = 'landscape:ez-tree-grass-field'
  group.add(grassMesh)

  let lastLodUpdate = 0
  const centerThree = new THREE.Vector3()
  const base = ctx.base
  const bounds = sceneParcelBounds(sceneParcels)
  const centerPx = (bounds.minX + bounds.maxX + 1) * 0.5
  const centerPy = (bounds.minY + bounds.maxY + 1) * 0.5
  dclToThreePos((centerPx - base.x) * PARCEL_SIZE, 0, (centerPy - base.y) * PARCEL_SIZE, centerThree)

  const update = (elapsed: number, cameraPos: THREE.Vector3): void => {
    const shader = grassMaterial.userData.shader as { uniforms: { uTime: { value: number } } } | undefined
    if (shader) shader.uniforms.uTime.value = elapsed

    const now = performance.now()
    if (now - lastLodUpdate < 120) return
    lastLodUpdate = now

    const camDist = cameraPos.distanceTo(centerThree)
    const lodT = THREE.MathUtils.clamp((camDist - LOD_NEAR_M) / (LOD_FAR_M - LOD_NEAR_M), 0, 1)
    const lodFraction = THREE.MathUtils.lerp(1, LOD_MIN_FRACTION, lodT * lodT)
    const targetCount = Math.max(1, Math.floor(instances.length * lodFraction))

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
  }

  group.userData.grassInstanceCount = instances.length
  return { group, update, dispose }
}