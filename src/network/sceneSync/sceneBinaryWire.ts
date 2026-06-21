/**
 * @dcl/sdk BinaryMessageBus wire format — matches sync-systems `s1e` / `a1e` in scene bundles.
 * @see https://dcl.gg/sdk/sync-systems
 */

/** SDK7 scene-room binary message types (Ro enum in sync-systems). */
export const SceneBinaryMessageType = {
  CRDT_SERVER: 4,
  CRDT_AUTHORITATIVE: 5,
  CUSTOM_EVENT: 6,
  CRDT: 7,
  REQ_CRDT_STATE: 8,
  RES_CRDT_STATE: 9
} as const

/** Peer emit chunk for REQ_CRDT_STATE (sync-systems `a1e`). */
export function encodeReqCrdtStateChunk(): Uint8Array {
  return encodePeerEmitChunk(SceneBinaryMessageType.REQ_CRDT_STATE, new Uint8Array(0))
}

export type SceneBinaryMessageType =
  (typeof SceneBinaryMessageType)[keyof typeof SceneBinaryMessageType]

/** Sender id for authoritative server → client messages (Explorer parity). */
export const AUTHORITATIVE_SERVER_SENDER = 'authoritative-server'

const VALID_MESSAGE_TYPES = new Set<number>(Object.values(SceneBinaryMessageType))

export function isSceneBinaryMessageType(value: number): value is SceneBinaryMessageType {
  return VALID_MESSAGE_TYPES.has(value)
}

/** Peer emit chunk: `[messageType][payload]` (`a1e` in sync-systems). */
export function encodePeerEmitChunk(messageType: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + payload.byteLength)
  out[0] = messageType
  out.set(payload, 1)
  return out
}

/**
 * Full comms message: `[senderLen][senderUtf8][messageType][payload]`
 * Consumed by BinaryMessageBus `__processMessages` / `s1e`.
 */
export function encodeCommsBinaryMessage(
  sender: string,
  messageType: number,
  payload: Uint8Array
): Uint8Array {
  const senderBytes = new TextEncoder().encode(sender)
  if (senderBytes.length > 255) throw new Error('Comms sender address too long')
  const out = new Uint8Array(1 + senderBytes.length + 1 + payload.byteLength)
  out[0] = senderBytes.length
  out.set(senderBytes, 1)
  out[1 + senderBytes.length] = messageType
  out.set(payload, 2 + senderBytes.length)
  return out
}

export type DecodedCommsBinaryMessage = {
  sender: string
  messageType: number
  payload: Uint8Array
}

export function decodeCommsBinaryMessage(data: Uint8Array): DecodedCommsBinaryMessage | null {
  if (data.length < 3) return null
  const senderLen = data[0]!
  if (senderLen === 0 || 1 + senderLen + 1 > data.length) return null
  const sender = new TextDecoder().decode(data.subarray(1, 1 + senderLen))
  const messageType = data[1 + senderLen]!
  const payload = data.subarray(2 + senderLen)
  return { sender, messageType, payload }
}

export function isFullCommsBinaryMessage(data: Uint8Array): boolean {
  const decoded = decodeCommsBinaryMessage(data)
  if (!decoded) return false
  return isSceneBinaryMessageType(decoded.messageType)
}

/** Wrap an RFC4 scene payload or peer emit chunk into a full comms message. */
export function wrapPeerEmitChunk(sender: string, chunk: Uint8Array): Uint8Array | null {
  if (chunk.length < 1) return null
  if (isFullCommsBinaryMessage(chunk)) return chunk.slice()
  const messageType = chunk[0]!
  if (!isSceneBinaryMessageType(messageType)) return null
  return encodeCommsBinaryMessage(sender, messageType, chunk.subarray(1))
}

/** Normalize inbound scene-room binary (full message or peer emit chunk). */
export function normalizeInboundSceneBinary(sender: string, data: Uint8Array): Uint8Array | null {
  if (isFullCommsBinaryMessage(data)) return data.slice()
  return wrapPeerEmitChunk(sender, data)
}