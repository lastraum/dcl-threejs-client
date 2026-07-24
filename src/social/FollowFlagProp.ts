/**
 * Tour leader flag: circular image badge above the nametag (not a flagpole).
 * Posed from feet world position + nametag world Y.
 */
import * as THREE from 'three'

/** Diameter of the circular badge (world metres). */
const BADGE_DIAMETER = 0.42
/** Gap between nametag top and badge bottom (world metres). */
const ABOVE_NAMETAG_GAP = 0.12
/** Fallback nametag height when no anchor is available (typical head + CSS2D). */
const DEFAULT_NAMETAG_Y = 1.95

const _up = new THREE.Vector3(0, 1, 0)
const _camDir = new THREE.Vector3()
const _quat = new THREE.Quaternion()

export class FollowFlagProp {
  readonly root: THREE.Group
  private readonly disc: THREE.Mesh
  private readonly discMat: THREE.MeshBasicMaterial
  private texture: THREE.Texture | null = null
  private disposed = false
  private hasImage = false

  constructor() {
    this.root = new THREE.Group()
    this.root.name = 'follow-tour-flag'
    this.root.visible = false
    this.root.renderOrder = 4

    // Soft circular alpha via radial gradient canvas so any flag image is masked.
    this.discMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      alphaTest: 0.08
    })
    const geo = new THREE.CircleGeometry(BADGE_DIAMETER * 0.5, 48)
    this.disc = new THREE.Mesh(geo, this.discMat)
    this.root.add(this.disc)
  }

  setImageDataUrl(dataUrl: string | null): void {
    if (this.disposed) return
    this.disposeTexture()
    this.hasImage = false
    if (!dataUrl) {
      this.discMat.map = null
      this.discMat.needsUpdate = true
      this.root.visible = false
      return
    }
    const loader = new THREE.TextureLoader()
    loader.load(
      dataUrl,
      (tex) => {
        if (this.disposed) {
          tex.dispose()
          return
        }
        this.disposeTexture()
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = 4
        // Circle-mask the image into a canvas so non-square flags still look round.
        const masked = maskTextureCircular(tex)
        if (masked) {
          tex.dispose()
          this.texture = masked
          this.discMat.map = masked
        } else {
          this.texture = tex
          this.discMat.map = tex
        }
        this.discMat.color.setHex(0xffffff)
        this.discMat.needsUpdate = true
        this.hasImage = true
        this.root.visible = true
      },
      undefined,
      () => {
        this.discMat.map = null
        this.discMat.color.setHex(0xaa3344)
        this.discMat.needsUpdate = true
        this.hasImage = true
        this.root.visible = true
      }
    )
  }

  /**
   * Pose badge above the nametag height.
   * @param feetWorld — CCT / peer feet world position
   * @param nametagWorldY — absolute world Y of the nametag anchor (top of head area)
   * @param camera — optional; disc billboards toward camera
   */
  updateAboveNametag(
    feetWorld: THREE.Vector3,
    nametagWorldY: number | null,
    camera: THREE.Camera | null,
    _dt: number
  ): boolean {
    if (this.disposed || !this.hasImage) {
      this.root.visible = false
      return false
    }
    this.root.visible = true

    const tagY =
      nametagWorldY != null && Number.isFinite(nametagWorldY)
        ? nametagWorldY
        : feetWorld.y + DEFAULT_NAMETAG_Y
    // Place center of disc so bottom of circle sits above nametag.
    const centerY = tagY + ABOVE_NAMETAG_GAP + BADGE_DIAMETER * 0.5
    this.root.position.set(feetWorld.x, centerY, feetWorld.z)

    if (camera) {
      camera.getWorldPosition(_camDir)
      _camDir.sub(this.root.position).normalize()
      // Billboard: face camera, keep upright.
      this.root.lookAt(camera.getWorldPosition(new THREE.Vector3()))
      // Stabilise roll
      this.root.up.copy(_up)
    } else {
      this.root.quaternion.identity()
    }
    void _quat
    return true
  }

  /** @deprecated use updateAboveNametag */
  updateFromCct(feetWorld: THREE.Vector3, _yaw: number, dt: number): boolean {
    return this.updateAboveNametag(feetWorld, null, null, dt)
  }

  setVisible(v: boolean): void {
    this.root.visible = v && this.hasImage
  }

  dispose(): void {
    this.disposed = true
    this.disposeTexture()
    this.root.removeFromParent()
    this.disc.geometry.dispose()
    this.discMat.dispose()
  }

  private disposeTexture(): void {
    if (this.texture) {
      this.texture.dispose()
      this.texture = null
    }
    this.discMat.map = null
  }
}

function maskTextureCircular(src: THREE.Texture): THREE.Texture | null {
  try {
    const img = src.image as
      | HTMLImageElement
      | HTMLCanvasElement
      | ImageBitmap
      | undefined
    if (!img) return null
    const w = 'width' in img ? Number(img.width) : 0
    const h = 'height' in img ? Number(img.height) : 0
    if (!w || !h) return null
    const size = Math.min(256, Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const scale = size / Math.max(w, h)
    const dw = w * scale
    const dh = h * scale
    ctx.save()
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
    ctx.closePath()
    ctx.clip()
    ctx.drawImage(img as CanvasImageSource, (size - dw) / 2, (size - dh) / 2, dw, dh)
    ctx.restore()
    // Soft edge
    const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.42, size / 2, size / 2, size * 0.5)
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, 'rgba(0,0,0,1)')
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    return tex
  } catch {
    return null
  }
}
