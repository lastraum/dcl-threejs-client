import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { normalizeMixamoBoneName, resolveOdkBoneName } from './odkBoneMap'
import {
  getOdkRetargetProfile,
  ODK_LOCOMOTION_LEG_CHAIN,
  shouldRetargetOdkBone,
  type OdkClipKind,
  type OdkRetargetProfile
} from './odkRetargetProfile'
import { extractPelvisHeightMeters, getOdkBone } from './odkSkeleton'

const qPrep = new THREE.Quaternion()
const qBind = new THREE.Quaternion()
const qAnim = new THREE.Quaternion()
const qCorr = new THREE.Quaternion()
const qOut = new THREE.Quaternion()
const qDelta = new THREE.Quaternion()
const qParentOut = new THREE.Quaternion()
const qParentBind = new THREE.Quaternion()
const qTwistBind = new THREE.Quaternion()
const qSrcBindWorld = new THREE.Quaternion()
const qSrcAnimWorld = new THREE.Quaternion()
const qTgtBindWorld = new THREE.Quaternion()
const qTgtAnimWorld = new THREE.Quaternion()
const qParentWorld = new THREE.Quaternion()
const qSample = new THREE.Quaternion()
const restRotationInverse = new THREE.Quaternion()
const parentRestWorldRotation = new THREE.Quaternion()

let sharedLoader: GLTFLoader | null = null

function getLoader(): GLTFLoader {
  if (!sharedLoader) sharedLoader = new GLTFLoader()
  return sharedLoader
}

function findMixamoBone(scene: THREE.Object3D, trackBoneName: string): THREE.Object3D | null {
  return (
    scene.getObjectByName(trackBoneName) ??
    scene.getObjectByName(normalizeMixamoBoneName(trackBoneName)) ??
    null
  )
}

function mixamoSceneScale(scene: THREE.Object3D): number {
  const s = scene.children[0]?.scale.x
  return s && s > 1e-6 ? s : 1
}

function prepMixamoTrack(
  track: THREE.QuaternionKeyframeTrack,
  mixamoScene: THREE.Object3D,
  srcBone: THREE.Object3D
): Float32Array {
  mixamoScene.updateWorldMatrix(true, true)
  srcBone.getWorldQuaternion(restRotationInverse).invert()
  const parent = srcBone.parent
  if (parent) parent.getWorldQuaternion(parentRestWorldRotation)
  else parentRestWorldRotation.identity()

  const values = new Float32Array(track.values.length)
  for (let i = 0; i < track.values.length; i += 4) {
    qPrep.fromArray(track.values, i)
    qPrep.premultiply(parentRestWorldRotation).multiply(restRotationInverse)
    qPrep.toArray(values, i)
  }
  return values
}

function sampleQuaternionTrack(track: THREE.QuaternionKeyframeTrack, time: number): THREE.Quaternion {
  const times = track.times
  if (times.length === 0) return qSample.identity()
  if (time <= times[0]!) {
    qSample.fromArray(track.values, 0)
    return qSample
  }
  const last = times.length - 1
  if (time >= times[last]!) {
    qSample.fromArray(track.values, last * 4)
    return qSample
  }
  let i = 0
  while (i < last && times[i + 1]! < time) i++
  const t0 = times[i]!
  const t1 = times[i + 1]!
  const k = (time - t0) / (t1 - t0)
  qParentBind.fromArray(track.values, i * 4)
  qParentOut.fromArray(track.values, (i + 1) * 4)
  qSample.copy(qParentBind).slerp(qParentOut, k)
  return qSample
}

function poseOdkLegAncestors(
  odkProbe: THREE.Object3D,
  bindLocals: Map<string, THREE.Quaternion>,
  posedLocals: Map<string, THREE.QuaternionKeyframeTrack>,
  odkName: string,
  time: number
): void {
  for (const name of ODK_LOCOMOTION_LEG_CHAIN) {
    if (name === odkName) break
    const bone = getOdkBone(odkProbe, name)
    if (!bone) continue
    const track = posedLocals.get(name)
    if (track) bone.quaternion.copy(sampleQuaternionTrack(track, time))
    else bone.quaternion.copy(bindLocals.get(name) ?? bone.quaternion)
  }
  odkProbe.updateWorldMatrix(true, true)
}

