import type { Entity } from '@dcl/ecs'
import type { ResolvedScene } from '../dcl/content/types'
import * as THREE from 'three'
import { createTerrainModel } from '../dcl/landscape/Worlds/TerrainModel'
import { getSessionAssetCache, prefetchSceneManifestGlbs } from '../rendering/AssetCache'
import { SceneHost } from '../rendering/SceneHost'
import { PhysXWorld } from '../physics/PhysXWorld'
import { PlayerSystem } from '../player/PlayerSystem'
import { sceneWorldBounds } from '../player/SceneBounds'
import { LandscapeSystem } from './systems/LandscapeSystem'
import { SceneScriptSystem } from './systems/SceneScriptSystem'
import { EnvironmentSystem } from '../environment/EnvironmentSystem'
import { WaterPlane } from '../environment/WaterPlane'
import { SessionIdentity } from '../network/SessionIdentity'
import { RemoteAvatarManager } from '../network/RemoteAvatarManager'
import { CommsService } from '../network/CommsService'
import { buildEmoteWheelSlots, resolveSceneEmoteFromSrc } from '../avatar/profileEmotes'
import { SocialService } from '../social/SocialService'
import { overheadChatText } from '../social/overheadChatText'
import { fetchProfileFaceUrl, seedCommsPeerProfile } from '../avatar/peerApi'
import type { LoginResult } from '../auth/AuthClient'
import {
  performGetSignedHeaders,
  performSignedFetch,
  type SignedFetchSceneContext
} from '../network/SignedFetchService'
import { shortenAddress } from '../avatar/displayName'
import { buildPlayerMirrorIdentity, getOrCreateGuestAddress } from '../bridge/playerMirrorIdentity'
import type { AvatarAttachTargetResolver } from '../avatar/AvatarAttachTargets'
import { dclToThreeVec, type DclTransformValues } from '../bridge/dclTransform'
import type { PhysicsColliderDesc } from '../physics/PhysXWorld'

import { openExternalUrl } from '../player/openExternalUrl'
import { ReservedEntitiesSync } from '../bridge/ReservedEntitiesSync'
import { waitForSceneAssets, type WaitForSceneAssetsOptions } from '../rendering/sceneHydration'
import { LightManager } from '../rendering/LightManager'
import { clearGeometryCookCache } from '../physics/geometryToPxMesh'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { skipRemoteAvatars } from '../client/devFlags'
import { physxColliderDebug } from '../debug/PhysxColliderDebug'

function useOrbitMode(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('orbit')
}

/** Top-level world — analogous to Unity Explorer client world root. */
export class World {
  readonly assets = getSessionAssetCache()
  readonly landscape = new LandscapeSystem()
  readonly sceneScript = new SceneScriptSystem()
  readonly physics = new PhysXWorld()
  readonly session = new SessionIdentity()
  readonly comms = new CommsService()
  readonly social = new SocialService()
  readonly host: SceneHost
  readonly environment: EnvironmentSystem
  private readonly lightManager: LightManager
  private water: WaterPlane | null = null
  private player: PlayerSystem | null = null
  private remoteAvatars: RemoteAvatarManager | null = null
  private playerMode = !useOrbitMode()
  private lastGltfColliderCount = 0
  private loggedGltfPhysMismatch = false
  private collidersPhysLastLog = 0
  private loggedCollidersPhysNoHit = false
  private loggedFinalizePoseDiag = false
  private loggedRuntimeRecookDisabled = false
  private collidersLoadingComplete = false
  private lastPhysicsBatchFp = ''
  private signedFetchSceneContext: SignedFetchSceneContext | null = null
  private sceneCommsConnected = false
  private authoritativeCrdtRetryTimers: number[] = []
  private pendingColliderCooks = 0
  private readonly colliderCookQueue = new Set<number>()
  /** Extract colliders while GLBs attach; PhysX cook runs once after hydration is idle. */
  private deferPhysxCooks = true
  private readonly colliderCookPriority = new THREE.Vector3()
  private warmStaticScenePending = false
  private bootAssetsTimedOut = false
  /** Runtime burst (e.g. theatre Scene 11/12) — drain with loading-style recook until idle. */
  private runtimeColliderBurstUntil = 0
  private unsubAvatarChat: (() => void) | null = null

  /** Per-tick budget while GLBs still attaching on the loading screen. */
  private static readonly HYDRATION_COLLIDER_COOK_BUDGET = 80
  /** Per-frame budget during the post-hydration loading drain. */
  private static readonly LOADING_COLLIDER_COOK_BUDGET = 96
  private static readonly RUNTIME_COLLIDER_COOK_BUDGET = 24
  /** Burst cook after dynamic scene spawns (theatre) — higher per-frame budget. */
  private static readonly RUNTIME_COLLIDER_BURST_BUDGET = 64
  private static readonly RUNTIME_COLLIDER_BURST_MS = 12_000
  private static readonly RUNTIME_COLLIDER_BURST_QUEUE = 24
  /** Hard cap for the single boot cook — load fails if the queue is not drained in time. */
  private static readonly LOADING_COLLIDER_WALL_MS = 180_000
  private static readonly LOADING_COLLIDER_WALL_TIMED_OUT_MS = 120_000
  private static readonly COLLIDER_COOK_PROGRESS_START = 0.82
  private static readonly COLLIDER_COOK_PROGRESS_RANGE = 0.12

  constructor(container: HTMLElement) {
    this.host = new SceneHost(container)
    this.lightManager = new LightManager(this.host.scene)
    this.environment = new EnvironmentSystem(this.host, this.lightManager)
    this.player = new PlayerSystem(this.host, this.physics)
    this.sceneScript.setClientPoseProvider(() => ({
      player: this.player!.getEntityPose(),
      camera: this.player!.getCameraEntityPose()
    }))
    this.remoteAvatars = new RemoteAvatarManager(this.host.scene)

    this.remoteAvatars && this.comms.setHandlers({
      onPeerJoin: (address) => {
        if (skipRemoteAvatars()) return
        if (address === this.session.getAddress()?.toLowerCase()) return
        this.remoteAvatars?.upsertPeer(address)
        void this.social.ensurePeerProfile(address)
      },
      onPeerLeave: (address) => {
        if (skipRemoteAvatars()) return
        this.remoteAvatars?.removePeer(address)
      },
      onPeerTransform: (address, payload) => {
        if (skipRemoteAvatars()) return
        this.remoteAvatars?.updatePeerTransform(
          address,
          new THREE.Vector3(payload.x, payload.y, payload.z),
          payload.yaw,
          payload.vx !== undefined
            ? new THREE.Vector3(payload.vx, payload.vy ?? 0, payload.vz ?? 0)
            : undefined,
          {
            isGrounded: payload.isGrounded,
            isJumping: payload.isJumping,
            jumpCount: payload.jumpCount
          }
        )
      },
      onPeerProfile: (address, serializedProfile) => {
        if (skipRemoteAvatars()) return
        seedCommsPeerProfile(address, serializedProfile)
        this.remoteAvatars?.applyPeerProfile(address, serializedProfile)
        this.social.rememberPeerProfile(address, serializedProfile)
      },
      onPeerEmote: (address, urn, incrementalId) => {
        if (skipRemoteAvatars()) return
        this.remoteAvatars?.playPeerEmote(address, urn, incrementalId)
      }
    })

    this.comms.setSceneBinaryHandler((sender, data) => {
      this.sceneScript.deliverCommsBinary(sender, data)
    })
    this.comms.setAuthServerJoinHandler(() => {
      this.sceneScript.syncRealmInfo(this.comms.getRealmInfo())
      this.requestAuthoritativeSceneStateIfReady()
    })
    this.sceneScript.setOnWorkerReady(() => {
      this.requestAuthoritativeSceneStateIfReady()
    })
    this.sceneScript.setOnAuthoritativeBulkReceived(() => {
      this.clearAuthoritativeCrdtRetries()
    })
    this.comms.setTopicMessageHandler((topic, sender, payload) => {
      if (topic !== 'comms') return
      const message = new TextDecoder().decode(payload)
      this.sceneScript.engineApiEvents.pushCommsMessage(message, sender)
    })
  }

