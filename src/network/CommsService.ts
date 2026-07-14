import type { AuthIdentity } from '@dcl/crypto/dist/types'
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
import { clearCastVideoHost, reattachFirstRemoteVideoToHost } from './comms/livekitVideoStreams'
import {
  parseCommsSceneOrigin,
  realmBoundsFromParcels,
  sceneLocalToGenesis,
  type RealmBounds
} from './comms/movementCompressed'
import { encodeRfc4SceneBinaryPacket, Rfc4Router } from './comms/Rfc4Router'
import { DAV_SCENE_ID } from '../avatar/vrm/dclClientAvatar'
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
  | 'scene_ban'
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
  sceneTitle?: string
  /** Catalyst `metadata.policy.blacklist` — checked again before comms connect. */
  metadataBlacklist?: string[]
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
      },
      onPeerChatMedia: (address, data, transport) => {
        if (transport === TransportType.World && this.sceneLiveKit.isConnected()) return
        if (transport === TransportType.Island) return
        this.chatMediaHandler?.({ senderAddress: address, data })
      },
      onPeerAvatarVrm: (address, data, transport) => {
        if (transport === TransportType.World && this.sceneLiveKit.isConnected()) return
        if (transport === TransportType.Island) return
        this.avatarVrmHandler?.(address, data)
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

  setChatMediaHandler(handler: SceneChatMediaHandler | null): void {
    this.chatMediaHandler = handler
  }

  setAvatarVrmHandler(handler: ((sender: string, data: Uint8Array) => void) | null): void {
    this.avatarVrmHandler = handler
  }

  /** DAV v1 — custom VRM P2P on RFC4 Scene `dcl.client.avatar`. */
  async sendSceneAvatarVrm(envelopes: Uint8Array[]): Promise<boolean> {
    const sessions = this.liveKitChatSessions()
    if (!sessions.length || !envelopes.length) return false
    const paceEvery = envelopes.length > 8 ? 8 : 0
    const paceMs = envelopes.length > 64 ? 8 : 2
    let sent = false
    for (const session of sessions) {
      try {
        for (let i = 0; i < envelopes.length; i++) {
          const packet = encodeRfc4SceneBinaryPacket(DAV_SCENE_ID, envelopes[i]!)
          await session.publishReliableData(packet)
          if (paceEvery > 0 && i > 0 && i % paceEvery === 0) {
            await new Promise((resolve) => setTimeout(resolve, paceMs))
          }
        }
        sent = true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        clientDebugLog.log('comms', `DAV publish failed: ${msg}`, { level: 'error' })
      }
    }
    return sent
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

    const realmName = gatekeeperRealmNameForComms(target)

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
        this.releaseWalletSessionIfHeld()
        if (adapterResult.status === 403 || adapterResult.status === 401) {
          clientDebugLog.log('comms', `Scene access denied at comms connect: ${adapterResult.error}`, {
            level: 'error'
          })
          return { ok: false, reason: 'scene_ban' }
        }
        clientDebugLog.log('comms', `Gatekeeper failed: ${adapterResult.error}`, { level: 'error' })
        return { ok: false, reason: 'gatekeeper' }
      }
      sceneAdapter = adapterResult.adapter
    }

    clientDebugLog.log('comms', 'Gatekeeper adapter received · connecting scene LiveKit…', { level: 'success' })

    this.realm.commsAdapter = sceneAdapter

    const connected = await this.sceneLiveKit.connect(sceneAdapter)
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

  /** LiveKit remote participant counts (debug / frame-60 diagnostics). */
  getLivePeerCounts(): { scene: number; island: number; world: number; islandConnected: boolean } {
    return {
      scene: this.sceneLiveKit.getRemotePeerAddresses().length,
      island: this.islandLiveKit.getRemotePeerAddresses().length,
      world: this.worldLiveKit.getRemotePeerAddresses().length,
      islandConnected: this.islandConnected
    }
  }

  /** Seed archipelago with spawn so island assignment does not wait for first post-start frame. */
  seedArchipelagoSceneLocal(x: number, y: number, z: number): void {
    if (this.sceneOrigin) {
      const g = sceneLocalToGenesis(x, y, z, this.sceneOrigin)
      this.archipelago.queuePosition(g.x, g.y, g.z)
      return
    }
    this.archipelago.queuePosition(x, y, z)
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
      // Archipelago heartbeats are genesis (world) meters — not scene-local.
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

  /** Prefer scene room, then world, then island LiveKit sessions. */
  private preferredLiveKitSession() {
    if (this.sceneLiveKit.isConnected()) return this.sceneLiveKit
    if (this.worldLiveKit.isConnected()) return this.worldLiveKit
    if (this.islandLiveKit.isConnected()) return this.islandLiveKit
    return null
  }

  private connectedLiveKitSessions() {
    return [this.sceneLiveKit, this.worldLiveKit, this.islandLiveKit].filter((s) => s.isConnected())
  }

  /** Bind `livekit-video://current-stream` to a scene VideoPlayer HTML element. */
  bindLiveKitVideoSource(video: HTMLVideoElement, onUpdate?: () => void): () => void {
    // Cast/OBS lives on the scene room for worlds — prefer it for attach.
    const session = this.preferredLiveKitSession()
    if (!session) return () => {}
    return session.bindCurrentVideoStream(video, onUpdate)
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
      console.log('[cast] bindRemoteCastVideoToHost: no LiveKit sessions')
      return () => {}
    }

    for (const s of sessions) {
      const room = s.getRoom()
      if (room) void room.startAudio().catch(() => {})
    }

    let lastOk = false
    let ticks = 0
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

      ticks += 1
      const ordered = [...sessions].sort((a, b) => {
        const aScene = a.getRoomName().includes('scene-room') ? 0 : 1
        const bScene = b.getRoomName().includes('scene-room') ? 0 : 1
        if (aScene !== bScene) return aScene - bScene
        const aLive = a.hasRemoteVideoLive() ? 0 : 1
        const bLive = b.hasRemoteVideoLive() ? 0 : 1
        return aLive - bLive
      })

      let attached = false
      const diag: string[] = []
      for (const s of ordered) {
        const room = s.getRoom()
        if (!room) continue
        const snap = s.getRemoteVideoPresenceSnapshot()
        diag.push(
          `${s.getRoomName().slice(0, 40) || '?'} remotes=${snap.remoteParticipants} video=${snap.remoteVideoPubs}`
        )
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

      if (ticks <= 6 || attached !== lastOk) {
        console.log(`[cast] attach tick=${ticks} ok=${attached} · ${diag.join(' | ') || 'no rooms'}`)
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
    // Poll only while not attached (late RTMP publisher).
    const poll = window.setInterval(() => {
      if (!lastOk) tryAll(false)
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
        console.log('[cast] scene room joined for Cast detection (late / retry)')
        clientDebugLog.log('cast', 'Scene LiveKit joined for Cast detection', {
          level: 'success',
          alsoConsole: true
        })
      }
      return ok
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[cast] ensureSceneRoomForCastDetection failed', msg)
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
    this.chatHandler = null
    this.chatMediaHandler = null
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
    clientDebugLog.log(
      'network',
      connected
        ? `Island LiveKit connected (archipelago) · remotes=${this.islandLiveKit.getRemotePeerAddresses().length}`
        : 'Island LiveKit connect failed (archipelago)',
      { level: connected ? 'success' : 'error', alsoConsole: true }
    )
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
