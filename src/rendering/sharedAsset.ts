import * as THREE from 'three'

const SHARED = '__sharedAsset'

/** Tag geometries/materials owned by AssetCache — never dispose from instance clones. */
export function markSharedAssetResources(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    node.geometry.userData[SHARED] = true
    const materials = Array.isArray(node.material) ? node.material : [node.material]
    for (const material of materials) {
      if (material) material.userData[SHARED] = true
    }
  })
}

export function isSharedAssetResource(resource: { userData?: Record<string, unknown> } | null | undefined): boolean {
  return resource?.userData?.[SHARED] === true
}

/** Remove an instance from the scene graph without touching cached GPU resources. */
export function detachObject3D(obj: THREE.Object3D): void {
  obj.removeFromParent()
}

export function disposeOwnedObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    if (!isSharedAssetResource(child.geometry)) {
      child.geometry?.dispose()
    }
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if (material && !isSharedAssetResource(material)) {
        material.dispose()
      }
    }
  })
}
