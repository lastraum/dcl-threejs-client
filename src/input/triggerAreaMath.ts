import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import {
  resolveEntityWorldMatrix,
  type EntityWorldTransformDeps
} from '../transform/entityWorldTransform'

/** Matches `TriggerAreaMeshType.TAMT_SPHERE`. */
export const TRIGGER_MESH_SPHERE = 1

/** Vertical probe offsets (m) from player Transform origin (feet) — torso catches ground-level boxes. */
export const PLAYER_PROBE_HEIGHTS_DCL = [0, 0.55, 1.1] as const

const _inv = new THREE.Matrix4()
const _local = new THREE.Vector3()
const _pos = new THREE.Vector3()

/** Unit box/sphere in entity local space (DCL default trigger primitives). */
export function isPointInsideTriggerLocal(local: THREE.Vector3, mesh: number): boolean {
  if (mesh === TRIGGER_MESH_SPHERE) {
    return local.lengthSq() <= 0.25
  }
  return Math.abs(local.x) <= 0.5 && Math.abs(local.y) <= 0.5 && Math.abs(local.z) <= 0.5
}

/** World-space point vs trigger volume — inverse-transform into entity-local unit primitive. */
export function isPointInsideTriggerMatrix(
  worldPoint: THREE.Vector3,
  worldMatrix: THREE.Matrix4,
  mesh: number
): boolean {
  _inv.copy(worldMatrix).invert()
  _local.copy(worldPoint).applyMatrix4(_inv)
  return isPointInsideTriggerLocal(_local, mesh)
}

/** World-space point vs trigger entity group — uses composed world matrix from the scene graph. */
export function isPointInsideTriggerVolume(
  worldPoint: THREE.Vector3,
  triggerNode: THREE.Object3D,
  mesh: number
): boolean {
  triggerNode.updateWorldMatrix(true, false)
  return isPointInsideTriggerMatrix(worldPoint, triggerNode.matrixWorld, mesh)
}

/**
 * World matrix from projection CRDT transforms in **DCL scene space** (Tier A default).
 * Matches SDK TriggerArea semantics — do not mix with Three.js display reflection.
 */
export function composeTriggerWorldMatrixDcl(
  entity: Entity,
  deps: EntityWorldTransformDeps,
  out: THREE.Matrix4
): boolean {
  return resolveEntityWorldMatrix(entity, deps, { space: 'dcl', out }) !== null
}

/**
 * World matrix for a trigger entity in Three.js display space — prefers the live scene-graph
 * node, falls back to projection Transform parent chain (store nodes can lag behind CRDT during spawn).
 */
export function composeTriggerWorldMatrix(
  entity: Entity,
  deps: EntityWorldTransformDeps,
  out: THREE.Matrix4
): boolean {
  return resolveEntityWorldMatrix(entity, deps, { space: 'three', out }) !== null
}

/** True when any vertical probe at the player's DCL Transform origin is inside the volume. */
export function isPlayerInsideTriggerDcl(
  playerTransform: {
    position: { x: number; y: number; z: number }
    rotation: { x: number; y: number; z: number; w: number }
    scale: { x: number; y: number; z: number }
  },
  worldMatrix: THREE.Matrix4,
  mesh: number,
  probeHeights: readonly number[] = PLAYER_PROBE_HEIGHTS_DCL
): boolean {
  for (const h of probeHeights) {
    _pos.set(playerTransform.position.x, playerTransform.position.y + h, playerTransform.position.z)
    if (isPointInsideTriggerMatrix(_pos, worldMatrix, mesh)) return true
  }
  return false
}