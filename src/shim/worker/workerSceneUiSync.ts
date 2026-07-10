/** @deprecated Import from sceneEngineUiScheduler — kept for internal import stability. */
export {
  commitSceneUiCrdtBaseline,
  computeWorkerUiFingerprint,
  flushWorkerSceneUiAfterEngineTick,
  hasWorkerReactEcsSync,
  installSceneEngineUiScheduler,
  installWorkerEngineUiHooks,
  planSceneUiCrdtEmit,
  resetWorkerUiFingerprint,
  seedWorkerUiCanvasInformation,
  seedWorkerUiFingerprint,
  touchWorkerUiComponentsForCrdt
} from './sceneEngineUiScheduler'

export { installReactEcsOnceGuard } from './reactEcsOnce'