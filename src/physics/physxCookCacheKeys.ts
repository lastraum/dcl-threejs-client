import { physxCookStorageKey } from './physxCookByteCache'
import { bootColliderCookSignature, entityLocalColliderCookSignature } from './physxCookBake'
import type { PhysicsColliderDesc } from './PhysXWorld'

/** Boot IDB prime — entity-local GLTF triangle cooks (matches loading drain geometryCache=true path). */
export function collectBootPhysxCookStorageKeys(descs: PhysicsColliderDesc[]): string[] {
  const keys = new Set<string>()
  for (const desc of descs) {
    if (desc.shapes?.length) {
      for (const shape of desc.shapes) {
        if (!shape.geometry) continue
        const localSig = entityLocalColliderCookSignature(shape.geometry, shape.localMatrix, false)
        keys.add(physxCookStorageKey(localSig, false))
      }
    } else if (desc.geometry) {
      const sig = bootColliderCookSignature(desc.geometry, desc, undefined, false)
      keys.add(physxCookStorageKey(sig, false))
    }
  }
  return [...keys]
}

/** Storage keys for IndexedDB prime — entity-local + world-baked variants (legacy / manual recook probes). */
export function collectPhysxCookStorageKeys(descs: PhysicsColliderDesc[]): string[] {
  const keys = new Set(collectBootPhysxCookStorageKeys(descs))
  for (const desc of descs) {
    if (desc.shapes?.length) {
      for (const shape of desc.shapes) {
        if (!shape.geometry) continue
        const localSig = entityLocalColliderCookSignature(shape.geometry, shape.localMatrix, false)
        keys.add(physxCookStorageKey(localSig, true))
        const worldSig = bootColliderCookSignature(shape.geometry, desc, shape.localMatrix, false)
        keys.add(physxCookStorageKey(worldSig, false))
        keys.add(physxCookStorageKey(worldSig, true))
      }
    } else if (desc.geometry) {
      const sig = bootColliderCookSignature(desc.geometry, desc, undefined, false)
      keys.add(physxCookStorageKey(sig, true))
    }
  }
  return [...keys]
}