import * as THREE from 'three'
import type { DclTransformValues } from '../bridge/dclTransform'
import {
  applyDclLocalTransform,
  dclToThreePos,
  dclToThreeQuat,
  threeToDclPos,
  threeToDclQuat
} from '../bridge/dclTransform'

const _playerPos = new THREE.Vector3()
const _playerQuat = new THREE.Quaternion()
const _playerScale = new THREE.Vector3(1, 1, 1)
const _playerMat = new THREE.Matrix4()
const _relativeQuat = new THREE.Quaternion()

export type AvatarAttachRelativeTransform = DclTransformValues

/** Build player world matrix from DCL Transform (feet / PlayerEntity). */
export function playerMatrixFromDclTransform(player: DclTransformValues): THREE.Matrix4 {
  dclToThreePos(player.position.x, player.position.y, player.position.z, _playerPos)
  dclToThreeQuat(player.rotation.x, player.rotation.y, player.rotation.z, player.rotation.w, _playerQuat)
  _playerScale.set(player.scale.x, player.scale.y, player.scale.z)
  return _playerMat.compose(_playerPos, _playerQuat, _playerScale)
}

const _peQ = new THREE.Quaternion()
const _boneQ = new THREE.Quaternion()
const _invPeQ = new THREE.Quaternion()
const _dclDelta = new THREE.Vector3()

/**
 * Anchor world (Three.js display) → avatar-relative **DCL** Transform.
 *
 * SDK `getWorldPosition` (`Fle` / `iBe`): AvatarAttach entities compose
 * `world = PE × local` in DCL space (no parent walk). Inverse must use that
 * product. Three-display invert + component convert is not the same — rod
 * tip (`I5e` + `$m`) misses the hand.
 */
export function anchorWorldToRelativeTransform(
  player: DclTransformValues,
  anchorPosition: THREE.Vector3,
  anchorQuaternion: THREE.Quaternion,
  existing?: DclTransformValues
): AvatarAttachRelativeTransform {
  threeToDclPos(anchorPosition.x, anchorPosition.y, anchorPosition.z, _dclDelta)
  threeToDclQuat(anchorQuaternion, _boneQ)
  _peQ.set(player.rotation.x, player.rotation.y, player.rotation.z, player.rotation.w)
  _invPeQ.copy(_peQ).invert()
  _dclDelta.x -= player.position.x
  _dclDelta.y -= player.position.y
  _dclDelta.z -= player.position.z
  _dclDelta.applyQuaternion(_invPeQ)
  _relativeQuat.copy(_invPeQ).multiply(_boneQ)

  return {
    position: { x: _dclDelta.x, y: _dclDelta.y, z: _dclDelta.z },
    rotation: {
      x: _relativeQuat.x,
      y: _relativeQuat.y,
      z: _relativeQuat.z,
      w: _relativeQuat.w
    },
    scale: existing?.scale ?? { x: 1, y: 1, z: 1 },
    parent: existing?.parent
  }
}

/** Compose player + avatar-relative → world DCL Transform (SDK `iBe`). */
export function composeAvatarAttachedWorldTransform(
  player: DclTransformValues,
  relative: DclTransformValues
): DclTransformValues {
  _peQ.set(player.rotation.x, player.rotation.y, player.rotation.z, player.rotation.w)
  _dclDelta.set(relative.position.x, relative.position.y, relative.position.z)
  _dclDelta.applyQuaternion(_peQ)
  _relativeQuat
    .set(relative.rotation.x, relative.rotation.y, relative.rotation.z, relative.rotation.w)
  _boneQ.copy(_peQ).multiply(_relativeQuat)
  return {
    position: {
      x: player.position.x + _dclDelta.x,
      y: player.position.y + _dclDelta.y,
      z: player.position.z + _dclDelta.z
    },
    rotation: { x: _boneQ.x, y: _boneQ.y, z: _boneQ.z, w: _boneQ.w },
    scale: { x: relative.scale.x, y: relative.scale.y, z: relative.scale.z },
    parent: relative.parent
  }
}

/** Apply composed world pose to a store node (entity parent chain unchanged). */
export function applyWorldDclTransformToObject(obj: THREE.Object3D, world: DclTransformValues): void {
  applyDclLocalTransform(obj, world)
}