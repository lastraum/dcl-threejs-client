import * as THREE from 'three'
import { AvatarAnimations } from '../../avatar/AvatarAnimations'
import { composeAvatarFromProfile } from '../../avatar/AvatarComposer'
import { disposeWearableInstance } from '../../avatar/loadWearable'
import { fetchProfileCached } from '../../avatar/peerApi'

/** Three.js avatar stage for the pre-world login screen (returning users). */
export class SplashAvatarPreview {
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly pivot = new THREE.Group()
  private readonly platform: THREE.Mesh
  private avatar: THREE.Group | null = null
  private animations: AvatarAnimations | null = null
  private resizeObserver: ResizeObserver | null = null
  private raf = 0
  private lastFrame = 0
  private disposed = false
  private loadToken = 0
  private subjectSize = new THREE.Vector3(1.8, 1.8, 0.8)

  constructor(private readonly host: HTMLElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'splash-screen__canvas'
    this.host.appendChild(this.canvas)

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true
    })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50)

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.72))
    const key = new THREE.DirectionalLight(0xffffff, 1.15)
    key.position.set(2.5, 4.5, 3.5)
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0xc9a0ff, 0.45)
    rim.position.set(-3, 2, -2)
    this.scene.add(rim)

    const platformGeo = new THREE.CircleGeometry(0.72, 64)
    const platformMat = new THREE.MeshStandardMaterial({
      color: 0xf0b429,
      emissive: 0x5a3d00,
      emissiveIntensity: 0.35,
      metalness: 0.55,
      roughness: 0.35
    })
    this.platform = new THREE.Mesh(platformGeo, platformMat)
    this.platform.rotation.x = -Math.PI / 2
    this.platform.position.y = 0.01
    this.scene.add(this.platform)

    const ringGeo = new THREE.RingGeometry(0.72, 0.82, 64)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x1a1030,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.rotation.x = -Math.PI / 2
    this.scene.add(ring)

    this.pivot.name = 'splash-avatar-pivot'
    this.scene.add(this.pivot)

    this.frameCamera()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.host)
    this.resize()
    this.lastFrame = performance.now()
    this.raf = requestAnimationFrame((t) => this.tick(t))
  }

  async loadProfile(address: string): Promise<void> {
    const token = ++this.loadToken
    this.clearAvatar()

    const profile = await fetchProfileCached(address)
    if (!profile || this.disposed || token !== this.loadToken) return

    const avatar = await composeAvatarFromProfile({ ...profile, address, fromWallet: true })
    if (this.disposed || token !== this.loadToken) {
      this.disposeAvatarGraph(avatar)
      return
    }

    const box = new THREE.Box3().setFromObject(avatar)
    const center = box.getCenter(new THREE.Vector3())
    avatar.position.set(-center.x, -box.min.y, -center.z)
    this.avatar = avatar
    this.pivot.add(avatar)

    this.animations = new AvatarAnimations()
    try {
      await this.animations.bind(avatar)
    } catch (err) {
      console.warn('[splash] idle emote failed', err)
      this.animations.dispose()
      this.animations = null
    }

    this.subjectSize = box.getSize(new THREE.Vector3())
    this.subjectSize.y += 0.18
    this.subjectSize.x = Math.max(this.subjectSize.x, 0.9)
    this.frameCamera()
  }

  dispose(): void {
    this.disposed = true
    this.loadToken++
    cancelAnimationFrame(this.raf)
    this.resizeObserver?.disconnect()
    this.clearAvatar()
    this.platform.geometry.dispose()
    ;(this.platform.material as THREE.Material).dispose()
    this.renderer.forceContextLoss()
    this.renderer.dispose()
    this.canvas.remove()
  }

  private tick(now: number): void {
    if (this.disposed) return
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000)
    this.lastFrame = now
    this.pivot.rotation.y += delta * 0.35
    this.animations?.update(delta, {
      horizontalSpeed: 0,
      grounded: true,
      locomotionMode: 'walk',
      jumping: false,
      doubleJumping: false,
      falling: false
    })
    this.renderer.render(this.scene, this.camera)
    this.raf = requestAnimationFrame((t) => this.tick(t))
  }

  private frameCamera(): void {
    const size = this.subjectSize
    const lookY = size.y * 0.42
    const fovRad = THREE.MathUtils.degToRad(this.camera.fov)
    const aspect = Math.max(this.camera.aspect, 0.5)
    const pad = 1.22
    const fitHeight = ((size.y + 0.35) * pad) / (2 * Math.tan(fovRad / 2))
    const fitWidth = ((size.x + 0.5) * pad) / (2 * Math.tan(fovRad / 2) * aspect)
    const distance = Math.max(fitHeight, fitWidth, 2.2)
    this.camera.position.set(0, lookY, distance)
    this.camera.lookAt(0, lookY, 0)
    this.camera.updateProjectionMatrix()
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.host
    if (w <= 0 || h <= 0) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.frameCamera()
  }

  private clearAvatar(): void {
    this.animations?.dispose()
    this.animations = null
    if (!this.avatar) return
    this.disposeAvatarGraph(this.avatar)
    this.pivot.remove(this.avatar)
    this.avatar = null
  }

  private disposeAvatarGraph(root: THREE.Object3D): void {
    disposeWearableInstance(root)
  }
}
