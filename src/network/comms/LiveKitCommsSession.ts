import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrackPublication
} from 'livekit-client'
import type { CommsProfileEntity } from '../../avatar/peerApi'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import { setLiveKitSession } from '../SessionConnections'
import {
  encodeRfc4MovementPacket,
  encodeRfc4PlayerEmotePacket,
  encodeRfc4ProfileResponsePacket,
  encodeRfc4ProfileVersionPacket,
  movementBlendTier
} from './dclRfc4Comms'
import { encodeRfc4ChatPacket, oleTimestampNow } from '../../social/dclRfc4Chat'
import { DCM_SCENE_ID } from '../../social/dcmChatMedia'
import { encodeRfc4SceneBinaryPacket } from './Rfc4Router'
import {
  playerYawToMovementRotationDeg,
  sceneLocalToGenesis,
  type CommsSceneOrigin,
  type RealmBounds
} from './movementCompressed'
import { parseLiveKitConnectionString } from './livekitAdapter'
import {
  collectActiveVideoStreamsFromRoom,
  forceSubscribeRemoteVideo,
  pickCurrentStreamVideoTrack,
  reattachFirstRemoteVideoToHost,
  roomHasRemoteVideo,
  snapshotRemoteVideoPresence,
  type ActiveVideoStream
} from './livekitVideoStreams'
import { TransportType, type PeerLifecycleHandlers } from './Transport'

const PROFILE_EVERY_N_BROADCASTS = 30
const MOVE_EPSILON = 0.02
const OUTBOUND_DEBUG_LOGS = 5

export type PacketHandler = (transport: TransportType, address: string, data: Uint8Array) => void
export type TopicHandler = (topic: string, address: string, data: Uint8Array) => void

/** LiveKit transport entity — Bevy `LivekitPlugin` room session. */
export class LiveKitCommsSession {
  private room: Room | null = null
  private peerHandlers: PeerLifecycleHandlers | null = null
  private packetHandler: PacketHandler | null = null
  private topicHandler: TopicHandler | null = null
  private localAddress: string | null = null
  private commsProfile: CommsProfileEntity | null = null
  private lambdasUrl = ''
  private realmBounds: RealmBounds | null = null
  private sceneOrigin: CommsSceneOrigin | null = null
  private pendingTransform: {
    x: number
    y: number
    z: number
    yaw: number
    isEmoting: boolean
    locomotion?: {
      isGrounded?: boolean
      isJumping?: boolean
      jumpCount?: number
      isFalling?: boolean
    }
  } | null = null
  private lastSentTransform: { x: number; y: number; z: number; yaw: number } | null = null
  private sessionStartedAt = performance.now()
  private lastBroadcast = 0
  private broadcastCount = 0
  private outboundDebugLogs = 0
  private connected = false
  /** Bumped on every disconnect / new connect so stale in-flight joins abort cleanly. */
  private connectGeneration = 0

  constructor(
    private readonly transport: TransportType,
    private readonly registerGlobalSession = true
  ) {}

  setPeerHandlers(handlers: PeerLifecycleHandlers | null): void {
    this.peerHandlers = handlers
  }

  setPacketHandler(handler: PacketHandler | null): void {
    this.packetHandler = handler
  }

  setTopicHandler(handler: TopicHandler | null): void {
    this.topicHandler = handler
  }

  setLocalAddress(address: string | undefined): void {
    this.localAddress = address?.toLowerCase() ?? null
  }

  setCommsProfile(profile: CommsProfileEntity | null): void {
    this.commsProfile = profile
    // Re-apply name/metadata if already connected (handoff / late profile load).
    if (this.isConnected()) this.applyLocalIdentityToRoom()
  }

  /**
   * Push display name + lambdas into LiveKit participant so Explorer can map wallet → avatar
   * for voice bars / name tags. serializedProfile is a flat LambdaAvatarEntry JSON (not {avatars:[]}).
   */
  applyLocalIdentityToRoom(displayNameOverride?: string | null): void {
    const room = this.room
    if (!room || room.state !== ConnectionState.Connected) return
    const meta: Record<string, unknown> = {}
    if (this.lambdasUrl) meta.lambdasEndpoint = this.lambdasUrl
    let dn = displayNameOverride?.trim() || ''
    if (!dn && this.commsProfile?.serializedProfile) {
      try {
        const entry = JSON.parse(this.commsProfile.serializedProfile) as {
          name?: string
          unclaimedName?: string
        }
        dn = entry.name?.trim() || entry.unclaimedName?.trim() || ''
      } catch {
        /* ignore */
      }
    }
    if (dn) {
      meta.displayName = dn
      void room.localParticipant.setName(dn)
    }
    if (Object.keys(meta).length > 0) {
      void room.localParticipant.setMetadata(JSON.stringify(meta))
    }
  }

