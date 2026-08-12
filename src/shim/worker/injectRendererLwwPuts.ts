import type { Entity, IEngine } from '@dcl/ecs'
import * as extended from '@dcl/ecs/dist/components'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
import { CrdtMessageType } from '@dcl/ecs/dist/serialization/crdt/types'
import { writeHostLwwNoDirty } from './injectHostLww'

/** SDK7 reserved entities — renderer-owned Transform must land same-tick on the worker. */
const RESERVED_ENTITIES = new Set<Entity>([0 as Entity, 1 as Entity, 2 as Entity])

/** `core::TweenState` — renderer-driven tween progress for worker `tweenCompleted()`. */
const TWEEN_STATE_ID = 1103
/** TweenStateStatus.TS_COMPLETED — sequence advance leaves this stale on the next leg. */
const TS_COMPLETED = 1
/** TweenLoop.TL_RESTART / TL_YOYO */
const TL_RESTART = 0
const TL_YOYO = 1
/** `core::RaycastResult` — renderer raycast hits for worker `raycastSystem` callbacks. */
const RAYCAST_RESULT_ID = 1068
/** `core::GltfContainerLoadingState` — renderer reports GLB load progress (ADR-215). */
const GLTF_CONTAINER_LOADING_STATE_ID = 1049
/** `core::VideoPlayer` — renderer syncs `playing` on natural end for scene toggle parity. */
const VIDEO_PLAYER_ID = 1043
/** `core::AudioSource` — renderer syncs `playing` on natural end for scene toggle parity. */
const AUDIO_SOURCE_ID = 1020
/** `core::AudioAnalysis` — renderer fills amplitude + 8 frequency bands. */
const AUDIO_ANALYSIS_ID = 1212
/** `core::UiCanvasInformation` — renderer injects virtual canvas size for scene UI systems. */
const UI_CANVAS_INFORMATION_ID = 1054
/** `core::UiInputResult` — renderer writes typed text back to scene systems. */
const UI_INPUT_RESULT_ID = 1095
/** `core::UiDropdownResult` — renderer writes selected index back to scene systems. */
const UI_DROPDOWN_RESULT_ID = 1096
/** `core::CameraMode` — renderer reports 1st/3rd person on CameraEntity. */
const CAMERA_MODE_ID = 1072
/** `core::PointerLock` — renderer reports pointer-lock state on CameraEntity. */
const POINTER_LOCK_ID = 1074
/** `core::RealmInfo` — renderer injects scene-room connect for SDK network catch-up. */
const REALM_INFO_ID = 1106
/** `core::PrimaryPointerInfo` — renderer pointer screen/ray on RootEntity. */
const PRIMARY_POINTER_INFO_ID = 1209
/** `core::EngineInfo` — host frame/tick counters on RootEntity (ADR-148). */
const ENGINE_INFO_ID = 1048

export type RendererLwwInjectCounts = {
  tweenPuts: number
  raycastPuts: number
  gltfLoadingStatePuts: number
  /** FINISHED / FINISHED_WITH_ERROR / NOT_FOUND — SpaceRunner load-freeze release signal. */
  gltfLoadingStateTerminalPuts: number
  videoPlayerPuts: number
  audioSourcePuts: number
  audioAnalysisPuts: number
  uiCanvasPuts: number
  uiInputResultPuts: number
  uiDropdownResultPuts: number
  cameraModePuts: number
  pointerLockPuts: number
  realmInfoPuts: number
  primaryPointerPuts: number
  engineInfoPuts: number
  reservedTransformPuts: number
}

/**
 * Host LWW that scene systems / Component.onChange listen for (excludes reserved pose spam
 * and ambient EngineInfo/PrimaryPointer heartbeats — those ride transport + play ticks).
 */
