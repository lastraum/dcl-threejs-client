import * as THREE from 'three'
import { bakeTrimeshGeometry } from './bakeTrimeshGeometry'
import { ensureIndexedForCook } from './colliderGeometryPrep'
import { geometryCookCacheId } from './geometryToPxMesh'
import type { PhysicsColliderDesc } from './PhysXWorld'

const _worldBake = new THREE.Matrix4()

/** Boot `loading` pass — world-space vertices baked into mesh (actor at origin). */
export function bootWorldBakeMatrix(desc: PhysicsColliderDesc, shapeLocal?: THREE.Matrix4): THREE.Matrix4 {
  _worldBake.copy(desc.matrix)
  if (shapeLocal) _worldBake.multiply(shapeLocal)
  return _worldBake
}

export function bakeBootColliderGeometry(
  geometry: THREE.BufferGeometry,
  desc: PhysicsColliderDesc,
  shapeLocal?: THREE.Matrix4
): THREE.BufferGeometry {
  const indexed = ensureIndexedForCook(geometry)
  const baked = bakeTrimeshGeometry(indexed, bootWorldBakeMatrix(desc, shapeLocal))
  if (indexed !== geometry) indexed.dispose()
  return baked
}

export function bakeEntityLocalColliderGeometry(
  geometry: THREE.BufferGeometry,
  localMatrix: THREE.Matrix4
): THREE.BufferGeometry {
  const indexed = ensureIndexedForCook(geometry)
  const baked = bakeTrimeshGeometry(indexed, localMatrix)
  if (indexed !== geometry) indexed.dispose()
  return baked
}

export function bootColliderCookSignature(
  geometry: THREE.BufferGeometry,
  desc: PhysicsColliderDesc,
  shapeLocal?: THREE.Matrix4,
  convex = false
): string {
  const baked = bakeBootColliderGeometry(geometry, desc, shapeLocal)
  const sig = geometryCookCacheId(baked, convex)
  baked.dispose()
  return sig
}

/** Entity-local GLTF `_collider` — matches `createLocalTrimeshShape` geometryCache path. */
export function entityLocalColliderCookSignature(
  geometry: THREE.BufferGeometry,
  localMatrix: THREE.Matrix4,
  convex = false
): string {
  const baked = bakeEntityLocalColliderGeometry(geometry, localMatrix)
  const sig = geometryCookCacheId(baked, convex)
  baked.dispose()
  return sig
}