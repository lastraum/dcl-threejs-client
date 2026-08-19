import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import { normalizeBoneName, resolveBoneName } from './emoteBoneMap'
import { findHeadBone, NAME_TAG_HEAD_OFFSET_Y } from './headAnchor'

/** Mixamo / DCL short name → VRM humanoid key (same map as mixamo retarget). */
const MIXAMO_TO_VRM: Record<string, string> = {
  Head: 'head',
  Neck: 'neck',
  Hips: 'hips',
  LeftHand: 'leftHand',
  RightHand: 'rightHand',
  LeftHandIndex1: 'leftIndexProximal',
  RightHandIndex1: 'rightIndexProximal',
  LeftShoulder: 'leftShoulder',
  RightShoulder: 'rightShoulder',
  LeftArm: 'leftUpperArm',
  RightArm: 'rightUpperArm',
  LeftForeArm: 'leftLowerArm',
  RightForeArm: 'rightLowerArm'
}

const MIXAMO_TO_ODK: Record<string, string> = {
  Head: 'head',
  Neck: 'neck_01',
  Hips: 'pelvis',
  LeftHand: 'hand_l',
  RightHand: 'hand_r',
  LeftHandIndex1: 'hand_l',
  RightHandIndex1: 'hand_r'
}

/** Matches `@dcl/ecs` AvatarAnchorPointType numeric ids. */
export const AAPT_NAME_TAG = 1
export const AAPT_LEFT_HAND = 2
export const AAPT_RIGHT_HAND = 3
export const AAPT_HEAD = 4
export const AAPT_NECK = 5
export const AAPT_SPINE = 6
export const AAPT_SPINE1 = 7
export const AAPT_SPINE2 = 8
export const AAPT_HIP = 9
export const AAPT_LEFT_SHOULDER = 10
export const AAPT_LEFT_ARM = 11
export const AAPT_LEFT_FOREARM = 12
export const AAPT_LEFT_HAND_INDEX = 13
export const AAPT_RIGHT_SHOULDER = 14
export const AAPT_RIGHT_ARM = 15
export const AAPT_RIGHT_FOREARM = 16
export const AAPT_RIGHT_HAND_INDEX = 17
export const AAPT_LEFT_UP_LEG = 18
export const AAPT_LEFT_LEG = 19
export const AAPT_LEFT_FOOT = 20
export const AAPT_LEFT_TOE_BASE = 21
export const AAPT_RIGHT_UP_LEG = 22
export const AAPT_RIGHT_LEG = 23
export const AAPT_RIGHT_FOOT = 24
export const AAPT_RIGHT_TOE_BASE = 25

const ANCHOR_BONE_ALIASES: Record<number, string[]> = {
  [AAPT_HEAD]: ['Head'],
  [AAPT_NECK]: ['Neck'],
  [AAPT_SPINE]: ['Spine'],
  [AAPT_SPINE1]: ['Spine1'],
  [AAPT_SPINE2]: ['Spine2'],
  [AAPT_HIP]: ['Hips'],
  [AAPT_LEFT_SHOULDER]: ['LeftShoulder'],
  [AAPT_LEFT_ARM]: ['LeftArm'],
  [AAPT_LEFT_FOREARM]: ['LeftForeArm'],
  [AAPT_LEFT_HAND]: ['LeftHand'],
  [AAPT_LEFT_HAND_INDEX]: ['LeftHandIndex1', 'LeftHand'],
  [AAPT_RIGHT_SHOULDER]: ['RightShoulder'],
  [AAPT_RIGHT_ARM]: ['RightArm'],
  [AAPT_RIGHT_FOREARM]: ['RightForeArm'],
  [AAPT_RIGHT_HAND]: ['RightHand'],
  [AAPT_RIGHT_HAND_INDEX]: ['RightHandIndex1', 'RightHand'],
  [AAPT_LEFT_UP_LEG]: ['LeftUpLeg'],
  [AAPT_LEFT_LEG]: ['LeftLeg'],
  [AAPT_LEFT_FOOT]: ['LeftFoot'],
  [AAPT_LEFT_TOE_BASE]: ['LeftToeBase'],
  [AAPT_RIGHT_UP_LEG]: ['RightUpLeg'],
  [AAPT_RIGHT_LEG]: ['RightLeg'],
  [AAPT_RIGHT_FOOT]: ['RightFoot'],
  [AAPT_RIGHT_TOE_BASE]: ['RightToeBase']
}

