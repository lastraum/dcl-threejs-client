import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'

const _world = new THREE.Vector3()
const _local = new THREE.Vector3()

/** Lowest VRM foot bone Y in avatar-root local space. */
export function measureVrmFeetY(vrm: VRM, avatarRoot: THREE.Object3D): number | null {
  avatarRoot.updateWorldMatrix(true, true)
  let lowest: number | null = null

  for (const boneName of ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'] as const) {
    const bone = vrm.humanoid.getNormalizedBoneNode(boneName)
    if (!bone) continue
    bone.getWorldPosition(_world)
    avatarRoot.worldToLocal(_world)
    _local.copy(_world)
    if (lowest === null || _local.y < lowest) lowest = _local.y
  }

  return lowest
}

export function applyVrmPivotOffset(pivot: THREE.Object3D, vrm: VRM, model: THREE.Object3D): void {
  const feetY = measureVrmFeetY(vrm, model)
  pivot.position.y = feetY !== null ? -feetY : 0
}