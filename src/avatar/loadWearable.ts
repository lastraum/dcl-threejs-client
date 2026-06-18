import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import type { AssetCache } from '../rendering/AssetCache'
import { resolveDclAssetUrl, wearableMappingKeyVariants } from '../rendering/DclTextureResolver'
import { repairSkinnedMesh } from '../rendering/skinnedMeshInstance'
import { disposeOwnedObject3D } from '../rendering/sharedAsset'
import { sanitizeSceneGltfMaterials } from '../rendering/LandscapeAssetSanitizer'
import { contentMappings, getMainFileUrl } from './peerApi'
import { prepareAvatarMaterials, tintWearableMaterials } from './materials'
import { wearableGlbCacheKey } from './wearableCache'
import { findSkeletonHips, pruneWearableDisplayMeshes } from './wearableSanitize'
import type { BodyShape, WearableDefinition } from './types'

export { wearableGlbCacheKey } from './wearableCache'
export { pruneWearableDisplayMeshes } from './wearableSanitize'

export function createGltfLoader(mappings: Record<string, string>): GLTFLoader {
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    for (const variant of wearableMappingKeyVariants(url)) {
      const hit = mappings[variant]
      if (hit) return hit
    }
    const leaf = url.split('/').pop()?.split('?')[0] ?? url
    for (const variant of wearableMappingKeyVariants(leaf)) {
      const hit = mappings[variant]
      if (hit) return hit
    }
    return resolveDclAssetUrl(url)
  })
  const draco = new DRACOLoader()
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
  const loader = new GLTFLoader(manager)
  loader.setDRACOLoader(draco)
  return loader
}

export function buildMappingsForWearables(
  wearables: WearableDefinition[],
  bodyShape: BodyShape
): Record<string, string> {
  const mappings: Record<string, string> = {}
  for (const wearable of wearables) {
    try {
      Object.assign(mappings, contentMappings(wearable, bodyShape))
    } catch {
      // skip wearables without a representation for this body shape
    }
  }
  return mappings
}

/** Load via session AssetCache — dedupes GLB parse/GPU upload across avatars. */
export async function loadWearableSceneCached(
  cache: AssetCache,
  wearable: WearableDefinition,
  bodyShape: BodyShape,
  skin?: string,
  hair?: string,
  useGlobalMappings = false
): Promise<THREE.Group> {
  const url = getMainFileUrl(wearable, bodyShape)
  const mappings = useGlobalMappings ? {} : contentMappings(wearable, bodyShape)
  const hash = wearableGlbCacheKey(url)
  const root = await cache.loadWearableClone(url, mappings, hash)
  root.name = `wearable:${wearable.data.category}`
  tintWearableMaterials(root, skin, hair)
  prepareAvatarMaterials(root)
  return root
}

export async function loadWearableScene(
  wearable: WearableDefinition,
  bodyShape: BodyShape,
  loader: GLTFLoader,
  skin?: string,
  hair?: string
): Promise<THREE.Group> {
  const url = getMainFileUrl(wearable, bodyShape)
  const gltf = await loader.loadAsync(url)
  const root = gltf.scene
  root.name = `wearable:${wearable.data.category}`

  tintWearableMaterials(root, skin, hair)
  prepareAvatarMaterials(root)
  sanitizeWearableRoot(root)
  return root
}

function cloneMaterials(material: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
  if (Array.isArray(material)) return material.map((m) => m.clone())
  return material.clone()
}

function buildBoneIndexMap(src: THREE.Skeleton, dst: THREE.Skeleton): number[] {
  return src.bones.map((bone) => {
    const idx = dst.bones.findIndex((b) => b.name === bone.name)
    return idx >= 0 ? idx : 0
  })
}

function remapSkinIndices(geometry: THREE.BufferGeometry, indexMap: number[], boneCount: number): void {
  const attr = geometry.attributes.skinIndex as THREE.BufferAttribute | undefined
  if (!attr || boneCount <= 0) return
  for (let i = 0; i < attr.count; i++) {
    for (let j = 0; j < 4; j++) {
      const src = attr.getComponent(i, j)
      let dst = src < indexMap.length ? indexMap[src] : 0
      if (dst === undefined || dst < 0 || dst >= boneCount) dst = 0
      attr.setComponent(i, j, dst)
    }
  }
  attr.needsUpdate = true
}

function bindSkinnedMesh(mesh: THREE.SkinnedMesh, skeleton: THREE.Skeleton): void {
  mesh.skeleton = skeleton
  mesh.bind(skeleton, mesh.bindMatrix)
  mesh.frustumCulled = false
}

function boneMapQuality(src: THREE.Skeleton, dst: THREE.Skeleton): number {
  if (!src.bones.length) return 0
  let matched = 0
  for (const bone of src.bones) {
    if (dst.bones.some((b) => b.name === bone.name)) matched++
  }
  return matched / src.bones.length
}

/**
 * Attach wearable skinned meshes to the body skeleton (Forge pattern).
 * Remaps bone indices by name so custom profile wearables work.
 * Returns false when nothing could be merged — caller should add the full GLB instead.
 */
export function mergeWearableMeshes(
  wearableRoot: THREE.Object3D,
  skeleton: THREE.Skeleton,
  target: THREE.Object3D
): boolean {
  let merged = 0

  wearableRoot.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh) || !obj.skeleton) return

    const indexMap = buildBoneIndexMap(obj.skeleton, skeleton)
    if (boneMapQuality(obj.skeleton, skeleton) < 0.6) return

    const geometry = obj.geometry.clone()
    remapSkinIndices(geometry, indexMap, skeleton.bones.length)

    const mesh = new THREE.SkinnedMesh(geometry, cloneMaterials(obj.material))
    mesh.name = obj.name
    bindSkinnedMesh(mesh, skeleton)
    repairSkinnedMesh(mesh)
    target.add(mesh)
    merged++
  })

  return merged > 0
}

/**
 * When bone merge fails, parent the wearable under the avatar hips instead of dumping the raw GLB
 * at the avatar root (common source of huge white helper meshes).
 */
export function attachWearableFallback(
  wearableRoot: THREE.Object3D,
  skeleton: THREE.Skeleton,
  target: THREE.Object3D
): boolean {
  const visibleMeshes = pruneWearableDisplayMeshes(wearableRoot)
  if (visibleMeshes === 0) return false

  const attachBone = findSkeletonHips(skeleton)
  wearableRoot.position.set(0, 0, 0)
  wearableRoot.rotation.set(0, 0, 0)
  wearableRoot.scale.set(1, 1, 1)
  if (attachBone) {
    attachBone.add(wearableRoot)
  } else {
    target.add(wearableRoot)
  }
  return true
}

export function sanitizeWearableRoot(root: THREE.Object3D): void {
  sanitizeSceneGltfMaterials(root)
  pruneWearableDisplayMeshes(root)
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = false
      obj.receiveShadow = false
    }
    if (obj instanceof THREE.SkinnedMesh) {
      repairSkinnedMesh(obj)
    }
  })
}

export function disposeWearableInstance(root: THREE.Object3D): void {
  disposeOwnedObject3D(root)
}

export function findSkeleton(root: THREE.Object3D): THREE.Skeleton | null {
  let skeleton: THREE.Skeleton | null = null
  root.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh && obj.skeleton && !skeleton) {
      skeleton = obj.skeleton
    }
  })
  return skeleton
}