export function hasDynamicHostLwwInjects(c: RendererLwwInjectCounts): boolean {
  return (
    c.raycastPuts > 0 ||
    c.videoPlayerPuts > 0 ||
    c.audioSourcePuts > 0 ||
    c.audioAnalysisPuts > 0 ||
    c.gltfLoadingStatePuts > 0 ||
    c.uiInputResultPuts > 0 ||
    c.uiDropdownResultPuts > 0 ||
    c.uiCanvasPuts > 0 ||
    c.cameraModePuts > 0 ||
    c.pointerLockPuts > 0 ||
    c.realmInfoPuts > 0
  )
}

/** LoadingState: UNKNOWN=0 LOADING=1 NOT_FOUND=2 FINISHED_WITH_ERROR=3 FINISHED=4 */
function isTerminalGltfLoadingState(currentState: unknown): boolean {
  const s = typeof currentState === 'number' ? currentState : Number(currentState)
  return s === 2 || s === 3 || s === 4
}

/**
 * Apply renderer-encoded LWW PUTs for renderer-owned dynamic components directly on the scene worker engine.
 * Covers every host LWW id CrdtEncoder.recordLww / reserved targets emit so Component.onChange fires.
 */
export function injectRendererLwwPutsOnEngine(engine: IEngine, chunks: Uint8Array[]): RendererLwwInjectCounts {
  preregisterRendererInjectedComponents(engine)
  const Transform = extended.Transform(engine)
  const transformId = Transform.componentId
  const TweenState = generated.TweenState(engine)
  const RaycastResult = generated.RaycastResult(engine)
  const GltfContainerLoadingState = generated.GltfContainerLoadingState(engine)
  const VideoPlayer = generated.VideoPlayer(engine)
  const AudioSource = generated.AudioSource(engine)
  const AudioAnalysis = generated.AudioAnalysis(engine)
  const UiCanvasInformation = generated.UiCanvasInformation(engine)
  const UiInputResult = generated.UiInputResult(engine)
  const UiDropdownResult = generated.UiDropdownResult(engine)
  const CameraMode = generated.CameraMode(engine)
  const PointerLock = generated.PointerLock(engine)
  const RealmInfo = generated.RealmInfo(engine)
  const PrimaryPointerInfo = generated.PrimaryPointerInfo(engine)
  const EngineInfo = generated.EngineInfo(engine)
  let tweenPuts = 0
  let raycastPuts = 0
  let gltfLoadingStatePuts = 0
  let gltfLoadingStateTerminalPuts = 0
  let videoPlayerPuts = 0
  let audioSourcePuts = 0
  let audioAnalysisPuts = 0
  let uiCanvasPuts = 0
  let uiInputResultPuts = 0
  let uiDropdownResultPuts = 0
  let cameraModePuts = 0
  let pointerLockPuts = 0
  let realmInfoPuts = 0
  let primaryPointerPuts = 0
  let engineInfoPuts = 0
  let reservedTransformPuts = 0

  for (const chunk of chunks) {
    const buf = new ReadWriteByteBuffer(chunk)
    let msg = readMessage(buf)
    while (msg) {
      if (msg.type === CrdtMessageType.PUT_COMPONENT) {
        if (msg.componentId === transformId && RESERVED_ENTITIES.has(msg.entityId as Entity)) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = Transform.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(Transform, msg.entityId as number, value)
          reservedTransformPuts++
        } else if (msg.componentId === TWEEN_STATE_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = TweenState.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(TweenState, msg.entityId as number, value)
          tweenPuts++
        } else if (msg.componentId === RAYCAST_RESULT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = RaycastResult.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(RaycastResult, msg.entityId as number, value)
          raycastPuts++
        } else if (msg.componentId === GLTF_CONTAINER_LOADING_STATE_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = GltfContainerLoadingState.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(GltfContainerLoadingState, msg.entityId as number, value)
          gltfLoadingStatePuts++
          const currentState = (value as { currentState?: number } | null)?.currentState
          if (isTerminalGltfLoadingState(currentState)) {
            gltfLoadingStateTerminalPuts++
          }
        } else if (msg.componentId === VIDEO_PLAYER_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = VideoPlayer.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(VideoPlayer, msg.entityId as number, value)
          videoPlayerPuts++
        } else if (msg.componentId === AUDIO_SOURCE_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = AudioSource.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(AudioSource, msg.entityId as number, value)
          audioSourcePuts++
        } else if (msg.componentId === AUDIO_ANALYSIS_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = AudioAnalysis.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(AudioAnalysis, msg.entityId as number, value)
          audioAnalysisPuts++
        } else if (msg.componentId === UI_CANVAS_INFORMATION_ID && msg.entityId === 0) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = UiCanvasInformation.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(UiCanvasInformation, msg.entityId as number, value)
          uiCanvasPuts++
        } else if (msg.componentId === UI_INPUT_RESULT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = UiInputResult.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(UiInputResult, msg.entityId as number, value)
          uiInputResultPuts++
        } else if (msg.componentId === UI_DROPDOWN_RESULT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = UiDropdownResult.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(UiDropdownResult, msg.entityId as number, value)
          uiDropdownResultPuts++
        } else if (msg.componentId === CAMERA_MODE_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = CameraMode.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(CameraMode, msg.entityId as number, value)
          cameraModePuts++
        } else if (msg.componentId === POINTER_LOCK_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = PointerLock.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(PointerLock, msg.entityId as number, value)
          pointerLockPuts++
        } else if (msg.componentId === REALM_INFO_ID && msg.entityId === 0) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = RealmInfo.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(RealmInfo, msg.entityId as number, value)
          realmInfoPuts++
        } else if (msg.componentId === PRIMARY_POINTER_INFO_ID && msg.entityId === 0) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = PrimaryPointerInfo.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(PrimaryPointerInfo, msg.entityId as number, value)
          primaryPointerPuts++
        } else if (msg.componentId === ENGINE_INFO_ID && msg.entityId === 0) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = EngineInfo.schema.deserialize(valueBuf)
          writeHostLwwNoDirty(EngineInfo, msg.entityId as number, value)
          engineInfoPuts++
        }
      }
      msg = readMessage(buf)
    }
  }

  return {
    tweenPuts,
    raycastPuts,
    gltfLoadingStatePuts,
    gltfLoadingStateTerminalPuts,
    videoPlayerPuts,
    audioSourcePuts,
    audioAnalysisPuts,
    uiCanvasPuts,
    uiInputResultPuts,
    uiDropdownResultPuts,
    cameraModePuts,
    pointerLockPuts,
    realmInfoPuts,
    primaryPointerPuts,
    engineInfoPuts,
    reservedTransformPuts
  }
}