  setLambdasUrl(url: string): void {
    this.lambdasUrl = url.replace(/\/$/, '')
  }

  setRealmBounds(bounds: RealmBounds | null): void {
    this.realmBounds = bounds
  }

  setSceneOrigin(origin: CommsSceneOrigin | null): void {
    this.sceneOrigin = origin
  }

  isConnected(): boolean {
    return this.connected && this.room?.state === ConnectionState.Connected
  }

  /** LiveKit room instance (null if disconnected). */
  getRoom(): Room | null {
    return this.room
  }

  getRoomName(): string {
    return this.room?.name?.trim() || ''
  }

  getRemotePeerAddresses(): string[] {
    if (!this.room) return []
    const out: string[] = []
    for (const participant of this.room.remoteParticipants.values()) {
      const address = participant.identity?.trim().toLowerCase()
      if (address && address !== this.localAddress) out.push(address)
    }
    return out
  }

  getActiveVideoStreams(): ActiveVideoStream[] {
    return collectActiveVideoStreamsFromRoom(this.room)
  }

  /** True when any remote participant publishes video (Cast / OBS ingress live). */
  hasRemoteVideoLive(): boolean {
    return roomHasRemoteVideo(this.room)
  }

  getRemoteVideoPresenceSnapshot() {
    return snapshotRemoteVideoPresence(this.room)
  }

  /**
   * Notify when remote video presence flips (Cast start/stop).
   * Force-subscribes remote video (companion) and polls — RTMP ingress can lag join.
   */
  watchRemoteVideoLive(onChange: (live: boolean) => void): () => void {
    const room = this.room
    if (!room || !this.isConnected()) {
      onChange(false)
      return () => {}
    }

    let last: boolean | null = null
    let logTicks = 0

    const emit = (reason: string): void => {
      forceSubscribeRemoteVideo(room)
      const snap = snapshotRemoteVideoPresence(room)
      logTicks += 1
      // First few ticks + any change: log so landing Cast debug is visible in console.
      if (logTicks <= 6 || snap.live !== last) {
        // Category must NOT be `comms` — ClientDebugLog silences that category entirely.
        const msg =
          `Cast presence (${this.transport}/${reason}): live=${snap.live} remotes=${snap.remoteParticipants} videoPubs=${snap.remoteVideoPubs}` +
          (snap.details.length ? ` · ${snap.details.slice(0, 6).join(' | ')}` : '')
        clientDebugLog.log('cast', msg, {
          level: snap.live ? 'success' : 'info',
          alsoConsole: true
        })
        console.log(`[cast] ${msg}`)
      }
      if (snap.live === last) return
      last = snap.live
      onChange(snap.live)
    }

    const onTrackEvent = (): void => emit('track')
    const onPeerEvent = (): void => emit('peer')

    room.on(RoomEvent.TrackSubscribed, onTrackEvent)
    room.on(RoomEvent.TrackUnsubscribed, onTrackEvent)
    room.on(RoomEvent.TrackPublished, onTrackEvent)
    room.on(RoomEvent.TrackUnpublished, onTrackEvent)
    room.on(RoomEvent.ParticipantConnected, onPeerEvent)
    room.on(RoomEvent.ParticipantDisconnected, onPeerEvent)
    room.on(RoomEvent.Connected, onPeerEvent)
    room.on(RoomEvent.Disconnected, onPeerEvent)

    emit('start')
    // Ingress often appears 1–5s after OBS “live”; poll aggressively at first.
    const poll = window.setInterval(() => emit('poll'), 1500)

    return () => {
      window.clearInterval(poll)
      room.off(RoomEvent.TrackSubscribed, onTrackEvent)
      room.off(RoomEvent.TrackUnsubscribed, onTrackEvent)
      room.off(RoomEvent.TrackPublished, onTrackEvent)
      room.off(RoomEvent.TrackUnpublished, onTrackEvent)
      room.off(RoomEvent.ParticipantConnected, onPeerEvent)
      room.off(RoomEvent.ParticipantDisconnected, onPeerEvent)
      room.off(RoomEvent.Connected, onPeerEvent)
      room.off(RoomEvent.Disconnected, onPeerEvent)
    }
  }

