import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from '../../bridge/mirrorComponents'
import type { ProjectionView } from '../../bridge/ProjectionView'
import type { PBPointerEvents_Entry } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/pointer_events.gen'
import {
  InputAction,
  InteractionType,
  PointerEventType,
  type InputActionValue,
  type PointerEventTypeValue
} from '../../input/pointerConstants'
import { normalizePointerFilterMode, PointerFilterMode } from './yogaEnums'

function buttonMatches(entryButton: number | undefined, pressed: InputActionValue): boolean {
  const btn = entryButton ?? InputAction.IA_ANY
  if (btn === InputAction.IA_ANY) return true
  return btn === pressed
}

export function hasUiPointerEvent(
  spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> } | null | undefined,
  eventType: PointerEventTypeValue,
  button: InputActionValue
): boolean {
  if (!spec) return false
  return spec.pointerEvents.some(
    (entry) =>
      entry.eventType === eventType &&
      buttonMatches(entry.eventInfo?.button, button) &&
      (entry.interactionType ?? InteractionType.CURSOR) === InteractionType.CURSOR
  )
}

/** react-ecs onPointerDown / onPointerUp — cursor PET_DOWN or PET_UP (not hover-only). */
export function hasUiPointerDownOrUp(
  spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> } | null | undefined
): boolean {
  if (!spec?.pointerEvents.length) return false
  return spec.pointerEvents.some(
    (entry) =>
      (entry.eventType === PointerEventType.PET_DOWN ||
        entry.eventType === PointerEventType.PET_UP) &&
      (entry.interactionType ?? InteractionType.CURSOR) === InteractionType.CURSOR
  )
}

/**
 * Entity blocks scene pointer raycast / receives DOM hits — pointerFilter BLOCK or
 * onPointerDown/onPointerUp only (hover-only PointerEvents do not block).
 */
export function isUiPointerBlocking(ecs: MirrorComponents, entity: Entity): boolean {
  const t = ecs.UiTransform.getOrNull(entity)
  if (t && normalizePointerFilterMode(t.pointerFilter) === PointerFilterMode.BLOCK) return true
  return hasUiPointerDownOrUp(ecs.PointerEvents.getOrNull(entity))
}

/** Deepest UiEntity with a matching handler — react-ecs registers onMouseDown on the hit leaf. */
export function resolveUiPointerResultEntity(
  ecs: MirrorComponents,
  view: ProjectionView,
  entity: Entity,
  button: InputActionValue,
  state: PointerEventTypeValue = PointerEventType.PET_DOWN
): Entity {
  let current: Entity = entity
  const root = view.RootEntity
  for (;;) {
    const spec = ecs.PointerEvents.getOrNull(current)
    if (spec && hasUiPointerEvent(spec, state, button)) {
      return current
    }
    const parent = ecs.UiTransform.getOrNull(current)?.parent ?? 0
    if (!parent || parent === root || parent === 0) break
    current = parent as Entity
  }
  return entity
}

export function collectUiPointerResultTargets(
  ecs: MirrorComponents,
  view: ProjectionView,
  entity: Entity,
  button: InputActionValue,
  state: PointerEventTypeValue
): Entity[] {
  const targets: Entity[] = []
  let current: Entity = entity
  const root = view.RootEntity
  for (;;) {
    const spec = ecs.PointerEvents.getOrNull(current)
    if (spec) {
      if (hasUiPointerEvent(spec, state, button)) targets.push(current)
      else if (
        state === PointerEventType.PET_UP &&
        hasUiPointerEvent(spec, PointerEventType.PET_DOWN, button)
      ) {
        targets.push(current)
      }
    }
    const parent = ecs.UiTransform.getOrNull(current)?.parent ?? 0
    if (!parent || parent === root || parent === 0) break
    current = parent as Entity
  }
  if (!targets.length) targets.push(entity)
  return targets
}