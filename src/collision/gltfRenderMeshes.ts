import * as THREE from 'three'
import {
  isGltfInvisibleColliderMesh,
  isGltfInvisibleColliderName,
  isGltfVisibleClassMesh
} from './gltfColliderNaming'

function meshMaterials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

/** True when a mesh carries glTF-authored display maps (not a bare pointer/physics proxy). */
export function gltfMeshHasDisplayMaps(mesh: THREE.Mesh): boolean {
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

function classifyGltfRenderMeshes(root: THREE.Object3D): {
  visibleClass: THREE.Mesh[]
  colliderClass: THREE.Mesh[]
  misExport: boolean
} {
  const visibleClass: THREE.Mesh[] = []
  const colliderClass: THREE.Mesh[] = []

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (isGltfInvisibleColliderMesh(node, root)) {
      if (isGltfVisibleClassMesh(node)) visibleClass.push(node)
      else colliderClass.push(node)
      return
    }
    visibleClass.push(node)
  })

  const visibleHasDisplay = visibleClass.some(gltfMeshHasDisplayMaps)
  const misExport = !visibleHasDisplay && colliderClass.some(gltfMeshHasDisplayMaps)
  return { visibleClass, colliderClass, misExport }
}

/** Meshes that should draw for a GLTF instance (excludes hidden `_collider` hulls). */
export function collectGltfRenderMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const { visibleClass, colliderClass, misExport } = classifyGltfRenderMeshes(root)
  const meshes: THREE.Mesh[] = []

  for (const mesh of visibleClass) {
    const pos = mesh.geometry?.getAttribute('position')
    if (!pos || pos.count < 3) continue
    if (misExport && !gltfMeshHasDisplayMaps(mesh)) continue
    meshes.push(mesh)
  }

  if (misExport) {
    for (const mesh of colliderClass) {
      const pos = mesh.geometry?.getAttribute('position')
      if (!pos || pos.count < 3) continue
      if (gltfMeshHasDisplayMaps(mesh)) meshes.push(mesh)
    }
  }

  return meshes
}

/**
 * Apply DCL glTF render visibility after cache sanitization / on every attach sync.
 *
 * Standard layout: textured visible-class meshes render, `_collider` meshes stay hidden.
 * RickRoll `drone.glb` mis-export: textured art on `drone_collider`, untextured `Cube` pointer proxy —
 * show the textured `_collider` mesh and hide the proxy from the camera (still raycastable).
 */
export function syncGltfInstanceRenderState(root: THREE.Object3D): void {
  const { colliderClass, misExport } = classifyGltfRenderMeshes(root)

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

  for (const mesh of colliderClass) {
    mesh.visible = misExport && gltfMeshHasDisplayMaps(mesh)
  }

  unhideRenderAncestors(root)
}