  applyLogin(choice: LoginResult | null): void {
    this.session.applyLogin(choice)
    this.comms.setIdentity(this.session.getAddress(), this.session.getAuthIdentity())
  }

  private buildCommsTarget(scene: ResolvedScene) {
    return {
      pointer: scene.commsPointer,
      baseParcel: scene.baseParcel,
      sceneId: scene.entityId ?? '',
      realmName: scene.realm.realmName,
      contentUrl: scene.realm.contentUrl,
      parcels: scene.parcels,
      isWorld: scene.source.kind === 'world'
    }
  }

  /** REQ_CRDT_STATE only after the scene worker can receive RES_CRDT_STATE (early comms drops otherwise). */
  private requestAuthoritativeSceneStateIfReady(): void {
    if (!this.sceneCommsConnected || !this.comms.expectsRemoteAuthoritativeServer()) return
    if (!this.comms.hasRemoteAuthoritativeServer()) return
    this.comms.requestAuthoritativeCrdtState(true)
    this.scheduleAuthoritativeCrdtRetries()
  }

  /** Authoritative server can answer after scene-room handshake — retry bulk state request. */
  private scheduleAuthoritativeCrdtRetries(): void {
    this.clearAuthoritativeCrdtRetries()
    for (const delayMs of [2_000, 5_000, 10_000]) {
      const timer = window.setTimeout(() => {
        if (!this.sceneCommsConnected || !this.comms.hasRemoteAuthoritativeServer()) return
        this.comms.requestAuthoritativeCrdtState(true)
      }, delayMs)
      this.authoritativeCrdtRetryTimers.push(timer)
    }
  }

  private clearAuthoritativeCrdtRetries(): void {
    for (const timer of this.authoritativeCrdtRetryTimers) clearTimeout(timer)
    this.authoritativeCrdtRetryTimers.length = 0
  }

  async loadScene(scene: ResolvedScene, onProgress?: (msg: string) => void): Promise<void> {
    this.clearAuthoritativeCrdtRetries()
    if (skipRemoteAvatars()) {
      clientDebugLog.log('network', 'Remote avatars disabled (?noremote)', {
        alsoConsole: true,
        throttleMs: 60_000
      })
    }
    this.assets.setScene(scene)
    prefetchSceneManifestGlbs(this.assets, scene)
    this.comms.setIdentity(this.session.getAddress(), this.session.getAuthIdentity())
    this.comms.applyRealmAbout(scene.realm, scene.commsPointer)
    this.session.setCatalystEndpoints(scene.realm.contentUrl, scene.realm.lambdasUrl)
    this.remoteAvatars?.setCatalystEndpoints(scene.realm.contentUrl, scene.realm.lambdasUrl)
    this.remoteAvatars?.setAssetCache(this.assets)

    const bounds = sceneWorldBounds(scene.parcels, scene.baseParcel)
    this.host.configureViewDistance(bounds)

    onProgress?.('Setting up sky…')
    await this.environment.init(scene)

    await this.landscape.initialize(scene, this.assets, onProgress)
    if (this.landscape.state.landscapeRoot) {
      this.host.scene.add(this.landscape.state.landscapeRoot)
    }

    this.water = new WaterPlane(scene.parcels, scene.baseParcel, 1)
    this.host.scene.add(this.water.mesh)

    onProgress?.('Initialising physics…')
    await this.physics.init()
    const terrain = createTerrainModel(scene.parcels, 1)
    this.physics.syncLandscapeGround(terrain.landscapeParcelKeys, scene.baseParcel, scene.parcels)

    if (scene.mainEntry && scene.entityId) {
      this.sceneScript.prepare(scene, this.assets, this.host)
      this.sceneScript.setLiveKitVideoBinder((video, onUpdate) =>
        this.comms.bindLiveKitVideoSource(video, onUpdate)
      )
      if (this.landscape.state.landscapeRoot) {
        this.sceneScript.gltfColliders?.setLandscapeRoot(this.landscape.state.landscapeRoot)
      }
      this.remoteAvatars?.setEntityStore(this.sceneScript.getEntityStore())
      dclToThreeVec(
        new THREE.Vector3(scene.spawn.x, scene.spawn.y, scene.spawn.z),
        this.colliderCookPriority
      )
      this.sceneScript.setCollidersCookCallback((entity) => this.onColliderCookRequest(entity))
      this.sceneScript.setCollidersPoseCallback((entities) => this.applyColliderPoseSlides(entities))
      this.sceneScript.setCommsHandler({
        setCommunicationsAdapter: async (body) => ({
          success: await this.comms.connectAdapter(body.connectionString)
        }),
        isServer: async () => ({ isServer: this.comms.isEngineServer() }),
        sendBinary: async (body) => this.comms.handleSceneSendBinary(body),
        send: async (body) => {
          await this.comms.publishCommsMessage(body.message)
          return {}
        },
        getUserData: async () => this.buildUserData(),
        getRealm: async () => ({ realmInfo: this.comms.getRealmInfo() }),
        subscribeToTopic: async (body) => {
          this.comms.subscribeToTopic(body.topic)
          return {}
        },
        unsubscribeFromTopic: async (body) => {
          this.comms.unsubscribeFromTopic(body.topic)
          return {}
        },
        publishData: async (body) => {
          await this.comms.publishTopicData(body.topic, body.data)
          return {}
        },
        consumeMessages: async (body) => this.comms.consumeMessages(body.topic),
        getActiveVideoStreams: async () => this.comms.getActiveVideoStreams()
      })
      this.signedFetchSceneContext = {
        sceneId: scene.entityId ?? '',
        parcel: scene.baseParcel,
        realmName: scene.realm.realmName,
        isWorld: scene.source.kind === 'world'
      }
      this.sceneScript.setSignedFetchHandler(async (body) =>
        performSignedFetch(body, this.session.getAuthIdentity(), this.signedFetchSceneContext)
      )
      this.sceneScript.setSignedFetchGetHeadersHandler(async (body) =>
        performGetSignedHeaders(body, this.session.getAuthIdentity())
      )
      this.sceneScript.setOpenExternalUrlHandler((request) => openExternalUrl(request))
    }

    if (this.playerMode && this.player) {
      onProgress?.('Connecting profile…')
      await this.session.connect(onProgress)
      this.comms.setIdentity(this.session.getAddress(), this.session.getAuthIdentity())
      this.comms.setCommsProfile(this.session.getCommsProfileEntity())
      this.sceneScript.setPlayerIdentity(
        buildPlayerMirrorIdentity({
          address: this.session.getAddress(),
          profile: this.session.getProfile()
        })
      )

      this.sceneScript.setMovePlayerHandler((request) => this.player!.movePlayerTo(request))
      this.sceneScript.setTriggerEmoteHandler((request) => {
        const emote = request.predefinedEmote?.trim()
        if (!emote) return false
        clientDebugLog.log('pointer', `triggerEmote → ${emote}`, { alsoConsole: true })
        void this.playLocalEmote(emote, { loop: undefined })
        return true
      })
      this.sceneScript.setTriggerSceneEmoteHandler((request) => {
        const src = request.src?.trim()
        if (!src) return false
        console.log('[pointer]', `triggerSceneEmote handler — src=${src}`)
        const resolved = resolveSceneEmoteFromSrc(src, request.loop ?? false)
        if (!resolved) {
          console.warn('[pointer]', `triggerSceneEmote miss — ${src}`)
          clientDebugLog.log('pointer', `triggerSceneEmote miss — ${src}`, { level: 'warn', alsoConsole: true })
          return false
        }
        console.log('[pointer]', `triggerSceneEmote → ${resolved.urn}`)
        clientDebugLog.log('pointer', `triggerSceneEmote → ${resolved.urn}`, { alsoConsole: true })
        void this.playLocalEmote(resolved.urn, { loop: resolved.loop })
        return true
      })
      this.sceneScript.setAvatarEmoteHandler({
        play: (emoteUrn, loop) => {
          if (!emoteUrn.trim()) return false
          void this.playLocalEmote(emoteUrn.trim(), { loop, broadcast: true })
          return true
        },
        stop: () => this.player!.stopEmote()
      })
    } else {
      this.host.focusSpawn(scene)
      this.host.setOrbitEnabled(true)
      this.sceneScript.setPlayerIdentity(buildPlayerMirrorIdentity({}))
    }

    if (scene.mainEntry && scene.entityId) {
      onProgress?.('Booting scene script…')
      const spawnPoses = this.seedPosesFromSpawn(scene.spawn)
      this.sceneScript.seedRendererEntities(spawnPoses.player, spawnPoses.camera)
      try {
        await this.sceneScript.start(scene, this.assets, this.host)
        if (this.sceneCommsConnected) {
          this.sceneScript.syncRealmInfo(this.comms.getRealmInfo())
        }
        onProgress?.('Scene script running')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        onProgress?.(`Scene script error: ${msg}`)
        console.error(err)
      }
    }
  }

