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
const _playerInv = new THREE.Matrix4()
const _anchorPos = new THREE.Vector3()
const _anchorQuat = new THREE.Quaternion()
const _anchorScale = new THREE.Vector3(1, 1, 1)
const _anchorMat = new THREE.Matrix4()
const _relativeMat = new THREE.Matrix4()
const _worldMat = new THREE.Matrix4()
const _relativePos = new THREE.Vector3()
const _relativeQuat = new THREE.Quaternion()
const _relativeScale = new THREE.Vector3()
const _worldPos = new THREE.Vector3()
const _worldQuat = new THREE.Quaternion()
const _worldScale = new THREE.Vector3()

export type AvatarAttachRelativeTransform = DclTransformValues

/** Build player world matrix from DCL Transform (feet / PlayerEntity). */
export function playerMatrixFromDclTransform(player: DclTransformValues): THREE.Matrix4 {
  dclToThreePos(player.position.x, player.position.y, player.position.z, _playerPos)
  dclToThreeQuat(player.rotation.x, player.rotation.y, player.rotation.z, player.rotation.w, _playerQuat)
  _playerScale.set(player.scale.x, player.scale.y, player.scale.z)
  return _playerMat.compose(_playerPos, _playerQuat, _playerScale)
}

/**
 * Anchor world (Three.js) → avatar-relative DCL Transform (SDK parity).
 * relative such that: playerWorld * relative ≈ anchorWorld
 */
export function anchorWorldToRelativeTransform(
  player: DclTransformValues,
  anchorPosition: THREE.Vector3,
  anchorQuaternion: THREE.Quaternion,
  existing?: DclTransformValues
): AvatarAttachRelativeTransform {
  playerMatrixFromDclTransform(player)
  _playerInv.copy(_playerMat).invert()

  _anchorPos.copy(anchorPosition)
  _anchorQuat.copy(anchorQuaternion)
  _anchorMat.compose(_anchorPos, _anchorQuat, _anchorScale)

  _relativeMat.multiplyMatrices(_playerInv, _anchorMat)
  _relativeMat.decompose(_relativePos, _relativeQuat, _relativeScale)

  const dclPos = threeToDclPos(_relativePos.x, _relativePos.y, _relativePos.z, new THREE.Vector3())
  const dclRot = threeToDclQuat(_relativeQuat, new THREE.Quaternion())

  return {
    position: { x: dclPos.x, y: dclPos.y, z: dclPos.z },
    rotation: { x: dclRot.x, y: dclRot.y, z: dclRot.z, w: dclRot.w },
    scale: existing?.scale ?? { x: 1, y: 1, z: 1 },
    parent: existing?.parent
  }
}

/** Compose player + avatar-relative → world DCL Transform. */
export function composeAvatarAttachedWorldTransform(
  player: DclTransformValues,
  relative: DclTransformValues
): DclTransformValues {
  playerMatrixFromDclTransform(player)
  dclToThreePos(relative.position.x, relative.position.y, relative.position.z, _relativePos)
  dclToThreeQuat(relative.rotation.x, relative.rotation.y, relative.rotation.z, relative.rotation.w, _relativeQuat)
  _relativeScale.set(relative.scale.x, relative.scale.y, relative.scale.z)
  _relativeMat.compose(_relativePos, _relativeQuat, _relativeScale)
  _worldMat.multiplyMatrices(_playerMat, _relativeMat)
  _worldMat.decompose(_worldPos, _worldQuat, _worldScale)

  const dclPos = threeToDclPos(_worldPos.x, _worldPos.y, _worldPos.z, new THREE.Vector3())
  const dclRot = threeToDclQuat(_worldQuat, new THREE.Quaternion())
  return {
    position: { x: dclPos.x, y: dclPos.y, z: dclPos.z },
    rotation: { x: dclRot.x, y: dclRot.y, z: dclRot.z, w: dclRot.w },
    scale: { x: _worldScale.x, y: _worldScale.y, z: _worldScale.z },
    parent: relative.parent
  }
}

/** Apply composed world pose to a store node (entity parent chain unchanged). */
export function applyWorldDclTransformToObject(obj: THREE.Object3D, world: DclTransformValues): void {
  applyDclLocalTransform(obj, world)
}