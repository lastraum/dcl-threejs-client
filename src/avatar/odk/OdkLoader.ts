import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { validateOdkSkeleton } from './odkSkeleton'
import { applyMmlAttachments, type LoadedOdkAttachment } from './odkAttachments'
import type { MmlAttachmentSpec } from './parseMml'

export type ParsedOdk = {
  root: THREE.Group
  height: number
  attachments: LoadedOdkAttachment[]
}

let sharedLoader: GLTFLoader | null = null

function getLoader(): GLTFLoader {
  if (!sharedLoader) sharedLoader = new GLTFLoader()
  return sharedLoader
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

function prepScene(root: THREE.Group): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true
      obj.receiveShadow = true
    }
  })
}

export async function parseOdkBytes(
  bytes: ArrayBuffer,
  attachments?: MmlAttachmentSpec[]
): Promise<ParsedOdk> {
  const gltf = await getLoader().parseAsync(bytes, '')
  const root = gltf.scene as THREE.Group
  root.name = 'custom-odk'
  root.matrixAutoUpdate = true
  root.matrixWorldAutoUpdate = true

  const validation = validateOdkSkeleton(root)
  if (!validation.ok) {
    throw new Error(`Not a valid ODK skeleton — missing: ${validation.missing.join(', ')}`)
  }

  prepScene(root)
  root.updateWorldMatrix(true, true)

  const loadedAttachments = attachments?.length
    ? await applyMmlAttachments(root, attachments, getLoader())
    : []

  const height = measureHeight(root)
  return { root, height, attachments: loadedAttachments }
}

export function disposeOdkRoot(root?: THREE.Object3D | null): void {
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