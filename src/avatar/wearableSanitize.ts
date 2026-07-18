import * as THREE from 'three'
import { normalizeBoneName, resolveBoneName } from './emoteBoneMap'
import type { WearableCategory } from './types'

const _boundsSize = new THREE.Vector3()
const _worldScale = new THREE.Vector3()

/**
 * Junk geometry inside wearable GLBs (colliders, LOD, helpers).
 * Do NOT match `*BaseMesh*` here — that is the standard DCL wearable display mesh
 * (e.g. ShapeB_uBody_BaseMesh). Body-shape shells are hidden via `applyBodyShapeVisibility`.
 */
// LOD1 is often the only NFT display mesh (e.g. ProcessedMeshNode_LOD1) — hide LOD2+ only.
const WEARABLE_HIDE_NAME =
  /collider|_lod[2-9]\d*$|_lod_[2-9]|helper|invisible|physics|_anchor|_target|vfx|particle|reference|^armature$|skeleton|rig_|^root$/i

/** Max mesh extent in meters — larger geometry is almost always a bad export or VFX plane. */
const MAX_WEARABLE_MESH_EXTENT_M = 3.5

/** Expected wearable size by slot — used to fix L1 exports parented with wrong unit scale. */
const EXPECTED_WEARABLE_EXTENT_M: Partial<Record<WearableCategory, number>> = {
  feet: 0.55,
  lower_body: 1.1,
  upper_body: 1.4,
  hands_wear: 0.45,
  helmet: 0.7,
  hat: 0.7,
  top_head: 0.7,
  mask: 0.65,
  eyewear: 0.35,
  earring: 0.2,
  tiara: 0.35,
  facial_hair: 0.35,
  hair: 0.9
}

const CATEGORY_ATTACH_BONE_ALIASES: Partial<Record<WearableCategory, string[]>> = {
  // Whole-shoe GLBs must not parent to a single foot — Hips keeps both feet aligned.
  feet: ['Hips'],
  lower_body: ['Hips', 'Spine'],
  upper_body: ['Spine2', 'Spine1', 'Spine'],
  hands_wear: ['LeftHand', 'RightHand', 'LeftForeArm', 'RightForeArm'],
  helmet: ['Head', 'Neck'],
  hat: ['Head', 'Neck'],
  top_head: ['Head', 'Neck'],
  mask: ['Head', 'Neck'],
  eyewear: ['Head', 'Neck'],
  earring: ['Head', 'LeftEar', 'RightEar'],
  tiara: ['Head', 'Neck'],
  facial_hair: ['Head', 'Neck'],
  hair: ['Head', 'Neck']
}

function meshExtentMeters(mesh: THREE.Mesh): number {
  mesh.updateWorldMatrix(true, false)
  const box = new THREE.Box3().setFromObject(mesh)
  if (box.isEmpty()) return 0
  return box.getSize(_boundsSize).length()
}

/** Local-space bounds — catches cm-scale helper planes before armature scale is normalized. */
function localMeshExtent(mesh: THREE.Mesh): number {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
  const box = mesh.geometry.boundingBox
  if (!box || box.isEmpty()) return 0
  return box.getSize(_boundsSize).length()
}

function isCmScaleHelperPlane(mesh: THREE.Mesh): boolean {
  const local = localMeshExtent(mesh)
  if (local <= 10) return false
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute | undefined
  // RTFKT / L1 helper quad: ~58 verts, ~250cm wide (standard sneakers: same count but ~0.25m).
  return (pos?.count ?? 0) < 120
}

export function wearableHasCmScaleDisplayMesh(root: THREE.Object3D): boolean {
  let found = false
  root.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh)) return
    if (localMeshExtent(obj) > 2) found = true
  })
  return found
}

function shouldHideWearableMesh(mesh: THREE.Mesh, extentCheck = true): boolean {
  if (WEARABLE_HIDE_NAME.test(mesh.name)) return true
  if (isCmScaleHelperPlane(mesh)) return true
  if (!extentCheck) return false
  return meshExtentMeters(mesh) > MAX_WEARABLE_MESH_EXTENT_M
}

function subtreeHasVisibleMesh(obj: THREE.Object3D): boolean {
  let found = false
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh && child.visible) found = true
  })
  return found
}

