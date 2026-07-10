import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from '../../bridge/mirrorComponents'
import type { ProjectionView } from '../../bridge/ProjectionView'
import type { PBPointerEvents_Entry } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/pointer_events.gen'
export type UiPointerEventsLookup = (
  entity: Entity
) => { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> } | null | undefined
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
 * Entity blocks scene pointer raycast — pointerFilter BLOCK or onPointerDown/onPointerUp.
 * Hover-only PointerEvents do not block. Optional lookup covers phase-4 mount snapshot lag.
 */
export function isUiEntityBlocking(
  ecs: MirrorComponents,
  entity: Entity,
  pointerEventsOf?: UiPointerEventsLookup
): boolean {
  const t = ecs.UiTransform.getOrNull(entity)
  if (t && normalizePointerFilterMode(t.pointerFilter) === PointerFilterMode.BLOCK) return true
  const spec = pointerEventsOf?.(entity) ?? ecs.PointerEvents.getOrNull(entity)
  return hasUiPointerDownOrUp(spec)
}

/** @deprecated Use isUiEntityBlocking — projection-only PointerEvents lookup. */
export function isUiPointerBlocking(ecs: MirrorComponents, entity: Entity): boolean {
  return isUiEntityBlocking(ecs, entity)
}

/** Deepest UiEntity with a matching handler — react-ecs registers onMouseDown on the hit leaf. */
export function resolveUiPointerResultEntity(
  ecs: MirrorComponents,
  view: ProjectionView,
  entity: Entity,
  button: InputActionValue,
  state: PointerEventTypeValue = PointerEventType.PET_DOWN,
  pointerEventsOf?: UiPointerEventsLookup
): Entity {
  let current: Entity = entity
  const root = view.RootEntity
  const specOf = (id: Entity) => pointerEventsOf?.(id) ?? ecs.PointerEvents.getOrNull(id)
  for (;;) {
    const spec = specOf(current)
    if (spec && hasUiPointerEvent(spec, state, button)) {
      return current
    }
    const parent = ecs.UiTransform.getOrNull(current)?.parent ?? 0
    if (!parent || parent === root || parent === 0) break
    current = parent as Entity
  }
  return entity
}

/** True when this entity (not ancestors) has a matching cursor PET_DOWN/PET_UP handler. */
export function hasDirectUiPointerHandler(
  ecs: MirrorComponents,
  entity: Entity,
  button: InputActionValue,
  state: PointerEventTypeValue = PointerEventType.PET_DOWN,
  pointerEventsOf?: UiPointerEventsLookup
): boolean {
  const spec = pointerEventsOf?.(entity) ?? ecs.PointerEvents.getOrNull(entity)
  return hasUiPointerEvent(spec, state, button)
}

/** Walk UiTransform parents — first entity with PET_DOWN/PET_UP, or null when none. */
export function findUiPointerHandlerEntity(
  ecs: MirrorComponents,
  view: ProjectionView,
  entity: Entity,
  button: InputActionValue,
  state: PointerEventTypeValue = PointerEventType.PET_DOWN,
  pointerEventsOf?: UiPointerEventsLookup
): Entity | null {
  let current: Entity = entity
  const root = view.RootEntity
  const specOf = (id: Entity) => pointerEventsOf?.(id) ?? ecs.PointerEvents.getOrNull(id)
  for (;;) {
    const spec = specOf(current)
    if (spec && hasUiPointerEvent(spec, state, button)) {
      return current
    }
    const parent = ecs.UiTransform.getOrNull(current)?.parent ?? 0
    if (!parent || parent === root || parent === 0) break
    current = parent as Entity
  }
  return null
}

export function collectUiPointerResultTargets(
  ecs: MirrorComponents,
  view: ProjectionView,
  entity: Entity,
  button: InputActionValue,
  state: PointerEventTypeValue,
  pointerEventsOf?: UiPointerEventsLookup
): Entity[] {
  const targets: Entity[] = []
  let current: Entity = entity
  const root = view.RootEntity
  const specOf = (id: Entity) => pointerEventsOf?.(id) ?? ecs.PointerEvents.getOrNull(id)
  for (;;) {
    const spec = specOf(current)
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