const _boneWorldPos = new THREE.Vector3()
const _boneWorldQuat = new THREE.Quaternion()
const _headWorld = new THREE.Vector3()

export type AvatarAttachAnchorPose = {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}

function collectNamedNodes(model: THREE.Object3D): Map<string, THREE.Object3D> {
  const byName = new Map<string, THREE.Object3D>()
  model.traverse((obj) => {
    if (obj.name) byName.set(normalizeBoneName(obj.name), obj)
    if (obj instanceof THREE.SkinnedMesh && obj.skeleton) {
      for (const bone of obj.skeleton.bones) {
        if (bone.name) byName.set(normalizeBoneName(bone.name), bone)
      }
    }
  })
  return byName
}

function findVrmOnModel(model: THREE.Object3D): VRM | null {
  let node: THREE.Object3D | null = model
  while (node) {
    const vrm = (node.userData as { vrm?: VRM }).vrm
    if (vrm?.humanoid) return vrm
    node = node.parent
  }
  let found: VRM | null = null
  model.traverse((obj) => {
    if (found) return
    const vrm = (obj.userData as { vrm?: VRM }).vrm
    if (vrm?.humanoid) found = vrm
  })
  return found
}

function findAnchorBone(model: THREE.Object3D, aliases: string[]): THREE.Object3D | null {
  const named = collectNamedNodes(model)
  const bones = new Set(named.keys())
  for (const alias of aliases) {
    const resolved = resolveBoneName(alias, bones)
    if (resolved) {
      const hit = named.get(resolved)
      if (hit) return hit
    }
    const odk = MIXAMO_TO_ODK[alias]
    if (odk && named.has(odk)) return named.get(odk)!
    const vrmKey = MIXAMO_TO_VRM[alias]
    const vrm = vrmKey ? findVrmOnModel(model) : null
    if (vrm && vrmKey) {
      const node =
        vrm.humanoid.getNormalizedBoneNode(vrmKey as never) ??
        vrm.humanoid.getRawBoneNode(vrmKey as never)
      if (node) return node
    }
  }
  return null
}

/** Resolve anchor world pose for a composed avatar model (post-mixer update). */
export function sampleAvatarAttachAnchor(
  model: THREE.Object3D,
  anchorPointId: number,
  nameTagAnchor?: THREE.Object3D | null
): AvatarAttachAnchorPose | null {
  if (anchorPointId === AAPT_NAME_TAG) {
    if (nameTagAnchor) {
      nameTagAnchor.updateWorldMatrix(true, false)
      nameTagAnchor.getWorldPosition(_boneWorldPos)
      nameTagAnchor.getWorldQuaternion(_boneWorldQuat)
      return {
        position: _boneWorldPos.clone(),
        quaternion: _boneWorldQuat.clone()
      }
    }
    const head = findHeadBone(model)
    if (!head) return null
    model.updateWorldMatrix(true, false)
    head.getWorldPosition(_headWorld)
    _boneWorldPos.copy(_headWorld)
    _boneWorldPos.y += NAME_TAG_HEAD_OFFSET_Y
    head.getWorldQuaternion(_boneWorldQuat)
    return {
      position: _boneWorldPos.clone(),
      quaternion: _boneWorldQuat.clone()
    }
  }

  const aliases = ANCHOR_BONE_ALIASES[anchorPointId]
  if (!aliases?.length) return null

  const bone = findAnchorBone(model, aliases)
  if (!bone) return null

  model.updateWorldMatrix(true, false)
  bone.updateWorldMatrix(true, false)
  bone.getWorldPosition(_boneWorldPos)
  bone.getWorldQuaternion(_boneWorldQuat)
  return {
    position: _boneWorldPos.clone(),
    quaternion: _boneWorldQuat.clone()
  }
}