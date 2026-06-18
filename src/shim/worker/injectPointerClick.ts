import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import { PointerEventType } from '../../input/pointerConstants'
import type { InjectPointerClickBody } from '../../player/injectPointerClick'

/** Write PointerEventsResult directly on the scene worker engine (same-tick getClick). */
export function injectPointerClickOnEngine(engine: IEngine, body: InjectPointerClickBody): void {
  preregisterRendererInjectedComponents(engine)
  const PointerEventsResult = generated.PointerEventsResult(engine)
  const hit = {
    entityId: body.hitEntity,
    position: { ...body.hitPosition },
    globalOrigin: undefined,
    direction: undefined,
    normalHit: { ...body.hitNormal },
    length: body.hitDistance,
    meshName: body.meshName ?? ''
  }

  const down = {
    button: body.button,
    state: PointerEventType.PET_DOWN,
    timestamp: body.downTimestamp,
    tickNumber: body.tickNumber,
    hit,
    analog: undefined
  }
  const up = {
    button: body.button,
    state: PointerEventType.PET_UP,
    timestamp: body.upTimestamp,
    tickNumber: body.tickNumber,
    hit,
    analog: undefined
  }

  const entities = body.entities.length ? body.entities : [body.entity]
  for (const entity of entities) {
    PointerEventsResult.addValue(entity as Entity, down)
    PointerEventsResult.addValue(entity as Entity, up)
  }
}
