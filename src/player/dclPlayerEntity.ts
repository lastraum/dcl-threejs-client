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
 * Not PlayerEntity chest (+0.88). Look-only RPCs may still send stale PE coords with
 * `avatarTarget` — keep live client feet when the destination is not a real move.
 *
 * @returns resolved **feet** in DCL scene space
 */
export function resolveMovePlayerToTargetFeetDcl(
  targetFeetDcl: THREE.Vector3,
  currentFeetDcl: THREE.Vector3,
  avatarTargetDcl: { x?: number; y?: number; z?: number } | undefined,
  out = new THREE.Vector3()
): THREE.Vector3 {
  out.copy(targetFeetDcl)
  if (!avatarTargetDcl) return out

  const avatarX = avatarTargetDcl.x ?? 0
  const avatarZ = avatarTargetDcl.z ?? 0
  _moveTargetFeet.copy(targetFeetDcl)
  _moveCurrentFeet.copy(currentFeetDcl)
  const currentHoriz = Math.hypot(_moveCurrentFeet.x - avatarX, _moveCurrentFeet.z - avatarZ)
  const targetHoriz = Math.hypot(_moveTargetFeet.x - avatarX, _moveTargetFeet.z - avatarZ)
  const poseHoriz = Math.hypot(
    targetFeetDcl.x - currentFeetDcl.x,
    targetFeetDcl.z - currentFeetDcl.z
  )

  // Sit / teleport — RPC destination is nearer the interact target than the live client.
  if (targetHoriz + 0.25 < currentHoriz) return out

  // Look-only with stale worker pose — RPC is farther from the target than we already are.
  if (targetHoriz > currentHoriz + 0.5) {
    out.copy(currentFeetDcl)
    return out
  }

  // Large horizontal mismatch while not moving toward the target (walked since last worker sync).
  if (poseHoriz > 1 && targetHoriz >= currentHoriz) {
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