/** RTFKT feet ship duplicate scene-root armatures — drop trees with no display mesh. */
export function pruneOrphanWearableRoots(wearableRoot: THREE.Object3D): void {
  for (const child of [...wearableRoot.children]) {
    if (!subtreeHasVisibleMesh(child)) child.removeFromParent()
  }
}

/**
 * Max world scale on the wearable rig — BaseMale Armature ≈0.01, RTFKT ≈10.
 * Returns 0 when unknown (never invent 1.0 — that vs body 0.01 produced 100× explode).
 */
export function getWearableArmatureScale(root: THREE.Object3D): number {
  let maxScale = 0
  root.updateWorldMatrix(true, true)
  root.traverse((obj) => {
    if (!/armature/i.test(obj.name)) return
    obj.getWorldScale(_worldScale)
    maxScale = Math.max(maxScale, _worldScale.x, _worldScale.y, _worldScale.z)
  })
  // Many L1/NFT GLBs name the rig root without "Armature" — use skinned-mesh ancestors.
  if (maxScale <= 0) {
    root.traverse((obj) => {
      if (!(obj instanceof THREE.SkinnedMesh)) return
      let p: THREE.Object3D | null = obj
      for (let depth = 0; p && depth < 6; depth++, p = p.parent) {
        p.getWorldScale(_worldScale)
        maxScale = Math.max(maxScale, _worldScale.x, _worldScale.y, _worldScale.z)
        if (p === root) break
      }
    })
  }
  return maxScale > 0 ? maxScale : 0
}

/** True when wearable rig units differ from body_shape (merge would explode skinning). */
export function wearableNeedsParallelSkeleton(
  bodyRoot: THREE.Object3D,
  wearableRoot: THREE.Object3D
): boolean {
  // Primary signal — RTFKT/L1 feet keep shoe verts in ~300cm space; body_shape uses meters.
  if (wearableHasCmScaleDisplayMesh(wearableRoot)) return true

  const bodyScale = getWearableArmatureScale(bodyRoot)
  const wearScale = getWearableArmatureScale(wearableRoot)
  if (bodyScale <= 1e-8 || wearScale <= 1e-8) return false
  const ratio = wearScale / bodyScale
  return ratio > 2 || ratio < 0.5
}

/** Match wearable armature units to body_shape (Forge keeps parallel rigs at the same scale). */
export function normalizeWearableArmatureToBody(
  wearableRoot: THREE.Object3D,
  bodyRoot: THREE.Object3D
): void {
  const bodyScale = getWearableArmatureScale(bodyRoot)
  const wearScale = getWearableArmatureScale(wearableRoot)
  if (bodyScale <= 1e-8 || wearScale <= 1e-8) return
  const ratio = wearScale / bodyScale
  if (ratio > 2 || ratio < 0.5) {
    const factor = bodyScale / wearScale
    // Body 0.01 / RTFKT 10 → 0.001 — must apply, not reject as "absurd".
    if (!Number.isFinite(factor) || factor < 1e-4 || factor > 100) return
    let applied = false
    wearableRoot.traverse((obj) => {
      if (!/armature/i.test(obj.name)) return
      obj.scale.multiplyScalar(factor)
      applied = true
    })
    if (!applied) wearableRoot.scale.multiplyScalar(factor)
  }
}

/**
 * RTFKT / L1 feet often ship vertex coords in cm while armature node scale reads ~1.
 * Bake oversize local geometry down to meter-scale slot extents before merge or fallback.
 */
export function bakeOversizedWearableGeometry(
  root: THREE.Object3D,
  category?: WearableCategory
): void {
  const expected = (category && EXPECTED_WEARABLE_EXTENT_M[category]) ?? 2
  // Feet use a tight trigger so L1 shoes (vampire_feet etc.) bake before merge.
  const trigger =
    category === 'feet' ? Math.max(expected * 1.5, 0.8) : Math.max(expected * 4, 2.5)
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const local = localMeshExtent(obj)
    if (local <= trigger) return
    const factor = expected / local
    // SkeletonUtils.clone shares geometry with AssetCache — never mutate the template.
    obj.geometry = obj.geometry.clone()
    const pos = obj.geometry.attributes.position as THREE.BufferAttribute | undefined
    if (!pos) return
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        pos.getX(i) * factor,
        pos.getY(i) * factor,
        pos.getZ(i) * factor
      )
    }
    pos.needsUpdate = true
    obj.geometry.computeBoundingBox()
    obj.geometry.computeBoundingSphere()
  })
}

