import * as THREE from 'three'
import type { BodyShape } from './types'
import { remapClipToAvatar } from './emoteBoneMap'

const cache = new Map<string, THREE.AnimationClip>()

function cacheKey(bodyShape: BodyShape, clip: THREE.AnimationClip): string {
  return `${bodyShape}:${clip.name}:${clip.duration}:${clip.tracks.length}:noHipPos`
}

/**
 * Drop hips/root translation tracks so jump/walk clips cannot lift the mesh above the CCT.
 * Physics owns vertical motion; animation should only pose bones relative to feet.
 */
function stripRootPositionTracks(clip: THREE.AnimationClip): THREE.AnimationClip {
  const kept = clip.tracks.filter((track) => {
    if (!track.name.endsWith('.position')) return true
    const bone = track.name.slice(0, -'.position'.length).replace(/\.\d+$/, '')
    const n = bone
      .replace(/^Avatar_/i, '')
      .replace(/^CTRL_Avatar_/i, '')
      .replace(/^CTRL_FK_Avatar_/i, '')
      .replace(/^mixamorig/i, '')
    return !/^(Hips|hip|Armature|Root|root|Pelvis)$/i.test(n)
  })
  if (kept.length === clip.tracks.length) return clip
  return new THREE.AnimationClip(clip.name, clip.duration, kept)
}

/**
 * Retarget locomotion clips once per body shape — reuse across remote avatars with the same rig.
 * Returns a fresh clone for AnimationMixer ownership.
 */
export function getRemappedLocomotionClip(
  clip: THREE.AnimationClip | undefined,
  avatarRoot: THREE.Object3D,
  bodyShape: BodyShape
): THREE.AnimationClip | null {
  if (!clip) return null
  const key = cacheKey(bodyShape, clip)
  let template = cache.get(key)
  if (!template) {
    const remapped = remapClipToAvatar(clip, avatarRoot)
    if (!remapped) return null
    template = stripRootPositionTracks(remapped)
    cache.set(key, template)
  }
  return template.clone()
}

export function clearLocomotionClipCache(): void {
  cache.clear()
}