import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
import { CrdtMessageType } from '@dcl/ecs/dist/serialization/crdt/types'

/** `core::TriggerAreaResult` — grow-only trigger events from the renderer. */
const TRIGGER_AREA_RESULT_ID = 1061

/**
 * Write TriggerAreaResult appends directly on the scene worker engine (same-tick as pointer inject).
 * Parses renderer-encoded APPEND_VALUE ops from `encodeAppendsOnly()` payloads.
 */
export function injectTriggerAreaAppendsOnEngine(engine: IEngine, chunks: Uint8Array[]): number {
  const TriggerAreaResult = generated.TriggerAreaResult(engine)
  let applied = 0

  for (const chunk of chunks) {
    const buf = new ReadWriteByteBuffer(chunk)
    let msg = readMessage(buf)
    while (msg) {
      if (msg.type === CrdtMessageType.APPEND_VALUE && msg.componentId === TRIGGER_AREA_RESULT_ID) {
        const valueBuf = new ReadWriteByteBuffer(msg.data)
        const value = TriggerAreaResult.schema.deserialize(valueBuf)
        TriggerAreaResult.addValue(msg.entityId as Entity, value)
        applied++
      }
      msg = readMessage(buf)
    }
  }

  return applied
}