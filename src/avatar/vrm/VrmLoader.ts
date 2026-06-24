import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'

export type ParsedVrm = {
  root: THREE.Group
  vrm: VRM
  height: number
}

const DEG2RAD = Math.PI / 180

let sharedLoader: GLTFLoader | null = null

function getLoader(): GLTFLoader {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader()
    sharedLoader.register((parser) => new VRMLoaderPlugin(parser))
  }
  return sharedLoader
}

function cleanupVrmScene(scene: THREE.Object3D): void {
  for (const node of [...scene.children]) {
    if (node.type === 'VRMExpression' || node.name === 'VRMHumanoidRig' || node.name === 'secondary') {
      node.removeFromParent()
    }
  }
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true
      obj.receiveShadow = true
    }
  })
}

function poseArmsDown(vrm: VRM): void {
  const leftUpperArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm')
  const rightUpperArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm')
  if (leftUpperArm) leftUpperArm.rotation.z = 75 * DEG2RAD
  if (rightUpperArm) rightUpperArm.rotation.z = -75 * DEG2RAD
  vrm.humanoid.update()
}

function measureHeight(scene: THREE.Object3D): number {
  let height = 0.5
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh)) return
    obj.computeBoundingBox()
    if (obj.boundingBox && obj.boundingBox.max.y > height) {
      height = obj.boundingBox.max.y
    }
  })
  return height
}

export async function parseVrmBytes(bytes: ArrayBuffer): Promise<ParsedVrm> {
  const gltf = await getLoader().parseAsync(bytes, '')
  const vrm = gltf.userData.vrm as VRM | undefined
  if (!vrm) throw new Error('File is not a valid VRM')

  VRMUtils.removeUnnecessaryVertices(gltf.scene)
  VRMUtils.removeUnnecessaryJoints(gltf.scene)

  const root = gltf.scene as THREE.Group
  root.name = 'custom-vrm'
  root.matrixAutoUpdate = true
  root.matrixWorldAutoUpdate = true

  cleanupVrmScene(root)
  poseArmsDown(vrm)

  root.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh) {
      obj.bindMode = THREE.DetachedBindMode
      obj.bindMatrix.copy(obj.matrixWorld)
      obj.bindMatrixInverse.copy(obj.bindMatrix).invert()
    }
  })

  const height = measureHeight(root)
  return { root, vrm, height }
}

export function disposeVrmRoot(vrm: VRM | null, root?: THREE.Object3D | null): void {
  if (vrm) {
    VRMUtils.deepDispose(vrm.scene)
    return
  }
  if (!root) return
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry?.dispose()
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const mat of mats) mat?.dispose()
    }
  })
  root.removeFromParent()
}