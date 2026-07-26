import type * as THREE from 'three'

/** DCL invisible physics meshes: name contains `_collider` anywhere (Blender suffixes like `_001` are common). */
export function isGltfInvisibleColliderName(name: string | undefined): boolean {
  if (!name) return false
  return /_collider/i.test(name)
}

/**
 * Match mesh or any ancestor up to `stopBefore` (exclusive).
 * Explorer parity: floor/wall hulls are often named `Floor` under a `*_collider` group — ancestry
 * must count, not only the leaf mesh name.
 */
export function isGltfInvisibleColliderMesh(mesh: THREE.Object3D, stopBefore: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = mesh
  while (node && node !== stopBefore) {
    if (isGltfInvisibleColliderName(node.name)) return true
    node = node.parent
  }
  return false
}

/**
 * Visible GLTF class (`visibleMeshesCollisionMask`) — named mesh that is **not** under a
 * `_collider` hierarchy. Must pass `stopBefore` (GLB root) so ancestry is checked; without it
 * only the leaf name is tested (legacy callers).
 */
export function isGltfVisibleClassMesh(mesh: THREE.Mesh, stopBefore?: THREE.Object3D): boolean {
  if (isGltfInvisibleColliderName(mesh.name)) return false
  if (stopBefore && isGltfInvisibleColliderMesh(mesh, stopBefore)) return false
  return mesh.name.length > 0
}
