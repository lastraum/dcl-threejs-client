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
  /** Diagnostic: how many LiveKit rooms we publish/subscribe on. */
  roomCount: number
}

type Listener = (state: VoiceChatSnapshot) => void
/** All currently connected LiveKit rooms (scene + island + world). */
type RoomsProvider = () => Room[]

type RemoteVoiceEntry = {
  element: HTMLAudioElement
  trackSid: string
  participantId: string
  roomName: string
}

type BoundRoom = {
  room: Room
  handlersBound: boolean
}

/**
 * Nearby voice — publish/subscribe on **every** connected LiveKit room.
 *
 * Genesis uses both scene-room (chat/cast) and island-room (archipelago peers).
 * Explorer voice often rides the island room; we must mic-publish there too.
 */
export class VoiceChatService {
  private roomsProvider: RoomsProvider = () => []
  private bound = new Map<string, BoundRoom>()
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
  private publishInFlight: Promise<void> | null = null
  private audioHost: HTMLDivElement | null = null

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.repeat || ev.code !== 'KeyT') return
    if (isTextInputFocused() || isEditableTarget(ev.target)) {
      voiceLog('T ignored — text field focused')
      return
    }
    this.refreshRooms()
    if (this.liveRooms().length === 0) {
      voiceLog('T blocked — no connected LiveKit rooms', 'warn')
      return
    }
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
    this.unbindAllRooms()
    this.roomsProvider = () => []
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
    this.refreshRooms()
    const rooms = this.liveRooms()
    return {
      hearing: this.hearing,
      speaking: this.speaking,
      backgroundMuted: this.backgroundMuted,
      pttHeld: this.pttHeld,
      micLive: this.micLive,
      remoteCount: this.remoteCount,
      roomReady: rooms.length > 0,
      roomCount: rooms.length,
      error: this.error
    }
  }

  /** Provide all connected LiveKit rooms (scene + island + world). */
  bindRoomsProvider(provider: RoomsProvider): void {
    this.roomsProvider = provider
    this.refreshRooms()
  }

  /** @deprecated */
  bindRoomProvider(provider: () => Room | null): void {
    this.bindRoomsProvider(() => {
      const r = provider()
      return r && r.state === ConnectionState.Connected ? [r] : []
    })
  }

  /** @deprecated */
  attachRoom(room: Room | null): void {
    this.bindRoomProvider(() => room)
  }

  refreshRoomBinding(): void {
    this.refreshRooms()
  }

  refreshRooms(): void {
    const nextRooms = this.roomsProvider().filter((r) => r.state === ConnectionState.Connected)
    const nextKeys = new Set(nextRooms.map(roomKey))

    // Drop bindings for rooms that disappeared.
    for (const [key, bound] of [...this.bound.entries()]) {
      if (nextKeys.has(key)) continue
      this.unbindRoom(bound)
      this.bound.delete(key)
    }

    // Bind new rooms.
    for (const room of nextRooms) {
      const key = roomKey(room)
      if (this.bound.has(key)) continue
      this.bound.set(key, { room, handlersBound: false })
      this.bindRoomHandlers(room)
      voiceLog(`bound room=${room.name || key} remotes=${room.remoteParticipants.size}`)
      if (this.hearing) {
        void this.applyHearingOnRoom(room, true)
      }
    }

    if (nextRooms.length === 0) {
      this.clearAllRemotes()
      this.micLive = false
    } else if (this.shouldPublishMic()) {
      void this.reconcileMicPublish()
    }
    this.notify()
  }

  async setHearing(on: boolean): Promise<void> {
    this.refreshRooms()
    if (this.hearing === on) return
    this.hearing = on
    for (const { room } of this.bound.values()) {
      await this.applyHearingOnRoom(room, on)
    }
    if (!on) this.clearAllRemotes()
    this.notify()
  }

  async toggleHearing(): Promise<void> {
    await this.setHearing(!this.hearing)
  }

  async setSpeaking(on: boolean): Promise<void> {
    this.refreshRooms()
    if (this.speaking === on) {
      voiceLog(`Speak already ${on ? 'on' : 'off'}`)
      return
    }
    if (on && this.liveRooms().length === 0) {
      this.error = 'Not connected to voice room'
      this.notify()
      voiceLog('Speak blocked — no connected LiveKit rooms', 'warn')
      return
    }
    this.speaking = on
    this.error = null
    if (on) {
      for (const room of this.liveRooms()) {
        try {
          await room.startAudio()
        } catch (err) {
          voiceLog(`startAudio failed (${room.name}): ${String(err)}`, 'warn')
        }
      }
    }
    await this.reconcileMicPublish()
    this.notify()
    voiceLog(on ? `Speak ON · rooms=${this.liveRooms().length}` : 'Speak OFF')
  }

  async toggleSpeaking(): Promise<void> {
    await this.setSpeaking(!this.speaking)
  }

  private setPttHeld(held: boolean): void {
    if (this.pttHeld === held) return
    this.pttHeld = held
    this.refreshRooms()
    if (held) {
      for (const room of this.liveRooms()) {
        void room.startAudio().catch(() => {})
      }
    }
    void this.reconcileMicPublish()
    this.notify()
  }

  private shouldPublishMic(): boolean {
    if (this.backgroundMuted || this.liveRooms().length === 0) return false
    return this.speaking || this.pttHeld
  }

  private liveRooms(): Room[] {
    return [...this.bound.values()]
      .map((b) => b.room)
      .filter((r) => r.state === ConnectionState.Connected)
  }

  private async applyHearingOnRoom(room: Room, on: boolean): Promise<void> {
    if (room.state !== ConnectionState.Connected) return
    if (on) {
      try {
        await room.startAudio()
      } catch {
        /* autoplay */
      }
      this.rescanRemoteVoice(room)
      this.applyRemoteVolumes()
    }
  }

  private async reconcileMicPublish(): Promise<void> {
    await this.ensureMicPublished(this.shouldPublishMic())
  }

  private async ensureMicPublished(want: boolean): Promise<void> {
    this.refreshRooms()
    const rooms = this.liveRooms()
    if (rooms.length === 0) {
      this.micLive = false
      if (want) {
        this.error = 'Not connected to voice room'
        this.notify()
      }
      return
    }
    if (this.publishInFlight) await this.publishInFlight
    const run = (async () => {
      let anyLive = false
      let lastError: string | null = null
      for (const room of rooms) {
        try {
          const perms = room.localParticipant.permissions
          const canPublish = perms?.canPublish
          voiceLog(
            `mic want=${want} room=${shortName(room.name)} canPublish=${String(canPublish)} id=${(room.localParticipant.identity ?? '').slice(0, 12)}`
          )
          if (want && canPublish === false) {
            lastError = `canPublish=false on ${shortName(room.name)}`
            voiceLog(lastError, 'error')
            continue
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
            const live = !!pub?.track || hasLocalMic(room)
            if (live) anyLive = true
            voiceLog(
              `Mic published · ${shortName(room.name)} live=${live} sid=${pub?.trackSid?.slice(0, 10) ?? 'n/a'}`
            )
          } else {
            await room.localParticipant.setMicrophoneEnabled(false)
            voiceLog(`Mic unpublished · ${shortName(room.name)}`)
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          voiceLog(`Mic error on ${shortName(room.name)}: ${lastError}`, 'error')
        }
      }
      this.micLive = want ? anyLive : false
      this.error = want && !anyLive ? lastError : null
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
    const key = roomKey(room)
    const bound = this.bound.get(key)
    if (!bound || bound.handlersBound) return
    bound.handlersBound = true
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

  private unbindRoom(bound: BoundRoom): void {
    const room = bound.room
    if (bound.handlersBound) {
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
    // Drop remotes that came from this room.
    const prefix = `${roomKey(room)}|`
    for (const k of [...this.remotes.keys()]) {
      if (k.startsWith(prefix)) this.detachRemote(k)
    }
  }

  private unbindAllRooms(): void {
    for (const bound of this.bound.values()) this.unbindRoom(bound)
    this.bound.clear()
    this.clearAllRemotes()
    this.micLive = false
  }

  private readonly onTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    if (!this.hearing) return
    if (!isVoicePublication(publication, participant)) return
    const room = this.findRoomForParticipant(participant)
    this.attachRemote(track, publication, participant, room?.name ?? '?')
  }

  private readonly onTrackUnsubscribed = (
    _track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    const room = this.findRoomForParticipant(participant)
    this.detachRemote(remoteKey(room?.name ?? '?', participant.identity, publication.trackSid))
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
    const room = this.findRoomForParticipant(participant)
    this.detachRemote(remoteKey(room?.name ?? '?', participant.identity, publication.trackSid))
  }

  private readonly onParticipantDisconnected = (participant: RemoteParticipant): void => {
    const id = participant.identity?.toLowerCase() ?? ''
    for (const [key, entry] of [...this.remotes.entries()]) {
      if (entry.participantId === id) this.detachRemote(key)
    }
  }

  private readonly onRoomDisconnected = (): void => {
    // Full re-scan of provider — drop dead rooms.
    this.refreshRooms()
    this.notify()
  }

  private readonly onRoomReconnected = (): void => {
    this.refreshRooms()
    if (this.hearing) {
      for (const room of this.liveRooms()) void this.applyHearingOnRoom(room, true)
    }
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
      // Still live if another room still has mic.
      this.micLive = this.liveRooms().some(hasLocalMic)
      this.notify()
    }
  }

  private findRoomForParticipant(participant: RemoteParticipant): Room | null {
    for (const room of this.liveRooms()) {
      if (room.remoteParticipants.get(participant.sid) || room.remoteParticipants.has(participant.identity)) {
        return room
      }
      for (const p of room.remoteParticipants.values()) {
        if (p === participant || p.identity === participant.identity) return room
      }
    }
    return this.liveRooms()[0] ?? null
  }

  private rescanRemoteVoice(room: Room): void {
    if (!this.hearing) return
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
          this.attachRemote(track as RemoteTrack, publication, participant, room.name)
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
    participant: RemoteParticipant,
    roomName: string
  ): void {
    if (track.kind !== Track.Kind.Audio) return
    const key = remoteKey(roomName, participant.identity, publication.trackSid)
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
      participantId: participant.identity?.toLowerCase() ?? '',
      roomName
    })
    this.remoteCount = this.remotes.size
    voiceLog(
      `Remote voice · peer=${(participant.identity ?? '').slice(0, 10)} room=${shortName(roomName)} total=${this.remoteCount}`
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
    const rooms = this.liveRooms()
    const snap: VoiceChatSnapshot = {
      hearing: this.hearing,
      speaking: this.speaking,
      backgroundMuted: this.backgroundMuted,
      pttHeld: this.pttHeld,
      micLive: this.micLive,
      remoteCount: this.remoteCount,
      roomReady: rooms.length > 0,
      roomCount: rooms.length,
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

function roomKey(room: Room): string {
  return room.name || `room-${room.localParticipant.identity || room.localParticipant.sid}`
}

function remoteKey(roomName: string, identity: string | undefined, trackSid: string): string {
  return `${roomName}|${(identity ?? '').toLowerCase()}:${trackSid}`
}

function shortName(name: string | undefined): string {
  if (!name) return '?'
  return name.length > 36 ? `${name.slice(0, 36)}…` : name
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
