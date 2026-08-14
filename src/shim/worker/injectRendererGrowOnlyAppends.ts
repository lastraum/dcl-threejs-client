import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
import { CrdtMessageType } from '@dcl/ecs/dist/serialization/crdt/types'
import { nextWorkerPointerEventTimestamp } from './workerPointerEventTimestamp'
import { forEachWorkerPointerEventsResult } from './resolveBundledUiComponents'

/** `core::TriggerAreaResult` — grow-only trigger events from the renderer. */
const TRIGGER_AREA_RESULT_ID = 1061
/** `core::VideoEvent` — grow-only playback events for worker `videoEventsSystem` / onChange. */
const VIDEO_EVENT_ID = 1044
/** `core::PointerEventsResult` — grow-only pointer down/up from the renderer. */
const POINTER_EVENTS_RESULT_ID = 1063
/** `core::AudioEvent` — grow-only audio state for worker `AudioEvent.onChange`. */
const AUDIO_EVENT_ID = 1105
/** `core::AssetLoadLoadingState` — grow-only AssetLoad progress for scene systems. */
const ASSET_LOAD_LOADING_STATE_ID = 1214

export type RendererGrowOnlyInjectCounts = {
  triggerAppends: number
  videoAppends: number
  pointerAppends: number
  audioAppends: number
  assetLoadAppends: number
}

/** True when any host grow-only APPEND was applied (any component scenes may onChange). */
export function hasGrowOnlyInjects(c: RendererGrowOnlyInjectCounts): boolean {
  return (
    c.triggerAppends > 0 ||
    c.videoAppends > 0 ||
    c.pointerAppends > 0 ||
    c.audioAppends > 0 ||
    c.assetLoadAppends > 0
  )
}

/**
 * Apply renderer-encoded grow-only APPEND_VALUE ops directly on the scene worker engine.
 * Covers every host grow-only id CrdtEncoder.recordAppend accepts so Component.onChange /
 * SDK event systems fire after the subsequent engine.update.
 */
export function injectRendererGrowOnlyAppendsOnEngine(
  engine: IEngine,
  chunks: Uint8Array[]
): RendererGrowOnlyInjectCounts {
  preregisterRendererInjectedComponents(engine)
  const TriggerAreaResult = generated.TriggerAreaResult(engine)
  const VideoEvent = generated.VideoEvent(engine)
  const AudioEvent = generated.AudioEvent(engine)
  const AssetLoadLoadingState = generated.AssetLoadLoadingState(engine)
  let triggerAppends = 0
  let videoAppends = 0
  let pointerAppends = 0
  let audioAppends = 0
  let assetLoadAppends = 0

  for (const chunk of chunks) {
    const buf = new ReadWriteByteBuffer(chunk)
    let msg = readMessage(buf)
    while (msg) {
      if (msg.type === CrdtMessageType.APPEND_VALUE) {
        if (msg.componentId === TRIGGER_AREA_RESULT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = TriggerAreaResult.schema.deserialize(valueBuf)
          TriggerAreaResult.addValue(msg.entityId as Entity, value)
          triggerAppends++
        } else if (msg.componentId === VIDEO_EVENT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = VideoEvent.schema.deserialize(valueBuf)
          VideoEvent.addValue(msg.entityId as Entity, value)
          videoAppends++
        } else if (msg.componentId === POINTER_EVENTS_RESULT_ID) {
          const raw = msg.data
          const entityId = msg.entityId as Entity
          let first = true
          forEachWorkerPointerEventsResult(engine, (PointerEventsResult) => {
            const value = PointerEventsResult.schema.deserialize(new ReadWriteByteBuffer(raw))
            value.timestamp = nextWorkerPointerEventTimestamp()
            PointerEventsResult.addValue(entityId, value)
            if (first) {
              pointerAppends++
              first = false
            }
          })
        } else if (msg.componentId === AUDIO_EVENT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = AudioEvent.schema.deserialize(valueBuf)
          AudioEvent.addValue(msg.entityId as Entity, value)
          audioAppends++
        } else if (msg.componentId === ASSET_LOAD_LOADING_STATE_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = AssetLoadLoadingState.schema.deserialize(valueBuf)
          AssetLoadLoadingState.addValue(msg.entityId as Entity, value)
          assetLoadAppends++
        }
      }
      msg = readMessage(buf)
    }
  }

  return { triggerAppends, videoAppends, pointerAppends, audioAppends, assetLoadAppends }
}

/** @deprecated Use `injectRendererGrowOnlyAppendsOnEngine` — kept for call-site grep stability. */
export function injectTriggerAreaAppendsOnEngine(engine: IEngine, chunks: Uint8Array[]): number {
  const c = injectRendererGrowOnlyAppendsOnEngine(engine, chunks)
  return (
    c.triggerAppends + c.videoAppends + c.pointerAppends + c.audioAppends + c.assetLoadAppends
  )
}
