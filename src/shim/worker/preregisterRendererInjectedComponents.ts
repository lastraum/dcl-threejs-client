import type { IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { guardVideoPlayerGetMutable } from './guardVideoPlayerGetMutable'

/** Global hook invoked from patched bundle capture snippets (pre-seal). */
export const PREREGISTER_RENDERER_COMPONENTS_KEY = '__THREEJS_PREREGISTER_RENDERER_COMPONENTS__'

const preregistered = new WeakSet<IEngine>()

type RendererComponentFactory = (engine: IEngine) => unknown

/**
 * Exported + iterated from the hook so the worker bundle cannot tree-shake
 * registration calls away (empty preregister → "Engine is already sealed" at runtime).
 */
export const RENDERER_PREREGISTER_FACTORIES: readonly RendererComponentFactory[] = [
  (engine) => generated.PointerEventsResult(engine),
  (engine) => generated.TriggerAreaResult(engine),
  (engine) => generated.VideoEvent(engine),
  (engine) => generated.AudioEvent(engine),
  (engine) => generated.TweenState(engine),
  (engine) => generated.RaycastResult(engine),
  (engine) => generated.VideoPlayer(engine),
  (engine) => generated.AudioSource(engine),
  (engine) => generated.PrimaryPointerInfo(engine)
]

/**
 * Declare renderer→worker CRDT components on the scene engine before `engine.seal()`.
 * Direct inject (`addValue` / `createOrReplace`) fails with "Engine is already sealed"
 * if these are first touched after onStart.
 */
export function preregisterRendererInjectedComponents(engine: IEngine): void {
  if (preregistered.has(engine)) return
  preregistered.add(engine)
  for (const register of RENDERER_PREREGISTER_FACTORIES) {
    register(engine)
  }
  guardVideoPlayerGetMutable(engine)
}

export function installPreregisterRendererComponentsHook(): void {
  const g = globalThis as Record<string, unknown>
  g[PREREGISTER_RENDERER_COMPONENTS_KEY] = preregisterRendererInjectedComponents
  if (RENDERER_PREREGISTER_FACTORIES.length === 0) {
    throw new Error('[sceneWorker] renderer preregister factories missing')
  }
}