import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { needsCommsPeerProfile, type CommsProfileEntity } from '../avatar/peerApi'
import { encodeRfc4ProfileRequestPacket } from './comms/dclRfc4Comms'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { resolveCommsSceneId } from './catalyst/CatalystClient'
import { normalizePointer, realmNameForCommsPointer, isParcelPointer } from './catalyst/pointer'
import type { RealmEndpoints } from '../dcl/content/types'
import { fetchSceneParticipants, getSceneAdapter } from './gatekeeper/GatekeeperClient'
import {
  acquireWalletSessionLock,
  isWalletListedInScene,
  refreshWalletSessionLock,
  releaseWalletSessionLock
} from './walletSessionGuard'
import { AdapterManager } from './comms/AdapterManager'
import { ArchipelagoClient } from './comms/ArchipelagoClient'
import { CommsInboundQueue } from './comms/CommsInboundQueue'
import { CommsTopicService } from './comms/CommsTopicService'
import { LiveKitCommsSession } from './comms/LiveKitCommsSession'
import { parseCommsSceneOrigin, realmBoundsFromParcels, type RealmBounds } from './comms/movementCompressed'
import { encodeRfc4SceneBinaryPacket, Rfc4Router } from './comms/Rfc4Router'
import { Rfc5RoomClient } from './comms/Rfc5RoomClient'
import { isLiveKitAdapter } from './comms/livekitAdapter'
import type { ActiveVideoStream } from './comms/livekitVideoStreams'
import { TransportType } from './comms/Transport'
import {
  decodeTransformPayload,
  encodeTransformPayload,
  type AvatarTransformPayload,
  type CommsRealmInfo
} from './comms/types'

const BROADCAST_INTERVAL_MS = 100

export type SceneCommsFailureReason =
  | 'duplicate_wallet'
  | 'no_identity'
  | 'scene_id'
  | 'gatekeeper'
  | 'livekit'

export type SceneCommsConnectResult = { ok: true } | { ok: false; reason: SceneCommsFailureReason }

