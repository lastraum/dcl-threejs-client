import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { collectBoneNames, getOdkBone } from './odkSkeleton'

let meshoptReady: Promise<void> | null = null
let sharedLoader: GLTFLoader | null = null

function ensureMeshopt(): Promise<void> {
  if (!meshoptReady) {
    meshoptReady = MeshoptDecoder.ready.then(() => {
      if (!sharedLoader) sharedLoader = new GLTFLoader()
      sharedLoader.setMeshoptDecoder(MeshoptDecoder)
    })
  }
  return meshoptReady
}

function getLoader(): GLTFLoader {
  if (!sharedLoader) throw new Error('[odk] MML anim loader used before meshopt init')
  return sharedLoader
}

/** Keep only tracks whose bone exists on the avatar skeleton. */
export function filterClipToOdkAvatar(
  clip: THREE.AnimationClip,
  avatarRoot: THREE.Object3D
): THREE.AnimationClip {
  const boneNames = collectBoneNames(avatarRoot)
  const tracks = clip.tracks.filter((track) => {
    const boneName = track.name.split('.')[0] ?? ''
    return boneNames.has(boneName) && getOdkBone(avatarRoot, boneName) !== null
  })
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

export async function loadMmlUeClipForOdk(
  url: string,
  avatarRoot: THREE.Object3D,
  clipName?: string
): Promise<THREE.AnimationClip> {
  await ensureMeshopt()
  const gltf = await getLoader().loadAsync(url)
  const clipIn = gltf.animations[0]
  if (!clipIn) throw new Error(`[odk] MML anim: no clip in ${url}`)

  const filtered = filterClipToOdkAvatar(clipIn, avatarRoot)
  if (clipName) filtered.name = clipName
  return filtered
}