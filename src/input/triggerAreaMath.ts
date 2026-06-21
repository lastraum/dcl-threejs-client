import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import {
  dclToThreePos,
  dclToThreeQuat,
  type DclTransformValues
} from '../bridge/dclTransform'

/** Matches `TriggerAreaMeshType.TAMT_SPHERE`. */
export const TRIGGER_MESH_SPHERE = 1

/** Vertical probe offsets (m) from player Transform origin (feet) — torso catches ground-level boxes. */
export const PLAYER_PROBE_HEIGHTS_DCL = [0, 0.55, 1.1] as const

const _inv = new THREE.Matrix4()
const _local = new THREE.Vector3()
const _compose = new THREE.Matrix4()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()

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

function composeTransformMatrixDcl(t: DclTransformValues, out: THREE.Matrix4): void {
  _pos.set(t.position.x, t.position.y, t.position.z)
  _quat.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w)
  _scale.set(t.scale.x, t.scale.y, t.scale.z)
  out.compose(_pos, _quat, _scale)
}

function composeTransformMatrixThree(t: DclTransformValues, out: THREE.Matrix4): void {
  dclToThreePos(t.position.x, t.position.y, t.position.z, _pos)
  dclToThreeQuat(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w, _quat)
  _scale.set(t.scale.x, t.scale.y, t.scale.z)
  out.compose(_pos, _quat, _scale)
}

function collectTransformChain(
  entity: Entity,
  Transform: MirrorComponents['Transform'],
  view: { RootEntity: Entity }
): Entity[] {
  const chain: Entity[] = []
  let current: Entity | undefined = entity
  const seen = new Set<Entity>()
  while (current !== undefined && current !== view.RootEntity && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    const tr = Transform.getOrNull(current)
    if (!tr?.parent || tr.parent === view.RootEntity || tr.parent === 0) break
    current = tr.parent as Entity
  }
  chain.reverse()
  return chain
}

/**
 * World matrix from projection CRDT transforms in **DCL scene space** (Tier A default).
 * Matches SDK TriggerArea semantics — do not mix with Three.js display reflection.
 */
export function composeTriggerWorldMatrixDcl(
  entity: Entity,
  Transform: MirrorComponents['Transform'],
  view: { RootEntity: Entity },
  out: THREE.Matrix4
): boolean {
  const chain = collectTransformChain(entity, Transform, view)
  if (!chain.length) return false
  out.identity()
  for (const e of chain) {
    const tr = Transform.getOrNull(e)
    if (!tr) return false
    composeTransformMatrixDcl(tr as DclTransformValues, _compose)
    out.multiply(_compose)
  }
  return true
}

function composeTransformMatrix(
  t: DclTransformValues,
  out: THREE.Matrix4,
  space: 'dcl' | 'three'
): void {
  if (space === 'dcl') composeTransformMatrixDcl(t, out)
  else composeTransformMatrixThree(t, out)
}

/**
 * World matrix for a trigger entity — prefers the live scene-graph node, falls back to
 * projection Transform parent chain (store nodes can lag behind CRDT during spawn).
 */
export function composeTriggerWorldMatrix(
  entity: Entity,
  Transform: MirrorComponents['Transform'],
  view: { RootEntity: Entity },
  nodes: Map<Entity, THREE.Group>,
  out: THREE.Matrix4,
  space: 'dcl' | 'three' = 'three'
): boolean {
  const node = nodes.get(entity)
  if (node && space === 'three') {
    node.updateWorldMatrix(true, false)
    out.copy(node.matrixWorld)
    return true
  }

  const chain = collectTransformChain(entity, Transform, view)
  if (!chain.length) return false
  out.identity()
  for (const e of chain) {
    composeTransformMatrix(Transform.get(e) as DclTransformValues, _compose, space)
    out.multiply(_compose)
  }
  return true
}

/** True when any vertical probe at the player's DCL Transform origin is inside the volume. */
export function isPlayerInsideTriggerDcl(
  playerTransform: DclTransformValues,
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