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

function measureOdkFootStance(avatarRoot: THREE.Object3D): {
  feetY: number
  centerX: number
  centerZ: number
} | null {
  const samples: THREE.Vector3[] = []
  for (const boneName of ['foot_l', 'foot_r', 'ball_l', 'ball_r']) {
    const bone = getOdkBone(avatarRoot, boneName)
    if (!bone) continue
    bone.getWorldPosition(_world)
    avatarRoot.worldToLocal(_world)
    samples.push(_world.clone())
  }
  if (samples.length === 0) return null
  let sx = 0
  let sz = 0
  let lowest = samples[0]!.y
  for (const p of samples) {
    sx += p.x
    sz += p.z
    if (p.y < lowest) lowest = p.y
  }
  return { feetY: lowest, centerX: sx / samples.length, centerZ: sz / samples.length }
}

export function applyOdkPivotOffset(pivot: THREE.Object3D, model: THREE.Object3D): void {
  // Offset on model, not pivot — same as VRM/DCL (pivot is pure yaw for setYaw).
  pivot.position.set(0, 0, 0)
  model.position.set(0, 0, 0)
  const stance = measureOdkFootStance(model)
  const feetY = measureOdkFeetY(model)
  const y = feetY !== null ? -feetY : stance ? -stance.feetY : 0
  const cx = stance?.centerX ?? 0
  const cz = stance?.centerZ ?? 0
  model.position.set(-cx, y, -cz)
}