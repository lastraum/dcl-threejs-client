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
const _parentWorldQuat = new THREE.Quaternion()
const _prevLocalQuat = new THREE.Quaternion()

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

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly store: EntityStore,
    private readonly getCamera: () => THREE.Camera
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
    }
  }

  /** Clear yaw early-out after hide→show. */
  invalidateFacing(entity: Entity): void {
    this.lastYaw.delete(entity)
  }

  update(): void {
    const { Billboard } = this.ecs
    const camPos = this.getCamera().position

    // Live ECS check — same as aefccaf (runtime spawns, not flags alone).
    this.store.forEachSceneEntity((entity, obj) => {
      if (!Billboard.has(entity)) {
        if (this.store.isBillboard(entity)) this.store.setBillboard(entity, false)
        this.lastYaw.delete(entity)
        return
      }
      this.store.setBillboard(entity, true)

      const mode = Billboard.get(entity).billboardMode ?? 7
      if (mode === 0) return

      obj.updateWorldMatrix(true, false)
      obj.getWorldPosition(_worldPos)

      if (mode === BM_Y || mode === (BM_X | BM_Y)) {
        const dx = camPos.x - _worldPos.x
        const dz = camPos.z - _worldPos.z
        const nextYaw = Math.atan2(dx, dz)
        const prev = this.lastYaw.get(entity)
        if (prev !== undefined && Math.abs(nextYaw - prev) <= YAW_EPS) return
        _worldQuat.setFromAxisAngle(_worldUp, nextYaw)
        this.applyWorldQuaternionAsLocal(obj, _worldQuat)
        if (!obj.matrixAutoUpdate) obj.updateMatrix()
        obj.updateMatrixWorld(true)
        this.lastYaw.set(entity, nextYaw)
        this.motionEntities.add(entity)
        return
      }

      // BM_ALL — platform law: Three lookAt (−Z toward camera).
      _prevLocalQuat.copy(obj.quaternion)
      _lookMat.lookAt(_worldPos, camPos, _worldUp)
      _worldQuat.setFromRotationMatrix(_lookMat)
      this.applyWorldQuaternionAsLocal(obj, _worldQuat)
      if (_prevLocalQuat.angleTo(obj.quaternion) <= YAW_EPS) return
      if (!obj.matrixAutoUpdate) obj.updateMatrix()
      obj.updateMatrixWorld(true)
      this.lastYaw.set(entity, obj.rotation.y)
      this.motionEntities.add(entity)
    })
  }

  private applyWorldQuaternionAsLocal(obj: THREE.Object3D, worldQuat: THREE.Quaternion): void {
    const parent = obj.parent
    if (parent) {
      parent.getWorldQuaternion(_parentWorldQuat)
      obj.quaternion.copy(_parentWorldQuat).invert().multiply(worldQuat)
    } else {
      obj.quaternion.copy(worldQuat)
    }
  }
}
