import { encodeCommsBinaryMessage } from './commsBinaryWire'

/** SDK7 BinaryMessageBus message types (@dcl/sdk/network/binary-message-bus). */
export const CommsWireMessageType = {
  CRDT: 1,
  REQ_CRDT_STATE: 2,
  RES_CRDT_STATE: 3
} as const

/** Buffers inbound scene-room payloads until the next sendBinary response. */
export class CommsInboundQueue {
  private readonly pending: Uint8Array[] = []

  pushSceneBinary(sender: string, payload: Uint8Array, messageType = CommsWireMessageType.CRDT): void {
    this.pending.push(encodeCommsBinaryMessage(sender, messageType, payload))
  }

  drain(): Uint8Array[] {
    if (!this.pending.length) return []
    const out = this.pending.slice()
    this.pending.length = 0
    return out
  }

  clear(): void {
    this.pending.length = 0
  }
}
