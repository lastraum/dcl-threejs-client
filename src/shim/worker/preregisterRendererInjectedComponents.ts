import type { IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { guardVideoPlayerGetMutable } from './guardVideoPlayerGetMutable'
import { guardGltfContainerGetMutable } from './guardGltfContainerGetMutable'
import {
  installClearPlayerInputModifierBlockHook,
  installInputModifierLocomotionGuard,
  installInputModifierSdkPatchHook
} from './inputModifierLocomotionGuard'
import { installVirtualCameraBindGuard } from './virtualCameraBindGuard'
import { installReactEcsOnceGuard } from './reactEcsOnce'
import { installSdkPollEventsLatchHook } from './patchSdkOnUpdatePollEvents'
import { installEngineSystemLoopPartition, installSceneEngineUiScheduler } from './sceneEngineUiScheduler'

/** Global hook invoked from patched bundle capture snippets (pre-seal). */
export const PREREGISTER_RENDERER_COMPONENTS_KEY = '__THREEJS_PREREGISTER_RENDERER_COMPONENTS__'
/** Patched setUiRenderer/addUiRenderer reports virtual canvas size to the worker. */
export const UI_VIRTUAL_CANVAS_KEY = '__THREEJS_UI_VIRTUAL_CANVAS__'

const preregistered = new WeakSet<IEngine>()

type RendererComponentFactory = (engine: IEngine) => unknown

/**
 * Exported + iterated from the hook so the worker bundle cannot tree-shake
 * registration calls away (empty preregister → "Engine is already sealed" at runtime).
 */
/**
 * Every host→worker component that inject* applies via createOrReplace/addValue.
 * Must stay in sync with CrdtEncoder growOnly/lwwCapture/reserved + inject files.
 */
export const RENDERER_PREREGISTER_FACTORIES: readonly RendererComponentFactory[] = [
  (engine) => generated.PointerEventsResult(engine),
  (engine) => generated.TriggerAreaResult(engine),
  (engine) => generated.VideoEvent(engine),
  (engine) => generated.AudioEvent(engine),
  (engine) => generated.AssetLoadLoadingState(engine),
  (engine) => generated.TweenState(engine),
  (engine) => generated.RaycastResult(engine),
  // Host LWW — GltfContainer load progress (ADR-215); scene systems poll currentState.
  (engine) => generated.GltfContainerLoadingState(engine),
  (engine) => generated.VideoPlayer(engine),
  (engine) => generated.AudioSource(engine),
  // Host LWW — amplitude + 8 bands for @dcl/sdk AudioAnalysis visualizers
  (engine) => generated.AudioAnalysis(engine),
  (engine) => generated.PrimaryPointerInfo(engine),
  (engine) => generated.CameraMode(engine),
  (engine) => generated.PointerLock(engine),
  (engine) => generated.UiCanvasInformation(engine),
  (engine) => generated.UiInputResult(engine),
  (engine) => generated.UiDropdownResult(engine),
  // SDK network listens for isConnectedSceneRoom on RootEntity
  (engine) => generated.RealmInfo(engine),
  // Host-owned local + remote player mirrors — joinRoster / getPlayer read PlayerEntity
  (engine) => generated.PlayerIdentityData(engine),
  // ADR-148 host frame counters — scenes may EngineInfo.onChange / read RootEntity
  (engine) => generated.EngineInfo(engine)
]

/**
 * Declare renderer→worker CRDT components on the scene engine before `engine.seal()`.
 * Direct inject (`addValue` / `createOrReplace`) fails with "Engine is already sealed"
 * if these are first touched after onStart.
 */
export function preregisterRendererInjectedComponents(engine: IEngine): void {
  if (preregistered.has(engine)) return
  preregistered.add(engine)
  installSceneEngineUiScheduler(engine)
  for (const register of RENDERER_PREREGISTER_FACTORIES) {
    register(engine)
  }
  guardVideoPlayerGetMutable(engine)
  guardGltfContainerGetMutable(engine)
  installVirtualCameraBindGuard(engine)
  installInputModifierLocomotionGuard(engine)
}

export function installPreregisterRendererComponentsHook(): void {
  installReactEcsOnceGuard()
  installEngineSystemLoopPartition()
  installInputModifierSdkPatchHook()
  installClearPlayerInputModifierBlockHook()
  installSdkPollEventsLatchHook()
  const g = globalThis as Record<string, unknown>
  g[PREREGISTER_RENDERER_COMPONENTS_KEY] = preregisterRendererInjectedComponents
  if (RENDERER_PREREGISTER_FACTORIES.length === 0) {
    throw new Error('[sceneWorker] renderer preregister factories missing')
  }
}

export function installUiVirtualCanvasHook(
  post: (width: number, height: number) => void
): void {
  const g = globalThis as Record<string, unknown>
  g[UI_VIRTUAL_CANVAS_KEY] = (width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    if (width <= 0 || height <= 0) return
    post(Math.floor(width), Math.floor(height))
  }
}