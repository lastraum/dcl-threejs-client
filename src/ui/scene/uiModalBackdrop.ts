import type { Entity } from '@dcl/ecs'
import type { PBUiBackground } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_background.gen'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'
import { CANVAS_ROOT_ENTITY } from './uiTree'
import type { LayoutBox } from './yogaLayout'
import type { VirtualCanvasSize } from './virtualCanvas'

/** Full-screen semi-transparent modal scrim (CameraOperator home / use / presets). */
export function isModalBackdropBox(
  box: LayoutBox,
  bg: PBUiBackground | null,
  virtual: VirtualCanvasSize
): boolean {
  if (!bg?.color) return false
  const a = bg.color.a ?? 1
  if (a < 0.02 || a > 0.92) return false
  const coversW = box.width >= virtual.width * 0.85
  const coversH = box.height >= virtual.height * 0.85
  return coversW && coversH
}

/** Max zIndex along UiTransform ancestors — scrim entities are usually 0 but live under zIndex:210 shells. */
export function modalBackdropStackZ(
  entity: Entity,
  transformOf: (e: Entity) => PBUiTransform | null
): number {
  let maxZ = 0
  let current: Entity | null = entity
  while (current) {
    const t = transformOf(current)
    if (t) maxZ = Math.max(maxZ, t.zIndex ?? 0)
    const parent = t?.parent ?? CANVAS_ROOT_ENTITY
    if (parent === CANVAS_ROOT_ENTITY || parent === 0) break
    current = parent as Entity
  }
  return maxZ
}

/** Keep only the topmost fullscreen scrim — stale view overlays must not stack dimming. */
export function pickTopmostModalBackdrop(
  candidates: Array<{ entity: Entity; zIndex: number }>
): Entity | null {
  if (candidates.length <= 1) return candidates[0]?.entity ?? null
  const sorted = [...candidates].sort((a, b) => {
    if (a.zIndex !== b.zIndex) return b.zIndex - a.zIndex
    return (b.entity as number) - (a.entity as number)
  })
  return sorted[0]?.entity ?? null
}

/**
 * Full-screen modal shell that owns both the scrim and the centered panel.
 * Scrim layers are inset-0 siblings of the panel — start from the scrim's parent.
 */
export function findFullscreenModalRoot(
  backdropEntity: Entity,
  layoutOf: (e: Entity) => LayoutBox | undefined,
  transformOf: (e: Entity) => PBUiTransform | null,
  virtual: VirtualCanvasSize
): Entity {
  const bt = transformOf(backdropEntity)
  const parent = bt?.parent ?? CANVAS_ROOT_ENTITY
  let current: Entity =
    parent !== CANVAS_ROOT_ENTITY && parent !== 0 ? (parent as Entity) : backdropEntity

  while (true) {
    const layout = layoutOf(current)
    const t = transformOf(current)
    if (
      layout &&
      t &&
      layout.width >= virtual.width * 0.9 &&
      layout.height >= virtual.height * 0.9
    ) {
      return current
    }
    const nextParent = t?.parent ?? CANVAS_ROOT_ENTITY
    if (nextParent === CANVAS_ROOT_ENTITY || nextParent === 0) break
    current = nextParent as Entity
  }
  return backdropEntity
}

export function isUiDescendantOf(
  entity: Entity,
  ancestor: Entity,
  transformOf: (e: Entity) => PBUiTransform | null
): boolean {
  let current: Entity | null = entity
  while (current) {
    if (current === ancestor) return true
    const parent = transformOf(current)?.parent ?? CANVAS_ROOT_ENTITY
    if (parent === CANVAS_ROOT_ENTITY || parent === 0) break
    current = parent as Entity
  }
  return false
}