/**
 * After TweenState COMPLETED inject + eng.update(0), TweenSequence may createOrReplace the
 * next leg while TweenState is still COMPLETED. SDK createTweenSystem then treats the new
 * tween as already finished (isCompleted) — Genesis blimp TL_RESTART only runs one orbit.
 *
 * Re-arm ACTIVE for playing sequence/loop tweens still marked COMPLETED.
 * @returns number of entities re-armed
 */
export function rearmTweenStateAfterSequenceAdvance(engine: IEngine): number {
  const Tween = generated.Tween(engine)
  const TweenState = generated.TweenState(engine)
  const TweenSequence = generated.TweenSequence(engine)
  let n = 0
  for (const [entity, tween] of engine.getEntitiesWith(Tween)) {
    if (tween.playing === false) continue
    const st = TweenState.getOrNull(entity)
    if (!st || st.state !== TS_COMPLETED) continue
    const seq = TweenSequence.getOrNull(entity)
    if (!seq) continue
    const hasQueued = (seq.sequence?.length ?? 0) > 0
    const loops = seq.loop === TL_RESTART || seq.loop === TL_YOYO
    if (!hasQueued && !loops) continue
    writeHostLwwNoDirty(TweenState, entity as number, { state: 0, currentTime: 0 })
    n++
  }
  return n
}
