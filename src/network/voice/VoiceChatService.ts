import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type LocalTrackPublication
} from 'livekit-client'
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
/** wallet address (lowercase) → LiveKit audioLevel 0–1 while speaking */
type SpeakingListener = (levels: ReadonlyMap<string, number>) => void
type RoomProvider = () => Room | null

type RemoteVoiceEntry = {
  element: HTMLAudioElement
  trackSid: string
  participantId: string
}

/**
 * Nearby voice on the **primary** LiveKit room only (scene parcels / world rooms).
 * Not island/archipelago — Explorer nearby voice uses the same scene-room path as chat.
 */
export class VoiceChatService {
  private roomProvider: RoomProvider = () => null
  private room: Room | null = null
  private handlersBound = false
  private hearing = true
  private speaking = false
  private backgroundMuted = false
  private pttHeld = false
  private micLive = false
  private error: string | null = null
  private remoteCount = 0
  private readonly remotes = new Map<string, RemoteVoiceEntry>()
  private readonly listeners = new Set<Listener>()
  private readonly speakingListeners = new Set<SpeakingListener>()
  /** Active speaker levels by participant identity (wallet). */
  private speakingLevels = new Map<string, number>()
  private unsubSound: (() => void) | null = null
  private publishInFlight: Promise<void> | null = null
  private audioHost: HTMLDivElement | null = null

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.repeat || ev.code !== 'KeyT') return
    if (isTextInputFocused() || isEditableTarget(ev.target)) {
      voiceLog('T ignored — text field focused')
      return
    }
    this.refreshRoom()
    if (!this.isRoomLive()) {
      voiceLog(`T blocked — no room (state=${this.room?.state ?? 'null'})`, 'warn')
      return
    }
    // If hot-mic Speak is already on, T does nothing extra (stay published).
    if (this.speaking) return
    ev.preventDefault()
    this.setPttHeld(true)
  }

  private readonly onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.code !== 'KeyT') return
    if (this.speaking) return
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
    this.roomProvider = () => null
    this.audioHost?.remove()
    this.audioHost = null
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.unsubSound?.()
    this.unsubSound = null
    this.listeners.clear()
    this.speakingListeners.clear()
    this.speakingLevels.clear()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Name-tag voice bars — map of peer wallet → audio level. */
  subscribeSpeaking(listener: SpeakingListener): () => void {
    this.speakingListeners.add(listener)
    listener(this.speakingLevels)
    return () => {
      this.speakingListeners.delete(listener)
    }
  }

  getSnapshot(): VoiceChatSnapshot {
    this.refreshRoom()
    return {
      hearing: this.hearing,
      speaking: this.speaking,
      backgroundMuted: this.backgroundMuted,
      pttHeld: this.pttHeld,
      micLive: this.micLive,
      remoteCount: this.remoteCount,
      roomReady: this.isRoomLive(),
      error: this.error
    }
  }

  bindRoomProvider(provider: RoomProvider): void {
    this.roomProvider = provider
    this.refreshRoom()
  }

  /** Multi-room provider adapter — voice uses the first live room only. */
  bindRoomsProvider(provider: () => Room[]): void {
    this.bindRoomProvider(() => {
      const rooms = provider()
      return rooms.find((r) => r.state === ConnectionState.Connected) ?? null
    })
  }

  attachRoom(room: Room | null): void {
    this.bindRoomProvider(() => room)
  }

  refreshRoomBinding(): void {
    this.refreshRoom()
  }

  refreshRooms(): void {
    this.refreshRoom()
  }

  refreshRoom(): void {
    const next = this.roomProvider()
    const nextLive =
      next && next.state === ConnectionState.Connected ? next : null

    if (nextLive === this.room) return

    const keepHearing = this.hearing
    const keepSpeaking = this.speaking

    this.detachRoom()
    this.room = nextLive
    this.micLive = false

    if (nextLive) {
      this.bindHandlers(nextLive)
      voiceLog(
        `bound scene/world room=${nextLive.name || '?'} remotes=${nextLive.remoteParticipants.size}`
      )
      this.hearing = keepHearing
      if (this.hearing) void this.applyHearing(true)
      this.speaking = keepSpeaking
      if (this.shouldPublishMic()) void this.reconcileMicPublish()
    } else {
      voiceLog('no primary LiveKit room', 'warn')
    }
    this.notify()
  }

  async setHearing(on: boolean): Promise<void> {
    this.refreshRoom()
    if (this.hearing === on) return
    this.hearing = on
    await this.applyHearing(on)
    this.notify()
  }

  async toggleHearing(): Promise<void> {
    await this.setHearing(!this.hearing)
  }

  /** Continuous hot mic — stays on until clicked again. Prefer this over hold-T. */
  async setSpeaking(on: boolean): Promise<void> {
    this.refreshRoom()
    if (this.speaking === on) {
      voiceLog(`Speak already ${on ? 'on' : 'off'}`)
      return
    }
    if (on && !this.isRoomLive()) {
      this.error = 'Not connected to voice room'
      this.notify()
      voiceLog('Speak blocked — LiveKit not connected', 'warn')
      return
    }
    this.speaking = on
    this.pttHeld = false
    this.error = null
    if (on) {
      try {
        await this.room!.startAudio()
      } catch (err) {
        voiceLog(`startAudio failed: ${String(err)}`, 'warn')
      }
    }
    await this.reconcileMicPublish()
    this.notify()
    voiceLog(on ? 'Speak ON (hot mic)' : 'Speak OFF')
  }

  async toggleSpeaking(): Promise<void> {
    await this.setSpeaking(!this.speaking)
  }

  private setPttHeld(held: boolean): void {
    if (this.speaking) return
    if (this.pttHeld === held) return
    this.pttHeld = held
    this.refreshRoom()
    if (held && this.room) void this.room.startAudio().catch(() => {})
    void this.reconcileMicPublish()
    this.notify()
    voiceLog(held ? 'PTT down (hold T)' : 'PTT up')
  }

  private isRoomLive(): boolean {
    return !!this.room && this.room.state === ConnectionState.Connected
  }

  private shouldPublishMic(): boolean {
    if (!this.isRoomLive() || this.backgroundMuted) return false
    return this.speaking || this.pttHeld
  }

  private async applyHearing(on: boolean): Promise<void> {
    this.refreshRoom()
    if (!this.isRoomLive()) {
      if (!on) this.clearAllRemotes()
      return
    }
    if (on) {
      try {
        await this.room!.startAudio()
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
    this.refreshRoom()
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
        const perms = room.localParticipant.permissions
        voiceLog(
          `mic want=${want} canPublish=${String(perms?.canPublish)} room=${shortName(room.name)} id=${(room.localParticipant.identity ?? '').slice(0, 12)}`
        )
        if (want && perms?.canPublish === false) {
          this.micLive = false
          this.error = 'LiveKit token cannot publish audio (canPublish=false)'
          voiceLog(this.error, 'error')
          this.notify()
          return
        }
        if (want) {
          const deviceId = soundSettings.get().microphoneDeviceId
          const opts = deviceId ? { deviceId } : undefined
          const pub = await room.localParticipant.setMicrophoneEnabled(true, opts, {
            source: Track.Source.Microphone,
            name: 'microphone',
            dtx: true,
            red: true
          })
          this.micLive = !!pub?.track || hasLocalMic(room)
          this.error = null
          voiceLog(
            `Mic published · live=${this.micLive} muted=${pub?.isMuted} sid=${pub?.trackSid?.slice(0, 10) ?? 'n/a'}`
          )
          this.bumpLocalSpeakingHint()
        } else {
          await room.localParticipant.setMicrophoneEnabled(false)
          this.micLive = false
          voiceLog('Mic unpublished')
          this.bumpLocalSpeakingHint()
        }
      } catch (err) {
        this.micLive = false
        this.error = err instanceof Error ? err.message : String(err)
        voiceLog(`Mic publish failed: ${this.error}`, 'error')
        this.bumpLocalSpeakingHint()
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

  private bindHandlers(room: Room): void {
    if (this.handlersBound) return
    this.handlersBound = true
    room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed)
    room.on(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed)
    room.on(RoomEvent.TrackPublished, this.onTrackPublished)
    room.on(RoomEvent.TrackUnpublished, this.onTrackUnpublished)
    room.on(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected)
    room.on(RoomEvent.Disconnected, this.onRoomDisconnected)
    room.on(RoomEvent.Reconnected, this.onRoomReconnected)
    room.on(RoomEvent.LocalTrackPublished, this.onLocalTrackPublished)
    room.on(RoomEvent.LocalTrackUnpublished, this.onLocalTrackUnpublished)
    room.on(RoomEvent.ActiveSpeakersChanged, this.onActiveSpeakersChanged)
  }

  private detachRoom(): void {
    const room = this.room
    if (room && this.handlersBound) {
      room.off(RoomEvent.TrackSubscribed, this.onTrackSubscribed)
      room.off(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed)
      room.off(RoomEvent.TrackPublished, this.onTrackPublished)
      room.off(RoomEvent.TrackUnpublished, this.onTrackUnpublished)
      room.off(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected)
      room.off(RoomEvent.Disconnected, this.onRoomDisconnected)
      room.off(RoomEvent.Reconnected, this.onRoomReconnected)
      room.off(RoomEvent.LocalTrackPublished, this.onLocalTrackPublished)
      room.off(RoomEvent.LocalTrackUnpublished, this.onLocalTrackUnpublished)
      room.off(RoomEvent.ActiveSpeakersChanged, this.onActiveSpeakersChanged)
    }
    this.handlersBound = false
    this.clearAllRemotes()
    this.room = null
    this.micLive = false
    this.setSpeakingLevels(new Map())
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
    const id = participant.identity?.toLowerCase() ?? ''
    for (const [key, entry] of [...this.remotes.entries()]) {
      if (entry.participantId === id) this.detachRemote(key)
    }
  }

  private readonly onRoomDisconnected = (): void => {
    this.clearAllRemotes()
    this.micLive = false
    this.speaking = false
    this.pttHeld = false
    this.room = null
    this.handlersBound = false
    this.setSpeakingLevels(new Map())
    this.notify()
  }

  private readonly onActiveSpeakersChanged = (speakers: Participant[]): void => {
    const next = new Map<string, number>()
    for (const p of speakers) {
      const id = p.identity?.trim().toLowerCase()
      if (!id) continue
      // audioLevel is 0–1 when LiveKit marks them active
      const level = typeof p.audioLevel === 'number' ? p.audioLevel : p.isSpeaking ? 0.6 : 0
      if (level > 0.02 || p.isSpeaking) next.set(id, Math.max(level, 0.25))
    }
    // Local PTT/Speak without server active-speaker yet — still show bars.
    if (this.micLive && this.room) {
      const localId = this.room.localParticipant.identity?.trim().toLowerCase()
      if (localId && !next.has(localId)) next.set(localId, 0.55)
    }
    this.setSpeakingLevels(next)
  }

  private setSpeakingLevels(next: Map<string, number>): void {
    this.speakingLevels = next
    for (const listener of this.speakingListeners) listener(this.speakingLevels)
  }

  /** Show local name-tag bars as soon as mic is live (before ActiveSpeakers fires). */
  private bumpLocalSpeakingHint(): void {
    if (!this.room) return
    const localId = this.room.localParticipant.identity?.trim().toLowerCase()
    if (!localId) return
    const next = new Map(this.speakingLevels)
    if (this.micLive) next.set(localId, Math.max(next.get(localId) ?? 0, 0.55))
    else next.delete(localId)
    this.setSpeakingLevels(next)
  }

  private readonly onRoomReconnected = (): void => {
    this.refreshRoom()
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
      this.micLive = this.room ? hasLocalMic(this.room) : false
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
      voiceLog(`Remote voice play blocked: ${String(err)}`, 'warn')
    })
    this.remotes.set(key, {
      element: el,
      trackSid: publication.trackSid,
      participantId: participant.identity?.toLowerCase() ?? ''
    })
    this.remoteCount = this.remotes.size
    voiceLog(
      `Remote voice · peer=${(participant.identity ?? '').slice(0, 10)} total=${this.remoteCount}`
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
    const snap: VoiceChatSnapshot = {
      hearing: this.hearing,
      speaking: this.speaking,
      backgroundMuted: this.backgroundMuted,
      pttHeld: this.pttHeld,
      micLive: this.micLive,
      remoteCount: this.remoteCount,
      roomReady: this.isRoomLive(),
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

function shortName(name: string | undefined): string {
  if (!name) return '?'
  return name.length > 40 ? `${name.slice(0, 40)}…` : name
}

export function isVoicePublication(
  publication: RemoteTrackPublication,
  participant: RemoteParticipant
): boolean {
  if (publication.kind !== Track.Kind.Audio) return false
  if (publication.source === Track.Source.ScreenShareAudio) return false
  if (publication.source === Track.Source.Microphone) return true
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

function voiceLog(message: string, level: 'log' | 'warn' | 'error' = 'log'): void {
  const prefix = '[voice]'
  if (level === 'warn') console.warn(prefix, message)
  else if (level === 'error') console.error(prefix, message)
  else console.log(prefix, message)
}
