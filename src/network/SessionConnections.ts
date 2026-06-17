import type { World } from '../core/World'

/** Future: LiveKit voice / scene stream sessions. */
export type LiveKitSession = {
  disconnect: () => Promise<void>
}

let liveKitSession: LiveKitSession | null = null

export function setLiveKitSession(session: LiveKitSession | null): void {
  liveKitSession = session
}

/** Stub hook for when LiveKit is wired (voice, scene watch, etc.). */
export async function disconnectLiveKit(): Promise<void> {
  if (!liveKitSession) return
  try {
    await liveKitSession.disconnect()
  } catch (err) {
    console.warn('[session] LiveKit disconnect failed', err)
  } finally {
    liveKitSession = null
  }
}

/** Tear down comms, voice, and world runtime before returning to splash. */
export async function disconnectAll(world: World | null): Promise<void> {
  await disconnectLiveKit()
  world?.dispose()
}
