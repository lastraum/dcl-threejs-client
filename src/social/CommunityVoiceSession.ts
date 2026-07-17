import type { AuthIdentity } from '@dcl/crypto/dist/types'
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication
} from 'livekit-client'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { parseLiveKitConnectionString } from '../network/comms/livekitAdapter'
import { joinCommunityVoiceChat } from '../network/gatekeeper/communityVoice'
import { voiceChatVolumeMultiplier, volumeToGain, soundSettings } from '../rendering/SoundSettings'

/**
 * Separate LiveKit room for community voice (not nearby scene voice).
 * Flat HTML audio — community rooms are not spatial.
 */
export class CommunityVoiceSession {
  private room: Room | null = null
  private communityId: string | null = null
  private audioHost: HTMLDivElement | null = null
  private readonly remotes = new Map<string, HTMLAudioElement>()
  private unsubSound: (() => void) | null = null

  constructor() {
    this.unsubSound = soundSettings.subscribe(() => this.applyVolumes())
  }

  isActive(): boolean {
    return this.room?.state === ConnectionState.Connected
  }

  getCommunityId(): string | null {
    return this.communityId
  }

  async join(options: {
    identity: AuthIdentity
    communityId: string
    userAddress: string
    action?: 'create' | 'join'
    displayName?: string
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    await this.leave()

    const result = await joinCommunityVoiceChat(options.identity, {
      communityId: options.communityId,
      userAddress: options.userAddress,
      action: options.action ?? 'join',
      userRole: 'member',
      profileName: options.displayName
    })
    if (!result.ok) {
      return { ok: false, error: result.error }
    }

    let url: string
    let token: string
    try {
      ;({ url, token } = parseLiveKitConnectionString(result.connectionUrl))
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    const room = new Room({ adaptiveStream: false, dynacast: false })
    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return
      this.attachRemote(track as RemoteTrack, pub as RemoteTrackPublication, participant as RemoteParticipant)
    })
    room.on(RoomEvent.TrackUnsubscribed, (_track, pub, participant) => {
      const key = `${participant.identity}:${pub.trackSid}`
      this.detachRemote(key)
    })
    room.on(RoomEvent.Disconnected, () => {
      this.clearRemotes()
      this.communityId = null
    })

    try {
      await room.connect(url, token)
      await room.localParticipant.setMicrophoneEnabled(true)
    } catch (err) {
      room.disconnect()
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }

    this.room = room
    this.communityId = options.communityId
    // Attach any already-subscribed remote audio.
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.kind === Track.Kind.Audio && pub.track) {
          this.attachRemote(pub.track as RemoteTrack, pub as RemoteTrackPublication, p)
        }
      }
    }
    clientDebugLog.log('social', `Community voice joined · ${options.communityId}`, {
      level: 'success',
      alsoConsole: true
    })
    return { ok: true }
  }

  async leave(): Promise<void> {
    this.clearRemotes()
    if (this.room) {
      try {
        await this.room.localParticipant.setMicrophoneEnabled(false)
      } catch {
        /* ignore */
      }
      this.room.disconnect()
      this.room = null
    }
    this.communityId = null
  }

  dispose(): void {
    void this.leave()
    this.unsubSound?.()
    this.unsubSound = null
    this.audioHost?.remove()
    this.audioHost = null
  }

  private ensureHost(): HTMLDivElement {
    if (this.audioHost?.isConnected) return this.audioHost
    const host = document.createElement('div')
    host.id = 'community-voice-audio-host'
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText =
      'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0.01;pointer-events:none;left:0;top:0'
    document.body.appendChild(host)
    this.audioHost = host
    return host
  }

  private attachRemote(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void {
    const key = `${participant.identity}:${publication.trackSid}`
    if (this.remotes.has(key)) return
    const el = track.attach() as HTMLAudioElement
    el.autoplay = true
    el.setAttribute('playsinline', 'true')
    el.volume = remoteGain()
    this.ensureHost().appendChild(el)
    void el.play().catch(() => {
      /* autoplay policy */
    })
    this.remotes.set(key, el)
  }

  private detachRemote(key: string): void {
    const el = this.remotes.get(key)
    if (!el) return
    try {
      el.pause()
      el.srcObject = null
      el.remove()
    } catch {
      /* ignore */
    }
    this.remotes.delete(key)
  }

  private clearRemotes(): void {
    for (const key of [...this.remotes.keys()]) this.detachRemote(key)
  }

  private applyVolumes(): void {
    const g = remoteGain()
    for (const el of this.remotes.values()) el.volume = g
  }
}

function remoteGain(): number {
  return Math.min(
    1,
    Math.max(0, voiceChatVolumeMultiplier() * volumeToGain(soundSettings.get().masterVolume))
  )
}

/** App-wide singleton so Settings + /communities share one session. */
let sharedCommunityVoice: CommunityVoiceSession | null = null

export function getCommunityVoiceSession(): CommunityVoiceSession {
  if (!sharedCommunityVoice) sharedCommunityVoice = new CommunityVoiceSession()
  return sharedCommunityVoice
}
