import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from './mirrorComponents'

export type DclTransformValues = {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
  parent?: Entity
}

/**
 * DCL SDK7 uses a left-handed scene space (+X east, +Y up, +Z north).
 * Three.js is right-handed with the same axis labels — reflect across YZ
 * (negate X) when rendering so layout matches Unity Explorer.
 */
export function dclToThreePos(
  x: number,
  y: number,
  z: number,
  out = new THREE.Vector3()
): THREE.Vector3 {
  return out.set(-x, y, z)
}

export function threeToDclPos(
  x: number,
  y: number,
  z: number,
  out = new THREE.Vector3()
): THREE.Vector3 {
  return out.set(-x, y, z)
}

/** Quaternion under YZ reflection (self-inverse). */
export function dclToThreeQuat(
  x: number,
  y: number,
  z: number,
  w: number,
  out = new THREE.Quaternion()
): THREE.Quaternion {
  return out.set(-x, y, z, -w)
}

export function threeToDclQuat(
  q: THREE.Quaternion,
  out = new THREE.Quaternion()
): THREE.Quaternion {
  return out.set(-q.x, q.y, q.z, -q.w)
}

export function dclToThreeVec(v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return dclToThreePos(v.x, v.y, v.z, out)
}

export function threeToDclVec(v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return threeToDclPos(v.x, v.y, v.z, out)
}

/** Yaw around world up — negates under X reflection. */
export function dclYawToThreeYaw(yaw: number): number {
  return -yaw
}

export function threeYawToDclYaw(yaw: number): number {
  return -yaw
}

/** Apply ECS local transform → Three.js display space. */
export function applyDclLocalTransform(obj: THREE.Object3D, t: DclTransformValues): void {
  dclToThreePos(t.position.x, t.position.y, t.position.z, obj.position)
  dclToThreeQuat(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w, obj.quaternion)
  obj.scale.set(t.scale.x, t.scale.y, t.scale.z)
}

export function resolveTransformParent(
  parentEntity: Entity | undefined,
  view: { RootEntity: Entity },
  nodes: Map<Entity, THREE.Group>,
  sceneRoot: THREE.Group
): THREE.Object3D {
  if (!parentEntity || parentEntity === 0 || parentEntity === view.RootEntity) {
    return sceneRoot
  }
  return nodes.get(parentEntity as Entity) ?? sceneRoot
}

/** Depth in Transform hierarchy — parents always get lower depth than children. */
export function transformHierarchyDepth(
  entity: Entity,
  Transform: MirrorComponents['Transform'],
  cache = new Map<Entity, number>()
): number {
  const hit = cache.get(entity)
  if (hit !== undefined) return hit

  const t = Transform.getOrNull(entity)
  if (!t?.parent) {
    cache.set(entity, 0)
    return 0
  }

  const depth = transformHierarchyDepth(t.parent as Entity, Transform, cache) + 1
  cache.set(entity, depth)
  return depth
}

export function sortEntitiesByTransformDepth(
  entities: Entity[],
  Transform: MirrorComponents['Transform']
): Entity[] {
  const cache = new Map<Entity, number>()
  return [...entities].sort(
    (a, b) =>
      transformHierarchyDepth(a, Transform, cache) - transformHierarchyDepth(b, Transform, cache)
  )
}