  /**
   * Attach scene `livekit-video://current-stream` to a VideoPlayer element.
   * Unity parity: presentation-bot → screen share → any remote video (stream-key ingress / Cast).
   * Admin Activate sets VideoPlayer.src to this URL (MessageBus); m3u8/static use normal https src.
   * Media ends when no remote publisher remains — not when the activating admin leaves.
   */
  bindCurrentVideoStream(video: HTMLVideoElement, onUpdate?: () => void): () => void {
    const room = this.room
    if (!room) return () => {}

    let attached: Track | null = null
    let attachedSid = ''
    let disposed = false

    const detach = (): void => {
      if (attached) {
        try {
          attached.detach(video)
        } catch {
          /* ignore */
        }
        attached = null
        attachedSid = ''
      }
      // Do not null srcObject here — LiveKit owns the MediaStream; clearing it during
      // teardown races with PC close and surfaces UnexpectedConnectionState spam.
    }

    const trackSid = (t: Track | null): string => {
      if (!t) return ''
      const sid = typeof t.sid === 'string' ? t.sid.trim() : ''
      return sid
    }

    const attachBest = (): void => {
      if (disposed || !this.room || this.room !== room) return
      if (room.state !== ConnectionState.Connected) return
      forceSubscribeRemoteVideo(room)
      const next = pickCurrentStreamVideoTrack(room)
      const nextSid = trackSid(next)
      if (next && nextSid && nextSid === attachedSid && attached) {
        if (video.paused) void video.play().catch(() => {})
        return
      }
      if (next === attached) {
        if (next && video.paused) void video.play().catch(() => {})
        return
      }
      detach()
      if (!next) {
        onUpdate?.()
        return
      }
      try {
        next.attach(video)
      } catch {
        onUpdate?.()
        return
      }
      attached = next
      attachedSid = nextSid
      void video.play().catch(() => {})
      onUpdate?.()
    }

    const onTrackChange = (): void => attachBest()

    room.on(RoomEvent.TrackSubscribed, onTrackChange)
    room.on(RoomEvent.TrackUnsubscribed, onTrackChange)
    room.on(RoomEvent.TrackPublished, onTrackChange)
    room.on(RoomEvent.TrackUnpublished, onTrackChange)
    room.on(RoomEvent.ParticipantConnected, onTrackChange)
    room.on(RoomEvent.ParticipantDisconnected, onTrackChange)
    room.on(RoomEvent.TrackMuted, onTrackChange)
    room.on(RoomEvent.TrackUnmuted, onTrackChange)

    attachBest()
    // RTMP ingress / Cast speakers can appear after Activate; poll lightly while connected.
    const poll = window.setInterval(attachBest, 2000)

    return () => {
      disposed = true
      window.clearInterval(poll)
      room.off(RoomEvent.TrackSubscribed, onTrackChange)
      room.off(RoomEvent.TrackUnsubscribed, onTrackChange)
      room.off(RoomEvent.TrackPublished, onTrackChange)
      room.off(RoomEvent.TrackUnpublished, onTrackChange)
      room.off(RoomEvent.ParticipantConnected, onTrackChange)
      room.off(RoomEvent.ParticipantDisconnected, onTrackChange)
      room.off(RoomEvent.TrackMuted, onTrackChange)
      room.off(RoomEvent.TrackUnmuted, onTrackChange)
      detach()
    }
  }