  /**
   * Connect scene comms during the loading screen so remote peers arrive while assets hydrate.
   * Receive-only until `start()` — idempotent; safe to call before `spawnLocalPlayer`.
   */
  async connectSceneCommsEarly(scene: ResolvedScene, onProgress?: (msg: string) => void): Promise<void> {
    if (!this.playerMode || this.sceneCommsConnected) return

    const address = this.session.getAddress()
    const identity = this.session.getAuthIdentity()
    if (!address || !identity) return

    onProgress?.(
      scene.source.kind === 'world' ? 'Joining world comms…' : 'Joining scene comms room…'
    )
    this.comms.setIdentity(address, identity)
    this.comms.setCommsProfile(this.session.getCommsProfileEntity())
    this.comms.setLambdasUrl(scene.realm.lambdasUrl)
    this.remoteAvatars?.setLocalAddress(address)
    const connectResult = await this.comms.connectSceneRoom(this.buildCommsTarget(scene))
    if (connectResult.ok) {
      this.sceneCommsConnected = true
      this.sceneScript.syncRealmInfo(this.comms.getRealmInfo())
      clientDebugLog.log('comms', 'Early scene comms connected during hydration', { level: 'success' })
      onProgress?.('Receiving peer updates…')
      return
    }
    if (connectResult.reason === 'duplicate_wallet') {
      onProgress?.('This wallet is already connected in another session — close the other client first')
      return
    }
    onProgress?.('Comms connection failed — check console')
  }

  /**
   * Spawn local player after scene script + assets are ready — PhysX ground plane must exist first.
   * Authoritative GLTF cook runs here (after final renderer sync), then capsule init.
   * Call after `waitForSceneAssets` and `prewarmPhysicsColliders`, before `start()`.
   */
  async spawnLocalPlayer(scene: ResolvedScene, onProgress?: (msg: string) => void): Promise<void> {
    if (!this.playerMode || !this.player) return
    if (!this.collidersLoadingComplete) {
      await this.bootCookPhysicsColliders(scene, onProgress, {
        assetsTimedOut: this.bootAssetsTimedOut
      })
    }

    const bounds = sceneWorldBounds(scene.parcels, scene.baseParcel)

    onProgress?.('Spawning player…')
    await this.player.initCapsule(scene.spawn, bounds, this.sceneScript.readComponents, onProgress)
    this.sceneScript.setSpatialAudioPlayerRoot(() => this.player!.getPlayerRoot())
    const spawnStatic = this.physics.staticColliderCount
    const spawnGltf = this.physics.gltfStaticActorCount
    const gltfStats = this.sceneScript.gltfColliders?.getPhysicsExtractionStats()
    const probe = this.physics.debugProbeStaticHit(2.5)
    const downProbe = this.physics.debugProbeDownHit(8)
    const pos = this.player.getPosition()
    const feetThree = this.player.getWorldPosition()
    const nearestGltf = this.nearestGltfColliderHorizDist(feetThree)
    const sceneProbe = this.physics.probeSceneMeshDownAt(feetThree, 12)
    console.info(
      `[World] player spawn — static=${spawnStatic} gltfRegistered=${spawnGltf} gltfExtracted=${this.lastGltfColliderCount}` +
        (gltfStats
          ? ` shapes(inv=${gltfStats.invisibleShapes} vis=${gltfStats.visibleShapes})`
          : '') +
        (pos ? ` feet=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})` : '') +
        ` probeH=${probe.distance !== null ? `${probe.distance.toFixed(2)}m` : 'none'}` +
        ` sceneProbe=${sceneProbe !== null ? `${sceneProbe.toFixed(2)}m` : 'none'}` +
        ` nearestGltf=${nearestGltf !== null ? `${nearestGltf.toFixed(1)}m` : 'none'}` +
        ` probeDown=${downProbe !== null ? `${downProbe.toFixed(2)}m` : 'none'}`
    )
    this.logBootColliderDiag(feetThree)
    this.sceneScript.syncClientEntities(this.player.getEntityPose(), this.player.getCameraEntityPose())

    const address = this.session.getAddress()
    const identity = this.session.getAuthIdentity()
    if (address && identity) {
      if (!this.sceneCommsConnected) {
        onProgress?.(
          scene.source.kind === 'world' ? 'Joining world comms…' : 'Joining scene comms room…'
        )
        this.comms.setIdentity(address, identity)
        this.comms.setCommsProfile(this.session.getCommsProfileEntity())
        this.comms.setLambdasUrl(scene.realm.lambdasUrl)
        this.remoteAvatars?.setLocalAddress(address)
        const connectResult = await this.comms.connectSceneRoom(this.buildCommsTarget(scene))
        this.sceneCommsConnected = connectResult.ok
        if (connectResult.ok) {
          onProgress?.('Connected to DCL comms')
          this.sceneScript.syncRealmInfo(this.comms.getRealmInfo())
        } else if (connectResult.reason === 'duplicate_wallet') {
          onProgress?.('This wallet is already connected in another session — close the other client first')
        } else {
          onProgress?.('Comms connection failed — check console')
        }
      }

      onProgress?.('Loading social services…')
      const profile = this.session.getProfile()
      await this.social.init({
        address,
        identity,
        isGuest: false,
        sceneTab: {
          key: scene.commsPointer,
          label: scene.title || scene.commsPointer,
          pointer: scene.commsPointer
        },
        comms: this.comms,
        contentUrl: scene.realm.contentUrl
      })
      if (profile) {
        void fetchProfileFaceUrl(address, scene.realm.lambdasUrl).then((faceUrl) => {
          this.social.setLocalProfile(
            address,
            profile.displayName ?? 'You',
            faceUrl,
            profile.nameColor ?? undefined
          )
        })
      }
      onProgress?.(
        this.social.getCommunities().length
          ? `Social ready · ${this.social.getCommunities().length} communities`
          : 'Social ready'
      )
      this.wireAvatarChatOverhead()
    }

    onProgress?.('Loading avatar…')
    this.player.setAssetCache(this.assets, scene.realm.contentUrl)
    await this.player.loadAvatar(onProgress)
    this.bindAvatarAttachTargets()
    this.sceneScript.bindPointerEvents(
      () => this.player!.getWorldPosition(),
      () => this.player!.isPointerBlocked(),
      () => this.physics
    )
    this.player.setOnUserGestureUnlock(() => {
      this.sceneScript.setVideoUserGestureUnlocked(true)
    })
  }