/** True when wearable rig units differ from body_shape — must normalize before extent-based prune. */
export function wearableNeedsArmatureNormalize(
  bodyRoot: THREE.Object3D,
  wearableRoot: THREE.Object3D
): boolean {
  if (wearableHasCmScaleDisplayMesh(wearableRoot)) return true
  const bodyScale = getWearableArmatureScale(bodyRoot)
  const wearScale = getWearableArmatureScale(wearableRoot)
  if (bodyScale <= 0 || wearScale <= 0) return false
  const ratio = wearScale / bodyScale
  return ratio > 2 || ratio < 0.5
}

/**
 * Normalize armature to body_shape, then prune — extent checks must run after scale fix.
 * Parallel duplicate skeletons break locomotion (mixer drives the wrong rig → T-pose).
 */
export function prepareWearableForCompose(
  wearableRoot: THREE.Object3D,
  bodyRoot: THREE.Object3D,
  category?: WearableCategory
): void {
  // Undo cache-time / prior compose hides before orphan pruning (stale visible=false drops whole subtrees).
  wearableRoot.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.visible = true
  })
  pruneOrphanWearableRoots(wearableRoot)
  wearableRoot.position.set(0, 0, 0)
  wearableRoot.rotation.set(0, 0, 0)
  wearableRoot.scale.set(1, 1, 1)
  normalizeWearableArmatureToBody(wearableRoot, bodyRoot)
  bakeOversizedWearableGeometry(wearableRoot, category)
  normalizeWearableWorldScale(wearableRoot, category)
  pruneWearableDisplayMeshes(wearableRoot)
}

/** @deprecated Use prepareWearableForCompose — kept for existing imports. */
export function prepareCmScaleWearableForMerge(
  wearableRoot: THREE.Object3D,
  bodyRoot: THREE.Object3D
): void {
  prepareWearableForCompose(wearableRoot, bodyRoot)
}

function skeletonBoneSet(skeleton: THREE.Skeleton): Set<string> {
  const names = new Set<string>()
  for (const bone of skeleton.bones) {
    names.add(normalizeBoneName(bone.name))
  }
  return names
}

function findBoneByResolvedName(skeleton: THREE.Skeleton, resolved: string): THREE.Bone | null {
  for (const bone of skeleton.bones) {
    if (normalizeBoneName(bone.name) === resolved) return bone
  }
  return null
}

export type PruneWearableMeshesOptions = {
  /** When false, only hide by name / helper heuristics (safe before armature normalize). */
  extentCheck?: boolean
}

/** Hide colliders, oversize planes, and duplicate body shells — returns visible mesh count. */
export function pruneWearableDisplayMeshes(
  root: THREE.Object3D,
  options: PruneWearableMeshesOptions = {}
): number {
  const extentCheck = options.extentCheck !== false
  let visible = 0
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    obj.visible = true
    if (shouldHideWearableMesh(obj, extentCheck)) {
      obj.visible = false
      return
    }
    visible++
  })
  return visible
}

export function findSkeletonHips(skeleton: THREE.Skeleton): THREE.Bone | null {
  const bones = skeletonBoneSet(skeleton)
  const resolved = resolveBoneName('Hips', bones)
  if (resolved) {
    const hit = findBoneByResolvedName(skeleton, resolved)
    if (hit) return hit
  }
  return skeleton.bones[0] ?? null
}

/** Pick the best avatar bone for a wearable slot when full GLB parenting is required. */
export function findAttachBoneForCategory(
  skeleton: THREE.Skeleton,
  category?: WearableCategory
): THREE.Bone | null {
  const aliases = category ? CATEGORY_ATTACH_BONE_ALIASES[category] : undefined
  const bones = skeletonBoneSet(skeleton)
  if (aliases) {
    for (const alias of aliases) {
      const resolved = resolveBoneName(alias, bones)
      if (!resolved) continue
      const hit = findBoneByResolvedName(skeleton, resolved)
      if (hit) return hit
    }
  }
  return findSkeletonHips(skeleton)
}

/**
 * L1 / legacy GLBs often ship at cm scale or with an oversized rig root.
 * Shrink only when world bounds are clearly wrong for the wearable slot.
 */
