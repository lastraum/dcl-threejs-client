import * as THREE from 'three'
import { alignPreviewAvatarToGround } from '../../../avatar/avatarPreviewAlign'
import { AvatarAnimations } from '../../../avatar/AvatarAnimations'
import { composeAvatarFromProfile } from '../../../avatar/AvatarComposer'
import { disposeWearableInstance } from '../../../avatar/loadWearable'
import type { AvatarProfile } from '../../../avatar/types'

export type AvatarPreviewOptions = {
  /** Values above 1 move the camera closer (larger subject). Default 1. */
  zoom?: number
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
  private previewOptions: AvatarPreviewOptions = {}
  private raf = 0
  private lastFrame = 0
  private disposed = false
  private resizeObserver: ResizeObserver | null = null

  constructor(stage: HTMLElement) {
    this.stage = stage
  }

  async showProfile(
    profile: AvatarProfile,
    contentUrl?: string,
    options: AvatarPreviewOptions = {}
  ): Promise<void> {
    this.previewOptions = options
    this.clear()
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'user-profile-modal__avatar-canvas'
    this.stage.appendChild(this.canvas)

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100)

    const hemi = new THREE.HemisphereLight(0xffffff, 0x2a1a44, 1.1)
    this.scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffffff, 0.9)
    key.position.set(2, 4, 3)
    this.scene.add(key)

    this.pivot = new THREE.Group()
    this.scene.add(this.pivot)

    try {
      this.avatar = await composeAvatarFromProfile(profile, contentUrl)
      this.subjectSize = alignPreviewAvatarToGround(this.avatar, 'dcl')
      this.pivot.add(this.avatar)
      this.animations = new AvatarAnimations()
      await this.animations.bind(this.avatar, this.pivot, {
        bodyShape: profile.bodyShape,
        peerUrl: contentUrl,
        assetCache: undefined
      })
      this.animations.update(0, {
        horizontalSpeed: 0,
        grounded: true,
        nearGround: true,
        verticalVelocity: 0,
        locomotionMode: 'jog',
        jumping: false,
        doubleJumping: false,
        doubleJumpTriggered: false,
        falling: false
      })
    } catch (err) {
      console.warn('[profile] avatar preview failed', err)
    }

    this.resize()
    this.frameCamera()
    this.resizeObserver = new ResizeObserver(() => {
      this.resize()
      this.frameCamera()
    })
    this.resizeObserver.observe(this.stage)
    this.lastFrame = performance.now()
    this.tick()
  }

  clear(): void {
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

  private frameCamera(): void {
    if (!this.camera || !this.subjectSize) return
    const size = this.subjectSize
    const lookY = size.y * 0.42
    const fovRad = THREE.MathUtils.degToRad(this.camera.fov)
    const aspect = Math.max(this.camera.aspect, 0.35)
    const zoom = Math.max(0.5, this.previewOptions.zoom ?? 1)
    const pad = 1.28 / zoom
    const fitHeight = ((size.y + 0.35) * pad) / (2 * Math.tan(fovRad / 2))
    const fitWidth = ((size.x + 0.5) * pad) / (2 * Math.tan(fovRad / 2) * aspect)
    const distance = Math.max(fitHeight, fitWidth, 2.4)
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
    this.animations?.update(delta, {
      horizontalSpeed: 0,
      grounded: true,
      nearGround: true,
      verticalVelocity: 0,
      locomotionMode: 'jog',
      jumping: false,
      doubleJumping: false,
      doubleJumpTriggered: false,
      falling: false
    })
    if (this.pivot) this.pivot.rotation.y += delta * 0.35
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera)
    }
  }
}