  private seedPosesFromSpawn(spawn: { x: number; y: number; z: number }) {
    const position = new THREE.Vector3(spawn.x, spawn.y, spawn.z)
    return {
      player: {
        position: position.clone(),
        rotation: ReservedEntitiesSync.playerRotationFromYaw(0)
      },
      camera: {
        position: position.clone(),
        rotation: ReservedEntitiesSync.playerRotationFromYaw(0)
      }
    }
  }

  private bindAvatarAttachTargets(): void {
    const { readComponents, view } = this.sceneScript
    const { Transform, PlayerIdentityData } = readComponents
    const { PlayerEntity } = view

    const resolver: AvatarAttachTargetResolver = {
      getLocalWallet: () => {
        if (PlayerIdentityData.has(PlayerEntity)) {
          return (PlayerIdentityData.get(PlayerEntity) as { address?: string }).address?.toLowerCase()
        }
        return this.session.getAddress()?.toLowerCase() ?? getOrCreateGuestAddress().toLowerCase()
      },
      getLocalSkeleton: () => {
        const avatar = this.player?.getLocalAvatar()
        const model = avatar?.getModel()
        if (!avatar || !model) return null
        return { model, nameTagAnchor: avatar.nameTagAnchor }
      },
      getRemoteSkeleton: (avatarId) => this.remoteAvatars?.getAttachSkeleton(avatarId) ?? null,
      getNpcSkeleton: (entity) => this.sceneScript.getAvatarShapeSkeleton(entity),
      getPlayerTransformDcl: (avatarId) => {
        const localWallet = resolver.getLocalWallet()
        const id = avatarId?.trim().toLowerCase()
        if (!id || (localWallet && id === localWallet)) {
          if (!Transform.has(PlayerEntity)) return null
          return Transform.get(PlayerEntity) as DclTransformValues
        }
        const remote = this.remoteAvatars?.getPlayerTransformDclForAddress(id)
        if (remote) return remote
        for (const [playerEntity, identity] of view.getEntitiesWith(PlayerIdentityData)) {
          const address = (identity as { address?: string }).address?.toLowerCase()
          if (address !== id) continue
          if (Transform.has(playerEntity)) return Transform.get(playerEntity) as DclTransformValues
        }
        return null
      }
    }

    this.sceneScript.setAvatarAttachTargets(resolver)
  }

  /** Block until scene GLBs/textures hydrate — call after `loadScene`, before `start()`. */
  waitForSceneAssets(
    scene: ResolvedScene,
    onProgress?: (msg: string, fraction?: number) => void,
    options?: WaitForSceneAssetsOptions
  ) {
    const spawnCamera = new THREE.Vector3(scene.spawn.x, scene.spawn.y, scene.spawn.z)
    if (!skipRemoteAvatars()) {
      this.remoteAvatars?.setCameraPosition(spawnCamera)
      this.remoteAvatars?.setHydrationLoading(true)
    }

    const hydration = waitForSceneAssets(scene, this.sceneScript, this.assets, onProgress, {
      ...options,
      onPrimeRender: () => this.primeRender(),
      onHydrationTick: (stats) => {
        if (!skipRemoteAvatars()) {
          this.remoteAvatars?.setSceneAssetPressure(stats.gltfInflight, stats.textureInflight)
        }
        options?.onHydrationTick?.(stats)
      }
    })
    if (!hydration) {
      if (!skipRemoteAvatars()) this.remoteAvatars?.setHydrationLoading(false)
      return
    }
    return hydration.finally(() => {
      if (!skipRemoteAvatars()) this.remoteAvatars?.setHydrationLoading(false)
    })
  }

  /** One visible frame (sky/landscape/camera) before the loading overlay hides. */
  primeRender(): void {
    this.water?.update(0)
    this.lightManager.update(this.host.camera.position)
    this.environment.update(0, this.sceneScript.view, this.sceneScript.readComponents)
    this.player?.snapCamera()
    this.host.renderFrame()
    const entityRoot = this.host.scene.getObjectByName('scene-entities')
    const hydration = this.sceneScript.getHydrationStats()
    console.info(
      '[World] primeRender — camera:',
      this.host.camera.position.toArray().map((n) => n.toFixed(2)),
      'sceneChildren:', this.host.scene.children.length,
      'entityNodes:', hydration?.entityCount ?? entityRoot?.children.length ?? 0,
      'gltf:', hydration ? `${hydration.gltfLoaded}/${hydration.gltfEntities}` : 'n/a',
      hydration?.gltfUnresolved ? `unresolved:${hydration.gltfUnresolved}` : '',
      'playerMode:', this.playerMode
    )
  }

