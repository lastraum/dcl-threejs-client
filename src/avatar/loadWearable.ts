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
import { isAvatarVerbose } from '../client/debug/ClientDebugLog'
import {
  alignFallbackWearableToSlot,
  findSkeletonHips,
  fitWearableWorldExtent,
  pruneWearableDisplayMeshes,
  scaleGeometryPositions,
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
  /** Wearable's hides list — fallback attach anchors against every body region it covers. */
  hides?: string[]
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
  const verbose = isAvatarVerbose()
  const vlog = (msg: string) => {
    if (verbose) console.info(`[avatar] merge ${options.category ?? '?'} ${options.wearableId ?? ''} — ${msg}`)
  }

  // RTFKT/L1 feet: Armature×10 + cm verts must be baked into body unit space before bind.
  const unitFactor =
    options.bodyRoot != null
      ? wearableUnitScaleFactor(options.bodyRoot, wearableRoot, options.category)
      : 1
  vlog(`unitFactor=${unitFactor.toFixed(5)} threshold=${threshold}`)

  wearableRoot.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh) || !obj.skeleton) return
    if (!obj.visible) {
      vlog(`mesh "${obj.name}" skipped: pruned (visible=false)`)
      return
    }

    const usedBones = collectUsedBoneIndices(obj)
    const quality = boneMapQuality(obj.skeleton, skeleton, usedBones)
    if (quality < threshold) {
      vlog(`mesh "${obj.name}" skipped: bone quality ${quality.toFixed(2)} < ${threshold}`)
      return
    }
    if (options.category === 'feet' && !feetMergeEligible(obj.skeleton, skeleton, usedBones)) {
      vlog(`mesh "${obj.name}" skipped: feet merge not eligible`)
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
        vlog(
          `mesh "${obj.name}" skipped: ${toZero}/${usedBones.size} used bones map to bone 0 (bad name map)`
        )
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

    const mesh = new THREE.SkinnedMesh(geometry, cloneMaterials(obj.material))
    mesh.name = obj.name
    // bindMatrix: mesh-local → bind space. Uniform vert scale f satisfies
    // f*(M*v)=M*(f*v), so keep M when baking unitFactor into positions.
    // Do NOT multiply mesh.matrix here — folding local TRS after unit bake caused
    // L1/RTFKT shoes to land huge and ~180° flipped vs body bind space.
    // Bind to the body skeleton with body boneInverses — verts render at their authored
    // ABSOLUTE bind positions. NOTE (tried twice, July 19+20): pairing the wearable's own
    // boneInverses with mapped body bones breaks the spring-bone→Head remap (base hair
    // collapses to a flat cap) and did not fix authored-offset accessories (AFK sign);
    // do not retry that variant.
    remapSkinIndices(geometry, indexMap, skeleton.bones.length)
    bindSkinnedMesh(mesh, skeleton, obj.bindMatrix.clone())
    repairSkinnedMesh(mesh)
    target.add(mesh)
    merged++
    if (verbose) {
      geometry.computeBoundingBox()
      const size = geometry.boundingBox?.getSize(new THREE.Vector3())
      vlog(
        `mesh "${obj.name}" MERGED — quality=${quality.toFixed(2)} applyUnit=${applyUnit} ` +
          `geomExtent=${size ? size.length().toFixed(3) : '?'} bindScale=${obj.bindMatrix
            .getMaxScaleOnAxis()
            .toFixed(4)}`
      )
    }
  })

  vlog(`done — merged=${merged}`)
  return merged > 0
}

/**
 * Bake skinned meshes to static geometry at their current rest pose.
 * Fallback-only: an unmergeable rig (bone quality ~0) can never follow body animation,
 * and skinned rendering ignores node transforms — verts follow the wearable's own bones,
 * so extent normalization and bone parenting measured via Box3 act on the wrong thing.
 * A static bake makes what we measure equal what the GPU draws.
 */
