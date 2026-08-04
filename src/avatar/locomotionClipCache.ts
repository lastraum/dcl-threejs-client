import * as THREE from 'three'
import type { BodyShape } from './types'
import { remapClipToAvatar } from './emoteBoneMap'

const cache = new Map<string, THREE.AnimationClip>()

function cacheKey(bodyShape: BodyShape, clip: THREE.AnimationClip, keepHipBob: boolean): string {
  const posMode = keepHipBob ? 'hipBob' : 'noHipPos'
  return `${bodyShape}:${clip.name}:${clip.duration}:${clip.tracks.length}:${posMode}`
}

const ROOT_POSITION_BONE = /^(Hips|hip|Armature|Root|root|Pelvis)$/i
/** Hips-level bones whose translation can be re-anchored; Armature/Root offsets are export garbage. */
const HIP_BONE = /^(Hips|hip|Pelvis)$/i

function rootBoneOfPositionTrack(trackName: string): string | null {
  if (!trackName.endsWith('.position')) return null
  const bone = trackName.slice(0, -'.position'.length).replace(/\.\d+$/, '')
  const n = bone
    .replace(/^Avatar_/i, '')
    .replace(/^CTRL_Avatar_/i, '')
    .replace(/^CTRL_FK_Avatar_/i, '')
    .replace(/^mixamorig/i, '')
  return ROOT_POSITION_BONE.test(n) ? n : null
}

/**
 * Re-express a hips translation track as its authored bounce/sway around the target
 * bone's rest position: rest + (value − cycle mean). Keeps the vertical bob and lateral
 * weight shift the animator keyed while removing any absolute-height mismatch between
 * the source rig and the composed avatar (which is why positions used to be stripped).
 */
function anchorHipTrackToRest(
  track: THREE.KeyframeTrack,
  avatarRoot: THREE.Object3D
): THREE.KeyframeTrack | null {
  const nodeName = track.name.slice(0, -'.position'.length)
  const bone = THREE.PropertyBinding.findNode(avatarRoot, nodeName) as THREE.Object3D | null
  if (!bone || !(bone as THREE.Object3D).isObject3D) return null
  const stride = track.getValueSize()
  if (stride !== 3 || track.values.length < 3) return null

  const values = track.values
  const count = values.length / 3
  let mx = 0
  let my = 0
  let mz = 0
  for (let i = 0; i < values.length; i += 3) {
    mx += values[i]
    my += values[i + 1]
    mz += values[i + 2]
  }
  mx /= count
  my /= count
  mz /= count

  const rest = bone.position
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i += 3) {
    out[i] = rest.x + (values[i] - mx)
    out[i + 1] = rest.y + (values[i + 1] - my)
    out[i + 2] = rest.z + (values[i + 2] - mz)
  }
  return new THREE.VectorKeyframeTrack(track.name, Array.from(track.times), Array.from(out))
}

/**
 * Root translation handling: physics owns world travel, so Armature/Root translation
 * tracks always go. Hips translation is dropped by default (jump/air clips would lift
 * the mesh above the CCT) but grounded gaits can keep it re-anchored via `keepHipBob`.
 */
function processRootPositionTracks(
  clip: THREE.AnimationClip,
  avatarRoot: THREE.Object3D,
  keepHipBob: boolean
): THREE.AnimationClip {
  let changed = false
  const kept: THREE.KeyframeTrack[] = []
  for (const track of clip.tracks) {
    const rootBone = rootBoneOfPositionTrack(track.name)
    if (!rootBone) {
      kept.push(track)
      continue
    }
    if (keepHipBob && HIP_BONE.test(rootBone)) {
      const anchored = anchorHipTrackToRest(track, avatarRoot)
      if (anchored) {
        kept.push(anchored)
        changed = true
        continue
      }
    }
    changed = true
  }
  if (!changed) return clip
  return new THREE.AnimationClip(clip.name, clip.duration, kept)
}

/**
 * Retarget locomotion clips once per body shape — reuse across remote avatars with the same rig.
 * Returns a fresh clone for AnimationMixer ownership.
 */
export function getRemappedLocomotionClip(
  clip: THREE.AnimationClip | undefined,
  avatarRoot: THREE.Object3D,
  bodyShape: BodyShape,
  options?: { keepHipBob?: boolean }
): THREE.AnimationClip | null {
  if (!clip) return null
  const keepHipBob = options?.keepHipBob === true
  const key = cacheKey(bodyShape, clip, keepHipBob)
  let template = cache.get(key)
  if (!template) {
    const remapped = remapClipToAvatar(clip, avatarRoot)
    if (!remapped) return null
    template = processRootPositionTracks(remapped, avatarRoot, keepHipBob)
    cache.set(key, template)
  }
  return template.clone()
}

export function clearLocomotionClipCache(): void {
  cache.clear()
}
