import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'

/** Core component ids — bundled scene engines often omit `component.name` on componentsIter(). */
const UI_TRANSFORM_ID = 1050
const UI_BACKGROUND_ID = 1052
const UI_TEXT_ID = 1053
const UI_INPUT_ID = 1093
const UI_DROPDOWN_ID = 1094
const POINTER_EVENTS_ID = 1062

type UiTransform = ReturnType<typeof generated.UiTransform>
type UiBackground = ReturnType<typeof generated.UiBackground>
type UiText = ReturnType<typeof generated.UiText>
type UiInput = ReturnType<typeof generated.UiInput>
type UiDropdown = ReturnType<typeof generated.UiDropdown>

function resolveByCoreId<T>(engine: IEngine, coreId: number, fallback: (e: IEngine) => T): T {
  for (const component of engine.componentsIter()) {
    if (component.componentId === coreId) {
      return component as T
    }
  }
  return fallback(engine)
}

export function resolveWorkerUiTransform(engine: IEngine): UiTransform {
  return resolveByCoreId(engine, UI_TRANSFORM_ID, generated.UiTransform)
}

export function resolveWorkerUiBackground(engine: IEngine): UiBackground {
  return resolveByCoreId(engine, UI_BACKGROUND_ID, generated.UiBackground)
}

export function resolveWorkerUiText(engine: IEngine): UiText {
  return resolveByCoreId(engine, UI_TEXT_ID, generated.UiText)
}

export function resolveWorkerUiInput(engine: IEngine): UiInput {
  return resolveByCoreId(engine, UI_INPUT_ID, generated.UiInput)
}

export function resolveWorkerUiDropdown(engine: IEngine): UiDropdown {
  return resolveByCoreId(engine, UI_DROPDOWN_ID, generated.UiDropdown)
}

export function resolveWorkerPointerEvents(engine: IEngine): ReturnType<typeof generated.PointerEvents> {
  return resolveByCoreId(engine, POINTER_EVENTS_ID, generated.PointerEvents)
}

/** UiTransform entity ids on the worker — mount set for main-thread DOM. */
export function collectWorkerUiTransformEntityIds(engine: IEngine): number[] {
  const UiTransform = resolveWorkerUiTransform(engine)
  const out: number[] = []
  for (const [entity] of engine.getEntitiesWith(UiTransform)) {
    out.push(entity as number)
  }
  return out
}

export function forEachWorkerUiTransformEntity(
  engine: IEngine,
  visit: (entity: Entity, UiTransform: UiTransform) => void
): void {
  const UiTransform = resolveWorkerUiTransform(engine)
  for (const [entity] of engine.getEntitiesWith(UiTransform)) {
    visit(entity as Entity, UiTransform)
  }
}