/** Preserve Mixamo world rotation delta; map into ODK locals using posed parent chain. */
function retargetLocomotionLegChainWorldDelta(
  clip: THREE.AnimationClip,
  mixamoScene: THREE.Object3D,
  avatarRoot: THREE.Object3D,
  profile: OdkRetargetProfile,
  kind: OdkClipKind,
  bindLocals: Map<string, THREE.Quaternion>
): THREE.KeyframeTrack[] {
  const mixamoProbe = mixamoScene.clone(true)
  const mixamoMixer = new THREE.AnimationMixer(mixamoProbe)
  mixamoMixer.clipAction(clip).play()

  const srcBindWorld = new Map<string, THREE.Quaternion>()
  const tgtBindWorld = new Map<string, THREE.Quaternion>()

  mixamoScene.updateWorldMatrix(true, true)
  avatarRoot.updateWorldMatrix(true, true)

  for (const odkName of ODK_LOCOMOTION_LEG_CHAIN) {
    if (!shouldRetargetOdkBone(odkName, kind, profile)) continue
    const srcBone = findMixamoBoneForOdk(mixamoScene, odkName)
    const tgtBone = getOdkBone(avatarRoot, odkName)
    if (!srcBone || !tgtBone) continue
    srcBone.getWorldQuaternion(qSrcBindWorld)
    tgtBone.getWorldQuaternion(qTgtBindWorld)
    srcBindWorld.set(odkName, qSrcBindWorld.clone())
    tgtBindWorld.set(odkName, qTgtBindWorld.clone())
    bindLocals.set(odkName, tgtBone.quaternion.clone())
  }

  const odkProbe = avatarRoot.clone(true)
  const posedTracks = new Map<string, THREE.QuaternionKeyframeTrack>()
  const outTracks: THREE.KeyframeTrack[] = []

  for (const odkName of ODK_LOCOMOTION_LEG_CHAIN) {
    if (!shouldRetargetOdkBone(odkName, kind, profile)) continue
    const srcTrack = findMixamoQuaternionTrack(clip, odkName)
    const srcBone = findMixamoBoneForOdk(mixamoProbe, odkName)
    const tgtBone = getOdkBone(odkProbe, odkName)
    const srcBind = srcBindWorld.get(odkName)
    const tgtBind = tgtBindWorld.get(odkName)
    if (!srcTrack || !srcBone || !tgtBone || !srcBind || !tgtBind) continue

    const times = Array.from(srcTrack.times)
    const values = new Float32Array(times.length * 4)

    for (let i = 0; i < times.length; i++) {
      const t = times[i]!
      mixamoMixer.setTime(t)
      mixamoMixer.update(0)
      mixamoProbe.updateWorldMatrix(true, true)
      srcBone.getWorldQuaternion(qSrcAnimWorld)

      qDelta.copy(srcBind).invert().multiply(qSrcAnimWorld)
      qTgtAnimWorld.copy(tgtBind).multiply(qDelta)

      poseOdkLegAncestors(odkProbe, bindLocals, posedTracks, odkName, t)
      const parent = tgtBone.parent
      if (parent) parent.getWorldQuaternion(qParentWorld)
      else qParentWorld.identity()

      qOut.copy(qParentWorld).invert().multiply(qTgtAnimWorld)
      qOut.toArray(values, i * 4)
    }

    const track = new THREE.QuaternionKeyframeTrack(
      `${odkName}.quaternion`,
      times,
      Array.from(values)
    )
    posedTracks.set(odkName, track)
    outTracks.push(track)
  }

  return outTracks
}

function findMixamoQuaternionTrack(
  clip: THREE.AnimationClip,
  odkName: string
): THREE.QuaternionKeyframeTrack | null {
  for (const track of clip.tracks) {
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) continue
    const mixamoName = track.name.split('.')[0] ?? ''
    if (resolveOdkBoneName(mixamoName) === odkName) return track
  }
  return null
}

function findMixamoBoneForOdk(scene: THREE.Object3D, odkName: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null
  scene.traverse((obj) => {
    if (found) return
    if (obj.name && resolveOdkBoneName(obj.name) === odkName) found = obj
  })
  return found
}

function applyBindMul(prepped: Float32Array, tgtBone: THREE.Object3D): Float32Array {
  qBind.copy(tgtBone.quaternion)
  const values = new Float32Array(prepped.length)
  for (let i = 0; i < prepped.length; i += 4) {
    qPrep.fromArray(prepped, i)
    qOut.copy(qBind).multiply(qPrep)
    qOut.toArray(values, i)
  }
  return values
}

function retargetPelvisPositionTrack(
  track: THREE.VectorKeyframeTrack,
  mixamoScene: THREE.Object3D,
  avatarRoot: THREE.Object3D,
  tgtBone: THREE.Object3D
): THREE.VectorKeyframeTrack {
  const mixamoScale = mixamoSceneScale(mixamoScene)
  const yScale = extractPelvisHeightMeters(avatarRoot) * mixamoScale
  const bindX = tgtBone.position.x
  const bindY = tgtBone.position.y
  const bindZ = tgtBone.position.z
  const frame0Y = track.values[1] ?? bindY

  const values = new Float32Array(track.values.length)
  for (let i = 0; i < track.values.length; i += 3) {
    values[i] = bindX
    values[i + 1] = bindY + (track.values[i + 1] - frame0Y) * yScale
    values[i + 2] = bindZ
  }

  return new THREE.VectorKeyframeTrack('pelvis.position', Array.from(track.times), Array.from(values))
}