function freezeSkinnedForFallback(root: THREE.Object3D): void {
  root.updateWorldMatrix(true, true)
  const skinned: THREE.SkinnedMesh[] = []
  let plainMeshes = 0
  root.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh) skinned.push(obj)
    else if (obj instanceof THREE.Mesh) plainMeshes++
  })
  if (isAvatarVerbose()) {
    const first = skinned[0]
    const boneScale = first ? first.skeleton.bones[0]?.getWorldScale(new THREE.Vector3()) : null
    let bakeInfo = ''
    if (first?.geometry.attributes.skinIndex) {
      // Bake bbox two ways: three's applyBoneTransform vs the raw matrix formula.
      // Divergence live ⇒ SkinnedMesh is patched; both collapsing ⇒ boneInverses wrong.
      const pos = first.geometry.attributes.position as THREE.BufferAttribute
      const si = first.geometry.attributes.skinIndex as THREE.BufferAttribute
      const sw = first.geometry.attributes.skinWeight as THREE.BufferAttribute
      const a = new THREE.Box3()
      const b = new THREE.Box3()
      const v = new THREE.Vector3()
      const vb = new THREE.Vector3()
      const acc = new THREE.Vector3()
      const m4 = new THREE.Matrix4()
      const step = Math.max(1, Math.floor(pos.count / 60))
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i)
        first.applyBoneTransform(i, v)
        a.expandByPoint(v.applyMatrix4(first.matrixWorld))
        // manual: Σ w · boneWorld · boneInverse · bindMatrix · v
        vb.fromBufferAttribute(pos, i).applyMatrix4(first.bindMatrix)
        acc.set(0, 0, 0)
        for (let j = 0; j < 4; j++) {
          const w = sw.getComponent(i, j)
          if (!w) continue
          const bi = si.getComponent(i, j)
          const bone = first.skeleton.bones[bi]
          if (!bone) continue
          m4.multiplyMatrices(bone.matrixWorld, first.skeleton.boneInverses[bi])
          acc.addScaledVector(new THREE.Vector3().copy(vb).applyMatrix4(m4), w)
        }
        b.expandByPoint(acc)
      }
      const inv0 = first.skeleton.boneInverses[0]
      bakeInfo =
        ` abtY=[${a.min.y.toFixed(2)}..${a.max.y.toFixed(2)}]` +
        ` manY=[${b.min.y.toFixed(2)}..${b.max.y.toFixed(2)}]` +
        ` inv0Scale=${inv0 ? inv0.getMaxScaleOnAxis().toExponential(2) : '?'}`
    }
    console.info(
      `[avatar] freeze diag: skinned=${skinned.length} plain=${plainMeshes}` +
        (first
          ? ` bones=${first.skeleton.bones.length} bone0="${first.skeleton.bones[0]?.name}" ` +
            `bone0Scale=${boneScale ? boneScale.x.toExponential(2) : '?'} ` +
            `skinIndex=${!!first.geometry.attributes.skinIndex} bindScale=${first.bindMatrix.getMaxScaleOnAxis().toExponential(2)}${bakeInfo}`
          : '')
    )
  }
  const v = new THREE.Vector3()
  for (const sm of skinned) {
    sm.skeleton.update()
    const geometry = sm.geometry.clone()
    const pos = geometry.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i)
      sm.applyBoneTransform(i, v)
      pos.setXYZ(i, v.x, v.y, v.z)
    }
    pos.needsUpdate = true
    geometry.deleteAttribute('skinIndex')
    geometry.deleteAttribute('skinWeight')
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()

    const mesh = new THREE.Mesh(geometry, sm.material)
    mesh.name = sm.name
    mesh.position.copy(sm.position)
    mesh.quaternion.copy(sm.quaternion)
    mesh.scale.copy(sm.scale)
    mesh.castShadow = sm.castShadow
    mesh.receiveShadow = sm.receiveShadow
    mesh.visible = sm.visible
    sm.parent?.add(mesh)
    sm.removeFromParent()
  }
}

/**
 * Convert placed fallback meshes into Hips-rigid SkinnedMeshes. Verts are baked in
 * avatar space at bind pose; binding with an identity bindMatrix and full Hips weight
 * reproduces them exactly at bind pose AND makes them ride the hips during locomotion
 * (static attaches drifted off the body as soon as the idle posed the skeleton).
 */
/** Mesh whose materials are all AvatarSkin — the wearable's copy of body skin. */
function isWearableSkinMesh(mesh: THREE.Mesh): boolean {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return materials.length > 0 && materials.every((mat) => /avatarskin/i.test(mat.name ?? ''))
}

