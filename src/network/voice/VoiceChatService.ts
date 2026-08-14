import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication
} from 'livekit-client'
import { isTextInputFocused } from '../../client/ui/textInputFocus'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
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
  /** False until local player has spawned into the scene/world (loading muted). */
  inPlay: boolean
  error: string | null
  roomCount: number
}

type Listener = (state: VoiceChatSnapshot) => void
type SpeakingListener = (levels: ReadonlyMap<string, number>) => void
type RoomsProvider = () => Room[]
type StatusProvider = () => string
/** Remote avatar root (or null while pose not yet known). */
type PeerObjectProvider = (address: string) => import('three').Object3D | null

type RemoteVoiceEntry = {
  element: HTMLAudioElement
  track: RemoteTrack
  trackSid: string
  participantId: string
  roomKey: string
}

type BoundRoom = {
  room: Room
  handlersBound: boolean
}

/**
 * Nearby voice — **flat HTML audio only** (spatial temporarily disabled).
 *
 * Room set from CommsService.getVoiceLiveKitRooms() — **single media room**:
 * - Worlds → world LiveKit only
 * - Parcels → **scene** LiveKit preferred; island only if scene is down
 *
 * Remote tracks → HTMLAudioElement (unmuted, volume via sound settings).
 * One source per participant. Audio stays muted until `setInPlay(true)` after play chrome is ready.
 */
