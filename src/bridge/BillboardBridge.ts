import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from './mirrorComponents'
import type { EntityStore } from './EntityStore'
import type { ProjectionView } from './ProjectionView'

/** Matches `@dcl/ecs` BillboardMode bit flags. */
const BM_X = 1
const BM_Y = 2
const YAW_EPS = 1e-5

const _worldPos = new THREE.Vector3()
const _worldUp = new THREE.Vector3(0, 1, 0)
const _lookMat = new THREE.Matrix4()
const _worldQuat = new THREE.Quaternion()
const _extractPos = new THREE.Vector3()
const _extractQuat = new THREE.Quaternion()
const _extractScale = new THREE.Vector3()
const _extractWorld = new THREE.Matrix4()

/**
 * Platform Billboard (1090).
 *
 * ## Verified client law (git history: initial → aefccaf live ECS scan)
 *
 * - `billboardMode ?? 7` → BM_ALL when omitted (matches scene `Billboard.create` / ECS default).
 * - **BM_Y** / X|Y: yaw only via `atan2(cam−pos)` on **world** XZ.
 * - **BM_ALL**: Three.js **lookAt** — object **−Z** faces the camera (Three convention).
 *
 * ## Hierarchy (required engineering — parented roots)
 *
 * Use **world** position for look/yaw (not `obj.position`). Write rotation as
 * **parent-local**. Local-space lookAt breaks GP press_e / bobber parents.
 *
 * ## Explicitly NOT platform law (reverted — invented during fishing debug)
 *
 * Ry(π) after lookAt · scale.x = −1 · makeBasis + 180° roll for dual-face UVs.
 * Texture orientation under lookAt is a **MeshRenderer plane UV** parity question
 * vs Explorer Unity — fix that law once; do not invent Billboard forks.
 */
export class BillboardBridge {
  private readonly lastYaw = new Map<Entity, number>()
  private readonly motionEntities = new Set<Entity>()
  private readonly lastCam = new THREE.Vector3(Number.NaN, 0, 0)

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly store: EntityStore,
    _getCamera: () => THREE.Camera
  ) {}

  pendingMotionEntities(): ReadonlySet<Entity> {
    return this.motionEntities
  }

  consumeMotionEntities(): ReadonlySet<Entity> {
    const out = new Set(this.motionEntities)
    this.motionEntities.clear()
    return out
  }

  /** Mark ECS Billboard entities on the store (O(billboards) path). */
  sync(view: ProjectionView): void {
    const { Billboard } = this.ecs
    for (const [entity] of view.getEntitiesWith(Billboard)) {
      this.store.setBillboard(entity, true)
      const node = this.store.getNode(entity)
      if (node) node.userData.dclBillboardMode = Billboard.get(entity).billboardMode ?? 7
    }
  }

  /** Clear yaw early-out after hide→show. */
  invalidateFacing(entity: Entity): void {
    this.lastYaw.delete(entity)
  }

  /**
   * Stamp extract flags on the pose node. Facing is applied in DrawWorld.sync
   * (registered visuals) and {@link applyExtract} (GPU instances) — never here.
   */
  update(): void {
    this.syncFlags()
  }

  /**
   * Extract-only: write GPU instance world matrices. Does not mutate pose quat.
   * Registered draw visuals are handled by DrawWorld.writeBillboard.
   */
  applyExtract(
    camera: THREE.Camera,
    writeInstanceWorld: (entity: Entity, world: THREE.Matrix4) => boolean
  ): void {
    const { Billboard } = this.ecs
    const camPos = camera.position
    const billed = this.store.getBillboardEntities()
    if (billed.length === 0) return
    if (camPos.distanceToSquared(this.lastCam) < 1e-8) return
    this.lastCam.copy(camPos)
    for (const entity of billed) {
      const obj = this.store.getNode(entity)
      if (!obj) continue
      if (!Billboard.has(entity)) {
        if (this.store.isBillboard(entity)) this.store.setBillboard(entity, false)
        delete obj.userData.dclBillboardMode
        this.lastYaw.delete(entity)
        continue
      }
      const mode = Billboard.get(entity).billboardMode ?? 7
      obj.userData.dclBillboardMode = mode
      this.store.setBillboard(entity, true)
      if (mode === 0) continue

      _worldPos.setFromMatrixPosition(obj.matrixWorld)
      obj.matrixWorld.decompose(_extractPos, _extractQuat, _extractScale)
      if (mode === BM_Y || mode === (BM_X | BM_Y)) {
        const dx = camPos.x - _worldPos.x
        const dz = camPos.z - _worldPos.z
        const nextYaw = Math.atan2(dx, dz)
        const prev = this.lastYaw.get(entity)
        if (prev !== undefined && Math.abs(nextYaw - prev) <= YAW_EPS) continue
        _worldQuat.setFromAxisAngle(_worldUp, nextYaw)
        this.lastYaw.set(entity, nextYaw)
      } else {
        _lookMat.lookAt(_worldPos, camPos, _worldUp)
        _worldQuat.setFromRotationMatrix(_lookMat)
        if (_extractQuat.angleTo(_worldQuat) <= YAW_EPS) continue
        this.lastYaw.set(entity, 0)
      }
      _extractWorld.compose(_extractPos, _worldQuat, _extractScale)
      if (writeInstanceWorld(entity, _extractWorld)) {
        this.motionEntities.add(entity)
      }
    }
  }

  private syncFlags(): void {
    const { Billboard } = this.ecs
    for (const entity of this.store.getBillboardEntities()) {
      const obj = this.store.getNode(entity)
      if (!obj) continue
      if (!Billboard.has(entity)) {
        delete obj.userData.dclBillboardMode
        continue
      }
      obj.userData.dclBillboardMode = Billboard.get(entity).billboardMode ?? 7
    }
  }

}