  start(): void {
    this.sceneScript.setVideoUserGestureUnlocked(true)
    let startFrame = 0
    this.host.start({
      onSyncFrame: (delta) => {
        startFrame++
        this.water?.update(delta)
        this.lightManager.update(this.host.camera.position)
        if (!skipRemoteAvatars()) {
          this.remoteAvatars?.setCameraPosition(this.host.camera.position)
        }
        this.environment.update(delta, this.sceneScript.view, this.sceneScript.readComponents)

        if (this.playerMode && this.player) {
          this.player.update(delta)
          this.sceneScript.syncClientEntities(this.player.getEntityPose(), this.player.getCameraEntityPose())
          this.sceneScript.updateTriggerAreas()
          this.sceneScript.updateRaycasts()
          this.sceneScript.updatePointerEvents(startFrame)

          const pos = this.player.getPosition()
          const yaw = this.player.getNetworkYaw()
          const isEmoting = this.player.isProfileEmoteActive()
          const locomotion = this.player.getLocomotionWireState()
          this.comms.broadcastTransform(pos.x, pos.y, pos.z, yaw, isEmoting, locomotion)

          if (startFrame === 60) {
            const worldX = pos.x + (this.comms.getSceneOrigin()?.x ?? 0)
            const worldZ = pos.z + (this.comms.getSceneOrigin()?.z ?? 0)
            console.info('[World] frame 60 — playerSceneLocal:', `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
              'playerWorld:', `(${worldX.toFixed(1)}, ${pos.y.toFixed(1)}, ${worldZ.toFixed(1)})`,
              'sceneOrigin:', this.comms.getSceneOrigin(),
              'cam:', this.host.camera.position.toArray().map((n) => n.toFixed(1)),
              'remotePeers:', this.remoteAvatars?.visiblePeerCount ?? 0,
              'gltfCached:', this.assets.getLoadStats().gltfCached)
          }
        }

        if (!skipRemoteAvatars()) {
          this.remoteAvatars?.update(delta)
        }
        this.comms.flushBroadcast()

        // Tweens / billboards / GLTF animators — sync frame, before render (not async-gated).
        this.sceneScript.pumpMotionBridges(delta, startFrame)
        // Campfire sprite UV animation — sync frame (tiny tracked set, self-prunes static planes).
        this.sceneScript.syncAnimatedSprites()
        // Texture retries — sync frame so failed loads don't block async projection drain.
        this.sceneScript.tickDeferredMaterials()
      },
      onAsyncFrame: async (_delta) => {
        await this.sceneScript.syncRenderer()
        this.sceneScript.syncCollision()

        if (this.playerMode && this.player) {
          this.applyPhysicsColliders()
          this.logCollidersPhysDebug()
        }

        await this.sceneScript.syncAsyncBridges()
      }
    })
  }

  /** Runtime pose-drift recook — off unless `?colliderrecook` or Help debug toggle. Boot + manual recook bypass. */
  private allowsRuntimeColliderRecook(): boolean {
    return physxColliderDebug.isRuntimeRecookEnabled()
  }

  private logRuntimeRecookDisabledOnce(): void {
    if (this.loggedRuntimeRecookDisabled || this.allowsRuntimeColliderRecook()) return
    this.loggedRuntimeRecookDisabled = true
    console.info(
      '[World] runtime collider recook disabled — boot cook + pose slides only; add ?colliderrecook or enable in Help (?) to allow drift recook'
    )
  }

  private applyPhysicsColliders(): void {
    if (!this.playerMode || !this.collidersLoadingComplete || this.deferPhysxCooks) return
    this.logRuntimeRecookDisabledOnce()
    const batchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()
    const fpDrifted = batchFp !== this.lastPhysicsBatchFp
    const cookPending = this.colliderCookQueue.size > 0
    const colliderWork = this.sceneScript.hasColliderWorkPending()

    if (fpDrifted) {
      const posesSynced = this.sceneScript.hadColliderPoseSyncThisPass()
      if (!posesSynced) {
        // Entity-local actors only — world-baked trimesh recooks run per-entity when
        // syncCollision reports an actual pose change (not blanket batch-drift sweeps).
        this.sceneScript.refreshColliderDescPoses()
        this.pushColliderPosesToPhysX()
      }
      this.lastPhysicsBatchFp = batchFp
    }

    if (!cookPending && !fpDrifted && !colliderWork) return

    this.reconcileColliderCookQueue()
    if (cookPending && this.allowsRuntimeColliderRecook()) {
      this.drainRuntimeColliderCookQueue()
    }
  }

  /** Runtime PhysX cook — prioritize near-player, burst-drain after composite spawns (theatre). */
  private drainRuntimeColliderCookQueue(): void {
    if (!this.allowsRuntimeColliderRecook()) return
    const pending = this.colliderCookQueue.size
    if (pending === 0) return

    const burstActive = performance.now() < this.runtimeColliderBurstUntil
    if (pending >= World.RUNTIME_COLLIDER_BURST_QUEUE || burstActive) {
      let passes = 0
      const maxPasses = burstActive ? 12 : 6
      while (this.colliderCookQueue.size > World.RUNTIME_COLLIDER_COOK_BUDGET && passes < maxPasses) {
        this.drainColliderCookQueue({ loading: true })
        passes++
      }
    }
    if (this.colliderCookQueue.size > 0) {
      this.drainColliderCookQueue({ initialOnly: true })
    }
  }

  /** Near-player colliders first — theatre floors under the avatar cook before distant props. */
  private sortedColliderCookQueue(): number[] {
    const ids = [...this.colliderCookQueue]
    const feet = this.player?.getWorldPosition()
    if (!feet || ids.length <= 1) return ids

    const distSq = (physId: number): number => {
      const desc = this.sceneScript.getPhysicsColliderDesc(physId)
      if (!desc) return Number.POSITIVE_INFINITY
      const dx = desc.matrix.elements[12]! - feet.x
      const dz = desc.matrix.elements[14]! - feet.z
      return dx * dx + dz * dz
    }
    ids.sort((a, b) => distSq(a) - distSq(b))
    return ids
  }

  /** Runtime tween / transform pose slide — only the entities that moved. */
  private applyColliderPoseSlides(changedEntities: Entity[]): void {
    if (!changedEntities.length) return
    const physIds: number[] = []
    for (const entity of changedEntities) {
      physIds.push(...this.sceneScript.collectPhysCookTargets(entity))
    }
    this.applyColliderPoseSlidesForPhysIds(physIds)
  }

  private collectColliderDescs(physIds: number[]): PhysicsColliderDesc[] {
    const descs: PhysicsColliderDesc[] = []
    for (const physId of physIds) {
      const desc = this.sceneScript.getPhysicsColliderDesc(physId)
      if (desc) descs.push(desc)
    }
    return descs
  }

  /** Incremental pose push — entity-local actors only; world-baked drift is queued for recook. */
  private applyColliderPoseSlidesForPhysIds(physIds: number[]): void {
    if (!this.playerMode || !physIds.length) return
    for (const physId of physIds) {
      this.sceneScript.refreshColliderPose(physId)
    }
    const descs = this.collectColliderDescs(physIds)
    const slideDescs: PhysicsColliderDesc[] = []
    for (const desc of descs) {
      if (this.physics.needsWorldBakedPoseRecook(desc)) {
        if (this.allowsRuntimeColliderRecook() && this.isColliderDescNearPlayer(desc)) {
          this.colliderCookQueue.add(desc.entity)
        }
        continue
      }
      slideDescs.push(desc)
    }
    const updated = this.physics.applyStaticColliderPoseUpdates(slideDescs)
    if (updated > 0) this.scheduleWarmStaticScene()
    if (this.colliderCookQueue.size > 0 && this.collidersLoadingComplete) {
      this.drainColliderCookQueue({ initialOnly: true })
    }
  }

  /** Coalesce runtime CCT cache warms to once per frame. */
  private scheduleWarmStaticScene(): void {
    if (this.warmStaticScenePending) return
    this.warmStaticScenePending = true
    requestAnimationFrame(() => {
      this.warmStaticScenePending = false
      this.physics.warmStaticScene()
    })
  }

  /** Pose slide only — never recooks geometry (runtime + post-spawn CRDT drain). */
  private pushColliderPosesToPhysX(options?: { force?: boolean }): void {
    if (!this.playerMode) return
    this.sceneScript.refreshColliderDescPoses()
    const descs = this.sceneScript.getAllPhysicsColliderDescs()
    const force = options?.force === true
    const updated = this.physics.applyStaticColliderPoseUpdates(descs, { force })
    if (updated > 0) this.physics.warmStaticScene()
    this.lastPhysicsBatchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()
  }

  /** Runtime world-baked recook — only colliders near the avatar (theatre tweens skip distant drift). */
  private isColliderDescNearPlayer(desc: PhysicsColliderDesc, maxHoriz = 40): boolean {
    const feet = this.player?.getWorldPosition()
    if (!feet) return true
    const dx = desc.matrix.elements[12]! - feet.x
    const dz = desc.matrix.elements[14]! - feet.z
    return dx * dx + dz * dz <= maxHoriz * maxHoriz
  }

  private nearestGltfColliderHorizDist(feet: THREE.Vector3): number | null {
    let nearest: number | null = null
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (!desc.fingerprint.startsWith('gltf-entity:')) continue
      const dx = desc.matrix.elements[12]! - feet.x
      const dz = desc.matrix.elements[14]! - feet.z
      const d = Math.hypot(dx, dz)
      if (nearest === null || d < nearest) nearest = d
    }
    return nearest
  }

  /** After boot cook — log probe health at spawn feet (once). */
  private logBootColliderDiag(probeAt: THREE.Vector3): void {
    if (!this.playerMode || this.loggedFinalizePoseDiag) return
    if (this.physics.gltfStaticActorCount < 20) return
    this.loggedFinalizePoseDiag = true
    const descs = this.sceneScript.getAllPhysicsColliderDescs()
    let fpMismatch = 0
    let missingActor = 0
    for (const desc of descs) {
      if (!desc.fingerprint.startsWith('gltf-entity:')) continue
      if (!this.physics.hasStaticActor(desc.entity)) missingActor++
      else if (!this.physics.geomFingerprintMatches(desc)) fpMismatch++
    }
    const sceneProbe = this.physics.probeSceneMeshDownAt(probeAt, 12)
    const probe = this.physics.debugProbeDownHit(8)
    const nearestGltf = this.nearestGltfColliderHorizDist(probeAt)
    console.info(
      `[World] colliders booted — gltf=${this.physics.gltfStaticActorCount}` +
        (fpMismatch > 0 ? ` fpMismatch=${fpMismatch}` : '') +
        (missingActor > 0 ? ` missingActor=${missingActor}` : '') +
        ` sceneProbe=${sceneProbe !== null ? `${sceneProbe.toFixed(2)}m` : 'none'}` +
        ` nearestGltf=${nearestGltf !== null ? `${nearestGltf.toFixed(1)}m` : 'none'}` +
        ` probeDown=${probe !== null ? `${probe.toFixed(2)}m` : 'none'}`
    )
  }

  /** GLB attached (enqueue) or hydration tick / notifyPlayReady (reconcile + drain). */
  private onColliderCookRequest(ecsEntity?: Entity): void {
    const queueBefore = this.colliderCookQueue.size
    if (ecsEntity !== undefined) {
      const physIds = this.sceneScript.collectPhysCookTargets(ecsEntity)
      this.enqueueColliderCook(ecsEntity)
      this.maybeBeginRuntimeColliderBurst(queueBefore)
      if (this.collidersLoadingComplete) {
        this.drainColliderCookQueue({ initialOnly: true })
        this.applyColliderPoseSlidesForPhysIds(physIds)
      }
      return
    }
    this.reconcileColliderCookQueue()
    this.maybeBeginRuntimeColliderBurst(queueBefore)
    if (this.collidersLoadingComplete) {
      const touched = [...this.colliderCookQueue]
      this.drainColliderCookQueue({ initialOnly: true })
      this.applyColliderPoseSlidesForPhysIds(touched)
    }
  }

  /** Dynamic scene spawn (theatre) — short burst of higher PhysX cook budget. */
  private maybeBeginRuntimeColliderBurst(queueBefore: number): void {
    if (!this.collidersLoadingComplete) return
    const pending = this.colliderCookQueue.size
    const delta = pending - queueBefore
    if (
      pending >= World.RUNTIME_COLLIDER_BURST_QUEUE ||
      delta >= World.RUNTIME_COLLIDER_BURST_QUEUE
    ) {
      this.runtimeColliderBurstUntil = performance.now() + World.RUNTIME_COLLIDER_BURST_MS
      clientDebugLog.log(
        'collision',
        `Runtime collider burst — pending=${pending} (+${delta})`,
        { level: 'info', alsoConsole: true, throttleMs: 5_000 }
      )
    }
  }

  private enqueueColliderCook(ecsEntity: Entity): void {
    if (this.deferPhysxCooks) return
    for (const physId of this.sceneScript.collectPhysCookTargets(ecsEntity)) {
      if (this.collidersLoadingComplete) {
        this.sceneScript.refreshColliderPose(physId)
      } else if (!this.deferPhysxCooks) {
        this.sceneScript.refreshColliderBeforeCook(physId)
      }
      const desc = this.sceneScript.getPhysicsColliderDesc(physId)
      if (!desc || this.physics.isColliderSynced(desc)) {
        this.colliderCookQueue.delete(physId)
        continue
      }
      this.colliderCookQueue.add(physId)
    }
    this.pendingColliderCooks = this.colliderCookQueue.size
  }

  /** Scan extracted descriptors and queue any not yet in PhysX. */
  private reconcileColliderCookQueue(): void {
    if (this.deferPhysxCooks) {
      this.pendingColliderCooks = this.colliderCookQueue.size
      return
    }
    this.sceneScript.refreshColliderDescPoses()
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (
        this.collidersLoadingComplete &&
        this.physics.isWorldBakedStatic(desc.entity) &&
        this.physics.geomFingerprintMatches(desc)
      ) {
        if (this.physics.needsWorldBakedPoseRecook(desc)) {
          if (this.allowsRuntimeColliderRecook() && this.isColliderDescNearPlayer(desc)) {
            this.colliderCookQueue.add(desc.entity)
          } else {
            this.colliderCookQueue.delete(desc.entity)
          }
          continue
        }
        this.physics.ackStaticPoseFingerprint(desc)
        this.colliderCookQueue.delete(desc.entity)
        continue
      }
      if (this.physics.isColliderSynced(desc)) {
        this.colliderCookQueue.delete(desc.entity)
      } else {
        this.colliderCookQueue.add(desc.entity)
      }
    }
    this.pendingColliderCooks = this.colliderCookQueue.size
  }

  private colliderCookProgressFraction(registered: number, total: number): number {
    if (total <= 0) return World.COLLIDER_COOK_PROGRESS_START + World.COLLIDER_COOK_PROGRESS_RANGE
    const frac = Math.min(1, registered / total)
    return World.COLLIDER_COOK_PROGRESS_START + World.COLLIDER_COOK_PROGRESS_RANGE * frac
  }

  private drainColliderCookQueue(options?: {
    hydration?: boolean
    loading?: boolean
    /** Force entity-local cached cook (runtime only — boot uses world-baked via `loading`). */
    entityLocal?: boolean
    /** Post-load: register actors that have never been cooked — never remove/recook existing. */
    initialOnly?: boolean
  }): void {
    const burstActive = performance.now() < this.runtimeColliderBurstUntil
    const budget = options?.hydration
      ? World.HYDRATION_COLLIDER_COOK_BUDGET
      : options?.loading
        ? World.LOADING_COLLIDER_COOK_BUDGET
        : options?.initialOnly
          ? burstActive
            ? World.RUNTIME_COLLIDER_BURST_BUDGET
            : World.RUNTIME_COLLIDER_COOK_BUDGET
          : Number.POSITIVE_INFINITY

    const loadingPass = !!(options?.loading || options?.hydration)
    const toCook: PhysicsColliderDesc[] = []
    let worldBakedRecook = false
    const queueOrder = loadingPass ? [...this.colliderCookQueue] : this.sortedColliderCookQueue()
    for (const physId of queueOrder) {
      if (toCook.length >= budget) break
      if (loadingPass) {
        this.sceneScript.flushSceneGraphMatrices()
        this.sceneScript.refreshColliderBeforeCook(physId)
      } else {
        this.sceneScript.refreshColliderPose(physId)
      }
      const desc = this.sceneScript.getPhysicsColliderDesc(physId)
      if (!desc) {
        this.colliderCookQueue.delete(physId)
        continue
      }
      // Runtime: only register actors that have never been cooked; never remove/recook existing.
      if (!loadingPass && !this.allowsRuntimeColliderRecook() && this.physics.hasStaticActor(physId)) {
        this.colliderCookQueue.delete(physId)
        continue
      }
      if (!loadingPass && this.physics.isColliderSynced(desc)) {
        this.colliderCookQueue.delete(physId)
        continue
      }
      if (loadingPass) {
        this.physics.invalidateStaticCollider(physId)
      } else if (
        this.physics.isWorldBakedStatic(physId) &&
        desc &&
        this.physics.needsWorldBakedPoseRecook(desc)
      ) {
        // syncStaticColliders removes + recooks atomically — do not invalidate early.
        worldBakedRecook = true
      }
      if (options?.initialOnly && this.physics.hasStaticActor(physId)) {
        if (this.physics.isColliderSynced(desc)) {
          this.colliderCookQueue.delete(physId)
          continue
        }
        // Boot world-bake — keep actor when pose still matches; drift needs full recook below.
        if (
          this.physics.isWorldBakedStatic(physId) &&
          this.physics.geomFingerprintMatches(desc) &&
          !this.physics.needsWorldBakedPoseRecook(desc)
        ) {
          this.physics.ackStaticPoseFingerprint(desc)
          this.colliderCookQueue.delete(physId)
          continue
        }
        if (this.physics.geomFingerprintMatches(desc)) {
          if (this.physics.needsWorldBakedPoseRecook(desc)) {
            // fall through — world-baked actor needs a full recook
          } else if (!this.physics.isWorldBakedStatic(physId)) {
            // Entity-local actor — pose slide only (theatre / composite parent moves).
            this.physics.applyStaticColliderPoseUpdates([desc])
            this.colliderCookQueue.delete(physId)
            continue
          } else {
            this.physics.ackStaticPoseFingerprint(desc)
            this.colliderCookQueue.delete(physId)
            continue
          }
        }
      }
      toCook.push(desc)
    }

    if (!toCook.length) {
      this.pendingColliderCooks = this.colliderCookQueue.size
      this.refreshColliderCookStats()
      return
    }

    try {
      const bootStyleCook = loadingPass || worldBakedRecook
      const result = this.physics.syncStaticColliders(toCook, {
        cookBudget: toCook.length,
        freezeRemoval: true,
        // Loading + world-baked pose drift: full world-bake recook.
        forceRecookOnPoseChange: bootStyleCook,
        geometryCache: options?.entityLocal ? true : !bootStyleCook
      })
      for (const desc of toCook) {
        if (this.physics.isColliderSynced(desc)) {
          this.colliderCookQueue.delete(desc.entity)
        }
      }
      if (result.geometryChanged) {
        if (loadingPass) this.physics.warmStaticScene()
        else this.scheduleWarmStaticScene()
      }
    } catch (err) {
      console.warn('[World] per-entity collider cook failed:', err)
    }

    this.pendingColliderCooks = this.colliderCookQueue.size
    this.refreshColliderCookStats()
  }

  private refreshColliderCookStats(): void {
    const gltfEntityCount = this.sceneScript.gltfColliders?.getGltfEntityColliderCount() ?? 0
    this.lastGltfColliderCount = gltfEntityCount
    const batchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()
    if (batchFp !== this.lastPhysicsBatchFp) {
      this.lastPhysicsBatchFp = batchFp
    }

    const gltfRegisteredAfter = this.physics.gltfStaticActorCount
    if (
      gltfEntityCount > 0 &&
      gltfRegisteredAfter === 0 &&
      this.colliderCookQueue.size === 0 &&
      !this.deferPhysxCooks &&
      this.collidersLoadingComplete &&
      !this.loggedGltfPhysMismatch
    ) {
      this.loggedGltfPhysMismatch = true
      console.warn(
        `[World] ${gltfEntityCount} GLTF entity colliders extracted but 0 registered in PhysX — check cook failures in console`
      )
    } else if (gltfRegisteredAfter > 0) {
      this.loggedGltfPhysMismatch = false
    }
  }

  /**
   * Force a full collider re-extract + PhysX cook (Help panel — Recook colliders).
   * Clears fingerprint skip and failed-cook blacklist when `force` is true.
   */
  recookPhysicsColliders(options?: { force?: boolean; quiet?: boolean }): void {
    if (!this.playerMode || !this.player) return
    if (options?.force !== false) {
      this.lastPhysicsBatchFp = ''
      this.physics.clearFailedCookCaches()
      this.physics.clearAllSceneStaticActors()
      this.colliderCookQueue.clear()
      this.sceneScript.invalidateGltfColliderSyncCache()
    }
    this.sceneScript.flushSceneGraphMatrices()
    this.sceneScript.syncCollisionForce()
    this.reconcileColliderCookQueue()
    while (this.colliderCookQueue.size > 0) {
      this.drainColliderCookQueue({ loading: true })
    }
    this.pushColliderPosesToPhysX({ force: true })
    this.physics.recookWorldBakedPoseDrift(this.sceneScript.getAllPhysicsColliderDescs(), {
      forceAll: true
    })
    this.physics.warmStaticScene()
    if (!options?.quiet) {
      const mesh = this.sceneScript.collision?.getPhysicsColliders().length ?? 0
      const gltf = this.sceneScript.gltfColliders?.getPhysicsColliders().length ?? 0
      const probeH = this.physics.debugProbeStaticHit(2.5)
      const probeDown = this.physics.debugProbeDownHit(8)
      const horiz = probeH.distance !== null ? `${probeH.distance.toFixed(2)}m` : 'none'
      const down = probeDown !== null ? `${probeDown.toFixed(2)}m` : 'none'
      clientDebugLog.log(
        'collision',
        `Colliders recooked — static=${this.physics.staticColliderCount} mesh=${mesh} gltf=${gltf} probeH=${horiz} probeDown=${down}`,
        { level: 'success', alsoConsole: true }
      )
    }
  }

  private logCollidersPhysDebug(): void {
    if (!physxColliderDebug.isCollidersPhysEnabled()) return
    const now = performance.now()
    if (now - this.collidersPhysLastLog < 1000) return
    this.collidersPhysLastLog = now
    const probe = this.physics.debugProbeStaticHit()
    const hit = probe.distance !== null ? `${probe.distance.toFixed(2)}m` : 'none'
    const downProbe = this.physics.debugProbeDownHit(8)
    const physFeet = this.player?.getWorldPosition()
    const feet =
      physFeet !== undefined
        ? `feet=(${physFeet.x.toFixed(1)}, ${physFeet.y.toFixed(1)}, ${physFeet.z.toFixed(1)})`
        : ''
    const down = downProbe !== null ? `probeDown=${downProbe.toFixed(2)}m` : 'probeDown=none'
    const pending = this.pendingColliderCooks
    const pendingStr = pending > 0 ? ` pendingCook=${pending}` : ''
    console.info(
      `[collidersphys] static=${probe.staticCount} gltfRegistered=${probe.gltfCount} extracted=${this.lastGltfColliderCount} nearestHit=${hit} ${down}${feet ? ` ${feet}` : ''}${pendingStr}`
    )
    if (
      !this.loggedCollidersPhysNoHit &&
      probe.gltfCount >= 50 &&
      probe.distance === null &&
      this.player?.getPosition()
    ) {
      this.loggedCollidersPhysNoHit = true
      const pos = this.player.getPosition()!
      console.warn(
        `[collidersphys] no static hit within 2.5m of player at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) — ${probe.gltfCount} GLTF actors registered`
      )
    }
  }

  /**
   * Hydration follow-up: extract colliders from live Three.js poses — PhysX cook deferred to spawn.
   * Keeps hydration mode on so projection diff cannot drift transforms before the authoritative cook.
   */
  async prewarmPhysicsColliders(
    _scene: ResolvedScene,
    onProgress?: (msg: string, fraction?: number) => void,
    options: { assetsTimedOut?: boolean } = {}
  ): Promise<void> {
    if (!this.playerMode) return
    this.bootAssetsTimedOut = options.assetsTimedOut ?? false
    this.lastPhysicsBatchFp = ''
    this.collidersLoadingComplete = false
    this.deferPhysxCooks = true
    this.colliderCookQueue.clear()

    this.sceneScript.setAssetHydrationMode(true)
    onProgress?.('Preparing collisions…', World.COLLIDER_COOK_PROGRESS_START)
    await this.sceneScript.syncRendererFull()
    this.sceneScript.flushSceneGraphMatrices()
    this.sceneScript.invalidateGltfColliderSyncCache()
    this.sceneScript.syncCollisionForce()
    this.refreshColliderCookStats()
    const extracted = this.lastGltfColliderCount
    onProgress?.(
      extracted > 0 ? `Colliders extracted (${extracted} GLTF)…` : 'Preparing collisions…',
      World.COLLIDER_COOK_PROGRESS_START + World.COLLIDER_COOK_PROGRESS_RANGE * 0.25
    )
  }

  /**
   * Authoritative boot cook — runs immediately before player spawn after final ECS/renderer sync.
   * Entity-local trimesh + actor at world pose; no post-spawn pose fixups.
   */
  private async bootCookPhysicsColliders(
    scene: ResolvedScene,
    onProgress?: (msg: string, fraction?: number) => void,
    options: { assetsTimedOut?: boolean } = {}
  ): Promise<void> {
    const assetsTimedOut = options.assetsTimedOut ?? false
    const maxWallMs = assetsTimedOut
      ? World.LOADING_COLLIDER_WALL_TIMED_OUT_MS
      : World.LOADING_COLLIDER_WALL_MS
    const started = performance.now()

    this.sceneScript.setAssetHydrationMode(true)
    try {
      onProgress?.('Syncing scene…', World.COLLIDER_COOK_PROGRESS_START + World.COLLIDER_COOK_PROGRESS_RANGE * 0.3)
      await this.sceneScript.syncRendererFull()
      this.sceneScript.flushSceneGraphMatrices()
      this.sceneScript.invalidateGltfColliderSyncCache()
      this.sceneScript.syncCollisionForce()

      this.lastPhysicsBatchFp = ''
      this.deferPhysxCooks = false
      clearGeometryCookCache()
      this.physics.clearGltfStaticActors()
      this.physics.clearFailedCookCaches()
      this.colliderCookQueue.clear()
      this.reconcileColliderCookQueue()

      dclToThreeVec(
        new THREE.Vector3(scene.spawn.x, scene.spawn.y, scene.spawn.z),
        this.colliderCookPriority
      )

      while (this.colliderCookQueue.size > 0) {
        if (performance.now() - started > maxWallMs) {
          const pending = this.colliderCookQueue.size
          const registered = this.physics.gltfStaticActorCount
          const extracted = this.lastGltfColliderCount
          throw new Error(
            `[World] collider boot incomplete after ${(maxWallMs / 1000).toFixed(0)}s — ` +
              `gltf=${registered}/${extracted} pending=${pending}`
          )
        }

        // World-baked boot cook — matches Help → Force recook (entity-local boot left actors misaligned).
        this.drainColliderCookQueue({ loading: true })
        const gltfCount = this.lastGltfColliderCount
        const registered = this.physics.gltfStaticActorCount
        const pending = this.colliderCookQueue.size
        onProgress?.(
          `Cooking collisions… ${registered}/${gltfCount} GLTF` +
            (pending > 0 ? ` (${pending} left)` : ''),
          this.colliderCookProgressFraction(registered, gltfCount)
        )
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }

      this.physics.warmStaticScene()

      const finalRegistered = this.physics.gltfStaticActorCount
      const finalGltfCount = this.lastGltfColliderCount
      if (finalGltfCount > 0 && finalRegistered < finalGltfCount) {
        throw new Error(
          `[World] collider boot incomplete — gltf=${finalRegistered}/${finalGltfCount} PhysX actors`
        )
      }

      this.collidersLoadingComplete = true
      this.lastPhysicsBatchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()
      this.sceneScript.notifyPlayReady()

      const elapsedSec = ((performance.now() - started) / 1000).toFixed(1)
      const staticAfter = this.physics.staticColliderCount
      const downProbe = this.physics.probeSceneMeshDownAt(this.colliderCookPriority, 12)
      const nearestGltf = this.nearestGltfColliderHorizDist(this.colliderCookPriority)
      console.info(
        `[World] colliders ready — static=${staticAfter} gltf=${finalRegistered}/${finalGltfCount} (${elapsedSec}s)` +
          ` sceneProbe=${downProbe !== null ? `${downProbe.toFixed(2)}m` : 'none'}` +
          ` nearestGltf=${nearestGltf !== null ? `${nearestGltf.toFixed(1)}m` : 'none'}`
      )
      if (finalGltfCount >= 50 && downProbe === null) {
        let descProbeHits = 0
        let sampled = 0
        for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
          if (!desc.fingerprint.startsWith('gltf-entity:')) continue
          if (sampled >= 8) break
          sampled++
          const px = desc.matrix.elements[12]!
          const py = desc.matrix.elements[13]!
          const pz = desc.matrix.elements[14]!
          const probeAt = new THREE.Vector3(px, py + 2, pz)
          if (this.physics.probeSceneMeshDownAt(probeAt, 16) !== null) descProbeHits++
        }
        console.warn(
          `[World] spawn probe missed scene meshes — nearestDesc=${nearestGltf !== null ? `${nearestGltf.toFixed(1)}m` : 'none'}` +
            ` descProbes=${descProbeHits}/${sampled}`
        )
      }
      onProgress?.('Collisions ready', 0.96)
    } finally {
      this.sceneScript.setAssetHydrationMode(false)
    }
  }

  getPlayerPosition(): THREE.Vector3 | null {
    if (!this.playerMode || !this.player) return null
    return this.player.getPosition()
  }

  triggerPointerAction(
    action: import('../input/pointerConstants').InputActionValue,
    phase: 'down' | 'up'
  ): void {
    this.sceneScript.triggerPointerAction(action, phase)
  }

  setJumpHeld(down: boolean): void {
    this.player?.setJumpHeld(down)
  }

  playLocalEmote(emoteRef: string, options?: { loop?: boolean; broadcast?: boolean }): void {
    if (!this.playerMode || !this.player) return
    void this.player.playEmote(emoteRef, { loop: options?.loop }).then((resolved) => {
      if (resolved && options?.broadcast !== false) {
        void this.comms.broadcastEmote(resolved.urn)
      }
    })
  }

  getEmoteWheelSlots() {
    return buildEmoteWheelSlots(this.session.getProfile())
  }

  upsertRemotePeer(address: string, position?: THREE.Vector3): void {
    this.remoteAvatars?.upsertPeer(address, position)
  }

  removeRemotePeer(address: string): void {
    this.remoteAvatars?.removePeer(address)
  }


  private wireAvatarChatOverhead(): void {
    this.unsubAvatarChat?.()
    this.unsubAvatarChat = this.social.onChat((event) => {
      if (!event.channelKey.startsWith('scene:')) return
      const address = event.line.senderAddress?.toLowerCase()
      if (!address) return
      const text = overheadChatText(event.line.text)
      if (!text) return
      this.showAvatarOverheadChat(address, text)
    })
  }

  private showAvatarOverheadChat(address: string, text: string): void {
    const local = this.session.getAddress()?.toLowerCase()
    if (local && address === local) {
      this.player?.showNameTagChat(text)
      return
    }
    if (!skipRemoteAvatars()) {
      this.remoteAvatars?.showPeerNameTagChat(address, text)
    }
  }

  dispose(): void {
    this.unsubAvatarChat?.()
    this.unsubAvatarChat = null
    this.host.stop()

    this.player?.dispose()
    this.player = null
    this.remoteAvatars?.dispose()
    this.remoteAvatars = null

    this.water?.dispose()
    this.water = null
    this.environment.dispose()

    this.landscape.state.landscapeRoot?.removeFromParent()
    this.landscape.state.landscapeRoot = null
    this.sceneScript.gltfColliders?.setLandscapeRoot(null)

    this.sceneScript.dispose()
    this.physics.dispose()

    this.comms.dispose()
    this.social.dispose()

    this.assets.clearScene()
    clearGeometryCookCache()

    this.host.dispose()
  }

  private buildUserData() {
    const address = this.session.getAddress()
    const profile = this.session.getProfile()
    if (!address) {
      const guestId = getOrCreateGuestAddress()
      return {
        data: {
          displayName: 'Guest',
          hasConnectedWeb3: false,
          userId: guestId,
          version: 1
        }
      }
    }

    return {
      data: {
        displayName: profile?.displayName ?? shortenAddress(address),
        publicKey: address,
        hasConnectedWeb3: true,
        userId: address,
        version: 1,
        avatar: profile
          ? {
              bodyShape: profile.bodyShape,
              skinColor: profile.skin,
              hairColor: profile.hair,
              eyeColor: profile.eyes,
              wearables: profile.wearables,
              snapshots: { face256: '', body: '' }
            }
          : undefined
      }
    }
  }
}
