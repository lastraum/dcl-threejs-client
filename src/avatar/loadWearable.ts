import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import type { AssetCache } from '../rendering/AssetCache'
import { resolveDclAssetUrl, wearableMappingKeyVariants } from '../rendering/DclTextureResolver'
import { repairSkinnedMesh } from '../rendering/skinnedMeshInstance'
import { disposeOwnedObject3D } from '../rendering/sharedAsset'
import { setMeshDesiredCastShadow } from '../rendering/shadowCastPolicy'

import { contentMappings, getMainFileUrl } from './peerApi'
import { prepareAvatarMaterials, tintWearableMaterials } from './materials'
import { wearableGlbCacheKey } from './wearableCache'
import { normalizeBoneName, resolveBoneName } from './emoteBoneMap'
import {
  bakeOversizedWearableGeometry,
  normalizeWearableArmatureToBody,
  normalizeWearableWorldScale,
  pruneOrphanWearableRoots,
  pruneWearableDisplayMeshes,
  scaleGeometryPositions,
  wearableHasCmScaleDisplayMesh,
  wearableNeedsArmatureNormalize,
  wearableUnitScaleFactor
} from './wearableSanitize'
import type { BodyShape, WearableCategory, WearableDefinition } from './types'

export { wearableGlbCacheKey } from './wearableCache'
export {
  bakeOversizedWearableGeometry,
  prepareCmScaleWearableForMerge,
  prepareWearableForCompose,
  pruneWearableDisplayMeshes,
  type PruneWearableMeshesOptions,
  wearableHasCmScaleDisplayMesh
} from './wearableSanitize'

export type MergeWearableOptions = {
  category?: WearableCategory
  wearableId?: string
  /** body_shape root — needed to normalize mismatched armature scales on fallback attach. */
  bodyRoot?: THREE.Object3D
}

/** userData key on parallel-skeleton wearable roots (see attachWearableFallback). */
export const PARALLEL_WEARABLE_USERDATA = 'dclParallelWearable'

type ParallelBonePair = { body: THREE.Bone; wearable: THREE.Bone }

export type ParallelWearableState = {
  pairs: ParallelBonePair[]
  skeletons: THREE.Skeleton[]
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
  // Cached roots may still carry visible=false from older prune rules — compose prep resets again.
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.visible = true
  })
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

/**
 * Base-avatar hair / facial hair GLBs weight verts onto secondary spring bones
 * (`Hair_springBone*`, etc.) that do not exist on body_shape. Map those to Head
 * so merge quality passes and the mesh skins with the head.
 */
function isSecondaryHeadBone(boneName: string): boolean {
  const n = normalizeBoneName(boneName).toLowerCase()
  if (n.includes('hair')) return true
  if (n.includes('spring')) return true
  if (n.includes('beard') || n.includes('mustache') || n.includes('facial')) return true
  return false
}

function headBoneIndex(dstIndexByName: Map<string, number>, dstBones: Set<string>): number | null {
  const resolved = resolveBoneName('Head', dstBones) ?? resolveBoneName('Avatar_Head', dstBones)
  if (!resolved) return null
  const idx = dstIndexByName.get(resolved)
  return idx !== undefined ? idx : null
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
  if (exact !== undefined) return exact

  if (isSecondaryHeadBone(boneName)) {
    const headIdx = headBoneIndex(dstIndexByName, dstBones)
    if (headIdx !== null) return headIdx
  }
  return 0
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
  const hasHead = !!(resolveBoneName('Head', dstBones) ?? resolveBoneName('Avatar_Head', dstBones))
  const bones =
    usedBoneIndices && usedBoneIndices.size > 0
      ? [...usedBoneIndices].map((i) => src.bones[i]).filter(Boolean)
      : src.bones
  if (!bones.length) return 0

  let matched = 0
  for (const bone of bones) {
    if (resolveBoneName(bone.name, dstBones)) {
      matched++
      continue
    }
    // Spring / hair secondary bones count as matched when Head exists (remapped on merge).
    if (hasHead && isSecondaryHeadBone(bone.name)) matched++
  }
  return matched / bones.length
}

const FEET_MERGE_BONE_ALIASES = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'] as const

