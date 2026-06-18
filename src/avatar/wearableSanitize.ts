import * as THREE from 'three'

const _boundsSize = new THREE.Vector3()

/** Helper / physics / duplicate body shells that must never render on avatars. */
const WEARABLE_HIDE_NAME =
  /collider|_lod\d*$|_lod_|helper|invisible|physics|_anchor|_target|vfx|particle|reference|basemesh|basebody|bodyshape|avatar_body|_body_/i

/** Max mesh extent in meters — larger geometry is almost always a bad export or VFX plane. */
const MAX_WEARABLE_MESH_EXTENT_M = 3.5

function meshExtentMeters(mesh: THREE.Mesh): number {
  const box = new THREE.Box3().setFromObject(mesh)
  if (box.isEmpty()) return 0
  return box.getSize(_boundsSize).length()
}

function shouldHideWearableMesh(mesh: THREE.Mesh): boolean {
  if (WEARABLE_HIDE_NAME.test(mesh.name)) return true
  return meshExtentMeters(mesh) > MAX_WEARABLE_MESH_EXTENT_M
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
  for (const bone of skeleton.bones) {
    const name = bone.name.replace(/\.\d+$/, '')
    if (/^(Avatar_)?Hips$/i.test(name)) return bone
  }
  return skeleton.bones[0] ?? null
}