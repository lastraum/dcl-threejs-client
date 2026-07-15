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
 * After PET_DOWN open, react-ecs may recycle the launcher id into a modal child.
 * Prefer UP targets that still have UiTransform; otherwise PlayerEntity so isPressed clears
 * without firing getClick on a recycled modal node.
 */
function resolveUpInjectTargets(engine: IEngine, body: InjectPointerClickBody): number[] {
  const requested = pointerUpTargets(body)
  preregisterRendererInjectedComponents(engine)
  const UiTransform = resolveWorkerUiTransform(engine)
  const alive = requested.filter((id) => UiTransform.has(id as Entity))
  if (alive.length) return alive
  return [engine.PlayerEntity as number]
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

/** PET_UP only — after post-DOWN react-ecs flush for inject-only UI clicks. */
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
  for (const entity of resolveUpInjectTargets(engine, body)) {
    PointerEventsResult.addValue(entity as Entity, up)
  }
}

/** Write PointerEventsResult directly on the scene worker engine (same-tick getClick). */
export function injectPointerClickOnEngine(engine: IEngine, body: InjectPointerClickBody): void {
  injectPointerClickDownOnEngine(engine, body)
  injectPointerClickUpOnEngine(engine, body)
}