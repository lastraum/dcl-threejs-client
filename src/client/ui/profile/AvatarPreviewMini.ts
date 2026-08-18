import * as THREE from 'three'
import { alignPreviewAvatarToGround } from '../../../avatar/avatarPreviewAlign'
import { AvatarAnimations, type AvatarLocomotionState } from '../../../avatar/AvatarAnimations'
import { composeAvatarFromProfile } from '../../../avatar/AvatarComposer'
import { disposeWearableInstance } from '../../../avatar/loadWearable'
import { prepareAvatarMaterials } from '../../../avatar/materials'
import type { AvatarProfile } from '../../../avatar/types'

/**
 * Isolated preview is not the world IBL stage. Three r155+ lights are physical
 * (old 1.0 ≈ π now). Explorer wearable-preview is high-fill matte — without
 * ambient + stronger keys, MeshStandard avatars render as a black silhouette.
 */
function addAvatarPreviewLights(scene: THREE.Scene): void {
  scene.add(new THREE.AmbientLight(0xffffff, 2.2))
  const hemi = new THREE.HemisphereLight(0xffffff, 0x6a5a88, 1.6)
  scene.add(hemi)
  const key = new THREE.DirectionalLight(0xffffff, 3.2)
  key.position.set(2.4, 4.2, 3.2)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xfff4e8, 1.4)
  fill.position.set(-2.2, 2.4, 1.6)
  scene.add(fill)
  const rim = new THREE.DirectionalLight(0xc9a0ff, 1.1)
  rim.position.set(-2.6, 2.2, -2.4)
  scene.add(rim)
}

/** Second WebGL context — upload maps here or they stay black until a later hitch. */
function bindPreviewTextures(renderer: THREE.WebGLRenderer, root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return
    const mats = Array.isArray((obj as THREE.Mesh).material)
      ? ((obj as THREE.Mesh).material as THREE.Material[])
      : [(obj as THREE.Mesh).material]
    for (const mat of mats) {
      if (!mat) continue
      const slots = [
        (mat as THREE.MeshStandardMaterial).map,
        (mat as THREE.MeshStandardMaterial).emissiveMap,
        (mat as THREE.MeshStandardMaterial).normalMap,
        (mat as THREE.MeshStandardMaterial).alphaMap
      ]
      for (const tex of slots) {
        if (tex) renderer.initTexture(tex)
      }
    }
  })
}

export type AvatarPreviewOptions = {
  /** Values above 1 move the camera closer (larger subject). Default 1. */
  zoom?: number
}

/** Standing still on the ground — the only state a profile preview ever plays. */
const PREVIEW_LOCOMOTION: AvatarLocomotionState = {
  horizontalSpeed: 0,
  grounded: true,
  nearGround: true,
  verticalVelocity: 0,
  locomotionMode: 'jog',
  jumping: false,
  doubleJumping: false,
  doubleJumpTriggered: false,
  falling: false
}

/** Compact 3D avatar preview for profile modals. */
export class AvatarPreviewMini {
  private readonly stage: HTMLElement
  private canvas: HTMLCanvasElement | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private pivot: THREE.Group | null = null
  private avatar: THREE.Group | null = null
  private animations: AvatarAnimations | null = null
  private subjectSize: THREE.Vector3 | null = null
  private subjectCenterY = 0
  private previewOptions: AvatarPreviewOptions = {}
  private raf = 0
  private lastFrame = 0
  private disposed = false
  private resizeObserver: ResizeObserver | null = null
  /** Bumped by every clear()/dispose() so in-flight loads can bail out. */
  private showToken = 0

  constructor(stage: HTMLElement) {
    this.stage = stage
  }

