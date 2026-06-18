import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
import { CrdtMessageType } from '@dcl/ecs/dist/serialization/crdt/types'

/** `core::TweenState` — renderer-driven tween progress for worker `tweenCompleted()`. */
const TWEEN_STATE_ID = 1103
/** `core::RaycastResult` — renderer raycast hits for worker `raycastSystem` callbacks. */
const RAYCAST_RESULT_ID = 1068

export type RendererLwwInjectCounts = {
  tweenPuts: number
  raycastPuts: number
}

/**
 * Apply renderer-encoded LWW PUTs for renderer-owned dynamic components directly on the scene worker engine.
 * Mirrors `injectTriggerAreaAppendsOnEngine` — same-tick delivery without waiting for transport LWW.
 */
export function injectRendererLwwPutsOnEngine(engine: IEngine, chunks: Uint8Array[]): RendererLwwInjectCounts {
  const TweenState = generated.TweenState(engine)
  const RaycastResult = generated.RaycastResult(engine)
  let tweenPuts = 0
  let raycastPuts = 0

  for (const chunk of chunks) {
    const buf = new ReadWriteByteBuffer(chunk)
    let msg = readMessage(buf)
    while (msg) {
      if (msg.type === CrdtMessageType.PUT_COMPONENT) {
        if (msg.componentId === TWEEN_STATE_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = TweenState.schema.deserialize(valueBuf)
          TweenState.createOrReplace(msg.entityId as Entity, value)
          tweenPuts++
        } else if (msg.componentId === RAYCAST_RESULT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = RaycastResult.schema.deserialize(valueBuf)
          RaycastResult.createOrReplace(msg.entityId as Entity, value)
          raycastPuts++
        }
      }
      msg = readMessage(buf)
    }
  }

  return { tweenPuts, raycastPuts }
}