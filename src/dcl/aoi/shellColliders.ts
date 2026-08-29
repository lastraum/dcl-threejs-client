import * as THREE from 'three'
import { isGltfInvisibleColliderMesh } from '../../collision/gltfColliderNaming'
import type { PhysicsColliderDesc } from '../../physics/PhysXWorld'

/**
 * Occupied composite-shell PhysX (SDK6 CityTiles, unbooted SDK7 composites).
 * Sits in the 100k gap after road hash (21–29M) and before empty-land (29.1M).
 */
export const SHELL_AOI_COLLIDER_ENTITY_BASE = 29_000_000
export const SHELL_AOI_COLLIDER_ID_SPAN = 100_000

export function stableShellColliderEntityId(instanceKey: string): number {
  let h = 2166136261
  for (let i = 0; i < instanceKey.length; i++) {
    h ^= instanceKey.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return SHELL_AOI_COLLIDER_ENTITY_BASE + ((h >>> 0) % SHELL_AOI_COLLIDER_ID_SPAN)
}

export function isShellAoiColliderEntity(entity: number): boolean {
  return (
    entity >= SHELL_AOI_COLLIDER_ENTITY_BASE &&
    entity < SHELL_AOI_COLLIDER_ENTITY_BASE + SHELL_AOI_COLLIDER_ID_SPAN
  )
}

/**
 * Invisible `_collider` hulls from an already-attached shell GLB.
 * Vis art never cooks (ADR-215) — CityTiles author floors/walls as `_collider`.
 */
export function extractShellColliderDescs(
  gltfRoot: THREE.Object3D,
  entityId: string,
  src: string
): PhysicsColliderDesc[] {
  gltfRoot.updateMatrixWorld(true)
  const descs: PhysicsColliderDesc[] = []
  let idx = 0
  gltfRoot.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if ((node as THREE.SkinnedMesh).isSkinnedMesh && !/_collider/i.test(node.name)) return
    if (!isGltfInvisibleColliderMesh(node, gltfRoot)) return
    const geometry = node.geometry
    const pos = geometry.getAttribute('position')
    if (!pos || pos.count < 3) return
    const key = `${entityId}:${src}:${node.name}:${idx}`
    const entity = stableShellColliderEntityId(key)
    descs.push({
      entity,
      kind: 'geometry',
      fingerprint: `shell-aoi:v1:${src}:${node.name}:${geometry.uuid}`,
      matrix: node.matrixWorld.clone(),
      geometry
    })
    idx++
  })
  return descs
}
