import * as THREE from 'three'
import { getOdkBone } from './odkSkeleton'

const _world = new THREE.Vector3()
const _local = new THREE.Vector3()
const _box = new THREE.Box3()

/** Lowest ODK foot bone Y in avatar-root local space. */
function measureOdkFootBoneY(avatarRoot: THREE.Object3D): number | null {
  let lowest: number | null = null

  for (const boneName of ['foot_l', 'foot_r', 'ball_l', 'ball_r']) {
    const bone = getOdkBone(avatarRoot, boneName)
    if (!bone) continue
    bone.getWorldPosition(_world)
    avatarRoot.worldToLocal(_world)
    _local.copy(_world)
    if (lowest === null || _local.y < lowest) lowest = _local.y
  }

  return lowest
}

/**
 * Lowest skinned sole Y in avatar-root local space.
 * ODK foot bones sit above the visible sole; mesh bounds track ground contact better.
 */
function measureOdkSkinnedSoleY(avatarRoot: THREE.Object3D): number | null {
  let lowest: number | null = null

  avatarRoot.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh)) return
    obj.skeleton?.update()
    _box.setFromObject(obj)
    if (_box.isEmpty()) return
    _world.set(_box.min.x, _box.min.y, _box.min.z)
    avatarRoot.worldToLocal(_world)
    if (lowest === null || _world.y < lowest) lowest = _world.y
  })

  return lowest
}

const MAX_SOLE_DROP_BELOW_BONE = 0.22

function mergeFootContactY(boneY: number | null, soleY: number | null): number | null {
  if (boneY === null) return soleY
  if (soleY === null) return boneY
  if (soleY < boneY - MAX_SOLE_DROP_BELOW_BONE) return boneY
  if (soleY > boneY + 0.05) return boneY
  return Math.min(boneY, soleY)
}

/** Lowest foot contact Y — min of foot bones and skinned sole bounds. */
export function measureOdkFeetY(avatarRoot: THREE.Object3D): number | null {
  avatarRoot.updateWorldMatrix(true, true)
  const boneY = measureOdkFootBoneY(avatarRoot)
  const soleY = measureOdkSkinnedSoleY(avatarRoot)
  return mergeFootContactY(boneY, soleY)
}

export function applyOdkPivotOffset(pivot: THREE.Object3D, model: THREE.Object3D): void {
  pivot.position.set(0, 0, 0)
  model.position.set(0, 0, 0)
  const feetY = measureOdkFeetY(model)
  pivot.position.y = feetY !== null ? -feetY : 0
}