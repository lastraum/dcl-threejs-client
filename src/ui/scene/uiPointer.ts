import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from '../../bridge/mirrorComponents'
import type { ProjectionView } from '../../bridge/ProjectionView'
import type { PBPointerEvents_Entry } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/pointer_events.gen'
import type { PBUiBackground } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_background.gen'
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
import { effectiveUiBackgroundAlpha, hasUiVisualBackground } from './uiBackgroundStyle'
import { isUiEntityVisible } from './uiVisibility'

function buttonMatches(entryButton: number | undefined, pressed: InputActionValue): boolean {
  const btn = entryButton ?? InputAction.IA_ANY
  if (btn === InputAction.IA_ANY) return true
  return Number(btn) === Number(pressed)
}

/** Snapshot/JSON PE may arrive as array-like objects — always normalize to an array. */
export function normalizePointerEventsList(
  spec: { pointerEvents?: unknown } | null | undefined
): PBPointerEvents_Entry[] {
  if (!spec) return []
  const raw = spec.pointerEvents
  if (Array.isArray(raw)) return raw as PBPointerEvents_Entry[]
  if (raw && typeof raw === 'object') return Object.values(raw) as PBPointerEvents_Entry[]
  return []
}

function entryEventType(entry: PBPointerEvents_Entry): number {
  return Number((entry as { eventType?: number }).eventType)
}

function entryButton(entry: PBPointerEvents_Entry): number | undefined {
  const info = entry.eventInfo as { button?: number } | undefined
  if (info?.button === undefined || info?.button === null) return undefined
  return Number(info.button)
}

function entryInteractionType(entry: PBPointerEvents_Entry): number {
  const v = (entry as { interactionType?: number }).interactionType
  return v === undefined || v === null ? InteractionType.CURSOR : Number(v)
}

export function hasUiPointerEvent(
  spec: { pointerEvents?: unknown } | null | undefined,
  eventType: PointerEventTypeValue,
  button: InputActionValue
): boolean {
  const list = normalizePointerEventsList(spec)
  if (!list.length) return false
  return list.some(
    (entry) =>
      entryEventType(entry) === Number(eventType) &&
      buttonMatches(entryButton(entry), button) &&
      entryInteractionType(entry) === InteractionType.CURSOR
  )
}

/** react-ecs onPointerDown / onPointerUp — cursor PET_DOWN or PET_UP (not hover-only). */
export function hasUiPointerDownOrUp(
  spec: { pointerEvents?: unknown } | null | undefined
): boolean {
  const list = normalizePointerEventsList(spec)
  if (!list.length) return false
  return list.some((entry) => {
    const t = entryEventType(entry)
    return (
      (t === PointerEventType.PET_DOWN || t === PointerEventType.PET_UP) &&
      entryInteractionType(entry) === InteractionType.CURSOR
    )
  })
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

/**
 * Near-invisible UiBackground (Color4.a) — CBD Plaza welcome fades a, not UiTransform.opacity.
 * Below this, PE shells must not capture hits/cursor (ghost catcher after fade).
 */
export const UI_POINTER_CAPTURE_MIN_ALPHA = 0.05

/** True when UiBackground.color.a is effectively invisible for pointer capture. */
export function isUiBackgroundPointerTransparent(
  bg: PBUiBackground | { color?: { r?: number; g?: number; b?: number; a?: number } } | null | undefined
): boolean {
  if (!bg) return false
  return effectiveUiBackgroundAlpha(bg.color) < UI_POINTER_CAPTURE_MIN_ALPHA
}

/**
 * Whether this entity should capture cursor/clicks right now.
 * Respects scene display/opacity/Color4.a — no client force-dismiss.
 *
 * Ghost PE catchers (CBD welcome after dissolve): PE stays mounted with a≈0 or no
 * paintable UiBackground while the logo unmounts — still must free the hand cursor.
 */
export function isUiEntityPointerCapturing(
  ecs: MirrorComponents,
  entity: Entity,
  pointerEventsOf?: UiPointerEventsLookup,
  background?: PBUiBackground | null
): boolean {
  const transformOf = (e: Entity) => ecs.UiTransform.getOrNull(e)
  if (!isUiEntityVisible(entity, transformOf)) return false
  const t = transformOf(entity)
  if (t && (t.opacity ?? 1) < UI_POINTER_CAPTURE_MIN_ALPHA) return false

  const hasInput = !!ecs.UiInput.getOrNull(entity)
  const hasDropdown = !!ecs.UiDropdown.getOrNull(entity)
  if (hasInput || hasDropdown) return true

  const bg = background ?? (ecs.UiBackground.getOrNull(entity) as PBUiBackground | null)
  // Faded Color4.a (welcome scrim) — PE must not keep the hand cursor.
  if (isUiBackgroundPointerTransparent(bg)) return false

  const hasText = !!(ecs.UiText.getOrNull(entity)?.value?.trim())
  // PE-only shell with nothing left to paint (a=0, bg removed, logo child gone) —
  // Explorer would still hit an invisible PE; free pointer when there is no visual.
  if (!hasText && !hasUiVisualBackground(bg)) return false

  return isUiEntityBlocking(ecs, entity, pointerEventsOf)
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