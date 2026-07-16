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
  /** Hear others (subscribe + play remote mics). */
  hearing: boolean
  /** Speak button — continuous hot mic. */
  speaking: boolean
  /** Forced off by tab background policy. */
  backgroundMuted: boolean
  /** Hold T — momentary transmit. */
  pttHeld: boolean
  /** Local mic is published live. */
  micLive: boolean
  /** Remote voice tracks currently attached. */
  remoteCount: number
  /** Connected to a LiveKit room. */
  roomReady: boolean
  error: string | null
}

type Listener = (state: VoiceChatSnapshot) => void

type RemoteVoiceEntry = {
  element: HTMLAudioElement
  trackSid: string
  participantId: string
}

/**
 * Nearby voice over primary LiveKit room — Explorer-shaped:
 * Hear others · Speak · Hold [T] to speak momentarily.
 */
export class VoiceChatService {
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
    if (!this.room) return
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
    this.detachRoom()
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

  /** Bind / rebind the LiveKit room used for avatar movement (scene or world). */
  attachRoom(room: Room | null): void {
    if (this.room === room) return
    const keepHearing = this.hearing
    const keepSpeaking = this.speaking
    void this.setSpeaking(false)
    this.pttHeld = false
    this.detachRoom()
    this.room = room
    if (room) {
      this.bindRoomHandlers(room)
      this.hearing = keepHearing
      if (this.hearing) void this.applyHearing(true)
      if (keepSpeaking) void this.setSpeaking(true)
    }
    this.notify()
  }

  async setHearing(on: boolean): Promise<void> {
    if (this.hearing === on) return
    this.hearing = on
    await this.applyHearing(on)
    this.notify()
  }

  async toggleHearing(): Promise<void> {
    await this.setHearing(!this.hearing)
  }

  /** Speak button — continuous hot mic. */
  async setSpeaking(on: boolean): Promise<void> {
    if (this.speaking === on) return
    if (on && !this.room) {
      this.error = 'Not connected to voice room'
      this.notify()
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
      level: on ? 'success' : 'info'
    })
  }

  async toggleSpeaking(): Promise<void> {
    await this.setSpeaking(!this.speaking)
  }

  private setPttHeld(held: boolean): void {
    if (this.pttHeld === held) return
    this.pttHeld = held
    if (held && this.room) {
      void this.room.startAudio().catch(() => {})
    }
    void this.reconcileMicPublish()
    this.notify()
  }

  private shouldPublishMic(): boolean {
    if (!this.room || this.backgroundMuted) return false
    return this.speaking || this.pttHeld
  }

  private async applyHearing(on: boolean): Promise<void> {
    if (!this.room) {
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
    const room = this.room
    if (!room) {
      this.micLive = false
      return
    }
    if (this.publishInFlight) await this.publishInFlight
    const run = (async () => {
      try {
        if (want) {
          const deviceId = soundSettings.get().microphoneDeviceId
          const opts = deviceId ? { deviceId } : undefined
          const pub = await room.localParticipant.setMicrophoneEnabled(true, opts)
          this.micLive = !!pub?.track || hasLocalMic(room)
          this.error = null
        } else {
          await room.localParticipant.setMicrophoneEnabled(false)
          this.micLive = false
        }
      } catch (err) {
        this.micLive = false
        this.error = err instanceof Error ? err.message : String(err)
        clientDebugLog.log('comms', `Mic publish failed: ${this.error}`, { level: 'error' })
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
    room.on(RoomEvent.LocalTrackPublished, this.onLocalTrackPublished)
    room.on(RoomEvent.LocalTrackUnpublished, this.onLocalTrackUnpublished)
  }

  private detachRoom(): void {
    const room = this.room
    if (room && this.roomHandlersBound) {
      room.off(RoomEvent.TrackSubscribed, this.onTrackSubscribed)
      room.off(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed)
      room.off(RoomEvent.TrackPublished, this.onTrackPublished)
      room.off(RoomEvent.TrackUnpublished, this.onTrackUnpublished)
      room.off(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected)
      room.off(RoomEvent.Disconnected, this.onRoomDisconnected)
      room.off(RoomEvent.LocalTrackPublished, this.onLocalTrackPublished)
      room.off(RoomEvent.LocalTrackUnpublished, this.onLocalTrackUnpublished)
    }
    this.roomHandlersBound = false
    this.clearAllRemotes()
    this.room = null
    this.micLive = false
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
    if (this.audioHost) return this.audioHost
    const host = document.createElement('div')
    host.id = 'nearby-voice-audio-host'
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText =
      'position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;left:0;top:0'
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
      clientDebugLog.log('comms', `Remote voice play blocked: ${String(err)}`, { level: 'warn' })
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
      { throttleMs: 2000, throttleKey: 'voice-attach' }
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
    const snap = this.getSnapshot()
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
  // Unknown audio: skip if same participant publishes camera/screenshare (Cast/OBS).
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
