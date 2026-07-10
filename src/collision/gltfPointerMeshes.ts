import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import { ColliderLayer, hasColliderLayer } from './ColliderLayer'
import { isGltfInvisibleColliderMesh, isGltfVisibleClassMesh } from './gltfColliderNaming'

export type GltfCollisionMaskSource = {
  visibleMeshesCollisionMask?: number
  invisibleMeshesCollisionMask?: number
}

/**
 * SDK7 defaults (docs):
 * - visibleMeshesCollisionMask omitted → 0 (no pointer/physics on art)
 * - invisibleMeshesCollisionMask omitted → CL_PHYSICS | CL_POINTER (_collider hulls)
 * Mask bits only — PointerEvents alone does not invent colliders (Explorer parity).
 */
export function gltfVisibleMeshesPointerEnabled(gltfData: GltfCollisionMaskSource): boolean {
  const visibleMask = gltfData.visibleMeshesCollisionMask ?? 0
  return hasColliderLayer(visibleMask, ColliderLayer.CL_POINTER)
}

export function gltfInvisibleMeshPointerEnabled(gltfData: GltfCollisionMaskSource): boolean {
  const invisibleMask =
    gltfData.invisibleMeshesCollisionMask ?? (ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS)
  return hasColliderLayer(invisibleMask, ColliderLayer.CL_POINTER)
}

/**
 * Push GLTF mesh raycast targets honoring DCL visible/invisible collision masks.
 *
 * Hidden `_collider` meshes (`visible=false`) with CL_POINTER are included; the pointer
 * raycaster temporarily unhides for THREE.Raycaster (skips invisible objects).
 */
export function collectGltfPointerTargetMeshes(
  gltfRoot: THREE.Object3D,
  gltfData: GltfCollisionMaskSource,
  entity: Entity,
  _pointerEventsRegistered: boolean,
  out: THREE.Object3D[]
): void {
  const includeVisible = gltfVisibleMeshesPointerEnabled(gltfData)
  const invisiblePointer = gltfInvisibleMeshPointerEnabled(gltfData)

  gltfRoot.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (isGltfVisibleClassMesh(node)) {
      if (!includeVisible) return
      // Opacity-0 proxy hulls stay raycastable; truly culled art does not.
      if (node.visible === false) return
    } else if (isGltfInvisibleColliderMesh(node, gltfRoot)) {
      if (!invisiblePointer) return
      // Keep even when visible=false — CL_POINTER hulls must still hit.
    } else {
      if (!includeVisible) return
      if (node.visible === false) return
    }
    node.userData.entity = entity
    out.push(node)
  })
}
