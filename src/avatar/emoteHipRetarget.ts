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

function findEmoteArmature(
  emoteRoot: THREE.Object3D,
  hips: THREE.Object3D | null
): THREE.Object3D | null {
  let p: THREE.Object3D | null = hips?.parent ?? null
  while (p) {
    if (/armature/i.test(p.name)) return p
    p = p.parent
  }
  return emoteRoot.getObjectByName('Armature') ?? null
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
 * T-pose / bind hips.position. Sit_Edge bind is (0,0,-100) cm under Armature×0.01;
 * frame 0 is already seated (z −16). Same-rig DCL bodies use this cm space — do not
 * treat frame 0 as rest (that leaves standing hips + sit rotations = float).
 */
function hipsRestFromTrack(_track: THREE.VectorKeyframeTrack, bind: THREE.Vector3): THREE.Vector3 {
  return bind.clone()
}

/** DCL body hips live in cm under Armature×0.01 (rest z≈-100). VRM hips are meters. */
function avatarHipsAreCmScale(rest: THREE.Vector3): boolean {
  return Math.abs(rest.z) > 5 || Math.abs(rest.y) > 5 || rest.length() > 5
}

/**
 * Rewrite hips-class `.position` tracks so sit/chair emotes stay on the hotspot.
 *
 * Emote GLBs bake translations in cm under Armature×0.01. Only hips keep a
 * within-clip delta (sway). Non-hips `.position` tracks are dropped — rotations
 * define the pose. Rest is **bind / T-pose**. Same-rig DCL hips stay in cm;
 * meter-scale (VRM) hips get the Armature×0.01 (+90X) sit drop on Y.
 */
export function reanchorEmoteHipPositions(
  clip: THREE.AnimationClip,
  emoteRoot: THREE.Object3D,
  avatarRoot: THREE.Object3D
): THREE.AnimationClip {
  avatarRoot.updateWorldMatrix(true, true)
  emoteRoot.updateWorldMatrix(true, true)

  const emoteHips = findEmoteHipsNode(emoteRoot)
  const bindRest = emoteHips
    ? emoteHips.position.clone()
    : new THREE.Vector3(0, 0, -100)

  let changed = false
  const tracks: THREE.KeyframeTrack[] = []

  for (const track of clip.tracks) {
    // Drop non-hips position tracks (cm-scale limb bind poses — not meter deltas).
    if (track instanceof THREE.VectorKeyframeTrack && track.name.endsWith('.position')) {
      if (!isHipsPositionTrack(track.name)) {
        changed = true
        continue
      }
    } else if (!(track instanceof THREE.VectorKeyframeTrack) || !isHipsPositionTrack(track.name)) {
      tracks.push(track)
      continue
    }

    const nodeName = track.name.slice(0, -'.position'.length)
    const bone = THREE.PropertyBinding.findNode(avatarRoot, nodeName) as THREE.Object3D | null
    if (!bone) {
      // No hips bone on avatar — drop the cm-scale track rather than apply raw.
      changed = true
      continue
    }

    const stride = track.getValueSize()
    if (stride !== 3 || track.values.length < 3) {
      tracks.push(track)
      continue
    }

    const rest = bone.position.clone()
    const emoteRest = hipsRestFromTrack(track, bindRest)
    const unit = inferUnitScale(track.values)
    const cmRig = avatarHipsAreCmScale(rest)
    const armature = cmRig ? null : findEmoteArmature(emoteRoot, emoteHips)
    armature?.updateMatrix()
    const out = new Float32Array(track.values.length)
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    for (let i = 0; i < track.values.length; i += 3) {
      a.set(track.values[i]!, track.values[i + 1]!, track.values[i + 2]!)
      b.copy(emoteRest)
      if (cmRig) {
        // Same DCL rig: keep cm. Do not *0.01 (that left a 0.84 cm sit drop).
        a.sub(b)
      } else if (armature) {
        a.applyMatrix4(armature.matrix)
        b.applyMatrix4(armature.matrix)
        a.sub(b)
      } else {
        a.sub(b).multiplyScalar(unit)
      }
      out[i] = rest.x + a.x
      out[i + 1] = rest.y + a.y
      out[i + 2] = rest.z + a.z
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
  const bindRest = emoteHips
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

  const rest = vrmHipsBone.position.clone()
  const emoteRest = hipsRestFromTrack(src, bindRest)
  const unit = inferUnitScale(src.values)
  const cmRig = avatarHipsAreCmScale(rest)
  const armature = cmRig ? null : findEmoteArmature(emoteRoot, emoteHips)
  armature?.updateMatrix()
  const out = new Float32Array(src.values.length)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  let maxDelta = 0
  for (let i = 0; i < src.values.length; i += 3) {
    a.set(src.values[i]!, src.values[i + 1]!, src.values[i + 2]!)
    b.copy(emoteRest)
    if (cmRig) {
      a.sub(b)
    } else if (armature) {
      a.applyMatrix4(armature.matrix)
      b.applyMatrix4(armature.matrix)
      a.sub(b)
    } else {
      a.sub(b).multiplyScalar(unit)
    }
    maxDelta = Math.max(maxDelta, Math.abs(a.x), Math.abs(a.y), Math.abs(a.z))
    out[i] = rest.x + a.x
    out[i + 1] = rest.y + a.y
    out[i + 2] = rest.z + a.z
  }
  // No meaningful sit delta (pure wave/idle) — skip hips position.
  if (maxDelta < 0.02) return null

  return new THREE.VectorKeyframeTrack(
    `${vrmHipsBone.name}.position`,
    Array.from(src.times),
    Array.from(out)
  )
}