export class VoiceChatService {
  private roomsProvider: RoomsProvider = () => []
  private statusProvider: StatusProvider = () => ''
  private inventoryProvider: StatusProvider = () => ''
  private bound = new Map<string, BoundRoom>()
  private hearing = true
  /** Unlocks hear/speak after spawn — false during landing/loading. */
  private inPlay = false
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
  /** Prevents ensureMicPublished ↔ refreshRooms re-entry (stack overflow). */
  private micSyncDepth = 0
  private audioHost: HTMLDivElement | null = null
  private rescanTimer: ReturnType<typeof setInterval> | null = null
  private lastDiagAt = 0

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.repeat || ev.code !== 'KeyT') return
    if (isTextInputFocused() || isEditableTarget(ev.target)) {
      voiceLog('T ignored — text field focused')
      return
    }
    if (!this.inPlay) {
      voiceLog('T blocked — not in play yet (still loading)', 'warn')
      return
    }
    this.refreshRooms()
    if (this.liveRooms().length === 0) {
      voiceLog('T blocked — no voice LiveKit rooms', 'warn')
      this.dumpStatus('ptt-no-room')
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
    // Peers often publish mic after first scan — keep listening + dump diagnostics.
    this.rescanTimer = setInterval(() => {
      // Never bind/play while loading — but still allow status dumps if rooms exist.
      this.refreshRooms()
      if (!this.inPlay) {
        this.dumpStatus('rescan-loading', true)
        return
      }
      if (this.liveRooms().length === 0) {
        this.dumpStatus('rescan-empty', true)
        return
      }
      if (this.canHear()) {
        this.rescanAllRemoteVoice()
        // Heal paused/muted elements without waiting for another gesture when possible.
        void this.kickAllRemotePlayback('rescan')
      }
      this.dumpStatus('rescan', true)
    }, 5000)
  }

  dispose(): void {
    if (this.rescanTimer != null) {
      clearInterval(this.rescanTimer)
      this.rescanTimer = null
    }
    this.inPlay = false
    void this.setSpeaking(false)
    this.pttHeld = false
    void this.teardownLocalMic('dispose')
    this.unbindAll()
    this.roomsProvider = () => []
    this.statusProvider = () => ''
    this.inventoryProvider = () => ''
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
      hearing: this.hearing && this.inPlay,
      speaking: this.speaking,
      backgroundMuted: this.backgroundMuted || !this.inPlay,
      pttHeld: this.pttHeld,
      micLive: this.micLive,
      remoteCount: this.remoteCount,
      roomReady: this.inPlay && rooms.length > 0,
      inPlay: this.inPlay,
      roomCount: rooms.length,
      error: this.error
    }
  }

  /** API compat — spatial path disabled (HTML audio only). */
  setAudioListener(_listener: import('three').AudioListener | null): void {
    /* no-op */
  }

  /** API compat — spatial path disabled. */
  setPeerObjectProvider(_provider: PeerObjectProvider): void {
    /* no-op */
  }

  /** API compat — spatial path disabled. */
  tickSpatial(): void {
    /* no-op */
  }

  bindRoomsProvider(provider: RoomsProvider): void {
    this.roomsProvider = provider
    this.refreshRooms()
  }

  /** Optional: CommsService.describeLiveKitRooms() for diagnostic dumps. */
  bindStatusProvider(provider: StatusProvider): void {
    this.statusProvider = provider
  }

  /** Optional: multi-line scene/world/island remote track inventory. */
  bindInventoryProvider(provider: StatusProvider): void {
    this.inventoryProvider = provider
  }

  /**
   * Unlock nearby voice after the local player has spawned into the scene/world.
   * Until then: no remote playback, no mic, no name-tag bars (rooms may still bind for logs).
   */
  setInPlay(on: boolean): void {
    if (this.inPlay === on) return
    this.inPlay = on
    voiceLog(on ? 'IN PLAY — voice channel unlocked' : 'OUT OF PLAY — voice muted (loading/leave)')
    this.refreshRooms()
    if (!on) {
      this.pttHeld = false
      void this.setSpeaking(false)
      this.clearAllRemotes()
      this.setSpeakingLevels(new Map())
      this.micLive = false
      void this.reconcileMicPublish()
    } else {
      if (this.hearing) {
        void this.unlockRemotePlayback('in-play')
      }
      this.dumpStatus('in-play')
    }
    this.notify()
  }

  /**
   * Unlock browser/LiveKit audio + attach all remote mics.
   * Call on in-play and after first user gesture — no Hear-others toggle required.
   */
  /**
   * Unlock browser/LiveKit audio + (re)play every remote mic element.
   * Must run inside a user-gesture turn when autoplay is blocked — call on every
   * pointer/key while any remote is still paused (not once-and-done).
   */
  async unlockRemotePlayback(reason = 'unlock'): Promise<void> {
    if (!this.canHear()) return
    this.refreshRooms()
    // No remotes and rooms already unlocked — skip startAudio/rescan storm (pixelwars click spam).
    if (this.remoteCount === 0 && reason === 'user-gesture') {
      const rooms = this.liveRooms()
      if (rooms.length > 0 && rooms.every((r) => r.canPlaybackAudio)) {
        return
      }
    }
    const rooms = this.liveRooms()
    for (const room of rooms) {
      try {
        await room.startAudio()
      } catch (err) {
        voiceLog(`startAudio failed (${shortName(room.name)}): ${String(err)}`, 'warn')
      }
      this.rescanRoom(room)
    }
    this.applyRemoteVolumes()
    await this.kickAllRemotePlayback(reason)
    const paused = [...this.remotes.values()].filter((e) => e.element.paused).length
    const playback = rooms.map((r) => `${shortName(r.name)}:canPlay=${String(r.canPlaybackAudio)}`).join(' ')
    // Throttle success logs — was every click with remotes=0 and tanked FPS with debug capture on.
    if (this.remoteCount > 0 || reason !== 'user-gesture') {
      voiceLog(
        `unlockRemotePlayback (${reason}) remotes=${this.remoteCount} paused=${paused} ${playback || 'no-rooms'}`
      )
    }
    this.notify()
  }

  /** True when at least one remote element is still blocked / not playing. */
  needsPlaybackUnlock(): boolean {
    if (!this.canHear() || this.remotes.size === 0) return false
    for (const entry of this.remotes.values()) {
      if (entry.element.paused || entry.element.muted) return true
      const tracks = (entry.element.srcObject as MediaStream | null)?.getAudioTracks?.() ?? []
      if (tracks.length === 0 || tracks.every((t) => t.readyState !== 'live')) return true
    }
    for (const room of this.liveRooms()) {
      if (!room.canPlaybackAudio) return true
    }
    return false
  }

  isInPlay(): boolean {
    return this.inPlay
  }

  /** Full diagnostic dump for scene-vs-world voice debugging. Verbose inventory only with ?voicedebug. */
  dumpStatus(reason: string, throttle = false): void {
    const now = performance.now()
    if (throttle && now - this.lastDiagAt < 4500) return
    this.lastDiagAt = now
    const verbose =
      typeof location !== 'undefined' &&
      /(?:^|[?&])voicedebug(?:=|&|$)/i.test(location.search)
    this.refreshRooms()
    const rooms = this.liveRooms()
    const roomsDesc = this.statusProvider() || '(no status provider)'
    voiceLog(
      `status (${reason}) inPlay=${this.inPlay} hearing=${this.hearing} canHear=${this.canHear()} ` +
        `speak=${this.speaking} ptt=${this.pttHeld} micLive=${this.micLive} ` +
        `boundRooms=${rooms.length} attachedRemotes=${this.remoteCount} err=${this.error ?? 'none'}`
    )
    if (!verbose) {
      // One-line summary only — full peer inventory every 5s was drowning the console in Genesis.
      voiceLog(`  livekit: ${roomsDesc}`)
      return
    }
    voiceLog(`  livekit: ${roomsDesc}`)
    if (rooms.length === 0) {
      voiceLog('  voice rooms: none — getVoiceLiveKitRooms empty (wrong room type or not connected)', 'warn')
    } else {
      for (const room of rooms) {
        const lp = room.localParticipant
        const perms = lp.permissions
        voiceLog(
          `  VOICE room=${shortName(room.name)} state=${room.state} remotes=${room.remoteParticipants.size} ` +
            `canPublish=${String(perms?.canPublish)} canSubscribe=${String(perms?.canSubscribe)} ` +
            `canPublishData=${String(perms?.canPublishData)} id=${(lp.identity ?? '').slice(0, 14)} ` +
            `localMic=${hasLocalMic(room)} activeSpeakers=${room.activeSpeakers.length}`
        )
        this.dumpRemoteAudioInventory(room, `voice/${reason}`)
      }
    }
    const inv = this.inventoryProvider()
    if (inv) {
      for (const line of inv.split('\n')) {
        if (line.trim()) voiceLog(`  all · ${line}`)
      }
    }
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
      voiceLog(
        `bound ${shortName(room.name)} remotes=${room.remoteParticipants.size} inPlay=${this.inPlay}`
      )
      if (this.canHear()) void this.applyHearingOnRoom(room)
      else this.dumpRemoteAudioInventory(room, 'bind-muted')
    }

    if (nextRooms.length === 0) {
      this.clearAllRemotes()
      this.micLive = false
      this.setSpeakingLevels(new Map())
    } else if (this.shouldPublishMic() && this.micSyncDepth === 0) {
      // Only from outside ensureMicPublished — never recurse refreshRooms ↔ mic publish.
      void this.reconcileMicPublish()
    }
    this.notify()
  }

  async setHearing(on: boolean): Promise<void> {
    this.refreshRooms()
    if (this.hearing === on) return
    this.hearing = on
    voiceLog(`Hear others ${on ? 'ON' : 'OFF'} inPlay=${this.inPlay}`)
    if (on && this.inPlay) {
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
    this.dumpStatus('panel-open')
    if (!this.inPlay) {
      voiceLog('ensureHearingUnlocked — not in play yet (still muted)', 'warn')
      this.notify()
      return
    }
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
    await this.kickAllRemotePlayback('panel-open')
    this.notify()
  }

  async setSpeaking(on: boolean): Promise<void> {
    this.refreshRooms()
    if (this.speaking === on) {
      voiceLog(`Speak already ${on ? 'on' : 'off'}`)
      return
    }
    if (on && !this.inPlay) {
      this.error = 'Still loading — voice unlocks when you are in the scene'
      this.notify()
      voiceLog('Speak blocked — not in play yet', 'warn')
      this.dumpStatus('speak-blocked-loading')
      return
    }
    if (on && this.liveRooms().length === 0) {
      this.error = 'Not connected to voice room'
      this.notify()
      voiceLog('Speak blocked — no LiveKit rooms', 'warn')
      this.dumpStatus('speak-blocked-no-room')
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
    if (held && !this.inPlay) {
      voiceLog('PTT blocked — not in play yet', 'warn')
      return
    }
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

  private canHear(): boolean {
    return this.hearing && this.inPlay
  }

  private shouldPublishMic(): boolean {
    if (!this.inPlay || this.backgroundMuted || this.liveRooms().length === 0) return false
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
    await this.kickAllRemotePlayback('hear-on')
  }

  private async reconcileMicPublish(): Promise<void> {
    await this.ensureMicPublished(this.shouldPublishMic())
  }

  private async ensureMicPublished(want: boolean): Promise<void> {
    this.micSyncDepth += 1
    try {
      this.refreshRooms()
      const rooms = this.liveRooms()
      if (rooms.length === 0) {
        this.micLive = false
        if (want) {
          this.error = 'Not connected to voice room'
          this.notify()
        }
        if (!want) await this.teardownLocalMic('no-room')
        return
      }
      if (this.publishInFlight) await this.publishInFlight
      const run = (async () => {
        let anyLive = false
        let lastError: string | null = null
        const deviceId = soundSettings.get().microphoneDeviceId
        const captureOpts = deviceId ? { deviceId } : undefined

        // Exactly the media room(s) from getVoiceLiveKitRooms (one for parcels/worlds).
        for (const room of rooms) {
          const perms = room.localParticipant.permissions
          const sources = (perms as { canPublishSources?: unknown[] } | undefined)?.canPublishSources
          voiceLog(
            `mic want=${want} room=${shortName(room.name)} remotes=${room.remoteParticipants.size} ` +
              `canPublish=${String(perms?.canPublish)} sources=${Array.isArray(sources) ? sources.join('|') || '[]' : String(sources)} ` +
              `id=${(room.localParticipant.identity ?? '').slice(0, 14)} name=${(room.localParticipant.name ?? '').slice(0, 20)}`
          )
          try {
            if (want) {
              if (perms?.canPublish === false) {
                lastError = `canPublish=false on ${shortName(room.name)}`
                voiceLog(lastError, 'error')
                continue
              }
              const pub = await room.localParticipant.setMicrophoneEnabled(true, captureOpts)
              if (pub?.isMuted) await pub.unmute()
              const track = pub?.track
              if (track?.isMuted) await track.unmute()
              const mst = track?.mediaStreamTrack
              if (mst && !mst.enabled) mst.enabled = true
              const live = !!track && !!mst && mst.readyState === 'live' && mst.enabled
              if (live) anyLive = true
              voiceLog(
                `Mic published · ${shortName(room.name)} live=${live} sid=${pub?.trackSid?.slice(0, 12) ?? 'n/a'} ` +
                  `muted=${String(pub?.isMuted)} remotes=${room.remoteParticipants.size} ` +
                  `localName=${(room.localParticipant.name ?? '').slice(0, 20)}`
              )
              for (const p of room.remoteParticipants.values()) {
                voiceLog(
                  `  peer-in-room ${(p.identity ?? '').slice(0, 12)} audioPubs=${[...p.audioTrackPublications.values()].length} ` +
                    `name=${(p.name ?? '').slice(0, 16)}`
                )
              }
            } else {
              await room.localParticipant.setMicrophoneEnabled(false)
              voiceLog(
                `Mic unpublished · ${shortName(room.name)} pubsLeft=${room.localParticipant.audioTrackPublications.size}`
              )
            }
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err)
            voiceLog(`Mic error on ${shortName(room.name)}: ${lastError}`, 'error')
          }
        }

        if (!want) {
          this.micLive = false
          this.error = null
        } else {
          this.micLive = anyLive
          this.error = anyLive
            ? null
            : lastError ?? `No publishable voice room among ${rooms.map((r) => shortName(r.name)).join('+')}`
        }
        this.bumpLocalSpeakingHint()
        this.notify()
      })()
      this.publishInFlight = run
      await run
      if (this.publishInFlight === run) this.publishInFlight = null
    } finally {
      this.micSyncDepth = Math.max(0, this.micSyncDepth - 1)
    }
  }

  private async teardownLocalMic(reason: string): Promise<void> {
    voiceLog(`teardownLocalMic (${reason})`)
    for (const room of this.liveRooms()) {
      try {
        await room.localParticipant.setMicrophoneEnabled(false)
      } catch {
        /* ignore */
      }
    }
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
    if (track.kind !== Track.Kind.Audio) return
    if (publication.source === Track.Source.ScreenShareAudio) return
    voiceLog(
      `TrackSubscribed audio · peer=${(participant.identity ?? '').slice(0, 12)} src=${publication.source} inPlay=${this.inPlay} hear=${this.hearing}`
    )
    if (!this.canHear()) return
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
    if (this.canHear()) this.ensureRemoteMic(participant)
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
    voiceLog('room reconnected')
    this.dumpStatus('reconnected')
    if (this.canHear()) this.rescanAllRemoteVoice()
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

  private readonly onActiveSpeakersChanged = (_speakers: Participant[]): void => {
    if (!this.inPlay) {
      // Still log sparingly so we can see speakers arrive during loading.
      if (_speakers.length > 0) {
        voiceLog(
          `activeSpeakers (muted/loading) n=${_speakers.length} ids=${_speakers
            .map((p) => (p.identity ?? '').slice(0, 10))
            .join(',')}`
        )
      }
      return
    }
    // Rebuild from every bound room — single-room events would wipe the other room's speakers.
    const next = new Map<string, number>()
    for (const room of this.liveRooms()) {
      for (const p of room.activeSpeakers) {
        const id = p.identity?.trim().toLowerCase()
        if (!id) continue
        const level = typeof p.audioLevel === 'number' ? p.audioLevel : p.isSpeaking ? 0.6 : 0
        if (level > 0.02 || p.isSpeaking) {
          next.set(id, Math.max(next.get(id) ?? 0, Math.max(level, 0.25)))
        }
        if (!p.isLocal && this.canHear()) {
          try {
            this.ensureRemoteMic(p as RemoteParticipant)
          } catch {
            /* ignore */
          }
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
      const rooms = this.liveRooms()
        .map((r) => shortName(r.name))
        .join('+')
      voiceLog(`activeSpeakers=${[...next.keys()].map((k) => k.slice(0, 10)).join(',')} room=${rooms}`)
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
    if (!this.canHear()) return
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
    // Keep in-layout (not display:none) so browsers don't treat as non-audible media.
    host.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;opacity:0'
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
    if (!this.canHear()) return
    const participantId = (participant.identity ?? '').trim().toLowerCase()
    if (!participantId) return

    // Island + scene dual rooms — one HTML source per peer (prefer existing live attachment).
    const existingForPeer = this.findRemoteForParticipant(participantId)
    if (existingForPeer) {
      if (this.isEntryLive(existingForPeer)) return
      // Dead/stale attachment — drop and rebind (common after island handoff).
      this.detachRemote(existingForPeer.key)
    }

    const rk = this.findRoomKey(participant)
    const key = remoteKey(rk, participant.identity, publication.trackSid)
    if (this.remotes.has(key)) {
      const cur = this.remotes.get(key)!
      if (this.isEntryLive(cur)) {
        this.applyEntryVolume(cur)
        void this.playEntry(cur, 'reattach-live')
        return
      }
      this.detachRemote(key)
    }

    const el = track.attach() as HTMLAudioElement
    el.autoplay = true
    el.setAttribute('playsinline', 'true')
    el.setAttribute('webkit-playsinline', 'true')
    this.ensureAudioHost().appendChild(el)

    const entry: RemoteVoiceEntry = {
      element: el,
      track,
      trackSid: publication.trackSid,
      participantId,
      roomKey: rk
    }
    this.remotes.set(key, entry)
    this.remoteCount = this.remotes.size
    this.applyEntryVolume(entry)
    void this.playEntry(entry, 'attach')

    const mst = track.mediaStreamTrack
    voiceLog(
      `Remote voice · peer=${participantId.slice(0, 10)} room=${rk.slice(0, 24)} ` +
        `track=${mst?.readyState ?? 'n/a'} enabled=${String(mst?.enabled)} ` +
        `mutedPub=${String(publication.isMuted)} total=${this.remoteCount}`
    )
    this.notify()
  }

  private findRemoteForParticipant(participantId: string): (RemoteVoiceEntry & { key: string }) | null {
    for (const [key, entry] of this.remotes) {
      if (entry.participantId === participantId) return { ...entry, key }
    }
    return null
  }

  private isEntryLive(entry: RemoteVoiceEntry): boolean {
    const mst = entry.track.mediaStreamTrack
    if (mst && mst.readyState === 'live') return true
    const tracks = (entry.element.srcObject as MediaStream | null)?.getAudioTracks?.() ?? []
    return tracks.some((t) => t.readyState === 'live')
  }

  private detachRemote(key: string): void {
    const entry = this.remotes.get(key)
    if (!entry) return
    try {
      // Prefer LiveKit detach so attachedElements stays consistent for startAudio().
      entry.track.detach(entry.element)
    } catch {
      try {
        entry.element.pause()
        entry.element.srcObject = null
        entry.element.remove()
      } catch {
        /* ignore */
      }
    }
    try {
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
    for (const entry of this.remotes.values()) this.applyEntryVolume(entry)
  }

  private applyEntryVolume(entry: RemoteVoiceEntry): void {
    const hear = this.canHear()
    const g = hear ? remoteGain() : 0
    // LiveKit may route through its own gain when webAudioMix/AudioContext is active.
    try {
      const t = entry.track as RemoteTrack & { setVolume?: (v: number) => void }
      t.setVolume?.(g)
    } catch {
      /* ignore */
    }
    entry.element.volume = g
    // Never leave muted=true while hearing — LiveKit startAudio also clears muted.
    entry.element.muted = !hear || g <= 0
  }

  private async playEntry(entry: RemoteVoiceEntry, reason: string): Promise<void> {
    if (!this.canHear()) return
    this.applyEntryVolume(entry)
    const el = entry.element
    try {
      await el.play()
    } catch (err) {
      voiceLog(
        `Remote voice play blocked (${reason}) peer=${entry.participantId.slice(0, 10)}: ${String(err)}`,
        'warn'
      )
    }
  }

  private async kickAllRemotePlayback(reason: string): Promise<void> {
    const jobs: Promise<void>[] = []
    for (const entry of this.remotes.values()) {
      jobs.push(this.playEntry(entry, reason))
    }
    await Promise.all(jobs)
  }

  private notify(): void {
    const rooms = this.liveRooms()
    const snap: VoiceChatSnapshot = {
      hearing: this.hearing && this.inPlay,
      speaking: this.speaking,
      backgroundMuted: this.backgroundMuted || !this.inPlay,
      pttHeld: this.pttHeld,
      micLive: this.micLive,
      remoteCount: this.remoteCount,
      roomReady: this.inPlay && rooms.length > 0,
      inPlay: this.inPlay,
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
  // Opt-in only — Help → Debug “Browser console logs” / panel record.
  const map: 'info' | 'warn' | 'error' = level === 'log' ? 'info' : level
  clientDebugLog.log('voice', message, { level: map })
}
