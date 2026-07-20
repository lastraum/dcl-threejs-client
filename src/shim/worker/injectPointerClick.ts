import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import { PointerEventType } from '../../input/pointerConstants'
import type { InjectPointerClickBody } from '../../player/injectPointerClick'
import { nextWorkerPointerEventTimestamp } from './workerPointerEventTimestamp'
import { resolveWorkerUiTransform } from './resolveBundledUiComponents'

function buildPointerHit(body: InjectPointerClickBody) {
  return {
    entityId: body.hitEntity,
    position: { ...body.hitPosition },
    globalOrigin: undefined,
    direction: undefined,
    normalHit: { ...body.hitNormal },
    length: body.hitDistance,
    meshName: body.meshName ?? ''
  }
}

function pointerDownTargets(body: InjectPointerClickBody): number[] {
  const list = body.downEntities ?? body.entities
  return list.length ? list : [body.entity]
}

function pointerUpTargets(body: InjectPointerClickBody): number[] {
  const list = body.upEntities ?? body.entities
  return list.length ? list : [body.entity]
}

/**
 * Resolve PET_UP inject targets after any post-DOWN remount.
 *
 * Scene DOM UI (`body.sceneUi`): react-ecs `onMouseDown` already ran on PET_DOWN.
 * Remount recycles entity ids — UiTransform.has(id) is true for a *new* node that
 * reused the id (scrim/close). PET_UP on that id re-fires the wrong handler.
 * Clear isPressed via PlayerEntity only (identity of click type, not mount size).
 *
 * World mesh / asset-pack Triggers (`onPointerDown` / getClick): PET_UP must land on the
 * same entity as PET_DOWN. Filtering to UiTransform only sent UP to PlayerEntity and broke
 * wall links / open_link (VoxBoards 142,-146 Instagram/Discord/X, marketplace boards).
 *
 * Non-sceneUi with UiTransform (3D-ish UI): keep only targets that still have UiTransform.
 */
function resolveUpInjectTargets(engine: IEngine, body: InjectPointerClickBody): number[] {
  if (body.sceneUi) {
    return [engine.PlayerEntity as number]
  }
  const requested = pointerUpTargets(body)
  if (!requested.length) return [engine.PlayerEntity as number]

  preregisterRendererInjectedComponents(engine)
  const UiTransform = resolveWorkerUiTransform(engine)
  const PointerEvents = generated.PointerEvents(engine)

  const worldAlive = requested.filter(
    (id) => PointerEvents.has(id as Entity) && !UiTransform.has(id as Entity)
  )
  if (worldAlive.length) return worldAlive

  const uiAlive = requested.filter((id) => UiTransform.has(id as Entity))
  if (uiAlive.length) return uiAlive

  // Prefer original mesh targets when PE was cleared mid-click; avoid PlayerEntity so
  // getClick still matches the entity the scene registered onPointerDown against.
  return requested
}

/** PET_DOWN only — must run before the first pointer-tick `engine.update(0)`. */
export function injectPointerClickDownOnEngine(engine: IEngine, body: InjectPointerClickBody): void {
  preregisterRendererInjectedComponents(engine)
  const PointerEventsResult = generated.PointerEventsResult(engine)
  const hit = buildPointerHit(body)
  const down = {
    button: body.button,
    state: PointerEventType.PET_DOWN,
    timestamp: nextWorkerPointerEventTimestamp(),
    tickNumber: body.tickNumber,
    hit,
    analog: undefined
  }
  for (const entity of pointerDownTargets(body)) {
    PointerEventsResult.addValue(entity as Entity, down)
  }
}

/** PET_UP only — targets resolved after any post-DOWN remount. */
export function injectPointerClickUpOnEngine(engine: IEngine, body: InjectPointerClickBody): void {
  preregisterRendererInjectedComponents(engine)
  const PointerEventsResult = generated.PointerEventsResult(engine)
  const hit = buildPointerHit(body)
  const up = {
    button: body.button,
    state: PointerEventType.PET_UP,
    timestamp: nextWorkerPointerEventTimestamp(),
    tickNumber: body.tickNumber,
    hit,
    analog: undefined
  }
  const targets = resolveUpInjectTargets(engine, body)
  for (const entity of targets) {
    PointerEventsResult.addValue(entity as Entity, up)
  }
}

/** Write PointerEventsResult directly on the scene worker engine (same-tick getClick). */
export function injectPointerClickOnEngine(engine: IEngine, body: InjectPointerClickBody): void {
  injectPointerClickDownOnEngine(engine, body)
  injectPointerClickUpOnEngine(engine, body)
}
