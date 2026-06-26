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