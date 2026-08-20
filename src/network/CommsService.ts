import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { ConnectionState, type Room } from 'livekit-client'
import { needsCommsPeerProfile, type CommsProfileEntity } from '../avatar/peerApi'
import { encodeRfc4ProfileRequestPacket } from './comms/dclRfc4Comms'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { resolveCommsSceneId } from './catalyst/CatalystClient'
import { normalizePointer, isParcelPointer } from './catalyst/pointer'
import type { RealmEndpoints } from '../dcl/content/types'
import { checkGatekeeperSceneAccess } from './sceneAccess/checkGatekeeperSceneAccess'
import { sceneBanDebug } from './sceneAccess/sceneBanDebug'
import {
  gatekeeperParcelForComms,
  gatekeeperRealmNameForComms,
  isAddressMetadataBlacklisted
} from './sceneAccess/sceneAccessCommon'
import {
  fetchSceneParticipants,
  GATEKEEPER_LOCAL_URL,
  getSceneAdapter,
  LOCAL_PREVIEW_REALM_NAME
} from './gatekeeper/GatekeeperClient'
import {
  acquireWalletSessionLock,
  refreshWalletSessionLock,
  releaseWalletSessionLock
} from './walletSessionGuard'
import { AdapterManager } from './comms/AdapterManager'
import { ArchipelagoClient } from './comms/ArchipelagoClient'
import { CommsInboundQueue, CommsWireMessageType } from './comms/CommsInboundQueue'
import {
  isReliableCommsWireType,
  isReqCrdtStateType,
  logSyncDirectedFallback,
  logSyncDirectedPublish,
  logSyncOversizedSkip,
  unwrapCraftedCommsMessage
} from './comms/syncDebug'

/** Auth-server SDK peer id — only this identity handles client CUSTOM_EVENT on server. */
const AUTH_SERVER_PEER_IDENTITY = 'authoritative-server'
import {
  isOversizedCraftedChunk,
  isOversizedPublishPacket,
  LIVEKIT_MAX_CRAFTED_BYTES,
  LIVEKIT_MAX_PUBLISH_BYTES
} from './comms/livekitLimits'
import { CommsTopicService } from './comms/CommsTopicService'
import { LiveKitCommsSession } from './comms/LiveKitCommsSession'
import {
  clearCastVideoHost,
  isNonPlayerLiveKitIdentity,
  reattachFirstRemoteVideoToHost
} from './comms/livekitVideoStreams'
import {
  parseCommsSceneOrigin,
  realmBoundsFromParcels,
  sceneLocalToGenesis,
  type RealmBounds
} from './comms/movementCompressed'
import { encodeRfc4SceneBinaryPacket, Rfc4Router } from './comms/Rfc4Router'
import { DAV_SCENE_ID } from '../avatar/vrm/dclClientAvatar'
import { DPET_SCENE_ID } from '../pets/dclClientPet'
import { Rfc5RoomClient } from './comms/Rfc5RoomClient'
import { isLiveKitAdapter, isUnusableLiveKitAdapter } from './comms/livekitAdapter'
import type { ActiveVideoStream } from './comms/livekitVideoStreams'
import { TransportType } from './comms/Transport'
import {
  classifyRfc5PeerUpdateBody,
  decodeRfc5TopicPayload,
  decodeTransformPayload,
  encodeRfc5TopicPayload,
  encodeTransformPayload,
  isLocalPreviewComms,
  type AvatarTransformPayload,
  type CommsRealmInfo
} from './comms/types'

const BROADCAST_INTERVAL_MS = 100

export type SceneCommsFailureReason =
  | 'duplicate_wallet'
  | 'no_identity'
  | 'scene_id'
  | 'scene_ban'
  | 'gatekeeper'
  | 'livekit'
  /** World /about (or /status) has no LiveKit adapter — solo play is fine. */
  | 'comms_disabled'

export type SceneCommsConnectResult = { ok: true } | { ok: false; reason: SceneCommsFailureReason }

export type SceneCommsTarget = {
  pointer: string
  baseParcel: string
  sceneId: string
  realmName: string
  contentUrl: string
  parcels?: string[]
  isWorld?: boolean
  sceneTitle?: string
  /** Catalyst `metadata.policy.blacklist` — checked again before comms connect. */
  metadataBlacklist?: string[]
  /**
   * From world `/about` (+ `/status`). When false, skip LiveKit/gatekeeper join —
   * content loads solo without chat/peers.
   */
  commsEnabled?: boolean
  /** Realm about adapter hint (signed-login / livekit / archipelago). */
  commsAdapterHint?: string
}

export type CommsPeerHandlers = {
  onPeerJoin: (address: string) => void
  onPeerLeave: (address: string) => void
  onPeerTransform: (address: string, payload: AvatarTransformPayload) => void
  onPeerProfile?: (address: string, serializedProfile: string, baseUrl: string) => void
  onPeerEmote?: (address: string, urn: string, incrementalId: number) => void
}

export type SceneBinaryHandler = (sender: string, data: Uint8Array) => void

export type SceneChatHandler = (payload: {
  senderAddress: string
  text: string
  time: number
}) => void

export type SceneChatMediaHandler = (payload: {
  senderAddress: string
  data: Uint8Array
}) => void

/** Bevy `CommsPlugin` — archipelago + signed-login/world + gatekeeper scene room + RFC4 router. */
export class CommsService {
  private readonly islandLiveKit = new LiveKitCommsSession(TransportType.Island, false)
  private readonly sceneLiveKit = new LiveKitCommsSession(TransportType.SceneRoom, true)
  private readonly worldLiveKit = new LiveKitCommsSession(TransportType.World, false)
  private readonly archipelago = new ArchipelagoClient()
  private readonly rfc5 = new Rfc5RoomClient()
  private readonly router = new Rfc4Router()
  private readonly topicService = new CommsTopicService()
  private readonly inboundQueue = new CommsInboundQueue()
  private adapterManager: AdapterManager

  private identity: AuthIdentity | null = null
  private localAddress: string | null = null
  private transport: 'none' | 'livekit' | 'rfc5' = 'none'
  private realmCommsHint = ''
  private contentUrl = ''
  private sceneId = ''
  private islandConnected = false
  private worldConnected = false
  private walletSessionLockHeld = false
  private handlers: CommsPeerHandlers | null = null
  private sceneBinaryHandler: SceneBinaryHandler | null = null
  private chatHandler: SceneChatHandler | null = null
  private chatMediaHandler: SceneChatMediaHandler | null = null
  private avatarVrmHandler: ((sender: string, data: Uint8Array) => void) | null = null
  private petHandler: ((sender: string, data: Uint8Array) => void) | null = null
  private topicMessageHandler: ((topic: string, sender: string, payload: Uint8Array) => void) | null = null
  /** Extra topic listeners (live tools, etc.) — do not replace the primary scene `comms` handler. */
  private readonly topicListeners = new Set<
    (topic: string, sender: string, payload: Uint8Array) => void
  >()
  private lastBroadcast = 0
  private pendingTransform: AvatarTransformPayload | null = null
  private sceneTarget: SceneCommsTarget | null = null
  private realmBounds: RealmBounds | null = null
  private sceneOrigin: ReturnType<typeof parseCommsSceneOrigin> = null
  private sceneOriginMeters: { x: number; z: number } = { x: 0, z: 0 }
  private emoteIncrementalId = 0
  private readonly peerTransports = new Map<string, Set<TransportType>>()
  private realm: CommsRealmInfo
  /** Serialize scene-room joins so cast retry + route switch cannot abort each other. */
  private sceneRoomConnectChain: Promise<unknown> = Promise.resolve()
  private sceneRoomConnectInFlight = false
  /** Throttle RFC4 ProfileRequest per peer — version heartbeats used to flood lossy DC. */
  private readonly profileRequestAt = new Map<string, number>()
  private static readonly PROFILE_REQUEST_COOLDOWN_MS = 5_000

  constructor(initialRealm?: Partial<CommsRealmInfo>) {
    this.realm = {
      realmName: initialRealm?.realmName ?? 'main',
      domain: initialRealm?.domain ?? 'decentraland.org',
      baseUrl: initialRealm?.baseUrl ?? 'https://peer.decentraland.org',
      networkId: initialRealm?.networkId ?? 1,
      commsAdapter: initialRealm?.commsAdapter ?? '',
      isPreview: initialRealm?.isPreview ?? false,
      room: initialRealm?.room,
      isConnectedSceneRoom: false
    }

    this.adapterManager = new AdapterManager(this.identity, this.contentUrl, {
      connectArchipelago: (url) => this.connectArchipelago(url),
      connectLiveKit: (adapter, label) => this.connectLiveKitLabel(adapter, label),
      connectWsRoom: (url) => this.connectWsRoom(url)
    })

    this.archipelago.setIslandHandler((event) => {
      void this.onIslandChanged(event.connStr)
    })

    this.router.setHandlers({
      onPeerTransform: (address, x, y, z, yaw, transport, velocity, locomotion) => {
        void transport
        this.handlers?.onPeerTransform(address, {
          type: 'avatar-transform',
          x,
          y,
          z,
          yaw,
          vx: velocity?.x,
          vy: velocity?.y,
          vz: velocity?.z,
          isGrounded: locomotion?.isGrounded,
          isJumping: locomotion?.isJumping,
          jumpCount: locomotion?.jumpCount,
          glideState: locomotion?.glideState
        })
      },
      onProfileRequest: (address) => {
        if (address !== this.localAddress) return
        // Reply only on the primary avatar/chat room — not every transport (spam + disconnect races).
        const primary = this.primaryAvatarSession()
        if (primary) primary.sendProfileAnnouncement('profile-request')
      },
      onPeerProfileVersion: (address, profileVersion) => {
        if (address === this.localAddress) return
        if (!needsCommsPeerProfile(address, profileVersion)) return
        this.requestRemotePeerProfile(address, profileVersion)
      },
      onPeerProfile: (address, serializedProfile, baseUrl) => {
        if (address === this.localAddress) return
        void baseUrl
        this.handlers?.onPeerProfile?.(address, serializedProfile, baseUrl)
      },
      onPeerEmote: (address, urn, incrementalId) => {
        if (address === this.localAddress) return
        this.handlers?.onPeerEmote?.(address, urn, incrementalId)
      },
      onSceneBinary: (sceneId, sender, data) => {
        if (this.sceneId && sceneId !== this.sceneId) return
        this.inboundQueue.pushSceneBinary(sender, data)
        this.sceneBinaryHandler?.(sender, data)
      },
      onPeerChat: (address, text, time, transport) => {
        if (!this.shouldAcceptChatTransport(transport)) return
        this.chatHandler?.({ senderAddress: address, text, time })
      },
      onPeerChatMedia: (address, data, transport) => {
        if (!this.shouldAcceptChatTransport(transport)) return
        this.chatMediaHandler?.({ senderAddress: address, data })
      },
      onPeerAvatarVrm: (address, data, _transport) => {
        // DAV is not chat — accept from any LiveKit room (world / scene / island).
        // Worlds previously dropped SceneRoom packets via shouldAcceptChatTransport, so
        // late joiners never saw peer custom VRM when announce landed on the Cast room.
        this.avatarVrmHandler?.(address, data)
      },
      onPeerPet: (address, data, _transport) => {
        this.petHandler?.(address, data)
      }
    })

    for (const session of [this.islandLiveKit, this.sceneLiveKit, this.worldLiveKit]) {
      session.setPacketHandler((transport, address, data) => {
        this.router.handlePacket(transport, address, data)
      })
      session.setTopicHandler((topic, address, data) => {
        this.dispatchTopic(topic, address, data)
      })
      session.setPeerHandlers({
        onPeerJoin: (address, transport) => this.trackPeerJoin(address, transport),
        onPeerLeave: (address, transport) => this.trackPeerLeave(address, transport)
      })
    }
  }

  setIdentity(address: string | undefined, identity: AuthIdentity | null): void {
    this.localAddress = address?.toLowerCase() ?? null
    this.identity = identity
    this.adapterManager.setIdentity(identity)
    for (const session of [this.islandLiveKit, this.sceneLiveKit, this.worldLiveKit]) {
      session.setLocalAddress(address)
    }
  }

