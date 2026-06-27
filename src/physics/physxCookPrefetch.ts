import { buildPhysxCookMeshPayload } from './physxCookPayload'
import type { PhysxCookPoolRequest } from './physxCookPool'
import { physxCookStorageKey } from './physxCookByteCache'
import {
  bakeBootColliderGeometry,
  bakeEntityLocalColliderGeometry,
  bootColliderCookSignature,
  entityLocalColliderCookSignature
} from './physxCookBake'
import type { PhysicsColliderDesc } from './PhysXWorld'
import type * as THREE from 'three'

function shouldSkipPrefetch(storageKey: string, keys: Set<string>): boolean {
  return keys.has(storageKey)
}

function addWorldBakedPrefetch(
  requests: PhysxCookPoolRequest[],
  keys: Set<string>,
  geometry: THREE.BufferGeometry,
  desc: PhysicsColliderDesc,
  shapeLocal?: THREE.Matrix4
): void {
  const sig = bootColliderCookSignature(geometry, desc, shapeLocal, false)
  const storageKey = physxCookStorageKey(sig, false)
  if (shouldSkipPrefetch(storageKey, keys)) return
  const baked = bakeBootColliderGeometry(geometry, desc, shapeLocal)
  const payload = buildPhysxCookMeshPayload(baked)
  baked.dispose()
  if (!payload) return
  keys.add(storageKey)
  requests.push({ storageKey, convex: false, payload })
}

function addEntityLocalPrefetch(
  requests: PhysxCookPoolRequest[],
  keys: Set<string>,
  geometry: THREE.BufferGeometry,
  localMatrix: THREE.Matrix4
): void {
  const sig = entityLocalColliderCookSignature(geometry, localMatrix, false)
  const storageKey = physxCookStorageKey(sig, false)
  if (shouldSkipPrefetch(storageKey, keys)) return
  const baked = bakeEntityLocalColliderGeometry(geometry, localMatrix)
  const payload = buildPhysxCookMeshPayload(baked)
  baked.dispose()
  if (!payload) return
  keys.add(storageKey)
  requests.push({ storageKey, convex: false, payload })
}

/**
 * Build worker cook jobs for a PhysX drain batch.
 * @param geometryCache — same flag passed to `syncStaticColliders` (entity-local vs world-baked shapes).
 */
export function buildPhysxCookPrefetchRequests(
  descs: PhysicsColliderDesc[],
  geometryCache = false
): PhysxCookPoolRequest[] {
  const requests: PhysxCookPoolRequest[] = []
  const keys = new Set<string>()
  for (const desc of descs) {
    if (desc.shapes?.length) {
      for (const shape of desc.shapes) {
        if (!shape.geometry) continue
        if (geometryCache) {
          addEntityLocalPrefetch(requests, keys, shape.geometry, shape.localMatrix)
        } else {
          addWorldBakedPrefetch(requests, keys, shape.geometry, desc, shape.localMatrix)
        }
      }
    } else if (desc.geometry) {
      addWorldBakedPrefetch(requests, keys, desc.geometry, desc)
    }
  }
  return requests
}

/** Boot prefetch — world-baked triangle cooks (legacy alias, geometryCache=false). */
export function buildBootPhysxCookPrefetchRequests(descs: PhysicsColliderDesc[]): PhysxCookPoolRequest[] {
  return buildPhysxCookPrefetchRequests(descs, false)
}