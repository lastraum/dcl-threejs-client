import * as THREE from 'three'
import { isGltfInvisibleColliderName } from '../collision/gltfColliderNaming'
import { isSceneNeonEmissiveMaterial } from './sceneGltfEmissives'

/** Leave headroom for fog/tone mapping; scene shadows stay off (each shadow light adds a sampler). */
const MAX_MATERIAL_TEXTURES = 8

const STRIP_MAP_KEYS = [
  'displacementMap',
  'bumpMap',
  'lightMap',
  'aoMap',
  'metalnessMap',
  'roughnessMap',
  'normalMap',
  'emissiveMap'
] as const satisfies ReadonlyArray<keyof THREE.MeshStandardMaterial>

type MapMaterial = THREE.MeshStandardMaterial

function countMaterialTextures(material: MapMaterial): number {
  let count = 0
  if (material.map) count++
  if (material.normalMap) count++
  if (material.roughnessMap) count++
  if (material.metalnessMap) count++
  if (material.aoMap) count++
  if (material.emissiveMap) count++
  if (material.bumpMap) count++
  if (material.displacementMap) count++
  if (material.alphaMap) count++
  if (material.lightMap) count++
  if (material.envMap) count++
  if (material instanceof THREE.MeshPhysicalMaterial) {
    if (material.clearcoatMap) count++
    if (material.clearcoatNormalMap) count++
    if (material.clearcoatRoughnessMap) count++
    if (material.transmissionMap) count++
    if (material.thicknessMap) count++
    if (material.specularIntensityMap) count++
    if (material.specularColorMap) count++
    if (material.sheenColorMap) count++
    if (material.sheenRoughnessMap) count++
    if (material.iridescenceMap) count++
    if (material.iridescenceThicknessMap) count++
    if (material.anisotropyMap) count++
  }
  return count
}

function resetPhysicalScalars(material: THREE.MeshPhysicalMaterial): void {
  material.clearcoat = 0
  material.transmission = 0
  material.sheen = 0
  material.iridescence = 0
  material.anisotropy = 0
  material.dispersion = 0
  material.specularColorMap = null
  material.specularIntensityMap = null
  material.clearcoatMap = null
  material.clearcoatNormalMap = null
  material.clearcoatRoughnessMap = null
  material.sheenColorMap = null
  material.sheenRoughnessMap = null
  material.iridescenceMap = null
  material.iridescenceThicknessMap = null
  material.transmissionMap = null
  material.thicknessMap = null
  material.anisotropyMap = null
}

function stripOptionalMaps(material: MapMaterial): void {
  material.envMap = null
  material.envMapIntensity = 0

  for (const key of STRIP_MAP_KEYS) {
    if (countMaterialTextures(material) <= MAX_MATERIAL_TEXTURES) return
    if (key === 'emissiveMap' && isSceneNeonEmissiveMaterial(material)) continue
    material[key] = null
  }
}

function downgradePhysicalMaterial(material: THREE.MeshPhysicalMaterial): THREE.MeshStandardMaterial {
  resetPhysicalScalars(material)

  const standard = new THREE.MeshStandardMaterial()
  standard.name = material.name
  standard.map = material.map
  standard.normalMap = material.normalMap
  standard.normalScale.copy(material.normalScale)
  standard.roughnessMap = material.roughnessMap
  standard.metalnessMap = material.metalnessMap
  standard.aoMap = material.aoMap
  standard.emissiveMap = material.emissiveMap
  standard.emissive.copy(material.emissive)
  standard.emissiveIntensity = material.emissiveIntensity
  standard.color.copy(material.color)
  standard.roughness = material.roughness
  standard.metalness = material.metalness
  standard.transparent = material.transparent
  standard.opacity = material.opacity
  standard.alphaMap = material.alphaMap
  standard.side = material.side
  standard.vertexColors = material.vertexColors
  stripOptionalMaps(standard)
  material.dispose()
  return standard
}

function simplifyMaterial(material: THREE.Material): THREE.Material {
  if (material instanceof THREE.MeshPhysicalMaterial) {
    return downgradePhysicalMaterial(material)
  }
  if (material instanceof THREE.MeshStandardMaterial) {
    stripOptionalMaps(material)
    return material
  }
  if (material instanceof THREE.MeshBasicMaterial) {
    return material
  }
  return material
}

function isAuthorTerrainMesh(mesh: THREE.Mesh): boolean {
  if (/^terrain_mesh_/i.test(mesh.name)) return true
  if (mesh.userData.dclAuthorTerrain === true) return true
  let parent: THREE.Object3D | null = mesh.parent
  while (parent) {
    if (parent.name === 'terrain_root' || parent.userData.dclAuthorTerrainRoot === true) return true
    parent = parent.parent
  }
  return false
}

