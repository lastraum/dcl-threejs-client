import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { preregisterRendererInjectedComponents } from '../shim/worker/preregisterRendererInjectedComponents'
import { InputAction, PointerEventType, type InputActionValue, type PointerEventTypeValue } from '../input/pointerConstants'

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

/** Scene keyboard relay actions — PET_UP clears worker inputSystem.buttonState. */
const SCENE_RELAY_ACTIONS: readonly InputActionValue[] = [
  InputAction.IA_FORWARD,
  InputAction.IA_BACKWARD,
  InputAction.IA_RIGHT,
  InputAction.IA_LEFT,
  InputAction.IA_JUMP,
  InputAction.IA_WALK,
  InputAction.IA_MODIFIER,
  InputAction.IA_PRIMARY,
  InputAction.IA_SECONDARY,
  InputAction.IA_ACTION_3,
  InputAction.IA_ACTION_4,
  InputAction.IA_ACTION_5,
  InputAction.IA_ACTION_6
]

let workerInputTimestamp = 1

function nextWorkerInputTimestamp(): number {
  return workerInputTimestamp++
}

export function releaseAllSceneKeysOnEngine(
  engine: IEngine,
  playerEntity: number,
  tickNumber: number
): void {
  for (const action of SCENE_RELAY_ACTIONS) {
    injectSceneKeyOnEngine(engine, {
      playerEntity,
      button: action,
      state: PointerEventType.PET_UP,
      timestamp: nextWorkerInputTimestamp(),
      tickNumber
    })
  }
}