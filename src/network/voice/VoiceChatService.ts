import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type LocalTrackPublication
} from 'livekit-client'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import { isTextInputFocused } from '../../client/ui/textInputFocus'
import {
  soundSettings,
  voiceChatVolumeMultiplier,
  volumeToGain,
  type SoundSettingsState
} from '../../rendering/SoundSettings'

export type VoiceChatSnapshot = {
  hearing: boolean
  speaking: boolean
  backgroundMuted: boolean
  pttHeld: boolean
  micLive: boolean
  remoteCount: number
  roomReady: boolean
  error: string | null
}

type Listener = (state: VoiceChatSnapshot) => void
type RoomProvider = () => Room | null

type RemoteVoiceEntry = {
  element: HTMLAudioElement
  trackSid: string
  participantId: string
}

/**
 * Nearby voice over primary LiveKit room — Explorer-shaped:
 * Hear others · Speak · Hold [T] to speak momentarily.
 *
 * Room is resolved via provider so reconnects (landing → play, island hop)
 * always publish/subscribe on the live Room instance.
 */
export class VoiceChatService {
  private roomProvider: RoomProvider = () => null
  private room: Room | null = null
  private hearing = true
  private speaking = false
  private backgroundMuted = false
  private pttHeld = false
  private micLive = false
  private error: string | null = null
  private remoteCount = 0
  private readonly remotes = new Map<string, RemoteVoiceEntry>()
  private readonly listeners = new Set<Listener>()
  private unsubSound: (() => void) | null = null
  private roomHandlersBound = false
  private publishInFlight: Promise<void> | null = null
  private audioHost: HTMLDivElement | null = null

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (isTextInputFocused() || isEditableTarget(ev.target)) return
    if (ev.repeat || ev.code !== 'KeyT') return
    this.refreshRoomBinding()
    if (!this.room || this.room.state !== ConnectionState.Connected) return
    ev.preventDefault()
    this.setPttHeld(true)
  }

  private readonly onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.code !== 'KeyT') return
    this.setPttHeld(false)
  }

  private readonly onVisibility = (): void => {
    this.syncBackgroundMute()
  }

  constructor() {
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.unsubSound = soundSettings.subscribe((s) => this.onSoundSettings(s))
    this.syncBackgroundMute()
  }

  dispose(): void {
    void this.setSpeaking(false)
    this.pttHeld = false
    this.detachRoomHandlers()
    this.room = null
    this.roomProvider = () => null
    this.audioHost?.remove()
    this.audioHost = null
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.unsubSound?.()
    this.unsubSound = null
    this.listeners.clear()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot(): VoiceChatSnapshot {
    this.refreshRoomBinding()
    return {
      hearing: this.hearing,
      speaking: this.speaking,
      backgroundMuted: this.backgroundMuted,
      pttHeld: this.pttHeld,
      micLive: this.micLive,
      remoteCount: this.remoteCount,
      roomReady: !!this.room && this.room.state === ConnectionState.Connected,
      error: this.error
    }
  }

  /**
   * Prefer a provider so reconnects pick up the new Room.
   * Legacy: attachRoom(room) still works via fixed provider.
   */
  bindRoomProvider(provider: RoomProvider): void {
    this.roomProvider = provider
    this.refreshRoomBinding()
  }

  /** @deprecated use bindRoomProvider — kept for call-site clarity */
  attachRoom(room: Room | null): void {
    this.bindRoomProvider(() => room)
  }

  /** Re-resolve primary LiveKit room (call after every connect / handoff). */
  refreshRoomBinding(): void {
    const next = this.roomProvider()
    if (next === this.room) return

    const keepHearing = this.hearing
    const keepSpeaking = this.speaking
    const wasLive = this.micLive

    this.detachRoomHandlers()
    this.clearAllRemotes()
    this.room = next
    this.micLive = false

    if (next && next.state === ConnectionState.Connected) {
      this.bindRoomHandlers(next)
      this.hearing = keepHearing
      if (this.hearing) void this.applyHearing(true)
      if (keepSpeaking || wasLive) {
        this.speaking = keepSpeaking
        void this.reconcileMicPublish()
      }
      clientDebugLog.log(
        'comms',
        `Voice bound room=${next.name || '?'} remotes=${next.remoteParticipants.size}`,
        { level: 'info', alsoConsole: true }
      )
    } else if (next) {
      // Connected event may fire shortly — bind handlers and wait.
      this.bindRoomHandlers(next)
      next.once(RoomEvent.Connected, () => {
        if (this.room !== next) return
        if (this.hearing) void this.applyHearing(true)
        void this.reconcileMicPublish()
        this.notify()
      })
    }
    this.notify()
  }

  async setHearing(on: boolean): Promise<void> {
    this.refreshRoomBinding()
    if (this.hearing === on) return
    this.hearing = on
    await this.applyHearing(on)
    this.notify()
  }

  async toggleHearing(): Promise<void> {
    await this.setHearing(!this.hearing)
  }

  async setSpeaking(on: boolean): Promise<void> {
    this.refreshRoomBinding()
    if (this.speaking === on) return
    if (on && (!this.room || this.room.state !== ConnectionState.Connected)) {
      this.error = 'Not connected to voice room'
      this.notify()
      clientDebugLog.log('comms', 'Speak blocked — LiveKit not connected', {
        level: 'warn',
        alsoConsole: true
      })
      return
    }
    this.speaking = on
    this.error = null
    if (on) {
      try {
        await this.room!.startAudio()
      } catch {
        /* autoplay */
      }
    }
    await this.reconcileMicPublish()
    this.notify()
    clientDebugLog.log('comms', on ? 'Nearby Speak on' : 'Nearby Speak off', {
      level: on ? 'success' : 'info',
      alsoConsole: true
    })
  }

  async toggleSpeaking(): Promise<void> {
    await this.setSpeaking(!this.speaking)
  }

  private setPttHeld(held: boolean): void {
    if (this.pttHeld === held) return
    this.pttHeld = held
    this.refreshRoomBinding()
    if (held && this.room) {
      void this.room.startAudio().catch(() => {})
    }
    void this.reconcileMicPublish()
    this.notify()
  }

  private shouldPublishMic(): boolean {
    if (!this.room || this.room.state !== ConnectionState.Connected || this.backgroundMuted) {
      return false
    }
    return this.speaking || this.pttHeld
  }

  private async applyHearing(on: boolean): Promise<void> {
    this.refreshRoomBinding()
    if (!this.room || this.room.state !== ConnectionState.Connected) {
      if (!on) this.clearAllRemotes()
      return
    }
    if (on) {
      try {
        await this.room.startAudio()
      } catch {
        /* autoplay */
      }
      this.rescanRemoteVoice()
      this.applyRemoteVolumes()
    } else {
      this.clearAllRemotes()
    }
  }

  private async reconcileMicPublish(): Promise<void> {
    await this.ensureMicPublished(this.shouldPublishMic())
  }

  private async ensureMicPublished(want: boolean): Promise<void> {
    this.refreshRoomBinding()
    const room = this.room
    if (!room || room.state !== ConnectionState.Connected) {
      this.micLive = false
      if (want) {
        this.error = 'Not connected to voice room'
        this.notify()
      }
      return
    }
    if (this.publishInFlight) await this.publishInFlight
    const run = (async () => {
      try {
        // Gatekeeper tokens sometimes set canPublish=false — surface it.
        const canPublish = room.localParticipant.permissions?.canPublish
        if (want && canPublish === false) {
          this.micLive = false
          this.error = 'LiveKit token cannot publish audio (canPublish=false)'
          clientDebugLog.log('comms', this.error, { level: 'error', alsoConsole: true })
          this.notify()
          return
        }

        if (want) {
          const deviceId = soundSettings.get().microphoneDeviceId
          const opts = deviceId ? { deviceId } : undefined
          // Explicit mic source so peers (Explorer / us) treat it as voice, not cast.
          const pub = await room.localParticipant.setMicrophoneEnabled(true, opts, {
            source: Track.Source.Microphone,
            name: 'microphone',
            dtx: true,
            red: true
          })
          this.micLive = !!pub?.track || hasLocalMic(room)
          this.error = null
          clientDebugLog.log(
            'comms',
            `Mic published · live=${this.micLive} sid=${pub?.trackSid?.slice(0, 8) ?? 'n/a'} room=${room.name}`,
            { level: 'success', alsoConsole: true }
          )
        } else {
          await room.localParticipant.setMicrophoneEnabled(false)
          this.micLive = false
        }
      } catch (err) {
        this.micLive = false
        this.error = err instanceof Error ? err.message : String(err)
        clientDebugLog.log('comms', `Mic publish failed: ${this.error}`, {
          level: 'error',
          alsoConsole: true
        })
      }
      this.notify()
    })()
    this.publishInFlight = run
    await run
    if (this.publishInFlight === run) this.publishInFlight = null
  }

  private onSoundSettings(_state: SoundSettingsState): void {
    this.applyRemoteVolumes()
    this.syncBackgroundMute()
    void this.reconcileMicPublish()
    this.notify()
  }

  private syncBackgroundMute(): void {
    const policy = soundSettings.get().muteMicInBackground
    const shouldMute = policy && document.visibilityState === 'hidden'
    if (this.backgroundMuted === shouldMute) return
    this.backgroundMuted = shouldMute
    void this.reconcileMicPublish()
    this.notify()
  }

  private bindRoomHandlers(room: Room): void {
    if (this.roomHandlersBound) return
    this.roomHandlersBound = true
    room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed)
    room.on(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed)
    room.on(RoomEvent.TrackPublished, this.onTrackPublished)
    room.on(RoomEvent.TrackUnpublished, this.onTrackUnpublished)
    room.on(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected)
    room.on(RoomEvent.Disconnected, this.onRoomDisconnected)
    room.on(RoomEvent.Reconnected, this.onRoomReconnected)
    room.on(RoomEvent.LocalTrackPublished, this.onLocalTrackPublished)
    room.on(RoomEvent.LocalTrackUnpublished, this.onLocalTrackUnpublished)
  }

  private detachRoomHandlers(): void {
    const room = this.room
    if (room && this.roomHandlersBound) {
      room.off(RoomEvent.TrackSubscribed, this.onTrackSubscribed)
      room.off(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed)
      room.off(RoomEvent.TrackPublished, this.onTrackPublished)
      room.off(RoomEvent.TrackUnpublished, this.onTrackUnpublished)
      room.off(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected)
      room.off(RoomEvent.Disconnected, this.onRoomDisconnected)
      room.off(RoomEvent.Reconnected, this.onRoomReconnected)
      room.off(RoomEvent.LocalTrackPublished, this.onLocalTrackPublished)
      room.off(RoomEvent.LocalTrackUnpublished, this.onLocalTrackUnpublished)
    }
    this.roomHandlersBound = false
    this.clearAllRemotes()
  }

  private readonly onTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    if (!this.hearing) return
    if (!isVoicePublication(publication, participant)) return
    this.attachRemote(track, publication, participant)
  }

  private readonly onTrackUnsubscribed = (
    _track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    this.detachRemote(remoteKey(participant.identity, publication.trackSid))
  }

  private readonly onTrackPublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    if (!isVoicePublication(publication, participant)) return
    try {
      if (!publication.isSubscribed) publication.setSubscribed(true)
    } catch {
      /* ignore */
    }
  }

  private readonly onTrackUnpublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    this.detachRemote(remoteKey(participant.identity, publication.trackSid))
  }

  private readonly onParticipantDisconnected = (participant: RemoteParticipant): void => {
    const prefix = `${participant.identity?.toLowerCase() ?? ''}:`
    for (const key of [...this.remotes.keys()]) {
      if (key.startsWith(prefix)) this.detachRemote(key)
    }
  }

  private readonly onRoomDisconnected = (): void => {
    this.clearAllRemotes()
    this.micLive = false
    this.speaking = false
    this.pttHeld = false
    this.notify()
  }

  private readonly onRoomReconnected = (): void => {
    if (this.hearing) void this.applyHearing(true)
    void this.reconcileMicPublish()
    this.notify()
  }

  private readonly onLocalTrackPublished = (pub: LocalTrackPublication): void => {
    if (pub.kind === Track.Kind.Audio && pub.source === Track.Source.Microphone) {
      this.micLive = true
      this.notify()
    }
  }

  private readonly onLocalTrackUnpublished = (pub: LocalTrackPublication): void => {
    if (pub.kind === Track.Kind.Audio && pub.source === Track.Source.Microphone) {
      this.micLive = false
      this.notify()
    }
  }

  private rescanRemoteVoice(): void {
    const room = this.room
    if (!room || !this.hearing) return
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (!isVoicePublication(publication, participant)) continue
        try {
          if (!publication.isSubscribed) publication.setSubscribed(true)
        } catch {
          /* ignore */
        }
        const track = publication.track
        if (track && track.kind === Track.Kind.Audio) {
          this.attachRemote(track as RemoteTrack, publication, participant)
        }
      }
    }
  }

  private ensureAudioHost(): HTMLDivElement {
    if (this.audioHost?.isConnected) return this.audioHost
    const host = document.createElement('div')
    host.id = 'nearby-voice-audio-host'
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
    if (track.kind !== Track.Kind.Audio) return
    const key = remoteKey(participant.identity, publication.trackSid)
    if (this.remotes.has(key)) return

    const el = track.attach() as HTMLAudioElement
    el.autoplay = true
    el.setAttribute('playsinline', 'true')
    el.muted = false
    el.volume = this.hearing ? remoteGain() : 0
    this.ensureAudioHost().appendChild(el)
    void el.play().catch((err) => {
      clientDebugLog.log('comms', `Remote voice play blocked: ${String(err)}`, {
        level: 'warn',
        alsoConsole: true
      })
    })
    this.remotes.set(key, {
      element: el,
      trackSid: publication.trackSid,
      participantId: participant.identity?.toLowerCase() ?? ''
    })
    this.remoteCount = this.remotes.size
    clientDebugLog.log(
      'comms',
      `Remote voice attached · peer=${(participant.identity ?? '').slice(0, 10)}… remotes=${this.remoteCount}`,
      { level: 'success', alsoConsole: true }
    )
    this.notify()
  }

  private detachRemote(key: string): void {
    const entry = this.remotes.get(key)
    if (!entry) return
    try {
      entry.element.pause()
      entry.element.srcObject = null
      entry.element.remove()
    } catch {
      /* ignore */
    }
    this.remotes.delete(key)
    this.remoteCount = this.remotes.size
    this.notify()
  }

  private clearAllRemotes(): void {
    for (const key of [...this.remotes.keys()]) this.detachRemote(key)
  }

  private applyRemoteVolumes(): void {
    const g = this.hearing ? remoteGain() : 0
    for (const entry of this.remotes.values()) {
      entry.element.volume = g
      entry.element.muted = !this.hearing || g <= 0
    }
  }

  private notify(): void {
    const snap = {
      hearing: this.hearing,
      speaking: this.speaking,
      backgroundMuted: this.backgroundMuted,
      pttHeld: this.pttHeld,
      micLive: this.micLive,
      remoteCount: this.remoteCount,
      roomReady: !!this.room && this.room.state === ConnectionState.Connected,
      error: this.error
    }
    for (const listener of this.listeners) listener(snap)
  }
}

function hasLocalMic(room: Room): boolean {
  for (const pub of room.localParticipant.audioTrackPublications.values()) {
    if (pub.source === Track.Source.Microphone && pub.track) return true
  }
  return false
}

function remoteGain(): number {
  return Math.min(
    1,
    Math.max(0, voiceChatVolumeMultiplier() * volumeToGain(soundSettings.get().masterVolume))
  )
}

function remoteKey(identity: string | undefined, trackSid: string): string {
  return `${(identity ?? '').toLowerCase()}:${trackSid}`
}

/** Peer voice — skip screen-share / cast video companions. */
export function isVoicePublication(
  publication: RemoteTrackPublication,
  participant: RemoteParticipant
): boolean {
  if (publication.kind !== Track.Kind.Audio) return false
  if (publication.source === Track.Source.ScreenShareAudio) return false
  if (publication.source === Track.Source.Microphone) return true
  // Unknown audio without camera/screenshare video = treat as voice (Explorer interop).
  for (const pub of participant.trackPublications.values()) {
    if (pub.kind !== Track.Kind.Video) continue
    if (pub.source === Track.Source.Camera || pub.source === Track.Source.ScreenShare) return false
  }
  return true
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}