function terrainVertexColorAttribute(mesh: THREE.Mesh): THREE.BufferAttribute | null {
  const attr = mesh.geometry.getAttribute('color')
  return attr instanceof THREE.BufferAttribute ? attr : null
}

function terrainSourceMap(mesh: THREE.Mesh): THREE.Texture | null {
  const mats = meshMaterials(mesh)
  for (const mat of mats) {
    if (!mat) continue
    if (mat instanceof THREE.MeshBasicMaterial && mat.map) return mat.map
    if (mat instanceof THREE.MeshStandardMaterial && mat.map) return mat.map
    if (mat instanceof THREE.MeshLambertMaterial && mat.map) return mat.map
  }
  return null
}

/**
 * Editor terrain.glb — per-instance unlit material.
 * Prefer baked albedo map (reliable in ECS); fall back to COLOR_0 for Creator Hub parity.
 */
export function tuneAuthorTerrainMeshMaterial(mesh: THREE.Mesh): void {
  if (!isAuthorTerrainMesh(mesh)) return
  const colors = terrainVertexColorAttribute(mesh)
  const map = terrainSourceMap(mesh)
  if (!colors && !map) return

  if (colors) colors.needsUpdate = true
  if (map) {
    map.colorSpace = THREE.SRGBColorSpace
    map.needsUpdate = true
  }

  mesh.material = new THREE.MeshBasicMaterial({
    name: 'dcl-author-terrain',
    color: 0xffffff,
    map,
    vertexColors: !map && !!colors,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
    transparent: false,
    opacity: 1,
    depthWrite: true
  })
}

function meshMaterials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

/** GLTFLoader often omits vertexColors on PBR materials — editor terrain.glb only. */
export function enableMeshVertexColors(mesh: THREE.Mesh): void {
  if (!isAuthorTerrainMesh(mesh)) return
  if (!mesh.geometry.getAttribute('color')) return
  for (const material of meshMaterials(mesh)) {
    if (!material) continue
    if (
      material instanceof THREE.MeshStandardMaterial ||
      material instanceof THREE.MeshPhysicalMaterial ||
      material instanceof THREE.MeshLambertMaterial ||
      material instanceof THREE.MeshBasicMaterial
    ) {
      material.vertexColors = true
      material.color.setRGB(1, 1, 1)
      material.needsUpdate = true
    }
  }
}

/** Re-apply author-terrain materials on scene GLTF instance attach (hydration replays). */
export function enableSceneGltfVertexColors(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (!isAuthorTerrainMesh(node)) return
    enableMeshVertexColors(node)
    tuneAuthorTerrainMeshMaterial(node)
  })
}

/** Keep glTF materials under WebGL fragment texture unit limits (16 on many GPUs). */
export function sanitizeSceneGltfMaterials(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (isGltfInvisibleColliderName(node.name)) {
      node.visible = false
      return
    }
    if (Array.isArray(node.material)) {
      node.material = node.material.map((material) => simplifyMaterial(material))
    } else {
      node.material = simplifyMaterial(node.material)
    }
    if (isAuthorTerrainMesh(node)) {
      enableMeshVertexColors(node)
      tuneAuthorTerrainMeshMaterial(node)
    }
  })
}

/** Landscape tree cards only — alpha cutout + double-sided (see sanitizeLandscapeGltf). */
function tuneFoliageMaterial(material: THREE.Material, meshName = ''): void {
  if (!(material instanceof THREE.MeshStandardMaterial)) return

  const foliageMesh = /leaf|foliage|petal|flower|tree|plant|grass|bush|fern|vine|canopy|branch/i.test(meshName)
  if (!foliageMesh) return

  material.side = THREE.DoubleSide
  material.transparent = false
  material.alphaTest = material.alphaMap ? 0.5 : 0.35
  material.depthWrite = true
}

/** Hide DCL `_collider` meshes on scene GLBs (do not use landscape shadow tuning). */
export function sanitizeSceneGltfColliders(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (isGltfInvisibleColliderName(obj.name)) obj.visible = false
  })
}

/** DCL empty-land glTFs ship invisible physics meshes alongside the visual LOD. */
export function sanitizeLandscapeGltf(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (isGltfInvisibleColliderName(obj.name)) {
      obj.visible = false
      return
    }

    if (!(obj instanceof THREE.Mesh)) return

    obj.castShadow = false
    obj.receiveShadow = false

    if (Array.isArray(obj.material)) {
      obj.material.forEach((m) => tuneFoliageMaterial(m, obj.name))
    } else {
      tuneFoliageMaterial(obj.material, obj.name)
    }
  })
}
