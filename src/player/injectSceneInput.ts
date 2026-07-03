import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { preregisterRendererInjectedComponents } from '../shim/worker/preregisterRendererInjectedComponents'
import type { InputActionValue, PointerEventTypeValue } from '../input/pointerConstants'

/** Direct worker injection — scene keyboard relay (WASD / actions → inputSystem.isPressed). */
export type InjectSceneInputBody = {
  playerEntity: number
  button: InputActionValue
  state: PointerEventTypeValue
  timestamp: number
  tickNumber: number
}

export function injectSceneKeyOnEngine(engine: IEngine, body: InjectSceneInputBody): void {
  preregisterRendererInjectedComponents(engine)
  const PointerEventsResult = generated.PointerEventsResult(engine)
  const result = {
    button: body.button,
    state: body.state,
    timestamp: body.timestamp,
    tickNumber: body.tickNumber,
    hit: {
      entityId: body.playerEntity,
      position: { x: 0, y: 0, z: 0 },
      globalOrigin: undefined,
      direction: undefined,
      normalHit: { x: 0, y: 1, z: 0 },
      length: 0,
      meshName: ''
    },
    analog: undefined
  }
  PointerEventsResult.addValue(body.playerEntity as Entity, result)
}