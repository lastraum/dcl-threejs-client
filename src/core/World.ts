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
import { fetchProfileFaceUrl } from '../avatar/peerApi'
import type { LoginResult } from '../auth/AuthClient'
import type { SendBinaryRequest } from '../shim/types'
import { performGetSignedHeaders, performSignedFetch } from '../network/SignedFetchService'
import { shortenAddress } from '../avatar/displayName'
import { buildPlayerMirrorIdentity, getOrCreateGuestAddress } from '../bridge/playerMirrorIdentity'
import type { AvatarAttachTargetResolver } from '../avatar/AvatarAttachTargets'
import type { DclTransformValues } from '../bridge/dclTransform'
import { openExternalUrl } from '../player/openExternalUrl'
import { ReservedEntitiesSync } from '../bridge/ReservedEntitiesSync'
import { waitForSceneAssets, type WaitForSceneAssetsOptions } from '../rendering/sceneHydration'
import { LightManager } from '../rendering/LightManager'
import { clearGeometryCookCache } from '../physics/geometryToPxMesh'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
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
  private lastGltfRegisteredCount = 0
  private skippedColliderWipeLogged = false
  private loggedGltfPhysMismatch = false
  private collidersPhysLastLog = 0
  private loggedCollidersPhysNoHit = false
  private hydrationCollidersCooked = false
  private lastPhysicsBatchFp = ''

  /** New static actors cooked per hydration tick — keeps GLTF attach ahead of PhysX trimesh work. */
  private static readonly HYDRATION_COLLIDER_COOK_BUDGET = 50

  constructor(container: HTMLElement) {
    this.host = new SceneHost(container)
    this.lightManager = new LightManager(this.host.scene)
    this.environment = new EnvironmentSystem(this.host, this.lightManager)
    this.player = new PlayerSystem(this.host, this.physics)
    this.remoteAvatars = new RemoteAvatarManager(this.host.scene)

    this.remoteAvatars && this.comms.setHandlers({
      onPeerJoin: (address) => {
        this.remoteAvatars?.upsertPeer(address)
        void this.social.ensurePeerProfile(address)
      },
      onPeerLeave: (address) => this.remoteAvatars?.removePeer(address),
      onPeerTransform: (address, payload) => {
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
        this.remoteAvatars?.applyPeerProfile(address, serializedProfile)
        this.social.rememberPeerProfile(address, serializedProfile)
      },
      onPeerEmote: (address, urn, incrementalId) => {
        this.remoteAvatars?.playPeerEmote(address, urn, incrementalId)
      }
    })

    this.comms.setSceneBinaryHandler((sender, data) => {
      this.sceneScript.deliverCommsBinary(sender, data)
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

  async loadScene(scene: ResolvedScene, onProgress?: (msg: string) => void): Promise<void> {
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
      this.sceneScript.gltfColliders?.setLandscapeRoot(this.landscape.state.landscapeRoot)
    }

    this.water = new WaterPlane(scene.parcels, scene.baseParcel, 1)
    this.host.scene.add(this.water.mesh)

    onProgress?.('Initialising physics…')
    await this.physics.init()
    const terrain = createTerrainModel(scene.parcels, 1)
    this.physics.syncLandscapeGround(terrain.landscapeParcelKeys, scene.baseParcel, scene.parcels)

    if (scene.mainEntry && scene.entityId) {
      this.sceneScript.prepare(scene, this.assets, this.host)
      this.remoteAvatars?.setEntityStore(this.sceneScript.getEntityStore())
      this.sceneScript.setCollidersCookCallback(() => this.cookStaticColliders())
      this.sceneScript.setCommsHandler({
        setCommunicationsAdapter: async (body) => ({
          success: await this.comms.connectAdapter(body.connectionString)
        }),
        sendBinary: async (body) => this.handleSendBinary(body),
        send: async (body) => {
          await this.comms.publishTopicData('comms', body.message)
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
      this.sceneScript.setSignedFetchHandler(async (body) =>
        performSignedFetch(body, this.session.getAuthIdentity())
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
        onProgress?.('Scene script running')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        onProgress?.(`Scene script error: ${msg}`)
        console.error(err)
      }
    }
  }

  /**
   * Spawn local player after scene script + assets are ready — PhysX ground plane must exist first.
   * Call after `waitForSceneAssets`, before `start()`.
   */
  async spawnLocalPlayer(scene: ResolvedScene, onProgress?: (msg: string) => void): Promise<void> {
    if (!this.playerMode || !this.player) return

    const bounds = sceneWorldBounds(scene.parcels, scene.baseParcel)
    this.sceneScript.syncCollisionForce()
    this.syncPhysicsColliders()
    this.physics.warmStaticScene()

    onProgress?.('Spawning player…')
    await this.player.initCapsule(scene.spawn, bounds, this.sceneScript.readComponents, onProgress)
    this.physics.invalidateControllerCache()
    const spawnStatic = this.physics.staticColliderCount
    const spawnGltf = this.physics.gltfStaticActorCount
    console.info(
      `[World] player spawn — staticColliderCount=${spawnStatic} gltfRegistered=${spawnGltf} gltfExtracted=${this.lastGltfColliderCount}`
    )
    this.sceneScript.syncClientEntities(this.player.getEntityPose(), this.player.getCameraEntityPose())

    const address = this.session.getAddress()
    const identity = this.session.getAuthIdentity()
    if (address && identity) {
      onProgress?.(
        scene.source.kind === 'world' ? 'Joining world comms…' : 'Joining scene comms room…'
      )
      this.comms.setIdentity(address, identity)
      this.comms.setCommsProfile(this.session.getCommsProfileEntity())
      this.comms.setLambdasUrl(scene.realm.lambdasUrl)
      const connected = await this.comms.connectSceneRoom(this.buildCommsTarget(scene))
      onProgress?.(connected ? 'Connected to DCL comms' : 'Comms connection failed — check console')

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
    return waitForSceneAssets(scene, this.sceneScript, this.assets, onProgress, {
      ...options,
      onPrimeRender: () => this.primeRender(),
      onCollidersCook: () => this.cookStaticCollidersDuringHydration()
    })
  }

  /** One visible frame (sky/landscape/camera) before the loading overlay hides. */
  primeRender(): void {
    this.syncPhysicsColliders()
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
    this.sceneScript.notifyPlayReady()
    let startFrame = 0
    this.host.start({
      onSyncFrame: (delta) => {
        startFrame++
        this.water?.update(delta)
        this.lightManager.update(this.host.camera.position)
        this.remoteAvatars?.setCameraPosition(this.host.camera.position)
        this.environment.update(delta, this.sceneScript.view, this.sceneScript.readComponents)

        if (this.playerMode && this.player) {
          this.player.update(delta)
          this.sceneScript.syncClientEntities(this.player.getEntityPose(), this.player.getCameraEntityPose())
          this.sceneScript.updateTriggerAreas()
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

        this.remoteAvatars?.update(delta)
        this.comms.flushBroadcast()

        // Tweens / billboards / GLTF animators — sync frame, before render (not async-gated).
        this.sceneScript.pumpMotionBridges(delta, startFrame)
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

  private applyPhysicsColliders(): void {
    if (!this.playerMode) return
    this.cookStaticColliders()
  }

  /**
   * Extract GLTF/MeshCollider descriptors and cook any new/changed trimeshes into PhysX.
   * Safe to call during asset hydration (before the player capsule exists).
   */
  cookStaticColliders(options?: { hydration?: boolean }): void {
    const gltfEntityCount = this.sceneScript.gltfColliders?.getGltfEntityColliderCount() ?? 0
    let gltfRegistered = this.physics.gltfStaticActorCount
    const registrationComplete = gltfEntityCount === 0 || gltfRegistered >= gltfEntityCount

    if (!options?.hydration) {
      const batchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()
      if (registrationComplete && batchFp === this.lastPhysicsBatchFp) {
        const extracted = this.lastGltfColliderCount
        const registered = this.physics.gltfStaticActorCount
        if (extracted === 0 || registered >= extracted) return
      }
      this.lastPhysicsBatchFp = batchFp
    }

    const colliders = this.sceneScript.collision?.getPhysicsColliders() ?? []
    const gltfColliders = this.sceneScript.gltfColliders?.getPhysicsColliders() ?? []
    const prevGltf = this.lastGltfColliderCount
    const prevRegistered = this.lastGltfRegisteredCount

    if (gltfEntityCount === 0 && prevGltf > 10 && this.physics.gltfStaticActorCount > 0) {
      if (!this.skippedColliderWipeLogged) {
        console.warn('[World] skipping collider wipe — transient empty gltf batch')
        this.skippedColliderWipeLogged = true
      }
      return
    }
    this.skippedColliderWipeLogged = false

    try {
      this.physics.syncStaticColliders([...colliders, ...gltfColliders], {
        cookBudget: options?.hydration ? World.HYDRATION_COLLIDER_COOK_BUDGET : undefined
      })
    } catch (err) {
      console.warn('[World] syncStaticColliders failed:', err)
      return
    }

    gltfRegistered = this.physics.gltfStaticActorCount
    // Landscape `_collider` meshes are extracted here but registered as environment actors, not gltf-*.
    if (
      !options?.hydration &&
      gltfEntityCount > 0 &&
      gltfRegistered === 0 &&
      !this.loggedGltfPhysMismatch
    ) {
      this.loggedGltfPhysMismatch = true
      console.warn(
        `[World] ${gltfEntityCount} GLTF entity colliders extracted but 0 registered in PhysX — check cook failures in console`
      )
    } else if (gltfRegistered > 0) {
      this.loggedGltfPhysMismatch = false
    }

    const gltfRecoveredFromEmpty = prevGltf === 0 && gltfEntityCount > 0
    const significantGltfIncrease =
      gltfEntityCount - prevGltf >= 50 || (prevGltf < 10 && gltfEntityCount >= 50)
    const significantGltfRegistered =
      gltfRegistered - prevRegistered >= 50 || (prevRegistered < 10 && gltfRegistered >= 50)
    if (
      this.player &&
      (gltfRecoveredFromEmpty || significantGltfIncrease || significantGltfRegistered)
    ) {
      this.physics.invalidateControllerCache()
      // Small correction only — full snap teleports and zeroes velocity (breaks movement near walls).
      this.physics.snapToGroundBelow(0.35)
    }
    this.lastGltfColliderCount = gltfEntityCount
    this.lastGltfRegisteredCount = gltfRegistered
  }

  /** Incremental PhysX cook while GLBs attach during the loading-screen hydration loop. */
  private cookStaticCollidersDuringHydration(): void {
    if (!this.playerMode) return
    this.cookStaticColliders({ hydration: true })
    const gltfEntityCount = this.sceneScript.gltfColliders?.getGltfEntityColliderCount() ?? 0
    const gltfRegistered = this.physics.gltfStaticActorCount
    if (gltfEntityCount === 0 || gltfRegistered >= gltfEntityCount) {
      this.hydrationCollidersCooked = true
    }
  }

  private logCollidersPhysDebug(): void {
    if (!physxColliderDebug.isCollidersPhysEnabled()) return
    const now = performance.now()
    if (now - this.collidersPhysLastLog < 1000) return
    this.collidersPhysLastLog = now
    const probe = this.physics.debugProbeStaticHit()
    const hit = probe.distance !== null ? `${probe.distance.toFixed(2)}m` : 'none'
    console.info(
      `[collidersphys] static=${probe.staticCount} gltfRegistered=${probe.gltfCount} extracted=${this.lastGltfColliderCount} nearestHit=${hit}`
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

  syncPhysicsColliders(): void {
    if (!this.playerMode || !this.player) return
    this.sceneScript.syncCollisionForce()
    this.applyPhysicsColliders()
  }

  /**
   * Validation pass after hydration — most trimeshes are already cooked incrementally while
   * GLBs attach. Only re-syncs the renderer when assets are still pending; otherwise just
   * re-extracts poses and confirms the static-actor count stabilises.
   */
  async prewarmPhysicsColliders(
    onProgress?: (msg: string) => void,
    options: { assetsTimedOut?: boolean } = {}
  ): Promise<void> {
    if (!this.playerMode || !this.player) return
    const assetsTimedOut = options.assetsTimedOut ?? false
    this.lastPhysicsBatchFp = ''
    const maxWallMs = assetsTimedOut ? 4_000 : 12_000
    const maxPasses = assetsTimedOut ? 6 : 16
    const started = performance.now()

    let prev = -1
    let prevGltfRegistered = -1
    let stable = 0
    let gltfStable = 0

    for (let pass = 0; pass < maxPasses; pass++) {
      if (performance.now() - started >= maxWallMs) {
        clientDebugLog.log('collision', `[prewarm] wall timeout after ${pass} pass(es)`, {
          throttleMs: 10_000,
          alsoConsole: false
        })
        break
      }

      const hydration = this.sceneScript.getHydrationStats()
      const gltfsPending = hydration?.gltfPending ?? 0

      // Renderer full-walk only when late attaches are still in flight.
      if (gltfsPending > 0) {
        await this.sceneScript.syncRenderer()
      }
      this.sceneScript.syncCollisionForce()
      this.cookStaticColliders()
      this.physics.warmStaticScene()
      const count = this.physics.staticColliderCount
      const gltfCount = this.lastGltfColliderCount
      const gltfRegistered = this.physics.gltfStaticActorCount

      if (count === prev) stable++
      else {
        stable = 0
        prev = count
      }

      if (assetsTimedOut) {
        if (gltfCount === 0 || gltfRegistered > 0 || pass >= 2) gltfStable = 2
      } else if (gltfsPending > 0) {
        gltfStable = 0
      } else if (gltfCount === 0) {
        gltfStable = 2
      } else if (gltfRegistered === prevGltfRegistered && gltfRegistered >= gltfCount) {
        gltfStable++
      } else {
        gltfStable = 0
        prevGltfRegistered = gltfRegistered
      }

      const label = this.hydrationCollidersCooked ? 'Checking collisions' : 'Building collisions'
      onProgress?.(`${label}… ${count} static (${gltfRegistered}/${gltfCount} GLTF)`)

      const registrationComplete = gltfCount === 0 || gltfRegistered >= gltfCount
      const collidersQueryable =
        registrationComplete && stable >= 2 && gltfStable >= 2 && this.areSpawnCollidersQueryable(gltfCount)
      if (collidersQueryable) break

      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }

    const finalRegistered = this.physics.gltfStaticActorCount
    const finalGltfCount = this.lastGltfColliderCount
    if (finalGltfCount > 0 && finalRegistered === 0) {
      console.warn(
        `[World] prewarm finished with 0/${finalGltfCount} GLTF PhysX actors — movement will not collide with GLTF meshes`
      )
    } else if (finalRegistered > 0 && finalRegistered < finalGltfCount) {
      console.warn(
        `[World] prewarm finished with ${finalRegistered}/${finalGltfCount} GLTF PhysX actors — some GLTF meshes will not block movement`
      )
    } else if (finalGltfCount >= 50 && !this.areSpawnCollidersQueryable(finalGltfCount)) {
      console.warn(
        `[World] prewarm finished — ${finalRegistered} GLTF actors registered but horizontal CCT probe near spawn found no hit`
      )
    }
    this.physics.invalidateControllerCache()
    this.physics.snapToGroundBelow(2)
  }

  /** True when a horizontal capsule sweep near the player hits registered static geometry. */
  private areSpawnCollidersQueryable(gltfCount: number): boolean {
    if (gltfCount < 10) return true
    const probe = this.physics.debugProbeStaticHit(6)
    return probe.distance !== null
  }

  getPlayerPosition(): THREE.Vector3 | null {
    if (!this.playerMode || !this.player) return null
    return this.player.getPosition()
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


  dispose(): void {
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

  private async handleSendBinary(body: SendBinaryRequest) {
    const peerChunks =
      body.peerData?.flatMap((entry) => entry.data.map((chunk) => ({ chunk, addresses: entry.address }))) ?? []
    const broadcast = body.data ?? []
    const sent: Uint8Array[] = []

    if (broadcast.length === 0 && peerChunks.length === 0) {
      return { data: await this.comms.sendBinary([]) }
    }

    if (broadcast.length) {
      sent.push(...(await this.comms.sendBinary(broadcast)))
    }
    for (const entry of peerChunks) {
      sent.push(...(await this.comms.sendBinary([entry.chunk], entry.addresses)))
    }
    return { data: sent }
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
