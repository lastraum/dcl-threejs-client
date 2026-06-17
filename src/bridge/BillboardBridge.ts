import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from './mirrorComponents'

const BM_X = 1
const BM_Y = 2

/** Y-axis / full billboarding for TextShape and signs. */
export class BillboardBridge {
  constructor(
    private readonly ecs: MirrorComponents,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined,
    private readonly getCamera: () => THREE.Camera
  ) {}

  update(): void {
    const nodes = this.getNodes()
    if (!nodes) return
    const { Billboard } = this.ecs
    const camPos = this.getCamera().position

    for (const [entity, obj] of nodes) {
      if (!Billboard.has(entity)) continue
      const mode = Billboard.get(entity).billboardMode ?? 7
      if (mode === 0) continue

      if (mode === BM_Y || mode === (BM_X | BM_Y)) {
        const dx = camPos.x - obj.position.x
        const dz = camPos.z - obj.position.z
        obj.rotation.y = Math.atan2(dx, dz)
        continue
      }

      obj.lookAt(camPos)
    }
  }
}
