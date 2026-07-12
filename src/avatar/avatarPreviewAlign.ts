import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import { measureAvatarStance } from './feetAlign'
import { measureOdkFeetY } from './odk/odkFeetAlign'
import { measureVrmFeetY, prepareVrmForFeetMeasure } from './vrm/vrmFeetAlign'
import type { CustomAvatarFormat } from './vrm/constants'

const _box = new THREE.Box3()
const _center = new THREE.Vector3()
const _size = new THREE.Vector3()

/**
 * Place preview root so soles sit on y=0 and the stance (feet midpoint) sits on
 * the origin — not mesh AABB, which props skew off the ground disc.
 */
export function alignPreviewAvatarToGround(
  root: THREE.Object3D,
  format: CustomAvatarFormat | 'dcl',
  vrm?: VRM
): THREE.Vector3 {
  // Parent pivot should be at identity for measurement (caller restores yaw after).
  root.position.set(0, 0, 0)
  root.rotation.set(0, 0, 0)
  root.scale.set(1, 1, 1)
  root.updateWorldMatrix(true, true)

  let centerX = 0
  let centerZ = 0
  let groundY: number | null = null

  if (format === 'vrm' && vrm) {
    prepareVrmForFeetMeasure(vrm, root)
    groundY = measureVrmFeetY(vrm, root)
    // VRM: fall back to AABB for XZ if no stance bones
    _box.setFromObject(root)
    if (!_box.isEmpty()) {
      _box.getCenter(_center)
      centerX = _center.x
      centerZ = _center.z
    }
  } else if (format === 'odk') {
    groundY = measureOdkFeetY(root)
    _box.setFromObject(root)
    if (!_box.isEmpty()) {
      _box.getCenter(_center)
      centerX = _center.x
      centerZ = _center.z
    }
  } else {
    const stance = measureAvatarStance(root)
    if (stance) {
      groundY = stance.feetY
      centerX = stance.centerX
      centerZ = stance.centerZ
    } else {
      _box.setFromObject(root)
      if (!_box.isEmpty()) {
        _box.getCenter(_center)
        groundY = _box.min.y
        centerX = _center.x
        centerZ = _center.z
      }
    }
  }

  _box.setFromObject(root)
  if (_box.isEmpty() && groundY === null) return new THREE.Vector3(0.9, 1.8, 0.5)

  if (groundY === null) groundY = _box.min.y
  root.position.set(-centerX, -groundY, -centerZ)
  root.updateWorldMatrix(true, true)

  // Second pass after translation (stance re-measure for DCL idle bones).
  if (format === 'dcl') {
    const stance2 = measureAvatarStance(root)
    if (stance2) {
      root.position.x -= stance2.centerX
      root.position.z -= stance2.centerZ
      root.position.y -= stance2.feetY
      root.updateWorldMatrix(true, true)
    }
  } else {
    _box.setFromObject(root)
    if (!_box.isEmpty()) {
      _box.getCenter(_center)
      root.position.x -= _center.x
      root.position.z -= _center.z
      if (_box.min.y !== 0) root.position.y -= _box.min.y
      root.updateWorldMatrix(true, true)
    }
  }

  _box.setFromObject(root)
  _box.getSize(_size)
  _size.y += 0.12
  _size.x = Math.max(_size.x, 0.85)
  _size.z = Math.max(_size.z, 0.4)
  return _size.clone()
}
