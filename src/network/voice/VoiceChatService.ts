import {
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
  type SoundSettingsState,
  type VoiceInputMode
} from '../../rendering/SoundSettings'

export type VoiceChatSnapshot = {
  /** Nearby voice channel on (listen + can transmit). */
  enabled: boolean
  /** Open-mic soft mute (ignored in pure PTT hold logic except as hard mute). */
  userMuted: boolean
  /** Forced off by tab background policy. */
  backgroundMuted: boolean
  /** Push-to-talk key currently held. */
  pttHeld: boolean
  /** Local mic is published live. */
  micLive: boolean
  /** Input mode from preferences. */
  mode: VoiceInputMode
  /** Remote voice tracks currently attached. */
  remoteCount: number
  /** Last error message for UI. */
  error: string | null
}

type Listener = (state: VoiceChatSnapshot) => void

type RemoteVoiceEntry = {
  element: HTMLAudioElement
  trackSid: string
  participantId: string
}

/**
 * Nearby voice chat over the primary LiveKit room.
 * Phase 1: publish/subscribe + PTT + mute-in-background + volume/device prefs.
 * Spatial attach comes later.
 */
export class VoiceChatService {
  private room: Room | null = null
  private enabled = false
  private userMuted = false
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

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (isTextInputFocused() || isEditableTarget(ev.target)) return
    if (!this.enabled) return
    // M — soft-mute in open-mic mode
    if (ev.code === 'KeyM' && !ev.repeat && soundSettings.get().voiceInputMode === 'open-mic') {
      ev.preventDefault()
      this.toggleUserMuted()
      return
    }
    if (ev.repeat || ev.code !== 'KeyV') return
    if (soundSettings.get().voiceInputMode !== 'push-to-talk') return
    ev.preventDefault()
    this.setPttHeld(true)
  }

  private readonly onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.code !== 'KeyV') return
    if (soundSettings.get().voiceInputMode !== 'push-to-talk') return
    this.setPttHeld(false)
  }

  private readonly onVisibility = (): void => {
    this.syncBackgroundMute()
  }

  constructor() {
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('blur', this.onVisibility)
    window.addEventListener('focus', this.onVisibility)
    this.unsubSound = soundSettings.subscribe((s) => this.onSoundSettings(s))
    this.syncBackgroundMute()
  }

  dispose(): void {
    void this.setEnabled(false)
    this.detachRoom()
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('blur', this.onVisibility)
    window.removeEventListener('focus', this.onVisibility)
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
      enabled: this.enabled,
      userMuted: this.userMuted,
      backgroundMuted: this.backgroundMuted,
      pttHeld: this.pttHeld,
      micLive: this.micLive,
      mode: soundSettings.get().voiceInputMode,
      remoteCount: this.remoteCount,
      error: this.error
    }
  }

  /** Bind / rebind the LiveKit room used for avatar movement (scene or world). */
  attachRoom(room: Room | null): void {
    if (this.room === room) return
    const wasEnabled = this.enabled
    if (wasEnabled) void this.setEnabled(false)
    this.detachRoom()
    this.room = room
    if (room) this.bindRoomHandlers(room)
    if (wasEnabled && room) void this.setEnabled(true)
    this.notify()
  }

  /** Sidebar / HUD: toggle nearby voice on or off. */
  async toggleEnabled(): Promise<void> {
    await this.setEnabled(!this.enabled)
  }

  async setEnabled(on: boolean): Promise<void> {
    if (on === this.enabled) return
    if (on && !this.room) {
      this.error = 'Not connected to a LiveKit room'
      this.notify()
      clientDebugLog.log('comms', 'Voice enable skipped — no room', { level: 'warn' })
      return
    }
    this.enabled = on
    this.error = null
    if (!on) {
      this.pttHeld = false
      this.userMuted = false
      await this.ensureMicPublished(false)
      this.clearAllRemotes()
      this.notify()
      return
    }

    try {
      await this.room!.startAudio()
    } catch {
      /* autoplay policies — still try tracks */
    }
    this.rescanRemoteVoice()
    await this.reconcileMicPublish()
    this.notify()
    clientDebugLog.log('comms', 'Nearby voice enabled', { level: 'success' })
  }

  /** Open-mic soft mute (M key or UI). */
  setUserMuted(muted: boolean): void {
    if (this.userMuted === muted) return
    this.userMuted = muted
    void this.reconcileMicPublish()
    this.notify()
  }

  toggleUserMuted(): void {
    this.setUserMuted(!this.userMuted)
  }

  private setPttHeld(held: boolean): void {
    if (this.pttHeld === held) return
    this.pttHeld = held
    void this.reconcileMicPublish()
    this.notify()
  }

  private shouldPublishMic(): boolean {
    if (!this.enabled || !this.room || this.backgroundMuted) return false
    const mode = soundSettings.get().voiceInputMode
    if (mode === 'push-to-talk') return this.pttHeld
    return !this.userMuted
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
          const pub = await room.localParticipant.setMicrophoneEnabled(
            true,
            deviceId ? { deviceId } : undefined
          )
          this.micLive = !!pub?.track
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

  private onSoundSettings(state: SoundSettingsState): void {
    this.applyRemoteVolumes()
    this.syncBackgroundMute()
    // Device / mode change while live
    if (this.enabled) void this.reconcileMicPublish()
    // If mode flipped to open-mic, clear PTT hold sticky
    if (state.voiceInputMode === 'open-mic' && this.pttHeld) {
      this.pttHeld = false
    }
    this.notify()
  }

  private syncBackgroundMute(): void {
    const policy = soundSettings.get().muteMicInBackground
    const hidden = document.visibilityState === 'hidden' || !document.hasFocus()
    // Only treat visibility hidden as "background" for mute-in-background — blur alone is noisy with pointer lock.
    const shouldMute = policy && document.visibilityState === 'hidden'
    void hidden
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
    if (!this.enabled) return
    if (!isVoicePublication(publication, participant)) return
    this.attachRemote(track, publication, participant)
  }

  private readonly onTrackUnsubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    this.detachRemote(remoteKey(participant.identity, publication.trackSid))
    void track
  }

  private readonly onTrackPublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    if (!isVoicePublication(publication, participant)) return
    try {
      publication.setSubscribed(true)
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
    this.enabled = false
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
    if (!room) return
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (!isVoicePublication(publication, participant)) continue
        try {
          publication.setSubscribed(true)
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
    el.volume = remoteGain()
    void el.play().catch(() => {
      /* startAudio should have unlocked */
    })
    this.remotes.set(key, {
      element: el,
      trackSid: publication.trackSid,
      participantId: participant.identity?.toLowerCase() ?? ''
    })
    this.remoteCount = this.remotes.size
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
    const g = remoteGain()
    for (const entry of this.remotes.values()) {
      entry.element.volume = g
    }
  }

  private notify(): void {
    const snap = this.getSnapshot()
    for (const listener of this.listeners) listener(snap)
  }
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

/** Peer microphone (or audio without cast video) — skip screen-share / cast. */
export function isVoicePublication(
  publication: RemoteTrackPublication,
  participant: RemoteParticipant
): boolean {
  if (publication.kind !== Track.Kind.Audio) return false
  if (publication.source === Track.Source.ScreenShareAudio) return false
  if (publication.source === Track.Source.Microphone) return true
  // Unknown / other audio: skip if participant also has camera/screenshare video (Cast/OBS).
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
