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

export function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]!)
  return btoa(binary)
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
