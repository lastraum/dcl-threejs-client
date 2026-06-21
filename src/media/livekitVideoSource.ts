/** DCL Cast / Admin-tools live stream URL for VideoPlayer.src. */
export const LIVEKIT_CURRENT_STREAM_SRC = 'livekit-video://current-stream'

export function isLiveKitVideoSrc(src: string): boolean {
  return /^livekit-video:\/\//i.test(src.trim())
}

export function isLiveKitCurrentStreamSrc(src: string): boolean {
  const normalized = src.trim().toLowerCase()
  return normalized === LIVEKIT_CURRENT_STREAM_SRC || normalized === 'livekit-video://current_stream'
}