import {
  ConnectionState,
  RemoteTrack,
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
import { encodeRfc4ChatPacket } from '../../social/dclRfc4Chat'
import {
  playerYawToMovementRotationDeg,
  sceneLocalToGenesis,
  type CommsSceneOrigin,
  type RealmBounds
} from './movementCompressed'
import { parseLiveKitConnectionString } from './livekitAdapter'
import { collectActiveVideoStreamsFromRoom, type ActiveVideoStream } from './livekitVideoStreams'
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

  getRemotePeerAddresses(): string[] {
    if (!this.room) return []
    const out: string[] = []
    for (const participant of this.room.remoteParticipants.values()) {
      const address = participant.identity?.trim().toLowerCase()
      if (address && address !== this.localAddress) out.push(address)
    }
    return out
  }

  hasRemoteParticipant(identity: string): boolean {
    if (!this.room) return false
    const key = identity.trim().toLowerCase()
    if (!key) return false
    return this.room.remoteParticipants.has(key)
  }

  getActiveVideoStreams(): ActiveVideoStream[] {
    return collectActiveVideoStreamsFromRoom(this.room)
  }

  /**
   * Attach the scene's active LiveKit video (screen share, then camera) to a VideoPlayer element.
   * Rebinds when tracks subscribe/unsubscribe.
   */
  bindCurrentVideoStream(video: HTMLVideoElement, onUpdate?: () => void): () => void {
    const room = this.room
    if (!room) return () => {}

    let attached: RemoteTrack | null = null

    const detach = (): void => {
      if (attached) {
        attached.detach(video)
        attached = null
      }
      video.srcObject = null
      video.removeAttribute('src')
    }

    const attachBest = (): void => {
      const next = pickCurrentVideoTrack(room)
      if (next === attached) return
      detach()
      if (!next) {
        onUpdate?.()
        return
      }
      next.attach(video)
      attached = next
      onUpdate?.()
    }

    const onTrackChange = (): void => attachBest()

    room.on(RoomEvent.TrackSubscribed, onTrackChange)
    room.on(RoomEvent.TrackUnsubscribed, onTrackChange)
    room.on(RoomEvent.TrackPublished, onTrackChange)
    room.on(RoomEvent.TrackUnpublished, onTrackChange)
    room.on(RoomEvent.ParticipantConnected, onTrackChange)
    room.on(RoomEvent.ParticipantDisconnected, onTrackChange)

    attachBest()

    return () => {
      room.off(RoomEvent.TrackSubscribed, onTrackChange)
      room.off(RoomEvent.TrackUnsubscribed, onTrackChange)
      room.off(RoomEvent.TrackPublished, onTrackChange)
      room.off(RoomEvent.TrackUnpublished, onTrackChange)
      room.off(RoomEvent.ParticipantConnected, onTrackChange)
      room.off(RoomEvent.ParticipantDisconnected, onTrackChange)
      detach()
    }
  }

  async connect(adapter: string): Promise<boolean> {
    this.disconnect()

    let url: string
    let token: string
    try {
      ;({ url, token } = parseLiveKitConnectionString(adapter))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('comms', `Invalid LiveKit adapter: ${msg}`, { level: 'error' })
      return false
    }

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
      setLiveKitSession({
        disconnect: async () => {
          room.disconnect()
        }
      })
    }

    try {
      await room.connect(url, token)
      this.connected = true
      if (this.lambdasUrl) {
        void room.localParticipant.setMetadata(JSON.stringify({ lambdasEndpoint: this.lambdasUrl }))
      }

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
      }

      clientDebugLog.log(
        'comms',
        `LiveKit connected (${this.transport}) · room=${room.name} · identity=${room.localParticipant.identity} · remotes=${room.remoteParticipants.size}`,
        { level: 'success' }
      )

      for (const participant of room.remoteParticipants.values()) {
        onParticipantConnected(participant)
      }

      this.sendProfileAnnouncement('connect')
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('comms', `LiveKit connect failed (${this.transport}): ${msg}`, { level: 'error' })
      this.disconnect()
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

    void this.room.localParticipant.publishData(movementPacket, { reliable: false })

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
    const participant = this.room.localParticipant
    const sendFullProfile = reason !== 'heartbeat' || this.broadcastCount <= 1

    if (sendFullProfile) {
      void participant.publishData(encodeRfc4ProfileResponsePacket(serializedProfile, baseUrl), {
        reliable: true
      })
    }

    void participant.publishData(encodeRfc4ProfileVersionPacket(version), { reliable: false })
    clientDebugLog.log(
      'comms',
      `RFC4 Profile v${version} sent (${this.transport}/${reason})`,
      { throttleMs: reason === 'heartbeat' ? 5000 : 0, throttleKey: `profile-${this.transport}-${reason}` }
    )
  }

  async publishChat(text: string): Promise<boolean> {
    if (!this.room || this.room.state !== ConnectionState.Connected) return false
    const trimmed = text.trim()
    if (!trimmed) return false
    const sessionElapsedSec = Math.max(0.001, (performance.now() - this.sessionStartedAt) / 1000)
    const packet = encodeRfc4ChatPacket(trimmed, sessionElapsedSec)
    try {
      await this.room.localParticipant.publishData(packet, { reliable: true })
      clientDebugLog.log(
        'comms',
        `RFC4 Chat out → ${this.transport} len=${packet.byteLength} elapsed=${sessionElapsedSec.toFixed(1)}s`,
        { throttleMs: 0, throttleKey: `chat-out:${this.transport}` }
      )
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('comms', `RFC4 Chat publish failed (${this.transport}): ${msg}`, { level: 'error' })
      return false
    }
  }

  async publishPlayerEmote(urn: string, incrementalId: number): Promise<boolean> {
    if (!this.room || this.room.state !== ConnectionState.Connected) return false
    const sessionElapsedSec = Math.max(0.001, (performance.now() - this.sessionStartedAt) / 1000)
    const packet = encodeRfc4PlayerEmotePacket(urn, incrementalId, sessionElapsedSec)
    try {
      await this.room.localParticipant.publishData(packet, { reliable: true })
      clientDebugLog.log(
        'comms',
        `RFC4 PlayerEmote out → ${this.transport} ${urn.split(':').pop()} #${incrementalId}`,
        { throttleMs: 0, throttleKey: `emote-out:${this.transport}` }
      )
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('comms', `RFC4 PlayerEmote publish failed (${this.transport}): ${msg}`, { level: 'error' })
      return false
    }
  }

  async publishData(packet: Uint8Array, destinationIdentities?: string[]): Promise<void> {
    if (!this.room || this.room.state !== ConnectionState.Connected) return
    const options: { reliable: false; destinationIdentities?: string[] } = { reliable: false }
    if (destinationIdentities?.length) {
      options.destinationIdentities = destinationIdentities
    }
    await this.room.localParticipant.publishData(packet, options)
  }

  async publishTopicData(topic: string, packet: Uint8Array, reliable = true): Promise<void> {
    if (!this.room || this.room.state !== ConnectionState.Connected) return
    await this.room.localParticipant.publishData(packet, { reliable, topic })
  }

  disconnect(): void {
    if (this.connected) {
      clientDebugLog.log('comms', `Disconnecting LiveKit (${this.transport})`, { level: 'warn' })
    }
    this.connected = false
    this.pendingTransform = null
    this.lastSentTransform = null
    this.broadcastCount = 0
    this.outboundDebugLogs = 0
    this.room?.disconnect()
    this.room = null
    if (this.registerGlobalSession) {
      setLiveKitSession(null)
    }
  }
}

