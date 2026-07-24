/**
 * Dedicated LiveKit room for Cast 2.0 watchers (not scene chat).
 * Connect with gatekeeper POST /cast/watcher-token credentials.
 */
import { ConnectionState, Room, RoomEvent, Track, type RemoteTrackPublication } from 'livekit-client'
import {
  clearCastVideoHost,
  reattachFirstRemoteVideoToHost,
  forceSubscribeRemoteVideo
} from './livekitVideoStreams'

export class CastLiveKitRoom {
  private room: Room | null = null
  private hostUnsub: (() => void) | null = null

  isConnected(): boolean {
    return this.room?.state === ConnectionState.Connected
  }

  getRoom(): Room | null {
    return this.room
  }

  async connect(url: string, token: string): Promise<boolean> {
    this.disconnect()
    const room = new Room({ adaptiveStream: false, dynacast: false })
    this.room = room
    try {
      // url may be wss://… or livekit:wss://…
      const u = url.trim().startsWith('livekit:') ? url.trim().slice('livekit:'.length) : url.trim()
      await room.connect(u, token, { autoSubscribe: true })
      // Join live is a user gesture path — unlock remote A/V playback ASAP.
      try {
        await room.startAudio()
      } catch {
        void room.startAudio().catch(() => {})
      }
      // Force-sub remote video + stream audio (mic stays for voice chat if shared room).
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub.kind !== Track.Kind.Video && pub.kind !== Track.Kind.Audio) continue
          try {
            ;(pub as RemoteTrackPublication).setSubscribed(true)
          } catch {
            /* ignore */
          }
        }
      }
      return room.state === ConnectionState.Connected
    } catch {
      this.disconnect()
      return false
    }
  }

  /**
   * Attach best remote video into host; re-try on track events.
   */
  bindVideoToHost(
    host: HTMLElement,
    onUpdate?: (attached: boolean) => void,
    opts?: { muted?: boolean; volume?: number }
  ): () => void {
    const room = this.room
    if (!room) {
      onUpdate?.(false)
      return () => {}
    }

    let last = false
    const attach = (): void => {
      forceSubscribeRemoteVideo(room)
      // reattach also force-subs + mounts companion stream audio tracks
      const ok = reattachFirstRemoteVideoToHost(room, host, {
        muted: opts?.muted,
        volume: opts?.volume,
        controls: false
      })
      // Only notify on transition — reattach itself no-ops same track (no flicker).
      if (ok !== last) {
        last = ok
        onUpdate?.(ok)
      }
    }

    const onEv = (): void => attach()
    room.on(RoomEvent.TrackSubscribed, onEv)
    room.on(RoomEvent.TrackUnsubscribed, onEv)
    room.on(RoomEvent.TrackPublished, onEv)
    room.on(RoomEvent.TrackUnpublished, onEv)
    room.on(RoomEvent.ParticipantConnected, onEv)
    room.on(RoomEvent.ParticipantDisconnected, onEv)
    room.on(RoomEvent.Disconnected, onEv)

    attach()
    // Poll for late RTMP publishers and stream-end (clears host + onUpdate(false)).
    const poll = window.setInterval(() => {
      attach()
    }, 2000)
    this.hostUnsub = () => {
      window.clearInterval(poll)
      room.off(RoomEvent.TrackSubscribed, onEv)
      room.off(RoomEvent.TrackUnsubscribed, onEv)
      room.off(RoomEvent.TrackPublished, onEv)
      room.off(RoomEvent.TrackUnpublished, onEv)
      room.off(RoomEvent.ParticipantConnected, onEv)
      room.off(RoomEvent.ParticipantDisconnected, onEv)
      clearCastVideoHost(host)
    }
    return () => {
      this.hostUnsub?.()
      this.hostUnsub = null
    }
  }

  disconnect(): void {
    this.hostUnsub?.()
    this.hostUnsub = null
    if (this.room) {
      void this.room.disconnect().catch(() => {})
      this.room = null
    }
  }
}