  /**
   * Companion-style Cast attach: force-sub remote A/V, pick best video, mount into host.
   * Retries on track events until disposed.
   */
  bindRemoteVideoToHost(
    host: HTMLElement,
    onUpdate?: (attached: boolean) => void,
    opts?: { muted?: boolean; volume?: number }
  ): () => void {
    const room = this.room
    if (!room) {
      onUpdate?.(false)
      return () => {}
    }

    // Unlock remote audio after user gesture (Join live click).
    void room.startAudio().catch(() => {})

    let lastOk = false
    const attach = (): void => {
      forceSubscribeRemoteVideo(room)
      const ok = reattachFirstRemoteVideoToHost(room, host, {
        muted: opts?.muted,
        volume: opts?.volume,
        controls: false
      })
      if (ok !== lastOk) {
        lastOk = ok
        onUpdate?.(ok)
      } else if (ok) {
        onUpdate?.(true)
      }
    }

    const onChange = (): void => attach()
    room.on(RoomEvent.TrackSubscribed, onChange)
    room.on(RoomEvent.TrackUnsubscribed, onChange)
    room.on(RoomEvent.TrackPublished, onChange)
    room.on(RoomEvent.TrackUnpublished, onChange)
    room.on(RoomEvent.ParticipantConnected, onChange)
    room.on(RoomEvent.ParticipantDisconnected, onChange)

    attach()
    const poll = window.setInterval(attach, 1500)

    return () => {
      window.clearInterval(poll)
      room.off(RoomEvent.TrackSubscribed, onChange)
      room.off(RoomEvent.TrackUnsubscribed, onChange)
      room.off(RoomEvent.TrackPublished, onChange)
      room.off(RoomEvent.TrackUnpublished, onChange)
      room.off(RoomEvent.ParticipantConnected, onChange)
      room.off(RoomEvent.ParticipantDisconnected, onChange)
      host.replaceChildren()
    }
  }

  async connect(adapter: string): Promise<boolean> {
    const gen = ++this.connectGeneration
    // Tear down previous room without invalidating *this* generation.
    this.teardownRoom()

    let url: string
    let token: string
    try {
      ;({ url, token } = parseLiveKitConnectionString(adapter))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('comms', `Invalid LiveKit adapter: ${msg}`, { level: 'error' })
      return false
    }

    if (gen !== this.connectGeneration) return false

    const room = new Room({ adaptiveStream: false, dynacast: false })
    this.room = room
    this.sessionStartedAt = performance.now()

    const onParticipantConnected = (participant: Participant) => {
      const address = participant.identity?.trim().toLowerCase()
      if (!address || address === this.localAddress) return
      clientDebugLog.log('comms', `Peer joined (${this.transport}): ${address.slice(0, 10)}…`, {
        level: 'success'
      })
      this.peerHandlers?.onPeerJoin(address, this.transport)
    }

    const onParticipantDisconnected = (participant: Participant) => {
      const address = participant.identity?.trim().toLowerCase()
      if (!address || address === this.localAddress) return
      clientDebugLog.log('comms', `Peer left (${this.transport}): ${address.slice(0, 10)}…`, {
        level: 'warn'
      })
      this.peerHandlers?.onPeerLeave(address, this.transport)
    }

    const onDataReceived = (
      payload: Uint8Array,
      participant?: Participant,
      _kind?: unknown,
      topic?: string
    ) => {
      const address = participant?.identity?.trim().toLowerCase()
      if (!address || address === this.localAddress || participant?.isLocal) return
      if (topic) {
        this.topicHandler?.(topic, address, payload)
        return
      }
      this.packetHandler?.(this.transport, address, payload)
    }

    const onDisconnected = () => {
      this.connected = false
      clientDebugLog.log('comms', `LiveKit disconnected (${this.transport})`, { level: 'warn' })
    }

    room.on(RoomEvent.ParticipantConnected, onParticipantConnected)
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected)
    room.on(RoomEvent.DataReceived, onDataReceived)
    room.on(RoomEvent.Disconnected, onDisconnected)

    if (this.registerGlobalSession) {
      // Only the *connected* scene/world room owns the global session. Empty World
      // CommsService dispose must not clear a live landing room via setLiveKitSession(null).
      setLiveKitSession({
        disconnect: async () => {
          // Identity check: ignore if this session already tore down / was replaced.
          if (this.room !== room) return
          room.disconnect()
        }
      })
    }

    // Cast/OBS LIVE detection only needs **video**. Do not force-subscribe mic audio here —
    // VoiceChatService owns nearby voice attach/mute (and must stay silent until in-play).
    const forceSubscribeRemoteVideo = (
      publication: RemoteTrackPublication,
      participant: Participant
    ): void => {
      if (participant.isLocal) return
      if (publication.kind !== Track.Kind.Video) return
      try {
        publication.setSubscribed(true)
      } catch {
        /* ignore */
      }
    }
    room.on(RoomEvent.TrackPublished, forceSubscribeRemoteVideo)