function extendSpineChain(
  clip: THREE.AnimationClip,
  avatarRoot: THREE.Object3D,
  spine03Prep: Float32Array,
  times: number[],
  profile: OdkRetargetProfile
): void {
  for (const ext of profile.spineExtension.bones) {
    const bone = getOdkBone(avatarRoot, ext.name)
    if (!bone) continue

    const bind = bone.quaternion
    const values = new Float32Array(spine03Prep.length)

    for (let i = 0; i < spine03Prep.length; i += 4) {
      qPrep.fromArray(spine03Prep, i)
      if (ext.blend < 1) qDelta.identity().slerp(qPrep, ext.blend)
      else qDelta.copy(qPrep)
      qOut.copy(bind).multiply(qDelta)
      qOut.toArray(values, i)
    }

    clip.tracks.push(
      new THREE.QuaternionKeyframeTrack(`${ext.name}.quaternion`, times, Array.from(values))
    )
  }
}

function mirrorTwistTracks(
  clip: THREE.AnimationClip,
  avatarRoot: THREE.Object3D,
  bindLocals: Map<string, THREE.Quaternion>,
  profile: OdkRetargetProfile,
  kind: OdkClipKind
): void {
  for (const [twistBone, rule] of Object.entries(profile.twistBones)) {
    if (!shouldRetargetOdkBone(rule.parent, kind, profile)) continue
    const twist = getOdkBone(avatarRoot, twistBone)
    const parentTrack = clip.tracks.find((t) => t.name === `${rule.parent}.quaternion`)
    const parentBind = bindLocals.get(rule.parent)
    if (!twist || !parentTrack || !parentBind) continue

    qTwistBind.copy(twist.quaternion)
    const values = new Float32Array(parentTrack.values.length)

    for (let i = 0; i < parentTrack.values.length; i += 4) {
      qParentOut.fromArray(parentTrack.values, i)
      qParentBind.copy(parentBind)
      qDelta.copy(qParentBind).invert().multiply(qParentOut)
      if (rule.blend < 1) qDelta.identity().slerp(qDelta, rule.blend)
      qOut.copy(qTwistBind).multiply(qDelta)
      qOut.toArray(values, i)
    }

    clip.tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${twistBone}.quaternion`,
        Array.from((parentTrack as THREE.QuaternionKeyframeTrack).times),
        Array.from(values)
      )
    )
  }
  clip.optimize()
}

/**
 * Mixamo → ODK via UE5 mannequin profile:
 * - bindmul for spine/arms; world-delta for locomotion leg chain (UE5 pelvis axis fix)
 * - foot/ball retargeted on locomotion (ankle flex); idle omits legs
 * - spine extension + twist mirror from profile
 * - pelvis Y position (height × mixamoScale)
 */
export function retargetClipToOdk(
  clip: THREE.AnimationClip,
  mixamoScene: THREE.Object3D,
  avatarRoot: THREE.Object3D,
  profile: OdkRetargetProfile = getOdkRetargetProfile(),
  kind: OdkClipKind = 'full'
): THREE.AnimationClip {
  mixamoScene.updateWorldMatrix(true, true)
  avatarRoot.updateWorldMatrix(true, true)

  const bindLocals = new Map<string, THREE.Quaternion>()
  const tracks: THREE.KeyframeTrack[] = []
  const legWorldDelta = new Set<string>()
  let spine03Prep: Float32Array | null = null
  let spine03Times: number[] | null = null

  if (kind === 'locomotion') {
    for (const track of retargetLocomotionLegChainWorldDelta(
      clip,
      mixamoScene,
      avatarRoot,
      profile,
      kind,
      bindLocals
    )) {
      const bone = track.name.split('.')[0] ?? ''
      legWorldDelta.add(bone)
      tracks.push(track)
    }
  }

  for (const track of clip.tracks) {
    const parts = track.name.split('.')
    const trackBoneName = parts[0] ?? ''
    const prop = parts[1]

    if (
      (kind === 'locomotion' || kind === 'full') &&
      profile.pelvisPosition &&
      track instanceof THREE.VectorKeyframeTrack &&
      prop === 'position'
    ) {
      const odkName = resolveOdkBoneName(trackBoneName)
      if (odkName !== 'pelvis') continue
      const tgtBone = getOdkBone(avatarRoot, 'pelvis')
      if (!tgtBone) continue
      tracks.push(retargetPelvisPositionTrack(track, mixamoScene, avatarRoot, tgtBone))
      continue
    }

    if (!(track instanceof THREE.QuaternionKeyframeTrack) || prop !== 'quaternion') continue

    const odkName = resolveOdkBoneName(trackBoneName)
    if (!odkName || !shouldRetargetOdkBone(odkName, kind, profile)) continue
    if (legWorldDelta.has(odkName)) continue

    const srcBone = findMixamoBone(mixamoScene, trackBoneName)
    const tgtBone = getOdkBone(avatarRoot, odkName)
    if (!srcBone || !tgtBone) continue

    bindLocals.set(odkName, tgtBone.quaternion.clone())

    const prepped = prepMixamoTrack(track, mixamoScene, srcBone)

    if (odkName === profile.spineExtension.sourceBone) {
      spine03Prep = prepped
      spine03Times = Array.from(track.times)
    }

    const values = applyBindMul(prepped, tgtBone)
    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${odkName}.quaternion`,
        Array.from(track.times),
        Array.from(values)
      )
    )
  }

  const out = new THREE.AnimationClip(clip.name, clip.duration, tracks)
  if (spine03Prep && spine03Times && shouldRetargetOdkBone(profile.spineExtension.sourceBone, kind, profile)) {
    extendSpineChain(out, avatarRoot, spine03Prep, spine03Times, profile)
    for (const ext of profile.spineExtension.bones) {
      const bone = getOdkBone(avatarRoot, ext.name)
      if (bone) bindLocals.set(ext.name, bone.quaternion.clone())
    }
  }
  mirrorTwistTracks(out, avatarRoot, bindLocals, profile, kind)
  return out
}

