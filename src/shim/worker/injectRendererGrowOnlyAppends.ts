import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
import { CrdtMessageType } from '@dcl/ecs/dist/serialization/crdt/types'

/** `core::TriggerAreaResult` — grow-only trigger events from the renderer. */
const TRIGGER_AREA_RESULT_ID = 1061
/** `core::VideoEvent` — grow-only playback events for worker `videoEventsSystem`. */
const VIDEO_EVENT_ID = 1044

export type RendererGrowOnlyInjectCounts = {
  triggerAppends: number
  videoAppends: number
}

/**
 * Apply renderer-encoded grow-only APPEND_VALUE ops directly on the scene worker engine.
 * Handles TriggerAreaResult + VideoEvent (and ignores other component ids in mixed batches).
 */
export function injectRendererGrowOnlyAppendsOnEngine(
  engine: IEngine,
  chunks: Uint8Array[]
): RendererGrowOnlyInjectCounts {
  const TriggerAreaResult = generated.TriggerAreaResult(engine)
  const VideoEvent = generated.VideoEvent(engine)
  let triggerAppends = 0
  let videoAppends = 0

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
        }
      }
      msg = readMessage(buf)
    }
  }

  return { triggerAppends, videoAppends }
}

/** @deprecated Use `injectRendererGrowOnlyAppendsOnEngine` — kept for call-site grep stability. */
export function injectTriggerAreaAppendsOnEngine(engine: IEngine, chunks: Uint8Array[]): number {
  const { triggerAppends, videoAppends } = injectRendererGrowOnlyAppendsOnEngine(engine, chunks)
  return triggerAppends + videoAppends
}