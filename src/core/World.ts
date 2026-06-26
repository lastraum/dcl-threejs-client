import type { Entity } from '@dcl/ecs'
import type { ResolvedScene } from '../dcl/content/types'
import * as THREE from 'three'
import { createTerrainModel } from '../dcl/landscape/Worlds/TerrainModel'
import { getSessionAssetCache, prefetchSceneManifestAssets } from '../rendering/AssetCache'
import { applyClientPerformanceDefaults, detectPerformanceTier } from '../client/detectPerformanceTier'
import { SceneHost } from '../rendering/SceneHost'

import { GLTF_COLLIDER_ENTITY_BASE } from '../collision/GltfColliderExtractor'
import { PhysXWorld } from '../physics/PhysXWorld'
import { PlayerSystem } from '../player/PlayerSystem'
import {
  islandCircularWalkBounds,
  sceneWorldBounds,
  type PlayerWalkBounds
} from '../player/SceneBounds'
import { LandscapeSystem } from './systems/LandscapeSystem'
import { SceneScriptSystem } from './systems/SceneScriptSystem'
import { EnvironmentSystem } from '../environment/EnvironmentSystem'
import { FftOceanWater } from '../environment/FftOceanWater'
import { IslandWater } from '../environment/IslandWater'
import { OpenOceanWater } from '../environment/OpenOceanWater'
import { OceanRing } from '../environment/OceanRing'
import { readFftOceanOverride } from '../environment/fftOcean/readFftOceanOverride'
import type { OceanPerfInfo } from '../client/ui/RenderStats'
import type { OutdoorLightingSnapshot } from '../environment/OutdoorLighting'
import type { IslandShoreMaterial } from '../dcl/landscape/IslandShoreMaterial'
import {
  landscapeProfileForResolvedScene,
  resolveSceneEnvironment
} from '../dcl/landscape/resolveLandscapeEnvironment'
import type { EzTreeGrassFieldHandle } from '../dcl/landscape/EzTreeGrassField'
import { resetFoliageWindRegistry, updateFoliageWind } from '../dcl/landscape/foliageWind'
import { SessionIdentity } from '../network/SessionIdentity'
import { RemoteAvatarManager } from '../network/RemoteAvatarManager'
import { CommsService } from '../network/CommsService'
import { buildEmoteWheelSlots, resolveSceneEmoteFromSrc } from '../avatar/profileEmotes'
import { SocialService } from '../social/SocialService'
import { isChatTextLine } from '../social/types'
import { overheadChatText } from '../social/overheadChatText'
import { fetchProfileFaceUrl, seedCommsPeerProfile } from '../avatar/peerApi'
import type { LoginResult } from '../auth/AuthClient'
import type { SendBinaryRequest } from '../shim/types'
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
import {
  buildPhysxCookPrefetchRequests,
  clearGeometryCookCache,
  disposePhysxCookPool,
  getGeometryCookCacheStats,
  prefetchPhysxCookStreams,
  resetGeometryCookCacheStats,
  resetPhysxCookPoolSession,
  startPhysxCookPrefetch
} from '../physics/geometryToPxMesh'
import { clearPrimedPhysxCookStreams } from '../physics/physxCookByteCache'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { skipRemoteAvatars, useWorkerPhysx } from '../client/devFlags'
import { initMainThreadPerfFromUrl, recordMainThreadPerf } from '../debug/MainThreadPerf'
import { disposePhysxSimWorker, warmPhysxSimWorker } from '../physics/physxSimBridge'
import { VrmPeerSync } from '../avatar/vrm/VrmPeerSync'
import { clearVrmRamCache } from '../avatar/vrm/vrmRamCache'

import { physxColliderDebug } from '../debug/PhysxColliderDebug'
import { environmentDebug } from '../debug/EnvironmentDebug'
import { platformMotionDebug } from '../debug/PlatformMotionDebug'

function useOrbitMode(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('orbit')
}

