import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import { measureAvatarFeetY } from './feetAlign'
import { measureOdkFeetY } from './odk/odkFeetAlign'
import { measureVrmFeetY, prepareVrmForFeetMeasure } from './vrm/vrmFeetAlign'
import type { CustomAvatarFormat } from './vrm/constants'

const _box = new THREE.Box3()
const _center = new THREE.Vector3()
const _size = new THREE.Vector3()

/** Place preview root so soles sit on y=0 and return subject size for camera framing. */
export function alignPreviewAvatarToGround(
  root: THREE.Object3D,
  format: CustomAvatarFormat | 'dcl',
  vrm?: VRM
): THREE.Vector3 {
  root.position.set(0, 0, 0)
  root.updateWorldMatrix(true, true)

  let feetY: number | null = null
  if (format === 'vrm' && vrm) {
    prepareVrmForFeetMeasure(vrm, root)
    feetY = measureVrmFeetY(vrm, root)
  } else if (format === 'odk') {
    feetY = measureOdkFeetY(root)
  } else {
    feetY = measureAvatarFeetY(root)
  }

  _box.setFromObject(root)
  if (_box.isEmpty()) return new THREE.Vector3(0.9, 1.8, 0.5)

  _box.getCenter(_center)
  const groundY = feetY ?? _box.min.y
  root.position.set(-_center.x, -groundY, -_center.z)
  root.updateWorldMatrix(true, true)

  _box.setFromObject(root)
  _box.getSize(_size)
  _size.y += 0.12
  _size.x = Math.max(_size.x, 0.85)
  _size.z = Math.max(_size.z, 0.4)
  return _size.clone()
}