  setCommsProfile(profile: CommsProfileEntity | null): void {
    for (const session of [this.islandLiveKit, this.sceneLiveKit, this.worldLiveKit]) {
      session.setCommsProfile(profile)
    }
  }

  /** Apply display name to all connected LiveKit rooms (Explorer voice-bar identity). */
  applyLocalDisplayName(displayName: string | null | undefined): void {
    const dn = displayName?.trim() || null
    for (const session of [this.islandLiveKit, this.sceneLiveKit, this.worldLiveKit]) {
      if (session.isConnected()) session.applyLocalIdentityToRoom(dn)
    }
  }

  /**
   * Re-broadcast profile on every movement room (scene + island on parcels).
   * Explorer peers read RFC4 Profile on the archipelago island.
   */
  announceProfile(reason: 'connect' | 'heartbeat' | 'profile-request' = 'connect'): void {
    for (const session of this.movementLiveKitSessions()) {
      session.sendProfileAnnouncement(reason)
    }
  }

  setLambdasUrl(url: string): void {
    for (const session of [this.islandLiveKit, this.sceneLiveKit, this.worldLiveKit]) {
      session.setLambdasUrl(url)
    }
  }

  setHandlers(handlers: CommsPeerHandlers | null): void {
    this.handlers = handlers
  }

  /**
   * After landing → play handoff: re-fire onPeerJoin for everyone already in the room
   * so RemoteAvatarManager learns about peers without a reconnect.
   */
  notifyHandlersOfCurrentPeers(): void {
    if (!this.handlers) return
    for (const address of this.peerTransports.keys()) {
      this.handlers.onPeerJoin(address)
    }
  }

  /** Any LiveKit room still up (used to decide handoff vs fresh connect). */
  hasLiveKitSession(): boolean {
    return this.isLiveKitConnected()
  }

  /**
   * After jump-in: drop LiveKit transports not needed for this place.
   * Worlds: prune island. Parcels: prune world; prune island when scene media is up.
   */
  pruneUnusedLiveKitForTarget(target: { isWorld: boolean }): void {
    if (target.isWorld) {
      if (this.islandLiveKit.isConnected() || this.islandConnected) {
        this.islandLiveKit.disconnect()
        this.islandConnected = false
        this.clearPeerTransport(TransportType.Island)
        clientDebugLog.log('comms', 'Pruned island LiveKit (world play — not used)', {
          level: 'info',
          alsoConsole: true
        })
      }
      return
    }
    // Parcel: world room is unused once in scene-primary mode.
    if (this.worldLiveKit.isConnected() || this.worldConnected) {
      this.worldLiveKit.disconnect()
      this.worldConnected = false
      this.clearPeerTransport(TransportType.World)
      clientDebugLog.log('comms', 'Pruned world LiveKit (parcel play — not used)', {
        level: 'info',
        alsoConsole: true
      })
    }
  }

  setSceneBinaryHandler(handler: SceneBinaryHandler | null): void {
    this.sceneBinaryHandler = handler
  }

  setChatHandler(handler: SceneChatHandler | null): void {
    this.chatHandler = handler
  }

  setChatMediaHandler(handler: SceneChatMediaHandler | null): void {
    this.chatMediaHandler = handler
  }

  setAvatarVrmHandler(handler: ((sender: string, data: Uint8Array) => void) | null): void {
    this.avatarVrmHandler = handler
  }

  setPetHandler(handler: ((sender: string, data: Uint8Array) => void) | null): void {
    this.petHandler = handler
  }

  /**
   * DAV v1 — custom VRM P2P on RFC4 Scene `dcl.client.avatar`.
   * @param roomMode `broadcast` = all LiveKit rooms (announce/clear/want only).
   *   `primary` = single chat room (fetch request + multi‑MB chunk streams).
   *   Fetch must never dual-publish — concurrent serves race FetchEnd and drop chunks.
   */
  async sendSceneAvatarVrm(
    envelopes: Uint8Array[],
    roomMode: 'broadcast' | 'primary' = 'primary'
  ): Promise<boolean> {
    return this.sendSceneChannel(DAV_SCENE_ID, envelopes, roomMode, 'DAV')
  }

  /**
   * DPET v1 — client pets on RFC4 Scene `dcl.client.pet` (not scene-worker CRDT).
   * Same roomMode rules as DAV.
   */
  async sendScenePet(
    envelopes: Uint8Array[],
    roomMode: 'broadcast' | 'primary' = 'primary'
  ): Promise<boolean> {
    return this.sendSceneChannel(DPET_SCENE_ID, envelopes, roomMode, 'DPET')
  }

  private async sendSceneChannel(
    sceneId: string,
    envelopes: Uint8Array[],
    roomMode: 'broadcast' | 'primary',
    label: string
  ): Promise<boolean> {
    const sessions =
      roomMode === 'broadcast' ? this.liveKitDavSessions() : this.liveKitChatSessions()
    if (!sessions.length || !envelopes.length) return false
    // Large streams: pace harder so reliable DC doesn't drop trailing packets.
    const large = envelopes.length > 32
    const paceEvery = large ? 4 : envelopes.length > 8 ? 8 : 0
    const paceMs = large ? 12 : envelopes.length > 64 ? 8 : 2
    let sent = false
    for (const session of sessions) {
      try {
        for (let i = 0; i < envelopes.length; i++) {
          const packet = encodeRfc4SceneBinaryPacket(sceneId, envelopes[i]!)
          await session.publishReliableData(packet)
          if (paceEvery > 0 && i > 0 && i % paceEvery === 0) {
            await new Promise((resolve) => setTimeout(resolve, paceMs))
          }
        }
        sent = true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        clientDebugLog.log('comms', `${label} publish failed: ${msg}`, { level: 'error' })
      }
    }
    return sent
  }

  setTopicMessageHandler(
    handler: ((topic: string, sender: string, payload: Uint8Array) => void) | null
  ): void {
    this.topicMessageHandler = handler
  }

  /**
   * Subscribe to LiveKit data topics (scene room). Used by live tools, etc.
   * @returns unsubscribe
   */
  addTopicListener(
    listener: (topic: string, sender: string, payload: Uint8Array) => void
  ): () => void {
    this.topicListeners.add(listener)
    return () => {
      this.topicListeners.delete(listener)
    }
  }

  private dispatchTopic(topic: string, address: string, data: Uint8Array): void {
    this.topicService.enqueue(topic, address, data)
    this.topicMessageHandler?.(topic, address, data)
    for (const listener of this.topicListeners) {
      try {
        listener(topic, address, data)
      } catch {
        /* ignore listener errors */
      }
    }
  }

  /**
   * Publish raw bytes on a LiveKit topic across chat-capable rooms.
   * Must use a non-empty topic so packets never hit RFC4 Chat / scene chat UI.
   */
  async publishRawTopicData(topic: string, packet: Uint8Array, reliable = true): Promise<boolean> {
    const t = topic.trim()
    if (!t) return false
    const body = encodeRfc5TopicPayload(t, packet)
    // Scene LiveKit is the RFC4 Packet bus (Movement / Profile / scene-binary).
    // Hammurabi Packet.decode()s every data payload — JSON topic envelopes log
    // `index out of range` and can starve movement (player Transform stuck at y=0 → below deck).
    const sessions = this.liveKitBroadcastSessions().filter((s) => s !== this.sceneLiveKit)
    let sent = false
    if (sessions.length) {
      const bits: string[] = []
      for (const session of sessions) {
        const remotes = session.getRemotePeerAddresses().length
        const named = await session.publishTopicData(t, body, reliable)
        const bare = await session.publishBareData(body, reliable)
        if (named || bare) sent = true
        bits.push(`${session.getRoomName() || 'room'} remotes=${remotes} named=${named} bare=${bare}`)
      }
      clientDebugLog.log('comms', `topic-out ${t} · ${bits.join(' · ') || 'no rooms'}`, {
        alsoConsole: true
      })
    }
    if (this.rfc5.isConnected()) {
      this.rfc5.send(body, !reliable)
      sent = true
    }
    return sent
  }

  /**
   * P2P trade over world / scene LiveKit (not private-messages).
   * Critical for Worlds: both players share world-prd-* rooms; PM room may not.
   * Dual path: directed when peer identity is in room + topic broadcast (filter by msg.to).
   */
  async publishTradePacket(packet: Uint8Array, peerAddress?: string): Promise<boolean> {
    const sessions = this.liveKitChatSessions()
    if (!sessions.length) return false
    const topic = 'd3js-trade'
    const peer = (peerAddress || '').trim().toLowerCase()
    let sent = false
    for (const session of sessions) {
      if (peer) {
        const id = session.getExactRemoteIdentity(peer)
        if (id) {
          if (await session.publishTopicDataTo(topic, packet, [id], true)) sent = true
        }
      }
      if (await session.publishTopicData(topic, packet, true)) sent = true
    }
    return sent
  }

  async sendSceneChat(text: string): Promise<boolean> {
    const sessions = this.liveKitChatSessions()
    if (!sessions.length) {
      console.warn('[chat] send skipped — no LiveKit session connected')
      clientDebugLog.log('comms', 'Chat send skipped — no LiveKit session connected', { level: 'warn' })
      return false
    }
    let sent = false
    const rooms: string[] = []
    for (const session of sessions) {
      if (await session.publishChat(text)) {
        sent = true
        rooms.push((session.getRoomName() || 'room').slice(0, 48))
      }
    }
    console.log(
      `[chat] publish ${sent ? 'ok' : 'FAIL'} rooms=${sessions.length} delivered=[${rooms.join(', ') || 'none'}] text=${text.slice(0, 40)}`
    )
    return sent
  }

  /** DCM v1 — scene chat images on RFC4 Scene `dcl.chat.media` (chunked when needed). */
  async sendSceneChatMedia(envelopes: Uint8Array[]): Promise<boolean> {
    const sessions = this.liveKitChatSessions()
    if (!sessions.length || !envelopes.length) {
      clientDebugLog.log('comms', 'Chat media send skipped — no LiveKit session connected', {
        level: 'warn'
      })
      return false
    }
    let sent = false
    for (const session of sessions) {
      if (await session.publishChatMedia(envelopes)) sent = true
    }
    return sent
  }

  /** Fan-out RFC4 PlayerEmote to scene / world / island LiveKit rooms (same paths as chat). */
  async broadcastEmote(urn: string): Promise<boolean> {
    const sessions = this.liveKitChatSessions()
    if (!sessions.length) return false
    const incrementalId = ++this.emoteIncrementalId
    let sent = false
    for (const session of sessions) {
      if (await session.publishPlayerEmote(urn, incrementalId)) sent = true
    }
    return sent
  }

  applyRealmAbout(about: RealmEndpoints, commsPointer: string): void {
    this.realmCommsHint = about.commsAdapterHint ?? ''
    this.contentUrl = about.contentUrl.replace(/\/$/, '')
    this.adapterManager.setContentUrl(this.contentUrl)
    this.realm = {
      realmName: about.realmName,
      domain: 'decentraland.org',
      baseUrl: about.contentUrl,
      networkId: about.networkId,
      commsAdapter: this.realmCommsHint,
      isPreview: false,
      room: normalizePointer(commsPointer),
      isConnectedSceneRoom: this.realm.isConnectedSceneRoom
    }
  }

