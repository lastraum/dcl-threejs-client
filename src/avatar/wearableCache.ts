import * as THREE from 'three'
import { normalizeGlbCacheKey } from '../rendering/glbByteCache'
import { repairSkinnedMesh } from '../rendering/skinnedMeshInstance'

/** Content-hash key for Catalyst wearables; stable URL for bundled `/avatar/wearables/` GLBs. */
export function wearableGlbCacheKey(url: string): string {
  return normalizeGlbCacheKey(url)
}

/** Sanitize wearable GLB roots stored in AssetCache — no per-avatar skin/hair tint. */
export function prepareWearableCacheRoot(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.name.toLowerCase().includes('collider')) {
      obj.visible = false
    }
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = false
      obj.receiveShadow = false
    }
    if (obj instanceof THREE.SkinnedMesh) {
      repairSkinnedMesh(obj)
    }
  })
}
