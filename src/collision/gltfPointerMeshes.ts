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

/** DrawWorld parents `__mesh_*` under drawRoot — pose children are empty. */
export function gltfEntityDrawRoot(
  obj: THREE.Object3D | undefined,
  entity?: Entity
): THREE.Object3D | undefined {
  if (!obj) return undefined
  const drawn = obj.userData.dclDrawVisual as THREE.Object3D | undefined
  if (drawn) return drawn
  if (entity !== undefined) {
    const named = obj.getObjectByName(`__mesh_${entity}`)
    if (named) return named
  }
  return obj.children.find((c) => c.name.startsWith('__mesh_'))
}

export function gltfVisibleMeshLayerEnabled(
  gltfData: GltfCollisionMaskSource,
  layerMask: number
): boolean {
  const visibleMask = gltfData.visibleMeshesCollisionMask ?? 0
  return hasColliderLayer(visibleMask, layerMask)
}

export function gltfInvisibleMeshLayerEnabled(
  gltfData: GltfCollisionMaskSource,
  layerMask: number
): boolean {
  const invisibleMask =
    gltfData.invisibleMeshesCollisionMask ?? (ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS)
  return hasColliderLayer(invisibleMask, layerMask)
}

/**
 * Scene `Raycast` / any-layer query — include visible/invisible Gltf meshes whose
 * authored collision mask intersects `layerMask`. Not PhysX: CUSTOM* hulls stay
 * query-only so they never become walk surfaces.
 */
export function collectGltfLayerTargetMeshes(
  gltfRoot: THREE.Object3D,
  gltfData: GltfCollisionMaskSource,
  entity: Entity,
  layerMask: number,
  out: THREE.Object3D[]
): void {
  const includeVisible = gltfVisibleMeshLayerEnabled(gltfData, layerMask)
  const includeInvisible = gltfInvisibleMeshLayerEnabled(gltfData, layerMask)
  if (!includeVisible && !includeInvisible) return

  gltfRoot.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if ((node as THREE.InstancedMesh).isInstancedMesh) return
    // Renderer-added pond display mesh (sibling of `*_collider`). Same disk the
    // scene Raycast CL_CUSTOM8 aim cookie must hit — include it whenever the
    // invisible mask is in the query, even if a named collider also exists.
    if (node.userData.dclWaterVisual === true || node.name === 'dclWaterVisual') {
      if (!includeInvisible && !includeVisible) return
      node.userData.entity = entity
      out.push(node)
      return
    }
    if (isGltfInvisibleColliderMesh(node, gltfRoot)) {
      if (!includeInvisible) return
    } else if (isGltfVisibleClassMesh(node, gltfRoot)) {
      if (!includeVisible) return
      // Visibility / DrawWorld may hide the pose (click_area). Authored layer
      // masks still query — Explorer colliders ignore VisibilityComponent.
    } else {
      if (!includeVisible) return
    }
    node.userData.entity = entity
    out.push(node)
  })
}

function gltfHasInvisibleColliderMesh(gltfRoot: THREE.Object3D): boolean {
  let found = false
  gltfRoot.traverse((node) => {
    if (found || !(node instanceof THREE.Mesh)) return
    if (isGltfInvisibleColliderMesh(node, gltfRoot)) found = true
  })
  return found
}

export function collectGltfPointerTargetMeshes(
  gltfRoot: THREE.Object3D,
  gltfData: GltfCollisionMaskSource,
  entity: Entity,
  pointerEventsRegistered: boolean,
  out: THREE.Object3D[]
): void {
  const invisiblePointer = gltfInvisibleMeshPointerEnabled(gltfData)
  const hasInvisibleHull = invisiblePointer && gltfHasInvisibleColliderMesh(gltfRoot)
  // Visible art: authored CL_POINTER, or PE with no `_collider` hull (How To Play).
  // Do not include visible water/pond art when invisible CL_POINTER hulls exist —
  // a scale-18 water plane would steal every nearby PE (How To Play, inventory).
  const includeVisible = gltfVisibleMeshesPointerEnabled(gltfData) || (pointerEventsRegistered && !hasInvisibleHull)

  gltfRoot.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    // Ancestry-first: children of `*_collider` groups are invisible-class (Explorer).
    if (isGltfInvisibleColliderMesh(node, gltfRoot)) {
      if (!invisiblePointer) return
      // Keep even when visible=false — CL_POINTER hulls must still hit.
    } else if (isGltfVisibleClassMesh(node, gltfRoot)) {
      if (!includeVisible) return
      // Creator Hub click_area: visible-class cube, Visibility=false, vis mask
      // CL_POINTER. DrawWorld sets the extract `visible=false`; the hull still hits.
    } else {
      if (!includeVisible) return
    }
    node.userData.entity = entity
    out.push(node)
  })
}
