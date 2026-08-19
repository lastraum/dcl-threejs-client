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

function cloneOwnedMaterial(material: THREE.Material): THREE.Material {
  const next = material.clone()
  if (next.userData) delete next.userData[SHARED]
  return next
}

/**
 * Wearable/avatar instances must own their materials. AssetCache + SkeletonUtils
 * share GPU materials — tint / prepare / toon on a new peer would paint every
 * already-rendered avatar that still pointed at the cache prototype.
 */
export function ownInstanceMaterials(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !node.material) return
    if (Array.isArray(node.material)) {
      node.material = node.material.map((m) =>
        isSharedAssetResource(m) ? cloneOwnedMaterial(m) : m
      )
    } else if (isSharedAssetResource(node.material)) {
      node.material = cloneOwnedMaterial(node.material)
    }
  })
}

/** Remove an instance from the scene graph without touching cached GPU resources. */
export function detachObject3D(obj: THREE.Object3D): void {
  obj.removeFromParent()
}

export function disposeOwnedObject3D(obj: THREE.Object3D): void {
  // Per-avatar opaque atlas (if composed) — not shared with AssetCache.
  const atlas = (obj.userData as Record<string, unknown>).dclOpaqueAtlasTexture as
    | { dispose?: () => void }
    | undefined
  if (atlas?.dispose) {
    atlas.dispose()
    delete (obj.userData as Record<string, unknown>).dclOpaqueAtlasTexture
  }
  obj.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    if (!isSharedAssetResource(child.geometry)) {
      child.geometry?.dispose()
    }
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if (material && !isSharedAssetResource(material)) {
        // Don't dispose the shared atlas map here more than once — texture.dispose is idempotent-ish
        // but multiple materials share one atlas; dispose atlas only via root userData above.
        const map = (material as THREE.MeshStandardMaterial).map
        if (map && (map.userData as Record<string, unknown> | undefined)?.dclAvatarAtlas) {
          ;(material as THREE.MeshStandardMaterial).map = null
        }
        material.dispose()
      }
    }
  })
}
