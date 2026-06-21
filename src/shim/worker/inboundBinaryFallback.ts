import {
  decodeCommsBinaryMessage,
  SceneBinaryMessageType
} from '../../network/sceneSync/sceneBinaryWire'
export type InboundBinaryFallbackDeps = {
  postAuthoritativeCrdt: (data: Uint8Array) => void
  applyNetworkCrdt: (data: Uint8Array) => void
  log: (level: 'log' | 'warn', message: string) => void
}

function isAuthoritativeInboundMessage(messageType: number): boolean {
  return (
    messageType === SceneBinaryMessageType.CRDT_AUTHORITATIVE ||
    messageType === SceneBinaryMessageType.RES_CRDT_STATE ||
    messageType === SceneBinaryMessageType.CRDT
  )
}

/** Forward authoritative CRDT payloads to main projection (worker engine already updated separately). */
export function forwardAuthoritativeInboundChunks(
  chunks: Uint8Array[],
  postAuthoritativeCrdt: (data: Uint8Array) => void
): number {
  let forwarded = 0
  for (const chunk of chunks) {
    const decoded = decodeCommsBinaryMessage(chunk)
    if (!decoded) continue
    const { messageType, payload } = decoded
    if (!payload.byteLength || !isAuthoritativeInboundMessage(messageType)) continue
    const copy = payload.slice()
    postAuthoritativeCrdt(copy)
    forwarded++
  }
  return forwarded
}

/** Apply RES_CRDT_STATE / CRDT_AUTHORITATIVE when sync-systems BinaryMessageBus was not captured. */
export function processInboundBinaryFallback(
  chunks: Uint8Array[],
  deps: InboundBinaryFallbackDeps
): number {
  let applied = 0
  for (const chunk of chunks) {
    const decoded = decodeCommsBinaryMessage(chunk)
    if (!decoded) continue
    const { messageType, payload } = decoded
    if (!payload.byteLength || !isAuthoritativeInboundMessage(messageType)) continue
    const copy = payload.slice()
    deps.postAuthoritativeCrdt(copy)
    deps.applyNetworkCrdt(payload)
    applied++
    deps.log(
      'log',
      `[sceneWorker] inbound-binary fallback — type ${messageType} (${payload.byteLength}B)`
    )
  }
  return applied
}