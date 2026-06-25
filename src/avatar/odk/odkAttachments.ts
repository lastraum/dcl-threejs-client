import * as THREE from 'three'
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { MmlAttachmentSpec } from './parseMml'
import { getOdkBone } from './odkSkeleton'
import { fetchUrlBytes } from './parseMml'

export type LoadedOdkAttachment = {
  spec: MmlAttachmentSpec
  object: THREE.Object3D
}

const DEG2RAD = Math.PI / 180

function applyMmlTransform(obj: THREE.Object3D, t: MmlAttachmentSpec['transform']): void {
  obj.position.set(t.x, t.y, t.z)
  obj.rotation.set(t.rx * DEG2RAD, t.ry * DEG2RAD, t.rz * DEG2RAD)
  obj.scale.set(t.sx, t.sy, t.sz)
}

export async function applyMmlAttachments(
  avatarRoot: THREE.Object3D,
  specs: MmlAttachmentSpec[],
  loader: GLTFLoader
): Promise<LoadedOdkAttachment[]> {
  const loaded: LoadedOdkAttachment[] = []

  for (const spec of specs) {
    const bytes = await fetchUrlBytes(spec.src)
    const gltf = await loader.parseAsync(bytes, '')
    const object = gltf.scene
    object.name = `mml-attachment:${spec.socket ?? 'root'}`
    applyMmlTransform(object, spec.transform)

    if (spec.socket) {
      const bone = getOdkBone(avatarRoot, spec.socket)
      if (bone) {
        bone.add(object)
      } else {
        console.warn(`[odk] attachment socket not found: ${spec.socket}`)
        avatarRoot.add(object)
      }
    } else {
      avatarRoot.add(object)
    }

    loaded.push({ spec, object })
  }

  avatarRoot.updateWorldMatrix(true, true)
  return loaded
}