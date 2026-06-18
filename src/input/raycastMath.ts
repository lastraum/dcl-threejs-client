import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import type { PBRaycast } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/raycast.gen'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import { dclToThreePos, dclToThreeVec, threeToDclPos, threeToDclVec } from '../bridge/dclTransform'
import { composeTriggerWorldMatrix } from './triggerAreaMath'

const _worldMatrix = new THREE.Matrix4()
const _localOffset = new THREE.Vector3()
const _target = new THREE.Vector3()

export type SceneRay = {
  originThree: THREE.Vector3
  directionThree: THREE.Vector3
  originDcl: THREE.Vector3
  directionDcl: THREE.Vector3
}

/** Build a world-space ray from a `Raycast` spec on `entity`. */
export function buildSceneRay(
  entity: Entity,
  raycast: PBRaycast,
  Transform: MirrorComponents['Transform'],
  view: { RootEntity: Entity },
  nodes: Map<Entity, THREE.Group>
): SceneRay | null {
  if (!composeTriggerWorldMatrix(entity, Transform, view, nodes, _worldMatrix, 'three')) {
    return null
  }

  const offset = raycast.originOffset ?? { x: 0, y: 0, z: 0 }
  _localOffset.set(offset.x, offset.y, offset.z)
  const originThree = _localOffset.clone().applyMatrix4(_worldMatrix)

  const direction = raycast.direction
  if (!direction) return null

  let directionThree: THREE.Vector3
  switch (direction.$case) {
    case 'localDirection': {
      const local = direction.localDirection
      directionThree = new THREE.Vector3(local.x, local.y, local.z)
        .transformDirection(_worldMatrix)
        .normalize()
      break
    }
    case 'globalDirection': {
      const global = direction.globalDirection
      directionThree = dclToThreeVec(
        new THREE.Vector3(global.x, global.y, global.z),
        new THREE.Vector3()
      ).normalize()
      break
    }
    case 'globalTarget': {
      const target = direction.globalTarget
      _target.copy(dclToThreePos(target.x, target.y, target.z))
      directionThree = _target.sub(originThree).normalize()
      break
    }
    case 'targetEntity': {
      const targetEntity = direction.targetEntity as Entity
      if (!composeTriggerWorldMatrix(targetEntity, Transform, view, nodes, _worldMatrix, 'three')) {
        return null
      }
      _target.setFromMatrixPosition(_worldMatrix)
      directionThree = _target.sub(originThree).normalize()
      break
    }
    default:
      return null
  }

  if (directionThree.lengthSq() < 1e-8) return null

  const originDcl = threeToDclPos(originThree.x, originThree.y, originThree.z, new THREE.Vector3())
  const directionDcl = threeToDclVec(directionThree, new THREE.Vector3()).normalize()

  return { originThree, directionThree, originDcl, directionDcl }
}

/** Stable key — re-run one-shot raycasts when the scene replaces the request. */
export function raycastRequestKey(raycast: PBRaycast): string {
  const dir = raycast.direction
  let dirKey = 'none'
  if (dir) {
    switch (dir.$case) {
      case 'localDirection': {
        const v = dir.localDirection
        dirKey = `local:${v.x},${v.y},${v.z}`
        break
      }
      case 'globalDirection': {
        const v = dir.globalDirection
        dirKey = `global:${v.x},${v.y},${v.z}`
        break
      }
      case 'globalTarget': {
        const v = dir.globalTarget
        dirKey = `target:${v.x},${v.y},${v.z}`
        break
      }
      case 'targetEntity':
        dirKey = `entity:${dir.targetEntity}`
        break
      default:
        break
    }
  }
  const off = raycast.originOffset ?? { x: 0, y: 0, z: 0 }
  return [
    raycast.timestamp ?? 0,
    raycast.maxDistance,
    raycast.queryType,
    raycast.continuous ? 1 : 0,
    raycast.collisionMask ?? '',
    `${off.x},${off.y},${off.z}`,
    dirKey
  ].join('|')
}