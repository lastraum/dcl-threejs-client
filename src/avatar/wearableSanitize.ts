import * as THREE from 'three'
import { normalizeBoneName, resolveBoneName } from './emoteBoneMap'
import type { WearableCategory } from './types'

const _boundsSize = new THREE.Vector3()
const _worldScale = new THREE.Vector3()

/** Helper / physics / duplicate body shells that must never render on avatars. */
const WEARABLE_HIDE_NAME =
  /collider|_lod\d*$|_lod_|helper|invisible|physics|_anchor|_target|vfx|particle|reference|basemesh|basebody|bodyshape|avatar_body|_body_|^armature$|skeleton|rig_|^root$/i

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
  feet: ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase', 'Hips'],
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

function shouldHideWearableMesh(mesh: THREE.Mesh): boolean {
  if (WEARABLE_HIDE_NAME.test(mesh.name)) return true
  return meshExtentMeters(mesh) > MAX_WEARABLE_MESH_EXTENT_M
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

/** Hide colliders, oversize planes, and duplicate body shells — returns visible mesh count. */
export function pruneWearableDisplayMeshes(root: THREE.Object3D): number {
  let visible = 0
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    if (shouldHideWearableMesh(obj)) {
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
  const trigger = Math.max(expected * 4, 2.5)

  root.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(root)
  if (box.isEmpty()) return

  const extent = box.getSize(_boundsSize).length()
  if (extent <= trigger) return

  const factor = expected / extent
  root.getWorldScale(_worldScale)
  root.scale.set(
    root.scale.x * factor,
    root.scale.y * factor,
    root.scale.z * factor
  )
}