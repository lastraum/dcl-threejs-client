import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { preregisterRendererInjectedComponents } from '../shim/worker/preregisterRendererInjectedComponents'
import { InputAction, PointerEventType, type InputActionValue } from '../input/pointerConstants'
import type { InjectSceneInputBody } from './injectSceneInput'
import { injectSceneKeyOnEngine } from './injectSceneInput'

/** Level-state keyboard snapshot — Phase 1+ replacement for per-edge PointerEventsResult relay. */
export type SceneInputSnapshotBody = {
  tickNumber: number
  /** Input actions currently held on the main-thread relay. */
  pressed: readonly InputActionValue[]
}

/** Actions mirrored in scene keyboard relay / creator flight (excludes IA_POINTER / IA_ANY). */
export const SCENE_INPUT_SNAPSHOT_ACTIONS: readonly InputActionValue[] = [
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

export function buildSceneInputSnapshot(
  tickNumber: number,
  pressed: Iterable<InputActionValue>
): SceneInputSnapshotBody {
  return { tickNumber, pressed: [...pressed] }
}

let workerInputTimestamp = 1

function nextWorkerInputTimestamp(): number {
  return workerInputTimestamp++
}

/** Mirror `inputSystem.isPressed` — latest PET_DOWN/UP on PlayerEntity PointerEventsResult. */
export function isSceneInputPressedOnPlayer(
  engine: IEngine,
  playerEntity: Entity,
  action: InputActionValue
): boolean {
  const PointerEventsResult = generated.PointerEventsResult(engine)
  const commands = PointerEventsResult.get(playerEntity)
  if (!commands) return false
  for (const command of Array.from(commands).reverse()) {
    if (command.button !== action) continue
    if (command.state === PointerEventType.PET_DOWN) return true
    if (command.state === PointerEventType.PET_UP) return false
  }
  return false
}

export function resetWorkerInputSnapshotState(): void {
  workerInputTimestamp = 1
}

/** Compare worker pressed state against main-thread level snapshot (shadow parity). */
export function sceneInputSnapshotMismatches(
  engine: IEngine,
  playerEntity: Entity,
  snapshot: SceneInputSnapshotBody
): InputActionValue[] {
  const expected = new Set(snapshot.pressed)
  const mismatches: InputActionValue[] = []
  for (const action of SCENE_INPUT_SNAPSHOT_ACTIONS) {
    const actual = isSceneInputPressedOnPlayer(engine, playerEntity, action)
    const want = expected.has(action)
    if (actual !== want) mismatches.push(action)
  }
  return mismatches
}

/** Apply level snapshot as PET_DOWN/PET_UP edge diffs on the worker PlayerEntity. */
export function applySceneInputSnapshotOnEngine(
  engine: IEngine,
  playerEntity: number,
  snapshot: SceneInputSnapshotBody,
  previousPressed: ReadonlySet<InputActionValue>
): Set<InputActionValue> {
  preregisterRendererInjectedComponents(engine)
  const nextPressed = new Set(snapshot.pressed)
  const tickNumber = snapshot.tickNumber

  for (const action of SCENE_INPUT_SNAPSHOT_ACTIONS) {
    const was = previousPressed.has(action)
    const now = nextPressed.has(action)
    if (was === now) continue
    const body: InjectSceneInputBody = {
      playerEntity,
      button: action,
      state: now ? PointerEventType.PET_DOWN : PointerEventType.PET_UP,
      timestamp: nextWorkerInputTimestamp(),
      tickNumber
    }
    injectSceneKeyOnEngine(engine, body)
  }

  return nextPressed
}