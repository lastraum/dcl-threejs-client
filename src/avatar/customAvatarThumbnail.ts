import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import { VrmAvatar } from './vrm/VrmAvatar'
import { OdkAvatar } from './odk/OdkAvatar'
import { alignPreviewAvatarToGround } from './avatarPreviewAlign'
import type { CustomAvatarFormat } from './vrm/constants'
import type { MmlAttachmentSpec } from './odk/parseMml'

const THUMB_SIZE = 256

function frameThumbCamera(camera: THREE.PerspectiveCamera, size: THREE.Vector3): void {
  const lookY = size.y * 0.44
  const fovRad = THREE.MathUtils.degToRad(camera.fov)
  const fitHeight = ((size.y + 0.2) * 0.94) / (2 * Math.tan(fovRad / 2))
  const fitWidth = ((size.x + 0.35) * 0.94) / (2 * Math.tan(fovRad / 2))
  const distance = Math.max(fitHeight, fitWidth, 1.35)
  camera.position.set(0.08, lookY, distance)
  camera.lookAt(0.08, lookY, 0)
  camera.updateProjectionMatrix()
}

export async function renderCustomAvatarThumbnail(
  bytes: ArrayBuffer,
  format: CustomAvatarFormat,
  attachments?: MmlAttachmentSpec[]
): Promise<string> {
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true
  })
  renderer.setSize(THUMB_SIZE, THUMB_SIZE, false)
  renderer.setPixelRatio(1)
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 40)
  scene.add(new THREE.AmbientLight(0xffffff, 0.78))
  const key = new THREE.DirectionalLight(0xffffff, 1.05)
  key.position.set(2, 4, 3)
  scene.add(key)

  const pivot = new THREE.Group()
  scene.add(pivot)

  let root: THREE.Object3D | null = null
  let vrm: VRM | undefined
  let dispose: (() => void) | null = null

  try {
    if (format === 'odk') {
      const odk = await OdkAvatar.fromBytes(bytes, attachments)
      root = odk.root
      vrm = undefined
      dispose = () => odk.dispose()
    } else {
      const avatar = await VrmAvatar.fromBytes(bytes)
      root = avatar.root
      vrm = avatar.vrm
      dispose = () => avatar.dispose()
    }

    pivot.add(root)
    const size = alignPreviewAvatarToGround(root, format, vrm)
    frameThumbCamera(camera, size)
    renderer.render(scene, camera)
    return renderer.domElement.toDataURL('image/png')
  } finally {
    if (root) pivot.remove(root)
    dispose?.()
    renderer.dispose()
  }
}