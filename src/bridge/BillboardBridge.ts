import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from './mirrorComponents'
import type { EntityStore } from './EntityStore'
import type { ProjectionView } from './ProjectionView'

const BM_X = 1
const BM_Y = 2
const YAW_EPS = 1e-5

/** Y-axis / full billboarding for TextShape and signs. */
export class BillboardBridge {
  private readonly lastYaw = new Map<Entity, number>()
  /** Entities whose camera-facing rotation changed this frame — collider pose slide emitter. */
  private readonly motionEntities = new Set<Entity>()

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly store: EntityStore,
    private readonly getCamera: () => THREE.Camera
  ) {}

  /** Entities rotated this frame — valid until `consumeMotionEntities`. */
  pendingMotionEntities(): ReadonlySet<Entity> {
    return this.motionEntities
  }

  /** Consume entities that rotated this frame (clears the set). */
  consumeMotionEntities(): ReadonlySet<Entity> {
    const out = new Set(this.motionEntities)
    this.motionEntities.clear()
    return out
  }

  /** Register ECS Billboard entities on the store — O(billboards), not O(scene). */
  sync(view: ProjectionView): void {
    const { Billboard } = this.ecs
    for (const [entity] of view.getEntitiesWith(Billboard)) {
      this.store.setBillboard(entity, true)
    }
  }

  update(): void {
    const { Billboard } = this.ecs
    const camPos = this.getCamera().position

    for (const entity of this.store.getBillboardEntities()) {
      const obj = this.store.nodes.get(entity)
      if (!obj) continue

      if (!Billboard.has(entity)) {
        this.store.setBillboard(entity, false)
        this.lastYaw.delete(entity)
        continue
      }
      this.store.setBillboard(entity, true)

      const mode = Billboard.get(entity).billboardMode ?? 7
      if (mode === 0) continue

      let nextYaw = obj.rotation.y
      if (mode === BM_Y || mode === (BM_X | BM_Y)) {
        const dx = camPos.x - obj.position.x
        const dz = camPos.z - obj.position.z
        nextYaw = Math.atan2(dx, dz)
        const prev = this.lastYaw.get(entity)
        if (prev !== undefined && Math.abs(nextYaw - prev) <= YAW_EPS) continue
        obj.rotation.y = nextYaw
      } else {
        const prevQuat = obj.quaternion.clone()
        obj.lookAt(camPos)
        const nextQuat = obj.quaternion.clone()
        obj.quaternion.copy(prevQuat)
        if (prevQuat.angleTo(nextQuat) <= YAW_EPS) continue
        obj.quaternion.copy(nextQuat)
        nextYaw = obj.rotation.y
      }

      obj.updateMatrixWorld(true)
      this.lastYaw.set(entity, nextYaw)
      this.motionEntities.add(entity)
    }
  }
}