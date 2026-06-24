import * as THREE from 'three'
import { enableMeshVertexColors, tuneAuthorTerrainMeshMaterial } from '../rendering/LandscapeAssetSanitizer'
import { isGltfInvisibleColliderName } from './gltfColliderNaming'

function meshMaterials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

/** True when a mesh carries glTF-authored display maps (not a bare pointer/physics proxy). */
export function gltfMeshHasDisplayMaps(mesh: THREE.Mesh): boolean {
  if (mesh.geometry.getAttribute('color')) return true
  for (const material of meshMaterials(mesh)) {
    if (!material) continue
    const std = material as THREE.MeshStandardMaterial
    if (std.map || std.emissiveMap || std.normalMap || std.metalnessMap || std.roughnessMap) return true
  }
  return false
}

/** Keep pointer raycasts while hiding untextured proxy hulls from the camera. */
function hideMeshFromCameraKeepRaycast(mesh: THREE.Mesh): void {
  mesh.visible = true
  for (const material of meshMaterials(mesh)) {
    if (!material) continue
    material.transparent = true
    material.opacity = 0
    material.depthWrite = false
  }
}

function unhideRenderAncestors(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !node.visible) return
    let parent = node.parent
    while (parent && parent !== root) {
      if (!isGltfInvisibleColliderName(parent.name)) parent.visible = true
      parent = parent.parent
    }
  })
}

/**
 * Apply DCL glTF render visibility after cache sanitization / on every attach sync.
 *
 * Standard layout: textured visible-class meshes render, `_collider` meshes stay hidden.
 * RickRoll `drone.glb` mis-export: textured art on `drone_collider`, untextured `Cube` pointer proxy —
 * show the textured `_collider` mesh and hide the proxy from the camera (still raycastable).
 */
export function syncGltfInstanceRenderState(root: THREE.Object3D): void {
  const visibleClass: THREE.Mesh[] = []
  const colliderClass: THREE.Mesh[] = []

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (isGltfInvisibleColliderName(node.name)) colliderClass.push(node)
    else visibleClass.push(node)
  })

  const visibleHasDisplay = visibleClass.some(gltfMeshHasDisplayMaps)
  const misExport = !visibleHasDisplay && colliderClass.some(gltfMeshHasDisplayMaps)

  root.traverse((node) => {
    if (isGltfInvisibleColliderName(node.name)) {
      if (node instanceof THREE.Mesh) {
        node.visible = misExport && gltfMeshHasDisplayMaps(node)
      } else {
        node.visible = false
      }
      return
    }
    if (node instanceof THREE.Mesh) {
      if (misExport && !gltfMeshHasDisplayMaps(node)) hideMeshFromCameraKeepRaycast(node)
      else node.visible = true
    }
  })

  unhideRenderAncestors(root)

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !node.visible) return
    enableMeshVertexColors(node)
    tuneAuthorTerrainMeshMaterial(node)
  })
}
