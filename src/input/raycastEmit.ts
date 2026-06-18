import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import type { PBRaycast } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/raycast.gen'
import type { PBRaycastResult } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/raycast_result.gen'
import type { RaycastHit } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/common/raycast_hit.gen'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { SceneRay } from './raycastMath'
import { threeToDclPos, threeToDclVec } from '../bridge/dclTransform'

const _pos = new THREE.Vector3()
const _normal = new THREE.Vector3()

export function buildRaycastResult(
  raycast: PBRaycast,
  ray: SceneRay,
  hits: RaycastHit[],
  tickNumber: number
): PBRaycastResult {
  return {
    timestamp: raycast.timestamp,
    globalOrigin: { x: ray.originDcl.x, y: ray.originDcl.y, z: ray.originDcl.z },
    direction: { x: ray.directionDcl.x, y: ray.directionDcl.y, z: ray.directionDcl.z },
    hits,
    tickNumber
  }
}

export function hitFromCollider(
  hitEntity: Entity,
  point: THREE.Vector3,
  normal: THREE.Vector3,
  distance: number,
  ray: SceneRay,
  meshName?: string
): RaycastHit {
  const pos = threeToDclPos(point.x, point.y, point.z, _pos)
  const normalDcl = threeToDclVec(normal, _normal)
  return {
    entityId: hitEntity,
    position: { x: pos.x, y: pos.y, z: pos.z },
    globalOrigin: { x: ray.originDcl.x, y: ray.originDcl.y, z: ray.originDcl.z },
    direction: { x: ray.directionDcl.x, y: ray.directionDcl.y, z: ray.directionDcl.z },
    normalHit: { x: normalDcl.x, y: normalDcl.y, z: normalDcl.z },
    length: distance,
    meshName
  }
}

export function putRaycastResult(
  ecs: MirrorComponents,
  entity: Entity,
  result: PBRaycastResult,
  recordLww?: (componentId: number, entity: Entity, value: unknown) => void
): void {
  ecs.RaycastResult.createOrReplace(entity, result)
  recordLww?.(ecs.RaycastResult.componentId, entity, result)
}