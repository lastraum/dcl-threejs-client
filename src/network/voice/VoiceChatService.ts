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
  roomCount: number
}

type Listener = (state: VoiceChatSnapshot) => void
type SpeakingListener = (levels: ReadonlyMap<string, number>) => void
type RoomsProvider = () => Room[]

type RemoteVoiceEntry = {
  element: HTMLAudioElement
  trackSid: string
  participantId: string
  roomKey: string
}

type BoundRoom = {
  room: Room
  handlersBound: boolean
}

/**
 * Nearby voice.
 *
 * Room set comes from CommsService.getVoiceLiveKitRooms():
 * - Worlds → world room only
 * - Parcels → scene + island (when both connected) so Explorer mics are heard
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
  private readonly speakingListeners = new Set<SpeakingListener>()
  private speakingLevels = new Map<string, number>()
  private unsubSound: (() => void) | null = null
  private publishInFlight: Promise<void> | null = null
  private audioHost: HTMLDivElement | null = null
  private rescanTimer: ReturnType<typeof setInterval> | null = null

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.repeat || ev.code !== 'KeyT') return
    if (isTextInputFocused() || isEditableTarget(ev.target)) {
      voiceLog('T ignored — text field focused')
      return
    }
    this.refreshRooms()
    if (this.liveRooms().length === 0) {
      voiceLog('T blocked — no voice LiveKit rooms', 'warn')
      return
    }
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
    // Parcel peers often publish mic after we first scan — keep listening.
    this.rescanTimer = setInterval(() => {
      if (!this.hearing || this.liveRooms().length === 0) return
      this.refreshRooms()
      this.rescanAllRemoteVoice()
    }, 4000)
  }

  dispose(): void {
    if (this.rescanTimer != null) {
      clearInterval(this.rescanTimer)
      this.rescanTimer = null
    }
    void this.setSpeaking(false)
    this.pttHeld = false
    this.unbindAll()
    this.roomsProvider = () => []
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

  subscribeSpeaking(listener: SpeakingListener): () => void {
    this.speakingListeners.add(listener)
    listener(this.speakingLevels)
    return () => {
      this.speakingListeners.delete(listener)
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

  bindRoomsProvider(provider: RoomsProvider): void {
    this.roomsProvider = provider
    this.refreshRooms()
  }

  bindRoomProvider(provider: () => Room | null): void {
    this.bindRoomsProvider(() => {
      const r = provider()
      return r && r.state === ConnectionState.Connected ? [r] : []
    })
  }

  attachRoom(room: Room | null): void {
    this.bindRoomProvider(() => room)
  }

  refreshRoomBinding(): void {
    this.refreshRooms()
  }

  refreshRoom(): void {
    this.refreshRooms()
  }

  refreshRooms(): void {
    const nextRooms = this.roomsProvider().filter((r) => r.state === ConnectionState.Connected)
    const nextKeys = new Set(nextRooms.map(roomKey))

    for (const [key, bound] of [...this.bound.entries()]) {
      if (nextKeys.has(key)) continue
      this.unbindRoom(bound)
      this.bound.delete(key)
    }

    for (const room of nextRooms) {
      const key = roomKey(room)
      if (this.bound.has(key)) continue
      this.bound.set(key, { room, handlersBound: false })
      this.bindHandlers(room)
      voiceLog(`bound ${shortName(room.name)} remotes=${room.remoteParticipants.size}`)
      if (this.hearing) void this.applyHearingOnRoom(room)
    }

    if (nextRooms.length === 0) {
      this.clearAllRemotes()
      this.micLive = false
      this.setSpeakingLevels(new Map())
    } else if (this.shouldPublishMic()) {
      void this.reconcileMicPublish()
    }
    this.notify()
  }

  async setHearing(on: boolean): Promise<void> {
    this.refreshRooms()
    if (this.hearing === on) return
    this.hearing = on
    if (on) {
      for (const room of this.liveRooms()) await this.applyHearingOnRoom(room)
    } else {
      this.clearAllRemotes()
    }
    this.notify()
  }

  async toggleHearing(): Promise<void> {
    await this.setHearing(!this.hearing)
  }

  async ensureHearingUnlocked(): Promise<void> {
    this.refreshRooms()
    this.hearing = true
    if (this.liveRooms().length === 0) {
      voiceLog('ensureHearingUnlocked — no rooms', 'warn')
      return
    }
    for (const room of this.liveRooms()) {
      try {
        await room.startAudio()
      } catch (err) {
        voiceLog(`startAudio failed (${shortName(room.name)}): ${String(err)}`, 'warn')
      }
      this.dumpRemoteAudioInventory(room, 'panel-open')
      this.rescanRoom(room)
    }
    this.applyRemoteVolumes()
    this.notify()
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
      voiceLog('Speak blocked — no LiveKit rooms', 'warn')
      return
    }
    this.speaking = on
    this.pttHeld = false
    this.error = null
    if (on) {
      for (const room of this.liveRooms()) {
        try {
          await room.startAudio()
        } catch {
          /* autoplay */
        }
        this.rescanRoom(room)
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
    if (this.speaking) return
    if (this.pttHeld === held) return
    this.pttHeld = held
    this.refreshRooms()
    if (held) {
      for (const room of this.liveRooms()) {
        void room.startAudio().catch(() => {})
        this.rescanRoom(room)
      }
    }
    void this.reconcileMicPublish()
    this.notify()
    voiceLog(held ? 'PTT down (hold T)' : 'PTT up')
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

  private async applyHearingOnRoom(room: Room): Promise<void> {
    if (room.state !== ConnectionState.Connected) return
    try {
      await room.startAudio()
    } catch {
      /* autoplay */
    }
    this.dumpRemoteAudioInventory(room, 'hear-on')
    this.rescanRoom(room)
    this.applyRemoteVolumes()
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
          voiceLog(
            `mic want=${want} room=${shortName(room.name)} canPublish=${String(perms?.canPublish)} id=${(room.localParticipant.identity ?? '').slice(0, 12)}`
          )
          if (want && perms?.canPublish === false) {
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
      this.bumpLocalSpeakingHint()
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
    room.on(RoomEvent.ActiveSpeakersChanged, this.onActiveSpeakersChanged)
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
      room.off(RoomEvent.ActiveSpeakersChanged, this.onActiveSpeakersChanged)
    }
    const rk = roomKey(room)
    for (const k of [...this.remotes.keys()]) {
      if (this.remotes.get(k)?.roomKey === rk) this.detachRemote(k)
    }
  }

  private unbindAll(): void {
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
    if (track.kind !== Track.Kind.Audio) return
    if (publication.source === Track.Source.ScreenShareAudio) return
    voiceLog(
      `TrackSubscribed audio · peer=${(participant.identity ?? '').slice(0, 12)} src=${publication.source}`
    )
    this.attachRemote(track, publication, participant)
  }

  private readonly onTrackUnsubscribed = (
    _track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    this.detachRemote(remoteKey(this.findRoomKey(participant), participant.identity, publication.trackSid))
  }

  private readonly onTrackPublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    if (publication.kind !== Track.Kind.Audio) return
    if (publication.source === Track.Source.ScreenShareAudio) return
    voiceLog(
      `TrackPublished audio · peer=${(participant.identity ?? '').slice(0, 12)} src=${publication.source}`
    )
    try {
      if (!publication.isSubscribed) publication.setSubscribed(true)
    } catch {
      /* ignore */
    }
    if (this.hearing) this.ensureRemoteMic(participant)
  }

  private readonly onTrackUnpublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    this.detachRemote(remoteKey(this.findRoomKey(participant), participant.identity, publication.trackSid))
  }

  private readonly onParticipantDisconnected = (participant: RemoteParticipant): void => {
    const id = participant.identity?.toLowerCase() ?? ''
    for (const [key, entry] of [...this.remotes.entries()]) {
      if (entry.participantId === id) this.detachRemote(key)
    }
  }

  private readonly onRoomDisconnected = (): void => {
    this.refreshRooms()
    this.notify()
  }

  private readonly onRoomReconnected = (): void => {
    this.refreshRooms()
    if (this.hearing) this.rescanAllRemoteVoice()
    void this.reconcileMicPublish()
    this.notify()
  }

  private readonly onLocalTrackPublished = (pub: LocalTrackPublication): void => {
    if (pub.kind === Track.Kind.Audio && pub.source === Track.Source.Microphone) {
      this.micLive = true
      this.bumpLocalSpeakingHint()
      this.notify()
    }
  }

  private readonly onLocalTrackUnpublished = (pub: LocalTrackPublication): void => {
    if (pub.kind === Track.Kind.Audio && pub.source === Track.Source.Microphone) {
      this.micLive = this.liveRooms().some(hasLocalMic)
      this.bumpLocalSpeakingHint()
      this.notify()
    }
  }

  private readonly onActiveSpeakersChanged = (speakers: Participant[]): void => {
    const next = new Map<string, number>()
    for (const p of speakers) {
      const id = p.identity?.trim().toLowerCase()
      if (!id) continue
      const level = typeof p.audioLevel === 'number' ? p.audioLevel : p.isSpeaking ? 0.6 : 0
      if (level > 0.02 || p.isSpeaking) next.set(id, Math.max(level, 0.25))
      if (!p.isLocal) {
        try {
          this.ensureRemoteMic(p as RemoteParticipant)
        } catch {
          /* ignore */
        }
      }
    }
    if (this.micLive) {
      for (const room of this.liveRooms()) {
        const localId = room.localParticipant.identity?.trim().toLowerCase()
        if (localId && !next.has(localId)) next.set(localId, 0.55)
      }
    }
    if (next.size > 0) {
      voiceLog(`activeSpeakers=${[...next.keys()].map((k) => k.slice(0, 10)).join(',')}`)
    }
    this.setSpeakingLevels(next)
  }

  private setSpeakingLevels(next: Map<string, number>): void {
    this.speakingLevels = next
    for (const listener of this.speakingListeners) listener(this.speakingLevels)
  }

  private bumpLocalSpeakingHint(): void {
    const next = new Map(this.speakingLevels)
    for (const room of this.liveRooms()) {
      const localId = room.localParticipant.identity?.trim().toLowerCase()
      if (!localId) continue
      if (this.micLive) next.set(localId, Math.max(next.get(localId) ?? 0, 0.55))
      else next.delete(localId)
    }
    this.setSpeakingLevels(next)
  }

  private findRoomKey(participant: RemoteParticipant): string {
    for (const [key, bound] of this.bound) {
      for (const p of bound.room.remoteParticipants.values()) {
        if (p === participant || p.identity === participant.identity) return key
      }
    }
    return 'unknown'
  }

  private rescanAllRemoteVoice(): void {
    for (const room of this.liveRooms()) this.rescanRoom(room)
  }

  private rescanRoom(room: Room): void {
    if (!this.hearing) return
    for (const participant of room.remoteParticipants.values()) {
      this.ensureRemoteMic(participant)
    }
  }

  private ensureRemoteMic(participant: RemoteParticipant): void {
    for (const publication of participant.trackPublications.values()) {
      if (publication.kind !== Track.Kind.Audio) continue
      if (publication.source === Track.Source.ScreenShareAudio) continue
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

  private dumpRemoteAudioInventory(room: Room, reason: string): void {
    const n = room.remoteParticipants.size
    if (n === 0) {
      voiceLog(`audio inventory (${reason}/${shortName(room.name)}): 0 remotes`)
      return
    }
    for (const p of room.remoteParticipants.values()) {
      const pubs = [...p.trackPublications.values()].map(
        (pub) =>
          `${pub.kind}/${pub.source}/sub=${pub.isSubscribed}/muted=${pub.isMuted}/hasTrack=${!!pub.track}`
      )
      voiceLog(
        `audio inventory (${reason}/${shortName(room.name)}) peer=${(p.identity ?? '').slice(0, 12)} pubs=[${pubs.join(' | ') || 'none'}]`
      )
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
    const rk = this.findRoomKey(participant)
    const key = remoteKey(rk, participant.identity, publication.trackSid)
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
      roomKey: rk
    })
    this.remoteCount = this.remotes.size
    voiceLog(
      `Remote voice · peer=${(participant.identity ?? '').slice(0, 10)} room=${rk.slice(0, 24)} total=${this.remoteCount}`
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
  return room.name || `room-${room.localParticipant.identity || 'local'}`
}

function remoteKey(roomKeyStr: string, identity: string | undefined, trackSid: string): string {
  return `${roomKeyStr}|${(identity ?? '').toLowerCase()}:${trackSid}`
}

function shortName(name: string | undefined): string {
  if (!name) return '?'
  return name.length > 36 ? `${name.slice(0, 36)}…` : name
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
