import * as THREE from 'three'
import { normalizeBoneName } from './emoteBoneMap'

/**
 * Sit / chair / ground emotes bake `Avatar_Hips.translation` in **cm-scale** under an
 * Armature with scale ≈ 0.01 (rest often z≈-100). Applying those raw numbers onto a
 * meter-scale DCL body or VRM hips sinks the mesh or floats the sit pose above seats.
 *
 * Re-express each hips-class position track as:
 *   avatarRest + (emoteValue − emoteRest) × unitScale
 * so only the authored sit delta (lower ~0.35m, slight Z) remains.
 */

const HIP_BONE = /^(Hips|hip|Pelvis|Avatar_Hips|CTRL_Avatar_Hips|mixamorigHips)$/i

function isHipsPositionTrack(trackName: string): boolean {
  if (!trackName.endsWith('.position')) return false
  const bone = trackName.slice(0, -'.position'.length)
  const n = normalizeBoneName(bone)
    .replace(/^Avatar_/i, '')
    .replace(/^CTRL_Avatar_/i, '')
    .replace(/^CTRL_FK_Avatar_/i, '')
    .replace(/^mixamorig:?/i, '')
  return HIP_BONE.test(n) || HIP_BONE.test(normalizeBoneName(bone))
}

function findEmoteHipsNode(emoteRoot: THREE.Object3D): THREE.Object3D | null {
  const names = [
    'Avatar_Hips',
    'CTRL_Avatar_Hips',
    'Hips',
    'mixamorigHips',
    'mixamorig:Hips',
    'Pelvis'
  ]
  for (const n of names) {
    const obj = emoteRoot.getObjectByName(n)
    if (obj) return obj
  }
  let found: THREE.Object3D | null = null
  emoteRoot.traverse((obj) => {
    if (found || !obj.name) return
    const n = normalizeBoneName(obj.name)
    if (/hips|pelvis/i.test(n) && !/ik|pole/i.test(n)) found = obj
  })
  return found
}

/**
 * Emote hips tracks use tens of units (cm). Meter-scale tracks stay near ±2.
 * Parent Armature scale 0.01 is NOT baked into the track numbers by GLTFLoader.
 */
function inferUnitScale(values: ArrayLike<number>): number {
  let maxAbs = 0
  for (let i = 0; i < values.length; i++) {
    const v = Math.abs(values[i]!)
    if (v > maxAbs) maxAbs = v
  }
  if (maxAbs > 5) return 0.01
  return 1
}

/**
 * Rewrite hips-class `.position` tracks so sit/chair emotes land at avatar rest ± authored delta.
 * Non-hips tracks unchanged. Returns `clip` if nothing to do.
 *
 * `clip` bone names must already match nodes under `avatarRoot` (DCL remap or VRM raw names).
 */
export function reanchorEmoteHipPositions(
  clip: THREE.AnimationClip,
  emoteRoot: THREE.Object3D,
  avatarRoot: THREE.Object3D
): THREE.AnimationClip {
  avatarRoot.updateWorldMatrix(true, true)
  emoteRoot.updateWorldMatrix(true, true)

  const emoteHips = findEmoteHipsNode(emoteRoot)
  // Prefer authored rest on the emote skeleton (pre-animation bind).
  const emoteRest = emoteHips
    ? emoteHips.position.clone()
    : new THREE.Vector3(0, 0, -100)

  let changed = false
  const tracks: THREE.KeyframeTrack[] = []

  for (const track of clip.tracks) {
    if (!(track instanceof THREE.VectorKeyframeTrack) || !isHipsPositionTrack(track.name)) {
      tracks.push(track)
      continue
    }

    const nodeName = track.name.slice(0, -'.position'.length)
    const bone = THREE.PropertyBinding.findNode(avatarRoot, nodeName) as THREE.Object3D | null
    if (!bone) {
      tracks.push(track)
      continue
    }

    const stride = track.getValueSize()
    if (stride !== 3 || track.values.length < 3) {
      tracks.push(track)
      continue
    }

    const unit = inferUnitScale(track.values)
    const rest = bone.position
    const out = new Float32Array(track.values.length)
    for (let i = 0; i < track.values.length; i += 3) {
      const dx = (track.values[i]! - emoteRest.x) * unit
      const dy = (track.values[i + 1]! - emoteRest.y) * unit
      const dz = (track.values[i + 2]! - emoteRest.z) * unit
      out[i] = rest.x + dx
      out[i + 1] = rest.y + dy
      out[i + 2] = rest.z + dz
    }
    tracks.push(
      new THREE.VectorKeyframeTrack(track.name, Array.from(track.times), Array.from(out))
    )
    changed = true
  }

  if (!changed) return clip
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

/**
 * Build a VRM-local hips.position track from emote-space translation (cm under 0.01 armature).
 * Returns null when the emote has no usable hips translation (rotations-only emotes).
 */
export function buildVrmHipsPositionTrackFromEmote(
  emoteClip: THREE.AnimationClip,
  emoteRoot: THREE.Object3D,
  vrmHipsBone: THREE.Object3D
): THREE.VectorKeyframeTrack | null {
  emoteRoot.updateWorldMatrix(true, true)
  const emoteHips = findEmoteHipsNode(emoteRoot)
  const emoteRest = emoteHips
    ? emoteHips.position.clone()
    : new THREE.Vector3(0, 0, -100)

  let src: THREE.VectorKeyframeTrack | null = null
  for (const track of emoteClip.tracks) {
    if (track instanceof THREE.VectorKeyframeTrack && isHipsPositionTrack(track.name)) {
      src = track
      break
    }
  }
  if (!src || src.getValueSize() !== 3 || src.values.length < 3) return null

  const unit = inferUnitScale(src.values)
  // Static sits (chair): if delta is tiny after unit scale, still apply — sit Y is ~0.35m.
  const rest = vrmHipsBone.position
  const out = new Float32Array(src.values.length)
  let maxDelta = 0
  for (let i = 0; i < src.values.length; i += 3) {
    const dx = (src.values[i]! - emoteRest.x) * unit
    const dy = (src.values[i + 1]! - emoteRest.y) * unit
    const dz = (src.values[i + 2]! - emoteRest.z) * unit
    maxDelta = Math.max(maxDelta, Math.abs(dx), Math.abs(dy), Math.abs(dz))
    out[i] = rest.x + dx
    out[i + 1] = rest.y + dy
    out[i + 2] = rest.z + dz
  }
  // No meaningful sit delta (pure wave/idle) — skip hips position.
  if (maxDelta < 0.02) return null

  return new THREE.VectorKeyframeTrack(
    `${vrmHipsBone.name}.position`,
    Array.from(src.times),
    Array.from(out)
  )
}
