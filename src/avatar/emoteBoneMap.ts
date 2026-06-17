import * as THREE from 'three'

export function normalizeBoneName(name: string): string {
  return name.replace(/\.\d+$/, '')
}

/** Common humanoid bone aliases — clip may use Mixamo/VRM/CTRL names, avatar uses Avatar_* */
const HUMANOID_BONE_VARIANTS: Record<string, string[]> = {
  Hips: ['Hips', 'Avatar_Hips', 'CTRL_Avatar_Hips', 'mixamorigHips'],
  Spine: ['Spine', 'Avatar_Spine', 'CTRL_Avatar_Spine', 'mixamorigSpine'],
  Spine1: ['Spine1', 'Avatar_Spine1', 'CTRL_Avatar_Spine1', 'mixamorigSpine1'],
  Spine2: ['Spine2', 'Avatar_Spine2', 'CTRL_Avatar_Spine2', 'mixamorigSpine2'],
  Neck: ['Neck', 'Avatar_Neck', 'CTRL_Avatar_Neck', 'mixamorigNeck'],
  Head: ['Head', 'Avatar_Head', 'CTRL_Avatar_Head', 'mixamorigHead'],
  LeftShoulder: ['LeftShoulder', 'Avatar_LeftShoulder', 'CTRL_Avatar_LeftShoulder', 'mixamorigLeftShoulder'],
  RightShoulder: ['RightShoulder', 'Avatar_RightShoulder', 'CTRL_Avatar_RightShoulder', 'mixamorigRightShoulder'],
  LeftArm: ['LeftArm', 'Avatar_LeftArm', 'CTRL_Avatar_LeftArm', 'mixamorigLeftArm'],
  RightArm: ['RightArm', 'Avatar_RightArm', 'CTRL_Avatar_RightArm', 'mixamorigRightArm'],
  LeftForeArm: ['LeftForeArm', 'Avatar_LeftForeArm', 'CTRL_Avatar_LeftForeArm', 'mixamorigLeftForeArm'],
  RightForeArm: ['RightForeArm', 'Avatar_RightForeArm', 'CTRL_Avatar_RightForeArm', 'mixamorigRightForeArm'],
  LeftHand: ['LeftHand', 'Avatar_LeftHand', 'CTRL_Avatar_LeftHand', 'mixamorigLeftHand'],
  RightHand: ['RightHand', 'Avatar_RightHand', 'CTRL_Avatar_RightHand', 'mixamorigRightHand'],
  LeftUpLeg: ['LeftUpLeg', 'Avatar_LeftUpLeg', 'CTRL_Avatar_LeftUpLeg', 'mixamorigLeftUpLeg'],
  RightUpLeg: ['RightUpLeg', 'Avatar_RightUpLeg', 'CTRL_Avatar_RightUpLeg', 'mixamorigRightUpLeg'],
  LeftLeg: ['LeftLeg', 'Avatar_LeftLeg', 'CTRL_Avatar_LeftLeg', 'mixamorigLeftLeg'],
  RightLeg: ['RightLeg', 'Avatar_RightLeg', 'CTRL_Avatar_RightLeg', 'mixamorigRightLeg'],
  LeftFoot: ['LeftFoot', 'Avatar_LeftFoot', 'CTRL_Avatar_LeftFoot', 'mixamorigLeftFoot'],
  RightFoot: ['RightFoot', 'Avatar_RightFoot', 'CTRL_Avatar_RightFoot', 'mixamorigRightFoot'],
  LeftToeBase: ['LeftToeBase', 'Avatar_LeftToeBase', 'CTRL_Avatar_LeftToeBase', 'mixamorigLeftToeBase'],
  RightToeBase: ['RightToeBase', 'Avatar_RightToeBase', 'CTRL_Avatar_RightToeBase', 'mixamorigRightToeBase']
}

/** Catalyst / wearable-preview clips target CTRL / FK / IK rig bones — avatar uses Avatar_*. */
function clipBoneAliases(name: string): string[] {
  const normalized = normalizeBoneName(name)
  const aliases = new Set<string>([normalized, `Avatar_${normalized}`])

  if (normalized.startsWith('CTRL_FK_Avatar_')) {
    const core = normalized.slice('CTRL_FK_Avatar_'.length)
    aliases.add(`Avatar_${core}`)
    aliases.add(`CTRL_Avatar_${core}`)
    aliases.add(core)
  } else if (normalized.startsWith('CTRL_Avatar_')) {
    const core = normalized.slice('CTRL_Avatar_'.length)
    aliases.add(`Avatar_${core}`)
    aliases.add(core)
  } else if (normalized.startsWith('CTRL_IK_')) {
    const rest = normalized.slice('CTRL_IK_'.length)
    aliases.add(`Avatar_${rest}`)
    aliases.add(rest)
  } else if (normalized.startsWith('CTRL_')) {
    aliases.add(normalized.slice(5))
  }

  if (normalized.startsWith('Avatar_')) {
    aliases.add(normalized.slice(7))
  }

  return [...aliases]
}

export function isEmoteMechanismBone(name: string): boolean {
  const n = normalizeBoneName(name)
  return n.startsWith('MCH_')
}

export function buildBoneNameSet(root: THREE.Object3D): Set<string> {
  const names = new Set<string>()
  root.traverse((obj) => {
    if (obj.name) names.add(normalizeBoneName(obj.name))
  })
  return names
}

export function resolveBoneName(clipBoneName: string, avatarBones: Set<string>): string | null {
  const candidates = new Set<string>()

  for (const alias of clipBoneAliases(clipBoneName)) {
    candidates.add(alias)
    for (const variants of Object.values(HUMANOID_BONE_VARIANTS)) {
      if (variants.some((v) => normalizeBoneName(v) === alias)) {
        for (const v of variants) candidates.add(normalizeBoneName(v))
      }
    }
  }

  for (const name of candidates) {
    if (avatarBones.has(name)) return name
  }
  return null
}

/** Drop tracks that don't match avatar bones; normalize `.001` suffix mismatches. */
export function remapClipToAvatar(
  clip: THREE.AnimationClip | undefined,
  avatarRoot: THREE.Object3D
): THREE.AnimationClip | null {
  if (!clip) return null

  const bones = buildBoneNameSet(avatarRoot)
  const tracks: THREE.KeyframeTrack[] = []

  for (const track of clip.tracks) {
    const dot = track.name.indexOf('.')
    if (dot <= 0) continue
    const clipBoneName = normalizeBoneName(track.name.slice(0, dot))
    const boneName = resolveBoneName(clipBoneName, bones)
    if (!boneName) continue

    const property = track.name.slice(dot + 1)
    const cloned = track.clone()
    cloned.name = `${boneName}.${property}`
    tracks.push(cloned)
  }

  if (!tracks.length) return null
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}
