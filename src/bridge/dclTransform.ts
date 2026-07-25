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

/** Apply ECS local transform → Three.js display space. */
export function applyDclLocalTransform(obj: THREE.Object3D, t: DclTransformValues): void {
  dclToThreePos(t.position.x, t.position.y, t.position.z, obj.position)
  dclToThreeQuat(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w, obj.quaternion)
  // Keep authored scale (do not swap for marquee re-basis — panels are spaced by scale.x
  // along the curve; swapping made them overlap and double-draw LED rows).
  obj.scale.set(t.scale.x, t.scale.y, t.scale.z)
  // Static plaza GLTFs freeze matrixAutoUpdate — still need local matrix after pose write.
  if (!obj.matrixAutoUpdate) obj.updateMatrix()
}

/** Live Three.js anchors for reserved ECS parents (PlayerEntity / CameraEntity). */
export type ReservedTransformAnchors = {
  getPlayerRoot: () => THREE.Object3D | null
  getCamera: () => THREE.Object3D | null
}

export type TransformParentView = {
  RootEntity: Entity
  PlayerEntity?: Entity
  CameraEntity?: Entity
}

/** True when `parent` is scene root / unset (not a scene-entity Group). */
export function isSceneRootParent(
  parentEntity: Entity | undefined | null,
  view: TransformParentView
): boolean {
  return (
    parentEntity === undefined ||
    parentEntity === null ||
    parentEntity === 0 ||
    parentEntity === view.RootEntity
  )
}

/**
 * Resolve Three.js parent for an ECS Transform.parent.
 *
 * Contract: for a non-root scene parent that already has a store node, that node is returned.
 * Callers must run {@link expandTransformAncestors} + create ancestor nodes **before** this
 * so a missing parent node is not silently replaced with sceneRoot (which parks *local*
 * coords at world origin — plaza bounce TriggerAreas ~50m wrong).
 *
 * sceneRoot is only used for: root/0, reserved PE/camera without anchors, or a parent id
 * that truly has no Transform on the ECS yet (forward reference).
 */
export function resolveTransformParent(
  parentEntity: Entity | undefined,
  view: TransformParentView,
  nodes: Map<Entity, THREE.Group>,
  sceneRoot: THREE.Group,
  anchors?: ReservedTransformAnchors | null
): THREE.Object3D {
  if (isSceneRootParent(parentEntity, view)) {
    return sceneRoot
  }
  // Reserved entities are not scene store nodes — parent to the live player/camera object.
  // Dead Surge post-tutorial arrow: Transform.parent = engine.PlayerEntity.
  if (view.PlayerEntity != null && parentEntity === view.PlayerEntity) {
    return anchors?.getPlayerRoot() ?? sceneRoot
  }
  if (view.CameraEntity != null && parentEntity === view.CameraEntity) {
    return anchors?.getCamera() ?? sceneRoot
  }
  const parentNode = nodes.get(parentEntity as Entity)
  if (parentNode) return parentNode
  // Parent id is set but no node — caller should have expanded/created ancestors first.
  // Fall back only for true forward refs (parent Transform not on ECS yet).
  return sceneRoot
}

/**
 * Add every ECS Transform ancestor of `entities` into the set (in-place).
 * Partial CRDT batches that only contain children still apply parents first.
 */
export function expandTransformAncestors(
  entities: Set<Entity>,
  Transform: MirrorComponents['Transform'],
  view: TransformParentView
): void {
  const queue = [...entities]
  while (queue.length > 0) {
    const entity = queue.pop()!
    const t = Transform.getOrNull(entity)
    if (!t) continue
    const parent = t.parent as Entity | undefined
    if (isSceneRootParent(parent, view)) continue
    if (view.PlayerEntity != null && parent === view.PlayerEntity) continue
    if (view.CameraEntity != null && parent === view.CameraEntity) continue
    if (!Transform.has(parent as Entity)) continue
    if (entities.has(parent as Entity)) continue
    entities.add(parent as Entity)
    queue.push(parent as Entity)
  }
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
