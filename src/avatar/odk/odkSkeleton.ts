import * as THREE from 'three'

/** Locomotion-critical ODK / UE5 mannequin bones. */
export const ODK_REQUIRED_BONES = [
  'pelvis',
  'spine_01',
  'spine_02',
  'spine_03',
  'spine_04',
  'spine_05',
  'neck_01',
  'neck_02',
  'head',
  'clavicle_l',
  'upperarm_l',
  'lowerarm_l',
  'hand_l',
  'clavicle_r',
  'upperarm_r',
  'lowerarm_r',
  'hand_r',
  'thigh_l',
  'calf_l',
  'foot_l',
  'ball_l',
  'thigh_r',
  'calf_r',
  'foot_r',
  'ball_r'
] as const

export type OdkBoneName = (typeof ODK_REQUIRED_BONES)[number]

const IK_PREFIX = 'ik_'

export function collectBoneNames(root: THREE.Object3D): Set<string> {
  const names = new Set<string>()
  root.traverse((obj) => {
    if (obj.name) names.add(obj.name)
  })
  return names
}

export function validateOdkSkeleton(root: THREE.Object3D): { ok: true } | { ok: false; missing: string[] } {
  const names = collectBoneNames(root)
  const missing = ODK_REQUIRED_BONES.filter((b) => !names.has(b))
  if (missing.length) return { ok: false, missing: [...missing] }
  return { ok: true }
}

export function getOdkBone(root: THREE.Object3D, boneName: string): THREE.Object3D | null {
  return root.getObjectByName(boneName) ?? null
}

export function isOdkAnimatableBone(name: string): boolean {
  return !name.startsWith(IK_PREFIX) && name !== 'interaction' && name !== 'center_of_mass'
}

/** Bones frozen to bind pose while standing idle (no lower-body idle sway). */
export const ODK_LEG_BIND_BONES = [
  'pelvis',
  'thigh_l',
  'thigh_r',
  'calf_l',
  'calf_r',
  'foot_l',
  'foot_r',
  'ball_l',
  'ball_r',
  'thigh_twist_01_l',
  'thigh_twist_02_l',
  'calf_twist_01_l',
  'calf_twist_02_l',
  'thigh_twist_01_r',
  'thigh_twist_02_r',
  'calf_twist_01_r',
  'calf_twist_02_r'
] as const

export function captureOdkBindQuaternions(root: THREE.Object3D): Map<string, THREE.Quaternion> {
  const map = new Map<string, THREE.Quaternion>()
  for (const name of ODK_LEG_BIND_BONES) {
    const bone = getOdkBone(root, name)
    if (bone) map.set(name, bone.quaternion.clone())
  }
  return map
}

/** All animatable bone locals — used to freeze full bind pose while standing. */
export function captureOdkFullBindQuaternions(root: THREE.Object3D): Map<string, THREE.Quaternion> {
  const map = new Map<string, THREE.Quaternion>()
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Bone)) return
    if (!isOdkAnimatableBone(obj.name)) return
    map.set(obj.name, obj.quaternion.clone())
  })
  return map
}

export function applyOdkBindPose(
  root: THREE.Object3D,
  bindQuats: Map<string, THREE.Quaternion>
): void {
  for (const [name, q] of bindQuats) {
    const bone = getOdkBone(root, name)
    if (bone) bone.quaternion.copy(q)
  }
  root.updateWorldMatrix(true, true)
  updateOdkSkinnedMeshes(root)
}

export function applyOdkLegBindPose(root: THREE.Object3D, bindQuats: Map<string, THREE.Quaternion>): void {
  applyOdkBindPose(root, bindQuats)
}

export function updateOdkSkinnedMeshes(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh) obj.skeleton.update()
  })
}

export function extractPelvisHeightMeters(root: THREE.Object3D): number {
  const pelvis = getOdkBone(root, 'pelvis')
  if (!pelvis) return 1
  root.updateWorldMatrix(true, true)
  return pelvis.getWorldPosition(new THREE.Vector3()).y
}