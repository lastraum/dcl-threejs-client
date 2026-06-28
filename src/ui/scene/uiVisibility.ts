import type { Entity } from '@dcl/ecs'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'
import { CANVAS_ROOT_ENTITY } from './uiTree'
import { YGDisplay } from './yogaEnums'

/** True when entity and every UiTransform ancestor are shown (display flex + opacity > 0). */
export function isUiEntityVisible(
  entity: Entity,
  transformOf: (e: Entity) => PBUiTransform | null
): boolean {
  let current: Entity | null = entity
  while (current) {
    const t = transformOf(current)
    if (!t || t.display === YGDisplay.NONE) return false
    if ((t.opacity ?? 1) < 0.01) return false
    const parent = t.parent ?? CANVAS_ROOT_ENTITY
    if (parent === CANVAS_ROOT_ENTITY || parent === 0) break
    current = parent as Entity
  }
  return true
}