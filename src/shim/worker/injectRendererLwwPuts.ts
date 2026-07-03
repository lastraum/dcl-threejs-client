import type { Entity, IEngine } from '@dcl/ecs'
import * as extended from '@dcl/ecs/dist/components'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
import { CrdtMessageType } from '@dcl/ecs/dist/serialization/crdt/types'

/** SDK7 reserved entities — renderer-owned Transform must land same-tick on the worker. */
const RESERVED_ENTITIES = new Set<Entity>([0 as Entity, 1 as Entity, 2 as Entity])

/** `core::TweenState` — renderer-driven tween progress for worker `tweenCompleted()`. */
const TWEEN_STATE_ID = 1103
/** `core::RaycastResult` — renderer raycast hits for worker `raycastSystem` callbacks. */
const RAYCAST_RESULT_ID = 1068
/** `core::VideoPlayer` — renderer syncs `playing` on natural end for scene toggle parity. */
const VIDEO_PLAYER_ID = 1043
/** `core::UiCanvasInformation` — renderer injects virtual canvas size for scene UI systems. */
const UI_CANVAS_INFORMATION_ID = 1054
/** `core::UiInputResult` — renderer writes typed text back to scene systems. */
const UI_INPUT_RESULT_ID = 1095
/** `core::UiDropdownResult` — renderer writes selected index back to scene systems. */
const UI_DROPDOWN_RESULT_ID = 1096

export type RendererLwwInjectCounts = {
  tweenPuts: number
  raycastPuts: number
  videoPlayerPuts: number
  uiCanvasPuts: number
  uiInputResultPuts: number
  uiDropdownResultPuts: number
  reservedTransformPuts: number
}

/**
 * Apply renderer-encoded LWW PUTs for renderer-owned dynamic components directly on the scene worker engine.
 * Mirrors `injectTriggerAreaAppendsOnEngine` — same-tick delivery without waiting for transport LWW.
 */
export function injectRendererLwwPutsOnEngine(engine: IEngine, chunks: Uint8Array[]): RendererLwwInjectCounts {
  preregisterRendererInjectedComponents(engine)
  const Transform = extended.Transform(engine)
  const transformId = Transform.componentId
  const TweenState = generated.TweenState(engine)
  const RaycastResult = generated.RaycastResult(engine)
  const VideoPlayer = generated.VideoPlayer(engine)
  const UiCanvasInformation = generated.UiCanvasInformation(engine)
  const UiInputResult = generated.UiInputResult(engine)
  const UiDropdownResult = generated.UiDropdownResult(engine)
  let tweenPuts = 0
  let raycastPuts = 0
  let videoPlayerPuts = 0
  let uiCanvasPuts = 0
  let uiInputResultPuts = 0
  let uiDropdownResultPuts = 0
  let reservedTransformPuts = 0

  for (const chunk of chunks) {
    const buf = new ReadWriteByteBuffer(chunk)
    let msg = readMessage(buf)
    while (msg) {
      if (msg.type === CrdtMessageType.PUT_COMPONENT) {
        if (msg.componentId === transformId && RESERVED_ENTITIES.has(msg.entityId as Entity)) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = Transform.schema.deserialize(valueBuf)
          Transform.createOrReplace(msg.entityId as Entity, value)
          reservedTransformPuts++
        } else if (msg.componentId === TWEEN_STATE_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = TweenState.schema.deserialize(valueBuf)
          TweenState.createOrReplace(msg.entityId as Entity, value)
          tweenPuts++
        } else if (msg.componentId === RAYCAST_RESULT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = RaycastResult.schema.deserialize(valueBuf)
          RaycastResult.createOrReplace(msg.entityId as Entity, value)
          raycastPuts++
        } else if (msg.componentId === VIDEO_PLAYER_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = VideoPlayer.schema.deserialize(valueBuf)
          VideoPlayer.createOrReplace(msg.entityId as Entity, value)
          videoPlayerPuts++
        } else if (msg.componentId === UI_CANVAS_INFORMATION_ID && msg.entityId === 0) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = UiCanvasInformation.schema.deserialize(valueBuf)
          UiCanvasInformation.createOrReplace(msg.entityId as Entity, value)
          uiCanvasPuts++
        } else if (msg.componentId === UI_INPUT_RESULT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = UiInputResult.schema.deserialize(valueBuf)
          UiInputResult.createOrReplace(msg.entityId as Entity, value)
          uiInputResultPuts++
        } else if (msg.componentId === UI_DROPDOWN_RESULT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = UiDropdownResult.schema.deserialize(valueBuf)
          UiDropdownResult.createOrReplace(msg.entityId as Entity, value)
          uiDropdownResultPuts++
        }
      }
      msg = readMessage(buf)
    }
  }

  return {
    tweenPuts,
    raycastPuts,
    videoPlayerPuts,
    uiCanvasPuts,
    uiInputResultPuts,
    uiDropdownResultPuts,
    reservedTransformPuts
  }
}