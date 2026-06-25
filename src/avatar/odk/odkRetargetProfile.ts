/**
 * Skeleton-family retarget profile — UE5 mannequin / ODK (not per-avatar hacks).
 * Rules drive rotation retarget, twist mirror, spine extension, and locomotion layers.
 */

export type OdkRotationRule = 'retarget' | 'omit'

export type OdkClipKind = 'full' | 'idle' | 'locomotion'

export type OdkLocomotionLayerId = 'idleUpper' | 'locomotionLower' | 'legLocoBind' | 'full'

export type OdkBoneRotationRule = {
  rotation: OdkRotationRule
}

export type OdkTwistRule = {
  parent: string
  blend: number
}

export type OdkSpineExtensionBone = {
  name: string
  /** 0 = bind only, 1 = full chest delta from spine_03 prep */
  blend: number
}

export type OdkLocomotionLayerSpec = {
  include?: RegExp
  exclude?: RegExp
}

export type OdkRetargetProfile = {
  id: string
  chainDefaults: {
    spine: OdkRotationRule
    arm: OdkRotationRule
    leg: OdkRotationRule
    foot: OdkRotationRule
    pelvis: OdkRotationRule
  }
  boneRules: Partial<Record<string, OdkBoneRotationRule>>
  spineExtension: {
    sourceBone: string
    bones: OdkSpineExtensionBone[]
  }
  twistBones: Record<string, OdkTwistRule>
  /** Retarget mixamorigHips.position → pelvis.position (Y delta only, VRM-scale). */
  pelvisPosition: boolean
  /** Which bones to retarget per clip type (applied before mirror/spine extension). */
  clipKinds: Record<OdkClipKind, OdkLocomotionLayerSpec>
  locomotionLayers: Record<OdkLocomotionLayerId, OdkLocomotionLayerSpec>
}

/** Locomotion leg bones — world-delta retarget order (parent before child). */
export const ODK_LOCOMOTION_LEG_CHAIN = [
  'pelvis',
  'thigh_l',
  'calf_l',
  'foot_l',
  'ball_l',
  'thigh_r',
  'calf_r',
  'foot_r',
  'ball_r'
] as const

/** UE5 / ODK mannequin — bindmul upper body; world-delta locomotion legs. */
export const UE5_MANNEQUIN_PROFILE: OdkRetargetProfile = {
  id: 'ue5-mannequin',
  chainDefaults: {
    spine: 'retarget',
    arm: 'retarget',
    leg: 'retarget',
    foot: 'retarget',
    pelvis: 'retarget'
  },
  boneRules: {},
  spineExtension: {
    sourceBone: 'spine_03',
    bones: [
      { name: 'spine_04', blend: 0.42 },
      { name: 'spine_05', blend: 1.0 }
    ]
  },
  twistBones: {
    upperarm_twist_01_l: { parent: 'upperarm_l', blend: 1 },
    upperarm_twist_02_l: { parent: 'upperarm_l', blend: 1 },
    lowerarm_twist_01_l: { parent: 'lowerarm_l', blend: 1 },
    lowerarm_twist_02_l: { parent: 'lowerarm_l', blend: 1 },
    upperarm_twist_01_r: { parent: 'upperarm_r', blend: 1 },
    upperarm_twist_02_r: { parent: 'upperarm_r', blend: 1 },
    lowerarm_twist_01_r: { parent: 'lowerarm_r', blend: 1 },
    lowerarm_twist_02_r: { parent: 'lowerarm_r', blend: 1 },
    thigh_twist_01_l: { parent: 'thigh_l', blend: 1 },
    thigh_twist_02_l: { parent: 'thigh_l', blend: 1 },
    calf_twist_01_l: { parent: 'calf_l', blend: 1 },
    calf_twist_02_l: { parent: 'calf_l', blend: 1 },
    thigh_twist_01_r: { parent: 'thigh_r', blend: 1 },
    thigh_twist_02_r: { parent: 'thigh_r', blend: 1 },
    calf_twist_01_r: { parent: 'calf_r', blend: 1 },
    calf_twist_02_r: { parent: 'calf_r', blend: 1 }
  },
  pelvisPosition: true,
  clipKinds: {
    full: {},
    idle: {
      exclude: /^(pelvis|thigh_|calf_|foot_|ball_|thigh_twist_|calf_twist_)/
    },
    locomotion: {
      include: /^(pelvis|thigh_l|thigh_r|calf_l|calf_r|foot_l|foot_r|ball_l|ball_r)$/
    }
  },
  locomotionLayers: {
    idleUpper: {
      exclude: /^(pelvis|thigh_|calf_|foot_|ball_|thigh_twist_|calf_twist_)/
    },
    locomotionLower: {
      include: /^(pelvis|thigh_l|thigh_r|calf_l|calf_r)$/
    },
    legLocoBind: {
      include: /^(pelvis|thigh_l|thigh_r|calf_l|calf_r)$/
    },
    full: {}
  }
}

let activeProfile: OdkRetargetProfile = UE5_MANNEQUIN_PROFILE

export function getOdkRetargetProfile(): OdkRetargetProfile {
  return activeProfile
}

export function setOdkRetargetProfile(profile: OdkRetargetProfile): void {
  activeProfile = profile
}

export function resolveOdkRotationRule(
  boneName: string,
  profile: OdkRetargetProfile = activeProfile
): OdkBoneRotationRule {
  const override = profile.boneRules[boneName]
  if (override) return override

  if (boneName === 'pelvis') return { rotation: profile.chainDefaults.pelvis }
  if (
    boneName.startsWith('spine_') ||
    boneName.startsWith('neck_') ||
    boneName === 'head'
  ) {
    return { rotation: profile.chainDefaults.spine }
  }
  if (
    boneName.includes('clavicle') ||
    boneName.includes('arm') ||
    boneName.includes('hand') ||
    boneName.includes('thumb_') ||
    boneName.includes('index_') ||
    boneName.includes('middle_') ||
    boneName.includes('ring_') ||
    boneName.includes('pinky_') ||
    boneName.includes('metacarpal')
  ) {
    return { rotation: profile.chainDefaults.arm }
  }
  if (boneName.startsWith('thigh_') || boneName.startsWith('calf_')) {
    return { rotation: profile.chainDefaults.leg }
  }
  if (boneName.startsWith('foot_') || boneName.startsWith('ball_')) {
    return { rotation: profile.chainDefaults.foot }
  }
  return { rotation: 'retarget' }
}

function clipMatchesSpec(boneName: string, spec: OdkLocomotionLayerSpec | undefined): boolean {
  if (!spec) return true
  if (spec.exclude?.test(boneName)) return false
  if (spec.include && !spec.include.test(boneName)) return false
  return true
}

export function clipMatchesClipKind(
  boneName: string,
  kind: OdkClipKind,
  profile: OdkRetargetProfile = activeProfile
): boolean {
  return clipMatchesSpec(boneName, profile.clipKinds[kind])
}

export function clipMatchesLocomotionLayer(
  boneName: string,
  layerId: OdkLocomotionLayerId,
  profile: OdkRetargetProfile = activeProfile
): boolean {
  return clipMatchesSpec(boneName, profile.locomotionLayers[layerId])
}

export function shouldRetargetOdkBone(
  odkName: string,
  kind: OdkClipKind,
  profile: OdkRetargetProfile = activeProfile
): boolean {
  if (!clipMatchesClipKind(odkName, kind, profile)) return false
  return resolveOdkRotationRule(odkName, profile).rotation === 'retarget'
}