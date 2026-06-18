import type { IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'

/** Global hook invoked from patched bundle capture snippets (pre-seal). */
export const PREREGISTER_RENDERER_COMPONENTS_KEY = '__THREEJS_PREREGISTER_RENDERER_COMPONENTS__'

const preregistered = new WeakSet<IEngine>()

/**
 * Declare renderer→worker CRDT components on the scene engine before `engine.seal()`.
 * Direct inject (`addValue` / `createOrReplace`) fails with "Engine is already sealed"
 * if these are first touched after onStart.
 */
export function preregisterRendererInjectedComponents(engine: IEngine): void {
  if (preregistered.has(engine)) return
  preregistered.add(engine)

  generated.PointerEventsResult(engine)
  generated.TriggerAreaResult(engine)
  generated.VideoEvent(engine)
  generated.TweenState(engine)
  generated.RaycastResult(engine)
  generated.VideoPlayer(engine)
  generated.PrimaryPointerInfo(engine)
}

export function installPreregisterRendererComponentsHook(): void {
  const g = globalThis as Record<string, unknown>
  g[PREREGISTER_RENDERER_COMPONENTS_KEY] = preregisterRendererInjectedComponents
}