function feetMergeUsedBones(
  src: THREE.Skeleton,
  usedBoneIndices: Set<number>
): THREE.Bone[] {
  return usedBoneIndices.size > 0
    ? [...usedBoneIndices].map((i) => src.bones[i]).filter(Boolean)
    : src.bones
}

function feetMergeHasFootBones(src: THREE.Skeleton, dst: THREE.Skeleton, usedBoneIndices: Set<number>): boolean {
  const dstBones = skeletonBoneSet(dst)
  const footTargets = new Set<string>()
  for (const alias of FEET_MERGE_BONE_ALIASES) {
    const resolved = resolveBoneName(alias, dstBones)
    if (resolved) footTargets.add(resolved)
  }
  if (!footTargets.size) return false

  for (const bone of feetMergeUsedBones(src, usedBoneIndices)) {
    const resolved = resolveBoneName(bone.name, dstBones)
    if (resolved && footTargets.has(resolved)) return true
  }
  return false
}

/** RTFKT / L2 whole-shoe rigs skin only to Hips — merge onto body Hips instead of fallback attach. */
function feetMergeUsesHipsOnly(
  src: THREE.Skeleton,
  dst: THREE.Skeleton,
  usedBoneIndices: Set<number>
): boolean {
  const dstBones = skeletonBoneSet(dst)
  const hipsResolved = resolveBoneName('Hips', dstBones)
  if (!hipsResolved) return false

  const footTargets = new Set<string>()
  for (const alias of FEET_MERGE_BONE_ALIASES) {
    const resolved = resolveBoneName(alias, dstBones)
    if (resolved) footTargets.add(resolved)
  }

  let hasHips = false
  let hasFoot = false
  for (const bone of feetMergeUsedBones(src, usedBoneIndices)) {
    const resolved = resolveBoneName(bone.name, dstBones)
    if (!resolved) continue
    if (resolved === hipsResolved) hasHips = true
    if (footTargets.has(resolved)) hasFoot = true
  }
  return hasHips && !hasFoot
}

function feetMergeEligible(
  src: THREE.Skeleton,
  dst: THREE.Skeleton,
  usedBoneIndices: Set<number>
): boolean {
  return (
    feetMergeHasFootBones(src, dst, usedBoneIndices) ||
    feetMergeUsesHipsOnly(src, dst, usedBoneIndices)
  )
}

function mergeThresholdForCategory(category?: WearableCategory, wearableId?: string): number {
  if (isL1WearableUrn(wearableId)) return 0.85
  switch (category) {
    case 'feet':
      return 0.55
    case 'hair':
    case 'facial_hair':
      // Base hairs weight onto Head + spring bones; spring bones remap to Head.
      return 0.35
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

function bindSkinnedMesh(
  mesh: THREE.SkinnedMesh,
  skeleton: THREE.Skeleton,
  bindMatrix: THREE.Matrix4
): void {
  mesh.skeleton = skeleton
  mesh.bind(skeleton, bindMatrix)
  mesh.frustumCulled = false
}

/**
 * Max bone-map quality across visible skinned meshes (0..1).
 * Used to skip prepare/merge when a wearable clearly cannot rebind to the body skeleton.
 */
export function probeWearableMergeQuality(
  wearableRoot: THREE.Object3D,
  bodySkeleton: THREE.Skeleton,
  options: MergeWearableOptions = {}
): number {
  let best = 0
  wearableRoot.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh) || !obj.skeleton || !obj.visible) return
    const usedBones = collectUsedBoneIndices(obj)
    let quality = boneMapQuality(obj.skeleton, bodySkeleton, usedBones)
    if (options.category === 'feet' && !feetMergeEligible(obj.skeleton, bodySkeleton, usedBones)) {
      quality = 0
    }
    if (quality > best) best = quality
  })
  return best
}