export function normalizeWearableWorldScale(
  root: THREE.Object3D,
  category?: WearableCategory
): void {
  const expected = (category && EXPECTED_WEARABLE_EXTENT_M[category]) ?? 2
  // Feet: shrink when clearly larger than a shoe (not only when >4× expected).
  const trigger =
    category === 'feet' ? Math.max(expected * 1.6, 0.9) : Math.max(expected * 4, 2.5)

  root.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(root)
  if (box.isEmpty()) return

  const extent = box.getSize(_boundsSize).length()
  if (extent <= trigger) return

  const factor = expected / extent
  // Only shrink — never enlarge via this path.
  if (!Number.isFinite(factor) || factor <= 0 || factor >= 1) return
  root.scale.set(
    root.scale.x * factor,
    root.scale.y * factor,
    root.scale.z * factor
  )
}

/**
 * After parenting under body bones (Hips etc.), hierarchy scale can double-shrink
 * or re-inflate the wearable. Fit world extent to the slot target (grow or shrink).
 */
export function fitWearableWorldExtent(
  root: THREE.Object3D,
  category?: WearableCategory
): void {
  const expected = (category && EXPECTED_WEARABLE_EXTENT_M[category]) ?? 2
  const maxOk =
    category === 'feet' ? Math.max(expected * 1.6, 0.9) : Math.max(expected * 4, 2.5)
  const minOk = expected * 0.25

  root.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(root)
  if (box.isEmpty()) return

  const extent = box.getSize(_boundsSize).length()
  if (extent < 1e-8) return
  if (extent >= minOk && extent <= maxOk) return

  const factor = expected / extent
  if (!Number.isFinite(factor) || factor < 1e-4 || factor > 100) return
  root.scale.multiplyScalar(factor)
}

/**
 * Unit conversion factor so wearable mesh verts match body_shape bind space.
 *
 * Body_shape: Armature ≈ 0.01, feet verts ~0.4m local.
 * RTFKT / L1 feet: Armature ≈ 10, verts ~300–600 local → explode if merged raw.
 */
export function wearableUnitScaleFactor(
  bodyRoot: THREE.Object3D,
  wearableRoot: THREE.Object3D,
  category?: WearableCategory
): number {
  let factor = 1
  const bodyScale = getWearableArmatureScale(bodyRoot)
  const wearScale = getWearableArmatureScale(wearableRoot)
  // Both sides must be known. Missing wear scale used to default to 1 vs body 0.01 → 100× explode.
  if (bodyScale > 1e-8 && wearScale > 1e-8) {
    const ratio = wearScale / bodyScale
    if (ratio > 2 || ratio < 0.5) factor = bodyScale / wearScale
  }

  const expected = (category && EXPECTED_WEARABLE_EXTENT_M[category]) ?? 2
  // Feet: ~0.55m. L1 halloween vampire_feet often merge with unitFactor=1 then explode.
  // Use a tight trigger (1.5× expected) so we bake before bind, not after soup.
  const meshTrigger =
    category === 'feet' ? Math.max(expected * 1.5, 0.8) : Math.max(expected * 4, 2.5)
  let maxLocal = 0
  wearableRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.visible) return
    maxLocal = Math.max(maxLocal, localMeshExtent(obj))
  })
  if (maxLocal > meshTrigger) {
    const fromMesh = expected / maxLocal
    // Prefer mesh extent when armature factor alone still leaves cm-space verts.
    if (factor === 1 || maxLocal * factor > expected * 1.5) {
      factor = fromMesh
    }
  }
  // Body Armature ≈0.01 vs RTFKT ≈10 → factor ≈0.001. Reject only true garbage.
  // (Old floor of 0.02 forced factor=1 and left shoes giant / pruned invisible.)
  if (!Number.isFinite(factor) || factor < 1e-4 || factor > 100) return 1
  return factor
}

/** Bake uniform scale into position attributes (merge path unit fix). */
export function scaleGeometryPositions(geometry: THREE.BufferGeometry, factor: number): void {
  if (!Number.isFinite(factor) || Math.abs(factor - 1) < 1e-8) return
  const pos = geometry.attributes.position as THREE.BufferAttribute | undefined
  if (!pos) return
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) * factor, pos.getY(i) * factor, pos.getZ(i) * factor)
  }
  pos.needsUpdate = true
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
}