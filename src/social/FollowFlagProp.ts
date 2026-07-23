/**
 * Tour leader flag: pole + banner mesh, posed each frame from avatar spine bone.
 */
import * as THREE from 'three'
import {
  AAPT_SPINE2,
  AAPT_SPINE1,
  AAPT_SPINE,
  sampleAvatarAttachAnchor
} from '../avatar/avatarAttachAnchors'

const POLE_HEIGHT = 0.95
const POLE_RADIUS = 0.018
const FLAG_W = 0.48
const FLAG_H = 0.32
/** Spine-local offset: slightly up, right, and back of torso. */
const SPINE_LOCAL_OFFSET = new THREE.Vector3(0.14, 0.22, -0.06)

const _offset = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _forward = new THREE.Vector3()
const _right = new THREE.Vector3()
const _look = new THREE.Matrix4()
const _quat = new THREE.Quaternion()

export class FollowFlagProp {
  readonly root: THREE.Group
  private readonly pole: THREE.Mesh
  private readonly flag: THREE.Mesh
  private readonly flagMat: THREE.MeshBasicMaterial
  private texture: THREE.Texture | null = null
  private flutterT = 0
  private disposed = false

  constructor() {
    this.root = new THREE.Group()
    this.root.name = 'follow-tour-flag'
    this.root.visible = false
    this.root.renderOrder = 2

    const poleGeo = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS * 1.15, POLE_HEIGHT, 8)
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0xc4a574,
      metalness: 0.15,
      roughness: 0.65
    })
    this.pole = new THREE.Mesh(poleGeo, poleMat)
    this.pole.position.y = POLE_HEIGHT * 0.5
    this.pole.castShadow = false
    this.root.add(this.pole)

    // Knob
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(POLE_RADIUS * 1.8, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xe8d5a3, metalness: 0.35, roughness: 0.4 })
    )
    knob.position.y = POLE_HEIGHT
    this.root.add(knob)

    this.flagMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true
    })
    const flagGeo = new THREE.PlaneGeometry(FLAG_W, FLAG_H, 6, 4)
    this.flag = new THREE.Mesh(flagGeo, this.flagMat)
    // Hang from top of pole, extending +X (right of pole in local space)
    this.flag.position.set(FLAG_W * 0.5 + POLE_RADIUS, POLE_HEIGHT - FLAG_H * 0.5, 0)
    this.root.add(this.flag)
  }

  setImageDataUrl(dataUrl: string | null): void {
    if (this.disposed) return
    this.disposeTexture()
    if (!dataUrl) {
      this.flagMat.map = null
      this.flagMat.color.setHex(0xaa3344)
      this.flagMat.needsUpdate = true
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
        this.texture = tex
        this.flagMat.map = tex
        this.flagMat.color.setHex(0xffffff)
        this.flagMat.needsUpdate = true
        this.root.visible = true
      },
      undefined,
      () => {
        // Fallback solid if decode fails
        this.flagMat.map = null
        this.flagMat.color.setHex(0xaa3344)
        this.flagMat.needsUpdate = true
        this.root.visible = true
      }
    )
  }

  /**
   * Pose flag from avatar model spine. Returns false if bone missing.
   */
  updateFromAvatar(model: THREE.Object3D, dt: number): boolean {
    if (this.disposed || !this.root.visible) return false
    const pose =
      sampleAvatarAttachAnchor(model, AAPT_SPINE2) ??
      sampleAvatarAttachAnchor(model, AAPT_SPINE1) ??
      sampleAvatarAttachAnchor(model, AAPT_SPINE)
    if (!pose) return false

    _offset.copy(SPINE_LOCAL_OFFSET).applyQuaternion(pose.quaternion)
    this.root.position.copy(pose.position).add(_offset)

    // Keep pole world-up; yaw from avatar facing (spine forward ≈ -Z in many rigs).
    _forward.set(0, 0, 1).applyQuaternion(pose.quaternion)
    _forward.y = 0
    if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, 1)
    else _forward.normalize()
    _right.crossVectors(_up, _forward).normalize()
    _forward.crossVectors(_right, _up).normalize()
    _look.makeBasis(_right, _up, _forward)
    _quat.setFromRotationMatrix(_look)
    this.root.quaternion.copy(_quat)

    // Gentle flutter
    this.flutterT += dt
    const wave = Math.sin(this.flutterT * 3.2) * 0.08
    this.flag.rotation.y = wave
    this.flag.rotation.z = Math.sin(this.flutterT * 2.1) * 0.04
    return true
  }

  setVisible(v: boolean): void {
    this.root.visible = v && !!this.flagMat.map
  }

  dispose(): void {
    this.disposed = true
    this.disposeTexture()
    this.root.removeFromParent()
    this.pole.geometry.dispose()
    ;(this.pole.material as THREE.Material).dispose()
    this.flag.geometry.dispose()
    this.flagMat.dispose()
  }

  private disposeTexture(): void {
    if (this.texture) {
      this.texture.dispose()
      this.texture = null
    }
    this.flagMat.map = null
  }
}
