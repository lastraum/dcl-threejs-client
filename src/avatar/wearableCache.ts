import * as THREE from 'three'
import { normalizeGlbCacheKey } from '../rendering/glbByteCache'
import { pruneWearableDisplayMeshes } from './wearableSanitize'
import { repairSkinnedMesh } from '../rendering/skinnedMeshInstance'
import { setMeshDesiredCastShadow } from '../rendering/shadowCastPolicy'

/** Content-hash key for Catalyst wearables; stable URL for bundled `/avatar/wearables/` GLBs. */
export function wearableGlbCacheKey(url: string): string {
  return normalizeGlbCacheKey(url)
}

/** Sanitize wearable GLB roots stored in AssetCache — no per-avatar skin/hair tint. */
export function prepareWearableCacheRoot(root: THREE.Object3D): void {
  // Extent prune needs body_shape armature context — name-only here; compose re-prunes after normalize.
  pruneWearableDisplayMeshes(root, { extentCheck: false })
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      // Default on; RemoteAvatarManager may disable cast for distant remotes (shadow budget).
      setMeshDesiredCastShadow(obj, true, 'avatar')
      obj.receiveShadow = true
    }
    if (obj instanceof THREE.SkinnedMesh) {
      repairSkinnedMesh(obj)
    }
  })
}