export type SceneCommsTarget = {
  pointer: string
  baseParcel: string
  sceneId: string
  realmName: string
  contentUrl: string
  parcels?: string[]
  isWorld?: boolean
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
  private topicMessageHandler: ((topic: string, sender: string, payload: Uint8Array) => void) | null = null
  private lastBroadcast = 0
  private pendingTransform: AvatarTransformPayload | null = null
  private sceneTarget: SceneCommsTarget | null = null
  private realmBounds: RealmBounds | null = null
  private sceneOrigin: ReturnType<typeof parseCommsSceneOrigin> = null
  private sceneOriginMeters: { x: number; z: number } = { x: 0, z: 0 }
  private emoteIncrementalId = 0
  private readonly peerTransports = new Map<string, Set<TransportType>>()
  private realm: CommsRealmInfo

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
          jumpCount: locomotion?.jumpCount
        })
      },
      onProfileRequest: (address) => {
        if (address !== this.localAddress) return
        this.sceneLiveKit.sendProfileAnnouncement('profile-request')
        this.worldLiveKit.sendProfileAnnouncement('profile-request')
        this.islandLiveKit.sendProfileAnnouncement('profile-request')
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
        if (transport === TransportType.World && this.sceneLiveKit.isConnected()) return
        if (transport === TransportType.Island) return
        this.chatHandler?.({ senderAddress: address, text, time })
      }
    })

    for (const session of [this.islandLiveKit, this.sceneLiveKit, this.worldLiveKit]) {
      session.setPacketHandler((transport, address, data) => {
        this.router.handlePacket(transport, address, data)
      })
      session.setTopicHandler((topic, address, data) => {
        this.topicService.enqueue(topic, address, data)
        this.topicMessageHandler?.(topic, address, data)
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

  setLambdasUrl(url: string): void {
    for (const session of [this.islandLiveKit, this.sceneLiveKit, this.worldLiveKit]) {
      session.setLambdasUrl(url)
    }
  }

  setHandlers(handlers: CommsPeerHandlers | null): void {
    this.handlers = handlers
  }

  setSceneBinaryHandler(handler: SceneBinaryHandler | null): void {
    this.sceneBinaryHandler = handler
  }

  setChatHandler(handler: SceneChatHandler | null): void {
    this.chatHandler = handler
  }

  setTopicMessageHandler(
    handler: ((topic: string, sender: string, payload: Uint8Array) => void) | null
  ): void {
    this.topicMessageHandler = handler
  }

  async sendSceneChat(text: string): Promise<boolean> {
    const sessions = this.liveKitChatSessions()
    if (!sessions.length) {
      clientDebugLog.log('comms', 'Chat send skipped — no LiveKit session connected', { level: 'warn' })
      return false
    }
    let sent = false
    for (const session of sessions) {
      if (await session.publishChat(text)) sent = true
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
    return {
      ...this.realm,
      room: this.sceneTarget?.pointer ?? this.realm.room,
      isConnectedSceneRoom:
        this.transport === 'livekit'
          ? this.sceneLiveKit.isConnected() || this.worldLiveKit.isConnected()
          : this.rfc5.isConnected()
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
    if (!hint) return false

    const parsed = this.adapterManager.parse(hint)
    clientDebugLog.log(
      'comms',
      `Realm comms adapter · ${parsed?.kind ?? 'unknown'} ${hint.slice(0, 64)}`,
      { level: 'info' }
    )

    const connected = await this.adapterManager.connect(hint, 'world')
    this.worldConnected = this.worldLiveKit.isConnected()
    return connected
  }

  async connectSceneRoom(target: SceneCommsTarget): Promise<SceneCommsConnectResult> {
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
    clientDebugLog.log(
      'comms',
      `Scene origin: baseParcel=${target.baseParcel} → world offset (${this.sceneOriginMeters.x}, ${this.sceneOriginMeters.z})m | bounds=(${this.realmBounds?.minX},${this.realmBounds?.minY})→(${this.realmBounds?.maxX},${this.realmBounds?.maxY})`
    )
    this.router.setRealmBounds(this.realmBounds)
    this.router.setSceneOrigin(target.baseParcel)
    this.syncRealmBoundsToSessions()

    if (!this.localAddress || !this.identity) {
      clientDebugLog.log('comms', 'Wallet login required for production comms', { level: 'warn' })
      return { ok: false, reason: 'no_identity' }
    }

    if (!acquireWalletSessionLock(this.localAddress)) {
      clientDebugLog.log('comms', 'Blocked second client — wallet already active in another tab', {
        level: 'error'
      })
      return { ok: false, reason: 'duplicate_wallet' }
    }

    const realmName = realmNameForCommsPointer(target.pointer)

    try {
      const alreadyInScene = await isWalletListedInScene(target.pointer, realmName, this.localAddress)
      if (alreadyInScene) {
        releaseWalletSessionLock(this.localAddress)
        clientDebugLog.log(
          'comms',
          `Blocked second client — ${this.localAddress.slice(0, 8)}… already in scene`,
          { level: 'error' }
        )
        return { ok: false, reason: 'duplicate_wallet' }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('comms', `scene-participants preflight failed: ${msg}`, { level: 'warn' })
    }

    this.walletSessionLockHeld = true
    const isWorld = target.isWorld ?? !isParcelPointer(normalizePointer(target.pointer))

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

    this.disconnectSceneTransports()
    this.realm = {
      ...this.realm,
      realmName,
      baseUrl: target.contentUrl,
      isPreview: false,
      isConnectedSceneRoom: false
    }

    await this.connectRealmComms(target.contentUrl)

    if (isWorld) {
      clientDebugLog.log('comms', `Joining world comms · pointer=${target.pointer}`, { level: 'info' })
      if (!this.worldConnected) {
        this.releaseWalletSessionIfHeld()
        clientDebugLog.log('comms', 'World LiveKit failed to connect', { level: 'error' })
        return { ok: false, reason: 'livekit' }
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

      clientDebugLog.log('comms', 'Transport: LiveKit world room · RFC4 Movement + chat', {
        level: 'success'
      })
      return { ok: true }
    }

    clientDebugLog.log('comms', `Joining scene room · pointer=${target.pointer} scene=${sceneId.slice(0, 12)}…`)

    const parcel = isParcelPointer(normalizePointer(target.pointer))
      ? normalizePointer(target.pointer)
      : normalizePointer(target.baseParcel)

    clientDebugLog.log(
      'comms',
      `Gatekeeper request · realm=${realmName} parcel=${parcel} scene=${sceneId.slice(0, 12)}… world=false`,
      { level: 'info' }
    )

    const adapterResult = await getSceneAdapter(this.identity, {
      sceneId,
      parcel,
      realmName,
      isWorld: false
    })
    if (!adapterResult.ok) {
      this.releaseWalletSessionIfHeld()
      clientDebugLog.log('comms', `Gatekeeper failed: ${adapterResult.error}`, { level: 'error' })
      return { ok: false, reason: 'gatekeeper' }
    }

    clientDebugLog.log('comms', 'Gatekeeper adapter received · connecting scene LiveKit…', { level: 'success' })

    this.realm.commsAdapter = adapterResult.adapter

    const connected = await this.sceneLiveKit.connect(adapterResult.adapter)
    if (!connected) {
      this.releaseWalletSessionIfHeld()
      clientDebugLog.log('comms', 'Scene LiveKit failed to connect', { level: 'error' })
      return { ok: false, reason: 'livekit' }
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

    clientDebugLog.log('comms', 'Transport: LiveKit scene room · RFC4 Movement + Scene packets', {
      level: 'success'
    })
    return { ok: true }
  }

  async connectAdapter(connectionString: string, roomHint?: string): Promise<boolean> {
    const trimmed = connectionString.trim()
    if (!trimmed) return false
    if (!this.localAddress || !this.identity) return false

    if (isLiveKitAdapter(trimmed)) {
      this.disconnectSceneTransports()
      this.realm.commsAdapter = trimmed
      const connected = await this.sceneLiveKit.connect(trimmed)
      this.transport = connected ? 'livekit' : 'none'
      this.realm.isConnectedSceneRoom = connected
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

  /** Scene-room wallets for @-mentions — gatekeeper seed list + LiveKit remotes. */
  getSceneChatMentionAddresses(): string[] {
    const self = this.localAddress
    const addresses = new Set<string>()
    for (const [address, sources] of this.peerTransports) {
      if (!sources.has(TransportType.SceneRoom)) continue
      if (self && address === self) continue
      addresses.add(address)
    }
    for (const address of this.sceneLiveKit.getRemotePeerAddresses()) {
      if (self && address === self) continue
      addresses.add(address)
    }
    return [...addresses].sort((a, b) => a.localeCompare(b))
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
    }
  ): void {
    if (this.transport === 'livekit') {
      this.pendingTransform = { type: 'avatar-transform', x, y, z, yaw }
      if (this.sceneLiveKit.isConnected()) {
        this.sceneLiveKit.queueTransform(x, y, z, yaw, isEmoting, locomotion)
      }
      if (this.worldConnected) {
        this.worldLiveKit.queueTransform(x, y, z, yaw, isEmoting, locomotion)
      }
      if (this.islandConnected) {
        this.islandLiveKit.queueTransform(x, y, z, yaw, isEmoting, locomotion)
      }
      this.archipelago.queuePosition(x, y, z)
      return
    }
    if (!this.rfc5.isConnected()) return
    this.pendingTransform = { type: 'avatar-transform', x, y, z, yaw }
  }

  flushBroadcast(now = performance.now()): void {
    if (this.walletSessionLockHeld && this.localAddress) {
      refreshWalletSessionLock(this.localAddress)
    }
    if (this.transport === 'livekit') {
      if (this.sceneLiveKit.isConnected()) this.sceneLiveKit.flushBroadcast(now, BROADCAST_INTERVAL_MS)
      if (this.worldConnected) this.worldLiveKit.flushBroadcast(now, BROADCAST_INTERVAL_MS)
      if (this.islandConnected) this.islandLiveKit.flushBroadcast(now, BROADCAST_INTERVAL_MS)
      return
    }
    if (!this.pendingTransform || now - this.lastBroadcast < BROADCAST_INTERVAL_MS) return
    this.rfc5.send(encodeTransformPayload(this.pendingTransform), true)
    this.lastBroadcast = now
    this.pendingTransform = null
  }

  async sendBinary(data: Uint8Array[], addresses: string[] = []): Promise<Uint8Array[]> {
    void addresses
    if (this.transport !== 'livekit' || !this.sceneId) {
      if (!this.rfc5.isConnected()) return this.inboundQueue.drain()
      for (const chunk of data) this.rfc5.send(chunk, false)
      return this.inboundQueue.drain()
    }

    for (const chunk of data) {
      const packet = encodeRfc4SceneBinaryPacket(this.sceneId, chunk)
      const session = this.activeDataSession()
      if (!session) return this.inboundQueue.drain()
      await session.publishData(packet)
    }
    return this.inboundQueue.drain()
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

  disconnect(): void {
    this.disconnectAllTransports()
  }

  dispose(): void {
    this.disconnectAllTransports()
    this.handlers = null
    this.sceneBinaryHandler = null
    this.topicMessageHandler = null
    this.chatHandler = null
    this.sceneTarget = null
    this.peerTransports.clear()
    this.topicService.clear()
    this.inboundQueue.clear()
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
    const connected = await this.islandLiveKit.connect(connStr)
    this.islandConnected = connected
    if (connected) {
      clientDebugLog.log('comms', 'Island LiveKit connected (archipelago)', { level: 'success' })
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
    return connected
  }

  private connectWsRoom(wsUrl: string, roomHint?: string): boolean {
    if (!this.localAddress || !this.identity) return false
    this.disconnectAllTransports()
    this.realm = {
      ...this.realm,
      commsAdapter: `ws-room:${wsUrl}`,
      room: roomHint ?? this.realm.room,
      isConnectedSceneRoom: false
    }

    this.rfc5.connect(wsUrl, this.localAddress, this.identity, {
      onWelcome: (_alias, peers) => {
        this.transport = 'rfc5'
        this.realm.isConnectedSceneRoom = true
        for (const address of peers.values()) {
          if (address === this.localAddress) continue
          this.handlers?.onPeerJoin(address)
        }
      },
      onPeerJoin: (_alias, address) => {
        if (address === this.localAddress) return
        this.handlers?.onPeerJoin(address)
      },
      onPeerLeave: (alias) => {
        const address = this.rfc5.getAddressForAlias(alias)
        if (address) this.handlers?.onPeerLeave(address)
      },
      onPeerUpdate: (fromAlias, body) => {
        const address = this.rfc5.getAddressForAlias(fromAlias)
        if (!address || address === this.localAddress) return
        const payload = decodeTransformPayload(body)
        if (payload) this.handlers?.onPeerTransform(address, payload)
      },
      onDisconnect: () => {
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

    const packet = encodeRfc4ProfileRequestPacket(key, profileVersion)
    let sent = false
    for (const session of [this.sceneLiveKit, this.worldLiveKit, this.islandLiveKit]) {
      if (!session.isConnected()) continue
      void session.publishData(packet)
      sent = true
    }
    if (sent) {
      clientDebugLog.log(
        'comms',
        `RFC4 ProfileRequest → ${key.slice(0, 8)}… v${profileVersion}`,
        { throttleMs: 1500, throttleKey: `profile-req:${key}` }
      )
    }
  }

  private trackPeerLeave(address: string, transport: TransportType): void {
    const key = address.toLowerCase()
    const sources = this.peerTransports.get(key)
    if (!sources) return
    sources.delete(transport)
    if (sources.size === 0) {
      this.peerTransports.delete(key)
      this.handlers?.onPeerLeave(key)
    }
  }

  private disconnectSceneTransports(): void {
    this.sceneLiveKit.disconnect()
    this.rfc5.disconnect()
    this.transport = 'none'
    this.realm.isConnectedSceneRoom = false
    this.pendingTransform = null
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

  /** LiveKit rooms that carry scene chat (ADR-204: island + scene/world). */
  private liveKitChatSessions(): LiveKitCommsSession[] {
    const sessions: LiveKitCommsSession[] = []
    if (this.sceneLiveKit.isConnected()) sessions.push(this.sceneLiveKit)
    if (this.worldConnected && this.worldLiveKit.isConnected()) sessions.push(this.worldLiveKit)
    if (this.islandConnected && this.islandLiveKit.isConnected()) sessions.push(this.islandLiveKit)
    return sessions
  }

  /** Primary LiveKit session for RFC4 scene binary (scene room, else world room). */
  private activeDataSession(): LiveKitCommsSession | null {
    if (this.sceneLiveKit.isConnected()) return this.sceneLiveKit
    if (this.worldConnected) return this.worldLiveKit
    return null
  }
}
