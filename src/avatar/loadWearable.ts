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
import { normalizeBoneName, resolveBoneName } from './emoteBoneMap'
import {
  findAttachBoneForCategory,
  findSkeletonHips,
  normalizeWearableWorldScale,
  pruneWearableDisplayMeshes
} from './wearableSanitize'
import type { BodyShape, WearableCategory, WearableDefinition } from './types'

export { wearableGlbCacheKey } from './wearableCache'
export { pruneWearableDisplayMeshes } from './wearableSanitize'

export type MergeWearableOptions = {
  category?: WearableCategory
  wearableId?: string
}

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

function skeletonBoneSet(skeleton: THREE.Skeleton): Set<string> {
  const names = new Set<string>()
  for (const bone of skeleton.bones) {
    names.add(normalizeBoneName(bone.name))
  }
  return names
}

function buildDstBoneIndexMap(dst: THREE.Skeleton): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i < dst.bones.length; i++) {
    map.set(normalizeBoneName(dst.bones[i].name), i)
  }
  return map
}

function resolveDstBoneIndex(
  boneName: string,
  dstIndexByName: Map<string, number>,
  dstBones: Set<string>
): number {
  const resolved = resolveBoneName(boneName, dstBones)
  if (resolved) {
    const idx = dstIndexByName.get(resolved)
    if (idx !== undefined) return idx
  }
  const exact = dstIndexByName.get(normalizeBoneName(boneName))
  return exact !== undefined ? exact : 0
}

function buildBoneIndexMap(src: THREE.Skeleton, dst: THREE.Skeleton): number[] {
  const dstBones = skeletonBoneSet(dst)
  const dstIndexByName = buildDstBoneIndexMap(dst)
  return src.bones.map((bone) => resolveDstBoneIndex(bone.name, dstIndexByName, dstBones))
}

function collectUsedBoneIndices(mesh: THREE.SkinnedMesh): Set<number> {
  const used = new Set<number>()
  const skinIndex = mesh.geometry.attributes.skinIndex as THREE.BufferAttribute | undefined
  const skinWeight = mesh.geometry.attributes.skinWeight as THREE.BufferAttribute | undefined
  if (!skinIndex) return used

  for (let i = 0; i < skinIndex.count; i++) {
    for (let j = 0; j < 4; j++) {
      const weight = skinWeight ? skinWeight.getComponent(i, j) : 1
      if (weight <= 0) continue
      const idx = skinIndex.getComponent(i, j)
      if (idx >= 0) used.add(idx)
    }
  }
  return used
}

function boneMapQuality(
  src: THREE.Skeleton,
  dst: THREE.Skeleton,
  usedBoneIndices?: Set<number>
): number {
  const dstBones = skeletonBoneSet(dst)
  const bones =
    usedBoneIndices && usedBoneIndices.size > 0
      ? [...usedBoneIndices].map((i) => src.bones[i]).filter(Boolean)
      : src.bones
  if (!bones.length) return 0

  let matched = 0
  for (const bone of bones) {
    if (resolveBoneName(bone.name, dstBones)) matched++
  }
  return matched / bones.length
}

const FEET_MERGE_BONE_ALIASES = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'] as const

function feetMergeHasFootBones(src: THREE.Skeleton, dst: THREE.Skeleton, usedBoneIndices: Set<number>): boolean {
  const dstBones = skeletonBoneSet(dst)
  const footTargets = new Set<string>()
  for (const alias of FEET_MERGE_BONE_ALIASES) {
    const resolved = resolveBoneName(alias, dstBones)
    if (resolved) footTargets.add(resolved)
  }
  if (!footTargets.size) return false

  const bones =
    usedBoneIndices.size > 0
      ? [...usedBoneIndices].map((i) => src.bones[i]).filter(Boolean)
      : src.bones
  for (const bone of bones) {
    const resolved = resolveBoneName(bone.name, dstBones)
    if (resolved && footTargets.has(resolved)) return true
  }
  return false
}

function mergeThresholdForCategory(category?: WearableCategory, wearableId?: string): number {
  if (isL1WearableUrn(wearableId)) return 0.85
  switch (category) {
    case 'feet':
      return 0.55
    case 'earring':
    case 'eyewear':
      return 0.35
    case 'hands_wear':
      return 0.4
    default:
      return 0.55
  }
}

/** L1 profile wearables (ethereum / collections-v1) — bone merge required; never fallback-attach. */
export function isL1WearableUrn(urn?: string): boolean {
  return !!urn?.includes(':ethereum:') || !!urn?.includes(':collections-v1:')
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

/**
 * Attach wearable skinned meshes to the body skeleton (Forge pattern).
 * Remaps bone indices by name so L1 / Mixamo profile wearables work.
 * Returns false when nothing could be merged — caller should add the full GLB instead.
 */
export function mergeWearableMeshes(
  wearableRoot: THREE.Object3D,
  skeleton: THREE.Skeleton,
  target: THREE.Object3D,
  options: MergeWearableOptions = {}
): boolean {
  const threshold = mergeThresholdForCategory(options.category, options.wearableId)
  let merged = 0

  wearableRoot.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh) || !obj.skeleton) return

    const usedBones = collectUsedBoneIndices(obj)
    const quality = boneMapQuality(obj.skeleton, skeleton, usedBones)
    if (quality < threshold) return
    if (
      options.category === 'feet' &&
      !feetMergeHasFootBones(obj.skeleton, skeleton, usedBones)
    ) {
      return
    }

    const indexMap = buildBoneIndexMap(obj.skeleton, skeleton)
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
 * When bone merge fails, parent the wearable under a category-appropriate avatar bone.
 * L1 exports often keep their own armature — scale is normalized before attach.
 */
export function attachWearableFallback(
  wearableRoot: THREE.Object3D,
  skeleton: THREE.Skeleton,
  target: THREE.Object3D,
  options: MergeWearableOptions = {}
): boolean {
  if (isL1WearableUrn(options.wearableId)) return false

  const visibleMeshes = pruneWearableDisplayMeshes(wearableRoot)
  if (visibleMeshes === 0) return false

  const attachBone = findAttachBoneForCategory(skeleton, options.category) ?? findSkeletonHips(skeleton)
  wearableRoot.position.set(0, 0, 0)
  wearableRoot.rotation.set(0, 0, 0)
  normalizeWearableWorldScale(wearableRoot, options.category)
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