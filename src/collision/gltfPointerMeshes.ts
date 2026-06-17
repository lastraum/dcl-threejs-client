import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import { ColliderLayer, hasColliderLayer } from './ColliderLayer'
import { isGltfInvisibleColliderMesh, isGltfVisibleClassMesh } from './gltfColliderNaming'

export type GltfCollisionMaskSource = {
  visibleMeshesCollisionMask?: number
  invisibleMeshesCollisionMask?: number
}

/**
 * Visible GLTF meshes are pointer-raycast targets when the mask includes CL_POINTER,
 * or when visibleMeshesCollisionMask is omitted and PointerEvents is registered on the
 * entity (RickRoll drone: invisible=_collider physics-only, visible Cube clickable).
 */
export function gltfVisibleMeshesPointerEnabled(
  gltfData: GltfCollisionMaskSource,
  pointerEventsRegistered: boolean
): boolean {
  const visibleMask = gltfData.visibleMeshesCollisionMask
  if (visibleMask !== undefined && hasColliderLayer(visibleMask, ColliderLayer.CL_POINTER)) {
    return true
  }
  return visibleMask === undefined && pointerEventsRegistered
}

export function gltfInvisibleMeshPointerEnabled(gltfData: GltfCollisionMaskSource): boolean {
  const invisibleMask =
    gltfData.invisibleMeshesCollisionMask ?? (ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS)
  return hasColliderLayer(invisibleMask, ColliderLayer.CL_POINTER)
}

/** Push GLTF mesh raycast targets honoring DCL visible/invisible collision masks. */
export function collectGltfPointerTargetMeshes(
  gltfRoot: THREE.Object3D,
  gltfData: GltfCollisionMaskSource,
  entity: Entity,
  pointerEventsRegistered: boolean,
  out: THREE.Object3D[]
): void {
  const includeVisible = gltfVisibleMeshesPointerEnabled(gltfData, pointerEventsRegistered)
  const invisiblePointer = gltfInvisibleMeshPointerEnabled(gltfData)

  gltfRoot.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (node.visible === false) return
    if (isGltfVisibleClassMesh(node)) {
      if (!includeVisible) return
    } else if (isGltfInvisibleColliderMesh(node, gltfRoot)) {
      if (!invisiblePointer) return
    } else if (!includeVisible) {
      return
    }
    node.userData.entity = entity
    out.push(node)
  })
}
