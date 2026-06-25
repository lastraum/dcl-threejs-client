import * as THREE from 'three'
import {
  clipMatchesLocomotionLayer,
  getOdkRetargetProfile,
  type OdkLocomotionLayerId,
  type OdkRetargetProfile
} from './odkRetargetProfile'
import { isOdkAnimatableBone } from './odkSkeleton'

/** Filter retargeted clip tracks to a locomotion layer (post-retarget safety net). */
export function filterClipToLocomotionLayer(
  clip: THREE.AnimationClip,
  layerId: OdkLocomotionLayerId,
  profile: OdkRetargetProfile = getOdkRetargetProfile()
): number {
  const before = clip.tracks.length
  clip.tracks = clip.tracks.filter((track) => {
    const bone = track.name.split('.')[0] ?? ''
    return clipMatchesLocomotionLayer(bone, layerId, profile)
  })
  return before - clip.tracks.length
}

/** Standing bind for pelvis + thighs + calves — fades out as walk/jog take over. */
export function buildLegLocoBindClip(
  avatarRoot: THREE.Object3D,
  duration: number,
  profile: OdkRetargetProfile = getOdkRetargetProfile()
): THREE.AnimationClip {
  const d = Math.max(duration, 0.001)
  const tracks: THREE.KeyframeTrack[] = []

  avatarRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Bone)) return
    if (!isOdkAnimatableBone(obj.name)) return
    if (!clipMatchesLocomotionLayer(obj.name, 'legLocoBind', profile)) return

    const q = obj.quaternion.toArray()
    tracks.push(
      new THREE.QuaternionKeyframeTrack(`${obj.name}.quaternion`, [0, d], [...q, ...q])
    )
  })

  return new THREE.AnimationClip('odk-leg-loco-bind', d, tracks)
}