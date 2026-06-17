import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
import { CrdtMessageType } from '@dcl/ecs/dist/serialization/crdt/types'

/** `core::TweenState` — renderer-driven tween progress for worker `tweenCompleted()`. */
const TWEEN_STATE_ID = 1103

/**
 * Apply renderer-encoded LWW PUTs for `TweenState` directly on the scene worker engine.
 * Mirrors `injectTriggerAreaAppendsOnEngine` — same-tick delivery without waiting for transport LWW.
 */
export function injectRendererLwwPutsOnEngine(engine: IEngine, chunks: Uint8Array[]): number {
  const TweenState = generated.TweenState(engine)
  let applied = 0

  for (const chunk of chunks) {
    const buf = new ReadWriteByteBuffer(chunk)
    let msg = readMessage(buf)
    while (msg) {
      if (msg.type === CrdtMessageType.PUT_COMPONENT && msg.componentId === TWEEN_STATE_ID) {
        const valueBuf = new ReadWriteByteBuffer(msg.data)
        const value = TweenState.schema.deserialize(valueBuf)
        TweenState.createOrReplace(msg.entityId as Entity, value)
        applied++
      }
      msg = readMessage(buf)
    }
  }

  return applied
}