  getRealmInfo(): CommsRealmInfo {
    // SDK `@dcl/sdk/network` isStateSyncronized / isRoomReady gates on RealmInfo.isConnectedSceneRoom.
    // Auth-server scenes (pixelwars paint, Flagtag combat) fire REQ_CRDT_STATE on this edge and only
    // become room-ready after RES from peer identity `authoritative-server`.
    //
    // Must track the **scene** LiveKit room — not the world chat room. ORing worldLiveKit made
    // isConnectedSceneRoom true as soon as world connected; the SDK edge fired once, REQ went out
    // before (or on) the wrong session, and when the Cast/scene room later connected there was no
    // false→true edge to re-pulse. joinRoster then stayed queued forever → no teamAssigned →
    // paint never writes Material (crdt-outbound bytes=0 while walking).
    const sceneRoom =
      this.transport === 'livekit' ? this.sceneLiveKit.isConnected() : this.rfc5.isConnected()
    const preview =
      this.realm.isPreview === true ||
      this.transport === 'rfc5' ||
      isLocalPreviewComms(this.realm.commsAdapter, this.realm.realmName)
    return {
      ...this.realm,
      room: this.sceneTarget?.pointer ?? this.realm.room,
      isPreview: preview,
      isConnectedSceneRoom: sceneRoom
    }
  }

  /** Bevy `process_realm_change` — archipelago (Genesis) or signed-login world room. */
  async connectRealmComms(contentUrl?: string): Promise<boolean> {
    if (!this.localAddress || !this.identity) return false
    if (contentUrl) {
      this.contentUrl = contentUrl.replace(/\/$/, '')
      this.adapterManager.setContentUrl(this.contentUrl)
    }
    const hint = this.realmCommsHint || this.realm.commsAdapter
    if (!hint) {
      clientDebugLog.log(
        'network',
        'Realm comms adapter missing — Genesis island peers will not connect (no archipelago)',
        { level: 'error', alsoConsole: true }
      )
      return false
    }

    const parsed = this.adapterManager.parse(hint)
    clientDebugLog.log(
      'network',
      `Realm comms adapter · ${parsed?.kind ?? 'unknown'} · ${hint.slice(0, 80)}`,
      { level: 'info', alsoConsole: true }
    )

    // Preview mini-comms is not Genesis archipelago. Re-connecting ws-room calls
    // disconnectAllTransports and kills the hammurabi scene LiveKit (AUTH_RES / CUSTOM_EVENT).
    if (parsed?.kind === 'ws-room') {
      return this.rfc5.isConnected() || this.sceneLiveKit.isConnected()
    }

    const connected = await this.adapterManager.connect(hint, 'world')
    this.worldConnected = this.worldLiveKit.isConnected()
    if (parsed?.kind === 'archipelago') {
      clientDebugLog.log(
        'network',
        connected
          ? 'Archipelago control plane connecting (island LiveKit follows islandChanged)…'
          : 'Archipelago connect failed',
        { level: connected ? 'success' : 'error', alsoConsole: true }
      )
    }
    return connected
  }

