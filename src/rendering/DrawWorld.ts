import * as THREE from 'three'

/**
 * Present extract list (Bevy-shaped).
 *
 * Pose graph (EntityStore) owns parent/child and matrixWorld.
 * Draw list owns GPU objects. Present walks `drawRoot` only — not 3k empty entity Groups.
 */
export class DrawWorld {
  readonly drawRoot = new THREE.Group()
  private readonly links = new Map<THREE.Object3D, THREE.Object3D>()

  constructor() {
    this.drawRoot.name = 'draw-root'
  }

  get visualCount(): number {
    return this.links.size
  }

  /** Place `visual` under the draw root; `pose` stays in the entity hierarchy. */
  register(visual: THREE.Object3D, pose: THREE.Object3D): void {
    this.unregister(visual)
    visual.matrixWorldAutoUpdate = false
    this.drawRoot.add(visual)
    this.links.set(visual, pose)
    if (visual.userData.dclDrawAnimated === true) {
      visual.matrixAutoUpdate = true
      this.writeAnimated(visual, pose)
      return
    }
    visual.matrixAutoUpdate = false
    this.writeMatrix(visual, pose)
  }

  unregister(visual: THREE.Object3D): void {
    if (!this.links.delete(visual)) return
    if (visual.parent === this.drawRoot) this.drawRoot.remove(visual)
  }

  /**
   * Extract: copy pose world onto GPU objects. Billboard facing is applied here
   * (camera-facing is extract, not a pose-graph write).
   */
  sync(camera?: THREE.Camera): void {
    for (const [visual, pose] of this.links) {
      // Pose Visibility is law — static extract must not keep a pre-hide visible flag
      // (LO() hides plaza benches after the frozen clone was registered).
      visual.visible = pose.visible
      const billboardMode = (pose.userData.dclBillboardMode as number | undefined) ?? 0
      if (billboardMode && camera) {
        this.writeBillboard(visual, pose, camera, billboardMode)
        continue
      }
      if (visual.userData.dclDrawStatic === true && visual.userData.dclDrawAnimated !== true) {
        continue
      }
      if (visual.userData.dclDrawAnimated === true) {
        this.writeAnimated(visual, pose)
        continue
      }
      if (visual.matrixWorld.equals(pose.matrixWorld)) continue
      this.writeMatrix(visual, pose)
    }
  }

  dispose(): void {
    this.links.clear()
    this.drawRoot.clear()
  }

  private writeMatrix(visual: THREE.Object3D, pose: THREE.Object3D): void {
    visual.matrix.copy(pose.matrixWorld)
    visual.matrixWorld.copy(pose.matrixWorld)
    this.pushChildren(visual)
  }

  /**
   * Mixer owns local TRS (Spring flower scale, blimp props, how-to arrow).
   * World = entity pose × clip local — never clobber clip scale with pose world.
   */
  private writeAnimated(visual: THREE.Object3D, pose: THREE.Object3D): void {
    visual.updateMatrix()
    visual.matrixWorld.multiplyMatrices(pose.matrixWorld, visual.matrix)
    this.pushChildren(visual)
  }

  private writeBillboard(
    visual: THREE.Object3D,
    pose: THREE.Object3D,
    camera: THREE.Camera,
    mode: number
  ): void {
    _billPos.setFromMatrixPosition(pose.matrixWorld)
    pose.matrixWorld.decompose(_billDummy, _billQuat, _billScale)
    if (mode === 2 || mode === 3) {
      // BM_Y / BM_X|Y — yaw only (same as BillboardBridge).
      const dx = camera.position.x - _billPos.x
      const dz = camera.position.z - _billPos.z
      _billQuat.setFromAxisAngle(_billUp, Math.atan2(dx, dz))
    } else {
      _billLook.lookAt(_billPos, camera.position, _billUp)
      _billQuat.setFromRotationMatrix(_billLook)
    }
    visual.matrixWorld.compose(_billPos, _billQuat, _billScale)
    visual.matrix.copy(visual.matrixWorld)
    this.pushChildren(visual)
  }

  /** Parent world already written. Incremental child push — no force walk on leaves. */
  private pushChildren(visual: THREE.Object3D): void {
    const n = visual.children.length
    if (n === 0) return
    for (const child of visual.children) {
      child.updateMatrixWorld(n > 1)
    }
  }
}

const _billPos = new THREE.Vector3()
const _billQuat = new THREE.Quaternion()
const _billScale = new THREE.Vector3()
const _billDummy = new THREE.Vector3()
const _billUp = new THREE.Vector3(0, 1, 0)
const _billLook = new THREE.Matrix4()
