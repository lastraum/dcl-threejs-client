import { encodeCommsBinaryMessage } from './commsBinaryWire'
import { logSyncDrain, logSyncInbound, unwrapCraftedCommsMessage } from './syncDebug'

/**
 * SDK7 BinaryMessageBus message types.
 *
 * **Serverless / default `@dcl/sdk`:** 1–3.
 * **Authoritative server (`@dcl/sdk@auth-server`, Flagtag-class scenes):** 4–9
 * (CRDT/REQ/RES renumbered; plus server/authoritative/custom-event channels).
 * Host is transport-only — forward the type byte as-is; the scene bundle's SDK
 * registers the handlers for whichever enum it was built with.
 */
export const CommsWireMessageType = {
  // Default SDK (serverless multiplayer)
  CRDT: 1,
  REQ_CRDT_STATE: 2,
  RES_CRDT_STATE: 3,
  // Auth-server SDK extensions
  CRDT_SERVER: 4,
  CRDT_AUTHORITATIVE: 5,
  CUSTOM_EVENT: 6,
  AUTH_CRDT: 7,
  AUTH_REQ_CRDT_STATE: 8,
  AUTH_RES_CRDT_STATE: 9
} as const

/**
 * Buffers inbound scene-room payloads until the next sendBinary response.
 *
 * LiveKit carries SDK `craftCommsMessage` bytes: `[messageType:u8][payload…]`.
 * Worker BinaryMessageBus expects `encodeCommsBinaryMessage` envelopes:
 * `[senderLen][sender][messageType][payload…]`.
 */
export class CommsInboundQueue {
  private readonly pending: Uint8Array[] = []

  /**
   * @param craftedPayload — RFC4 scene-binary body = SDK craftCommsMessage
   *   (`[type][payload]`). Message type is taken from the first byte (not forced CRDT).
   */
  pushSceneBinary(sender: string, craftedPayload: Uint8Array): void {
    const unwrapped = unwrapCraftedCommsMessage(craftedPayload)
    if (!unwrapped) return
    const { messageType, payload } = unwrapped
    logSyncInbound({
      sender,
      messageType,
      payloadBytes: payload.byteLength
    })
    this.pending.push(encodeCommsBinaryMessage(sender, messageType, payload))
  }

  /** @deprecated Prefer pushSceneBinary — type must come from craftCommsMessage. */
  pushSceneBinaryTyped(sender: string, payload: Uint8Array, messageType: number): void {
    logSyncInbound({ sender, messageType, payloadBytes: payload.byteLength })
    this.pending.push(encodeCommsBinaryMessage(sender, messageType, payload))
  }

  drain(): Uint8Array[] {
    if (!this.pending.length) return []
    const out = this.pending.slice()
    this.pending.length = 0
    let totalBytes = 0
    for (const m of out) totalBytes += m.byteLength
    logSyncDrain({ count: out.length, totalBytes })
    return out
  }

  clear(): void {
    this.pending.length = 0
  }
}