export function mergeThreshold(options: MergeWearableOptions = {}): number {
  return mergeThresholdForCategory(options.category, options.wearableId)
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

  // RTFKT/L1 feet: Armature×10 + cm verts must be baked into body unit space before bind.
  const unitFactor =
    options.bodyRoot != null
      ? wearableUnitScaleFactor(options.bodyRoot, wearableRoot, options.category)
      : 1

  wearableRoot.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh) || !obj.skeleton || !obj.visible) return

    const usedBones = collectUsedBoneIndices(obj)
    const quality = boneMapQuality(obj.skeleton, skeleton, usedBones)
    if (quality < threshold) return
    if (options.category === 'feet' && !feetMergeEligible(obj.skeleton, skeleton, usedBones)) {
      return
    }

    const indexMap = buildBoneIndexMap(obj.skeleton, skeleton)
    // Bad name maps dump most verts onto bone 0 (Hips) → "ball of bones" on remotes.
    if (usedBones.size > 0) {
      let toZero = 0
      for (const bi of usedBones) {
        const dst = bi < indexMap.length ? indexMap[bi] : 0
        if (dst === 0) toZero++
      }
      if (toZero / usedBones.size > 0.55 && usedBones.size >= 3) {
        return
      }
    }
    // Always clone — never mutate AssetCache-shared geometry/skin attributes.
    const geometry = obj.geometry.clone()
    // Unit bake only for clearly mismatched feet/cm exports — wrong factor on clothing = soup.
    const applyUnit =
      unitFactor !== 1 &&
      (options.category === 'feet' || unitFactor < 0.5 || unitFactor > 2)
    if (applyUnit) scaleGeometryPositions(geometry, unitFactor)
    remapSkinIndices(geometry, indexMap, skeleton.bones.length)

    const mesh = new THREE.SkinnedMesh(geometry, cloneMaterials(obj.material))
    mesh.name = obj.name
    // bindMatrix: mesh-local → bind space. Uniform vert scale f satisfies
    // f*(M*v)=M*(f*v), so keep M when baking unitFactor into positions.
    // Do NOT multiply mesh.matrix here — folding local TRS after unit bake caused
    // L1/RTFKT shoes to land huge and ~180° flipped vs body bind space.
    bindSkinnedMesh(mesh, skeleton, obj.bindMatrix.clone())
    repairSkinnedMesh(mesh)
    target.add(mesh)
    merged++
  })

  return merged > 0
}

function collectWearableSkeletons(root: THREE.Object3D): THREE.Skeleton[] {
  const seen = new Set<THREE.Skeleton>()
  const out: THREE.Skeleton[] = []
  root.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh) || !obj.skeleton || !obj.visible) return
    if (seen.has(obj.skeleton)) return
    seen.add(obj.skeleton)
    out.push(obj.skeleton)
  })
  return out
}

/**
 * Map wearable bones → body bones by name (explorer parallel-rig style).
 * Unmapped wearable bones are left at authored bind pose.
 */
function buildParallelBonePairs(
  wearableSkeleton: THREE.Skeleton,
  bodySkeleton: THREE.Skeleton
): ParallelBonePair[] {
  const bodyNames = skeletonBoneSet(bodySkeleton)
  const bodyByName = new Map<string, THREE.Bone>()
  for (const bone of bodySkeleton.bones) {
    bodyByName.set(normalizeBoneName(bone.name), bone)
  }
  const pairs: ParallelBonePair[] = []
  for (const wearBone of wearableSkeleton.bones) {
    const resolved = resolveBoneName(wearBone.name, bodyNames)
    if (!resolved) continue
    const bodyBone = bodyByName.get(resolved)
    if (!bodyBone || bodyBone === wearBone) continue
    pairs.push({ body: bodyBone, wearable: wearBone })
  }
  return pairs
}

function applyParallelBonePairs(pairs: ParallelBonePair[]): void {
  for (const { body, wearable } of pairs) {
    // Local TRS copy: standard DCL wearables share the Avatar_* hierarchy, so matching
    // bones animate with the body. Wearable bone scale is left alone (unit differences).
    wearable.position.copy(body.position)
    wearable.quaternion.copy(body.quaternion)
  }
}

/**
 * Collect parallel-skeleton wearable states once at anim bind (avoid traverse every frame).
 */
export function collectParallelWearableStates(avatarRoot: THREE.Object3D): ParallelWearableState[] {
  const out: ParallelWearableState[] = []
  avatarRoot.traverse((obj) => {
    const state = obj.userData[PARALLEL_WEARABLE_USERDATA] as ParallelWearableState | undefined
    if (state?.pairs?.length) out.push(state)
  })
  return out
}

