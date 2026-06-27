import * as THREE from 'three'
import { VRMHumanBoneName, type VRM } from '@pixiv/three-vrm'

const _world = new THREE.Vector3()
const _local = new THREE.Vector3()
const _box = new THREE.Box3()

const VRM_FOOT_BONE = /foot|toe/i
/** Mesh AABB can include capes/hair far below soles — ignore outlier sole samples. */
const MAX_SOLE_DROP_BELOW_BONE = 0.22
const MAX_PIVOT_OFFSET = 2.5

function mergeFootContactY(boneY: number | null, soleY: number | null): number | null {
  if (boneY === null) return soleY
  if (soleY === null) return boneY
  if (soleY < boneY - MAX_SOLE_DROP_BELOW_BONE) return boneY
  if (soleY > boneY + 0.05) return boneY
  return Math.min(boneY, soleY)
}

const VRM_FOOT_BONE_NAMES = [
  VRMHumanBoneName.LeftFoot,
  VRMHumanBoneName.RightFoot,
  VRMHumanBoneName.LeftToes,
  VRMHumanBoneName.RightToes
] as const

/** Raw rig bones — locomotion animates these while autoUpdateHumanBones is false. */
function measureVrmFootBoneY(vrm: VRM, avatarRoot: THREE.Object3D): number | null {
  let lowest: number | null = null

  for (const boneName of VRM_FOOT_BONE_NAMES) {
    const bone = vrm.humanoid.getRawBoneNode(boneName)
    if (!bone) continue
    bone.getWorldPosition(_world)
    avatarRoot.worldToLocal(_world)
    _local.copy(_world)
    if (lowest === null || _local.y < lowest) lowest = _local.y
  }

  if (lowest !== null) return lowest

  avatarRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Bone)) return
    const name = obj.name.replace(/\.\d+$/, '')
    if (!VRM_FOOT_BONE.test(name)) return
    obj.getWorldPosition(_world)
    avatarRoot.worldToLocal(_world)
    if (lowest === null || _world.y < lowest) lowest = _world.y
  })

  return lowest
}

/** World AABB floor — catches posed mesh when bone aliases are missing. */
function measureVrmWorldAabbMinY(avatarRoot: THREE.Object3D): number | null {
  avatarRoot.updateWorldMatrix(true, true)
  _box.setFromObject(avatarRoot)
  if (_box.isEmpty()) return null

  let lowest: number | null = null
  const xs = [_box.min.x, _box.max.x] as const
  const zs = [_box.min.z, _box.max.z] as const
  for (const x of xs) {
    for (const z of zs) {
      _world.set(x, _box.min.y, z)
      avatarRoot.worldToLocal(_world)
      if (lowest === null || _world.y < lowest) lowest = _world.y
    }
  }
  return lowest
}

/** Lowest skinned sole Y — foot bones often sit above the visible shoe sole. */
function measureVrmSkinnedSoleY(avatarRoot: THREE.Object3D): number | null {
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

/** Reset VRM to bind pose before feet measurement (locomotion idle skews soles). */
export function prepareVrmForFeetMeasure(vrm: VRM, avatarRoot: THREE.Object3D): void {
  vrm.humanoid.resetNormalizedPose()
  avatarRoot.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh) || !obj.skeleton) return
    obj.skeleton.pose()
    obj.skeleton.update()
  })
  avatarRoot.updateWorldMatrix(true, true)
}

/** Lowest VRM foot contact Y in avatar-root local space. */
export function measureVrmFeetY(vrm: VRM, avatarRoot: THREE.Object3D): number | null {
  avatarRoot.updateWorldMatrix(true, true)
  const boneY = measureVrmFootBoneY(vrm, avatarRoot)
  const soleY = measureVrmSkinnedSoleY(avatarRoot)
  const meshY = mergeFootContactY(boneY, soleY)
  const boundsY = measureVrmWorldAabbMinY(avatarRoot)

  if (meshY === null) return boundsY
  if (boundsY === null) return meshY
  if (boundsY < meshY - MAX_SOLE_DROP_BELOW_BONE) return meshY
  if (boundsY > meshY + 0.05) return meshY
  return Math.min(meshY, boundsY)
}

export type VrmPivotOptions = {
  /** Measure the active pose (e.g. locomotion idle) instead of resetting to bind pose. */
  measureActivePose?: boolean
}

export function applyVrmPivotOffset(
  pivot: THREE.Object3D,
  vrm: VRM,
  model: THREE.Object3D,
  options?: VrmPivotOptions
): void {
  pivot.position.set(0, 0, 0)
  model.position.set(0, 0, 0)
  if (options?.measureActivePose) {
    model.updateWorldMatrix(true, true)
    model.traverse((obj) => {
      if (obj instanceof THREE.SkinnedMesh && obj.skeleton) obj.skeleton.update()
    })
  } else {
    prepareVrmForFeetMeasure(vrm, model)
  }

  const boneY = measureVrmFootBoneY(vrm, model)
  const boundsY = measureVrmWorldAabbMinY(model)
  let feetY = measureVrmFeetY(vrm, model)
  if (feetY !== null && Math.abs(feetY) > MAX_PIVOT_OFFSET) {
    console.warn('[vrm] feet pivot out of range — falling back to foot bones', { feetY, boneY, boundsY })
    feetY = boneY ?? boundsY
  }
  const pivotY = feetY !== null ? -feetY : 0
  pivot.position.y = pivotY
  console.info('[vrm] feet pivot applied', {
    measureActivePose: !!options?.measureActivePose,
    boneY,
    boundsY,
    feetY,
    pivotY
  })
}