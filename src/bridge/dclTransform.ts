import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { SceneWorldBounds } from '../player/SceneBounds'
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

/** Reflect a DCL scene-space AABB into Three.js display space (X negated). */
export function dclBoundsToThreeDisplay(bounds: SceneWorldBounds): SceneWorldBounds {
  return {
    minX: -bounds.maxX,
    maxX: -bounds.minX,
    minZ: bounds.minZ,
    maxZ: bounds.maxZ
  }
}

/** DCL entities face +Z; Three.js PerspectiveCamera looks down -Z (self-inverse). */
const _ENTITY_TO_CAMERA_YAW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)

/** DCL entity world rotation → Three.js camera quaternion (display space). */
export function dclEntityQuatToThreeCameraQuat(
  x: number,
  y: number,
  z: number,
  w: number,
  out = new THREE.Quaternion()
): THREE.Quaternion {
  dclToThreeQuat(x, y, z, w, out)
  return out.multiply(_ENTITY_TO_CAMERA_YAW)
}

/**
 * Entity orientation already in Three.js display space (e.g. {@link resolveEntityWorldPose})
 * → camera quaternion. Do not pass through {@link dclToThreeQuat} again.
 */
export function entityDisplayQuatToThreeCameraQuat(
  entityQuat: THREE.Quaternion,
  out = new THREE.Quaternion()
): THREE.Quaternion {
  return out.copy(entityQuat).multiply(_ENTITY_TO_CAMERA_YAW)
}

/** Three.js camera quaternion → DCL entity rotation (display space). */
export function threeCameraQuatToDclEntityQuat(
  q: THREE.Quaternion,
  out = new THREE.Quaternion()
): THREE.Quaternion {
  out.copy(q).multiply(_ENTITY_TO_CAMERA_YAW)
  return threeToDclQuat(out, out)
}

/** Yaw around world up — negates under X reflection. */
export function dclYawToThreeYaw(yaw: number): number {
  return -yaw
}

export function threeYawToDclYaw(yaw: number): number {
  return -yaw
}

/** True when a MeshRenderer plane was re-based so atlas text runs along local +X. */
function entityHasTextAlongYPlaneBasis(obj: THREE.Object3D): boolean {
  let found = false
  obj.traverse((child) => {
    if (found) return
    const g = (child as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    if (g?.userData?.dclTextAlongYBasis) found = true
  })
  return found
}

/** Apply ECS local transform → Three.js display space. */
export function applyDclLocalTransform(obj: THREE.Object3D, t: DclTransformValues): void {
  dclToThreePos(t.position.x, t.position.y, t.position.z, obj.position)
  dclToThreeQuat(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w, obj.quaternion)
  // Marquee planes map atlas U (text) along local Y; we re-basis mesh so text is on +X.
  // Swap scale so authored text-length (scale.y) still spans the board horizontally.
  if (entityHasTextAlongYPlaneBasis(obj)) {
    obj.scale.set(t.scale.y, t.scale.x, t.scale.z)
  } else {
    obj.scale.set(t.scale.x, t.scale.y, t.scale.z)
  }
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
