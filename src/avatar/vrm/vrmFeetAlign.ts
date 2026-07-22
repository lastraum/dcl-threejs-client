import * as THREE from 'three'
import { VRMHumanBoneName, type VRM } from '@pixiv/three-vrm'

const _world = new THREE.Vector3()
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

type VrmFootStance = {
  feetY: number
  /** Midpoint of left/right feet in avatar-root local XZ — CCT is at pivot origin. */
  centerX: number
  centerZ: number
}

/** Raw rig bones — locomotion animates these while autoUpdateHumanBones is false. */
function measureVrmFootBoneY(vrm: VRM, avatarRoot: THREE.Object3D): number | null {
  return measureVrmFootStance(vrm, avatarRoot)?.feetY ?? null
}

/**
 * Foot stance in avatar-root local space (Y = lowest sole contact, XZ = feet midpoint).
 * Custom VRMs often ship with hips/mesh offset from origin — without XZ centering the
 * body orbits the PhysX CCT and walks look off-axis.
 */
function measureVrmFootStance(vrm: VRM, avatarRoot: THREE.Object3D): VrmFootStance | null {
  const samples: THREE.Vector3[] = []

  for (const boneName of VRM_FOOT_BONE_NAMES) {
    const bone = vrm.humanoid.getRawBoneNode(boneName)
    if (!bone) continue
    bone.getWorldPosition(_world)
    avatarRoot.worldToLocal(_world)
    samples.push(_world.clone())
  }

  if (samples.length === 0) {
    avatarRoot.traverse((obj) => {
      if (!(obj instanceof THREE.Bone)) return
      const name = obj.name.replace(/\.\d+$/, '')
      if (!VRM_FOOT_BONE.test(name)) return
      obj.getWorldPosition(_world)
      avatarRoot.worldToLocal(_world)
      samples.push(_world.clone())
    })
  }

  if (samples.length === 0) {
    const hips = vrm.humanoid.getRawBoneNode(VRMHumanBoneName.Hips)
    if (hips) {
      hips.getWorldPosition(_world)
      avatarRoot.worldToLocal(_world)
      return { feetY: _world.y, centerX: _world.x, centerZ: _world.z }
    }
    return null
  }

  let sx = 0
  let sz = 0
  let lowest = samples[0]!.y
  for (const p of samples) {
    sx += p.x
    sz += p.z
    if (p.y < lowest) lowest = p.y
  }
  return {
    feetY: lowest,
    centerX: sx / samples.length,
    centerZ: sz / samples.length
  }
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
  // Offset goes on the *model* (child of yaw pivot), not the pivot.
  // Pivot only rotates (setYaw). If XZ/Y offset lives on the pivot, rotation turns
  // "behind" into world offset and the body sits above/behind the CCT.
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

  const stance = measureVrmFootStance(vrm, model)
  const boneY = stance?.feetY ?? null
  const boundsY = measureVrmWorldAabbMinY(model)
  let feetY = measureVrmFeetY(vrm, model)
  if (feetY !== null && Math.abs(feetY) > MAX_PIVOT_OFFSET) {
    console.warn('[vrm] feet pivot out of range — falling back to foot bones', { feetY, boneY, boundsY })
    feetY = boneY ?? boundsY
  }
  let centerX = stance?.centerX ?? 0
  let centerZ = stance?.centerZ ?? 0
  if (Math.hypot(centerX, centerZ) > MAX_PIVOT_OFFSET) {
    console.warn('[vrm] feet XZ pivot out of range — using origin', { centerX, centerZ })
    centerX = 0
    centerZ = 0
  }
  const modelY = feetY !== null ? -feetY : 0
  model.position.set(-centerX, modelY, -centerZ)
  console.info('[vrm] feet pivot applied', {
    measureActivePose: !!options?.measureActivePose,
    boneY,
    boundsY,
    feetY,
    centerX,
    centerZ,
    modelY
  })
}