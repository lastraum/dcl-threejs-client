/**
 * Scene VideoPlayer.src for LiveKit media (composite, MessageBus, Admin Tools, or sync).
 *
 * **Screen content authority (client):**
 * 1. `main.composite` / CRDT — initial VideoPlayer on the entity
 * 2. Scene runtime mutations (Admin MessageBus `admin:set-video`, scene scripts)
 * 3. SyncComponents / `syncEntity` (not implemented here yet) — multiplayer LWW on VideoPlayer
 *
 * This URL is only the decoder backend for LiveKit. Stream-key RTMP ingress and DCL Cast both
 * publish into the **scene** LiveKit room; m3u8 / static https use normal HTTP decoders.
 */
export const LIVEKIT_CURRENT_STREAM_SRC = 'livekit-video://current-stream'

export function isLiveKitVideoSrc(src: string): boolean {
  return /^livekit-video:\/\//i.test(src.trim())
}

export function isLiveKitCurrentStreamSrc(src: string): boolean {
  const normalized = src.trim().toLowerCase()
  return normalized === LIVEKIT_CURRENT_STREAM_SRC || normalized === 'livekit-video://current_stream'
}