function rigidSkinFallbackToHips(
  wearableRoot: THREE.Object3D,
  skeleton: THREE.Skeleton,
  target: THREE.Object3D,
  dropSkinMeshes: boolean
): boolean {
  const hips = findSkeletonHips(skeleton)
  const hipsIndex = hips ? skeleton.bones.indexOf(hips) : -1
  if (hipsIndex < 0 || hipsIndex > 65535) return false

  wearableRoot.updateWorldMatrix(true, true)
  const sources: THREE.Mesh[] = []
  wearableRoot.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.visible && !(obj instanceof THREE.SkinnedMesh)) {
      // When the base part stays visible (wearable hides/replaces nothing), the
      // wearable's own AvatarSkin copies would double the animated base skin with a
      // rigid one — drop them. When it DOES hide/replace, its skin is the replacement.
      if (dropSkinMeshes && isWearableSkinMesh(obj)) return
      sources.push(obj)
    }
  })
  if (!sources.length) return false

  for (const src of sources) {
    const geometry = src.geometry.clone()
    geometry.applyMatrix4(src.matrixWorld)
    const count = (geometry.attributes.position as THREE.BufferAttribute).count
    const skinIndex = new Uint16Array(count * 4)
    const skinWeight = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) {
      skinIndex[i * 4] = hipsIndex
      skinWeight[i * 4] = 1
    }
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4))
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4))

    const mesh = new THREE.SkinnedMesh(geometry, src.material)
    mesh.name = src.name
    mesh.castShadow = true
    mesh.receiveShadow = true
    bindSkinnedMesh(mesh, skeleton, new THREE.Matrix4())
    target.add(mesh)
  }
  return true
}

/**
 * When bone merge fails, render the wearable at its AUTHORED rest pose, rigid-skinned
 * to Hips. Creators export wearables already placed on the body (verified: all five
 * broken-rig test items measure upright & on-body raw — Hey Shorty fabric y 0.85–1.05,
 * Duckie ring 0.75–1.30, authored widths wider than the base body). Every placement
 * heuristic this path used to have (slot regions, uprighting, inflation, extent
 * normalization) existed only to reconstruct what zeroing the authored transforms had
 * destroyed. IMPORTANT: the caller must pass a PRISTINE layer — prepareWearableForCompose
 * mutates transforms and must never run before this.
 */
export function attachWearableFallback(
  wearableRoot: THREE.Object3D,
  skeleton: THREE.Skeleton,
  target: THREE.Object3D,
  options: MergeWearableOptions = {}
): boolean {
  if (isL1WearableUrn(options.wearableId) && options.category !== 'feet') return false
  const verbose = isAvatarVerbose()
  const gate = (msg: string) => {
    if (verbose) console.info(`[avatar] fallback gate ${options.wearableId ?? '?'} — ${msg}`)
  }

  // Bake the authored rest pose (own skeleton, untouched node transforms).
  freezeSkinnedForFallback(wearableRoot)
  const visibleMeshes = pruneWearableDisplayMeshes(wearableRoot, { extentCheck: false })
  if (visibleMeshes === 0) {
    gate('REJECT: no visible meshes after freeze+prune')
    return false
  }

  // Sanity: authored bounds must be avatar-plausible. Exports that are genuinely not
  // in body space (cm-scale rigs etc.) are skipped rather than guessed at — merge with
  // unit-baking is the path that understands those.
  wearableRoot.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(wearableRoot)
  if (box.isEmpty()) {
    gate('REJECT: empty box')
    return false
  }
  const size = box.getSize(new THREE.Vector3())
  const extent = Math.max(size.x, size.y, size.z)
  gate(
    `meshes=${visibleMeshes} box y=[${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}] ` +
      `x=[${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)}] extent=${extent.toFixed(2)}`
  )
  const plausible =
    extent <= 3.5 && extent >= 0.05 && box.min.y >= -0.5 && box.max.y <= 2.5
  if (!plausible) {
    // Best-effort rescue instead of invisibility: the live client's authored-pose bake
    // collapses for some rigs (open mystery — see docs/avatar-fallback-wearable-compose.md
    // "SESSION OUTCOME"); scale-fit to the slot extent and place at the slot region so
    // the wearable at least shows up roughly where it belongs.
    gate('implausible bake — heuristic rescue (fit + slot align)')
    fitWearableWorldExtent(wearableRoot, options.category)
    alignFallbackWearableToSlot(wearableRoot, options.category, options.hides)
  }

  const replacesNothing = !options.hides?.length
  const ok = rigidSkinFallbackToHips(wearableRoot, skeleton, target, replacesNothing)
  if (!ok) gate('REJECT: rigid skin produced no meshes (all dropped as skin copies?)')
  return ok
}

export function sanitizeWearableRoot(root: THREE.Object3D): void {
  sanitizeSceneGltfMaterials(root)
  pruneWearableDisplayMeshes(root)
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      // Cast contact shadows onto landscape / scene floors (worlds island beach included).
      obj.castShadow = true
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