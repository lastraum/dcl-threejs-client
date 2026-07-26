import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import {
  resolveEntityWorldMatrix,
  type EntityWorldTransformDeps
} from '../transform/entityWorldTransform'

/** Matches `TriggerAreaMeshType.TAMT_SPHERE`. */
export const TRIGGER_MESH_SPHERE = 1

/**
 * Vertical probe offsets (m) from **capsule feet** (CCT foot position), not PE chest.
 * Covers full ~1.6m capsule so canopy spheres (Plaza parasols at +2.8) still hit
 * when feet sit on the mesh and PE lag / offset would miss a single sample.
 * Dead Surge join pads: unit box scale.y=1 centered y≈0 → world Y ∈ [-0.5, 0.5].
 */
export const PLAYER_PROBE_HEIGHTS_DCL = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.55] as const

/** Matches PhysXWorld CCT defaults — one avatar capsule, not a second body. */
export const PLAYER_CCT_RADIUS = 0.3
export const PLAYER_CCT_HEIGHT = 1.6

const _inv = new THREE.Matrix4()
const _local = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _segA = new THREE.Vector3()
const _segB = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _quat = new THREE.Quaternion()

/** Unit box/sphere in entity local space (DCL default trigger primitives). */
export function isPointInsideTriggerLocal(local: THREE.Vector3, mesh: number): boolean {
  if (mesh === TRIGGER_MESH_SPHERE) {
    // Unit sphere diameter 1 (radius 0.5) — same as MeshCollider sphere / Transform.scale.
    return local.lengthSq() <= 0.25 + 1e-6
  }
  return Math.abs(local.x) <= 0.5 + 1e-6 && Math.abs(local.y) <= 0.5 + 1e-6 && Math.abs(local.z) <= 0.5 + 1e-6
}

/** Squared distance from point P to segment AB. */
function distSqPointSegment(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number
): number {
  const abx = bx - ax
  const aby = by - ay
  const abz = bz - az
  const apx = px - ax
  const apy = py - ay
  const apz = pz - az
  const abLenSq = abx * abx + aby * aby + abz * abz
  let t = abLenSq > 1e-12 ? (apx * abx + apy * aby + apz * abz) / abLenSq : 0
  t = Math.max(0, Math.min(1, t))
  const qx = ax + abx * t - px
  const qy = ay + aby * t - py
  const qz = az + abz * t - pz
  return qx * qx + qy * qy + qz * qz
}

/**
 * Y-up capsule (CCT) vs unit TriggerArea volume under `worldMatrix` (DCL or Three — same space as feet).
 * Capsule: feet at bottom, total height includes hemispherical caps (PhysX CCT convention).
 * This is **one** player capsule (analytic) — not a second PhysX actor.
 */
export function capsuleOverlapsTriggerMatrix(
  feet: { x: number; y: number; z: number },
  worldMatrix: THREE.Matrix4,
  mesh: number,
  radius: number = PLAYER_CCT_RADIUS,
  totalHeight: number = PLAYER_CCT_HEIGHT
): boolean {
  const r = Math.max(radius, 1e-4)
  const h = Math.max(totalHeight, r * 2 + 1e-4)
  // Segment between hemisphere centers.
  _segA.set(feet.x, feet.y + r, feet.z)
  _segB.set(feet.x, feet.y + h - r, feet.z)

  _inv.copy(worldMatrix).invert()
  _segA.applyMatrix4(_inv)
  _segB.applyMatrix4(_inv)

  // World capsule radius → local under non-uniform scale (conservative: min scale → larger local r).
  worldMatrix.decompose(_pos, _quat, _scale)
  const minS = Math.min(Math.abs(_scale.x), Math.abs(_scale.y), Math.abs(_scale.z))
  const localR = r / Math.max(minS, 1e-6)

  if (mesh === TRIGGER_MESH_SPHERE) {
    // Unit sphere radius 0.5 at local origin.
    const d2 = distSqPointSegment(0, 0, 0, _segA.x, _segA.y, _segA.z, _segB.x, _segB.y, _segB.z)
    const sumR = 0.5 + localR
    return d2 <= sumR * sumR + 1e-6
  }

  // Unit AABB [-0.5,0.5]^3 expanded by localR (segment vs Minkowski sum of box + sphere).
  const min = -0.5 - localR
  const max = 0.5 + localR
  return segmentIntersectsAabb(_segA, _segB, min, max)
}

/** Segment AB vs axis-aligned box [min,max]^3. */
function segmentIntersectsAabb(
  a: THREE.Vector3,
  b: THREE.Vector3,
  min: number,
  max: number
): boolean {
  if (pointInAabb(a, min, max) || pointInAabb(b, min, max)) return true

  let t0 = 0
  let t1 = 1
  const axes: [number, number][] = [
    [a.x, b.x - a.x],
    [a.y, b.y - a.y],
    [a.z, b.z - a.z]
  ]
  for (const [start, delta] of axes) {
    if (Math.abs(delta) < 1e-12) {
      if (start < min || start > max) return false
      continue
    }
    const inv = 1 / delta
    let tNear = (min - start) * inv
    let tFar = (max - start) * inv
    if (tNear > tFar) {
      const tmp = tNear
      tNear = tFar
      tFar = tmp
    }
    t0 = Math.max(t0, tNear)
    t1 = Math.min(t1, tFar)
    if (t0 > t1) return false
  }
  return true
}

function pointInAabb(p: THREE.Vector3, min: number, max: number): boolean {
  return p.x >= min && p.x <= max && p.y >= min && p.y <= max && p.z >= min && p.z <= max
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

/**
 * Explorer parity: **player CCT capsule** vs trigger volume (not a single bone/point).
 *
 * Prefer `feetDcl` from the CCT foot position. Falls back to PE position (PE is feet).
 * `playerTransform` is only used for PE fallback + result payloads.
 */
export function isPlayerInsideTriggerDcl(
  playerTransform: {
    position: { x: number; y: number; z: number }
    rotation: { x: number; y: number; z: number; w: number }
    scale: { x: number; y: number; z: number }
  },
  worldMatrix: THREE.Matrix4,
  mesh: number,
  _probeHeights: readonly number[] = PLAYER_PROBE_HEIGHTS_DCL,
  feetDcl?: { x: number; y: number; z: number } | null,
  capsuleRadius: number = PLAYER_CCT_RADIUS,
  capsuleHeight: number = PLAYER_CCT_HEIGHT
): boolean {
  const pe = playerTransform.position
  // PE Transform is feet (same as CCT soles).
  const feet = feetDcl ?? {
    x: pe.x,
    y: pe.y,
    z: pe.z
  }
  if (capsuleOverlapsTriggerMatrix(feet, worldMatrix, mesh, capsuleRadius, capsuleHeight)) {
    return true
  }
  // Legacy dense probes if capsule test fails near degenerate matrices (scale ~0).
  for (const h of PLAYER_PROBE_HEIGHTS_DCL) {
    _pos.set(feet.x, feet.y + h, feet.z)
    if (isPointInsideTriggerMatrix(_pos, worldMatrix, mesh)) return true
  }
  return false
}