/** Drive cached parallel wearable states after body animation has been applied. */
export function syncParallelWearableStates(states: readonly ParallelWearableState[]): void {
  for (const state of states) {
    if (!state.pairs.length) continue
    applyParallelBonePairs(state.pairs)
    for (const sk of state.skeletons) sk.update()
  }
}

/**
 * Drive parallel wearable skeletons after body animation has been applied.
 * Prefer {@link collectParallelWearableStates} + {@link syncParallelWearableStates} on hot paths.
 */
export function syncParallelWearableSkeletons(avatarRoot: THREE.Object3D): void {
  syncParallelWearableStates(collectParallelWearableStates(avatarRoot))
}

/**
 * When bone merge fails, keep the wearable on its **own skeleton** (parallel rig).
 *
 * Matches explorer degradation for broken/mismatched bone names:
 * - Parent under the avatar root (never under a body bone — that double-applies scale/pose).
 * - Each frame, copy local pose from body bones that match by name.
 * - Unmapped bones stay at the authored bind pose (hats stay on head, etc.).
 *
 * Avoids the old bone-parent + bake-to-Hips patchwork that mis-placed accessories and
 * fought armature scale (~0.01 body bones collapsing fallback meshes).
 */
export function attachWearableFallback(
  wearableRoot: THREE.Object3D,
  skeleton: THREE.Skeleton,
  target: THREE.Object3D,
  options: MergeWearableOptions = {}
): boolean {
  if (isL1WearableUrn(options.wearableId) && options.category !== 'feet') return false

  // Soft prep only — preserve authored placement. Do NOT parent under body bones and do
  // NOT run the full prepareWearableForCompose path (that is for merge unit-baking).
  wearableRoot.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.visible = true
  })
  pruneOrphanWearableRoots(wearableRoot)

  if (options.bodyRoot) {
    if (wearableNeedsArmatureNormalize(options.bodyRoot, wearableRoot)) {
      normalizeWearableArmatureToBody(wearableRoot, options.bodyRoot)
    }
    if (wearableHasCmScaleDisplayMesh(wearableRoot)) {
      bakeOversizedWearableGeometry(wearableRoot, options.category)
    }
  }
  // Shrink only when clearly oversized for the slot — never invent placement.
  normalizeWearableWorldScale(wearableRoot, options.category)

  const visibleMeshes = pruneWearableDisplayMeshes(wearableRoot, { extentCheck: true })
  if (visibleMeshes === 0) return false

  // Plain meshes with no skeleton still render at authored pose under the avatar root.
  const skeletons = collectWearableSkeletons(wearableRoot)
  const pairs: ParallelBonePair[] = []
  for (const wearSkel of skeletons) {
    pairs.push(...buildParallelBonePairs(wearSkel, skeleton))
  }

  wearableRoot.position.set(0, 0, 0)
  wearableRoot.rotation.set(0, 0, 0)
  // Keep scale from normalize passes above; identity only when never adjusted.
  target.add(wearableRoot)

  const state: ParallelWearableState = { pairs, skeletons }
  wearableRoot.userData[PARALLEL_WEARABLE_USERDATA] = state

  // Initial pose so the first rendered frame is not a pre-animation bind mismatch.
  if (pairs.length) {
    applyParallelBonePairs(pairs)
    for (const sk of skeletons) sk.update()
  }

  wearableRoot.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh) repairSkinnedMesh(obj)
    if (obj instanceof THREE.Mesh) {
      setMeshDesiredCastShadow(obj, true, 'avatar')
      obj.receiveShadow = true
    }
  })

  return true
}

export function sanitizeWearableRoot(root: THREE.Object3D): void {
  // Do not run scene/landscape sanitizer here — outdoor remap + COLOR_0 enable
  // turns DCL wearables into a black silhouette (Explorer avatars are matte).
  pruneWearableDisplayMeshes(root)
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      // Cast contact shadows onto landscape / scene floors (worlds island beach included).
      // Preferences → Avatar shadows gates cast; remotes also apply distance budget.
      setMeshDesiredCastShadow(obj, true, 'avatar')
      obj.receiveShadow = true
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

/** Locomotion mixer must target body_shape only — not parallel wearable rigs. */
export function findBodyShapeRoot(avatar: THREE.Object3D): THREE.Object3D {
  for (const child of avatar.children) {
    if (child.name === 'wearable:body_shape') return child
  }
  return avatar
}