    try {
      await room.connect(url, token, { autoSubscribe: true })
      // Superseded by a newer connect/disconnect while awaiting join.
      if (gen !== this.connectGeneration || this.room !== room) {
        try {
          room.disconnect()
        } catch {
          /* ignore */
        }
        return false
      }
      this.connected = true
      this.applyLocalIdentityToRoom()

      for (const participant of room.remoteParticipants.values()) {
        const remoteAddress = participant.identity?.trim().toLowerCase()
        if (remoteAddress && this.localAddress && remoteAddress === this.localAddress) {
          clientDebugLog.log(
            'comms',
            `Duplicate wallet in room (${this.transport}) — disconnecting second client`,
            { level: 'error' }
          )
          this.disconnect()
          return false
        }
        // Subscribe video already present at join (Cast may already be live).
        for (const publication of participant.trackPublications.values()) {
          forceSubscribeRemoteVideo(publication as RemoteTrackPublication, participant)
        }
      }

      const remoteVideo = roomHasRemoteVideo(room)
      clientDebugLog.log(
        'network',
        `LiveKit connected (${this.transport}) · room=${room.name} · remotes=${room.remoteParticipants.size} · remoteVideo=${remoteVideo}`,
        { level: 'success', alsoConsole: true }
      )
      if (this.transport === TransportType.SceneRoom || String(room.name).includes('scene-room')) {
        console.log(
          `[cast] scene LiveKit room=${room.name} remotes=${room.remoteParticipants.size} remoteVideo=${remoteVideo}`
        )
      }

      for (const participant of room.remoteParticipants.values()) {
        onParticipantConnected(participant)
      }

      this.sendProfileAnnouncement('connect')
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Don't log aborts from a newer connect superseding this one.
      if (gen === this.connectGeneration) {
        clientDebugLog.log('comms', `LiveKit connect failed (${this.transport}): ${msg}`, {
          level: 'error'
        })
        this.teardownRoom()
      }
      return false
    }
  }

  seedPeers(addresses: string[]): void {
    if (!this.localAddress) return
    if (addresses.length) {
      clientDebugLog.log('comms', `Scene participants seeded: ${addresses.length}`, { level: 'info' })
    }
    for (const address of addresses) {
      if (address === this.localAddress) continue
      this.peerHandlers?.onPeerJoin(address, this.transport)
    }
  }

  queueTransform(
    x: number,
    y: number,
    z: number,
    yaw: number,
    isEmoting = false,
    locomotion?: {
      isGrounded?: boolean
      isJumping?: boolean
      jumpCount?: number
      isFalling?: boolean
    }
  ): void {
    if (!this.isConnected()) return
    this.pendingTransform = { x, y, z, yaw, isEmoting, locomotion }
  }

  flushBroadcast(now = performance.now(), intervalMs = 100): void {
    if (!this.pendingTransform || !this.room || this.room.state !== ConnectionState.Connected) return
    if (now - this.lastBroadcast < intervalMs) return

    const { x, y, z, yaw, isEmoting, locomotion } = this.pendingTransform
    const prev = this.lastSentTransform
    const moving = isEmoting
      ? false
      : !prev ||
        Math.hypot(x - prev.x, y - prev.y, z - prev.z) > MOVE_EPSILON ||
        Math.abs(yaw - prev.yaw) > MOVE_EPSILON

    const elapsedSec = (now - this.sessionStartedAt) / 1000
    const velocity = isEmoting
      ? { x: 0, y: 0, z: 0 }
      : prev && moving
        ? {
            x: (x - prev.x) / Math.max(intervalMs / 1000, 0.001),
            y: (y - prev.y) / Math.max(intervalMs / 1000, 0.001),
            z: (z - prev.z) / Math.max(intervalMs / 1000, 0.001)
          }
        : { x: 0, y: 0, z: 0 }

    const horizontalSpeed = Math.hypot(velocity.x, velocity.z)

    const movementPacket = encodeRfc4MovementPacket(
      { x, y, z, yaw, moving },
      elapsedSec,
      velocity,
      this.realmBounds,
      false,
      this.sceneOrigin,
      isEmoting,
      locomotion
    )

    void this.safePublishData(movementPacket, false)

    this.broadcastCount++
    this.lastSentTransform = { x, y, z, yaw }

    if (this.outboundDebugLogs < OUTBOUND_DEBUG_LOGS) {
      this.outboundDebugLogs++
      const genesis = this.sceneOrigin
        ? sceneLocalToGenesis(x, y, z, this.sceneOrigin)
        : { x, y, z }
      clientDebugLog.log(
        'comms',
        `RFC4 Movement out #${this.broadcastCount} (${this.transport}) scene=(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}) world=(${genesis.x.toFixed(1)},${genesis.y.toFixed(1)},${genesis.z.toFixed(1)}) origin=(${this.sceneOrigin?.baseParcelX ?? 0},${this.sceneOrigin?.baseParcelY ?? 0})`
      )
    }
    clientDebugLog.log(
      'comms',
      `RFC4 Movement out → ${this.transport} #${this.broadcastCount} x=${x.toFixed(1)} y=${y.toFixed(1)} z=${z.toFixed(1)} rot=${playerYawToMovementRotationDeg(yaw).toFixed(0)}° blend=${movementBlendTier(horizontalSpeed, moving)}`,
      { throttleMs: 1000, throttleKey: `position-out:${this.transport}` }
    )
    if (this.broadcastCount === 1 || this.broadcastCount % PROFILE_EVERY_N_BROADCASTS === 0) {
      this.sendProfileAnnouncement(this.broadcastCount === 1 ? 'connect' : 'heartbeat')
    }

    this.lastBroadcast = now
    this.pendingTransform = null
  }

  sendProfileAnnouncement(reason: 'connect' | 'heartbeat' | 'profile-request'): void {
    if (!this.room || this.room.state !== ConnectionState.Connected || !this.commsProfile) return

    const { version, serializedProfile, baseUrl } = this.commsProfile
    const sendFullProfile = reason !== 'heartbeat' || this.broadcastCount <= 1

    if (sendFullProfile) {
      void this.safePublishData(encodeRfc4ProfileResponsePacket(serializedProfile, baseUrl), true)
    }

    void this.safePublishData(encodeRfc4ProfileVersionPacket(version), false)
    clientDebugLog.log(
      'comms',
      `RFC4 Profile v${version} sent (${this.transport}/${reason})`,
      { throttleMs: reason === 'heartbeat' ? 5000 : 0, throttleKey: `profile-${this.transport}-${reason}` }
    )
  }

  async publishChatMedia(envelopes: Uint8Array[]): Promise<boolean> {
    if (!this.room || this.room.state !== ConnectionState.Connected || !envelopes.length) return false
    try {
      for (const envelope of envelopes) {
        const packet = encodeRfc4SceneBinaryPacket(DCM_SCENE_ID, envelope)
        const ok = await this.safePublishData(packet, true)
        if (!ok) return false
      }
      clientDebugLog.log(
        'comms',
        `DCM ChatMedia out → ${this.transport} chunks=${envelopes.length}`,
        { throttleMs: 0, throttleKey: `chat-media-out:${this.transport}` }
      )
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('comms', `DCM ChatMedia publish failed (${this.transport}): ${msg}`, {
        level: 'error'
      })
      return false
    }
  }

  async publishChat(text: string): Promise<boolean> {
    if (!this.room || this.room.state !== ConnectionState.Connected) {
      console.warn(`[chat] publishChat skip transport=${this.transport} room=${this.room?.state ?? 'null'}`)
      return false
    }
    const trimmed = text.trim()
    if (!trimmed) return false
    // Can this participant publish data? (token grant)
    const lp = this.room.localParticipant
    const canData =
      typeof (lp as { permissions?: { canPublishData?: boolean } }).permissions?.canPublishData ===
      'boolean'
        ? (lp as { permissions: { canPublishData: boolean } }).permissions.canPublishData
        : true
    if (!canData) {
      console.warn(`[chat] publishChat blocked — canPublishData=false transport=${this.transport}`)
      return false
    }
    // Godot Explorer requires OLE Automation dates (not unix seconds).
    const oleTs = oleTimestampNow()
    const packet = encodeRfc4ChatPacket(trimmed, oleTs)
    const ok = await this.safePublishData(packet, true)
    if (!ok) {
      console.error(`[chat] RFC4 publish failed (${this.transport}): room not ready`)
      return false
    }
    console.log(
      `[chat] RFC4 out → ${this.transport} room=${this.room?.name ?? '?'} len=${packet.byteLength} oleTs=${oleTs.toFixed(5)}`
    )
    clientDebugLog.log(
      'comms',
      `RFC4 Chat out → ${this.transport} len=${packet.byteLength} ole=${oleTs.toFixed(3)}`,
      { throttleMs: 0, throttleKey: `chat-out:${this.transport}` }
    )
    return true
  }

  async publishPlayerEmote(urn: string, incrementalId: number): Promise<boolean> {
    if (!this.room || this.room.state !== ConnectionState.Connected) return false
    const sessionElapsedSec = Math.max(0.001, (performance.now() - this.sessionStartedAt) / 1000)
    const packet = encodeRfc4PlayerEmotePacket(urn, incrementalId, sessionElapsedSec)
    const ok = await this.safePublishData(packet, true)
    if (!ok) return false
    clientDebugLog.log(
      'comms',
      `RFC4 PlayerEmote out → ${this.transport} ${urn.split(':').pop()} #${incrementalId}`,
      { throttleMs: 0, throttleKey: `emote-out:${this.transport}` }
    )
    return true
  }

  async publishData(
    packet: Uint8Array,
    opts?: { destinationIdentities?: string[]; reliable?: boolean }
  ): Promise<void> {
    await this.safePublishData(packet, opts?.reliable ?? false, opts?.destinationIdentities)
  }

  /** Reliable SCTP — required for large DAV VRM chunk streams (lossy drops under burst). */
  async publishReliableData(packet: Uint8Array): Promise<void> {
    await this.safePublishData(packet, true)
  }

  async publishTopicData(topic: string, packet: Uint8Array, reliable = true): Promise<void> {
    if (!this.room || this.room.state !== ConnectionState.Connected) return
    try {
      await this.room.localParticipant.publishData(packet, { reliable, topic })
    } catch {
      /* room tore down mid-publish — ignore PC manager closed */
    }
  }

  /**
   * Map wallet addresses (SDK peer targets) to LiveKit participant identities present
   * in the room. DCL gatekeeper tokens use the address as identity (case-insensitive).
   */
  resolveDestinationIdentities(addresses: readonly string[]): string[] {
    const wanted = new Set(
      addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0)
    )
    if (!wanted.size) return []
    const room = this.room
    if (!room || room.state !== ConnectionState.Connected) {
      return [...wanted]
    }
    const resolved: string[] = []
    const seen = new Set<string>()
    for (const p of room.remoteParticipants.values()) {
      const id = p.identity?.trim()
      if (!id) continue
      const key = id.toLowerCase()
      if (!wanted.has(key) || seen.has(key)) continue
      seen.add(key)
      // Prefer the identity string LiveKit already has (matches token).
      resolved.push(id)
    }
    // Targets not yet in remoteParticipants — still pass lowercased so late joins can receive
    // if LiveKit routes by identity string before join is reflected (best-effort).
    for (const addr of wanted) {
      if (!seen.has(addr)) resolved.push(addr)
    }
    return resolved
  }

  /**
   * publishData that never rejects. LiveKit throws UnexpectedConnectionState when the
   * room disconnects between isConnected() and the async publish (handoff / leave).
   */
  private async safePublishData(
    packet: Uint8Array,
    reliable: boolean,
    destinationIdentities?: readonly string[]
  ): Promise<boolean> {
    const room = this.room
    if (!room || room.state !== ConnectionState.Connected || !this.connected) return false
    try {
      const dest =
        destinationIdentities && destinationIdentities.length > 0
          ? [...destinationIdentities]
          : undefined
      await room.localParticipant.publishData(packet, {
        reliable,
        ...(dest ? { destinationIdentities: dest } : {})
      })
      return true
    } catch {
      return false
    }
  }

  disconnect(): void {
    this.connectGeneration++
    if (this.connected) {
      clientDebugLog.log('comms', `Disconnecting LiveKit (${this.transport})`, { level: 'warn' })
    }
    this.teardownRoom()
  }

  private teardownRoom(): void {
    this.connected = false
    this.pendingTransform = null
    this.lastSentTransform = null
    this.broadcastCount = 0
    this.outboundDebugLogs = 0
    const room = this.room
    this.room = null
    try {
      room?.disconnect()
    } catch {
      /* ignore */
    }
    // Only clear global registry if *this* session owned a live room.
    // Avoids empty World CommsService dispose wiping a transferred landing session.
    if (this.registerGlobalSession && room) {
      setLiveKitSession(null)
    }
  }
}