type SceneWater = {
  group: THREE.Group
  update: (delta: number, camera: THREE.Camera) => void
  applyOutdoorLighting?: (lighting: OutdoorLightingSnapshot) => void
  dispose: () => void
  perfInfo?: OceanPerfInfo
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
  private ocean: SceneWater | null = null
  private player: PlayerSystem | null = null
  private remoteAvatars: RemoteAvatarManager | null = null
  private readonly vrmPeerSync = new VrmPeerSync()
  private playerMode = !useOrbitMode()
  private editorPreviewMode = false
  private lastGltfColliderCount = 0
  private loggedGltfPhysMismatch = false
  private collidersPhysLastLog = 0
  private loggedCollidersPhysNoHit = false
  private loggedFinalizePoseDiag = false
  private loggedRuntimeRecookDisabled = false
  private loggedPlatformMotionDebugHint = false
  private collidersLoadingComplete = false
  private lastPhysicsBatchFp = ''
  private signedFetchSceneContext: SignedFetchSceneContext | null = null
  private sceneCommsConnected = false
  private pendingColliderCooks = 0
  private readonly colliderCookQueue = new Set<number>()
  /** Extract colliders while GLBs attach; PhysX cook runs once after hydration is idle. */
  private deferPhysxCooks = true
  private readonly colliderCookPriority = new THREE.Vector3()
  private warmStaticScenePending = false
  private bootAssetsTimedOut = false
  /** Plaza-scale scenes — keep cooking near-player GLTF colliders after hydration timeout. */
  private postBootColliderCatchUpUntil = 0
  /** Runtime burst (e.g. theatre Scene 11/12) — drain with loading-style recook until idle. */
  private runtimeColliderBurstUntil = 0
  private unsubAvatarChat: (() => void) | null = null
  private playerWalkBounds: PlayerWalkBounds | null = null
  private ezTreeGrass: EzTreeGrassFieldHandle | null = null
  private ezTreeGrassElapsed = 0
  private foliageWindElapsed = 0
  private unsubEnvironmentDebug: (() => void) | null = null

  /** Per-tick budget while GLBs still attaching on the loading screen. */
  private static readonly HYDRATION_COLLIDER_COOK_BUDGET = 80
  /** Per-frame budget during the post-hydration loading drain. */
  private static readonly LOADING_COLLIDER_COOK_BUDGET = 96
  private static readonly RUNTIME_COLLIDER_COOK_BUDGET = 8
  /** Burst cook after dynamic scene spawns (theatre) — higher per-frame budget. */
  private static readonly RUNTIME_COLLIDER_BURST_BUDGET = 64
  private static readonly RUNTIME_COLLIDER_BURST_MS = 12_000
  /** Theatre / composite sub-scenes often spawn <24 GLTFs — burst earlier. */
  private static readonly RUNTIME_COLLIDER_BURST_QUEUE = 8
  /** Hard cap for the single boot cook — load fails if the queue is not drained in time. */
  private static readonly LOADING_COLLIDER_WALL_MS = 180_000
  private static readonly LOADING_COLLIDER_WALL_TIMED_OUT_MS = 120_000
  private static readonly COLLIDER_COOK_PROGRESS_START = 0.82
  private static readonly COLLIDER_COOK_PROGRESS_RANGE = 0.12

  constructor(container: HTMLElement) {
    this.host = new SceneHost(container)
    const performanceTier = detectPerformanceTier(this.host.renderer.getContext())
    applyClientPerformanceDefaults(this.host.renderer, performanceTier)
    this.sceneScript.setPerformanceTier(performanceTier)
    if (performanceTier !== 'high') {
      console.info(`[World] performance tier=${performanceTier} — relaxed scene-worker timing + render defaults`)
    }
    this.lightManager = new LightManager(this.host.scene)
    this.environment = new EnvironmentSystem(this.host, this.lightManager)
    this.player = new PlayerSystem(this.host, this.physics)
    this.sceneScript.setClientPoseProvider(() => ({
      player: this.player!.getEntityPose(),
      camera: this.player!.getCameraEntityPose()
    }))
    this.remoteAvatars = new RemoteAvatarManager(this.host.scene)

    this.unsubEnvironmentDebug = environmentDebug.subscribe(() => this.applyEnvironmentDebugVisibility())

    this.vrmPeerSync.attach(this.comms, {
      onPeerVrmChanged: (address, contentHash, format) => {
        if (skipRemoteAvatars()) return
        this.remoteAvatars?.setPeerVrmHash(address, contentHash, format ?? null)
      },
      onPeerVrmBytesReady: (address, contentHash, format) => {
        if (skipRemoteAvatars()) return
        this.remoteAvatars?.onPeerVrmBytesReady(address, contentHash, format)
      }
    })

    this.remoteAvatars && this.comms.setHandlers({
      onPeerJoin: (address) => {
        if (skipRemoteAvatars()) return
        if (address === this.session.getAddress()?.toLowerCase()) return
        this.remoteAvatars?.upsertPeer(address)
        if (this.remoteAvatars) {
          this.vrmPeerSync.syncPeerToRemoteAvatars(address, this.remoteAvatars)
        }
        void this.vrmPeerSync.onPeerJoined(address)
        void this.social.ensurePeerProfile(address)
        this.social.onRemotePeerJoined(address)
      },
      onPeerLeave: (address) => {
        if (skipRemoteAvatars()) return
        this.vrmPeerSync.onPeerLeave(address)
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
    this.comms.setTopicMessageHandler((topic, sender, payload) => {
      if (topic !== 'comms') return
      const message = new TextDecoder().decode(payload)
      this.sceneScript.engineApiEvents.pushCommsMessage(message, sender)
    })
  }

  applyLogin(choice: LoginResult | null): void {
    this.session.applyLogin(choice)
    this.comms.setIdentity(this.session.getAddress(), this.session.getAuthIdentity())
    this.vrmPeerSync.setLocalAddress(this.session.getAddress() ?? null)
  }

  /** Local `/editor` preview — fly camera, no player controller, lightweight frame loop. */
  enterEditorPreviewMode(): void {
    this.playerMode = false
    this.editorPreviewMode = true
    this.host.setOrbitEnabled(false)
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
    if (skipRemoteAvatars()) {
      clientDebugLog.log('network', 'Remote avatars disabled (?noremote)', {
        alsoConsole: true,
        throttleMs: 60_000
      })
    }
    this.assets.setScene(scene)
    prefetchSceneManifestAssets(this.assets, scene)
    this.comms.setIdentity(this.session.getAddress(), this.session.getAuthIdentity())
    this.comms.applyRealmAbout(scene.realm, scene.commsPointer)
    this.session.setCatalystEndpoints(scene.realm.contentUrl, scene.realm.lambdasUrl)
    this.remoteAvatars?.setCatalystEndpoints(scene.realm.contentUrl, scene.realm.lambdasUrl)
    this.remoteAvatars?.setAssetCache(this.assets)

    const bounds = sceneWorldBounds(scene.parcels, scene.baseParcel)
    this.host.configureViewDistance(bounds)

    const resolvedEnv = resolveSceneEnvironment(scene.metadata, scene.source)
    scene.landscapeEnvironment = resolvedEnv.landscapeEnvironment
    scene.skyLighting = resolvedEnv.skyLighting
    environmentDebug.setSceneEnvironment(resolvedEnv.landscapeEnvironment)

    onProgress?.('Setting up sky…')
    await this.environment.init(scene)

    const landscapeProfile = landscapeProfileForResolvedScene(scene)
    const openIslandShore =
      landscapeProfile.kind === 'island' || landscapeProfile.circularShore === true
    const openOcean = landscapeProfile.openOcean === true

    const skipClientLandscape = scene.source.kind === 'local'
    const terrain = createTerrainModel(
      scene.parcels,
      landscapeProfile.borderPadding,
      landscapeProfile.circularShore === true
    )

    if (!skipClientLandscape) {
      await this.landscape.initialize(scene, this.assets, onProgress)
      this.ezTreeGrass?.dispose()
      this.ezTreeGrass =
        (this.landscape.state.landscapeRoot?.userData.ezTreeGrass as EzTreeGrassFieldHandle | undefined) ??
        null
      this.ezTreeGrassElapsed = 0
      this.foliageWindElapsed = 0
      if (this.landscape.state.landscapeRoot) {
        this.host.scene.add(this.landscape.state.landscapeRoot)
      }
    }

    this.clearOcean()
    if (!skipClientLandscape && landscapeProfile.showWater) {
      const fftSettings = readFftOceanOverride()
      const useFftOcean = fftSettings.enabled && this.host.renderer.capabilities.isWebGL2
      if (fftSettings.enabled && !useFftOcean) {
        console.warn('[ocean] FFTOCEAN requires WebGL2 — using Water.js')
      }
      console.info(
        `[ocean] env=${landscapeProfile.kind} openOcean=${openOcean} fftOcean=${useFftOcean}`
      )
      this.ocean = openOcean
        ? useFftOcean
          ? await this.createFftOcean(scene, 'open', fftSettings)
          : await this.createOpenOcean(scene)
        : openIslandShore
          ? useFftOcean
            ? await this.createFftOcean(
                scene,
                'island',
                fftSettings,
                landscapeProfile.borderPadding
              )
            : await this.createIslandWater(scene, landscapeProfile.borderPadding)
          : new OceanRing(
              scene.parcels,
              scene.baseParcel,
              terrain.paddingInParcels,
              terrain.landscapeParcelKeys
            )
      if (this.ocean.group.children.length > 0) {
        this.host.scene.add(this.ocean.group)
        this.host.renderStats.setOceanPerf(this.ocean.perfInfo ?? null)
      } else {
        this.ocean.dispose()
        this.ocean = null
        this.host.renderStats.setOceanPerf(null)
      }
    } else {
      this.host.renderStats.setOceanPerf(null)
    }
    this.syncOutdoorLighting()

    initMainThreadPerfFromUrl()

    onProgress?.('Initialising physics…')
    await this.physics.init()
    this.physics.syncLandscapeGround(terrain.landscapeParcelKeys, scene.baseParcel, scene.parcels, {
      perimeterWalls: !openIslandShore && !openOcean
    })
    this.playerWalkBounds = openIslandShore
      ? islandCircularWalkBounds(scene.parcels, scene.baseParcel, landscapeProfile.borderPadding)
      : { mode: 'rect', bounds: sceneWorldBounds(scene.parcels, scene.baseParcel) }

    if (scene.mainEntry && scene.entityId) {
      this.resetColliderBootState()
      this.sceneScript.prepare(scene, this.assets, this.host)
      this.sceneScript.setLiveKitVideoBinder((video, onUpdate) =>
        this.comms.bindLiveKitVideoSource(video, onUpdate)
      )
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
        sendBinary: async (body) => this.handleSendBinary(body),
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

    this.bindLandscapeColliders(openIslandShore)
    this.applyEnvironmentDebugVisibility()

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
      onProgress?.('Compiling scene script…')
      const spawnPoses = this.seedPosesFromSpawn(scene.spawn)
      this.sceneScript.seedRendererEntities(spawnPoses.player, spawnPoses.camera)
      this.sceneScript.setBootProgressReporter((msg) => onProgress?.(msg))
      try {
        await this.sceneScript.start(scene, this.assets, this.host)
        onProgress?.('Loading scene assets…')
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
    this.vrmPeerSync.setLocalAddress(address)
    const connectResult = await this.comms.connectSceneRoom(this.buildCommsTarget(scene))
    if (connectResult.ok) {
      this.sceneCommsConnected = true
      clientDebugLog.log('comms', 'Early scene comms connected during hydration', { level: 'success' })
      onProgress?.('Receiving peer updates…')
      await this.vrmPeerSync.onSceneConnected()
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
    await this.bootCookPhysicsColliders(scene, onProgress, {
      assetsTimedOut: this.bootAssetsTimedOut
    })

    const walkBounds =
      this.playerWalkBounds ?? { mode: 'rect', bounds: sceneWorldBounds(scene.parcels, scene.baseParcel) }

    onProgress?.('Spawning player…')
    await this.player.initCapsule(scene.spawn, walkBounds, this.sceneScript.readComponents, onProgress)
    if (scene.spawn.y <= 0.01) {
      console.info(
        `[World] spawn — no spawnPoints; feet y=1 (gravity on first frame) · parcel=${scene.commsPointer}`
      )
    }
    this.sceneScript.setSpatialAudioPlayerRoot(() => this.player!.getPlayerRoot())
    const spawnStatic = this.physics.staticColliderCount
    const spawnGltf = this.physics.gltfStaticActorCount
    const gltfStats = this.sceneScript.gltfColliders?.getPhysicsExtractionStats()
    const pos = this.player.getPosition()
    const feetThree = this.player.getWorldPosition()
    const probeH = this.physics.debugProbeStaticHit(2.5)
    const probeDown = this.physics.debugProbeDownHit(8)
    const nearestGltf = this.nearestGltfColliderHorizDist(feetThree)
    const sceneProbe = this.physics.probeSceneMeshDownAt(feetThree, 12)
    console.info(
      `[World] player spawn — static=${spawnStatic} gltfRegistered=${spawnGltf} gltfExtracted=${this.lastGltfColliderCount}` +
        (gltfStats
          ? ` shapes(inv=${gltfStats.invisibleShapes} vis=${gltfStats.visibleShapes})`
          : '') +
        (pos ? ` feet=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})` : '') +
        ` probeH=${probeH.distance !== null ? `${probeH.distance.toFixed(2)}m` : 'none'}` +
        ` sceneProbe=${sceneProbe !== null ? `${sceneProbe.toFixed(2)}m` : 'none'}` +
        ` nearestGltf=${nearestGltf !== null ? `${nearestGltf.toFixed(1)}m` : 'none'}` +
        ` probeDown=${probeDown !== null ? `${probeDown.toFixed(2)}m` : 'none'}`
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
        this.vrmPeerSync.setLocalAddress(address)
        const connectResult = await this.comms.connectSceneRoom(this.buildCommsTarget(scene))
        this.sceneCommsConnected = connectResult.ok
        if (connectResult.ok) {
          await this.vrmPeerSync.onSceneConnected()
        }
        if (connectResult.ok) {
          onProgress?.('Connected to DCL comms')
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
    // Social/avatar load can overlap post-play-ready CRDT — sync + register before pointer bind.
    this.sceneScript.syncCollision()
    this.reconcileColliderCookQueue()
    await this.drainPendingColliderCooksInitialOnly()
    this.physics.warmStaticScene()
    this.sceneScript.flushSceneGraphMatrices()
    this.sceneScript.preparePointerRaycast()
    this.sceneScript.refreshPointerTargets()
    this.sceneScript.bindPointerEvents(
      () => this.player!.getWorldPosition(),
      () => this.player!.isPointerBlocked(),
      () => this.physics
    )
    await this.sealSpawnColliderPoses()
    const plazaScale = this.lastGltfColliderCount >= 200
    this.sceneScript.notifyPlayReady({ plazaScale })
    if (useWorkerPhysx()) {
      void warmPhysxSimWorker().catch((err) => {
        console.warn('[World] PhysX sim worker warm failed — main-thread fallback', err)
      })
    }
    if (!skipRemoteAvatars()) {
      this.remoteAvatars?.setPlayReady(plazaScale)
    }
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

    this.sceneScript.setSceneWorkerOnUpdatePaused(true)
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
      return
    }
    return hydration
  }

  /** One visible frame (sky/landscape/camera) before the loading overlay hides. */
  primeRender(): void {
    this.ocean?.update(0, this.host.camera)
    updateFoliageWind(this.foliageWindElapsed)
    this.lightManager.update(this.host.camera.position)
    this.environment.update(0, this.sceneScript.view, this.sceneScript.readComponents)
    this.syncOutdoorLighting()
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
        if (!this.editorPreviewMode) {
          this.ocean?.update(delta, this.host.camera)
          if (this.ezTreeGrass) {
            this.ezTreeGrassElapsed += delta
            this.ezTreeGrass.update(this.ezTreeGrassElapsed, this.host.camera.position)
          }
          this.foliageWindElapsed += delta
          updateFoliageWind(this.foliageWindElapsed)
        }
        this.lightManager.update(this.host.camera.position)
        if (!skipRemoteAvatars()) {
          this.remoteAvatars?.setCameraPosition(this.host.camera.position)
        }
        if (!this.editorPreviewMode) {
          this.environment.update(delta, this.sceneScript.view, this.sceneScript.readComponents)
          this.syncOutdoorLighting()
        }

        if (this.playerMode && this.player) {
          const platformT0 = performance.now()
          this.syncPlayerMotionFrame(delta, startFrame)
          const platformMs = performance.now() - platformT0
          const playerT0 = performance.now()
          this.player.update(delta)
          const playerMs = performance.now() - playerT0
          recordMainThreadPerf({ platformMotionMs: platformMs, playerUpdateMs: playerMs, colliderApplyMs: 0 })
          this.sceneScript.syncClientEntities(this.player.getEntityPose(), this.player.getCameraEntityPose())

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
              'remoteLoaded:', this.remoteAvatars?.loadedPeerCount ?? 0,
              'gltfCached:', this.assets.getLoadStats().gltfCached)
          }
        }

        if (!skipRemoteAvatars()) {
          this.vrmPeerSync.gcStaleFetches()
          this.remoteAvatars?.update(delta)
        }
        this.comms.flushBroadcast()

        // Tweens / billboards / GLTF animators — player path runs in syncPlayerMotionFrame first.
        if (!this.editorPreviewMode && (!this.playerMode || !this.player)) {
          this.sceneScript.pumpMotionBridges(delta, startFrame)
        }
        if (this.playerMode && this.player) {
          this.sceneScript.preparePointerRaycast()
          this.sceneScript.updateTriggerAreas()
          this.sceneScript.updateRaycasts()
          this.sceneScript.updatePointerEvents(startFrame)
        }
        if (!this.editorPreviewMode) {
          // Campfire sprite UV animation — sync frame (tiny tracked set, self-prunes static planes).
          this.sceneScript.syncAnimatedSprites()
          // Texture retries — sync frame so failed loads don't block async projection drain.
          this.sceneScript.tickDeferredMaterials()
        }
      },
      onAsyncFrame: async (_delta) => {
        if (this.editorPreviewMode) return

        await this.sceneScript.syncRenderer()
        if (this.playerMode && this.player) {
          this.sceneScript.preparePointerRaycast()
        }

        // Sync frame already runs syncCollision after motion bridges — async only when
        // projection diff or entity-store changes mark new collider work this frame.
        if (this.sceneScript.hasColliderWorkPending()) {
          this.sceneScript.syncCollision()
        }

        if (this.playerMode && this.player) {
          const colliderT0 = performance.now()
          this.applyPhysicsColliders()
          recordMainThreadPerf({
            platformMotionMs: 0,
            playerUpdateMs: 0,
            colliderApplyMs: performance.now() - colliderT0
          })
          this.logCollidersPhysDebug()
        }

        await this.sceneScript.syncAsyncBridges()
      }
    })
  }

  /**
   * Platform motion frame — two pipelines (see platformMotion.ts):
   * 1. Pose sync: meshMotion → slide PhysX colliders (incl. distant animated props).
   * 2. Riding transfer: Δ only for CCT-grounded actor → PlayerSystem capsule += Δ before move().
   */
  private syncPlayerMotionFrame(delta: number, startFrame: number): void {
    const feet = this.player?.getWorldPosition()
    const groundPhysEntity = this.physics.getLastGroundPhysEntity()
    const standPhysEntity = this.sceneScript.resolveStandSurfacePhysEntity(feet, groundPhysEntity)
    this.physics.beginPlatformMotionFrame(standPhysEntity)
    this.sceneScript.consumeSyncFrameTransforms()

    const groundEcsEarly = this.sceneScript.standSurfaceEcsFromPhys(standPhysEntity)
    const onSceneGround = groundPhysEntity !== null && groundPhysEntity !== -1
    const shapeMotionEarly = this.sceneScript.collectPhysXShapeMotionEntities(
      groundEcsEarly,
      feet ?? undefined,
      groundPhysEntity
    )
    const needsPlatformPipeline =
      shapeMotionEarly.size > 0 || !onSceneGround || groundPhysEntity === -1

    if (needsPlatformPipeline && feet) {
      this.sceneScript.snapshotWalkSurfacePositions(feet, 96)
    }

    let descs: ReturnType<SceneScriptSystem['getAllPhysicsColliderDescs']> | null = null
    if (needsPlatformPipeline) {
      descs = this.sceneScript.getAllPhysicsColliderDescs()
      this.physics.snapshotColliderPositions(descs)
      if (shapeMotionEarly.size > 0 || !onSceneGround) {
        this.physics.snapshotActorRootPoses(descs)
      }
      if (shapeMotionEarly.size > 0 && standPhysEntity !== null && standPhysEntity !== -1) {
        this.physics.snapshotGltfColliderWalkSurfaces(descs, feet ?? undefined, standPhysEntity)
      }
      if (feet) {
        this.physics.snapshotGroundContactBaseline(feet)
        if (groundEcsEarly !== null) {
          this.sceneScript.snapshotAnimatorOriginPositions(feet, groundEcsEarly)
        }
      }
    }

    this.sceneScript.pumpMotionBridges(delta, startFrame)
    if (this.sceneScript.hasColliderWorkPending()) {
      this.sceneScript.syncCollision()
    }

    let meshMotion: Entity[] = []
    if (this.collidersLoadingComplete && !this.deferPhysxCooks && needsPlatformPipeline && descs) {
      const groundEcs = groundEcsEarly
      const shapeMotion = shapeMotionEarly
      meshMotion = feet
        ? this.sceneScript.detectAndMarkLiveColliderMeshMotion(feet, 96, standPhysEntity)
        : []
      const poseSync = this.sceneScript.collectPhysXPoseSyncEntities(meshMotion, shapeMotion)
      if (poseSync.length) {
        this.sceneScript.refreshColliderDescPoses(poseSync, shapeMotion)
        const forceEntities = new Set<number>()
        for (const entity of poseSync) {
          const physId = this.sceneScript.physEntityIdForPoseSync(entity)
          if (physId !== null) forceEntities.add(physId)
        }
        this.pushColliderPosesToPhysX({ forceEntities })
      }
      const groundIsMoving =
        groundEcs !== null && (meshMotion.includes(groundEcs) || shapeMotion.has(groundEcs))
      const standScoped = standPhysEntity !== null && standPhysEntity !== -1
      if (feet && standScoped && groundIsMoving) {
        this.physics.snapshotPhysXActorWalkSurfaces(standPhysEntity, feet, descs)
      }
      if (poseSync.length || groundIsMoving) {
        this.physics.applyGltfColliderPoseDeltas(descs, feet ?? undefined)
      }
      if (groundIsMoving) {
        this.physics.applyActorRootPoseDeltas(descs, standPhysEntity)
      }
      if (feet && groundEcs !== null && (groundIsMoving || shapeMotion.has(groundEcs))) {
        this.sceneScript.computeAnimatorOriginDeltas(feet, groundEcs)
      }
      this.physics.mergeAnimatorOriginPlatformMotion(
        this.sceneScript.consumeAnimatorOriginDeltasPhys(),
        this.sceneScript.consumeAnimatorOriginPositionsPhys()
      )
      if (poseSync.length || groundIsMoving) {
        this.physics.applyMeshColliderPoseDeltas(descs)
      }
      if (feet && standScoped && groundIsMoving) {
        this.physics.applyPhysXActorWalkSurfaceDeltas(standPhysEntity, feet, descs)
        this.physics.applyGroundContactDelta(feet)
      }
      if (feet && standScoped && groundPhysEntity === -1) {
        this.physics.reconcileStandSurfaceGrounding(standPhysEntity, descs, feet)
      }
      this.physics.cullInsignificantPlatformMotionDeltas()
    }
    if (platformMotionDebug.isEnabled() && !this.loggedPlatformMotionDebugHint) {
      this.loggedPlatformMotionDebugHint = true
      clientDebugLog.log(
        'motion',
        'Platform motion debug active — URL ?platformdebug or Help → Debug → Platform transfer log',
        { level: 'success', alsoConsole: true }
      )
    }
    if (feet && platformMotionDebug.isEnabled()) {
      this.sceneScript.logPlatformMotionTick(feet, {
        meshMotion,
        poseDirty: 0,
        platformDeltas: this.physics.getPlatformMotionDeltaSnapshot(),
        platformTransferApplied: false,
        lastGround: this.physics.getLastGroundPhysEntity(),
        standingPlatform: this.physics.getStandingPlatformEntity(),
        sceneOrigin: this.comms.getSceneOrigin()
      })
    }
  }

  /** Runtime pose-drift recook — off unless `?colliderrecook` or Help debug toggle. Boot + manual recook bypass. */
  private allowsRuntimeColliderRecook(): boolean {
    return physxColliderDebug.isRuntimeRecookEnabled()
  }

  private logRuntimeRecookDisabledOnce(): void {
    if (this.loggedRuntimeRecookDisabled || this.allowsRuntimeColliderRecook()) return
    this.loggedRuntimeRecookDisabled = true
    clientDebugLog.log(
      'client',
      'Runtime collider recook disabled — boot cook + pose slides only; add ?colliderrecook or enable in Help (?) to allow drift recook'
    )
  }

  private applyPhysicsColliders(): void {
    if (!this.playerMode || !this.collidersLoadingComplete || this.deferPhysxCooks) return
    this.logRuntimeRecookDisabledOnce()
    const batchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()
    const fpDrifted = batchFp !== this.lastPhysicsBatchFp
    const colliderWork = this.sceneScript.hasColliderWorkPending()

    if (colliderWork) {
      this.sceneScript.syncCollision()
    }

    if (fpDrifted) {
      const posesSynced = this.sceneScript.hadColliderPoseSyncThisPass()
      if (!posesSynced && this.allowsRuntimeColliderRecook()) {
        this.sceneScript.refreshColliderDescPoses()
        this.pushColliderPosesToPhysX()
      }
      this.lastPhysicsBatchFp = batchFp
    }

    this.reconcileColliderCookQueue()
    const cookPendingAfterReconcile = this.colliderCookQueue.size > 0
    if (!cookPendingAfterReconcile && !fpDrifted && !colliderWork) return
    if (this.colliderCookQueue.size > 0) {
      if (this.allowsRuntimeColliderRecook()) {
        void this.drainRuntimeColliderCookQueue()
      } else {
        void this.drainPendingColliderCooksInitialOnly()
      }
    }
  }

  /**
   * Register never-cooked PhysX actors while runtime recook is off — still required for
   * composite/theatre spawns that land after boot cook.
   */
  private async drainPendingColliderCooksInitialOnly(): Promise<void> {
    if (this.colliderCookQueue.size === 0) return
    const burstActive = performance.now() < this.runtimeColliderBurstUntil
    const catchUpActive = performance.now() < this.postBootColliderCatchUpUntil
    const pending = this.colliderCookQueue.size
    const nearPlayerPending = this.countNearPlayerColliderQueue()
    if (
      pending >= World.RUNTIME_COLLIDER_BURST_QUEUE ||
      burstActive ||
      nearPlayerPending >= 4 ||
      (catchUpActive && nearPlayerPending >= 1)
    ) {
      let passes = 0
      // Spread large post-composite queues across frames — avoid 200+ cooks in one async tick.
      const maxPasses = burstActive
        ? 3
        : catchUpActive && nearPlayerPending >= 1
          ? 3
          : nearPlayerPending >= 4
            ? 2
            : 1
      while (this.colliderCookQueue.size > 0 && passes < maxPasses) {
        await this.drainColliderCookQueue({ initialOnly: true })
        passes++
      }
    } else {
      await this.drainColliderCookQueue({ initialOnly: true })
    }
    this.scheduleWarmStaticScene()
  }

  /** Runtime PhysX cook — prioritize near-player, burst-drain after composite spawns (theatre). */
  private async drainRuntimeColliderCookQueue(): Promise<void> {
    if (!this.allowsRuntimeColliderRecook()) return
    const pending = this.colliderCookQueue.size
    if (pending === 0) return

    const burstActive = performance.now() < this.runtimeColliderBurstUntil
    if (pending >= World.RUNTIME_COLLIDER_BURST_QUEUE || burstActive) {
      let passes = 0
      const maxPasses = burstActive ? 12 : 6
      while (this.colliderCookQueue.size > World.RUNTIME_COLLIDER_COOK_BUDGET && passes < maxPasses) {
        await this.drainColliderCookQueue({ loading: true })
        passes++
      }
    }
    if (this.colliderCookQueue.size > 0) {
      await this.drainColliderCookQueue({ initialOnly: true })
    }
  }

  private countNearPlayerColliderQueue(maxHoriz = 32): number {
    const feet = this.player?.getWorldPosition()
    if (!feet) return 0
    const maxHorizSq = maxHoriz * maxHoriz
    let count = 0
    for (const physId of this.colliderCookQueue) {
      const desc = this.sceneScript.getPhysicsColliderDesc(physId)
      if (!desc) continue
      const dx = desc.matrix.elements[12]! - feet.x
      const dz = desc.matrix.elements[14]! - feet.z
      if (dx * dx + dz * dz <= maxHorizSq) count++
    }
    return count
  }

  /** Near-player colliders first — theatre floors under the avatar cook before distant props. */
  private sortedColliderCookQueue(priority?: THREE.Vector3): number[] {
    const ids = [...this.colliderCookQueue]
    const anchor = priority ?? this.player?.getWorldPosition()
    if (!anchor || ids.length <= 1) return ids

    const distSq = (physId: number): number => {
      const desc = this.sceneScript.getPhysicsColliderDesc(physId)
      if (!desc) return Number.POSITIVE_INFINITY
      const dx = desc.matrix.elements[12]! - anchor.x
      const dz = desc.matrix.elements[14]! - anchor.z
      return dx * dx + dz * dz
    }
    ids.sort((a, b) => distSq(a) - distSq(b))
    return ids
  }

  private resetColliderBootState(): void {
    this.collidersLoadingComplete = false
    this.deferPhysxCooks = true
    this.colliderCookQueue.clear()
    this.pendingColliderCooks = 0
    this.lastPhysicsBatchFp = ''
    this.postBootColliderCatchUpUntil = 0
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
    this.ensureAnimatedGltfEntityLocal(physIds)
    for (const physId of physIds) {
      this.sceneScript.refreshColliderPose(physId)
    }
    const descs = this.collectColliderDescs(physIds)
    const slideDescs: PhysicsColliderDesc[] = []
    for (const desc of descs) {
      if (this.physics.needsWorldBakedPoseRecook(desc)) {
        // Runtime recook off — ack pose drift and keep the boot-cooked actor (planter/structure
        // sync can false-trigger matrixWorld refresh without real movement).
        if (!this.allowsRuntimeColliderRecook()) {
          this.physics.ackStaticPoseFingerprint(desc)
          continue
        }
        const recook = this.physics.syncStaticColliders([desc], {
          cookBudget: 1,
          freezeRemoval: true,
          forceRecookOnPoseChange: true,
          geometryCache: true
        })
        if (recook.geometryChanged) this.scheduleWarmStaticScene()
        else if (this.isColliderDescNearPlayer(desc)) this.colliderCookQueue.add(desc.entity)
        continue
      }
      slideDescs.push(desc)
    }
    const updated = this.physics.applyStaticColliderPoseUpdates(slideDescs)
    if (updated > 0) this.scheduleWarmStaticScene()
    if (this.colliderCookQueue.size > 0 && this.collidersLoadingComplete) {
      void this.drainPendingColliderCooksInitialOnly()
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
  private pushColliderPosesToPhysX(options?: { force?: boolean; forceEntities?: ReadonlySet<number> }): void {
    if (!this.playerMode) return
    this.sceneScript.refreshColliderDescPoses()
    const descs = this.sceneScript.getAllPhysicsColliderDescs()
    const updated = this.physics.applyStaticColliderPoseUpdates(descs, options)
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

  /**
   * Lazy runtime upgrade — world-baked boot cooks freeze Animator treads; recook entity-local only
   * when those entities actually need shape-motion slides (never at boot — stale IDB/worker risk).
   */
  private ensureAnimatedGltfEntityLocal(physIds: number[]): void {
    const stale: PhysicsColliderDesc[] = []
    for (const physId of physIds) {
      if (physId < GLTF_COLLIDER_ENTITY_BASE) continue
      if (!this.physics.isWorldBakedStatic(physId)) continue
      const ecsEntity = (physId - GLTF_COLLIDER_ENTITY_BASE) as Entity
      if (!this.sceneScript.isAnimatedGltfColliderEntity(ecsEntity)) continue
      const desc = this.sceneScript.getPhysicsColliderDesc(physId)
      if (desc) stale.push(desc)
    }
    if (!stale.length) return
    const result = this.physics.syncStaticColliders(stale, {
      cookBudget: stale.length,
      freezeRemoval: true,
      geometryCache: true,
      skipWorkerStream: true
    })
    if (result.geometryChanged) this.scheduleWarmStaticScene()
  }

  /**
   * Composite CRDT can shift transforms after boot cook while onUpdate is still paused.
   * Re-world-bake near-player GLTF colliders before play-ready so walk surfaces match live poses.
   */
  private async sealSpawnColliderPoses(): Promise<void> {
    if (!this.playerMode || !this.player) return
    await this.sceneScript.syncRendererFull()
    this.sceneScript.flushSceneGraphMatrices()
    this.sceneScript.invalidateGltfColliderSyncCache()
    this.sceneScript.syncCollisionForce()

    let drifted = 0
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (!desc.fingerprint.startsWith('gltf-entity:')) continue
      if (!this.physics.isWorldBakedStatic(desc.entity)) continue
      if (!this.physics.needsWorldBakedPoseRecook(desc)) continue
      if (!this.isColliderDescNearPlayer(desc, 72)) continue
      this.physics.invalidateStaticCollider(desc.entity)
      this.colliderCookQueue.add(desc.entity)
      drifted++
    }

    if (drifted > 0) {
      while (this.colliderCookQueue.size > 0) {
        await this.drainColliderCookQueue({ loading: true })
      }
      const feet = this.player.getWorldPosition()
      const sceneProbe = this.physics.probeSceneMeshDownAt(feet, 12)
      console.info(
        `[World] spawn collider seal — recooked ${drifted} drifted GLTF actor(s)` +
          ` sceneProbe=${sceneProbe !== null ? `${sceneProbe.toFixed(2)}m` : 'none'}`
      )
    }
    this.physics.warmStaticScene()
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
    const probeDown = this.physics.debugProbeDownHit(8)
    const nearestGltf = this.nearestGltfColliderHorizDist(probeAt)
    console.info(
      `[World] colliders booted — gltf=${this.physics.gltfStaticActorCount}` +
        (fpMismatch > 0 ? ` fpMismatch=${fpMismatch}` : '') +
        (missingActor > 0 ? ` missingActor=${missingActor}` : '') +
        ` sceneProbe=${sceneProbe !== null ? `${sceneProbe.toFixed(2)}m` : 'none'}` +
        ` nearestGltf=${nearestGltf !== null ? `${nearestGltf.toFixed(1)}m` : 'none'}` +
        ` probeDown=${probeDown !== null ? `${probeDown.toFixed(2)}m` : 'none'}`
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
        void this.drainPendingColliderCooksInitialOnly()
        this.applyColliderPoseSlidesForPhysIds(physIds)
      }
      return
    }
    this.reconcileColliderCookQueue()
    this.maybeBeginRuntimeColliderBurst(queueBefore)
    if (this.collidersLoadingComplete) {
      void this.drainPendingColliderCooksInitialOnly()
    }
  }

  /** Start worker cooks as soon as late GLTF colliders enqueue — drain only deserializes on main. */
  private kickRuntimePhysxCookPrefetch(physIds: number[]): void {
    if (!this.collidersLoadingComplete || !physIds.length) return
    this.sceneScript.flushSceneGraphMatrices()
    for (const physId of physIds) {
      this.sceneScript.refreshColliderBeforeCook(physId)
    }
    const descs = this.collectColliderDescs(physIds)
    if (!descs.length) return
    const queued = startPhysxCookPrefetch(buildPhysxCookPrefetchRequests(descs, true))
    if (queued > 0) {
      clientDebugLog.log(
        'collision',
        `Runtime cook worker queued ${queued} stream(s)`,
        { level: 'info', throttleMs: 2_000 }
      )
    }
  }

  /** Dynamic scene spawn (theatre) — short burst of higher PhysX cook budget. */
  private maybeBeginRuntimeColliderBurst(queueBefore: number): void {
    if (!this.collidersLoadingComplete) return
    const pending = this.colliderCookQueue.size
    const delta = pending - queueBefore
    const nearPlayer = this.countNearPlayerColliderQueue()
    const catchUpActive = performance.now() < this.postBootColliderCatchUpUntil
    if (
      pending >= World.RUNTIME_COLLIDER_BURST_QUEUE ||
      delta >= World.RUNTIME_COLLIDER_BURST_QUEUE ||
      nearPlayer >= 4 ||
      (catchUpActive && nearPlayer >= 1)
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
    const enqueuedPhysIds: number[] = []
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
      enqueuedPhysIds.push(physId)
    }
    this.pendingColliderCooks = this.colliderCookQueue.size
    if (enqueuedPhysIds.length) {
      this.kickRuntimePhysxCookPrefetch(enqueuedPhysIds)
    }
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
          if (!this.allowsRuntimeColliderRecook()) {
            this.physics.ackStaticPoseFingerprint(desc)
          } else if (this.isColliderDescNearPlayer(desc)) {
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

  private async drainColliderCookQueue(options?: {
    hydration?: boolean
    loading?: boolean
    /** Force entity-local cached cook (runtime only — boot uses world-baked via `loading`). */
    entityLocal?: boolean
    /** Post-load: register actors that have never been cooked — never remove/recook existing. */
    initialOnly?: boolean
  }): Promise<void> {
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
    const queueOrder = loadingPass
      ? this.sortedColliderCookQueue(this.colliderCookPriority)
      : this.sortedColliderCookQueue()
    for (const physId of queueOrder) {
      if (toCook.length >= budget) break
      if (loadingPass) {
        this.sceneScript.flushSceneGraphMatrices()
        this.sceneScript.refreshColliderBeforeCook(physId)
      } else if (options?.initialOnly && !this.physics.hasStaticActor(physId)) {
        // Composite/theatre spawns — parent transforms must settle before first PhysX cook.
        this.sceneScript.flushSceneGraphMatrices()
        this.sceneScript.refreshColliderBeforeCook(physId)
      } else {
        this.sceneScript.refreshColliderPose(physId)
      }
      const desc = this.sceneScript.getPhysicsColliderDesc(physId)
      if (!desc) {
        // GLB may still be attaching — keep queued during boot, drop only at runtime.
        if (!loadingPass) this.colliderCookQueue.delete(physId)
        continue
      }
      // Runtime recook off — never remove/recook boot world-baked actors; register only new ones.
      if (!loadingPass && !this.allowsRuntimeColliderRecook() && this.physics.hasStaticActor(physId)) {
        if (desc && this.physics.needsWorldBakedPoseRecook(desc)) {
          this.physics.ackStaticPoseFingerprint(desc)
        }
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
            if (!this.allowsRuntimeColliderRecook()) {
              this.physics.ackStaticPoseFingerprint(desc)
              this.colliderCookQueue.delete(physId)
              continue
            }
            // fall through — world-baked actor needs a full recook (runtime recook enabled)
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
      const geometryCache = options?.entityLocal ? true : !bootStyleCook

      if (!loadingPass) {
        await prefetchPhysxCookStreams(buildPhysxCookPrefetchRequests(toCook, geometryCache), {
          quiet: true,
          maxWaitMs: 12
        })
      }

      const result = this.physics.syncStaticColliders(toCook, {
        cookBudget: toCook.length,
        freezeRemoval: true,
        // Boot world-bakes GLTF trimesh — entity-local boot misaligns actors (see origin/main).
        forceRecookOnPoseChange: bootStyleCook,
        geometryCache,
        skipWorkerStream: loadingPass
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
    void (async () => {
      while (this.colliderCookQueue.size > 0) {
        await this.drainColliderCookQueue({ loading: true })
      }
    })()
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
    this.resetColliderBootState()

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

  /** Wait for GLTF collider extraction to settle — hydration timeout can race ahead of GLB attach. */
  private async waitForColliderExtractionSettle(maxMs: number): Promise<void> {
    const started = performance.now()
    let lastCount = -1
    let stableMs = 0
    while (performance.now() - started < maxMs) {
      await this.sceneScript.syncRendererFull()
      this.sceneScript.flushSceneGraphMatrices()
      this.sceneScript.invalidateGltfColliderSyncCache()
      this.sceneScript.syncCollisionForce()
      this.refreshColliderCookStats()
      const count = this.lastGltfColliderCount
      if (count > 0 && count === lastCount) {
        stableMs += 16
        if (stableMs >= 400) return
      } else {
        stableMs = 0
        lastCount = count
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }

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

      if (assetsTimedOut) {
        onProgress?.('Waiting for collider extraction…')
        await this.waitForColliderExtractionSettle(Math.min(45_000, maxWallMs * 0.35))
      }

      this.lastPhysicsBatchFp = ''
      this.deferPhysxCooks = false
      resetPhysxCookPoolSession()
      clearPrimedPhysxCookStreams()
      resetGeometryCookCacheStats()
      clearGeometryCookCache()
      this.physics.clearGltfStaticActors()
      this.physics.clearFailedCookCaches()
      this.colliderCookQueue.clear()
      this.reconcileColliderCookQueue()

      dclToThreeVec(
        new THREE.Vector3(scene.spawn.x, scene.spawn.y, scene.spawn.z),
        this.colliderCookPriority
      )

      while (
        this.colliderCookQueue.size > 0 ||
        (assetsTimedOut && this.sceneScript.hasColliderWorkPending())
      ) {
        if (performance.now() - started > maxWallMs) {
          const pending = this.colliderCookQueue.size
          const registered = this.physics.gltfStaticActorCount
          const extracted = this.lastGltfColliderCount
          if (assetsTimedOut && registered > 0) {
            console.warn(
              `[World] collider boot timed out after ${(maxWallMs / 1000).toFixed(0)}s — ` +
                `gltf=${registered}/${extracted} pending=${pending}; continuing post-boot catch-up`
            )
            break
          }
          throw new Error(
            `[World] collider boot incomplete after ${(maxWallMs / 1000).toFixed(0)}s — ` +
              `gltf=${registered}/${extracted} pending=${pending}`
          )
        }

        if (this.sceneScript.hasColliderWorkPending()) {
          this.sceneScript.syncCollision()
        }
        this.reconcileColliderCookQueue()
        // World-baked boot cook — entity-local boot misaligns actors.
        await this.drainColliderCookQueue({ loading: true })
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

      // Final matrix pass — last GLB attach / composite flush can land on the queue-empty frame.
      await this.sceneScript.syncRendererFull()
      this.sceneScript.flushSceneGraphMatrices()
      this.sceneScript.invalidateGltfColliderSyncCache()
      this.sceneScript.syncCollisionForce()
      this.reconcileColliderCookQueue()
      while (this.colliderCookQueue.size > 0) {
        await this.drainColliderCookQueue({ loading: true })
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }

      this.physics.warmStaticScene()

      const finalRegistered = this.physics.gltfStaticActorCount
      const finalGltfCount = this.lastGltfColliderCount
      if (finalGltfCount > 0 && finalRegistered < finalGltfCount) {
        if (assetsTimedOut) {
          console.warn(
            `[World] collider boot partial — gltf=${finalRegistered}/${finalGltfCount} PhysX actors; post-boot catch-up active`
          )
        } else {
          throw new Error(
            `[World] collider boot incomplete — gltf=${finalRegistered}/${finalGltfCount} PhysX actors`
          )
        }
      }

      this.collidersLoadingComplete = true
      this.lastPhysicsBatchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()
      if (assetsTimedOut) {
        this.postBootColliderCatchUpUntil = performance.now() + 60_000
        console.info(
          '[World] hydration timed out — post-boot near-player collider catch-up active (60s)'
        )
      }
      if (platformMotionDebug.isEnabled() && this.player) {
        const feet = this.player.getWorldPosition()
        const origin = this.comms.getSceneOrigin()
        requestAnimationFrame(() => {
          this.sceneScript.dumpPlatformMotionReport(feet, origin)
        })
      }

      const elapsedSec = ((performance.now() - started) / 1000).toFixed(1)
      const staticAfter = this.physics.staticColliderCount
      const cookStats = getGeometryCookCacheStats()
      const downProbe = this.physics.probeSceneMeshDownAt(this.colliderCookPriority, 12)
      const nearestGltf = this.nearestGltfColliderHorizDist(this.colliderCookPriority)
      console.info(
        `[World] colliders ready — static=${staticAfter} gltf=${finalRegistered}/${finalGltfCount} (${elapsedSec}s)` +
          ` cookHits=${cookStats.hits} idb=${cookStats.idbHits} worker=${cookStats.worker} main=${cookStats.mainThread} miss=${cookStats.misses}` +
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

  /** Three.js world position for renderer raycasts. */
  getPlayerWorldPosition(): THREE.Vector3 | null {
    if (!this.playerMode || !this.player) return null
    return this.player.getWorldPosition()
  }

  /** Avatar facing yaw (radians) — independent of orbit camera. */
  getPlayerYaw(): number | null {
    if (!this.playerMode || !this.player) return null
    return this.player.getPlayerYaw()
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

  cancelCameraPointer(): void {
    this.player?.cancelCameraPointer()
  }

  getRemoteAvatarManager(): RemoteAvatarManager | null {
    return this.remoteAvatars
  }

  playLocalEmote(emoteRef: string, options?: { loop?: boolean; broadcast?: boolean }): void {
    if (!this.playerMode || !this.player) return
    void this.player.playEmote(emoteRef, { loop: options?.loop }).then((resolved) => {
      if (resolved && options?.broadcast !== false) {
        void this.comms.broadcastEmote(resolved.urn)
      }
    })
  }

  /** Reload local avatar after custom VRM equip / unequip from backpack. */
  async reloadLocalAvatar(): Promise<void> {
    if (!this.playerMode || !this.player) return
    await this.player.reloadAvatar()
    await this.vrmPeerSync.onLocalEquipChanged(this.session.getAddress())
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
      if (!isChatTextLine(event.line)) return
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

  /** Help panel — hide landscape, ocean, and genesis dome while a biome is loaded. */
  private applyEnvironmentDebugVisibility(): void {
    const hasLoaded = environmentDebug.hasLoadedEnvironment()
    const show = hasLoaded && !environmentDebug.isDisabled()

    const root = this.landscape.state.landscapeRoot
    if (root) root.visible = show

    if (this.ocean) this.ocean.group.visible = show

    this.environment.setLandscapeVisualSuppressed(hasLoaded && !show)
  }

  /** Wire landscape into GLTF collider extraction (must run after `sceneScript.prepare`). */
  private bindLandscapeColliders(openIslandShore: boolean): void {
    const root = this.landscape.state.landscapeRoot
    if (!root) return
    this.sceneScript.gltfColliders?.setLandscapeRoot(root, {
      physicsColliders: !openIslandShore
    })
    this.lastPhysicsBatchFp = ''
  }

  private syncOutdoorLighting(): void {
    const lighting = this.environment.getOutdoorLighting()
    this.ocean?.applyOutdoorLighting?.(lighting)
    const shoreRoot = this.landscape.state.landscapeRoot?.getObjectByName('landscape:island-shore')
    const shoreMat = shoreRoot?.userData.islandShoreMaterial as IslandShoreMaterial | undefined
    shoreMat?.applyOutdoorLighting(lighting)
  }

  private async createOpenOcean(scene: ResolvedScene): Promise<SceneWater> {
    const ocean = await OpenOceanWater.create(scene.parcels, scene.baseParcel)
    return {
      group: ocean.group,
      update: (delta, camera) => ocean.update(delta, camera),
      applyOutdoorLighting: (lighting) => ocean.applyOutdoorLighting(lighting),
      dispose: () => ocean.dispose(),
      perfInfo: ocean.perf
    }
  }

  private async createFftOcean(
    scene: ResolvedScene,
    mode: 'open' | 'island',
    fftSettings: ReturnType<typeof readFftOceanOverride>,
    shoreWidthParcels?: number
  ): Promise<SceneWater> {
    try {
      const ocean = await FftOceanWater.create(
        scene.parcels,
        scene.baseParcel,
        this.host.renderer,
        { mode, shoreWidthParcels, settings: fftSettings }
      )
      return {
        group: ocean.group,
        update: (delta, camera) => ocean.update(delta, camera),
        applyOutdoorLighting: (lighting) => ocean.applyOutdoorLighting(lighting),
        dispose: () => ocean.dispose(),
        perfInfo: ocean.perf
      }
    } catch (err) {
      console.error('[ocean] FFTOCEAN init failed — falling back to Water.js', err)
      return mode === 'island'
        ? this.createIslandWater(scene, shoreWidthParcels ?? 1)
        : this.createOpenOcean(scene)
    }
  }

  private async createIslandWater(
    scene: ResolvedScene,
    shoreWidthParcels: number
  ): Promise<SceneWater> {
    const ocean = await IslandWater.create(scene.parcels, scene.baseParcel, shoreWidthParcels)
    return {
      group: ocean.group,
      update: (delta, camera) => ocean.update(delta, camera),
      applyOutdoorLighting: (lighting) => ocean.applyOutdoorLighting(lighting),
      dispose: () => ocean.dispose(),
      perfInfo: ocean.perf
    }
  }

  private clearOcean(): void {
    this.ocean?.dispose()
    this.ocean = null
    this.host.renderStats.setOceanPerf(null)
    const stalePlane = this.host.scene.getObjectByName('water-plane')
    const staleRing = this.host.scene.getObjectByName('ocean-ring')
    const staleIsland = this.host.scene.getObjectByName('island-water')
    const staleOpenOcean = this.host.scene.getObjectByName('open-ocean-water')
    stalePlane?.removeFromParent()
    staleRing?.removeFromParent()
    staleIsland?.removeFromParent()
    staleOpenOcean?.removeFromParent()
  }

  dispose(): void {
    this.unsubAvatarChat?.()
    this.unsubAvatarChat = null
    this.unsubEnvironmentDebug?.()
    this.unsubEnvironmentDebug = null
    this.host.stop()

    this.player?.dispose()
    this.player = null
    this.remoteAvatars?.dispose()
    this.remoteAvatars = null

    this.clearOcean()
    this.environment.dispose()

    this.ezTreeGrass?.dispose()
    this.ezTreeGrass = null
    resetFoliageWindRegistry()
    this.landscape.state.landscapeRoot?.removeFromParent()
    this.landscape.state.landscapeRoot = null
    this.sceneScript.gltfColliders?.setLandscapeRoot(null)

    this.sceneScript.dispose()
    this.physics.dispose()
    disposePhysxSimWorker()

    this.vrmPeerSync.detach()
    clearVrmRamCache()
    this.comms.dispose()
    this.social.dispose()

    this.assets.clearScene()
    clearGeometryCookCache()
    clearPrimedPhysxCookStreams()
    disposePhysxCookPool()

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
