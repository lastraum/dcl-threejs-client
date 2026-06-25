/** Normalize Mixamo GLB node names (`mixamorig:Hips` → `mixamorigHips`). */
export function normalizeMixamoBoneName(name: string): string {
  return name.replace(/^mixamorig:/, 'mixamorig')
}

/** Mixamo / DAZ / VRM-style aliases → ODK UE5 mannequin bone names. */
export const TO_ODK: Record<string, string> = {
  Hips: 'pelvis',
  mixamorigHips: 'pelvis',
  pelvis: 'pelvis',

  Spine: 'spine_01',
  mixamorigSpine: 'spine_01',
  abdomenLower: 'spine_02',

  Spine1: 'spine_02',
  mixamorigSpine1: 'spine_02',

  Spine2: 'spine_03',
  mixamorigSpine2: 'spine_03',
  abdomenUpper: 'spine_03',

  chestLower: 'spine_04',
  chestUpper: 'spine_05',

  Neck: 'neck_01',
  mixamorigNeck: 'neck_01',
  neckLower: 'neck_01',

  neckUpper: 'neck_02',

  Head: 'head',
  mixamorigHead: 'head',
  head: 'head',

  LeftShoulder: 'clavicle_l',
  mixamorigLeftShoulder: 'clavicle_l',
  lCollar: 'clavicle_l',

  LeftArm: 'upperarm_l',
  mixamorigLeftArm: 'upperarm_l',
  lShldrBend: 'upperarm_l',

  lShldrTwist: 'upperarm_twist_01_l',

  LeftForeArm: 'lowerarm_l',
  mixamorigLeftForeArm: 'lowerarm_l',
  lForearmBend: 'lowerarm_l',
  lForearmTwist: 'lowerarm_twist_01_l',

  LeftHand: 'hand_l',
  mixamorigLeftHand: 'hand_l',
  lHand: 'hand_l',

  lThumb1: 'thumb_01_l',
  lThumb2: 'thumb_02_l',
  lThumb3: 'thumb_03_l',
  lIndex1: 'index_01_l',
  lIndex2: 'index_02_l',
  lIndex3: 'index_03_l',
  lCarpal1: 'index_metacarpal_l',
  lMid1: 'middle_01_l',
  lMid2: 'middle_02_l',
  lMid3: 'middle_03_l',
  lCarpal2: 'middle_metacarpal_l',
  lRing1: 'ring_01_l',
  lRing2: 'ring_02_l',
  lRing3: 'ring_03_l',
  lCarpal3: 'ring_metacarpal_l',
  lPinky1: 'pinky_01_l',
  lPinky2: 'pinky_02_l',
  lPinky3: 'pinky_03_l',
  lCarpal4: 'pinky_metacarpal_l',

  RightShoulder: 'clavicle_r',
  mixamorigRightShoulder: 'clavicle_r',
  rCollar: 'clavicle_r',

  RightArm: 'upperarm_r',
  mixamorigRightArm: 'upperarm_r',
  rShldrBend: 'upperarm_r',
  rShldrTwist: 'upperarm_twist_01_r',

  RightForeArm: 'lowerarm_r',
  mixamorigRightForeArm: 'lowerarm_r',
  rForearmBend: 'lowerarm_r',
  rForearmTwist: 'lowerarm_twist_01_r',

  RightHand: 'hand_r',
  mixamorigRightHand: 'hand_r',
  rHand: 'hand_r',

  rThumb1: 'thumb_01_r',
  rThumb2: 'thumb_02_r',
  rThumb3: 'thumb_03_r',
  rIndex1: 'index_01_r',
  rIndex2: 'index_02_r',
  rIndex3: 'index_03_r',
  rCarpal1: 'index_metacarpal_r',
  rMid1: 'middle_01_r',
  rMid2: 'middle_02_r',
  rMid3: 'middle_03_r',
  rCarpal2: 'middle_metacarpal_r',
  rRing1: 'ring_01_r',
  rRing2: 'ring_02_r',
  rRing3: 'ring_03_r',
  rCarpal3: 'ring_metacarpal_r',
  rPinky1: 'pinky_01_r',
  rPinky2: 'pinky_02_r',
  rPinky3: 'pinky_03_r',
  rCarpal4: 'pinky_metacarpal_r',

  LeftUpLeg: 'thigh_l',
  mixamorigLeftUpLeg: 'thigh_l',
  lThighBend: 'thigh_l',
  lThighTwist: 'thigh_twist_01_l',

  LeftLeg: 'calf_l',
  mixamorigLeftLeg: 'calf_l',
  lShin: 'calf_l',

  LeftFoot: 'foot_l',
  mixamorigLeftFoot: 'foot_l',
  lFoot: 'foot_l',
  lMetatarsals: 'foot_l',

  LeftToeBase: 'ball_l',
  mixamorigLeftToeBase: 'ball_l',

  RightUpLeg: 'thigh_r',
  mixamorigRightUpLeg: 'thigh_r',
  rThighBend: 'thigh_r',
  rThighTwist: 'thigh_twist_01_r',

  RightLeg: 'calf_r',
  mixamorigRightLeg: 'calf_r',
  rShin: 'calf_r',

  RightFoot: 'foot_r',
  mixamorigRightFoot: 'foot_r',
  rFoot: 'foot_r',
  rMetatarsals: 'foot_r',

  RightToeBase: 'ball_r',
  mixamorigRightToeBase: 'ball_r'
}

export function resolveOdkBoneName(mixamoTrackBone: string): string | undefined {
  const normalized = normalizeMixamoBoneName(mixamoTrackBone)
  return TO_ODK[normalized] ?? TO_ODK[mixamoTrackBone]
}