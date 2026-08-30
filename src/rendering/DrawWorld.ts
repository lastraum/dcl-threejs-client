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
      prepareAnimatedDrawLocal(visual)
      this.writeAnimated(visual, pose)
      return
    }
    visual.matrixAutoUpdate = false
    this.writeMatrix(visual, pose)
  }

  unregister(visual: THREE.Object3D): void {
    if (!this.links.delete(visual)) return
    // Always detach — a reparented extract (not a direct drawRoot child) still renders
    // if left in the scene after engine.removeEntity.
    visual.removeFromParent()
  }

  /**
   * Drop every GPU extract whose pose is this entity Group.
   * `engine.removeEntity` must not leave DrawWorld ghosts at the last matrixWorld
   * (blood bursts / splat GLBs stay visible after Transform DELETE if we only
   * hide the pose graph).
   */
  unregisterPose(pose: THREE.Object3D): void {
    const doomed: THREE.Object3D[] = []
    for (const [visual, linked] of this.links) {
      if (linked === pose) doomed.push(visual)
    }
    for (const visual of doomed) this.unregister(visual)
  }

  /**
   * Extract: copy pose world onto GPU objects. Billboard facing is applied here
   * (camera-facing is extract, not a pose-graph write).
   */
  sync(camera?: THREE.Camera): void {
    for (const [visual, pose] of this.links) {
      // Pose Visibility is law — static extract must not keep a pre-hide visible flag
      // (LO() hides plaza benches after the frozen clone was registered).
      visual.visible = isPoseChainVisible(pose)
      const billed = camera ? findBillboardAncestor(pose) : null
      if (billed) {
        this.writeBillboard(visual, pose, billed.pose, camera!, billed.mode)
        continue
      }
      // dclDrawStatic means “skip when pose world is unchanged” — not “never
      // extract.” Promote rebases the FocusOwner origin; frozen clones kept
      // the old matrixWorld and frustum-culled (appear on rotate, then vanish).
      if (visual.userData.dclDrawAnimated === true) {
        if (pose.matrixWorldNeedsUpdate) pose.updateWorldMatrix(true, false)
        this.writeAnimated(visual, pose)
        continue
      }
      if (pose.matrixWorldNeedsUpdate) pose.updateWorldMatrix(true, false)
      if (visual.matrixWorld.equals(pose.matrixWorld)) continue
      this.writeMatrix(visual, pose)
    }
  }

  /**
   * Same-fold extract after Transform.getMutable / Tween. Present increment can
   * miss a just-written pose world (rings/colliders follow ECS, GLB stays).
   */
  syncLinkedPose(pose: THREE.Object3D): void {
    pose.updateWorldMatrix(true, false)
    for (const [visual, linked] of this.links) {
      if (linked !== pose) continue
      visual.visible = isPoseChainVisible(pose)
      if (visual.userData.dclDrawAnimated === true) this.writeAnimated(visual, pose)
      else this.writeMatrix(visual, pose)
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
   *
   * Static extract first bakes pose.matrixWorld into visual.matrix. Multiplying
   * that leftover world by the new pose double-applies (or cancels) and the
   * GLB never follows script Transform. prepareAnimatedDrawLocal() must run
   * once when the mixer takes the clone.
   */
  private writeAnimated(visual: THREE.Object3D, pose: THREE.Object3D): void {
    if (visual.userData.dclAnimatedLocal !== true) {
      this.writeMatrix(visual, pose)
      return
    }
    visual.updateMatrix()
    visual.matrixWorld.multiplyMatrices(pose.matrixWorld, visual.matrix)
    this.pushChildren(visual)
  }

  private writeBillboard(
    visual: THREE.Object3D,
    pose: THREE.Object3D,
    billedPose: THREE.Object3D,
    camera: THREE.Camera,
    mode: number
  ): void {
    if (billedPose.matrixWorldNeedsUpdate) billedPose.updateWorldMatrix(true, false)
    if (pose !== billedPose && pose.matrixWorldNeedsUpdate) pose.updateWorldMatrix(true, false)
    _billPos.setFromMatrixPosition(billedPose.matrixWorld)
    billedPose.matrixWorld.decompose(_billDummy, _billQuat, _billScale)
    if (mode === 2 || mode === 3) {
      // BM_Y / BM_X|Y — yaw-only BM_ALL: Three −Z toward camera, no pitch.
      // atan2 without π aimed +Z (180° from lookAt) and turned TextShape names around.
      const dx = camera.position.x - _billPos.x
      const dz = camera.position.z - _billPos.z
      _billQuat.setFromAxisAngle(_billUp, Math.atan2(dx, dz) + Math.PI)
    } else {
      _billLook.lookAt(_billPos, camera.position, _billUp)
      _billQuat.setFromRotationMatrix(_billLook)
    }
    _billedWorld.compose(_billPos, _billQuat, _billScale)
    if (pose === billedPose) {
      visual.matrixWorld.copy(_billedWorld)
    } else {
      // Child MeshRenderer (plaza press_e on Billboard parent) must inherit facing.
      _billLocal.copy(billedPose.matrixWorld).invert().multiply(pose.matrixWorld)
      visual.matrixWorld.multiplyMatrices(_billedWorld, _billLocal)
    }
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

/**
 * After static extract, visual.matrix is a baked WORLD copy. Mixer/extract expect
 * clip-local TRS. Reset once so world = pose × local.
 */
export function prepareAnimatedDrawLocal(visual: THREE.Object3D): void {
  if (visual.userData.dclAnimatedLocal === true) return
  visual.position.set(0, 0, 0)
  visual.quaternion.identity()
  visual.scale.set(1, 1, 1)
  visual.updateMatrix()
  visual.userData.dclDrawAnimated = true
  visual.userData.dclAnimatedLocal = true
}

const _billPos = new THREE.Vector3()
const _billQuat = new THREE.Quaternion()
const _billScale = new THREE.Vector3()
const _billDummy = new THREE.Vector3()
const _billUp = new THREE.Vector3(0, 1, 0)
const _billLook = new THREE.Matrix4()
const _billedWorld = new THREE.Matrix4()
const _billLocal = new THREE.Matrix4()

function isPoseChainVisible(pose: THREE.Object3D): boolean {
  let o: THREE.Object3D | null = pose
  while (o) {
    if (o.visible === false) return false
    o = o.parent
  }
  return true
}

function findBillboardAncestor(
  pose: THREE.Object3D
): { pose: THREE.Object3D; mode: number } | null {
  let o: THREE.Object3D | null = pose
  while (o) {
    const mode = (o.userData.dclBillboardMode as number | undefined) ?? 0
    if (mode) return { pose: o, mode }
    o = o.parent
  }
  return null
}
