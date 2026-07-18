import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'

export type ParsedVrm = {
  root: THREE.Group
  vrm: VRM
  height: number
}

let sharedLoader: GLTFLoader | null = null

function getLoader(): GLTFLoader {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader()
    sharedLoader.register(
      (parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: false })
    )
  }
  return sharedLoader
}

/**
 * Skinned VRM/ODK meshes often cull incorrectly after mixer/pivot (bind-pose
 * bounding spheres). Force double-sided + no frustum cull so equip is not blank.
 */
export function prepareCustomAvatarScene(scene: THREE.Object3D): void {
  scene.visible = true
  scene.traverse((obj) => {
    obj.visible = true
    if (!(obj instanceof THREE.Mesh)) return
    obj.castShadow = true
    obj.receiveShadow = true
    obj.frustumCulled = false
    if (obj instanceof THREE.SkinnedMesh) {
      obj.skeleton?.update()
      obj.geometry?.computeBoundingSphere()
      obj.geometry?.computeBoundingBox()
    }
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of materials) {
      if (!mat) continue
      mat.visible = true
      mat.side = THREE.DoubleSide
      // MToon / standard — avoid fully transparent leftover flags from export tools.
      if ('transparent' in mat && (mat as THREE.Material & { opacity?: number }).opacity === 0) {
        ;(mat as THREE.Material & { opacity: number }).opacity = 1
        mat.transparent = false
      }
      mat.needsUpdate = true
    }
  })
}

function cleanupVrmScene(scene: THREE.Object3D): void {
  for (const node of [...scene.children]) {
    if (node.type === 'VRMExpression' || node.name === 'VRMHumanoidRig' || node.name === 'secondary') {
      node.removeFromParent()
    }
  }
  prepareCustomAvatarScene(scene)
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

  VRMUtils.rotateVRM0(vrm)

  const root = gltf.scene as THREE.Group
  root.name = 'custom-vrm'
  root.matrixAutoUpdate = true
  root.matrixWorldAutoUpdate = true

  cleanupVrmScene(root)
  root.updateWorldMatrix(true, true)

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