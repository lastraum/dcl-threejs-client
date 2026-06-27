import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { EntityPose } from '../bridge/ReservedEntitiesSync'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { EntityStore } from '../bridge/EntityStore'
import {
  applyDclLocalTransform,
  dclToThreePos,
  dclToThreeQuat,
  type DclTransformValues
} from '../bridge/dclTransform'

const _local = new THREE.Matrix4()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()

export type EntityWorldPose = {
  position: THREE.Vector3
  rotation: THREE.Quaternion
}

export type EntityWorldTransformDeps = {
  view: ProjectionView
  store: EntityStore
  playerPose: () => EntityPose
  cameraPose: () => EntityPose
}

/** World pose for scene entities, reserved ids, and parent chains (incl. PlayerEntity attach). */
export function resolveEntityWorldPose(
  entity: Entity,
  deps: EntityWorldTransformDeps,
  out: EntityWorldPose = { position: new THREE.Vector3(), rotation: new THREE.Quaternion() }
): EntityWorldPose | null {
  const matrix = resolveEntityWorldMatrix(entity, deps)
  if (!matrix) return null
  matrix.decompose(out.position, out.rotation, _scale)
  return out
}

function needsManualTransformChain(
  entity: Entity,
  view: ProjectionView,
  store: EntityStore
): boolean {
  const { Transform } = view.components
  const { RootEntity, PlayerEntity, CameraEntity } = view
  let current: Entity | undefined = entity
  while (current !== undefined && Transform.has(current)) {
    const parent = Transform.get(current).parent as Entity | undefined
    if (!parent || parent === RootEntity || parent === 0) return false
    if (parent === PlayerEntity || parent === CameraEntity) return true
    if (!store.has(parent)) return true
    current = parent
  }
  return false
}

export function resolveEntityWorldMatrix(
  entity: Entity,
  deps: EntityWorldTransformDeps,
  out = new THREE.Matrix4()
): THREE.Matrix4 | null {
  const { view, store, playerPose, cameraPose } = deps
  const { Transform } = view.components
  const { RootEntity, PlayerEntity, CameraEntity } = view

  const node = store.getNode(entity)
  if (node?.parent && !needsManualTransformChain(entity, view, store)) {
    node.updateMatrixWorld(true)
    out.copy(node.matrixWorld)
    return out
  }

  const cache = new Map<Entity, THREE.Matrix4>()
  const build = (e: Entity): THREE.Matrix4 | null => {
    const hit = cache.get(e)
    if (hit) return hit

    if (e === PlayerEntity) {
      const pose = playerPose()
      _pos.copy(dclToThreePos(pose.position.x, pose.position.y, pose.position.z))
      dclToThreeQuat(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w, _quat)
      const mat = new THREE.Matrix4().compose(_pos, _quat, _scale.set(1, 1, 1))
      cache.set(e, mat)
      return mat
    }

    if (e === CameraEntity) {
      const pose = cameraPose()
      _pos.copy(dclToThreePos(pose.position.x, pose.position.y, pose.position.z))
      dclToThreeQuat(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w, _quat)
      const mat = new THREE.Matrix4().compose(_pos, _quat, _scale.set(1, 1, 1))
      cache.set(e, mat)
      return mat
    }

    const t = Transform.getOrNull(e) as DclTransformValues | null
    if (!t) {
      if (e === RootEntity || e === 0) {
        const identity = new THREE.Matrix4()
        cache.set(e, identity)
        return identity
      }
      return null
    }

    const obj = new THREE.Object3D()
    applyDclLocalTransform(obj, t)
    _local.copy(obj.matrix)

    let parentMat: THREE.Matrix4 | null = null
    const parent = t.parent
    if (!parent || parent === RootEntity || parent === 0) {
      parentMat = new THREE.Matrix4()
    } else {
      parentMat = build(parent as Entity)
    }
    if (!parentMat) return null

    const world = new THREE.Matrix4().multiplyMatrices(parentMat, _local)
    cache.set(e, world)
    return world
  }

  return build(entity)
}