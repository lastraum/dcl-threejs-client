import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { EntityPose } from '../bridge/ReservedEntitiesSync'
import type { ProjectionView } from '../bridge/ProjectionView'
import { dclToThreePos, dclToThreeQuat, type DclTransformValues } from '../bridge/dclTransform'

const _local = new THREE.Matrix4()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()

export type EntityWorldSpace = 'three' | 'dcl'

export type EntityWorldPose = {
  position: THREE.Vector3
  rotation: THREE.Quaternion
}

export type EntityWorldTransformDeps = {
  view: ProjectionView
  playerPose: () => EntityPose
  cameraPose: () => EntityPose
}

export type ResolveEntityWorldMatrixOptions = {
  space?: EntityWorldSpace
  out?: THREE.Matrix4
}

/**
 * World pose from ECS Transform parent chains (SDK7 authority).
 * Scene-graph matrixWorld is rendering-only — billboards/tweens can diverge without updating ECS.
 */
export function resolveEntityWorldPose(
  entity: Entity,
  deps: EntityWorldTransformDeps,
  out: EntityWorldPose = { position: new THREE.Vector3(), rotation: new THREE.Quaternion() },
  options?: ResolveEntityWorldMatrixOptions
): EntityWorldPose | null {
  const matrix = resolveEntityWorldMatrix(entity, deps, options)
  if (!matrix) return null
  matrix.decompose(out.position, out.rotation, _scale)
  return out
}

/** World position in Three.js display space (default). */
export function resolveEntityWorldPosition(
  entity: Entity,
  deps: EntityWorldTransformDeps,
  out = new THREE.Vector3(),
  options?: ResolveEntityWorldMatrixOptions
): THREE.Vector3 | null {
  const matrix = resolveEntityWorldMatrix(entity, deps, options)
  if (!matrix) return null
  return out.setFromMatrixPosition(matrix)
}

export function resolveEntityWorldMatrix(
  entity: Entity,
  deps: EntityWorldTransformDeps,
  options: ResolveEntityWorldMatrixOptions = {}
): THREE.Matrix4 | null {
  const space = options.space ?? 'three'
  const out = options.out ?? new THREE.Matrix4()
  const { view, playerPose, cameraPose } = deps
  const { Transform } = view.components
  const { RootEntity, PlayerEntity, CameraEntity } = view

  const cache = new Map<Entity, THREE.Matrix4>()
  const build = (e: Entity): THREE.Matrix4 | null => {
    const hit = cache.get(e)
    if (hit) return hit

    if (e === PlayerEntity) {
      const pose = playerPose()
      if (space === 'dcl') {
        _pos.copy(pose.position)
        _quat.copy(pose.rotation)
      } else {
        _pos.copy(dclToThreePos(pose.position.x, pose.position.y, pose.position.z))
        dclToThreeQuat(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w, _quat)
      }
      const mat = new THREE.Matrix4().compose(_pos, _quat, _scale.set(1, 1, 1))
      cache.set(e, mat)
      return mat
    }

    if (e === CameraEntity) {
      const pose = cameraPose()
      if (space === 'dcl') {
        _pos.copy(pose.position)
        _quat.copy(pose.rotation)
      } else {
        _pos.copy(dclToThreePos(pose.position.x, pose.position.y, pose.position.z))
        dclToThreeQuat(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w, _quat)
      }
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

    // Parent world matrix first — shared _local scratch is reused by composeLocalTransformMatrix.
    // Composing local *before* recurse overwrote child local with the parent's (plaza bounce
    // spheres under Zi: world collapsed to ~origin while root-parented volumes stayed correct).
    let parentMat: THREE.Matrix4 | null = null
    const parent = t.parent
    if (!parent || parent === RootEntity || parent === 0) {
      parentMat = new THREE.Matrix4()
    } else {
      parentMat = build(parent as Entity)
    }
    if (!parentMat) return null

    composeLocalTransformMatrix(t, _local, space)
    const world = new THREE.Matrix4().multiplyMatrices(parentMat, _local)
    cache.set(e, world)
    return world
  }

  const built = build(entity)
  if (!built) return null
  out.copy(built)
  return out
}

function composeLocalTransformMatrix(t: DclTransformValues, out: THREE.Matrix4, space: EntityWorldSpace): void {
  if (space === 'dcl') {
    _pos.set(t.position.x, t.position.y, t.position.z)
    _quat.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w)
    _scale.set(t.scale.x, t.scale.y, t.scale.z)
    out.compose(_pos, _quat, _scale)
    return
  }

  dclToThreePos(t.position.x, t.position.y, t.position.z, _pos)
  dclToThreeQuat(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w, _quat)
  _scale.set(t.scale.x, t.scale.y, t.scale.z)
  out.compose(_pos, _quat, _scale)
}