/** Per-bone delta that maps retargeted frame 0 onto the ODK GLB bind pose. */
export function buildOdkRestCorrection(
  clip: THREE.AnimationClip,
  avatarRoot: THREE.Object3D
): Map<string, THREE.Quaternion> {
  const corrections = new Map<string, THREE.Quaternion>()
  for (const track of clip.tracks) {
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) continue
    const boneName = track.name.split('.')[0] ?? ''
    const bone = getOdkBone(avatarRoot, boneName)
    if (!bone) continue
    qAnim.fromArray(track.values, 0)
    qBind.copy(bone.quaternion)
    qCorr.copy(qBind).multiply(qAnim.invert())
    corrections.set(boneName, qCorr.clone())
  }
  return corrections
}

export function retargetAndCorrectClipToOdk(
  clip: THREE.AnimationClip,
  mixamoScene: THREE.Object3D,
  avatarRoot: THREE.Object3D,
  options?: { profile?: OdkRetargetProfile; kind?: OdkClipKind }
): THREE.AnimationClip {
  const profile = options?.profile ?? getOdkRetargetProfile()
  const kind = options?.kind ?? 'full'
  const retargeted = retargetClipToOdk(clip, mixamoScene, avatarRoot, profile, kind)
  applyOdkRestCorrection(retargeted, buildOdkRestCorrection(retargeted, avatarRoot))
  return retargeted
}

export function applyOdkRestCorrection(
  clip: THREE.AnimationClip,
  corrections: Map<string, THREE.Quaternion>
): void {
  for (const track of clip.tracks) {
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) continue
    const boneName = track.name.split('.')[0] ?? ''
    const corr = corrections.get(boneName)
    if (!corr) continue
    for (let i = 0; i < track.values.length; i += 4) {
      qAnim.fromArray(track.values, i)
      qOut.copy(corr).multiply(qAnim)
      qOut.toArray(track.values, i)
    }
  }
}

export function retargetGltfClipToOdk(
  clip: THREE.AnimationClip,
  glbScene: THREE.Object3D,
  avatarRoot: THREE.Object3D
): THREE.AnimationClip {
  glbScene.updateWorldMatrix(true, true)
  avatarRoot.updateWorldMatrix(true, true)
  return retargetClipToOdk(clip, glbScene, avatarRoot)
}

export async function loadRetargetedClipToOdk(
  url: string,
  avatarRoot: THREE.Object3D,
  options?: { correct?: boolean; kind?: OdkClipKind }
): Promise<THREE.AnimationClip> {
  const gltf = await getLoader().loadAsync(url)
  const clipIn = gltf.animations[0]
  if (!clipIn) throw new Error(`OdkRetarget: no animation in ${url}`)

  gltf.scene.updateWorldMatrix(true, true)
  avatarRoot.updateWorldMatrix(true, true)
  const kind = options?.kind ?? 'full'
  if (options?.correct === false) {
    return retargetClipToOdk(clipIn, gltf.scene, avatarRoot, getOdkRetargetProfile(), kind)
  }
  return retargetAndCorrectClipToOdk(clipIn, gltf.scene, avatarRoot, { kind })
}