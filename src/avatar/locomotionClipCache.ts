import * as THREE from 'three'
import type { BodyShape } from './types'
import { remapClipToAvatar } from './emoteBoneMap'

const cache = new Map<string, THREE.AnimationClip>()

function cacheKey(bodyShape: BodyShape, clip: THREE.AnimationClip): string {
  return `${bodyShape}:${clip.name}:${clip.duration}:${clip.tracks.length}`
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
    template = remapped
    cache.set(key, template)
  }
  return template.clone()
}

export function clearLocomotionClipCache(): void {
  cache.clear()
}