  /** Focus walk: join under-feet scene LiveKit; keep host origin / movement frame. */
  async connectFocusSceneRoom(target: SceneCommsTarget): Promise<SceneCommsConnectResult> {
    const run = this.sceneRoomConnectChain.then(() =>
      this.connectSceneRoomExclusive(target, { preserveHostOrigin: true })
    )
    this.sceneRoomConnectChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async connectSceneRoom(target: SceneCommsTarget): Promise<SceneCommsConnectResult> {
    const run = this.sceneRoomConnectChain.then(() => this.connectSceneRoomExclusive(target))
    this.sceneRoomConnectChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async connectSceneRoomExclusive(
    target: SceneCommsTarget,
    opts?: { preserveHostOrigin?: boolean }
  ): Promise<SceneCommsConnectResult> {
    this.sceneRoomConnectInFlight = true
    // Re-arm hold for each scene join — early AUTH_RES must not race async main/syncEntity.
    this.setSceneBinaryIngressHold(true)
    try {
      return await this.connectSceneRoomImpl(target, opts)
    } finally {
      this.sceneRoomConnectInFlight = false
    }
  }

  /**
   * Update scene origin/bounds/target without touching LiveKit sockets.
   * Used after landing → play handoff so movement encoding matches the World scene.
   */
  getSceneTarget(): SceneCommsTarget | null {
    return this.sceneTarget
  }

  /**
   * Reconnect scene LiveKit iff FocusOwner deployment changed.
   * Compare sceneId + pointer only — never commsAdapterHint (realm /about, identical on Genesis).
   */
  sceneRoomIdentityChanged(
    prev: Pick<SceneCommsTarget, 'sceneId' | 'pointer'> | null | undefined,
    next: Pick<SceneCommsTarget, 'sceneId' | 'pointer'>
  ): boolean {
    if (!prev) return true
    const prevSceneId = prev.sceneId?.trim() ?? ''
    const nextSceneId = next.sceneId?.trim() ?? ''
    const prevPointer = prev.pointer?.trim() ?? ''
    const nextPointer = next.pointer?.trim() ?? ''
    return prevSceneId !== nextSceneId || prevPointer !== nextPointer
  }

  /**
   * Swap Focus scene-room identity (sceneId + pointer) without moving the host
   * origin / PhysX frame. Walk Focus grant must not rebase Genesis.
   */
  bindFocusRoomIdentity(target: SceneCommsTarget): void {
    const host = this.sceneTarget
    this.sceneId = target.sceneId.trim()
    this.realm.room = normalizePointer(target.pointer)
    this.sceneTarget = {
      ...(host ?? target),
      sceneId: target.sceneId,
      pointer: target.pointer,
      sceneTitle: target.sceneTitle ?? host?.sceneTitle,
      commsEnabled: target.commsEnabled,
      commsAdapterHint: target.commsAdapterHint ?? host?.commsAdapterHint,
      metadataBlacklist: target.metadataBlacklist ?? host?.metadataBlacklist
    }
    this.realm = {
      ...this.realm,
      realmName: gatekeeperRealmNameForComms(target),
      isConnectedSceneRoom: this.isLiveKitConnected()
    }
  }

  bindSceneTarget(target: SceneCommsTarget): void {
    this.sceneTarget = target
    this.sceneId = target.sceneId.trim()
    this.realm.room = normalizePointer(target.pointer)
    this.contentUrl = target.contentUrl.replace(/\/$/, '')
    this.adapterManager.setContentUrl(this.contentUrl)
    this.realmBounds = realmBoundsFromParcels(target.parcels ?? [target.baseParcel])
    this.sceneOrigin = parseCommsSceneOrigin(target.baseParcel)
    const [bxStr, bzStr] = target.baseParcel.split(',')
    this.sceneOriginMeters = {
      x: (Number.parseInt(bxStr?.trim() ?? '0', 10) || 0) * 16,
      z: (Number.parseInt(bzStr?.trim() ?? '0', 10) || 0) * 16
    }
    this.router.setRealmBounds(this.realmBounds)
    this.router.setSceneOrigin(target.baseParcel)
    this.syncRealmBoundsToSessions()
    this.realm = {
      ...this.realm,
      realmName: gatekeeperRealmNameForComms(target),
      baseUrl: target.contentUrl,
      isPreview: false,
      isConnectedSceneRoom: this.isLiveKitConnected()
    }
    // Island assignment must track the landing parcel — not a leftover (0,0,0) friends seed.
    this.seedArchipelagoPresenceFromScene('bind-target')
  }

  /**
   * Genesis meters for archipelago seed: base parcel center (8,0,8 scene-local).
   * Avoids clustering every 2D landing onto Genesis Plaza's island.
   */
  private presenceSeedGenesisMeters(): { x: number; y: number; z: number } | null {
    if (!this.sceneOrigin) return null
    return sceneLocalToGenesis(8, 0, 8, this.sceneOrigin)
  }

  /** Force archipelago heartbeat at the bound scene (overwrites 0,0,0 shell seed). */
  seedArchipelagoPresenceFromScene(reason = 'scene'): void {
    if (this.isWorldComms()) return
    const seed = this.presenceSeedGenesisMeters()
    if (!seed) return
    this.archipelago.ensurePresenceSeed(seed)
    void reason
  }

  private async connectSceneRoomImpl(
    target: SceneCommsTarget,
    opts?: { preserveHostOrigin?: boolean }
  ): Promise<SceneCommsConnectResult> {
    if (opts?.preserveHostOrigin && this.sceneTarget) {
      this.bindFocusRoomIdentity(target)
      clientDebugLog.log(
        'comms',
        `Focus room (origin held) · scene=${target.sceneId.slice(0, 12)}… pointer=${target.pointer} hostBase=${this.sceneTarget.baseParcel}`
      )
    } else {
      this.bindSceneTarget(target)
      clientDebugLog.log(
        'comms',
        `Scene origin: baseParcel=${target.baseParcel} → world offset (${this.sceneOriginMeters.x}, ${this.sceneOriginMeters.z})m | bounds=(${this.realmBounds?.minX},${this.realmBounds?.minY})→(${this.realmBounds?.maxX},${this.realmBounds?.maxY})`
      )
    }

    if (!this.localAddress || !this.identity) {
      clientDebugLog.log('comms', 'Wallet login required for production comms', { level: 'warn' })
      return { ok: false, reason: 'no_identity' }
    }

    const isWorld = target.isWorld ?? !isParcelPointer(normalizePointer(target.pointer))
    const adapterHint =
      target.commsAdapterHint?.trim() || this.realmCommsHint || this.realm.commsAdapter || ''
    const parsedHint = this.adapterManager.parse(adapterHint)
    // sdk-commands preview: `/about` advertises `ws-room:…/mini-comms/room-1`.
    // That RFC-5 room is two-tab avatars only. Hammurabi (`@dcl/sdk@auth-server`)
    // stripped ws-room and joins LiveKit via comms-gatekeeper-local — same room
    // Explorer uses for CUSTOM_EVENT / AUTH_RES. Join both.
    if (parsedHint?.kind === 'ws-room') {
      if (!acquireWalletSessionLock(this.localAddress)) {
        clientDebugLog.log('comms', 'Blocked second client — wallet already active in another tab', {
          level: 'error'
        })
        return { ok: false, reason: 'duplicate_wallet' }
      }
      this.walletSessionLockHeld = true
      const ok = this.connectWsRoom(parsedHint.url, target.pointer)
      if (!ok) {
        this.releaseWalletSessionIfHeld()
        clientDebugLog.log('comms', `Preview mini-comms connect failed · ${parsedHint.url}`, {
          level: 'warn',
          alsoConsole: true
        })
        return { ok: false, reason: 'comms_disabled' }
      }
      clientDebugLog.log('comms', `Preview mini-comms · ${parsedHint.url}`, {
        level: 'success',
        alsoConsole: true
      })
      await this.joinLocalPreviewAuthLiveKit(target)
      return { ok: true }
    }
    // World server owner can omit LiveKit — still load scene content solo (no chat/peers).
    if (isWorld && (target.commsEnabled === false || !adapterHint)) {
      clientDebugLog.log(
        'comms',
        `World comms disabled by server (no LiveKit adapter) · ${target.pointer} — solo play, chat unavailable`,
        { level: 'warn', alsoConsole: true }
      )
      return { ok: false, reason: 'comms_disabled' }
    }

    if (!acquireWalletSessionLock(this.localAddress)) {
      clientDebugLog.log('comms', 'Blocked second client — wallet already active in another tab', {
        level: 'error'
      })
      return { ok: false, reason: 'duplicate_wallet' }
    }

    const realmName = gatekeeperRealmNameForComms(target)

    // This tab now owns the wallet session lock. Do **not** block on gatekeeper
    // scene-participants: landing → play handoff leaves a stale roster entry for
    // several seconds (same wallet). Another browser/tab is already blocked by
    // acquireWalletSessionLock + LiveKit single-identity. Checking roster here
    // caused permanent remotePeers:0 after Jump In from scene landing.
    this.walletSessionLockHeld = true

    let sceneId = this.sceneId
    if (!sceneId) {
      sceneId = (await resolveCommsSceneId(target.pointer, target.contentUrl, null)) ?? ''
      this.sceneId = sceneId
    }
    if (!sceneId) {
      this.releaseWalletSessionIfHeld()
      clientDebugLog.log('comms', `Could not resolve scene id for ${target.pointer}`, { level: 'error' })
      return { ok: false, reason: 'scene_id' }
    }

    if (sceneBanDebug.isSimulatingBan()) {
      this.releaseWalletSessionIfHeld()
      clientDebugLog.log('comms', `Scene access denied · simulated ban · ${target.pointer}`, {
        level: 'error'
      })
      return { ok: false, reason: 'scene_ban' }
    }

    if (isAddressMetadataBlacklisted(target.metadataBlacklist, this.localAddress)) {
      this.releaseWalletSessionIfHeld()
      clientDebugLog.log('comms', `Scene access denied · metadata blacklist · ${target.pointer}`, {
        level: 'error'
      })
      return { ok: false, reason: 'scene_ban' }
    }

    const parcel = gatekeeperParcelForComms(target)
    clientDebugLog.log(
      'comms',
      `Gatekeeper access check · realm=${realmName} parcel=${parcel} scene=${sceneId.slice(0, 12)}… world=${isWorld}`,
      { level: 'info' }
    )
    const access = await checkGatekeeperSceneAccess(this.identity, {
      sceneId,
      parcel,
      realmName,
      isWorld
    })
    if (access.denied) {
      this.releaseWalletSessionIfHeld()
      clientDebugLog.log('comms', `Scene access denied before comms · ${access.source}: ${access.error}`, {
        level: 'error'
      })
      return { ok: false, reason: 'scene_ban' }
    }
    if (access.adapter === null) {
      clientDebugLog.log(
        'comms',
        `Gatekeeper access check unavailable (${access.status}) — continuing comms connect: ${access.error}`,
        { level: 'warn' }
      )
    }

    let sceneAdapter = access.adapter

    this.disconnectSceneTransports()
    this.realm = {
      ...this.realm,
      realmName,
      baseUrl: target.contentUrl,
      isPreview: false,
      isConnectedSceneRoom: false
    }

    await this.connectRealmComms(target.contentUrl)
    // After archipelago is up, pin island to this parcel (not shell's (0,0,0) seed).
    this.seedArchipelagoPresenceFromScene(isWorld ? 'world-room' : 'scene-room')

    if (isWorld) {
      clientDebugLog.log('comms', `Joining world comms · pointer=${target.pointer}`, { level: 'info' })
      if (!this.worldConnected) {
        this.releaseWalletSessionIfHeld()
        // Soft for custom/self-hosted: bad LiveKit (e.g. livekit.host DNS fail) must not block scene load.
        clientDebugLog.log(
          'comms',
          'World LiveKit failed to connect — continuing solo (no peers/chat)',
          { level: 'warn', alsoConsole: true }
        )
        return { ok: false, reason: 'comms_disabled' }
      }

      this.transport = 'livekit'
      this.worldLiveKit.sendProfileAnnouncement('connect')

      try {
        const participants = await this.peerAddressesExceptSelf(
          await fetchSceneParticipants(target.pointer, realmName)
        )
        this.worldLiveKit.seedPeers(participants)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        clientDebugLog.log('comms', `world-participants fetch failed: ${msg}`, { level: 'warn' })
      }

      // Cast / OBS / livekit-video://current-stream publish into the **scene** LiveKit room
      // (gatekeeper get-scene-adapter), not the world signed-login room. Companion scene-watch
      // connects this room to count remote video and show Join live.
      if (!sceneAdapter) {
        clientDebugLog.log(
          'comms',
          `Gatekeeper scene adapter for world Cast · realm=${realmName} scene=${sceneId.slice(0, 12)}…`,
          { level: 'info' }
        )
        const adapterResult = await getSceneAdapter(this.identity, {
          sceneId,
          parcel,
          realmName,
          isWorld: true
        })
        if (adapterResult.ok) sceneAdapter = adapterResult.adapter
        else {
          clientDebugLog.log(
            'comms',
            `World scene-room adapter unavailable (Cast detect limited): ${adapterResult.error}`,
            { level: 'warn' }
          )
        }
      }
      if (sceneAdapter) {
        this.realm.commsAdapter = sceneAdapter
        const sceneOk = await this.sceneLiveKit.connect(sceneAdapter)
        this.realm.isConnectedSceneRoom = sceneOk
        if (sceneOk) {
          clientDebugLog.log(
            'comms',
            'Transport: LiveKit world + scene rooms · chat on world, Cast/video on scene',
            { level: 'success' }
          )
        } else {
          clientDebugLog.log('comms', 'World scene LiveKit failed — chat still on world room', {
            level: 'warn'
          })
        }
      } else {
        clientDebugLog.log('comms', 'Transport: LiveKit world room only · RFC4 Movement + chat', {
          level: 'success'
        })
      }
      // World room is the voice path — rebind even if cast scene room failed.
      this.notifyLiveKitRoomsChanged()
      return { ok: true }
    }

    clientDebugLog.log('comms', `Joining scene room · pointer=${target.pointer} scene=${sceneId.slice(0, 12)}…`)

    if (!sceneAdapter) {
      clientDebugLog.log(
        'comms',
        `Gatekeeper adapter retry · realm=${realmName} parcel=${parcel} scene=${sceneId.slice(0, 12)}…`,
        { level: 'info' }
      )
      const adapterResult = await getSceneAdapter(this.identity, {
        sceneId,
        parcel,
        realmName,
        isWorld: false
      })
      if (!adapterResult.ok) {
        if (adapterResult.status === 403 || adapterResult.status === 401) {
          this.releaseWalletSessionIfHeld()
          clientDebugLog.log('comms', `Scene access denied at comms connect: ${adapterResult.error}`, {
            level: 'error'
          })
          return { ok: false, reason: 'scene_ban' }
        }
        // Empty land / no scene room: still play multiplayer on archipelago island.
        clientDebugLog.log(
          'comms',
          `Gatekeeper scene adapter unavailable (${adapterResult.error}) — island-only multiplayer`,
          { level: 'warn', alsoConsole: true }
        )
        return this.finishParcelIslandOnlyComms()
      }
      sceneAdapter = adapterResult.adapter
    }

    clientDebugLog.log('comms', 'Gatekeeper adapter received · connecting scene LiveKit…', { level: 'success' })

    this.realm.commsAdapter = sceneAdapter

    const connected = await this.sceneLiveKit.connect(sceneAdapter)
    if (!connected) {
      clientDebugLog.log(
        'comms',
        'Scene LiveKit failed — continuing with archipelago island multiplayer',
        { level: 'warn', alsoConsole: true }
      )
      return this.finishParcelIslandOnlyComms()
    }

    let participants: Awaited<ReturnType<typeof fetchSceneParticipants>> = []
    try {
      participants = await this.peerAddressesExceptSelf(
        await fetchSceneParticipants(target.pointer, realmName)
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('comms', `scene-participants fetch failed: ${msg}`, { level: 'warn' })
    }

    if (this.worldConnected) {
      this.worldLiveKit.seedPeers(participants)
      this.worldLiveKit.sendProfileAnnouncement('connect')
    }

    this.transport = 'livekit'
    this.realm.isConnectedSceneRoom = true

    this.sceneLiveKit.seedPeers(participants)
    // ADR-204: scene room = scene media / scene packets. Island LiveKit stays
    // for RFC4 Movement + profiles (Explorer peers live on the island).
    this.notifyLiveKitRoomsChanged()

    clientDebugLog.log(
      'comms',
      'Transport: LiveKit scene room (media) + island (avatars) · RFC4 Movement + Scene packets',
      { level: 'success' }
    )
    return { ok: true }
  }

  /**
   * Parcel multiplayer without a scene LiveKit room (empty land / gatekeeper fail).
   * Archipelago already started in connectSceneRoomImpl — movement/profiles ride the island room.
   */
  private finishParcelIslandOnlyComms(): SceneCommsConnectResult {
    this.transport = 'livekit'
    this.realm.isConnectedSceneRoom = false
    this.seedArchipelagoPresenceFromScene('island-only')
    this.notifyLiveKitRoomsChanged()
    this.announceProfile('connect')
    clientDebugLog.log(
      'comms',
      'Transport: LiveKit island-only (no scene room) · RFC4 Movement + profiles on archipelago',
      { level: 'success', alsoConsole: true }
    )
    return { ok: true }
  }

  async connectAdapter(connectionString: string, roomHint?: string): Promise<boolean> {
    const trimmed = connectionString.trim()
    if (!trimmed) return false
    if (!this.localAddress || !this.identity) return false

    if (isLiveKitAdapter(trimmed)) {
      // Scene-room only. Never call disconnectSceneTransports() here — that also drops the
      // **world** LiveKit room and wipes remote avatars/movement on Worlds.
      this.sceneLiveKit.disconnect()
      this.rfc5.disconnect()
      this.realm.isConnectedSceneRoom = false
      this.clearPeerTransport(TransportType.SceneRoom)
      this.realm.commsAdapter = trimmed
      const connected = await this.sceneLiveKit.connect(trimmed)
      if (connected) {
        this.transport = 'livekit'
        this.realm.isConnectedSceneRoom = true
      } else if (this.worldLiveKit.isConnected() || this.worldConnected) {
        this.transport = 'livekit'
      } else {
        this.transport = 'none'
      }
      return connected
    }

    const parsed = this.adapterManager.parse(trimmed)
    if (parsed?.kind === 'ws-room') {
      return this.connectWsRoom(parsed.url, roomHint)
    }

    clientDebugLog.log('comms', `Unsupported adapter: ${trimmed.slice(0, 48)}`, { level: 'warn' })
    return false
  }

  getSceneOrigin(): { x: number; z: number } {
    return this.sceneOriginMeters
  }

  /** LiveKit remote participant counts (debug / frame-60 diagnostics). */
  getLivePeerCounts(): { scene: number; island: number; world: number; islandConnected: boolean } {
    return {
      scene: this.sceneLiveKit.getRemotePeerAddresses().length,
      island: this.islandLiveKit.getRemotePeerAddresses().length,
      world: this.worldLiveKit.getRemotePeerAddresses().length,
      islandConnected: this.islandConnected
    }
  }

  /**
   * Seed archipelago with spawn so island assignment does not wait for first post-start frame.
   * @param x,y,z — DCL scene-local meters from PlayerSystem.getPosition() (+Z north).
   */
  seedArchipelagoSceneLocal(x: number, y: number, z: number): void {
    if (this.sceneOrigin) {
      const g = sceneLocalToGenesis(x, y, z, this.sceneOrigin)
      console.log(
        '[archipelago] seed genesis from scene-local',
        `local=(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`,
        `genesis=(${g.x.toFixed(1)},${g.y.toFixed(1)},${g.z.toFixed(1)})`,
        `origin=${this.sceneOrigin.baseParcelX},${this.sceneOrigin.baseParcelY}`
      )
      this.archipelago.queuePosition(g.x, g.y, g.z)
      return
    }
    this.archipelago.queuePosition(x, y, z)
  }

  /**
   * Wallets for @-mentions + chat people list.
   * Gatekeeper seed + LiveKit remotes on **scene and world** rooms
   * (worlds put chat/people on World transport; parcels use SceneRoom).
   */
  getSceneChatMentionAddresses(): string[] {
    const self = this.localAddress?.toLowerCase() ?? null
    const addresses = new Set<string>()

    const acceptTransport = (sources: Set<TransportType>): boolean =>
      sources.has(TransportType.SceneRoom) || sources.has(TransportType.World)

    for (const [address, sources] of this.peerTransports) {
      if (!acceptTransport(sources)) continue
      const key = address.toLowerCase()
      if (self && key === self) continue
      addresses.add(key)
    }
    for (const address of this.sceneLiveKit.getRemotePeerAddresses()) {
      const key = address.toLowerCase()
      if (self && key === self) continue
      addresses.add(key)
    }
    for (const address of this.worldLiveKit.getRemotePeerAddresses()) {
      const key = address.toLowerCase()
      if (self && key === self) continue
      addresses.add(key)
    }
    return [...addresses].sort((a, b) => a.localeCompare(b))
  }

  /**
   * All nearby wallets currently on any live transport: scene, island (archipelago), world.
   * Used for friends online status (Explorer-style "in my area"), not only scene-chat mentions.
   */
  getLivePeerAddresses(): string[] {
    const self = this.localAddress?.toLowerCase() ?? null
    const addresses = new Set<string>()
    const add = (address: string) => {
      const key = address.toLowerCase()
      if (!key || (self && key === self)) return
      addresses.add(key)
    }
    for (const address of this.peerTransports.keys()) add(address)
    for (const address of this.sceneLiveKit.getRemotePeerAddresses()) add(address)
    for (const address of this.islandLiveKit.getRemotePeerAddresses()) add(address)
    for (const address of this.worldLiveKit.getRemotePeerAddresses()) add(address)
    return [...addresses].sort((a, b) => a.localeCompare(b))
  }

  /** True when the single media LiveKit room (or legacy rfc5) can carry movement. */
  private canPublishLiveKitMovement(): boolean {
    return (
      this.transport === 'livekit' ||
      this.mediaLiveKitSession() != null ||
      this.islandConnected ||
      this.sceneLiveKit.isConnected() ||
      this.worldConnected ||
      this.worldLiveKit.isConnected()
    )
  }

  /**
   * **One** LiveKit session for voice / scene media (not island avatars).
   *
   * Movement/profile fan-out is {@link movementLiveKitSessions}.
   *
   * | Place | Media room |
   * |-------|------------|
   * | Worlds | world (Cast scene room is not avatar media) |
   * | Parcels | **scene** preferred for voice / scene packets |
   * | Empty land / scene fail | island LiveKit fallback |
   *
   * Archipelago **WebSocket** stays for presence seed + Stats/monitoring.
   * Island LiveKit stays up for RFC4 Movement + profiles (Explorer peers).
   */
  private mediaLiveKitSession(): LiveKitCommsSession | null {
    if (this.isWorldComms()) {
      if (this.worldLiveKit.isConnected()) return this.worldLiveKit
      if (this.sceneLiveKit.isConnected()) return this.sceneLiveKit
      return null
    }
    // Parcels: scene first — no dual island+scene media.
    if (this.sceneLiveKit.isConnected()) return this.sceneLiveKit
    if (this.islandLiveKit.isConnected()) return this.islandLiveKit
    if (this.worldLiveKit.isConnected()) return this.worldLiveKit
    return null
  }

  /**
   * RFC4 Movement + Profile rooms. Explorer/Bevy publish Movement on **scene + world**
   * LiveKit (`global_crdt`). Worlds used to send only the world room — the scene-room
   * `authoritative-server` never saw player Transform, so Flagtag `requestCoinPickup`
   * (and similar proximity checks) silently returned (`getPlayerPosition` null / too far).
   * Voice / scene-binary stay on {@link mediaLiveKitSession}.
   */
  private movementLiveKitSessions(): LiveKitCommsSession[] {
    if (this.isWorldComms()) {
      const out: LiveKitCommsSession[] = []
      const media = this.mediaLiveKitSession()
      if (media) out.push(media)
      if (this.sceneLiveKit.isConnected() && media !== this.sceneLiveKit) {
        out.push(this.sceneLiveKit)
      }
      return out
    }
    const out: LiveKitCommsSession[] = []
    if (this.sceneLiveKit.isConnected()) out.push(this.sceneLiveKit)
    if (this.islandLiveKit.isConnected()) out.push(this.islandLiveKit)
    return out
  }

  broadcastTransform(
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
      glideState?: number
    }
  ): void {
    // Heal transport if media room is up after a failed scene-room connect (empty land).
    if (this.canPublishLiveKitMovement()) {
      this.transport = 'livekit'
      this.pendingTransform = { type: 'avatar-transform', x, y, z, yaw }
      for (const session of this.movementLiveKitSessions()) {
        session.queueTransform(x, y, z, yaw, isEmoting, locomotion)
      }
      // Archipelago WS position only (Stats / clustering seed) — not a second LiveKit publish.
      if (this.sceneOrigin) {
        const g = sceneLocalToGenesis(x, y, z, this.sceneOrigin)
        this.archipelago.queuePosition(g.x, g.y, g.z)
      } else {
        this.archipelago.queuePosition(x, y, z)
      }
      return
    }
    if (!this.rfc5.isConnected()) return
    this.pendingTransform = { type: 'avatar-transform', x, y, z, yaw }
  }

  flushBroadcast(now = performance.now()): void {
    if (this.walletSessionLockHeld && this.localAddress) {
      refreshWalletSessionLock(this.localAddress)
    }
    if (this.canPublishLiveKitMovement()) {
      this.transport = 'livekit'
      for (const session of this.movementLiveKitSessions()) {
        session.flushBroadcast(now, BROADCAST_INTERVAL_MS)
      }
      return
    }
    if (!this.pendingTransform || now - this.lastBroadcast < BROADCAST_INTERVAL_MS) return
    this.rfc5.send(encodeTransformPayload(this.pendingTransform), true)
    this.lastBroadcast = now
    this.pendingTransform = null
  }

  /**
   * Hold scene-binary ingress until async scene `main()` / `syncEntity` settles.
   * Prevents AUTH_RES orphan NetworkEntity race (pixelwars seed → white paint tiles).
   * Default is held; release after worker signals main complete / ready.
   */
  setSceneBinaryIngressHold(hold: boolean): void {
    const wasHeld = this.inboundQueue.isHoldDrain()
    this.inboundQueue.setHoldDrain(hold)
    if (wasHeld && !hold) {
      const n = this.inboundQueue.pendingCount()
      clientDebugLog.log(
        'sync',
        n > 0
          ? `scene-binary ingress released — ${n} buffered packet(s) will drain on next sendBinary`
          : 'scene-binary ingress released (queue empty)',
        { level: 'info', alsoConsole: true }
      )
    } else if (!wasHeld && hold) {
      clientDebugLog.log('sync', 'scene-binary ingress held (await scene main/syncEntity)', {
        level: 'info',
        alsoConsole: false
      })
    }
  }

  isSceneBinaryIngressHeld(): boolean {
    return this.inboundQueue.isHoldDrain()
  }

  /**
   * Official web Explorer connects scene LiveKit after the sandbox is ticking.
   * We reuse a landing room — open CUSTOM_EVENT only once that clock has a head start.
   */
  setSceneBinaryCustomEventHold(hold: boolean): void {
    const wasHeld = this.inboundQueue.isHoldCustomEvents()
    this.inboundQueue.setHoldCustomEvents(hold)
    if (wasHeld && !hold) {
      const n = this.inboundQueue.pendingCount()
      clientDebugLog.log(
        'sync',
        n > 0
          ? `CUSTOM_EVENT ingress live — ${n} join/snapshot packet(s) drain next sendBinary`
          : 'CUSTOM_EVENT ingress live (queue empty)',
        { level: 'info', alsoConsole: true }
      )
    }
  }

  /**
   * Drain buffered scene-binary for the worker without LiveKit publish.
   * Used when network transport's sendBinary has empty outbound (every eng.update).
   */
  drainSceneBinaryInbound(): Uint8Array[] {
    return this.inboundQueue.drain()
  }

  async sendBinary(data: Uint8Array[], addresses: string[] = []): Promise<Uint8Array[]> {
    if (this.transport !== 'livekit' || !this.sceneId) {
      // RFC5 has no directed peer targeting — broadcast only (rare fallback path).
      if (addresses.length) logSyncDirectedFallback(addresses, 'rfc5-broadcast')
      if (!this.rfc5.isConnected()) return this.inboundQueue.drain()
      this.maybeNoteMissingAuthServer()
      for (const chunk of data) {
        const unwrapped = unwrapCraftedCommsMessage(chunk)
        const reliable = !unwrapped || isReliableCommsWireType(unwrapped.messageType)
        this.rfc5.send(chunk, !reliable)
      }
      return this.inboundQueue.drain()
    }

    const session = this.activeDataSession()
    if (!session) return this.inboundQueue.drain()

    // Directed peerData → LiveKit destinationIdentities. Empty addresses = room broadcast
    // (unless CUSTOM_EVENT / REQ can be pinned to the authoritative-server peer below).
    let dest =
      addresses.length > 0 ? session.resolveDestinationIdentities(addresses) : undefined
    if (addresses.length) {
      logSyncDirectedPublish(addresses, dest ?? [])
    }

    // Throttled hint: auth-server games never paint without this peer.
    this.maybeNoteMissingAuthServer()

    for (const chunk of data) {
      // Parity with @dcl/ecs LIVEKIT_MAX_SIZE — SDK chunks; refuse runaway single blobs.
      if (isOversizedCraftedChunk(chunk)) {
        logSyncOversizedSkip({
          phase: 'crafted',
          bytes: chunk.byteLength,
          limit: LIVEKIT_MAX_CRAFTED_BYTES
        })
        continue
      }
      const packet = encodeRfc4SceneBinaryPacket(this.sceneId, chunk)
      if (isOversizedPublishPacket(packet)) {
        logSyncOversizedSkip({
          phase: 'publish',
          bytes: packet.byteLength,
          limit: LIVEKIT_MAX_PUBLISH_BYTES
        })
        continue
      }
      const unwrapped = unwrapCraftedCommsMessage(chunk)
      // Auth-server scenes: client CUSTOM_EVENT + REQ_CRDT_STATE are only handled by the
      // server peer. Prefer directed reliable publish so joinRoster / paintTick / state
      // sync are not lossy-broadcast (and reach the server when it is present).
      let chunkDest = dest
      if (
        (!chunkDest || chunkDest.length === 0) &&
        unwrapped &&
        (unwrapped.messageType === CommsWireMessageType.CUSTOM_EVENT ||
          isReqCrdtStateType(unwrapped.messageType))
      ) {
        const authDest = session.resolveDestinationIdentities([AUTH_SERVER_PEER_IDENTITY])
        if (authDest.length > 0 && session.hasRemoteIdentity(AUTH_SERVER_PEER_IDENTITY)) {
          chunkDest = authDest
        }
      }
      // Directed packets always reliable. RES/REQ + CUSTOM_EVENT need reliable DC —
      // lossy broadcast drops combat/lobby event sequences under load.
      const reliable =
        Boolean(chunkDest?.length) ||
        (unwrapped != null && isReliableCommsWireType(unwrapped.messageType))
      await session.publishData(packet, {
        reliable,
        destinationIdentities: chunkDest
      })
    }
    return this.inboundQueue.drain()
  }

  private lastMissingAuthServerLogMs = 0
  private authServerSeen = false
  private onAuthServerPresent: (() => void) | null = null

  /**
   * True when peer identity `authoritative-server` is in the scene room
   * (LiveKit Cast/scene room, or sdk-commands mini-comms / RFC5).
   * Pixelwars paint / Flagtag combat / Last Call Dock require this peer for isRoomReady.
   */
  hasAuthServerPeer(): boolean {
    if (this.transport === 'rfc5') {
      return this.rfc5.hasRemoteAddress(AUTH_SERVER_PEER_IDENTITY)
    }
    if (!this.sceneLiveKit.isConnected()) return false
    return this.sceneLiveKit.hasRemoteIdentity(AUTH_SERVER_PEER_IDENTITY)
  }

  /**
   * Fired once when auth-server first appears in the scene room (or immediately if already present).
   * Host uses this to re-pulse RealmInfo so SDK requestState / isRoomReady cannot stay stuck.
   */
  setAuthServerPresentHandler(handler: (() => void) | null): void {
    this.onAuthServerPresent = handler
    if (handler && this.hasAuthServerPeer()) {
      this.authServerSeen = true
      try {
        handler()
      } catch {
        /* ignore */
      }
    }
  }

  private noteAuthServerPeer(address: string): void {
    if (address.trim().toLowerCase() !== AUTH_SERVER_PEER_IDENTITY) return
    if (this.authServerSeen) return
    this.authServerSeen = true
    const via = this.transport === 'rfc5' ? 'mini-comms' : 'scene LiveKit'
    clientDebugLog.log(
      'sync',
      `authoritative-server present in ${via} — isRoomReady / CUSTOM_EVENT can drain`,
      { level: 'success', alsoConsole: true }
    )
    try {
      this.onAuthServerPresent?.()
    } catch {
      /* ignore */
    }
  }

  /** Once per 15s while scene room is live but auth-server peer is absent. */
  private maybeNoteMissingAuthServer(): void {
    const live =
      this.transport === 'rfc5' ? this.rfc5.isConnected() : this.sceneLiveKit.isConnected()
    if (!live) return
    if (this.hasAuthServerPeer()) {
      this.noteAuthServerPeer(AUTH_SERVER_PEER_IDENTITY)
      return
    }
    const now = performance.now()
    if (now - this.lastMissingAuthServerLogMs < 15_000) return
    this.lastMissingAuthServerLogMs = now
    const via = this.transport === 'rfc5' ? 'mini-comms room' : 'scene LiveKit room'
    clientDebugLog.log(
      'sync',
      `authoritative-server peer not in ${via} — auth-server games ` +
        '(Last Call Dock deck, pixelwars paint/team, Flagtag) will not isRoomReady until it joins. ' +
        `sceneId=${this.sceneId.slice(0, 16)}…`,
      { level: 'warn', alsoConsole: true }
    )
  }

  subscribeToTopic(topic: string): void {
    this.topicService.subscribe(topic)
  }

  unsubscribeFromTopic(topic: string): void {
    this.topicService.unsubscribe(topic)
  }

  async publishTopicData(topic: string, data: string): Promise<void> {
    const payload = this.topicService.decodePublishPayload(data)
    const session = this.activeDataSession()
    if (!session) return
    await session.publishTopicData(topic, payload)
  }

  /** Legacy `CommunicationsController.send` — UTF-8 text on topic `comms` (not base64). */
  async publishCommsMessage(message: string): Promise<void> {
    const payload = new TextEncoder().encode(message)
    const session = this.activeDataSession()
    if (!session) return
    await session.publishTopicData('comms', payload)
  }

  consumeMessages(topic: string): { messages: Array<{ sender: string; data: string }> } {
    return { messages: this.topicService.consume(topic) }
  }

  getActiveVideoStreams(): { streams: ActiveVideoStream[] } {
    const seen = new Set<string>()
    const streams: ActiveVideoStream[] = []
    for (const session of [this.sceneLiveKit, this.worldLiveKit, this.islandLiveKit]) {
      if (!session.isConnected()) continue
      for (const stream of session.getActiveVideoStreams()) {
        const key = `${stream.identity}:${stream.trackSid}`
        if (seen.has(key)) continue
        seen.add(key)
        streams.push(stream)
      }
    }
    return { streams }
  }

  private connectedLiveKitSessions() {
    return [this.sceneLiveKit, this.worldLiveKit, this.islandLiveKit].filter((s) => s.isConnected())
  }

  /**
   * True when any connected LiveKit room has remote video pubs (stream-key / Cast).
   * Prefers the scene room but also accepts world-room pubs — some ingress paths
   * have shown up outside `scene-room` while still publishing video.
   * Separate from VideoPlayer m3u8 / static https sources.
   */
  hasSceneLiveKitVideoLive(): boolean {
    if (this.sceneLiveKit.isConnected() && this.sceneLiveKit.hasRemoteVideoLive()) return true
    return this.hasRemoteVideoLive()
  }

  /** @deprecated use hasSceneLiveKitVideoLive — name was confusing (LiveKit ≠ Cast-only). */
  hasSceneCastVideoLive(): boolean {
    return this.hasSceneLiveKitVideoLive()
  }

  /**
   * Pick the LiveKit session that should feed `livekit-video://current-stream`.
   * Prefer live scene room → any live room → connected scene → any connected.
   */
  private pickLiveKitVideoSession(): LiveKitCommsSession | null {
    const sessions = this.connectedLiveKitSessions()
    if (sessions.length === 0) return null
    const score = (s: LiveKitCommsSession): number => {
      const scene = s.getRoomName().includes('scene-room') ? 0 : 10
      const live = s.hasRemoteVideoLive() ? 0 : 100
      return scene + live
    }
    return [...sessions].sort((a, b) => score(a) - score(b))[0] ?? null
  }

  /**
   * Bind `livekit-video://current-stream` to a scene VideoPlayer element.
   * Stream-key / Cast usually publish on the **scene** room; we still scan all
   * connected rooms (parity with companion Cast attach) and rebind when a better
   * room gains video after OBS goes live.
   */
  bindLiveKitVideoSource(video: HTMLVideoElement, onUpdate?: () => void): () => void {
    let disposed = false
    let innerCleanup: (() => void) | null = null
    let boundSession: LiveKitCommsSession | null = null
    let lastWaitLogAt = 0
    let lastBoundKey = ''

    const sessionKey = (s: LiveKitCommsSession): string =>
      `${s.getRoomName() || 'room'}|${s.hasRemoteVideoLive() ? 'live' : 'idle'}`

    const tryBind = (): void => {
      if (disposed) return
      const session = this.pickLiveKitVideoSession()
      if (!session) return

      const key = sessionKey(session)
      // Keep current bind if same room and still healthy; rebind when a better room appears.
      if (innerCleanup && boundSession === session) {
        if (key !== lastBoundKey && session.hasRemoteVideoLive()) {
          // Room flipped idle→live — attachBest inside bind already polls; just notify.
          lastBoundKey = key
          onUpdate?.()
        }
        return
      }

      if (innerCleanup && boundSession && boundSession !== session) {
        const oldLive = boundSession.hasRemoteVideoLive()
        const newLive = session.hasRemoteVideoLive()
        const newIsScene = session.getRoomName().includes('scene-room')
        const oldIsScene = boundSession.getRoomName().includes('scene-room')
        // Only rebind when new session is strictly better (live upgrade, or scene+live).
        const better =
          (newLive && !oldLive) || (newLive && newIsScene && !oldIsScene) || (!oldLive && newIsScene)
        if (!better) return
        innerCleanup()
        innerCleanup = null
        boundSession = null
      }

      if (innerCleanup) return

      innerCleanup = session.bindCurrentVideoStream(video, onUpdate)
      boundSession = session
      lastBoundKey = key
      const snap = session.getRemoteVideoPresenceSnapshot()
      clientDebugLog.log(
        'cast',
        `current-stream bound · room=${session.getRoomName() || '?'} live=${snap.live} remotes=${snap.remoteParticipants} videoPubs=${snap.remoteVideoPubs}`,
        { level: snap.live ? 'success' : 'info' }
      )
      console.log(
        `[livekit-video] current-stream bound · ${session.getRoomName() || sessionKey(session)} · live=${snap.live} pubs=${snap.remoteVideoPubs}`
      )
    }

    const logWait = (): void => {
      if (disposed) return
      if (this.hasSceneLiveKitVideoLive()) return
      const now = performance.now()
      if (now - lastWaitLogAt < 5000) return
      lastWaitLogAt = now
      const parts: string[] = []
      for (const s of this.connectedLiveKitSessions()) {
        const snap = s.getRemoteVideoPresenceSnapshot()
        parts.push(
          `${s.getRoomName() || '?'}:remotes=${snap.remoteParticipants}/pubs=${snap.remoteVideoPubs}`
        )
      }
      clientDebugLog.log(
        'cast',
        `current-stream waiting for remote video · ${parts.join(' · ') || 'no rooms'}`,
        { level: 'info', throttleMs: 0 }
      )
    }

    tryBind()
    const poll = window.setInterval(() => {
      tryBind()
      logWait()
    }, 750)

    return () => {
      disposed = true
      window.clearInterval(poll)
      innerCleanup?.()
      innerCleanup = null
      boundSession = null
    }
  }

  /**
   * Companion Cast attach into a host element.
   * Polls **all** connected rooms (scene + world) — Cast is on the scene room for worlds;
   * binding only the first empty room used to show a permanent black screen.
   */
  bindRemoteCastVideoToHost(
    host: HTMLElement,
    onUpdate?: (attached: boolean) => void,
    opts?: { muted?: boolean; volume?: number }
  ): () => void {
    const sessions = this.connectedLiveKitSessions()
    if (sessions.length === 0) {
      onUpdate?.(false)
      return () => {}
    }

    for (const s of sessions) {
      const room = s.getRoom()
      if (room) void room.startAudio().catch(() => {})
    }

    let lastOk = false
    const tryAll = (force = false): void => {
      // Already showing video — only refresh audio props on same track (no remount).
      if (lastOk && !force && host.querySelector('video') && host.dataset.castTrackSid) {
        reattachFirstRemoteVideoToHost(sessions[0]?.getRoom() ?? null, host, {
          muted: opts?.muted,
          volume: opts?.volume,
          controls: false
        })
        // Still try preferred rooms so SID can update if publisher switches
        const orderedKeep = [...sessions].sort((a, b) => {
          const aScene = a.getRoomName().includes('scene-room') ? 0 : 1
          const bScene = b.getRoomName().includes('scene-room') ? 0 : 1
          return aScene - bScene
        })
        for (const s of orderedKeep) {
          const room = s.getRoom()
          if (!room) continue
          if (
            reattachFirstRemoteVideoToHost(room, host, {
              muted: opts?.muted,
              volume: opts?.volume,
              controls: false
            })
          ) {
            return
          }
        }
        return
      }

      const ordered = [...sessions].sort((a, b) => {
        const aScene = a.getRoomName().includes('scene-room') ? 0 : 1
        const bScene = b.getRoomName().includes('scene-room') ? 0 : 1
        if (aScene !== bScene) return aScene - bScene
        const aLive = a.hasRemoteVideoLive() ? 0 : 1
        const bLive = b.hasRemoteVideoLive() ? 0 : 1
        return aLive - bLive
      })

      let attached = false
      for (const s of ordered) {
        const room = s.getRoom()
        if (!room) continue
        if (
          reattachFirstRemoteVideoToHost(room, host, {
            muted: opts?.muted,
            volume: opts?.volume,
            controls: false
          })
        ) {
          attached = true
          break
        }
      }

      if (attached !== lastOk) {
        lastOk = attached
        onUpdate?.(attached)
      }
    }

    const eventUnsubs: Array<() => void> = []
    for (const s of sessions) {
      eventUnsubs.push(s.watchRemoteVideoLive(() => tryAll(true)))
    }

    tryAll(true)
    // Poll for late RTMP publishers and stream-end (force recheck while attached).
    const poll = window.setInterval(() => {
      tryAll(true)
    }, 2000)

    return () => {
      window.clearInterval(poll)
      for (const u of eventUnsubs) u()
      clearCastVideoHost(host)
    }
  }

  /** Any LiveKit room connected (world and/or scene). */
  isLiveKitConnected(): boolean {
    return this.connectedLiveKitSessions().length > 0
  }

  /** Cast/OBS live: remote (or non-camera local) video on any connected room. */
  hasRemoteVideoLive(): boolean {
    return this.connectedLiveKitSessions().some((s) => s.hasRemoteVideoLive())
  }

  /**
   * Subscribe to Cast/OBS live presence on **all** connected rooms (OR).
   *
   * Dynamically rebinds when rooms connect later (world first, scene Cast room lag)
   * and keeps polling so OBS going live *after* landing still flips Join live.
   */
  watchRemoteVideoLive(onChange: (live: boolean) => void): () => void {
    const liveBySession = new Map<LiveKitCommsSession, boolean>()
    const unsubBySession = new Map<LiveKitCommsSession, () => void>()
    let lastEmitted: boolean | null = null
    let disposed = false
    let sceneEnsureInFlight = false

    const emit = (): void => {
      if (disposed) return
      // Direct scan each tick so we never miss pubs even if a child watcher lags.
      const any = this.hasRemoteVideoLive()
      if (any === lastEmitted) return
      lastEmitted = any
      onChange(any)
    }

    const syncSessions = (): void => {
      if (disposed) return
      const connected = this.connectedLiveKitSessions()
      const connectedSet = new Set(connected)

      for (const [session, unsub] of [...unsubBySession.entries()]) {
        if (connectedSet.has(session)) continue
        unsub()
        unsubBySession.delete(session)
        liveBySession.delete(session)
      }

      for (const session of connected) {
        if (unsubBySession.has(session)) continue
        liveBySession.set(session, session.hasRemoteVideoLive())
        unsubBySession.set(
          session,
          session.watchRemoteVideoLive((live) => {
            liveBySession.set(session, live)
            emit()
          })
        )
      }

      emit()
    }

    const tick = (): void => {
      if (disposed) return
      if (!sceneEnsureInFlight && !this.sceneLiveKit.isConnected()) {
        sceneEnsureInFlight = true
        void this.ensureSceneRoomForCastDetection()
          .catch(() => false)
          .finally(() => {
            sceneEnsureInFlight = false
            if (!disposed) syncSessions()
          })
      } else {
        syncSessions()
      }
    }

    tick()
    const poll = window.setInterval(tick, 2000)

    return () => {
      disposed = true
      window.clearInterval(poll)
      for (const unsub of unsubBySession.values()) unsub()
      unsubBySession.clear()
      liveBySession.clear()
    }
  }

  /**
   * Worlds connect world LiveKit first; Cast/OBS stream keys publish to the **scene** room.
   * Retry scene-room join while landing so going live after open still detects video.
   */
  async ensureSceneRoomForCastDetection(): Promise<boolean> {
    if (this.sceneLiveKit.isConnected()) return false
    // Never race cast retry against a scene-room switch / chat rejoin.
    if (this.sceneRoomConnectInFlight) return false
    if (!this.identity || !this.localAddress) return false
    const target = this.sceneTarget
    if (!target) return false

    const isWorld = target.isWorld ?? !isParcelPointer(normalizePointer(target.pointer))
    // Genesis parcels already use sceneLiveKit as primary; only worlds need a second room.
    if (!isWorld) return false
    if (!this.worldLiveKit.isConnected()) return false

    const sceneId = this.sceneId?.trim() || target.sceneId?.trim()
    if (!sceneId) return false

    const realmName = gatekeeperRealmNameForComms(target)
    const parcel = gatekeeperParcelForComms(target)
    try {
      const adapterResult = await getSceneAdapter(this.identity, {
        sceneId,
        parcel,
        realmName,
        isWorld: true
      })
      if (!adapterResult.ok) return false
      const ok = await this.sceneLiveKit.connect(adapterResult.adapter)
      this.realm.isConnectedSceneRoom = ok
      if (ok) {
        this.realm.commsAdapter = adapterResult.adapter
        clientDebugLog.log('cast', 'Scene LiveKit joined for Cast detection', { level: 'success' })
      }
      return ok
    } catch {
      return false
    }
  }

  disconnect(): void {
    this.disconnectAllTransports()
  }

  dispose(): void {
    this.disconnectAllTransports()
    this.handlers = null
    this.sceneBinaryHandler = null
    this.topicMessageHandler = null
    this.topicListeners.clear()
    this.chatHandler = null
    this.chatMediaHandler = null
    this.sceneTarget = null
    this.peerTransports.clear()
    this.topicService.clear()
    this.inboundQueue.clear()
    // Next scene join re-holds; default-safe so a late packet cannot race a new load.
    this.inboundQueue.setHoldDrain(true)
  }

  private connectArchipelago(url: string): void {
    if (!this.localAddress || !this.identity) return
    this.archipelago.connect(url, this.localAddress, this.identity)
  }

  private async onIslandChanged(connStr: string): Promise<void> {
    this.islandLiveKit.disconnect()
    this.islandConnected = false
    if (!isLiveKitAdapter(connStr)) {
      clientDebugLog.log('comms', `Island conn_str unsupported: ${connStr.slice(0, 48)}`, { level: 'warn' })
      return
    }
    // Data-only: Explorer avatars ride island RFC4. Do not auto-sub island A/V
    // (voice stays on the scene room).
    const connected = await this.islandLiveKit.connect(connStr, { autoSubscribe: false })
    this.islandConnected = connected
    clientDebugLog.log(
      'network',
      connected
        ? `Island LiveKit connected · remotes=${this.islandLiveKit.getRemotePeerAddresses().length}` +
            (this.sceneLiveKit.isConnected() ? ' (scene media still primary for voice)' : '')
        : 'Island LiveKit connect failed (archipelago)',
      { level: connected ? 'success' : 'error', alsoConsole: true }
    )
    if (connected) {
      // Without this, transport stays 'none' and broadcastTransform never publishes RFC4 Movement,
      // so peers freeze as name-tag pills forever on island-only parcels.
      this.transport = 'livekit'
      this.notifyLiveKitRoomsChanged()
      // LiveKit connect already fires onPeerJoin for remotes present at join, but after a
      // World rebuild / follow teleport handlers may have been rewired — re-push the roster
      // so RemoteAvatarManager does not stay empty while voice already sees peers.
      this.notifyHandlersOfCurrentPeers()
      this.announceProfile('connect')
      // Empty-land path: scene room never connects — DAV/DPET only reach peers after island.
      // Spawn-time WantAnnounce often ran too early (logs: "scene comms not connected").
      try {
        this.onIslandLiveKitReady?.()
      } catch (err) {
        clientDebugLog.log('comms', `onIslandLiveKitReady failed: ${String(err)}`, { level: 'warn' })
      }
    }
  }

  /**
   * World hook — fired when archipelago island LiveKit is up (parcel multiplayer path).
   * Use to re-announce custom VRM / pets after early WantAnnounce failed.
   */
  onIslandLiveKitReady: (() => void) | null = null

  /** Optional hook — World rebinds voice when LiveKit rooms change. */
  onLiveKitRoomsChanged: (() => void) | null = null

  /** Notify voice (and any other listeners) that the LiveKit room set changed. */
  notifyLiveKitRoomsChanged(): void {
    try {
      this.onLiveKitRoomsChanged?.()
    } catch (err) {
      clientDebugLog.log('comms', `onLiveKitRoomsChanged failed: ${String(err)}`, { level: 'warn' })
    }
  }

  private async connectLiveKitLabel(
    adapter: string,
    label: 'island' | 'scene' | 'world'
  ): Promise<boolean> {
    const session =
      label === 'island' ? this.islandLiveKit : label === 'scene' ? this.sceneLiveKit : this.worldLiveKit
    const connected = await session.connect(adapter)
    if (label === 'world') this.worldConnected = connected
    if (label === 'island') this.islandConnected = connected
    if (connected) {
      this.notifyLiveKitRoomsChanged()
      // Follow teleport / World rebuild: remotes already in room must re-hit onPeerJoin
      // (join events already fired during connect before handlers were rewired).
      this.notifyHandlersOfCurrentPeers()
    }
    return connected
  }

  /**
   * Hammurabi local-preview law: `/about` ws-room is not the auth-server bus.
   * Server calls `comms-gatekeeper-local/get-server-scene-adapter` with
   * realmName=LocalPreview + scene entity id and sits in that LiveKit room as
   * `authoritative-server`. The player must `get-scene-adapter` the same pair.
   */
  private async joinLocalPreviewAuthLiveKit(target: SceneCommsTarget): Promise<void> {
    const sceneId = (this.sceneId || target.sceneId).trim()
    if (!this.identity || !sceneId) {
      clientDebugLog.log(
        'sync',
        'Preview auth LiveKit skipped — missing identity or sceneId (hammurabi will not see this client)',
        { level: 'warn', alsoConsole: true }
      )
      return
    }
    const parcel = gatekeeperParcelForComms(target)
    clientDebugLog.log(
      'comms',
      `Preview auth LiveKit handshake · scene=${sceneId.slice(0, 20)}… realm=${LOCAL_PREVIEW_REALM_NAME} parcel=${parcel}`,
      { level: 'info', alsoConsole: true }
    )
    const result = await getSceneAdapter(
      this.identity,
      {
        sceneId,
        parcel,
        realmName: LOCAL_PREVIEW_REALM_NAME,
        isWorld: false
      },
      GATEKEEPER_LOCAL_URL
    )
    if (!result.ok) {
      clientDebugLog.log(
        'sync',
        `Preview auth LiveKit handshake failed (${result.status} ${result.error}) — ` +
          'authoritative-server is on gatekeeper-local LiveKit, not mini-comms. ' +
          'Need internet to comms-gatekeeper-local.decentraland.org.',
        { level: 'warn', alsoConsole: true }
      )
      return
    }
    if (!isLiveKitAdapter(result.adapter) || isUnusableLiveKitAdapter(result.adapter)) {
      clientDebugLog.log(
        'sync',
        'Preview auth handshake returned a non-LiveKit adapter — staying on mini-comms only',
        { level: 'warn', alsoConsole: true }
      )
      return
    }
    const connected = await this.connectLiveKitLabel(result.adapter, 'scene')
    if (!connected) {
      clientDebugLog.log(
        'sync',
        'Preview scene LiveKit connect failed — staying on mini-comms',
        { level: 'warn', alsoConsole: true }
      )
      return
    }
    this.transport = 'livekit'
    this.realm.isConnectedSceneRoom = true
    this.maybeNoteMissingAuthServer()
    clientDebugLog.log(
      'sync',
      'Preview scene LiveKit connected — CUSTOM_EVENT / AUTH_RES use this room (not mini-comms)',
      { level: 'success', alsoConsole: true }
    )
  }

  private connectWsRoom(wsUrl: string, roomHint?: string): boolean {
    if (!this.localAddress || !this.identity) return false
    const already =
      this.rfc5.isConnected() && this.realm.commsAdapter === `ws-room:${wsUrl}`
    if (already) {
      this.realm.room = roomHint ?? this.realm.room
      return true
    }
    // Keep scene LiveKit (hammurabi) if we are only (re)joining mini-comms avatars.
    const keepSceneLiveKit = this.sceneLiveKit.isConnected()
    if (keepSceneLiveKit) {
      this.rfc5.disconnect()
    } else {
      this.disconnectAllTransports()
    }
    this.realm = {
      ...this.realm,
      commsAdapter: `ws-room:${wsUrl}`,
      room: roomHint ?? this.realm.room,
      isPreview: true,
      isConnectedSceneRoom: false
    }

    this.rfc5.connect(wsUrl, this.localAddress, this.identity, {
      onWelcome: (_alias, peers) => {
        // Scene LiveKit (hammurabi) owns sendBinary when connected — do not clobber.
        if (this.transport !== 'livekit') {
          this.transport = 'rfc5'
          this.realm.isConnectedSceneRoom = true
        }
        this.realm.isPreview = true
        for (const address of peers.values()) {
          if (address === this.localAddress) continue
          this.handlers?.onPeerJoin(address)
          this.noteAuthServerPeer(address)
        }
      },
      onPeerJoin: (_alias, address) => {
        if (address === this.localAddress) return
        this.handlers?.onPeerJoin(address)
        this.noteAuthServerPeer(address)
      },
      onPeerLeave: (alias) => {
        const address = this.rfc5.getAddressForAlias(alias)
        if (address) this.handlers?.onPeerLeave(address)
      },
      onPeerUpdate: (fromAlias, body) => {
        const address = this.rfc5.getAddressForAlias(fromAlias)
        if (!address || address === this.localAddress) return
        const kind = classifyRfc5PeerUpdateBody(body)
        if (kind === 'transform') {
          const payload = decodeTransformPayload(body)
          if (payload) this.handlers?.onPeerTransform(address, payload)
          return
        }
        if (kind === 'topic') {
          const topic = decodeRfc5TopicPayload(body)
          if (topic) this.dispatchTopic(topic.topic, address, topic.packet)
          return
        }
        if (!body.byteLength) return
        this.noteAuthServerPeer(address)
        this.inboundQueue.pushSceneBinary(address, body)
        this.sceneBinaryHandler?.(address, body)
      },
      onDisconnect: () => {
        if (this.sceneLiveKit.isConnected()) {
          this.transport = 'livekit'
          this.realm.isConnectedSceneRoom = true
          return
        }
        this.realm.isConnectedSceneRoom = false
        if (this.transport === 'rfc5') this.transport = 'none'
      },
      onError: (err) => clientDebugLog.log('comms', err.message, { level: 'error' })
    })

    return true
  }

  private syncRealmBoundsToSessions(): void {
    for (const session of [this.islandLiveKit, this.sceneLiveKit, this.worldLiveKit]) {
      session.setRealmBounds(this.realmBounds)
      session.setSceneOrigin(this.sceneOrigin)
    }
  }

  private peerAddressesExceptSelf(addresses: string[]): string[] {
    const self = this.localAddress
    if (!self) return addresses
    return addresses.filter((address) => address.toLowerCase() !== self)
  }

  private releaseWalletSessionIfHeld(): void {
    if (!this.walletSessionLockHeld || !this.localAddress) return
    releaseWalletSessionLock(this.localAddress)
    this.walletSessionLockHeld = false
  }

  private trackPeerJoin(address: string, transport: TransportType): void {
    const key = address.toLowerCase()
    if (key === this.localAddress) return
    // Defense in depth — LiveKit session should already skip these, but never spawn
    // a blank avatar for RTMP stream-key ingress or Cast presentation bots.
    if (isNonPlayerLiveKitIdentity(key)) return
    let sources = this.peerTransports.get(key)
    if (!sources) {
      sources = new Set()
      this.peerTransports.set(key, sources)
    }
    if (sources.size === 0) {
      this.handlers?.onPeerJoin(key)
      this.requestRemotePeerProfile(key)
    }
    sources.add(transport)
  }

  /** Ask a remote peer for their RFC4 profile (Explorer parity on join / version bump). */
  requestRemotePeerProfile(address: string, profileVersion = 0): void {
    const key = address.toLowerCase()
    if (!key || key === this.localAddress) return

    const now = performance.now()
    const last = this.profileRequestAt.get(key) ?? 0
    if (now - last < CommsService.PROFILE_REQUEST_COOLDOWN_MS) return
    this.profileRequestAt.set(key, now)

    const packet = encodeRfc4ProfileRequestPacket(key, profileVersion)
    // One room only — dual world+scene publishes doubled traffic and hit disconnecting rooms.
    const session = this.primaryAvatarSession()
    if (!session) return
    void session.publishData(packet)
  }

  /** Room used for movement/profiles — same as {@link mediaLiveKitSession}. */
  private primaryAvatarSession(): LiveKitCommsSession | null {
    return this.mediaLiveKitSession()
  }

  /**
   * Primary LiveKit room (single) — world for Worlds, scene for parcels (island fallback).
   */
  getPrimaryLiveKitRoom(): Room | null {
    const session = this.mediaLiveKitSession()
    if (!session) return null
    const room = session.getRoom()
    if (!room || room.state !== ConnectionState.Connected) return null
    return room
  }

  /**
   * LiveKit rooms used for nearby voice — **exactly one** media room.
   *
   * - **Worlds:** world LiveKit only (scene room is Cast/video).
   * - **Parcels:** **scene** only when up; island LiveKit only if scene is down.
   *   No dual island+scene voice bind / mic publish.
   */
  getVoiceLiveKitRooms(): Room[] {
    const room = this.getPrimaryLiveKitRoom()
    return room ? [room] : []
  }

  /** Ensure Genesis archipelago control plane is up (island LiveKit follows assignment). */
  async ensureArchipelagoConnected(): Promise<void> {
    if (this.isWorldComms()) return
    // Prefer bound scene parcel; only (0,0,0) if no scene target yet (shell friends online).
    const seed = this.presenceSeedGenesisMeters()
    this.archipelago.ensurePresenceSeed(seed ?? undefined)
    if (this.archipelago.isWelcomed() && this.islandConnected) {
      // Re-assert parcel seed so we leave a wrong island after navigation.
      if (seed) this.archipelago.ensurePresenceSeed(seed)
      return
    }
    if (this.archipelago.isConnected() && this.archipelago.isWelcomed()) {
      if (seed) this.archipelago.ensurePresenceSeed(seed)
      return
    }
    // Handshake in flight — do not disconnect()/reconnect (that flapped the WS forever).
    if (this.archipelago.isConnecting() || this.archipelago.isConnected()) {
      if (seed) this.archipelago.ensurePresenceSeed(seed)
      return
    }
    const ok = await this.connectRealmComms()
    this.archipelago.ensurePresenceSeed(seed ?? this.presenceSeedGenesisMeters() ?? undefined)
    if (!ok) {
      clientDebugLog.log('network', 'ensureArchipelagoConnected · failed (no adapter?)', {
        level: 'warn',
        throttleMs: 10_000,
        throttleKey: 'archipelago-ensure-fail'
      })
    }
  }

  /** Archipelago WS status for voice diagnostics. */
  describeArchipelago(): string {
    return this.archipelago.describe()
  }

  /** Debug: which LiveKit rooms are up (for voice diagnostics). */
  describeLiveKitRooms(): string {
    const parts: string[] = []
    for (const [label, s] of [
      ['scene', this.sceneLiveKit],
      ['world', this.worldLiveKit],
      ['island', this.islandLiveKit]
    ] as const) {
      const room = s.getRoom()
      const st = room?.state ?? 'none'
      const name = room?.name?.slice(0, 40) ?? '-'
      parts.push(`${label}:${st}${s.isConnected() ? '*' : ''}(${name})`)
    }
    const voice = this.getVoiceLiveKitRooms()
      .map((r) => (r.name || '?').slice(0, 28))
      .join('+')
    parts.push(`voice=[${voice || 'none'}]`)
    parts.push(`archipelago={${this.archipelago.describe()}}`)
    return parts.join(' ')
  }

  /**
   * Multi-line dump of remote audio pubs on **all** LiveKit rooms (scene/world/island).
   * Used to debug “voice on world but silent on parcel scene” — e.g. mic on island only.
   */
  describeAllRoomsAudioInventory(): string {
    const lines: string[] = []
    for (const [label, s] of [
      ['scene', this.sceneLiveKit],
      ['world', this.worldLiveKit],
      ['island', this.islandLiveKit]
    ] as const) {
      const room = s.getRoom()
      if (!room || !s.isConnected()) {
        lines.push(`${label}: offline`)
        continue
      }
      const n = room.remoteParticipants.size
      if (n === 0) {
        lines.push(`${label}: ${room.name?.slice(0, 36) ?? '?'} remotes=0`)
        continue
      }
      for (const p of room.remoteParticipants.values()) {
        const pubs = [...p.trackPublications.values()].map(
          (pub) =>
            `${pub.kind}/${pub.source}/sub=${pub.isSubscribed}/muted=${pub.isMuted}/hasTrack=${!!pub.track}`
        )
        lines.push(
          `${label}: peer=${(p.identity ?? '').slice(0, 12)} pubs=[${pubs.join(' | ') || 'none'}]`
        )
      }
    }
    return lines.join('\n')
  }

  private trackPeerLeave(address: string, transport: TransportType): void {
    const key = address.toLowerCase()
    const sources = this.peerTransports.get(key)
    if (!sources) return
    sources.delete(transport)
    if (sources.size === 0) {
      this.peerTransports.delete(key)
      this.profileRequestAt.delete(key)
      this.handlers?.onPeerLeave(key)
    }
  }

  private disconnectSceneTransports(): void {
    this.sceneLiveKit.disconnect()
    this.rfc5.disconnect()
    // Always drop world room too — otherwise switching world→parcel (or world→world)
    // leaves the previous world's LiveKit peers/chat path half-alive (see dual room polls).
    if (this.worldLiveKit.isConnected() || this.worldConnected) {
      this.worldLiveKit.disconnect()
      this.worldConnected = false
      this.clearPeerTransport(TransportType.World)
    }
    this.transport = 'none'
    this.realm.isConnectedSceneRoom = false
    this.pendingTransform = null
    // Drop queued scene CRDT so a rejoin does not feed stale REQ/RES into the new worker.
    this.inboundQueue.clear()
    this.clearPeerTransport(TransportType.SceneRoom)
    this.clearPeerTransport(TransportType.WebsocketRoom)
  }

  private disconnectAllTransports(): void {
    this.releaseWalletSessionIfHeld()
    this.archipelago.disconnect()
    this.islandLiveKit.disconnect()
    this.sceneLiveKit.disconnect()
    this.worldLiveKit.disconnect()
    this.rfc5.disconnect()
    this.transport = 'none'
    this.islandConnected = false
    this.worldConnected = false
    this.realm.isConnectedSceneRoom = false
    this.pendingTransform = null
    this.peerTransports.clear()
    this.topicService.clear()
    this.inboundQueue.clear()
  }

  private clearPeerTransport(transport: TransportType): void {
    for (const [address, sources] of [...this.peerTransports.entries()]) {
      if (!sources.delete(transport)) continue
      if (sources.size === 0) {
        this.peerTransports.delete(address)
        this.handlers?.onPeerLeave(address)
      }
    }
  }

  /** Worlds use the world LiveKit room for Explorer chat; scene room is Cast/video. */
  private isWorldComms(): boolean {
    // Prefer explicit scene target — never infer "world" solely from a stale world LiveKit.
    if (this.sceneTarget?.isWorld != null) return this.sceneTarget.isWorld
    const pointer = this.sceneTarget?.pointer
    if (pointer) return !isParcelPointer(normalizePointer(pointer))
    return false
  }

  /**
   * Inbound chat de-dupe when both world + scene rooms are joined.
   * Worlds: Explorer chat is on **world** room (scene is Cast).
   * Parcels: prefer **scene** room.
   */
  private shouldAcceptChatTransport(transport: TransportType): boolean {
    if (this.isWorldComms()) {
      // Worlds: world room is primary; skip scene Cast room to avoid double chat.
      if (transport === TransportType.SceneRoom) return false
      return transport === TransportType.World || transport === TransportType.Island
    }
    // Parcels: Explorer peers may publish chat on scene OR island. Accept both;
    // SocialService.isDuplicateChat drops double-delivery. (Rejecting island hid all
    // Explorer chat when peers only published on the island room.)
    if (transport === TransportType.World && this.sceneLiveKit.isConnected()) return false
    return (
      transport === TransportType.SceneRoom ||
      transport === TransportType.Island ||
      transport === TransportType.World
    )
  }

  /**
   * LiveKit rooms for **chat / DCM media / emotes** — primary room only.
   * Dual-publish (world + scene) makes Explorer show every message twice because
   * peers join both rooms on worlds (world = chat, scene = Cast).
   * Worlds → world room; parcels → scene room (fallback world/island).
   */
  /** World + scene when both are up — VFX/trade one-shots must hit whichever room the peer shares. */
  private liveKitBroadcastSessions(): LiveKitCommsSession[] {
    const out: LiveKitCommsSession[] = []
    if (this.worldConnected && this.worldLiveKit.isConnected()) out.push(this.worldLiveKit)
    if (this.sceneLiveKit.isConnected()) out.push(this.sceneLiveKit)
    if (!out.length && this.islandConnected && this.islandLiveKit.isConnected()) {
      out.push(this.islandLiveKit)
    }
    return out
  }

  private liveKitChatSessions(): LiveKitCommsSession[] {
    if (this.isWorldComms()) {
      if (this.worldConnected && this.worldLiveKit.isConnected()) return [this.worldLiveKit]
      if (this.sceneLiveKit.isConnected()) return [this.sceneLiveKit]
      return []
    }
    if (this.sceneLiveKit.isConnected()) return [this.sceneLiveKit]
    if (this.worldConnected && this.worldLiveKit.isConnected()) return [this.worldLiveKit]
    if (this.islandConnected && this.islandLiveKit.isConnected()) return [this.islandLiveKit]
    return []
  }

  /** Primary LiveKit session for RFC4 scene binary (scene room, else world room). */
  private activeDataSession(): LiveKitCommsSession | null {
    if (this.sceneLiveKit.isConnected()) return this.sceneLiveKit
    if (this.worldConnected) return this.worldLiveKit
    return null
  }

  /**
   * LiveKit rooms for DAV custom-avatar sync — **single media room** (same as movement/voice).
   * Dual-publish was dual work; peers on the media room receive WantAnnounce/Fetch.
   */
  private liveKitDavSessions(): LiveKitCommsSession[] {
    const media = this.mediaLiveKitSession()
    return media ? [media] : []
  }
}
