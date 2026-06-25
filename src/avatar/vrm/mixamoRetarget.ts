import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMHumanBoneName, type VRM } from '@pixiv/three-vrm'

const q1 = new THREE.Quaternion()
const restRotationInverse = new THREE.Quaternion()
const parentRestWorldRotation = new THREE.Quaternion()

/** Mixamo bone names → VRM humanoid keys (genesis-games / Hyperfy). */
const TO_VRM: Record<string, string> = {
  Hips: 'hips',
  Spine: 'spine',
  Spine1: 'chest',
  Spine2: 'upperChest',
  Neck: 'neck',
  Head: 'head',
  LeftShoulder: 'leftShoulder',
  LeftArm: 'leftUpperArm',
  LeftForeArm: 'leftLowerArm',
  LeftHand: 'leftHand',
  RightShoulder: 'rightShoulder',
  RightArm: 'rightUpperArm',
  RightForeArm: 'rightLowerArm',
  RightHand: 'rightHand',
  LeftUpLeg: 'leftUpperLeg',
  LeftLeg: 'leftLowerLeg',
  LeftFoot: 'leftFoot',
  LeftToeBase: 'leftToes',
  RightUpLeg: 'rightUpperLeg',
  RightLeg: 'rightLowerLeg',
  RightFoot: 'rightFoot',
  RightToeBase: 'rightToes',
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes'
}

let sharedLoader: GLTFLoader | null = null

function getLoader(): GLTFLoader {
  if (!sharedLoader) sharedLoader = new GLTFLoader()
  return sharedLoader
}

function filterAndPrepClip(clip: THREE.AnimationClip, glbScene: THREE.Object3D, yOffsetScale: number): void {
  clip.tracks = clip.tracks.filter((track) => {
    if (track instanceof THREE.VectorKeyframeTrack) {
      const [, type] = track.name.split('.')
      if (type !== 'position') return false
      const [name] = track.name.split('.')
      return name === 'Root' || name === 'mixamorigHips'
    }
    return true
  })

  const scale =
    glbScene.children[0]?.scale.x && glbScene.children[0].scale.x > 1e-6
      ? glbScene.children[0].scale.x
      : 1
  const yOffset = (-0.05 / scale) * yOffsetScale

  clip.tracks.forEach((track) => {
    const rigName = track.name.split('.')[0]
    const node = glbScene.getObjectByName(rigName)
    if (!node) return
    node.getWorldQuaternion(restRotationInverse).invert()
    const parent = node.parent
    if (parent) parent.getWorldQuaternion(parentRestWorldRotation)
    else parentRestWorldRotation.identity()

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      for (let i = 0; i < track.values.length; i += 4) {
        const slice = track.values.slice(i, i + 4)
        q1.fromArray(slice)
        q1.premultiply(parentRestWorldRotation).multiply(restRotationInverse)
        q1.toArray(slice)
        slice.forEach((v, j) => {
          track.values[i + j] = v
        })
      }
    } else if (track instanceof THREE.VectorKeyframeTrack && yOffset !== 0) {
      track.values = track.values.map((v, idx) => (idx % 3 === 1 ? v + yOffset : v))
    }
  })
  clip.optimize()
}

export function extractRootToHipsMeters(vrm: VRM): number {
  const hips = vrm.humanoid.getRawBoneNode(VRMHumanBoneName.Hips)
  if (!hips) return 1
  vrm.scene.updateWorldMatrix(true, true)
  return hips.getWorldPosition(new THREE.Vector3()).y
}

export function retargetClipToVrm(
  clip: THREE.AnimationClip,
  glbScene: THREE.Object3D,
  vrm: VRM,
  rootToHips: number,
  metaVersion: string | undefined
): THREE.AnimationClip {
  const scale =
    glbScene.children[0]?.scale.x && glbScene.children[0].scale.x > 1e-6
      ? glbScene.children[0].scale.x
      : 1
  const scaler = rootToHips * scale
  const isV0 = metaVersion === '0'

  const getBoneName = (vrmKey: string): string | undefined => {
    return vrm.humanoid.getRawBoneNode(vrmKey as VRMHumanBoneName)?.name
  }

  const tracks: THREE.KeyframeTrack[] = []
  for (const track of clip.tracks) {
    const parts = track.name.split('.')
    const vrmKey = TO_VRM[parts[0] ?? '']
    if (!vrmKey) continue
    const nodeName = getBoneName(vrmKey)
    if (!nodeName) continue
    const prop = parts[1]

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${nodeName}.${prop}`,
          Array.from(track.times),
          Array.from(track.values, (v, i) => (isV0 && i % 2 === 0 ? -v : v))
        )
      )
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      tracks.push(
        new THREE.VectorKeyframeTrack(
          `${nodeName}.${prop}`,
          Array.from(track.times),
          Array.from(track.values, (v, i) => {
            const scaled = (isV0 && i % 3 !== 1 ? -v : v) * scaler
            return scaled
          })
        )
      )
    }
  }

  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

/** Retarget a loaded emote GLB (DCL / Mixamo bone names) onto a VRM skeleton. */
export function retargetGltfClipToVrm(
  clip: THREE.AnimationClip,
  glbScene: THREE.Object3D,
  vrm: VRM
): THREE.AnimationClip {
  glbScene.updateWorldMatrix(true, true)
  const prepared = clip.clone()
  filterAndPrepClip(prepared, glbScene, 1)
  const rootToHips = extractRootToHipsMeters(vrm)
  return retargetClipToVrm(prepared, glbScene, vrm, rootToHips, vrm.meta?.metaVersion)
}

export async function loadRetargetedClip(url: string, vrm: VRM): Promise<THREE.AnimationClip> {
  const gltf = await getLoader().loadAsync(url)
  const clipIn = gltf.animations[0]
  if (!clipIn) throw new Error(`MixamoRetarget: no animation in ${url}`)

  gltf.scene.updateWorldMatrix(true, true)
  const clip = clipIn.clone()
  filterAndPrepClip(clip, gltf.scene, 1)
  const rootToHips = extractRootToHipsMeters(vrm)
  return retargetClipToVrm(clip, gltf.scene, vrm, rootToHips, vrm.meta?.metaVersion)
}