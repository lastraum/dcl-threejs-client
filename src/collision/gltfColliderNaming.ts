import type * as THREE from 'three'

/** DCL invisible physics meshes: name contains `_collider` anywhere (Blender suffixes like `_001` are common). */
export function isGltfInvisibleColliderName(name: string | undefined): boolean {
  if (!name) return false
  return /_collider/i.test(name)
}

/** Match mesh or any ancestor up to `stopBefore` (exclusive). Handles unnamed mesh under a collider group. */
export function isGltfInvisibleColliderMesh(mesh: THREE.Mesh, stopBefore: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = mesh
  while (node && node !== stopBefore) {
    if (isGltfInvisibleColliderName(node.name)) return true
    node = node.parent
  }
  return false
}

/**
 * Named non-`_collider` mesh — visible GLTF class (`visibleMeshesCollisionMask`).
 * Stays visible-class even when nested under a `_collider` group (RickRoll drone `Cube` proxy).
 */
export function isGltfVisibleClassMesh(mesh: THREE.Mesh): boolean {
  return mesh.name.length > 0 && !isGltfInvisibleColliderName(mesh.name)
}