function publicationVideoTrack(publication: RemoteTrackPublication): RemoteTrack | null {
  if (publication.kind !== Track.Kind.Video || !publication.isSubscribed || !publication.track) {
    return null
  }
  return publication.track as RemoteTrack
}

function pickFromParticipant(participant: Participant): {
  screenShare: RemoteTrack | null
  camera: RemoteTrack | null
} {
  let screenShare: RemoteTrack | null = null
  let camera: RemoteTrack | null = null
  for (const publication of participant.trackPublications.values()) {
    const track = publicationVideoTrack(publication as RemoteTrackPublication)
    if (!track) continue
    if (publication.source === Track.Source.ScreenShare) {
      screenShare = track
    } else if (publication.source === Track.Source.Camera && !camera) {
      camera = track
    }
  }
  return { screenShare, camera }
}

/** Prefer remote screen share, then remote camera, then local screen share. */
function pickCurrentVideoTrack(room: Room): RemoteTrack | null {
  let remoteScreen: RemoteTrack | null = null
  let remoteCamera: RemoteTrack | null = null

  for (const participant of room.remoteParticipants.values()) {
    const picked = pickFromParticipant(participant)
    if (picked.screenShare) remoteScreen = picked.screenShare
    if (!remoteCamera && picked.camera) remoteCamera = picked.camera
  }

  if (remoteScreen) return remoteScreen
  if (remoteCamera) return remoteCamera

  const local = pickFromParticipant(room.localParticipant)
  return local.screenShare ?? local.camera
}
