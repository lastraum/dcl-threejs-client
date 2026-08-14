/** Wire format expected by @dcl/sdk BinaryMessageBus.decodeCommsMessage. */
export function encodeCommsBinaryMessage(sender: string, messageType: number, payload: Uint8Array): Uint8Array {
  const senderBytes = new TextEncoder().encode(sender)
  if (senderBytes.length > 255) throw new Error('Comms sender address too long')
  const out = new Uint8Array(1 + senderBytes.length + 1 + payload.byteLength)
  out[0] = senderBytes.length
  out.set(senderBytes, 1)
  out[1 + senderBytes.length] = messageType
  out.set(payload, 2 + senderBytes.length)
  return out
}

/**
 * Standalone copy at byteOffset 0. SDK `DataView(buf.buffer)` ignores view offsets —
 * a sliced/transferred envelope decodes the wrong sender and EventBus drops
 * `sender !== "authoritative-server"` with no log.
 */
export function isolateCommsBinaryMessage(chunk: Uint8Array): Uint8Array {
  if (chunk.byteOffset === 0 && chunk.buffer.byteLength === chunk.byteLength) {
    return chunk
  }
  const out = new Uint8Array(chunk.byteLength)
  out.set(chunk)
  return out
}

export function decodeCommsBinaryMessage(
  chunk: Uint8Array
): { sender: string; messageType: number; payload: Uint8Array } | null {
  if (chunk.byteLength < 2) return null
  const senderLen = chunk[0]!
  if (chunk.byteLength < 2 + senderLen) return null
  const sender = new TextDecoder().decode(chunk.subarray(1, 1 + senderLen))
  const messageType = chunk[1 + senderLen]!
  const payload = chunk.subarray(2 + senderLen)
  return { sender, messageType, payload }
}

export function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]!)
  return btoa(binary)
}

export function base64ToBytes(data: string): Uint8Array {
  const trimmed = data.trim()
  if (!trimmed) return new Uint8Array(0)
  try {
    const binary = atob(trimmed)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return new TextEncoder().encode(data)
  }
}