  /** Resolves true once an avatar is on the stage, false if the load failed or was superseded. */
  async showProfile(
    profile: AvatarProfile,
    contentUrl?: string,
    options: AvatarPreviewOptions = {}
  ): Promise<boolean> {
    this.clear()
    const token = this.showToken
    this.previewOptions = options
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'user-profile-modal__avatar-canvas'
    this.stage.appendChild(this.canvas)

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true
    })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100)
    addAvatarPreviewLights(this.scene)

    this.pivot = new THREE.Group()
    this.scene.add(this.pivot)

    let avatar: THREE.Group | null = null
    try {
      avatar = await composeAvatarFromProfile(profile, contentUrl)
    } catch (err) {
      console.warn('[profile] avatar preview failed', err)
    }

    // A second showProfile() (or a close) landed while the wearables loaded —
    // drop this one instead of stacking a canvas and a render loop on the stage.
    if (token !== this.showToken) {
      if (avatar) disposeWearableInstance(avatar)
      return false
    }
    if (!avatar) return false

    this.avatar = avatar
    prepareAvatarMaterials(avatar)
    if (this.renderer) bindPreviewTextures(this.renderer, avatar)
    const alignedSize = alignPreviewAvatarToGround(avatar, 'dcl')
    this.subjectSize = alignedSize
    this.subjectCenterY = alignedSize.y * 0.5
    this.pivot.add(avatar)
    await this.bindAnimations(avatar, profile, contentUrl, token)
    if (token !== this.showToken) return false
    // Measure once the idle pose is applied, so the frame matches the render.
    this.measureRenderedSubject(avatar)

    this.resize()
    this.frameCamera()
    this.resizeObserver = new ResizeObserver(() => {
      this.resize()
      this.frameCamera()
    })
    this.resizeObserver.observe(this.stage)
    this.lastFrame = performance.now()
    this.tick()
    return true
  }

  /**
   * Bind idle locomotion, retrying once: bind() throws when the idle clip loses
   * a load race, and an unbound avatar renders in its T-pose bind pose.
   */
  private async bindAnimations(
    avatar: THREE.Group,
    profile: AvatarProfile,
    contentUrl: string | undefined,
    token: number
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const animations = new AvatarAnimations()
      try {
        await animations.bind(avatar, this.pivot ?? avatar, {
          bodyShape: profile.bodyShape,
          peerUrl: contentUrl,
          assetCache: undefined
        })
        if (token !== this.showToken) {
          animations.dispose()
          return
        }
        this.animations = animations
        animations.update(0, PREVIEW_LOCOMOTION)
        return
      } catch (err) {
        animations.dispose()
        if (token !== this.showToken) return
        if (attempt === 1) {
          console.warn('[profile] avatar preview idle animation unavailable', err)
          return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 200))
        if (token !== this.showToken) return
      }
    }
  }

  /**
   * Bounds of what is actually drawn. Box3.setFromObject counts hidden meshes —
   * basemeshes covered by wearables and `collider` proxies both stay in the graph
   * with visible = false — and reads each skinned mesh's bind-pose box rather than
   * the posed skeleton. Both inflate the subject by an amount that varies with the
   * outfit, which framed heavily-covered avatars smaller than lightly-covered ones.
   */
  private measureRenderedSubject(avatar: THREE.Group): void {
    const box = new THREE.Box3()
    const meshBox = new THREE.Box3()
    avatar.updateWorldMatrix(true, true)
    avatar.traverseVisible((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      const skinned = mesh as THREE.SkinnedMesh
      if (skinned.isSkinnedMesh) {
        // Cached boundingBox is the bind pose — recompute against current bones.
        skinned.computeBoundingBox()
        if (!skinned.boundingBox) return
        meshBox.copy(skinned.boundingBox)
      } else {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
        if (!mesh.geometry.boundingBox) return
        meshBox.copy(mesh.geometry.boundingBox)
      }
      meshBox.applyMatrix4(mesh.matrixWorld)
      box.union(meshBox)
    })
    if (box.isEmpty()) return

    const height = box.max.y - box.min.y
    if (height <= 0) return
    // The preview spins, so reserve the wider of the two horizontal extents.
    const horizontal = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 0.5)
    this.subjectSize = new THREE.Vector3(horizontal, height, horizontal)
    this.subjectCenterY = (box.max.y + box.min.y) * 0.5
  }

  clear(): void {
    this.showToken++
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.animations?.dispose()
    this.animations = null
    if (this.avatar) {
      disposeWearableInstance(this.avatar)
      this.avatar = null
    }
    this.subjectSize = null
    this.subjectCenterY = 0
    this.previewOptions = {}
    this.pivot?.clear()
    this.pivot = null
    this.scene?.clear()
    this.scene = null
    this.renderer?.dispose()
    this.renderer = null
    this.canvas?.remove()
    this.canvas = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clear()
  }

  private resize(): void {
    if (!this.renderer || !this.camera || !this.canvas) return
    const w = Math.max(1, this.stage.clientWidth)
    const h = Math.max(1, this.stage.clientHeight)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /**
   * Fill the stage: fit the subject's own extents with a small margin, aimed at
   * its mid-height. Aiming low (0.42) and padding for absent props used to leave
   * the avatar at ~two thirds of the stage with dead space under the feet.
   */
  private frameCamera(): void {
    if (!this.camera || !this.subjectSize) return
    const size = this.subjectSize
    const lookY = this.subjectCenterY
    const fovRad = THREE.MathUtils.degToRad(this.camera.fov)
    const aspect = Math.max(this.camera.aspect, 0.35)
    const zoom = Math.max(0.5, this.previewOptions.zoom ?? 1)
    // 6% breathing room around the subject; zoom > 1 tightens into a crop.
    const margin = 1.06 / zoom
    const fitHeight = (size.y * margin) / (2 * Math.tan(fovRad / 2))
    const fitWidth = (size.x * margin) / (2 * Math.tan(fovRad / 2) * aspect)
    const distance = Math.max(fitHeight, fitWidth, 1.2)
    this.camera.position.set(0, lookY, distance)
    this.camera.lookAt(0, lookY, 0)
    this.camera.updateProjectionMatrix()
  }

  private tick = (): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.tick)
    const now = performance.now()
    const delta = Math.min((now - this.lastFrame) / 1000, 0.05)
    this.lastFrame = now
    this.animations?.update(delta, PREVIEW_LOCOMOTION)
    if (this.pivot) this.pivot.rotation.y += delta * 0.35
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera)
    }
  }
}