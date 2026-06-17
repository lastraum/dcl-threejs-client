/** Legacy EngineApi `SendBatchResponse.events` shapes (kernel engine_api.proto). */

export const EngineApiEventType = {
  GENERIC: 0,
  POSITION_CHANGED: 1,
  ROTATION_CHANGED: 2
} as const

export type EngineApiEvent =
  | {
      type: typeof EngineApiEventType.GENERIC
      generic: { eventId: string; eventData: string }
    }
  | {
      type: typeof EngineApiEventType.POSITION_CHANGED
      positionChanged: {
        position: { x: number; y: number; z: number }
        cameraPosition: { x: number; y: number; z: number }
        playerHeight: number
      }
    }
  | {
      type: typeof EngineApiEventType.ROTATION_CHANGED
      rotationChanged: {
        rotation: { x: number; y: number; z: number }
        quaternion: { x: number; y: number; z: number; w: number }
      }
    }

export function createGenericEngineApiEvent(eventId: string, data: unknown): EngineApiEvent {
  return {
    type: EngineApiEventType.GENERIC,
    generic: {
      eventId,
      eventData: typeof data === 'string' ? data : JSON.stringify(data)
    }
  }
}

/** Payload for `onCommsMessage` / message-bus (SDK7 `pollEvents` — only comms id consumed). */
export function createCommsEngineApiEvent(message: string, sender: string): EngineApiEvent {
  return createGenericEngineApiEvent('comms', { message, sender })
}
