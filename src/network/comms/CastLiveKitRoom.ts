/**
 * Dedicated LiveKit room for cast / OBS stream consumption only.
 * - Subscribes only to streamer-ingress video + companion stream audio
 * - Does not process chat data packets or peer voice/mics
 * - Not used as a general scene chat room
 */
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication
} from 'livekit-client'
import {
  clearCastVideoHost,
  forceSubscribeRemoteVideo,
  isStreamerIngressIdentity,
  isPresentationBotIdentity,
  reattachFirstRemoteVideoToHost
} from './livekitVideoStreams'

function isStreamVideoPub(pub: RemoteTrackPublication, identity: string): boolean {
  if (pub.kind !== Track.Kind.Video) return false
  // Prefer known cast/ingress identities; also allow screen-share from any remote.
  if (isStreamerIngressIdentity(identity) || isPresentationBotIdentity(identity)) return true
  if (pub.source === Track.Source.ScreenShare) return true
  // Ingress sometimes uses Unknown source with -streamer identity only (handled above).
  return false
}

function isStreamAudioPub(pub: RemoteTrackPublication, identity: string, hasStreamVideo: boolean): boolean {
  if (pub.kind !== Track.Kind.Audio) return false
  // Companion audio on same streamer participant (incl. mic-labelled ingress).
  if (isStreamerIngressIdentity(identity) || isPresentationBotIdentity(identity)) return true
  // Non-mic stream audio when we already matched a stream video publisher.
  if (hasStreamVideo && pub.source !== Track.Source.Microphone) return true
  if (pub.source === Track.Source.ScreenShareAudio) return true
  return false
}

export class CastLiveKitRoom {
  private room: Room | null = null
  private hostUnsub: (() => void) | null = null

  isConnected(): boolean {
    return this.room?.state === ConnectionState.Connected
  }

  getRoom(): Room | null {
    return this.room
  }

  /**
   * Connect as a pure stream consumer.
   * autoSubscribe=false — we only subscribe to cast/ingress A/V tracks.
   */
  async connect(url: string, token: string): Promise<boolean> {
    this.disconnect()
    const room = new Room({
      adaptiveStream: true,
      dynacast: false
    })
    this.room = room
    try {
      const u = url.trim().startsWith('livekit:') ? url.trim().slice('livekit:'.length) : url.trim()
      // Stream-only: do not auto-sub peer cams/mics/data consumers.
      await room.connect(u, token, { autoSubscribe: false })
      try {
        await room.startAudio()
      } catch {
        void room.startAudio().catch(() => {})
      }
      this.subscribeStreamTracksOnly(room)
      // Ignore data messages (chat / RFC4) — no dataReceived handlers registered.
      return room.state === ConnectionState.Connected
    } catch {
      this.disconnect()
      return false
    }
  }

  /** Subscribe only to OBS/cast ingress video + companion audio. */
  private subscribeStreamTracksOnly(room: Room): void {
    const applyForParticipant = (p: RemoteParticipant): void => {
      const identity = p.identity?.trim() || ''
      let hasStreamVideo = false
      for (const pub of p.trackPublications.values()) {
        if (isStreamVideoPub(pub as RemoteTrackPublication, identity)) {
          hasStreamVideo = true
          break
        }
      }
      for (const pub of p.trackPublications.values()) {
        const rp = pub as RemoteTrackPublication
        const want =
          isStreamVideoPub(rp, identity) || isStreamAudioPub(rp, identity, hasStreamVideo)
        try {
          if (want && !rp.isSubscribed) rp.setSubscribed(true)
          if (!want && rp.isSubscribed) rp.setSubscribed(false)
        } catch {
          /* ignore */
        }
      }
    }

    for (const p of room.remoteParticipants.values()) {
      applyForParticipant(p)
    }

    // Also force helper path for video (streamer priority).
    forceSubscribeRemoteVideo(room)

    room.on(RoomEvent.TrackPublished, (pub, participant) => {
      if (participant.isLocal) return
      const identity = participant.identity?.trim() || ''
      const rp = pub as RemoteTrackPublication
      const hasStreamVideo =
        isStreamerIngressIdentity(identity) ||
        isPresentationBotIdentity(identity) ||
        rp.source === Track.Source.ScreenShare
      const want =
        isStreamVideoPub(rp, identity) || isStreamAudioPub(rp, identity, hasStreamVideo)
      if (want) {
        try {
          rp.setSubscribed(true)
        } catch {
          /* ignore */
        }
      }
    })

    room.on(RoomEvent.ParticipantConnected, (p) => {
      if (!p.isLocal) applyForParticipant(p as RemoteParticipant)
    })
  }

  /**
   * Attach best remote cast video into host; re-try on track events.
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
      this.subscribeStreamTracksOnly(room)
      forceSubscribeRemoteVideo(room)
      const ok = reattachFirstRemoteVideoToHost(room, host, {
        muted: opts?.muted,
        volume: opts?.volume,
        controls: false
      })
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
      room.off(RoomEvent.Disconnected, onEv)
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
