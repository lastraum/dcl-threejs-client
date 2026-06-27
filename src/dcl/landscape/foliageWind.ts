import * as THREE from 'three'
import { tuneLandscapeFoliageMaterial } from '../../rendering/LandscapeAssetSanitizer'

export type LandscapeMeshPart = 'foliage' | 'bark' | 'collider' | 'other'

export function isFoliageMaterial(material: THREE.Material | undefined): boolean {
  if (!material) return false
  const name = material.name ?? ''
  return /^Leaf\d+_Mat$/i.test(name) || /leaf|foliage|canopy|petal|flower/i.test(name)
}

/** DCL empty-land trees: `Leaf*_Mat` canopy + shared `Trunk_Mat` bark. */
export function classifyLandscapeMesh(mesh: THREE.Mesh): LandscapeMeshPart {
  if (/collider/i.test(mesh.name)) return 'collider'

  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  if (isFoliageMaterial(mat)) return 'foliage'

  const matName = mat?.name ?? ''
  if (/trunk|bark/i.test(matName)) return 'bark'

  if (/^LOD[\d.]+_1$/i.test(mesh.name)) return 'bark'
  if (/^LOD[\d.]+$/i.test(mesh.name)) return 'foliage'

  return 'other'
}

const FOLIAGE_WIND = {
  /** Tree GLBs use ~0.01 node scale; `transformed.y * 0.01` ≈ metres in the canopy. */
  strength: new THREE.Vector3(0.07, 0, 0.07),
  frequency: 0.45,
  scale: 260
} as const

type WindMaterial = THREE.MeshStandardMaterial | THREE.MeshPhongMaterial

const windMaterials = new Set<WindMaterial>()
const windMaterialBySource = new Map<string, WindMaterial>()
let windElapsed = 0

function windMaterialCacheKey(source: THREE.Material, instanced: boolean): string {
  const name = source.name || source.uuid
  return `${name}:${instanced ? 'inst' : 'solo'}`
}

function isWindMaterial(material: THREE.Material): material is WindMaterial {
  return material.userData.foliageWindPatched === true
}

export function resetFoliageWindRegistry(): void {
  windMaterials.clear()
  windMaterialBySource.clear()
  windElapsed = 0
}

export function updateFoliageWind(elapsed: number): void {
  windElapsed = elapsed
  for (const material of windMaterials) {
    const uniform = material.userData.foliageWindTime as { value: number } | undefined
    if (uniform) uniform.value = elapsed
    const shader = material.userData.shader as
      | { uniforms: { uTime?: { value: number } } }
      | undefined
    if (shader?.uniforms?.uTime) shader.uniforms.uTime.value = elapsed
  }
}

function cloneForWind(source: THREE.Material): WindMaterial | null {
  if (source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshPhongMaterial) {
    const clone = source.clone()
    clone.name = source.name
    return clone
  }
  return null
}

/** MeshStandard/Phong + `project_vertex` replace — same technique as ez-tree grass. */
function appendFoliageWindShader(material: WindMaterial, instanced: boolean): void {
  const uTime = { value: windElapsed }
  material.userData.foliageWindTime = uTime
  material.userData.foliageWindPatched = true
  material.userData.foliageWindInstanced = instanced
  material.customProgramCacheKey = () =>
    `foliage-wind:${material.name}:${instanced ? 'i' : 's'}:${material.uuid}`

  material.onBeforeRender = () => {
    uTime.value = windElapsed
  }

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime
    shader.uniforms.uWindStrength = { value: FOLIAGE_WIND.strength }
    shader.uniforms.uWindFrequency = { value: FOLIAGE_WIND.frequency }
    shader.uniforms.uWindScale = { value: FOLIAGE_WIND.scale }

    shader.vertexShader =
      `
      uniform float uTime;
      uniform vec3 uWindStrength;
      uniform float uWindFrequency;
      uniform float uWindScale;
      ` + shader.vertexShader

    if (!shader.vertexShader.includes('float simplex2d(vec2 v)')) {
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
    }

    const projectVertex = instanced
      ? `
        vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0);
        float windOffset = 6.28318 * simplex2d((modelMatrix * mvPosition).xz / uWindScale);
        float heightM = abs(transformed.y) * 0.01;
        float swayMask = smoothstep(0.35, 2.0, heightM);
        vec3 windSway = swayMask * heightM * uWindStrength *
          sin(uTime * uWindFrequency + windOffset) *
          cos(uTime * 1.3 * uWindFrequency + windOffset);
        mvPosition.xyz += windSway;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
      `
      : `
        vec4 mvPosition = vec4(transformed, 1.0);
        float windOffset = 6.28318 * simplex2d((modelMatrix * mvPosition).xz / uWindScale);
        float heightM = abs(transformed.y) * 0.01;
        float swayMask = smoothstep(0.35, 2.0, heightM);
        vec3 windSway = swayMask * heightM * uWindStrength *
          sin(uTime * uWindFrequency + windOffset) *
          cos(uTime * 1.3 * uWindFrequency + windOffset);
        mvPosition.xyz += windSway;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
      `

    if (!shader.vertexShader.includes('#include <project_vertex>')) {
      console.warn('[foliageWind] project_vertex include missing for', material.name)
      return
    }

    shader.vertexShader = shader.vertexShader.replace(/#include <project_vertex>/, projectVertex)
    material.userData.shader = shader
  }

  material.needsUpdate = true
}

export function prepareFoliageWindMaterial(
  material: THREE.Material | THREE.Material[],
  instanced: boolean
): THREE.Material | THREE.Material[] {
  if (Array.isArray(material)) {
    return material.map((m) => prepareFoliageWindMaterial(m, instanced) as THREE.Material)
  }

  const cacheKey = windMaterialCacheKey(material, instanced)
  const cached = windMaterialBySource.get(cacheKey)
  if (cached) return cached

  if (isWindMaterial(material)) {
    if (material.userData.foliageWindInstanced === instanced) return material
    console.warn('[foliageWind] missing cached variant for', material.name, instanced ? 'inst' : 'solo')
    return material
  }

  const windMat = cloneForWind(material)
  if (!windMat) return material

  tuneLandscapeFoliageMaterial(windMat, material.name)
  appendFoliageWindShader(windMat, instanced)
  windMaterialBySource.set(cacheKey, windMat)
  windMaterials.add(windMat)
  return windMat
}

function patchMeshFoliageMaterial(mesh: THREE.Mesh, instanced: boolean): boolean {
  if (Array.isArray(mesh.material)) {
    let changed = false
    const next = mesh.material.map((m) => {
      if (!isFoliageMaterial(m)) return m
      changed = true
      return prepareFoliageWindMaterial(m, instanced) as THREE.Material
    })
    if (changed) mesh.material = next
    return changed
  }

  if (!isFoliageMaterial(mesh.material)) return false

  mesh.material = prepareFoliageWindMaterial(mesh.material, instanced)
  return true
}

/** Safety pass — patch every canopy draw call on the landscape root. */
export function finalizeFoliageWindLandscape(root: THREE.Object3D): void {
  let patched = 0
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    const instanced = node instanceof THREE.InstancedMesh
    if (patchMeshFoliageMaterial(node, instanced)) patched++
  })
  if (patched > 0) {
    console.info(`[foliageWind] ${patched} canopy draw(s), ${windMaterials.size} wind material(s)`)
  }
}

export function applyFoliageWindToObject(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (!isFoliageMaterial(Array.isArray(node.material) ? node.material[0] : node.material)) {
      if (classifyLandscapeMesh(node) !== 'foliage') return
    }
    patchMeshFoliageMaterial(node, false)
  })
}