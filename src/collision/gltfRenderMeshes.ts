import * as THREE from 'three'
import {
  isGltfInvisibleColliderMesh,
  isGltfInvisibleColliderName,
  isGltfVisibleClassMesh
} from './gltfColliderNaming'
import { isSharedAssetResource } from '../rendering/sharedAsset'

function meshMaterials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

const DEFAULT_ALBEDO = new THREE.Color(0xffffff)

function materialHasDisplayContent(material: THREE.Material): boolean {
  const std = material as THREE.MeshStandardMaterial & THREE.MeshBasicMaterial
  if (std.map || std.emissiveMap || std.normalMap || std.metalnessMap || std.roughnessMap || std.alphaMap) {
    return true
  }
  if ('vertexColors' in std && std.vertexColors) return true
  if ('color' in std && std.color && !std.color.equals(DEFAULT_ALBEDO)) return true
  return false
}

/** True when a mesh carries glTF-authored display content (not a bare pointer/physics proxy). */
export function gltfMeshHasDisplayMaps(mesh: THREE.Mesh): boolean {
  if (mesh.geometry?.attributes.color) return true
  for (const material of meshMaterials(mesh)) {
    if (!material) continue
    if (materialHasDisplayContent(material)) return true
  }
  return false
}

function detachSharedMaterials(mesh: THREE.Mesh): void {
  const materials = meshMaterials(mesh)
  if (!materials.some((m) => m && isSharedAssetResource(m))) return
  const cloned = materials.map((m) => (m ? m.clone() : m))
  mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]!
}

/** Keep pointer raycasts while hiding untextured proxy hulls from the camera. */
function hideMeshFromCameraKeepRaycast(mesh: THREE.Mesh): void {
  detachSharedMaterials(mesh)
  mesh.visible = true
  for (const material of meshMaterials(mesh)) {
    if (!material) continue
    material.transparent = true
    material.opacity = 0
    material.depthWrite = false
  }
}

/** InstancedMesh cannot drive per-instance morph/skinning — skip those templates. */
export function isInstancableGltfMesh(mesh: THREE.Mesh): boolean {
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return false
  const geometry = mesh.geometry
  if (!geometry) return false
  const pos = geometry.getAttribute('position')
  if (!pos || pos.count < 3) return false
  if (
    geometry.morphAttributes.position?.length ||
    geometry.morphAttributes.normal?.length ||
    geometry.morphAttributes.color?.length
  ) {
    return false
  }
  const materials = meshMaterials(mesh)
  if (!materials.length || materials.some((m) => !m)) return false
  return true
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

/** Renderable GLTF meshes safe for InstancedMesh batching (no morph/skinning). */
export function collectGltfInstancingMeshes(root: THREE.Object3D): THREE.Mesh[] {
  return collectGltfRenderMeshes(root).filter(isInstancableGltfMesh)
}

/** True when every render mesh can be batched into InstancedMesh (no partial roots). */
export function isGltfRootInstancable(root: THREE.Object3D): boolean {
  const renderMeshes = collectGltfRenderMeshes(root)
  if (!renderMeshes.length) return false
  return collectGltfInstancingMeshes(root).length === renderMeshes.length
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
