/**
 * Scene-network CRDT size budget — mirrors `@dcl/ecs` `LIVEKIT_MAX_SIZE` (KB).
 * SDK scene transport chunks outbound network CRDT to this budget before
 * craftCommsMessage; the host enforces the same ceiling on publish so a
 * misbehaving peer / oversized RES never saturates LiveKit data channel.
 */
export const LIVEKIT_MAX_SIZE_KB = 12

/** Max crafted scene-binary payload (SDK network CRDT chunk) before RFC4 wrap. */
export const LIVEKIT_MAX_CRAFTED_BYTES = LIVEKIT_MAX_SIZE_KB * 1024

/**
 * Max final `publishData` packet after RFC4 Scene envelope.
 * Slightly above crafted max to leave room for protobuf/sceneId overhead.
 */
export const LIVEKIT_MAX_PUBLISH_BYTES = LIVEKIT_MAX_CRAFTED_BYTES + 2048

export function isOversizedCraftedChunk(chunk: Uint8Array): boolean {
  return chunk.byteLength > LIVEKIT_MAX_CRAFTED_BYTES
}

export function isOversizedPublishPacket(packet: Uint8Array): boolean {
  return packet.byteLength > LIVEKIT_MAX_PUBLISH_BYTES
}
