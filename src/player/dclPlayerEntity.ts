import * as THREE from 'three'
import { dclToThreeVec, threeToDclVec } from '../bridge/dclTransform'

/**
 * SDK7 `Transform.get(engine.PlayerEntity).position` — chest height, not feet.
 * @see https://docs.decentraland.org/creator/scenes-sdk7/interactivity/user-data.md
 */
export const DCL_PLAYER_ENTITY_Y_OFFSET = 0.88

/** Feet (capsule root) → scene-relative PlayerEntity position in DCL space. */
export function feetDclToPlayerEntityPosition(feetDcl: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(feetDcl.x, feetDcl.y + DCL_PLAYER_ENTITY_Y_OFFSET, feetDcl.z)
}

/** PlayerEntity position → capsule feet in DCL space (inverse of kernel write). */
export function playerEntityPositionToFeetDcl(playerEntityDcl: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(playerEntityDcl.x, playerEntityDcl.y - DCL_PLAYER_ENTITY_Y_OFFSET, playerEntityDcl.z)
}

export function playerEntityPositionFromThreeFeet(feetThree: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return feetDclToPlayerEntityPosition(threeToDclVec(feetThree), out)
}

export function feetThreeFromPlayerEntityDcl(playerEntityDcl: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return dclToThreeVec(playerEntityPositionToFeetDcl(playerEntityDcl), out)
}

export function dclPlayerEntityPositionsEqual(a: THREE.Vector3, b: THREE.Vector3): boolean {
  return (
    Math.abs(a.x - b.x) <= 1e-4 &&
    Math.abs(a.y - b.y) <= 1e-4 &&
    Math.abs(a.z - b.z) <= 1e-4
  )
}

const _moveTargetFeet = new THREE.Vector3()
const _moveCurrentFeet = new THREE.Vector3()

/**
 * `RestrictedActions.movePlayerTo.newRelativePosition` is **feet** (docs use y=0 on ground).
 * Trust the scene's authored target — sit/stool seats break when client "corrects" pose.
 * Only treat near-zero horizontal delta as look-only (no reposition).
 *
 * @returns resolved **feet** in DCL scene space
 */
export function resolveMovePlayerToTargetFeetDcl(
  targetFeetDcl: THREE.Vector3,
  currentFeetDcl: THREE.Vector3,
  _avatarTargetDcl: { x?: number; y?: number; z?: number } | undefined,
  out = new THREE.Vector3()
): THREE.Vector3 {
  out.copy(targetFeetDcl)
  const poseHoriz = Math.hypot(
    targetFeetDcl.x - currentFeetDcl.x,
    targetFeetDcl.z - currentFeetDcl.z
  )
  const poseVert = Math.abs(targetFeetDcl.y - currentFeetDcl.y)
  // Pure look-only (no seat move) — keep feet; still apply avatarTarget rotation separately.
  if (poseHoriz < 0.04 && poseVert < 0.08) {
    out.copy(currentFeetDcl)
  }
  return out
}

/**
 * @deprecated Use `resolveMovePlayerToTargetFeetDcl` — movePlayerTo coords are feet, not PE.
 */
export function resolveMovePlayerToTargetPlayerEntity(
  targetPlayerEntityDcl: THREE.Vector3,
  currentPlayerEntityDcl: THREE.Vector3,
  avatarTargetDcl: { x?: number; y?: number; z?: number } | undefined,
  out = new THREE.Vector3()
): THREE.Vector3 {
  const targetFeet = playerEntityPositionToFeetDcl(targetPlayerEntityDcl, _moveTargetFeet)
  const currentFeet = playerEntityPositionToFeetDcl(currentPlayerEntityDcl, _moveCurrentFeet)
  const feet = resolveMovePlayerToTargetFeetDcl(targetFeet, currentFeet, avatarTargetDcl)
  return feetDclToPlayerEntityPosition(feet, out)
}