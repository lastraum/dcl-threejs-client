import type { Entity } from '@dcl/ecs'
import type { ResolvedScene } from '../dcl/content/types'
import * as THREE from 'three'
import { createTerrainModel } from '../dcl/landscape/Worlds/TerrainModel'
import { getSessionAssetCache, prefetchSceneManifestAssets } from '../rendering/AssetCache'
import {
  applyClientPerformanceDefaults,
  detectPerformanceTier,
  resolveEngineTickIntervalMs
} from '../client/detectPerformanceTier'
import { SceneHost } from '../rendering/SceneHost'
import { setSceneNameTagsVisible } from '../client/ui/nameTagVisibility'

import { GLTF_COLLIDER_ENTITY_BASE } from '../collision/GltfColliderExtractor'
import { isPlausibleSpawnSurfaceY, PhysXWorld } from '../physics/PhysXWorld'
import { PlayerSystem } from '../player/PlayerSystem'
import {
  islandCircularWalkBounds,
  sceneWorldBounds,
  type PlayerWalkBounds
} from '../player/SceneBounds'
import { genesisCityWalkBounds } from '../player/genesisCityBounds'
import { AoiVisualLayer } from '../dcl/aoi/AoiVisualLayer'
import { ScenePromoteController } from '../dcl/aoi/ScenePromoteController'
import type { MultiSceneRuntime } from '../dcl/multiScene/MultiSceneRuntime'
import { PeMainThreadMirror } from '../dcl/multiScene/PeMainThreadMirror'
import {
  collectPlayerClaims,
  PlayerClaimApplier
} from '../dcl/multiScene/PlayerClaimMerger'
import {
  hostPoseModeFromClaims,
  hostPoseModeLabel,
  type HostPoseMode
} from '../dcl/multiScene/HostPoseMode'
import {
  resolvePortableExperiencesPolicy,
  type PortableExperiencesPolicy
} from '../dcl/multiScene/resolvePortableExperiences'
import { renderQuality } from '../rendering/RenderQualitySettings'
import { applyAvatarToonShading } from '../avatar/materials'
import type { PerformanceTier } from '../shim/types'
import { LandscapeSystem } from './systems/LandscapeSystem'
import { SceneScriptSystem } from './systems/SceneScriptSystem'
import { EnvironmentSystem } from '../environment/EnvironmentSystem'
import { FftOceanWater } from '../environment/FftOceanWater'
import { IslandWater } from '../environment/IslandWater'
import { OpenOceanWater } from '../environment/OpenOceanWater'
import { OceanRing } from '../environment/OceanRing'
import {
  isClientWaterDisabled,
  resolveFftOceanSettings,
  type FftOceanSettings
} from '../environment/fftOcean/readFftOceanOverride'
import type { OceanPerfInfo } from '../client/ui/RenderStats'
import type { OutdoorLightingSnapshot } from '../environment/OutdoorLighting'
import type { IslandShoreMaterial } from '../dcl/landscape/IslandShoreMaterial'
import {
  landscapeProfileForResolvedScene,
  resolveSceneEnvironment
} from '../dcl/landscape/resolveLandscapeEnvironment'
import type { EzTreeGrassFieldHandle } from '../dcl/landscape/EzTreeGrassField'
import { buildAuthorTerrainGrassField } from '../dcl/landscape/AuthorTerrainGrassField'
import { sceneHasAuthorTerrain } from '../dcl/content/sceneAuthorTerrain'
import { readEnvironmentWindShader } from '../dcl/landscape/readEnvironmentWindShader'
import { resetFoliageWindRegistry, updateFoliageWind } from '../dcl/landscape/foliageWind'
import { SessionIdentity } from '../network/SessionIdentity'
import { RemoteAvatarManager } from '../network/RemoteAvatarManager'
import { CommsService } from '../network/CommsService'
import { VoiceChatService } from '../network/voice/VoiceChatService'
import { logSyncOutbound } from '../network/comms/syncDebug'
import { blacklistFromMetadata } from '../network/sceneAccess/sceneAccessCommon'
import { buildEmoteWheelSlots, resolveSceneEmoteFromSrc } from '../avatar/profileEmotes'
import { SocialService } from '../social/SocialService'
import { isChatTextLine } from '../social/types'
import { overheadChatText } from '../social/overheadChatText'
import { chatTranslationService } from '../social/translation'
import { NAME_TAG_CHAT_DISPLAY_MS } from '../client/ui/NameTag'
import {
  clearProfileCaches,
  fetchProfileFaceUrl,
  seedCommsPeerProfile,
  seedLocalProfileCache
} from '../avatar/peerApi'
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
import {
  feetDclToPlayerEntityPosition,
  feetThreeFromPlayerEntityDcl
} from '../player/dclPlayerEntity'
import type { PhysicsColliderDesc } from '../physics/PhysXWorld'

import { openExternalUrl } from '../player/openExternalUrl'
import { copyToClipboard } from '../player/copyToClipboard'
import { openNftDialog } from '../player/openNftDialog'
import { parseTeleportParcel } from '../player/teleportTo'
import type { RouteTarget } from '../dcl/content/route'
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
import { isTextInputFocused } from '../client/ui/textInputFocus'
import { skipRemoteAvatars } from '../client/devFlags'
import { InputHub } from '../input/InputHub'
import { initMainThreadPerfFromUrl, recordMainThreadPerf } from '../debug/MainThreadPerf'
import { VrmPeerSync } from '../avatar/vrm/VrmPeerSync'
import { clearVrmRamCache } from '../avatar/vrm/vrmRamCache'
import { PhotoCameraController } from '../photo/PhotoCameraController'
import type { PhotoPersonSample } from '../photo/photoMetadata'

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
  /** Mutable so promote handoff can adopt a live secondary worker as primary. */
  sceneScript = new SceneScriptSystem()
  readonly physics = new PhysXWorld()
  readonly session = new SessionIdentity()
  /** May be replaced by landing handoff (`adoptComms`) — keep LiveKit without reconnect. */
  comms: CommsService = new CommsService()
  /** Nearby voice over primary LiveKit room (PTT / open-mic + mute-in-background). */
  readonly voice = new VoiceChatService()
  readonly social = new SocialService()
  readonly host: SceneHost
  readonly environment: EnvironmentSystem
  private readonly lightManager: LightManager
  private ocean: SceneWater | null = null
  private player: PlayerSystem | null = null
  private remoteAvatars: RemoteAvatarManager | null = null
  private readonly vrmPeerSync = new VrmPeerSync()
  /** Explorer In-World Camera (photo fly mode) — dedicated lens, not orbit freecam. */
  private photoCamera: PhotoCameraController | null = null
  private photoChromeHandler: ((visible: boolean) => void) | null = null
  /** Last loaded scene — photo metadata place name. */
  private photoSceneTitle = 'Scene'
  private playerMode = !useOrbitMode()
  private editorPreviewMode = false
  /** AppController HUD — remote avatar compose progress toast. */
  private remoteAvatarProgressHandler:
    | ((progress: { total: number; loaded: number; pending: number }) => void)
    | null = null
  private lastRemoteProgressKey = ''
  private remoteProgressReportAt = 0
  /** AppController — RestrictedActions teleportTo / changeRealm. */
  private navigateHandler:
    | ((target: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>) => void)
    | null = null
  private lastGltfColliderCount = 0
  private loggedGltfPhysMismatch = false
  private collidersPhysLastLog = 0

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
  private colliderCookDrainInFlight = false
  private bootAssetsTimedOut = false
  /** Plaza-scale scenes — keep cooking near-player GLTF colliders after hydration timeout. */
  private postBootColliderCatchUpUntil = 0

  /** Runtime burst (e.g. theatre Scene 11/12) — drain with loading-style recook until idle. */
  private runtimeColliderBurstUntil = 0
  /** True after boot cook + pose push — gates world-baked pose-ack shortcuts at runtime. */
  private spawnColliderSealComplete = false
  private unsubAvatarChat: (() => void) | null = null
  private unsubAvatarChatTranslate: (() => void) | null = null
  /** Preferences → Graphics → Avatar toon — re-skin live meshes without full reload. */
  private unsubAvatarToon: (() => void) | null = null
  private lastAvatarToonEnabled: boolean | null = null
  /**
   * Last overhead chat per peer — used to swap in a translation when it arrives
   * before the bubble expires (Unity Explorer auto-translate bubbles).
   */
  private readonly overheadChatActive = new Map<
    string,
    { messageId: string; originalText: string; shownAt: number }
  >()
  private playerWalkBounds: PlayerWalkBounds | null = null
  /** Phase A2 — coords AOI blank ground + composite secondary visuals (tertiary). */
  private readonly aoiVisual = new AoiVisualLayer()
  /**
   * Multi-scene runtime (secondary live workers + PE ticks). Owned by AppController
   * so PE preferences survive World rebuild on /goto.
   */
  private multiScene: MultiSceneRuntime | null = null
  private readonly peMirror = new PeMainThreadMirror()
  /** Phase B — continuous claims from all layers (locomotion / camera / pose / force). */
  private readonly playerClaims = new PlayerClaimApplier()
  /** Phase D — last host pose mode (for one-shot logs). */
  private lastHostPoseMode: HostPoseMode = 'host_feet'
  /**
   * Single keyboard bus — primary scene + PE workers subscribe; hardware owned once.
   * Sync once per play frame (not per SceneScriptSystem).
   */
  readonly inputHub = new InputHub()
  private performanceTier: PerformanceTier = 'high'
  private loadedPrimaryScene: ResolvedScene | null = null
  /**
   * Multi-scene Phase B — stand-on-parcel promotes that scene to primary
   * (full scripts). Wired to navigateHandler after load.
   */
  private promoteNavigate:
    | ((target: Extract<RouteTarget, { kind: 'coords' }>, reason: string) => void)
    | null = null
  private promoteSoftRoute: ((x: number, y: number) => void) | null = null
  private promotePrefetch: ((x: number, y: number) => void) | null = null
  private readonly scenePromote = new ScenePromoteController({
    onPromote: (target, reason) => {
      console.info(`[World] promote primary → ${target.x},${target.y} (${reason})`)
      if (this.promoteNavigate) this.promoteNavigate(target, reason)
      else this.navigateHandler?.(target)
    },
    onSoftRoute: (x, y) => this.promoteSoftRoute?.(x, y),
    // Inner radius: warm scripts/manifests. Outer Scene Distance = composite GLBs (AoiVisualLayer).
    onPrefetch: (x, y) => this.promotePrefetch?.(x, y),
    dwellMs: 320,
    cooldownMs: 2_000
  })
  private ezTreeGrass: EzTreeGrassFieldHandle | null = null
  private ezTreeGrassElapsed = 0
  private desertAtmosphere: import('../environment/DesertAtmosphere').DesertAtmosphere | null = null
  private foliageWindElapsed = 0
  private unsubEnvironmentDebug: (() => void) | null = null
  private lastVoluntaryEmoteAllowed = true
  private onVoluntaryEmoteAllowedChange: ((allowed: boolean) => void) | null = null

  /** Per-tick budget while GLBs still attaching on the loading screen. */
  private static readonly HYDRATION_COLLIDER_COOK_BUDGET = 80
  /** Per-frame budget during the post-hydration loading drain. */
  private static readonly LOADING_COLLIDER_COOK_BUDGET = 96
  private static readonly RUNTIME_COLLIDER_COOK_BUDGET = 8
  /** Burst cook after dynamic scene spawns (theatre) — higher per-frame budget. */
  private static readonly RUNTIME_COLLIDER_BURST_BUDGET = 12
  private static readonly RUNTIME_COLLIDER_BURST_MS = 3_000
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
    this.performanceTier = performanceTier
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
    // Live Preferences → Graphics → Avatar toon (no full avatar reload / page refresh).
    this.unsubAvatarToon = renderQuality.subscribe((opts) => {
      if (this.lastAvatarToonEnabled === opts.avatarToonEnabled) return
      this.lastAvatarToonEnabled = opts.avatarToonEnabled
      this.applyAvatarToonToLiveMeshes(opts.avatarToonEnabled)
    })

    this.wireCommsHandlers()
  }

  /** Re-skin local + remote avatars when toon preference toggles. */
  private applyAvatarToonToLiveMeshes(enabled: boolean): void {
    const local = this.player?.getLocalAvatar()?.getModel()
    if (local) applyAvatarToonShading(local, enabled)
    this.remoteAvatars?.forEachModel((model) => applyAvatarToonShading(model, enabled))
  }

  /**
   * Landing → play: take the shell's live CommsService (already in world+scene rooms).
   * Does **not** disconnect LiveKit — only rewires peer handlers onto this World.
   */
  adoptComms(shellComms: CommsService, opts?: { isWorld?: boolean }): void {
    if (this.comms === shellComms) {
      this.sceneCommsConnected = shellComms.isLiveKitConnected()
      if (opts?.isWorld != null) this.comms.pruneUnusedLiveKitForTarget({ isWorld: opts.isWorld })
      // Handoff cleared chat handlers — re-bind 3D SocialService immediately.
      this.social.rewireComms(this.comms)
      return
    }
    this.vrmPeerSync.detach()
    const unused = this.comms
    this.comms = shellComms
    // Fresh World service never joined — safe to dispose without killing LiveKit.
    unused.dispose()

    this.wireCommsHandlers()
    // Shell cleared setChatHandler(null) on transfer — bind 3D chat NOW (not after long spawn).
    this.social.rewireComms(this.comms)
    this.sceneCommsConnected = this.comms.isLiveKitConnected()
    if (opts?.isWorld != null) this.comms.pruneUnusedLiveKitForTarget({ isWorld: opts.isWorld })
    // Peers already in the room never re-fire join — push them into RemoteAvatarManager.
    this.comms.notifyHandlersOfCurrentPeers()
    this.syncVoiceRoom()
    const counts = this.comms.getLivePeerCounts()
    clientDebugLog.log(
      'network',
      `Adopted landing LiveKit · live=${this.sceneCommsConnected} worldPeers=${counts.world} scenePeers=${counts.scene} island=${counts.island}`,
      { level: 'success', alsoConsole: true }
    )
  }

  /**
   * Wire 3D scene chat as soon as we know the scene pointer (before spawn).
   * Without this, handoff leaves chatHandler null for the whole hydration window and
   * ChatPanel (world.social) never sees lines that 2D landing already showed.
   */
  bootstrapSocialChat(scene: ResolvedScene): void {
    const address = this.session.getAddress()
    const identity = this.session.getAuthIdentity()
    if (!address || !identity) return
    const chatOk = scene.browserChatEnabled && scene.realm.commsEnabled !== false
    void this.social.attachSceneComms({
      comms: this.comms,
      sceneTab: {
        key: scene.commsPointer,
        label: scene.title || scene.commsPointer,
        pointer: scene.commsPointer,
        browserChatEnabled: chatOk
      },
      contentUrl: scene.realm.contentUrl
    })
    console.log('[chat] 3d social bootstrapped ·', scene.commsPointer)
  }

  /**
   * Bind voice rooms:
   * - Worlds → world LiveKit only
   * - Parcels → island + scene (Explorer nearby needs island; archipelago Z must be correct)
   * Does **not** unlock audio — call `unlockVoiceInPlay()` after spawn.
   */
  syncVoiceRoom(): void {
    this.comms.onLiveKitRoomsChanged = () => {
      this.voice.refreshRooms()
      console.log('[voice]', 'rooms changed', this.comms.describeLiveKitRooms())
      this.voice.dumpStatus('rooms-changed', true)
      this.logAllRoomsAudio('rooms-changed')
    }
    this.voice.bindRoomsProvider(() => this.comms.getVoiceLiveKitRooms())
    this.voice.bindStatusProvider(() => this.comms.describeLiveKitRooms())
    this.voice.bindInventoryProvider(() => this.comms.describeAllRoomsAudioInventory())
    this.wireVoiceSpatial()
    this.voice.refreshRooms()
    console.log('[voice]', 'syncVoiceRoom', this.comms.describeLiveKitRooms())
    this.voice.dumpStatus('sync')
  }

  /** PositionalAudio listener + peer avatar roots for 3D voice falloff. */
  private wireVoiceSpatial(): void {
    this.voice.setAudioListener(this.sceneScript?.getAudioListener() ?? null)
    this.voice.setPeerObjectProvider((address) => this.remoteAvatars?.getPeerRoot(address) ?? null)
  }

  /** Unlock nearby voice only when play chrome is ready (not during loading). */
  unlockVoiceInPlay(): void {
    // Archipelago still used for movement/nearby peers — not for voice (ADR-204 = scene room).
    const pos = this.player?.getPosition()
    if (pos) this.comms.seedArchipelagoSceneLocal(pos.x, pos.y, pos.z)
    void this.comms.ensureArchipelagoConnected()
    // Explorer maps voice bars via LiveKit name + profile packets — refresh after handoff.
    const dn = this.session.getProfile()?.displayName ?? null
    this.comms.setCommsProfile(this.session.getCommsProfileEntity())
    this.comms.applyLocalDisplayName(dn)
    this.comms.announceProfile('connect')
    this.syncVoiceRoom()
    this.wireVoiceSpatial()
    this.voice.setInPlay(true)
    // Browser autoplay: unlock immediately; also re-arm on first canvas pointer (below).
    void this.voice.unlockRemotePlayback('in-play')
    this.armVoiceUnlockOnUserGesture()
    this.logAllRoomsAudio('in-play')
    console.log('[voice] unlocked · displayName=', dn ?? '(none)', '·', this.comms.describeLiveKitRooms())
  }

  /**
   * Keep re-trying LiveKit startAudio + element.play() on user gestures until remotes
   * actually play. A one-shot unlock often runs before tracks attach (autoplay then
   * fails later outside the gesture turn → silent voice with activeSpeakers still on).
   */
  private voiceGestureUnlockBound = false
  private armVoiceUnlockOnUserGesture(): void {
    if (this.voiceGestureUnlockBound) return
    this.voiceGestureUnlockBound = true
    const onGesture = (): void => {
      if (!this.voice.isInPlay()) return
      if (!this.voice.needsPlaybackUnlock() && this.voice.getSnapshot().remoteCount > 0) return
      void this.voice.unlockRemotePlayback('user-gesture')
    }
    window.addEventListener('pointerdown', onGesture, true)
    window.addEventListener('keydown', onGesture, true)
  }

  /** Log scene/world/island remote track inventory (find mic on wrong room). */
  logAllRoomsAudio(reason: string): void {
    const inv = this.comms.describeAllRoomsAudioInventory()
    console.log(`[voice] all-rooms inventory (${reason}):\n${inv}`)
    // Same moment: dump LiveKit *video* pubs (stream keys / Cast) — audio inventory never lists them.
    this.comms.logCastVideoInventory(`world-${reason}`)
  }

  /** Drive 3 green voice bars on local + remote name tags. */
  applyVoiceLevelsToNameTags(levels: ReadonlyMap<string, number>): void {
    const local = this.session.getAddress()?.toLowerCase() ?? ''
    this.player?.setNameTagVoiceLevel(local ? (levels.get(local) ?? 0) : 0)
    this.remoteAvatars?.applyVoiceLevels(levels)
  }

  private wireCommsHandlers(): void {
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

    this.remoteAvatars &&
      this.comms.setHandlers({
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
              jumpCount: payload.jumpCount,
              glideState: payload.glideState
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

    // Inbound scene-binary is delivered only via CommsInboundQueue → sendBinary response.
    // Do not also postMessage `comms-receive-binary` here: that double-delivered every packet
    // (and used to force type=CRDT, which broke AUTH_RES / CUSTOM_EVENT handlers).
    this.comms.setTopicMessageHandler((topic, sender, payload) => {
      if (topic !== 'comms') return
      const message = new TextDecoder().decode(payload)
      this.sceneScript.engineApiEvents.pushCommsMessage(message, sender)
    })
  }

  private loginIsGuest = false

  applyLogin(choice: LoginResult | null): void {
    this.loginIsGuest = choice?.kind === 'guest'
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
    const isWorld = scene.source.kind === 'world'
    // Lowercase world realm for gatekeeper so Cast/stream-keys share the same LiveKit room.
    const realmName = isWorld
      ? scene.commsPointer.trim().toLowerCase()
      : scene.realm.realmName?.trim() || 'main'
    return {
      pointer: scene.commsPointer,
      baseParcel: scene.baseParcel,
      sceneId: scene.entityId ?? '',
      realmName,
      contentUrl: scene.realm.contentUrl,
      parcels: scene.parcels,
      isWorld,
      sceneTitle: scene.title,
      metadataBlacklist: blacklistFromMetadata(scene.metadata),
      // Worlds: optional LiveKit — false when /about has no adapter (content-only server).
      commsEnabled: scene.realm.commsEnabled,
      commsAdapterHint: scene.realm.commsAdapterHint
    }
  }

  async loadScene(scene: ResolvedScene, onProgress?: (msg: string) => void): Promise<void> {
    this.photoSceneTitle =
      scene.metadata?.display?.title?.trim() ||
      (scene.source.kind === 'world' ? scene.source.worldName : null) ||
      scene.baseParcel ||
      'Scene'
    if (skipRemoteAvatars()) {
      clientDebugLog.log('network', 'Remote avatars disabled (?noremote)', {
        alsoConsole: true,
        throttleMs: 60_000
      })
    }
    this.assets.setScene(scene)
    // scene.json / ?nameTags= — policy lock (like skybox fixedTime). User N only when allowed.
    setSceneNameTagsVisible(scene.nameTagsVisible !== false)
    if (scene.nameTagsVisible === false) {
      clientDebugLog.log('client', 'Name tags locked off (scene.json or ?nameTags=)', {
        alsoConsole: true
      })
    }
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

    // Local projects used to skip landscape; honor environment.kind so desert/island/etc.
    // match the same buildParcelLandscape path as worlds/coords (editor + play parity).
    const skipClientLandscape =
      scene.source.kind === 'local' && landscapeProfile.kind === 'none'
    const terrain = createTerrainModel(
      scene.parcels,
      landscapeProfile.borderPadding,
      landscapeProfile.circularShore === true
    )

    this.ezTreeGrass?.dispose()
    this.ezTreeGrass = null
    this.ezTreeGrassElapsed = 0
    this.desertAtmosphere = null
    this.foliageWindElapsed = 0
    this.host.scene.fog = null

    if (!skipClientLandscape) {
      await this.landscape.initialize(scene, this.assets, onProgress)
      this.ezTreeGrass =
        (this.landscape.state.landscapeRoot?.userData.ezTreeGrass as EzTreeGrassFieldHandle | undefined) ??
        null
      this.desertAtmosphere =
        (this.landscape.state.landscapeRoot?.userData.desertAtmosphere as
          | import('../environment/DesertAtmosphere').DesertAtmosphere
          | undefined) ?? null
      if (this.landscape.state.landscapeRoot) {
        this.host.scene.add(this.landscape.state.landscapeRoot)
      }
      // Mountains atmospheric haze (exp2 fog).
      if (landscapeProfile.kind === 'mountains') {
        const env =
          scene.metadata?.environment &&
          typeof scene.metadata.environment === 'object' &&
          !Array.isArray(scene.metadata.environment)
            ? (scene.metadata.environment as import('../dcl/content/types').SceneEnvironmentConfig)
            : undefined
        const { resolveMountainsSettings } = await import('../environment/mountainsDefaults')
        const m = resolveMountainsSettings(env?.mountains)
        if (m.haze > 0.0001) {
          const THREE = await import('three')
          this.host.scene.fog = new THREE.FogExp2(m.hazeColor, m.haze)
        }
      } else if (landscapeProfile.kind === 'desert' && this.desertAtmosphere) {
        this.desertAtmosphere.applyToScene(this.host.scene)
      }
    } else if (sceneHasAuthorTerrain(scene)) {
      // Local projects skip empty-land tiles, but still need paint-driven grass on editor terrain.
      onProgress?.('Planting author-terrain grass…')
      try {
        this.ezTreeGrass = await buildAuthorTerrainGrassField(scene, {
          windShader: readEnvironmentWindShader(scene.metadata),
          onProgress
        })
        if (this.ezTreeGrass) this.host.scene.add(this.ezTreeGrass.group)
      } catch (err) {
        console.warn('[windShader] author-terrain grass failed', err)
      }
    }

    this.clearOcean()
    const fftSettings = resolveFftOceanSettings(scene.metadata)
    // waterEnabled folds scene.json + URL (?water=0 / noWater / disableWater)
    const waterDisabled = !fftSettings.waterEnabled || isClientWaterDisabled()
    if (!skipClientLandscape && landscapeProfile.showWater && waterDisabled) {
      console.info(
        '[ocean] disabled (?water=0 / scene environment.water.enabled=false) — no water mesh or GPGPU'
      )
    } else if (!skipClientLandscape && landscapeProfile.showWater) {
      const useFftOcean = fftSettings.enabled && this.host.renderer.capabilities.isWebGL2
      if (fftSettings.enabled && !useFftOcean) {
        console.warn('[ocean] FFTOCEAN requires WebGL2 — using Water.js')
      }
      console.info(
        `[ocean] env=${landscapeProfile.kind} openOcean=${openOcean} fftOcean=${useFftOcean} fft=${fftSettings.fftResolution} amp=${fftSettings.amplitude}`
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
    // Coords + Scene Distance > 0: open Genesis walk (infinite ground plane) — no parcel walls.
    const openCityWalk =
      scene.source.kind === 'coords' && renderQuality.getSceneLoadRadiusM() > 0
    this.physics.syncLandscapeGround(terrain.landscapeParcelKeys, scene.baseParcel, scene.parcels, {
      perimeterWalls: !openIslandShore && !openOcean && !openCityWalk
    })
    this.playerWalkBounds = openIslandShore
      ? islandCircularWalkBounds(scene.parcels, scene.baseParcel, landscapeProfile.borderPadding)
      : openCityWalk
        ? genesisCityWalkBounds(scene.baseParcel)
        : { mode: 'rect', bounds: sceneWorldBounds(scene.parcels, scene.baseParcel) }

    this.loadedPrimaryScene = scene
    this.aoiVisual.bind({
      scene,
      cache: this.assets,
      hostScene: this.host.scene,
      syncRoadColliders: (descs) => {
        const result = this.physics.syncAoiRoadColliders(descs)
        if (result.geometryChanged) this.physics.warmStaticScene()
      },
      clearRoadColliders: () => this.physics.clearAoiRoadColliders(),
      onSecondaryCandidates: (candidates) => {
        this.multiScene?.reconcileSecondaries(candidates)
      }
    })
    this.scenePromote.bind(scene)
    if (openCityWalk) {
      console.info(
        `[aoi] Genesis walk — outer composites=${renderQuality.getSceneLoadRadiusM()}m · inner script-warm via promote · base=${scene.baseParcel}`
      )
    }

    if (scene.mainEntry && scene.entityId) {
      this.resetColliderBootState()
      this.sceneScript.prepare(scene, this.assets, this.host)
      // Scene audio listener is created in prepare — wire spatial voice now.
      this.wireVoiceSpatial()
      this.sceneScript.setLiveKitVideoBinder((video, onUpdate) =>
        this.comms.bindLiveKitVideoSource(video, onUpdate)
      )
      // Scene LiveKit video (stream-key and/or Cast) — not world-room voice cams.
      this.sceneScript.setLiveKitRemoteLiveCheck(() => this.comms.hasSceneLiveKitVideoLive())
      this.remoteAvatars?.setEntityStore(this.sceneScript.getEntityStore())
      this.remoteAvatars?.setPeerMirrorIdentityHandler((entity, identity) =>
        this.sceneScript.setRemotePlayerIdentity(entity, identity)
      )
      dclToThreeVec(
        new THREE.Vector3(scene.spawn.x, scene.spawn.y, scene.spawn.z),
        this.colliderCookPriority
      )
      this.sceneScript.setCollidersCookCallback((entity) => this.onColliderCookRequest(entity))
      this.sceneScript.setCollidersPoseCallback((entities) => this.applyColliderPoseSlides(entities))
      this.sceneScript.setCollidersRemoveCallback((entity) => this.onColliderEntityRemoved(entity))
      this.sceneScript.setRealmInfoProvider(() => this.comms.getRealmInfo())
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
      this.sceneScript.setOpenNftDialogHandler((request) => openNftDialog(request))
      this.sceneScript.setCopyToClipboardHandler((request) => copyToClipboard(request))
      // teleportTo = global parcel coords (Genesis) → navigate; not scene-local movePlayerTo.
      this.sceneScript.setTeleportToHandler((request) => {
        const parcel = parseTeleportParcel(request)
        if (!parcel) return false
        this.navigateHandler?.({
          kind: 'coords',
          x: parcel.x,
          y: parcel.y,
          segment: `${parcel.x},${parcel.y}`
        })
        return true
      })
      // changeRealm is deprecated — keep handler for SDK compat but never navigate.
      this.sceneScript.setChangeRealmHandler(() => {
        console.info('[World] changeRealm ignored (deprecated)')
        return false
      })
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
      this.sceneScript.setRealmInfo(this.comms.getRealmInfo())

      this.sceneScript.setMovePlayerHandler((request) => {
        const ok = this.player!.movePlayerTo(request)
        // Round-reset teleports often land while InputModifier is frozen / ticks held after UI.
        // Nudge worker play so scene systems can clear freeze and advance reset timers.
        this.sceneScript.nudgePlayAfterSceneTeleport()
        return ok
      })
      this.player.setModeFreezeEscapeHandler(() => {
        this.sceneScript.requestForceLocomotionClear('wasd-mode-freeze-escape')
      })
      this.sceneScript.setTriggerEmoteHandler((request) => {
        const emote = request.predefinedEmote?.trim()
        if (!emote) return false
        clientDebugLog.log('pointer', `triggerEmote → ${emote}`, { alsoConsole: true })
        void this.playLocalEmote(emote, { loop: undefined, sceneTriggered: true })
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
        void this.playLocalEmote(resolved.urn, { loop: resolved.loop, sceneTriggered: true })
        return true
      })
      this.sceneScript.setAvatarEmoteHandler({
        play: (emoteUrn, loop) => {
          if (!emoteUrn.trim()) return false
          void this.playLocalEmote(emoteUrn.trim(), { loop, broadcast: true, sceneTriggered: true })
          return true
        },
        stop: () => this.player!.stopEmote()
      })
    } else {
      this.host.focusSpawn(scene)
      this.host.setOrbitEnabled(true)
      this.sceneScript.setPlayerIdentity(buildPlayerMirrorIdentity({}))
      this.sceneScript.setRealmInfo(this.comms.getRealmInfo())
    }

    if (scene.mainEntry && scene.entityId) {
      onProgress?.('Compiling scene script…')
      const spawnPoses = this.seedPosesFromSpawn(scene.spawn)
      // Stage before worker boot so scene onStart / systems never read PE at origin
      // (Flagtag drown UI false-trigger → movePlayerTo tower).
      this.player?.stageSpawnPoses(spawnPoses.player, spawnPoses.camera, spawnPoses.feetThree)
      console.info(
        `[World] staged PE spawn before script boot — feet three=(${spawnPoses.feetThree.x.toFixed(1)}, ${spawnPoses.feetThree.y.toFixed(2)}, ${spawnPoses.feetThree.z.toFixed(1)})` +
          ` peY=${spawnPoses.player.position.y.toFixed(2)}`
      )
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
   * If landing already transferred a live session via `adoptComms`, skips reconnect.
   */
  async connectSceneCommsEarly(scene: ResolvedScene, onProgress?: (msg: string) => void): Promise<void> {
    if (!this.playerMode) return

    const address = this.session.getAddress()
    const identity = this.session.getAuthIdentity()
    if (!address || !identity) return

    this.comms.setIdentity(address, identity)
    this.comms.setCommsProfile(this.session.getCommsProfileEntity())
    this.comms.setLambdasUrl(scene.realm.lambdasUrl)
    this.remoteAvatars?.setLocalAddress(address)
    this.vrmPeerSync.setLocalAddress(address)

    // Landing handoff: already in the rooms — do not disconnect/reconnect.
    if (this.sceneCommsConnected || this.comms.isLiveKitConnected()) {
      this.sceneCommsConnected = true
      const target = this.buildCommsTarget(scene)
      this.comms.bindSceneTarget(target)
      this.comms.applyRealmAbout(scene.realm, scene.commsPointer)
      this.comms.pruneUnusedLiveKitForTarget({ isWorld: target.isWorld === true })
      // Landing may have scene LiveKit without archipelago island — force realm path.
      if (target.isWorld !== true) {
        await this.comms.ensureArchipelagoConnected()
      }
      this.comms.seedArchipelagoSceneLocal(scene.spawn.x, scene.spawn.y, scene.spawn.z)
      this.comms.notifyHandlersOfCurrentPeers()
      this.syncVoiceRoom()
      // Re-bind 3D chat after handoff cleared shell handlers (before spawn).
      this.bootstrapSocialChat(scene)
      console.log(
        '[comms] REUSE landing LiveKit (no reconnect) ·',
        this.comms.describeLiveKitRooms()
      )
      clientDebugLog.log('network', 'Early scene comms — reusing live landing session (no reconnect)', {
        level: 'success',
        alsoConsole: true
      })
      onProgress?.('Receiving peer updates…')
      await this.vrmPeerSync.onSceneConnected()
      return
    }

    console.warn(
      '[comms] NO live session to reuse — full connectSceneRoom (new LiveKit participant)'
    )
    onProgress?.(
      scene.source.kind === 'world' ? 'Joining world comms…' : 'Joining scene comms room…'
    )
    const connectResult = await this.comms.connectSceneRoom(this.buildCommsTarget(scene))
    if (connectResult.ok) {
      this.sceneCommsConnected = true
      // Genesis island routing needs world meters ASAP (not after first render frame).
      this.comms.seedArchipelagoSceneLocal(scene.spawn.x, scene.spawn.y, scene.spawn.z)
      this.syncVoiceRoom()
      clientDebugLog.log('network', 'Early scene comms connected during hydration', {
        level: 'success',
        alsoConsole: true
      })
      onProgress?.('Receiving peer updates…')
      await this.vrmPeerSync.onSceneConnected()
      return
    }
    if (connectResult.reason === 'comms_disabled') {
      // Content-only or broken LiveKit — play solo without chat/peers.
      onProgress?.('Multiplayer unavailable — continuing solo')
      return
    }
    if (connectResult.reason === 'duplicate_wallet') {
      onProgress?.('This wallet is already connected in another session — close the other client first')
      return
    }
    if (connectResult.reason === 'scene_ban') {
      onProgress?.('Access denied — you cannot join comms in this place')
      return
    }
    if (connectResult.reason === 'livekit') {
      onProgress?.('Multiplayer unavailable — continuing solo')
      return
    }
    onProgress?.('Comms connection failed — continuing without multiplayer')
  }

  /**
   * Spawn local player after scene script + assets are ready — PhysX ground plane must exist first.
   * Authoritative GLTF cook + pose seal run here; capsule is placed at scene.json spawn only after
   * all colliders are registered. Call after `waitForSceneAssets` and `prewarmPhysicsColliders`, before `start()`.
   */
  async spawnLocalPlayer(scene: ResolvedScene, onProgress?: (msg: string) => void): Promise<void> {
    if (!this.playerMode || !this.player) return
    await this.bootCookPhysicsColliders(scene, onProgress, {
      assetsTimedOut: this.bootAssetsTimedOut
    })
    await this.sealBootCollidersBeforeSpawn(onProgress)

    const walkBounds =
      this.playerWalkBounds ?? { mode: 'rect', bounds: sceneWorldBounds(scene.parcels, scene.baseParcel) }

    onProgress?.('Spawning player…')
    if (scene.spawn.fromSpawnPoints) {
      const label = scene.spawn.spawnPointName ? ` "${scene.spawn.spawnPointName}"` : ''
      console.info(
        `[World] spawn — scene.json${label} · dcl=(${scene.spawn.x.toFixed(1)}, ${scene.spawn.y.toFixed(1)}, ${scene.spawn.z.toFixed(1)}) · parcel=${scene.commsPointer}`
      )
    } else if (scene.spawn.y <= 0.01) {
      console.info(
        `[World] spawn — no spawnPoints; feet y=1 fallback · parcel=${scene.commsPointer}`
      )
    }
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
        } else if (
          connectResult.reason === 'comms_disabled' ||
          connectResult.reason === 'livekit'
        ) {
          onProgress?.('Multiplayer unavailable — continuing solo')
        } else if (connectResult.reason === 'duplicate_wallet') {
          onProgress?.('This wallet is already connected in another session — close the other client first')
        } else if (connectResult.reason === 'scene_ban') {
          onProgress?.('Access denied — you cannot join comms in this place')
        } else {
          onProgress?.('Comms connection failed — continuing without multiplayer')
        }
      }

      onProgress?.('Loading social services…')
      const profile = this.session.getProfile()
      // No LiveKit on this world → disable scene chat tab even if scene.json allows browserChat.
      const chatOk = scene.browserChatEnabled && scene.realm.commsEnabled !== false
      await this.social.init({
        address,
        identity,
        isGuest: this.loginIsGuest,
        sceneTab: {
          key: scene.commsPointer,
          label: scene.title || scene.commsPointer,
          pointer: scene.commsPointer,
          browserChatEnabled: chatOk
        },
        comms: this.comms,
        contentUrl: scene.realm.contentUrl
      })
      if (profile) {
        void fetchProfileFaceUrl(address, scene.realm.lambdasUrl).then((faceUrl) => {
          this.social.setLocalProfile(
            address,
            profile.displayName ?? (this.loginIsGuest ? 'Guest' : 'You'),
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

    // Hold avatar + CCT out of the scene until authored colliders solidly under spawn.
    const provenFeet = await this.waitForSpawnFloorReady(scene.spawn, onProgress)

    onProgress?.('Loading avatar…')
    this.player.setAssetCache(this.assets, scene.realm.contentUrl)
    await this.player.loadAvatar(onProgress)
    this.bindAvatarAttachTargets()
    // PhysX simulate(0) before CCT — pose slides that cannot move an actor trigger recook above.
    await this.sceneScript.yieldForWorkerMessages()
    await this.sceneScript.syncRendererFull()
    this.sceneScript.flushSceneGraphMatrices()
    this.sceneScript.syncCollisionForce()
    this.pushAllColliderPosesToPhysX()
    this.reconcileColliderCookQueue()
    await this.drainPendingColliderCooksInitialOnly()
    this.pushAllColliderPosesToPhysX()
    this.physics.warmStaticScene()
    await this.player.initCapsule(
      scene.spawn,
      walkBounds,
      this.sceneScript.readComponents,
      onProgress,
      provenFeet
    )
    // Genesis Plaza bounce parasols write PhysicsCombinedImpulse with eventId:0 — need LWW Lamport.
    this.player.setImpulseLamportProvider(() => this.sceneScript.getPhysicsImpulseLamport())
    this.sceneScript.setVirtualCameraPoseProviders(
      () => this.player!.getEntityPose(),
      () => this.player!.getCameraEntityPose()
    )
    this.player.setVirtualCameraBridge(this.sceneScript.getVirtualCameraBridge())
    this.sceneScript.setSpatialAudioPlayerRoot(() => this.player!.getPlayerRoot())
    const spawnStatic = this.physics.staticColliderCount
    const spawnGltf = this.physics.gltfStaticActorCount
    const gltfStats = this.sceneScript.gltfColliders?.getPhysicsExtractionStats()
    const pos = this.player.getPosition()
    const worldFeet = this.player.getWorldPosition()
    console.info(
      `[World] player spawn — static=${spawnStatic} gltfRegistered=${spawnGltf} gltfExtracted=${this.lastGltfColliderCount}` +
        (gltfStats
          ? ` shapes(inv=${gltfStats.invisibleShapes} vis=${gltfStats.visibleShapes})`
          : '') +
        (pos ? ` feet=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})` : '')
    )
    if (worldFeet) {
      this.physics.logStaticCollidersNear(worldFeet.x, worldFeet.y, worldFeet.z, 16)
    }
    this.logBootColliderDiag()
    this.sceneScript.syncClientEntities(this.player.getEntityPose(), this.player.getCameraEntityPose())
    this.physics.invalidateControllerCache()
    this.sceneScript.flushSceneGraphMatrices()
    // One more instance rewrite at spawn — catch late parent transforms after seal.
    this.sceneScript.refreshAllInstancedTransforms()
    this.sceneScript.preparePointerRaycast()
    this.sceneScript.refreshPointerTargets()
    this.startInputHub()
    this.sceneScript.setInputHub(this.inputHub, 'primary')
    this.sceneScript.bindPointerEvents(
      () => this.player?.getWorldPosition() ?? null,
      () => this.player?.isPointerBlocked() ?? true,
      () => this.physics,
      {
        isRelayBlocked: () => this.player?.isSceneRelayBlocked() ?? true,
        isLocomotionBlocked: () => this.player?.isLocomotionBlocked() ?? true,
        clearPlayerMoveKeys: () => this.player?.clearMoveKeys()
      },
      // Optional: dispose tears down scene after/with player — CameraModeArea clear must not throw.
      (mode) => this.player?.setForcedCameraMode(mode)
    )
    this.sceneScript.setAvatarModifierProviders({
      getSamples: () => {
        const samples: { id: string; position: { x: number; y: number; z: number } }[] = []
        const localPos = this.player?.getPosition()
        if (localPos) {
          const localId = this.session.getAddress()?.toLowerCase() ?? ''
          samples.push({
            id: localId,
            position: { x: localPos.x, y: localPos.y, z: localPos.z }
          })
        }
        this.remoteAvatars?.collectModifierSamples(samples)
        return samples
      },
      apply: (id, effects) => {
        const localId = this.session.getAddress()?.toLowerCase() ?? ''
        if (!id || id === localId) {
          this.player?.setModifierHidden(effects.hide)
          return
        }
        this.remoteAvatars?.setModifierHidden(id, effects.hide)
      }
    })
    // Voice stays muted here — AppController unlocks after load UI / chrome is ready.
    // Plaza-scale from entity count when GLTF collider extract is sparse (Genesis ~18 colliders).
    const hydration = this.sceneScript.getHydrationStats()
    const plazaScale =
      this.lastGltfColliderCount >= 200 || (hydration?.gltfEntities ?? 0) >= 400
    this.sceneScript.notifyPlayReady({
      plazaScale,
      engineTickIntervalMs: resolveEngineTickIntervalMs(this.sceneScript.getPerformanceTier())
    })
    if (!skipRemoteAvatars()) {
      this.remoteAvatars?.setPlayReady(plazaScale)
    }
    this.player.setOnUserGestureUnlock(() => {
      this.sceneScript.setVideoUserGestureUnlocked(true)
    })
  }

  private seedPosesFromSpawn(spawn: {
    x: number
    y: number
    z: number
    fromSpawnPoints?: boolean
  }) {
    // Match initCapsule / waitForSpawnFloorReady feet Y (no-spawn-points floor fallback).
    const feetY =
      spawn.fromSpawnPoints === true ? spawn.y : spawn.y <= 0.01 ? 1 : spawn.y
    const feetDcl = new THREE.Vector3(spawn.x, feetY, spawn.z)
    const playerEntityDcl = feetDclToPlayerEntityPosition(feetDcl)
    const rotation = ReservedEntitiesSync.playerRotationFromYaw(0)
    const feetThree = dclToThreeVec(feetDcl.clone())
    return {
      player: {
        position: playerEntityDcl,
        rotation
      },
      camera: {
        position: feetDcl.clone(),
        rotation
      },
      feetThree
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
    // Cull ECS lights by avatar (not camera) so freecam/orbit doesn't re-pick distant lights.
    this.lightManager.update(this.player?.getWorldPosition() ?? this.host.camera.position)
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
          // Character select / menus / PE drone bind VirtualCamera — skip FFT ocean GPGPU while VC is live
          // so main-thread budget goes to UI + late GLB attach (Explorer is not paying this tax).
          if (!this.isAnyVirtualCameraActive()) {
            this.ocean?.update(delta, this.host.camera)
          }
          if (this.ezTreeGrass) {
            this.ezTreeGrassElapsed += delta
            this.ezTreeGrass.update(this.ezTreeGrassElapsed, this.host.camera.position)
          }
          this.desertAtmosphere?.update(delta)
          this.foliageWindElapsed += delta
          updateFoliageWind(this.foliageWindElapsed)
        }
        this.lightManager.update(this.player?.getWorldPosition() ?? this.host.camera.position)
        if (!skipRemoteAvatars()) {
          this.remoteAvatars?.setCameraPosition(this.host.camera.position)
        }
        if (!this.editorPreviewMode) {
          this.environment.update(delta, this.sceneScript.view, this.sceneScript.readComponents)
          this.syncOutdoorLighting()
        }

        if (this.playerMode && this.player) {
          // Motion first — PE pose + TriggerArea enter must beat worker onUpdate.
          const platformT0 = performance.now()
          this.syncPlayerMotionFrame(delta, startFrame)
          // Claims from previous frame (poseDrive / freeze) until post-tick re-merge.
          // PE owns VirtualCamera / MainCamera (drone, vehicle) — claim merger selects lens.
          this.selectActiveVirtualCameraBridge()
          const platformMs = performance.now() - platformT0
          const playerT0 = performance.now()
          this.player.update(delta)
          if (this.photoCamera?.isActive()) {
            this.photoCamera.update(delta)
          }
          const playerMs = performance.now() - playerT0
          recordMainThreadPerf({ platformMotionMs: platformMs, playerUpdateMs: playerMs, colliderApplyMs: 0 })
          const emoteAllowed = this.player.canPlayVoluntaryEmote()
          if (emoteAllowed !== this.lastVoluntaryEmoteAllowed) {
            this.lastVoluntaryEmoteAllowed = emoteAllowed
            this.onVoluntaryEmoteAllowedChange?.(emoteAllowed)
          }
          const playerPose = this.player.getEntityPose()
          const cameraPose = this.player.getCameraEntityPose()
          // Keyboard bus first — PE/primary onUpdate this frame sees isPressed for drone WASD.
          this.inputHub.sync(startFrame)
          this.sceneScript.syncClientEntities(playerPose, cameraPose)
          // Detect enter/exit with post-move CCT feet, then flush PE+TriggerAreaResult to worker.
          this.sceneScript.updateTriggerAreas()
          // Worker onUpdate with current PE (bounce parasols read Transform.get(PlayerEntity)).
          this.sceneScript.tickPlayFrame()
          // Portable experiences + live secondaries (primary already ticked — primary wins intents).
          this.multiScene?.tickSync(playerPose, cameraPose, startFrame)
          // PE tween/billboard/attach motion + reserved-parent meshes (same as primary pump).
          this.pumpPeMotionBridges(delta, startFrame)
          // Phase B — merge layer claims (locomotion / camera / poseDrive / force) + discrete intents.
          this.applyLayerPlayerClaims()
          // PE free-flight: pull winning poseDrive layer PlayerEntity onto the capsule.
          this.syncPlayerFromPoseDriveClaim()
          // After claims / player-frame may have bound VC — re-select lens.
          this.selectActiveVirtualCameraBridge()

          const pos = this.player.getPosition()
          // AOI tertiary visuals — scene-local DCL feet (throttled inside layer).
          this.aoiVisual.update(pos.x, pos.z)
          // Multi-scene: dwell on foreign parcel → promote that scene to primary.
          this.scenePromote.tick(pos.x, pos.z)
          const yaw = this.player.getNetworkYaw()
          const isEmoting = this.player.isProfileEmoteActive()
          const locomotion = this.player.getLocomotionWireState()
          this.comms.broadcastTransform(pos.x, pos.y, pos.z, yaw, isEmoting, locomotion)

          if (startFrame === 60) {
            const worldX = pos.x + (this.comms.getSceneOrigin()?.x ?? 0)
            const worldZ = pos.z + (this.comms.getSceneOrigin()?.z ?? 0)
            const localAvatar = this.player.getLocalAvatar()
            const livePeers = this.comms.getLivePeerCounts()
            console.info(
              '[World] frame 60 — playerSceneLocal:',
              `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
              'playerWorld:',
              `(${worldX.toFixed(1)}, ${pos.y.toFixed(1)}, ${worldZ.toFixed(1)})`,
              'sceneOrigin:',
              this.comms.getSceneOrigin(),
              'cam:',
              this.host.camera.position.toArray().map((n) => n.toFixed(1)),
              'remotePeers:',
              this.remoteAvatars?.visiblePeerCount ?? 0,
              'remoteLoaded:',
              this.remoteAvatars?.loadedPeerCount ?? 0,
              'liveKit:',
              `scene=${livePeers.scene} island=${livePeers.island} world=${livePeers.world} islandOn=${livePeers.islandConnected}`,
              'localAvatar:',
              localAvatar?.getModel() ? 'yes' : 'no',
              'gltfCached:',
              this.assets.getLoadStats().gltfCached
            )
          }
        }

        if (!skipRemoteAvatars()) {
          this.vrmPeerSync.gcStaleFetches()
          this.remoteAvatars?.update(delta)
          this.reportRemoteAvatarProgress()
        }
        // Spatial voice reparents as peer poses land (cheap map walk).
        this.voice.tickSpatial()
        this.comms.flushBroadcast()

        // Tweens / billboards / GLTF animators — player path runs in syncPlayerMotionFrame first.
        if (!this.editorPreviewMode && (!this.playerMode || !this.player)) {
          this.sceneScript.pumpMotionBridges(delta, startFrame)
        }
        if (this.playerMode && this.player) {
          this.sceneScript.preparePointerRaycast()
          this.sceneScript.updateRaycasts()
          this.sceneScript.updatePointerEvents(startFrame)
          // Hub already synced before scene/PE ticks; late edges still publish on keydown.
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

        const t0 = performance.now()
        await this.sceneScript.syncRenderer()
        const rendererMs = performance.now() - t0

        if (this.playerMode && this.player) {
          this.sceneScript.preparePointerRaycast()
        }

        // Sync frame already runs syncCollision after motion bridges — async only when
        // projection diff or entity-store changes mark new collider work this frame.
        const t1 = performance.now()
        if (this.sceneScript.hasColliderWorkPending()) {
          this.sceneScript.syncCollision()
        }

        let colliderMs = 0
        if (this.playerMode && this.player) {
          const colliderT0 = performance.now()
          this.applyPhysicsColliders()
          colliderMs = performance.now() - colliderT0
          recordMainThreadPerf({
            platformMotionMs: 0,
            playerUpdateMs: 0,
            colliderApplyMs: colliderMs
          })
          this.logCollidersPhysDebug()
        }
        const collisionMs = performance.now() - t1

        const t2 = performance.now()
        await this.sceneScript.syncAsyncBridges()
        // PE + secondary async projection + multi-scene colliders into PhysX.
        if (this.multiScene) {
          const { colliders, invalidatePhysIds } = await this.multiScene.tickAsync()
          for (const id of invalidatePhysIds) {
            this.physics.invalidateStaticCollider(id)
          }
          if (colliders.length && this.collidersLoadingComplete && !this.deferPhysxCooks) {
            try {
              const result = this.physics.syncStaticColliders(colliders, {
                cookBudget: Math.min(16, colliders.length),
                freezeRemoval: true,
                forceRecookOnPoseChange: false,
                geometryCache: true
              })
              if (result.geometryChanged) this.scheduleStaticGeometryWarm()
            } catch (err) {
              console.warn('[multi-scene] PE/secondary collider sync failed', err)
            }
          }
        }
        const bridgesMs = performance.now() - t2
        const totalMs = performance.now() - t0
        // Diagnose multi-second async frames (was ~3300ms = cold GLB parse await / 3k pending walk).
        if (totalMs > 100) {
          // Lite counters only — full getHydrationStats walks every GltfContainer (was 3k+).
          const lite = this.sceneScript.getAttachProgressLite()
          console.warn(
            `[fps] async breakdown ${totalMs.toFixed(0)}ms — renderer=${rendererMs.toFixed(0)} ` +
              `collision=${collisionMs.toFixed(0)} bridges=${bridgesMs.toFixed(0)} ` +
              `gltfCached=${this.assets.getLoadStats().gltfCached} inflight=${this.assets.getLoadStats().gltfInflight}` +
              (lite
                ? ` attached=${lite.attached} pendingMesh=${lite.pendingMesh} sceneTris=${(lite.sceneTris / 1e6).toFixed(2)}M`
                : '')
          )
        }
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
    const motionSnapshotCandidates = this.sceneScript.collectMotionSnapshotCandidates(groundEcsEarly)
    const needsPlatformPipeline =
      motionSnapshotCandidates.size > 0 || !onSceneGround || groundPhysEntity === -1

    if (needsPlatformPipeline && feet) {
      this.sceneScript.snapshotMotionBaselines(motionSnapshotCandidates, feet, groundEcsEarly)
      const meshEntities = [...motionSnapshotCandidates].filter((entity) =>
        this.sceneScript.readComponents.MeshCollider.has(entity)
      )
      if (meshEntities.length) {
        const meshDescs = this.sceneScript.getPhysicsColliderDescsForEntities(meshEntities)
        this.physics.snapshotColliderPositions(meshDescs)
      }
      if (feet) {
        this.physics.snapshotGroundContactBaseline(feet)
      }
    }

    this.sceneScript.pumpMotionBridges(delta, startFrame)
    if (this.sceneScript.hasColliderWorkPending()) {
      this.sceneScript.syncCollision()
    }

    let meshMotion: Entity[] = []
    if (this.collidersLoadingComplete && !this.deferPhysxCooks && needsPlatformPipeline && feet) {
      const groundEcs = groundEcsEarly
      const shapeMotion = this.sceneScript.getFrameShapeMotionEntities(groundEcs)
      const frameMotion = this.sceneScript.consumeFrameMotionEntities()
      meshMotion = this.sceneScript.recordWalkSurfaceDeltasForEntities(
        frameMotion,
        shapeMotion,
        feet,
        standPhysEntity
      )
      if (this.sceneScript.hasColliderWorkPending()) {
        this.sceneScript.syncCollision()
      }
      const poseSync = this.sceneScript.collectPhysXPoseSyncEntities(meshMotion, shapeMotion)
      const platformEntities = new Set<Entity>(poseSync)
      if (groundEcs !== null) platformEntities.add(groundEcs)

      let platformDescs: ReturnType<SceneScriptSystem['getPhysicsColliderDescsForEntities']> | null =
        null
      const ensurePlatformDescs = (): NonNullable<typeof platformDescs> => {
        if (!platformDescs) {
          platformDescs = this.sceneScript.getPhysicsColliderDescsForEntities([...platformEntities])
        }
        return platformDescs
      }

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

      if (groundIsMoving || shapeMotion.size > 0) {
        const descs = ensurePlatformDescs()
        if (!onSceneGround || shapeMotion.size > 0) {
          this.physics.snapshotActorRootPoses(descs)
        }
        if (shapeMotion.size > 0 && standScoped) {
          this.physics.snapshotGltfColliderWalkSurfaces(descs, feet, standPhysEntity)
        }
      }

      if (feet && standScoped && groundIsMoving) {
        this.physics.snapshotPhysXActorWalkSurfaces(standPhysEntity, feet, ensurePlatformDescs())
      }

      if (groundIsMoving || poseSync.length > 0) {
        this.physics.applyGltfColliderPoseDeltas(ensurePlatformDescs(), feet)
      }
      if (groundIsMoving) {
        this.physics.applyActorRootPoseDeltas(ensurePlatformDescs(), standPhysEntity)
      }
      if (feet && groundEcs !== null && (groundIsMoving || shapeMotion.has(groundEcs))) {
        this.sceneScript.computeAnimatorOriginDeltas(feet, groundEcs)
      }
      this.physics.mergeAnimatorOriginPlatformMotion(
        this.sceneScript.consumeAnimatorOriginDeltasPhys(),
        this.sceneScript.consumeAnimatorOriginPositionsPhys()
      )
      if (poseSync.length > 0 || groundIsMoving) {
        const meshPoseEntities = poseSync.filter((entity) =>
          this.sceneScript.readComponents.MeshCollider.has(entity)
        )
        if (meshPoseEntities.length) {
          this.physics.applyMeshColliderPoseDeltas(
            this.sceneScript.getPhysicsColliderDescsForEntities(meshPoseEntities)
          )
        }
      }
      if (feet && standScoped && groundIsMoving) {
        this.physics.applyPhysXActorWalkSurfaceDeltas(standPhysEntity, feet, ensurePlatformDescs())
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
      'Runtime collider recook disabled — entity-local cooks + per-entity dirty pose slides + initial registration only; ?colliderrecook for play-time drift recook'
    )
  }

  private applyPhysicsColliders(): void {
    if (!this.playerMode || !this.collidersLoadingComplete || this.deferPhysxCooks) return
    this.logRuntimeRecookDisabledOnce()
    const colliderWork = this.sceneScript.hasColliderWorkPending()

    if (colliderWork) {
      this.sceneScript.syncCollision()
      const poseChanged = this.sceneScript.getLastPoseChangedEntities()
      if (poseChanged.length) {
        this.applyColliderPoseSlides([...poseChanged])
      }
    }

    if (colliderWork || this.colliderCookQueue.size > 0) {
      this.reconcileColliderCookQueue()
    }
    if (this.colliderCookQueue.size > 0) {
      void this.scheduleColliderCookDrain()
    }
  }

  /** Single in-flight cook drain — never stack async drains from attach callbacks. */
  private async scheduleColliderCookDrain(): Promise<void> {
    if (this.colliderCookDrainInFlight) return
    this.colliderCookDrainInFlight = true
    try {
      if (this.allowsRuntimeColliderRecook()) {
        await this.drainRuntimeColliderCookQueue()
      } else {
        await this.drainPendingColliderCooksInitialOnly()
      }
    } finally {
      this.colliderCookDrainInFlight = false
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
      nearPlayerPending >= 8 ||
      (catchUpActive && nearPlayerPending >= 1)
    ) {
      let passes = 0
      const maxPasses = burstActive
        ? 2
        : catchUpActive && nearPlayerPending >= 1
          ? 3
          : nearPlayerPending >= 8
            ? 2
            : 1
      while (this.colliderCookQueue.size > 0 && passes < maxPasses) {
        await this.drainColliderCookQueue({ initialOnly: true })
        passes++
      }
    } else {
      await this.drainColliderCookQueue({ initialOnly: true })
    }
    this.scheduleStaticGeometryWarm()
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
    this.spawnColliderSealComplete = false
    this.colliderCookQueue.clear()
    this.pendingColliderCooks = 0
    this.lastPhysicsBatchFp = ''

  }

  /**
   * World-baked pose drift recook — boot only unless `?colliderrecook`.
   * After boot: pose slides + initial registration for never-cooked actors; no play recook.
   */
  /** Runtime tween / transform pose slide — only entities marked pose-dirty (down-tree from mover). */
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

  /** Incremental pose push — entity-local actors; legacy world-baked upgrades on actual dirty entities. */
  private applyColliderPoseSlidesForPhysIds(physIds: number[]): void {
    if (!this.playerMode || !physIds.length) return
    for (const physId of physIds) {
      this.sceneScript.refreshColliderPose(physId)
    }
    const descs = this.collectColliderDescs(physIds)
    const slideDescs: PhysicsColliderDesc[] = []
    for (const desc of descs) {
      if (
        this.physics.isWorldBakedStatic(desc.entity) ||
        this.physics.needsWorldBakedPoseRecook(desc)
      ) {
        // Do not force-recook here — syncStaticColliders remove→add leaves a hole mid-walk.
        // Queue for budgeted drain; world-baked pose drift keeps the live actor until boot force.
        this.colliderCookQueue.add(desc.entity)
        continue
      }
      if (!this.physics.hasStaticActor(desc.entity)) {
        this.colliderCookQueue.add(desc.entity)
        continue
      }
      slideDescs.push(desc)
    }
    const updated = this.physics.applyStaticColliderPoseUpdates(slideDescs)
    if (updated > 0) this.physics.refreshStaticColliderQueries()
    // Unsafe slides invalidate actors — requeue so initialOnly / burst drain can recook.
    for (const desc of slideDescs) {
      if (!this.physics.hasStaticActor(desc.entity) || !this.physics.isColliderSynced(desc)) {
        this.colliderCookQueue.add(desc.entity)
      }
    }
    this.pendingColliderCooks = this.colliderCookQueue.size
  }

  /** Coalesce zero-dt PhysX sim warms to once per frame — geometry registration only. */
  private scheduleStaticGeometryWarm(): void {
    if (this.warmStaticScenePending) return
    this.warmStaticScenePending = true
    requestAnimationFrame(() => {
      this.warmStaticScenePending = false
      this.physics.warmStaticScene()
    })
  }

  /** Boot / seal — slide every entity-local actor to live descriptor poses (composite may shift after cook). */
  private pushAllColliderPosesToPhysX(): void {
    if (!this.playerMode) return
    this.sceneScript.flushSceneGraphMatrices()
    this.sceneScript.syncCollisionForce()
    this.sceneScript.syncCollisionPoses()
    const descs = this.sceneScript.getAllPhysicsColliderDescs()
    if (!descs.length) return
    const updated = this.physics.applyStaticColliderPoseUpdates(descs, { force: true })
    this.enqueueUnsyncedColliderCooks()
    if (updated > 0) this.physics.warmStaticScene()
    this.lastPhysicsBatchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()
    if (this.collidersLoadingComplete && !this.spawnColliderSealComplete) {
      const unsynced = this.colliderCookQueue.size
      console.info(
        `[World] pushAllColliderPoses — updated=${updated}/${descs.length}` +
          (unsynced > 0 ? ` unsyncedQueued=${unsynced}` : '')
      )
    }
  }

  /** Pose-slide invalidation drops actors — ensure they re-enter the cook queue before spawn. */
  private enqueueUnsyncedColliderCooks(): void {
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (!this.physics.isColliderSynced(desc)) {
        this.colliderCookQueue.add(desc.entity)
      }
    }
    this.pendingColliderCooks = this.colliderCookQueue.size
  }

  /**
   * Gate play until a temporary CCT can stand on authored geometry at scene.json spawn.
   * No synthetic pad — keeps pose-sliding / cooking until settle succeeds or timeout.
   * @returns grounded feet (Three space) for final capsule spawn, or null on timeout.
   */
  private async waitForSpawnFloorReady(
    spawn: ResolvedScene['spawn'],
    onProgress?: (msg: string) => void
  ): Promise<THREE.Vector3 | null> {
    const feetY = spawn.fromSpawnPoints ? spawn.y : spawn.y <= 0.01 ? 1 : spawn.y
    const spawnThree = dclToThreeVec(new THREE.Vector3(spawn.x, feetY, spawn.z))
    const elevated = spawnThree.y > 8
    const maxWaitMs = elevated ? 30_000 : 10_000
    const started = performance.now()
    let attempt = 0
    let lastProgressLog = 0
    let lastProbeFeet: THREE.Vector3 | null = null

    onProgress?.('Waiting for floor colliders…')
    console.info(
      `[World] spawn floor wait — authored feet three=(${spawnThree.x.toFixed(1)}, ${spawnThree.y.toFixed(2)}, ${spawnThree.z.toFixed(1)}) maxWait=${(maxWaitMs / 1000).toFixed(0)}s`
    )

    while (performance.now() - started < maxWaitMs) {
      attempt++
      await this.sceneScript.yieldForWorkerMessages()
      this.sceneScript.flushSceneGraphMatrices()
      this.sceneScript.syncCollisionForce()
      this.pushAllColliderPosesToPhysX()
      this.reconcileColliderCookQueue()
      await this.drainPendingColliderCooksInitialOnly()
      this.pushAllColliderPosesToPhysX()
      this.physics.warmStaticScene()

      // Prefer deck near authored Y — never the highest roof/arch hit.
      const probed = this.physics.probeWalkSurfaceFeetY(
        spawnThree.x,
        spawnThree.z,
        spawnThree.y + 1.2,
        8,
        spawnThree.y
      )
      const probeOk = probed != null && isPlausibleSpawnSurfaceY(probed, spawnThree.y)
      if (probeOk && probed != null) {
        lastProbeFeet = new THREE.Vector3(spawnThree.x, probed, spawnThree.z)
      }

      // CCT is the real gate — sweep alone can hit thin/wrong shapes.
      const settledFeet = this.physics.trySettleAtPosition(spawnThree, spawnThree.y)
      if (
        settledFeet &&
        isPlausibleSpawnSurfaceY(settledFeet.y, spawnThree.y)
      ) {
        const elapsed = ((performance.now() - started) / 1000).toFixed(1)
        console.info(
          `[World] spawn floor ready — CCT grounded after ${elapsed}s (attempts=${attempt}` +
            `, feetY=${settledFeet.y.toFixed(2)}` +
            (probed != null ? `, probeY=${probed.toFixed(2)}` : '') +
            ')'
        )
        onProgress?.('Floor ready')
        return settledFeet
      }

      const now = performance.now()
      if (now - lastProgressLog > 2000) {
        lastProgressLog = now
        const sec = ((now - started) / 1000).toFixed(0)
        onProgress?.(
          probeOk
            ? `Waiting for floor… ${sec}s (probe hit, CCT settling)`
            : `Waiting for floor… ${sec}s`
        )
        this.physics.logStaticCollidersNear(spawnThree.x, spawnThree.y, spawnThree.z, 16)
        clientDebugLog.log(
          'player',
          `spawn floor wait — t=${sec}s attempt=${attempt} probe=${probed?.toFixed(2) ?? 'none'} cct=miss`,
          { alsoConsole: true, level: 'info' }
        )
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 120))
    }

    const elapsed = ((performance.now() - started) / 1000).toFixed(1)
    console.warn(
      `[World] spawn floor wait timed out after ${elapsed}s (attempts=${attempt}) — spawning anyway (may freefall)`
    )
    this.physics.logStaticCollidersNear(spawnThree.x, spawnThree.y, spawnThree.z, 16)
    onProgress?.('Floor wait timed out — spawning…')
    // Prefer last walk-surface probe over raw authored air spawn.
    return lastProbeFeet
  }

  /**
   * Final collider pass before the player capsule exists — cook queue drained, poses slid, PhysX warmed.
   */
  private async sealBootCollidersBeforeSpawn(onProgress?: (msg: string) => void): Promise<void> {
    if (!this.playerMode) return
    onProgress?.('Syncing collisions…')
    this.sceneScript.setSceneWorkerTicksPaused(true)
    try {
      await this.sceneScript.yieldForWorkerMessages()
      await this.sceneScript.syncRendererFull()
      this.sceneScript.flushSceneGraphMatrices()
      this.sceneScript.invalidateGltfColliderSyncCache()
      this.sceneScript.syncCollisionForce()
      this.reconcileColliderCookQueue()
      while (this.colliderCookQueue.size > 0) {
        await this.drainColliderCookQueue({ loading: true })
      }
      this.pushAllColliderPosesToPhysX()
      this.reconcileColliderCookQueue()
      while (this.colliderCookQueue.size > 0) {
        await this.drainColliderCookQueue({ loading: true })
      }
      this.pushAllColliderPosesToPhysX()
      this.spawnColliderSealComplete = true
      this.physics.warmStaticScene()
      const registered = this.physics.gltfStaticActorCount
      const extracted = this.lastGltfColliderCount
      console.info(
        `[World] colliders sealed — gltf=${registered}/${extracted} static=${this.physics.staticColliderCount}`
      )
    } finally {
      this.sceneScript.setSceneWorkerTicksPaused(false)
    }
  }

  /** Pose slide only — never recooks geometry (runtime + post-spawn CRDT drain). */
  private pushColliderPosesToPhysX(options?: { forceEntities?: ReadonlySet<number> }): void {
    if (!this.playerMode) return
    const dirty = this.sceneScript.getLastPoseChangedEntities()
    if (!options?.forceEntities?.size && !dirty.length) return

    if (dirty.length) {
      this.sceneScript.refreshColliderDescPoses(dirty)
    }

    let descs: ReturnType<SceneScriptSystem['getPhysicsColliderDescsForEntities']> = []
    if (dirty.length) {
      descs = this.sceneScript.getPhysicsColliderDescsForEntities(dirty)
    } else if (options?.forceEntities?.size) {
      for (const physId of options.forceEntities) {
        const desc = this.sceneScript.getPhysicsColliderDesc(physId)
        if (desc) descs.push(desc)
      }
    }
    if (!descs.length) return

    const updated = this.physics.applyStaticColliderPoseUpdates(descs, options)
    if (updated > 0) this.physics.refreshStaticColliderQueries()
    this.lastPhysicsBatchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()
  }

  /**
   * Animator GLTF colliders must be entity-local — world-baked boot cooks freeze animated treads.
   */
  private recookAnimatedGltfEntityLocal(): void {
    const stale: PhysicsColliderDesc[] = []
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (!desc.fingerprint.startsWith('gltf-entity:')) continue
      if (!this.physics.isWorldBakedStatic(desc.entity)) continue
      const ecsEntity = (desc.entity - GLTF_COLLIDER_ENTITY_BASE) as Entity
      if (!this.sceneScript.isAnimatedGltfColliderEntity(ecsEntity)) continue
      stale.push(desc)
    }
    if (!stale.length) return
    const result = this.physics.syncStaticColliders(stale, {
      cookBudget: stale.length,
      freezeRemoval: true,
      geometryCache: true
    })
    if (result.geometryChanged) this.physics.warmStaticScene()
  }

  /** After boot cook — actor registration sanity (once). */
  private logBootColliderDiag(): void {
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
    console.info(
      `[World] colliders booted — gltf=${this.physics.gltfStaticActorCount}` +
        (fpMismatch > 0 ? ` fpMismatch=${fpMismatch}` : '') +
        (missingActor > 0 ? ` missingActor=${missingActor}` : '')
    )
  }

  /** GLB attached or hydration tick — enqueue only; drain runs in applyPhysicsColliders. */
  private onColliderCookRequest(ecsEntity?: Entity): void {
    const queueBefore = this.colliderCookQueue.size
    if (ecsEntity !== undefined) {
      this.enqueueColliderCook(ecsEntity)
    } else {
      // Empty callback = discover every unsynced extract (mass spawn / post-structure).
      // Must not use validate-only reconcile — that never enqueues new post-boot actors.
      this.discoverUnsyncedColliderCooks()
    }
    this.maybeBeginRuntimeColliderBurst(queueBefore)
  }

  /**
   * Enqueue every extracted descriptor that is not live+synced in PhysX.
   * Used after structure extracts (map spawns) and when cook is requested without an entity.
   */
  private discoverUnsyncedColliderCooks(): void {
    if (this.deferPhysxCooks) {
      this.pendingColliderCooks = this.colliderCookQueue.size
      return
    }
    this.sceneScript.flushSceneGraphMatrices()
    let added = 0
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (this.physics.isColliderSynced(desc)) {
        this.colliderCookQueue.delete(desc.entity)
        continue
      }
      if (!this.colliderCookQueue.has(desc.entity)) added++
      this.colliderCookQueue.add(desc.entity)
    }
    // Drop queue entries whose extract is gone (entity destroy / orphan remove).
    for (const physId of [...this.colliderCookQueue]) {
      if (!this.sceneScript.getPhysicsColliderDesc(physId)) {
        this.colliderCookQueue.delete(physId)
      }
    }
    this.pendingColliderCooks = this.colliderCookQueue.size
    if (added > 0) {
      console.info(
        `[phys] cook discover — +${added} unsynced (queue=${this.colliderCookQueue.size} ` +
          `static=${this.physics.staticColliderCount} gltfActors=${this.physics.gltfStaticActorCount})`
      )
    }
  }

  /**
   * ECS extract maps dropped a collider entity — remove live PhysX statics.
   * All runtime cooks use freezeRemoval:true so orphans never leave the scene otherwise
   * (SpaceRunner lobby walls/dome stayed solid after HF entity deletes).
   */
  private onColliderEntityRemoved(ecsEntity: Entity): void {
    const meshId = ecsEntity as number
    const gltfId = GLTF_COLLIDER_ENTITY_BASE + ecsEntity
    const hadMesh = this.physics.hasStaticActor(meshId)
    const hadGltf = this.physics.hasStaticActor(gltfId)
    if (hadMesh) this.physics.invalidateStaticCollider(meshId)
    if (hadGltf) this.physics.invalidateStaticCollider(gltfId)
    this.colliderCookQueue.delete(meshId)
    this.colliderCookQueue.delete(gltfId)
    if (hadMesh || hadGltf) {
      this.physics.invalidateControllerCache()
      console.info(
        `[phys] removed orphan static ecs=e${ecsEntity}` +
          (hadMesh ? ` mesh=e${meshId}` : '') +
          (hadGltf ? ` gltf=${gltfId}` : '')
      )
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
    if (
      pending >= World.RUNTIME_COLLIDER_BURST_QUEUE ||
      delta >= World.RUNTIME_COLLIDER_BURST_QUEUE ||
      nearPlayer >= 8
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
    // Subtree roots + the entity itself (extract may land before colliderRootEntities rebuild).
    const entities = new Set(this.sceneScript.collectColliderEntitiesInSubtree(ecsEntity))
    entities.add(ecsEntity)
    for (const entity of entities) {
      for (const physId of this.sceneScript.collectPhysCookTargets(entity)) {
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
    }
    this.pendingColliderCooks = this.colliderCookQueue.size
    if (
      enqueuedPhysIds.length &&
      (this.colliderCookQueue.size >= World.RUNTIME_COLLIDER_BURST_QUEUE ||
        performance.now() < this.runtimeColliderBurstUntil)
    ) {
      this.kickRuntimePhysxCookPrefetch(enqueuedPhysIds)
    }
  }

  /**
   * Boot — discover uncooked descriptors. Runtime — validate explicit queue only
   * (scoped to dirty/attach subtrees; no global fingerprint or world-baked scan).
   */
  private reconcileColliderCookQueue(): void {
    if (this.deferPhysxCooks) {
      this.pendingColliderCooks = this.colliderCookQueue.size
      return
    }
    if (!this.collidersLoadingComplete) {
      this.sceneScript.flushSceneGraphMatrices()
      this.sceneScript.syncCollisionPoses()
      for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
        if (this.physics.isColliderSynced(desc)) {
          this.colliderCookQueue.delete(desc.entity)
        } else {
          this.colliderCookQueue.add(desc.entity)
        }
      }
    } else {
      for (const physId of [...this.colliderCookQueue]) {
        const desc = this.sceneScript.getPhysicsColliderDesc(physId)
        if (!desc || this.physics.isColliderSynced(desc)) {
          this.colliderCookQueue.delete(physId)
        }
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
    /** Post-load: register never-cooked / unsynced actors — pose slides handle pure entity-local drift. */
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
    const queueOrder = loadingPass
      ? this.sortedColliderCookQueue(this.colliderCookPriority)
      : this.sortedColliderCookQueue()
    for (const physId of queueOrder) {
      if (toCook.length >= budget) break
      const desc = this.sceneScript.getPhysicsColliderDesc(physId)
      if (!desc) {
        if (!loadingPass) this.colliderCookQueue.delete(physId)
        continue
      }
      if (!loadingPass && this.physics.isColliderSynced(desc)) {
        this.colliderCookQueue.delete(physId)
        continue
      }
      // initialOnly / runtime-recook-off used to skip ANY live actor — that dropped
      // partial cooks and unsafe-slide invalidations forever (plaza walk-through).
      // Only skip when the actor is truly synced; otherwise recook.
      const hasActor = this.physics.hasStaticActor(physId)
      const needsRecook = !this.physics.isColliderSynced(desc)
      if (
        !loadingPass &&
        hasActor &&
        !needsRecook &&
        (options?.initialOnly || !this.allowsRuntimeColliderRecook())
      ) {
        this.colliderCookQueue.delete(physId)
        continue
      }
      this.sceneScript.flushSceneGraphMatrices()
      this.sceneScript.refreshColliderBeforeCook(physId)
      // Do not pre-invalidate when an actor is live — replaceStaticWithCook keeps the
      // previous solid until the new cook succeeds (avoids mid-walk floor holes).
      if (loadingPass || !hasActor) {
        this.physics.invalidateStaticCollider(physId)
      }
      const fresh = this.sceneScript.getPhysicsColliderDesc(physId)
      if (!fresh) continue
      toCook.push(fresh)
    }

    if (!toCook.length) {
      this.pendingColliderCooks = this.colliderCookQueue.size
      this.refreshColliderCookStats()
      return
    }

    try {
      if (!loadingPass) {
        await prefetchPhysxCookStreams(buildPhysxCookPrefetchRequests(toCook, true), {
          quiet: true,
          maxWaitMs: 12
        })
      }

      const result = this.physics.syncStaticColliders(toCook, {
        cookBudget: toCook.length,
        freezeRemoval: true,
        // Recook when queued — including partial cooks / failed slides after boot.
        forceRecookOnPoseChange: loadingPass || options?.initialOnly === true,
        geometryCache: true
      })
      for (const desc of toCook) {
        if (this.physics.isColliderSynced(desc)) {
          this.colliderCookQueue.delete(desc.entity)
        }
      }
      if (result.geometryChanged) {
        if (loadingPass) this.physics.warmStaticScene()
        else this.scheduleStaticGeometryWarm()
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
   *
   * Must re-enqueue every extracted descriptor: post-boot `reconcileColliderCookQueue`
   * only validates the existing queue, so clear→reconcile left the queue empty and
   * the async drain was a no-op (manual recook appeared to do nothing).
   */
  recookPhysicsColliders(options?: { force?: boolean; quiet?: boolean }): Promise<void> {
    if (!this.playerMode || !this.player) {
      if (!options?.quiet) {
        clientDebugLog.log('collision', 'Recook skipped — not in play mode / no player', {
          level: 'warn',
          alsoConsole: true
        })
      }
      return Promise.resolve()
    }

    if (options?.force !== false) {
      this.lastPhysicsBatchFp = ''
      this.physics.clearFailedCookCaches()
      this.physics.clearAllSceneStaticActors()
      this.colliderCookQueue.clear()
      this.sceneScript.invalidateGltfColliderSyncCache()
    }

    this.sceneScript.flushSceneGraphMatrices()
    this.sceneScript.refreshAllInstancedTransforms()
    this.sceneScript.syncCollisionForce()

    // Full re-enqueue (do not rely on post-boot reconcile — it only prunes the live queue).
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      this.colliderCookQueue.add(desc.entity)
    }
    this.pendingColliderCooks = this.colliderCookQueue.size
    const queued = this.colliderCookQueue.size

    if (!options?.quiet) {
      clientDebugLog.log(
        'collision',
        `Manual recook — cooking ${queued} collider(s)…`,
        { level: 'info', alsoConsole: true }
      )
    }

    return (async () => {
      // Serialize with the normal drain so we don't race budgeted cooks.
      while (this.colliderCookDrainInFlight) {
        await new Promise<void>((r) => setTimeout(r, 16))
      }
      this.colliderCookDrainInFlight = true
      try {
        let passes = 0
        const maxPasses = Math.max(64, Math.ceil(queued / 8) + 8)
        while (this.colliderCookQueue.size > 0 && passes < maxPasses) {
          await this.drainColliderCookQueue({ loading: true })
          passes++
          // Yield so rAF / player input keep running during plaza-scale recooks.
          await new Promise<void>((r) => requestAnimationFrame(() => r()))
        }
        if (this.colliderCookQueue.size > 0) {
          console.warn(
            `[World] manual recook incomplete — ${this.colliderCookQueue.size} still pending after ${passes} passes`
          )
        }
        this.pushAllColliderPosesToPhysX()
        this.physics.warmStaticScene()
      } finally {
        this.colliderCookDrainInFlight = false
        this.pendingColliderCooks = this.colliderCookQueue.size
      }

      if (!options?.quiet) {
        const mesh = this.sceneScript.collision?.getPhysicsColliders().length ?? 0
        const gltf = this.sceneScript.gltfColliders?.getPhysicsColliders().length ?? 0
        clientDebugLog.log(
          'collision',
          `Colliders recooked — static=${this.physics.staticColliderCount} gltfActors=${this.physics.gltfStaticActorCount} ` +
            `extracted mesh=${mesh} gltf=${gltf} pending=${this.colliderCookQueue.size}`,
          {
            level: this.physics.staticColliderCount > 0 ? 'success' : 'warn',
            alsoConsole: true
          }
        )
      }
    })()
  }

  private logCollidersPhysDebug(): void {
    if (!physxColliderDebug.isCollidersPhysEnabled()) return
    const now = performance.now()
    if (now - this.collidersPhysLastLog < 1000) return
    this.collidersPhysLastLog = now
    const staticCount = this.physics.staticColliderCount
    const gltfCount = this.physics.gltfStaticActorCount
    const physFeet = this.player?.getWorldPosition()
    const feet =
      physFeet !== undefined
        ? `feet=(${physFeet.x.toFixed(1)}, ${physFeet.y.toFixed(1)}, ${physFeet.z.toFixed(1)})`
        : ''
    const pending = this.pendingColliderCooks
    const pendingStr = pending > 0 ? ` pendingCook=${pending}` : ''
    console.info(
      `[collidersphys] static=${staticCount} gltfRegistered=${gltfCount} extracted=${this.lastGltfColliderCount}${feet ? ` ${feet}` : ''}${pendingStr}`
    )
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
  private async waitForColliderExtractionSettle(
    maxMs: number,
    onProgress?: (msg: string) => void
  ): Promise<void> {
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
      onProgress?.(`Waiting for collider extraction… ${count} GLTF`)
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
        await this.waitForColliderExtractionSettle(
          Math.min(45_000, maxWallMs * 0.35),
          (msg) => onProgress?.(msg)
        )
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
      // Instanced props bake world matrices — parent reparent during hydration leaves them stale.
      this.sceneScript.refreshAllInstancedTransforms()
      this.sceneScript.invalidateGltfColliderSyncCache()
      this.sceneScript.syncCollisionForce()
      this.reconcileColliderCookQueue()
      while (this.colliderCookQueue.size > 0) {
        await this.drainColliderCookQueue({ loading: true })
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }

      this.recookAnimatedGltfEntityLocal()
      this.pushAllColliderPosesToPhysX()
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
      this.spawnColliderSealComplete = false
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
      console.info(
        `[World] colliders ready — static=${staticAfter} gltf=${finalRegistered}/${finalGltfCount} (${elapsedSec}s)` +
          ` cookHits=${cookStats.hits} idb=${cookStats.idbHits} worker=${cookStats.worker} main=${cookStats.mainThread} miss=${cookStats.misses}`
      )
      onProgress?.('Collisions ready', 0.96)
    } finally {
      this.sceneScript.setAssetHydrationMode(false)
    }
  }

  setSceneUiVisible(visible: boolean): void {
    this.sceneScript.setSceneUiVisible(visible)
  }

  /**
   * Explorer [N] — apply name-tag preference to local player, remotes, and AvatarShape NPCs.
   */
  applyNameTagsVisibility(): void {
    this.player?.applyNameTagsVisibility()
    this.remoteAvatars?.applyNameTagsVisibility()
    this.sceneScript.applyAvatarShapeNameTagsVisibility()
  }

  /** AppController — hide/show play chrome while photo mode is active. */
  setPhotoChromeHandler(handler: ((visible: boolean) => void) | null): void {
    this.photoChromeHandler = handler
  }

  isPhotoCameraActive(): boolean {
    return this.photoCamera?.isActive() === true
  }

  /** Toggle Explorer In-World Camera (C / sidebar). */
  togglePhotoCamera(): void {
    if (!this.playerMode || !this.player) return
    // Scene / PE VirtualCamera owns the lens — don't fight it.
    if (this.isAnyVirtualCameraActive()) {
      clientDebugLog.log('client', 'Photo camera blocked — scene VirtualCamera is active', {
        alsoConsole: true,
        throttleMs: 2000
      })
      return
    }
    this.ensurePhotoCamera()
    this.photoCamera?.toggle()
  }

  enterPhotoCamera(): void {
    if (!this.playerMode || !this.player) return
    if (this.isAnyVirtualCameraActive()) return
    this.ensurePhotoCamera()
    this.photoCamera?.enter()
  }

  exitPhotoCamera(): void {
    this.photoCamera?.exit()
  }

  private ensurePhotoCamera(): void {
    if (this.photoCamera || !this.player) return
    this.photoCamera = new PhotoCameraController({
      host: this.host,
      getPlayerFeet: () => this.player!.getWorldPosition(),
      getPeopleSamples: () => this.collectPhotoPeopleSamples(),
      getSelfIdentity: () => {
        const profile = this.session.getProfile()
        const address = (this.session.getAddress() ?? profile?.address ?? '').toLowerCase()
        return {
          name: profile?.displayName?.trim() || (address ? shortenAddress(address) : 'You'),
          address,
          isGuest: !profile?.fromWallet
        }
      },
      getSceneMeta: () => this.getPhotoSceneMeta(),
      getAuthIdentity: () => this.session.getAuthIdentity(),
      peerUrl: this.session.getContentUrl() || undefined,
      setWorldChromeVisible: (visible) => {
        this.player?.setPhotoModeActive(!visible)
        this.photoChromeHandler?.(visible)
      }
    })
  }

  private getPhotoSceneMeta(): {
    sceneName: string
    realm: string
    parcelX: number
    parcelY: number
  } {
    const pos = this.player?.getPosition()
    const origin = this.comms.getSceneOrigin()
    const worldX = (pos?.x ?? 0) + (origin?.x ?? 0)
    const worldZ = (pos?.z ?? 0) + (origin?.z ?? 0)
    const parcelX = Math.floor(worldX / 16)
    const parcelY = Math.floor(worldZ / 16)
    return {
      sceneName: this.photoSceneTitle || `Parcel ${parcelX},${parcelY}`,
      realm: typeof window !== 'undefined' ? window.location.hostname : 'local',
      parcelX,
      parcelY
    }
  }

  private collectPhotoPeopleSamples(): PhotoPersonSample[] {
    const samples: PhotoPersonSample[] = []
    if (this.player) {
      const feet = this.player.getWorldPosition()
      const profile = this.session.getProfile()
      const address = (this.session.getAddress() ?? profile?.address ?? 'local').toLowerCase()
      samples.push({
        address,
        displayName: profile?.displayName?.trim() || shortenAddress(address),
        isGuest: !profile?.fromWallet,
        isEmoting: this.player.isProfileEmoteActive(),
        hasClaimedName: !!profile?.hasClaimedName,
        nameColor: profile?.nameColor,
        faceUrl: null,
        wearables: profile?.wearables ? [...profile.wearables] : [],
        worldPosition: feet.clone(),
        radius: 1.0
      })
    }
    if (!skipRemoteAvatars() && this.remoteAvatars) {
      for (const p of this.remoteAvatars.collectPhotoPeopleSamples()) {
        samples.push(p)
      }
    }
    return samples
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

  /**
   * Multi-scene seamless promote — place feet at Genesis City meters after a
   * primary swap (new base parcel origin). Instant, no settle drop.
   */
  restoreGenesisFeet(genesis: { x: number; y: number; z: number }): boolean {
    if (!this.playerMode || !this.player) return false
    const origin = this.comms.getSceneOrigin()
    const localX = genesis.x - origin.x
    const localZ = genesis.z - origin.z
    return this.player.movePlayerTo({
      newRelativePosition: { x: localX, y: genesis.y, z: localZ }
    })
  }

  /**
   * Minimap triangle rotation (canvas radians, 0 = tip north / up).
   * Uses **visual body yaw** (same as the avatar mesh), including travel facing while moving —
   * not freecam orbit and not a separate wire-yaw path that can lag or disagree.
   */
  getPlayerMinimapAngle(): number | null {
    if (!this.playerMode || !this.player) return null
    return this.player.getMinimapFacingAngle()
  }

  /**
   * Remote peers with a known pose, in Genesis City meters (for minimap dots).
   * Positions are world/genesis space (scene origin applied).
   */
  listMinimapPeers(): Array<{ address: string; x: number; z: number }> {
    if (!this.remoteAvatars) return []
    const origin = this.comms.getSceneOrigin()
    const samples: Array<{ id: string; position: { x: number; y: number; z: number } }> = []
    this.remoteAvatars.collectModifierSamples(samples)
    const out: Array<{ address: string; x: number; z: number }> = []
    for (const s of samples) {
      out.push({
        address: s.id,
        x: s.position.x + origin.x,
        z: s.position.z + origin.z
      })
    }
    return out
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

  /** RestrictedActions teleportTo / changeRealm → AppController navigation. */
  setNavigateHandler(
    handler: ((target: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>) => void) | null
  ): void {
    this.navigateHandler = handler
  }

  /**
   * Multi-scene seamless promote (no full loading screen) + optional AOI prefetch.
   * Prefer over navigateHandler for stand-on-parcel primary swaps.
   */
  setPromoteHandlers(opts: {
    onPromote: ((target: Extract<RouteTarget, { kind: 'coords' }>, reason: string) => void) | null
    onSoftRoute?: ((x: number, y: number) => void) | null
    onPrefetch?: ((x: number, y: number) => void) | null
  }): void {
    this.promoteNavigate = opts.onPromote
    this.promoteSoftRoute = opts.onSoftRoute ?? null
    this.promotePrefetch = opts.onPrefetch ?? null
  }

  /**
   * Attach session multi-scene runtime (PE + live secondaries). Call after loadScene.
   * PE manager must outlive World so /goto can restore without re-prompt.
   */
  attachMultiScene(runtime: MultiSceneRuntime | null): void {
    if (this.multiScene && this.multiScene !== runtime) {
      this.multiScene.unregisterPrimary()
      this.multiScene.unbindWorld()
    }
    this.multiScene = runtime
    if (!runtime || !this.loadedPrimaryScene) return
    // Phase A — primary is a layer like PE/secondary (docs/SCENE_LAYERS_PLAN.md).
    runtime.registerPrimary(this.sceneScript)
    runtime.setOnLiveSecondaryIds((ids) => this.aoiVisual.setLiveSecondaryIds(ids))
    // PE: identity + getUserData BEFORE scene main(); play-ready/input AFTER start.
    runtime.pe.setOnPeBeforeSceneStart((system, physOffset) => {
      this.wirePeIdentityAndComms(system, physOffset)
    })
    runtime.pe.setOnPeWorkerReady((system, physOffset) => {
      this.wirePeWorkerToMainThread(system, physOffset)
    })
    // Impulse Lamport = max(primary, all PE) so PE bounce pads / thrusters fire once.
    this.player?.setImpulseLamportProvider(() => {
      if (!this.multiScene) return this.sceneScript.getPhysicsImpulseLamport()
      return this.peMirror.impulseLamportAcross(this.sceneScript, this.multiScene.pe)
    })
    const pePolicy: PortableExperiencesPolicy =
      this.loadedPrimaryScene.portableExperiencesPolicy ??
      resolvePortableExperiencesPolicy(this.loadedPrimaryScene.metadata)
    runtime.bindWorld({
      primaryScene: this.loadedPrimaryScene,
      cache: this.assets,
      host: this.host,
      tier: this.performanceTier,
      poseProvider: () => {
        if (this.player) {
          return {
            player: this.player.getEntityPose(),
            camera: this.player.getCameraEntityPose()
          }
        }
        return {
          player: {
            position: new THREE.Vector3(0, 0, 0),
            rotation: new THREE.Quaternion()
          },
          camera: {
            position: new THREE.Vector3(0, 1.6, 0),
            rotation: new THREE.Quaternion()
          }
        }
      },
      pePolicy
    })
  }

  getMultiScene(): MultiSceneRuntime | null {
    return this.multiScene
  }

  getPerformanceTier(): PerformanceTier {
    return this.performanceTier
  }

  /**
   * PE pre-main wire — identity + UserIdentity RPC + poses.
   * Must run before `system.start()` so `getUserData()` does not return {}.
   */
  private wirePeIdentityAndComms(
    system: import('./systems/SceneScriptSystem').SceneScriptSystem,
    _physOffset = 0
  ): void {
    system.setPlayerIdentity(
      buildPlayerMirrorIdentity({
        address: this.session.getAddress(),
        profile: this.session.getProfile()
      })
    )
    system.setRealmInfo(this.comms.getRealmInfo())
    system.setRealmInfoProvider(() => this.comms.getRealmInfo())
    system.setClientPoseProvider(() => ({
      player: this.player!.getEntityPose(),
      camera: this.player!.getCameraEntityPose()
    }))
    system.setVirtualCameraPoseProviders(
      () => this.player!.getEntityPose(),
      () => this.player!.getCameraEntityPose()
    )
    // Same UserIdentity surface as primary — PE scene main() often calls getUserData().
    system.setCommsHandler({
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
    // Signed fetch — same session identity as primary (PE wearables / permissions).
    system.setSignedFetchHandler(async (body) =>
      performSignedFetch(body, this.session.getAuthIdentity(), this.signedFetchSceneContext)
    )
    system.setSignedFetchGetHeadersHandler(async (body) =>
      performGetSignedHeaders(body, this.session.getAuthIdentity())
    )
    console.info('[pe] identity+comms wired before scene main (getUserData ready)')
  }

  /**
   * Wire a PE SceneScriptSystem to main-thread player/input/physics — same surface as primary
   * minus exclusive privileges (teleport still via arbiter).
   * Call after system.start(); identity/comms should already be on via wirePeIdentityAndComms.
   */
  private wirePeWorkerToMainThread(
    system: import('./systems/SceneScriptSystem').SceneScriptSystem,
    physOffset = 0
  ): void {
    // Re-assert identity in case session profile arrived late during start.
    this.wirePeIdentityAndComms(system, physOffset)
    // PE entity delete → drop PhysX statics in the PE id namespace (freezeRemoval would leave ghosts).
    system.setCollidersRemoveCallback((entity) => {
      this.onColliderEntityRemovedWithOffset(entity, physOffset)
    })
    system.setCollidersPoseCallback((entities) => {
      // Pose slides use remapped phys ids in multi-scene tick; skip primary-only slide path.
      void entities
    })
    // PE is a full scene runtime — play-ready so engine ticks match primary.
    // Free-flight intent is queued if the worker is not up yet (flushed on ready/boot).
    system.notifyPlayReady({
      engineTickIntervalMs: resolveEngineTickIntervalMs(this.performanceTier),
      portableExperience: true
    })
    this.startInputHub()
    // Same keyboard bus as primary — subscribe as pe:<physOffset>, no second window listener.
    system.setInputHub(this.inputHub, `pe:${physOffset}`)
    system.bindPointerEvents(
      () => this.player?.getWorldPosition() ?? null,
      () => this.player?.isPointerBlocked() ?? false,
      () => this.physics,
      {
        // Hub global block covers chat/settings; PE worker still receives keys while frozen.
        isRelayBlocked: () => this.isInputHubBlocked(),
        isLocomotionBlocked: () =>
          this.multiScene?.pe.isAvatarLocomotionFrozenByPe() === true ||
          (this.player?.isLocomotionBlocked() ?? false),
        clearPlayerMoveKeys: () => this.player?.clearMoveKeys(),
        // PE drone freeze — republish every hub.sync so worker isPressed stays live.
        forceRepublishSnapshot: () => this.multiScene?.pe.isAvatarLocomotionFrozenByPe() === true
      },
      (mode) => this.player?.setForcedCameraMode(mode)
    )
    // Re-attach primary so hub has primary + PE (PE wire must not leave a 1-subscriber bus).
    this.sceneScript.setInputHub(this.inputHub, 'primary')
    this.sceneScript.bindPointerEvents(
      () => this.player?.getWorldPosition() ?? null,
      () => this.player?.isPointerBlocked() ?? true,
      () => this.physics,
      {
        isRelayBlocked: () => this.isInputHubBlocked(),
        isLocomotionBlocked: () =>
          this.multiScene?.pe.isAvatarLocomotionFrozenByPe() === true ||
          (this.player?.isLocomotionBlocked() ?? true),
        clearPlayerMoveKeys: () => this.player?.clearMoveKeys()
      },
      (mode) => this.player?.setForcedCameraMode(mode)
    )
    // Worker may already be up after prepare race — flush PE free-flight again.
    system.notifyPlayReady({
      engineTickIntervalMs: resolveEngineTickIntervalMs(this.performanceTier),
      portableExperience: true
    })
    system.setAvatarModifierProviders({
      getSamples: () => {
        const samples: { id: string; position: { x: number; y: number; z: number } }[] = []
        const localPos = this.player?.getPosition()
        if (localPos) {
          const localId = this.session.getAddress()?.toLowerCase() ?? ''
          samples.push({
            id: localId,
            position: { x: localPos.x, y: localPos.y, z: localPos.z }
          })
        }
        this.remoteAvatars?.collectModifierSamples(samples)
        return samples
      },
      apply: (id, effects) => {
        const localId = this.session.getAddress()?.toLowerCase() ?? ''
        if (!id || id === localId) {
          this.player?.setModifierHidden(effects.hide)
        } else {
          this.remoteAvatars?.setModifierHidden(id, effects.hide)
        }
      }
    })
    // Prefer PE VC bridge immediately if already bound (restore / late wire).
    this.selectActiveVirtualCameraBridge()
    console.info(
      `[pe] wired full primary-class runtime (hub sub=pe:${physOffset}, play-ready, pointer, VC, physics)`
    )
  }

  /**
   * Global keyboard gate for InputHub — chat / client overlays / primary scene text fields.
   * PE HUD buttons are not blocked (only #scene-ui-root text inputs).
   */
  private isInputHubBlocked(): boolean {
    if (isTextInputFocused()) return true
    if (document.querySelector('.settings-overlay.is-open')) return true
    if (document.querySelector('.preferences-panel.is-open')) return true
    // Primary scene ECS text/select only (not PE HUD buttons / pe-ui-root).
    const ae = document.activeElement
    if (
      ae instanceof HTMLElement &&
      ae.closest('#scene-ui-root') &&
      (ae.classList.contains('scene-ui-node__input') ||
        ae.classList.contains('scene-ui-node__select'))
    ) {
      return true
    }
    // Client HUD chat dock etc. — but do not block when only PE UI has focus.
    if (this.player?.isSceneRelayBlocked()) {
      if (ae instanceof HTMLElement && ae.closest('#pe-ui-root') && !ae.closest('#scene-ui-root')) {
        return false
      }
      return true
    }
    return false
  }

  /** Start the single keyboard bus (idempotent). */
  private startInputHub(): void {
    this.inputHub.start({
      isBlocked: () => this.isInputHubBlocked(),
      isLocomotionBlocked: () =>
        this.multiScene?.pe.isAvatarLocomotionFrozenByPe() === true ||
        (this.player?.isLocomotionBlocked() ?? false),
      clearPlayerMoveKeys: () => this.player?.clearMoveKeys()
    })
  }

  /** Last selected lens owner for one-shot logs (primary vs pe). */
  private lastVcBridgeOwner: 'none' | 'primary' | 'pe' = 'none'

  /**
   * Lens from camera claim (Phase B) or PE bound MainCamera, else primary freecam bridge.
   */
  private selectActiveVirtualCameraBridge(): void {
    if (!this.player) return
    // Prefer claim winner when multi-scene is live.
    if (this.multiScene) {
      const claims = collectPlayerClaims(this.multiScene.listLayers())
      if (claims.camera?.bridge && claims.camera.mainCameraBound) {
        this.player.setVirtualCameraBridge(claims.camera.bridge)
        const owner = claims.camera.kind === 'pe' ? 'pe' : 'primary'
        if (this.lastVcBridgeOwner !== owner) {
          this.lastVcBridgeOwner = owner
          console.info(
            `[layers] VirtualCamera lens → ${owner} (${claims.camera.layerId.slice(0, 24)})`
          )
        }
        return
      }
    }
    this.player.setVirtualCameraBridge(this.sceneScript.getVirtualCameraBridge())
    if (this.lastVcBridgeOwner === 'pe') {
      this.lastVcBridgeOwner = 'primary'
      console.info('[layers] VirtualCamera lens → primary (no camera claim)')
    } else if (this.lastVcBridgeOwner === 'none') {
      this.lastVcBridgeOwner = 'primary'
    }
  }

  private isAnyVirtualCameraActive(): boolean {
    if (this.sceneScript.getVirtualCameraBridge()?.isActive() === true) return true
    for (const sys of this.multiScene?.pe.getRunningSystems() ?? []) {
      if (sys.getVirtualCameraBridge()?.isActive() === true) return true
    }
    return false
  }

  /** PE tweens / billboards / animators — same motion pump as primary. */
  private pumpPeMotionBridges(delta: number, frame: number): void {
    for (const sys of this.multiScene?.pe.getRunningSystems() ?? []) {
      try {
        sys.pumpMotionBridges(delta, frame)
      } catch (err) {
        console.warn('[pe] pumpMotionBridges failed', err)
      }
    }
  }

  /** PE entity remove with phys-id offset (PE namespace). */
  private onColliderEntityRemovedWithOffset(ecsEntity: Entity, physOffset: number): void {
    const meshId = (ecsEntity as number) + physOffset
    const gltfId = GLTF_COLLIDER_ENTITY_BASE + (ecsEntity as number) + physOffset
    // Also try PE-remapped gltf base used in multi-scene fingerprints.
    const peGltfId = GLTF_COLLIDER_ENTITY_BASE + meshId
    for (const id of [meshId, gltfId, peGltfId]) {
      if (this.physics.hasStaticActor(id)) {
        this.physics.invalidateStaticCollider(id)
        this.colliderCookQueue.delete(id)
      }
    }
    // Registered phys ids from SceneWorkerSlot use entity+offset for both mesh-style descs.
    this.physics.invalidateControllerCache()
  }

  /**
   * Phase B+D — continuous claims + HostPoseMode + discrete privileged intents.
   */
  private applyLayerPlayerClaims(): void {
    if (!this.multiScene) return
    const claims = collectPlayerClaims(this.multiScene.listLayers())
    const poseMode = hostPoseModeFromClaims(claims)
    if (poseMode !== this.lastHostPoseMode) {
      this.lastHostPoseMode = poseMode
      console.info(`[layers] HostPoseMode → ${hostPoseModeLabel(poseMode)}`)
    }
    // Every layer: skip reserved feet inject when layer_drive.
    const drive = poseMode === 'layer_drive'
    this.sceneScript.setHostLayerDrivePoses(drive)
    for (const layer of this.multiScene.listLayers()) {
      if (layer.kind === 'primary') continue
      try {
        layer.system.setHostLayerDrivePoses(drive && claims.poseDrive?.layerId === layer.id)
      } catch {
        /* ignore */
      }
    }

    this.playerClaims.apply(claims, {
      primary: this.sceneScript,
      player: this.player,
      setVirtualCameraBridge: (bridge) => {
        if (bridge) this.player?.setVirtualCameraBridge(bridge)
      },
      primaryVirtualCameraBridge: () => this.sceneScript.getVirtualCameraBridge()
    })
    // PE IM is a PlayerSystem override — never written onto primary ECS, so no retain mirror.
    this.sceneScript.setRetainPeMirroredInputModifier(false)
    // Discrete intents still via arbiter (movePlayer / emote / teleport).
    this.drainPePrivilegedIntents()
  }

  /**
   * layer_drive: copy poseDrive layer PlayerEntity onto capsule.
   */
  private syncPlayerFromPoseDriveClaim(): void {
    if (!this.player || !this.multiScene) return
    if (this.lastHostPoseMode !== 'layer_drive') return
    const claims = collectPlayerClaims(this.multiScene.listLayers())
    if (!claims.poseDrive || claims.poseDrive.kind !== 'pe') return
    this.player.setAllowSceneOwnedMotion(true)
    const sys = claims.poseDrive.system
    try {
      const tr = sys.readComponents.Transform.getOrNull(sys.view.PlayerEntity) as
        | { position?: { x: number; y: number; z: number } }
        | null
      const p = tr?.position
      if (!p || ![p.x, p.y, p.z].every((n) => Number.isFinite(n))) return
      const feet = feetThreeFromPlayerEntityDcl(new THREE.Vector3(p.x, p.y, p.z))
      this.player.applySceneOwnedFeetPose(feet)
    } catch {
      /* ignore */
    }
  }

  getLoadedPrimaryScene(): ResolvedScene | null {
    return this.loadedPrimaryScene
  }

  /**
   * PE has full capability but lower priority. Intents submitted to the arbiter
   * during PE tick are applied here if still pending (primary already ran and
   * would have applied its own handlers directly — so remaining = PE wins only
   * when primary was silent on that channel).
   *
   * - movePlayerTo: scene-local feet
   * - teleportTo: global Genesis parcel → navigate (distinct from movePlayerTo)
   * - openExternal: handled directly on PE worker (confirm + tab; no reload)
   * - changeRealm: deprecated / ignored
   */
  private drainPePrivilegedIntents(): void {
    const arbiter = this.multiScene?.arbiter
    if (!arbiter || !this.player) return

    const move = arbiter.take('movePlayer')
    if (move && move.kind === 'pe') {
      try {
        this.player.movePlayerTo(move.payload as Parameters<PlayerSystem['movePlayerTo']>[0])
        this.sceneScript.nudgePlayAfterSceneTeleport()
      } catch (err) {
        console.warn('[pe] movePlayer apply failed', err)
      }
    }

    const emote = arbiter.take('emote')
    if (emote && emote.kind === 'pe') {
      const req = emote.payload as { predefinedEmote?: string }
      const name = req.predefinedEmote?.trim()
      if (name) void this.playLocalEmote(name, { loop: undefined, sceneTriggered: true })
    }

    // PE teleportTo = global parcel jump (not local movePlayerTo).
    const teleport = arbiter.take('teleport')
    if (teleport && teleport.kind === 'pe') {
      const parcel = parseTeleportParcel(
        teleport.payload as Parameters<typeof parseTeleportParcel>[0]
      )
      if (parcel) {
        console.info(`[pe] teleportTo → ${parcel.x},${parcel.y} (global)`)
        this.navigateHandler?.({
          kind: 'coords',
          x: parcel.x,
          y: parcel.y,
          segment: `${parcel.x},${parcel.y}`
        })
      }
    }

    // openExternal is applied on PE worker directly; drop any queued leftovers.
    arbiter.take('openExternal')
    arbiter.take('changeRealm')
    arbiter.take('camera')
    arbiter.take('locomotionClear')
  }

  /**
   * In-world promote (no World rebuild):
   * 1) handoff if target already live secondary
   * 2) else force-boot secondary for target, then handoff
   * Always demotes outgoing primary → sticky secondary (walk-back = resume, no reload).
   */
  async tryPromoteInWorld(target: { x: number; y: number }): Promise<boolean> {
    const multi = this.multiScene
    if (!multi || !this.player) return false

    let handoff = multi.takeSecondaryForPromote(target.x, target.y)
    if (!handoff) {
      console.info(
        `[promote] no live secondary @ ${target.x},${target.y} — force-boot for handoff…`
      )
      const booted = await multi.ensureSecondaryForParcel(target.x, target.y)
      if (!booted) return false
      handoff = multi.takeSecondaryForPromote(target.x, target.y)
      if (!handoff) return false
    }

    return this.applyPromoteHandoff(handoff)
  }

  /**
   * @deprecated use tryPromoteInWorld — kept for call sites that already have a secondary.
   */
  async tryPromoteFromSecondary(target: { x: number; y: number }): Promise<boolean> {
    return this.tryPromoteInWorld(target)
  }

  /**
   * Adopt secondary as primary; demote old primary to sticky secondary for resume.
   */
  private async applyPromoteHandoff(handoff: {
    entityId: string
    scene: ResolvedScene
    system: import('./systems/SceneScriptSystem').SceneScriptSystem
    physIds: number[]
  }): Promise<boolean> {
    const multi = this.multiScene
    if (!multi || !this.player) return false

    const pos = this.player.getPosition()
    const origin = this.comms.getSceneOrigin()
    const genesis = {
      x: pos.x + origin.x,
      y: pos.y,
      z: pos.z + origin.z
    }

    const oldPrimary = this.sceneScript
    const oldScene = this.loadedPrimaryScene
    const newScene = handoff.scene
    const newSystem = handoff.system

    // Drop secondary-offset colliders for the adopted scene (will re-register as primary ids).
    for (const id of handoff.physIds) {
      this.physics.invalidateStaticCollider(id)
    }

    // Demote old primary → sticky secondary (resume without reload when walking back).
    // Do this before wiring new primary so entity roots stay valid.
    if (oldScene?.entityId && oldScene.mainEntry && oldScene.entityId !== newScene.entityId) {
      const demoted = await multi.demotePrimaryToSecondary(oldPrimary, oldScene)
      if (demoted) {
        for (const id of demoted.primaryPhysIds) {
          this.physics.invalidateStaticCollider(id)
        }
        // Demoted will re-register colliders under secondary offset on next multi-scene tick.
      } else {
        try {
          oldPrimary.dispose()
        } catch (err) {
          console.warn('[promote] old primary dispose after demote fail', err)
        }
      }
    } else {
      try {
        oldPrimary.dispose()
      } catch (err) {
        console.warn('[promote] old primary dispose', err)
      }
    }

    this.sceneScript = newSystem
    this.loadedPrimaryScene = newScene
    this.assets.setScene(newScene)

    // Pose + player identity on the adopted worker.
    this.sceneScript.setClientPoseProvider(() => ({
      player: this.player!.getEntityPose(),
      camera: this.player!.getCameraEntityPose()
    }))
    this.sceneScript.setPerformanceTier(this.performanceTier)
    this.sceneScript.setPlayerIdentity(
      buildPlayerMirrorIdentity({
        address: this.session.getAddress(),
        profile: this.session.getProfile()
      })
    )
    this.sceneScript.setRealmInfo(this.comms.getRealmInfo())
    this.sceneScript.setCollidersCookCallback((entity) => this.onColliderCookRequest(entity))
    this.sceneScript.setCollidersPoseCallback((entities) => this.applyColliderPoseSlides(entities))
    this.sceneScript.setCollidersRemoveCallback((entity) => this.onColliderEntityRemoved(entity))
    this.remoteAvatars?.setEntityStore(this.sceneScript.getEntityStore())

    // Full primary RestrictedActions surface.
    this.sceneScript.setOpenExternalUrlHandler((request) => openExternalUrl(request))
    this.sceneScript.setOpenNftDialogHandler((request) => openNftDialog(request))
    this.sceneScript.setCopyToClipboardHandler((request) => copyToClipboard(request))
    this.sceneScript.setTeleportToHandler((request) => {
      const parcel = parseTeleportParcel(request)
      if (!parcel) return false
      this.navigateHandler?.({
        kind: 'coords',
        x: parcel.x,
        y: parcel.y,
        segment: `${parcel.x},${parcel.y}`
      })
      return true
    })
    this.sceneScript.setChangeRealmHandler(() => {
      console.info('[World] changeRealm ignored (deprecated)')
      return false
    })
    this.sceneScript.setMovePlayerHandler((request) => {
      const ok = this.player!.movePlayerTo(request)
      this.sceneScript.nudgePlayAfterSceneTeleport()
      return ok
    })
    this.sceneScript.setTriggerEmoteHandler((request) => {
      const emote = request.predefinedEmote?.trim()
      if (!emote) return false
      void this.playLocalEmote(emote, { loop: undefined, sceneTriggered: true })
      return true
    })
    this.sceneScript.setSceneUiVisible(true)

    // Comms / signed-fetch context for new primary.
    this.signedFetchSceneContext = {
      sceneId: newScene.entityId ?? '',
      parcel: newScene.baseParcel,
      realmName: newScene.realm.realmName,
      isWorld: newScene.source.kind === 'world'
    }
    this.sceneScript.setSignedFetchHandler(async (body) =>
      performSignedFetch(body, this.session.getAuthIdentity(), this.signedFetchSceneContext)
    )
    this.sceneScript.setSignedFetchGetHeadersHandler(async (body) =>
      performGetSignedHeaders(body, this.session.getAuthIdentity())
    )
    this.comms.applyRealmAbout(newScene.realm, newScene.commsPointer)
    this.session.setCatalystEndpoints(newScene.realm.contentUrl, newScene.realm.lambdasUrl)

    // AOI tertiary + promote controller retarget to new primary footprint.
    this.aoiVisual.bind({
      scene: newScene,
      cache: this.assets,
      hostScene: this.host.scene,
      syncRoadColliders: (descs) => {
        const result = this.physics.syncAoiRoadColliders(descs)
        if (result.geometryChanged) this.physics.warmStaticScene()
      },
      clearRoadColliders: () => this.physics.clearAoiRoadColliders(),
      onSecondaryCandidates: (candidates) => {
        this.multiScene?.reconcileSecondaries(candidates)
      }
    })
    this.scenePromote.bind(newScene)

    // Multi-scene keeps PE + demoted/remaining secondaries; retarget content map.
    multi.notifyPrimaryChanged(newScene)
    multi.setOnLiveSecondaryIds((ids) => this.aoiVisual.setLiveSecondaryIds(ids))

    // Re-cook colliders under primary entity ids.
    this.colliderCookQueue.clear()
    this.sceneScript.syncCollisionForce()
    this.reconcileColliderCookQueue()
    if (this.colliderCookQueue.size > 0) {
      void this.scheduleColliderCookDrain()
    }

    // Feet stay put in Genesis space.
    const ok = this.restoreGenesisFeet(genesis)
    console.info(
      `[promote] handoff+demote OK “${newScene.title}” base=${newScene.baseParcel}` +
        ` prev=${oldScene?.title ?? 'none'} restoreFeet=${ok}`
    )
    return true
  }

  getRemoteAvatarManager(): RemoteAvatarManager | null {
    return this.remoteAvatars
  }

  /** HUD toast while many remotes compose (community-style banner). */
  setRemoteAvatarProgressHandler(
    handler: ((progress: { total: number; loaded: number; pending: number }) => void) | null
  ): void {
    this.remoteAvatarProgressHandler = handler
    this.lastRemoteProgressKey = ''
  }

  private reportRemoteAvatarProgress(): void {
    if (!this.remoteAvatarProgressHandler || !this.remoteAvatars) return
    const now = performance.now()
    // Throttle UI updates — compose finishes are bursty.
    if (now - this.remoteProgressReportAt < 250) return
    this.remoteProgressReportAt = now
    const p = this.remoteAvatars.getComposeProgress()
    const key = `${p.total}:${p.loaded}:${p.pending}`
    if (key === this.lastRemoteProgressKey) return
    this.lastRemoteProgressKey = key
    this.remoteAvatarProgressHandler(p)
  }

  canPlayVoluntaryEmote(): boolean {
    return this.player?.canPlayVoluntaryEmote() ?? true
  }

  setVoluntaryEmoteAllowedHandler(handler: ((allowed: boolean) => void) | null): void {
    this.onVoluntaryEmoteAllowedChange = handler
    if (handler && this.player) {
      const allowed = this.player.canPlayVoluntaryEmote()
      this.lastVoluntaryEmoteAllowed = allowed
      handler(allowed)
    }
  }

  /** Debounce scene double-fires (watering plant / sit often RPC twice same frame). */
  private lastSceneEmoteKey = ''
  private lastSceneEmoteAt = 0
  private static readonly SCENE_EMOTE_DEBOUNCE_MS = 450

  playLocalEmote(
    emoteRef: string,
    options?: { loop?: boolean; broadcast?: boolean; /** Scene triggerEmote / AvatarEmoteCommand — bypass disableEmote. */ sceneTriggered?: boolean }
  ): void {
    if (!this.playerMode || !this.player) return
    if (!options?.sceneTriggered && !this.player.canPlayVoluntaryEmote()) return

    const key = emoteRef.trim().toLowerCase()
    if (options?.sceneTriggered && key) {
      const now = performance.now()
      if (key === this.lastSceneEmoteKey && now - this.lastSceneEmoteAt < World.SCENE_EMOTE_DEBOUNCE_MS) {
        return
      }
      this.lastSceneEmoteKey = key
      this.lastSceneEmoteAt = now
    }

    // Pause remote avatar composes while we load/bind the emote GLB (main-thread heavy).
    this.remoteAvatars?.setLocalEmoteLoadBusy(true)
    void this.player
      .playEmote(emoteRef, { loop: options?.loop })
      .then((resolved) => {
        if (resolved && options?.broadcast !== false) {
          void this.comms.broadcastEmote(resolved.urn)
        }
      })
      .finally(() => {
        this.remoteAvatars?.setLocalEmoteLoadBusy(false)
      })
  }

  /** Reload local avatar after backpack equip / profile save (session profile, not stale Catalyst). */
  async reloadLocalAvatar(): Promise<void> {
    if (!this.playerMode || !this.player) return
    const profile = this.session.getProfile()
    const address = this.session.getAddress() ?? profile?.address
    if (profile && address) {
      // Prefer session wearables immediately; Catalyst lambdas lag after deploy.
      clearProfileCaches(address)
      seedLocalProfileCache(address, profile)
    }
    // Session profile is authoritative right after a local deploy.
    await this.player.reloadAvatar(undefined, profile ?? undefined)
    // Re-announce with the deploy-bumped version + fresh serialized profile so
    // peers rebuild our remote avatar (they ignore repeats of the old version).
    this.comms.setCommsProfile(this.session.getCommsProfileEntity())
    this.comms.announceProfile('connect')
    // Equip key + announce identity — session wallet wins over stale ?profile=.
    await this.vrmPeerSync.onLocalEquipChanged(address)
    // Re-assert third-person body after mesh swap (FPV hide must not stick across equip).
    this.player.forceRefreshBodyVisibility()
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
    this.unsubAvatarChatTranslate?.()

    this.unsubAvatarChat = this.social.onChat((event) => {
      if (!event.channelKey.startsWith('scene:')) return
      const address = event.line.senderAddress?.toLowerCase()
      if (!address) return
      if (!isChatTextLine(event.line)) return
      // Prefer live translation when already ready (cache hit / fast auto-translate).
      const display = chatTranslationService.displayText(event.line.id, event.line.text)
      const text = overheadChatText(display)
      if (!text) return
      this.overheadChatActive.set(address, {
        messageId: event.line.id,
        originalText: event.line.text,
        shownAt: performance.now()
      })
      this.showAvatarOverheadChat(address, text)
    })

    // When a translation finishes, refresh the bubble if it's still the active line.
    this.unsubAvatarChatTranslate = chatTranslationService.onUpdate((evt) => {
      const t = evt.translation
      if (t.state !== 'success' || t.showingOriginal || !t.translatedText) return
      for (const [address, active] of this.overheadChatActive) {
        if (active.messageId !== evt.messageId) continue
        if (performance.now() - active.shownAt > NAME_TAG_CHAT_DISPLAY_MS) {
          this.overheadChatActive.delete(address)
          continue
        }
        const text = overheadChatText(t.translatedText)
        if (!text) continue
        // Reset the 10s timer so the translated line is readable.
        this.showAvatarOverheadChat(address, text)
        this.overheadChatActive.set(address, {
          messageId: active.messageId,
          originalText: active.originalText,
          shownAt: performance.now()
        })
      }
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
    fftSettings: FftOceanSettings,
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
    const fft = resolveFftOceanSettings(scene.metadata)
    const waterColor = new THREE.Color(fft.waterDeep).getHex()
    const ocean = await IslandWater.create(scene.parcels, scene.baseParcel, shoreWidthParcels, {
      waterColor,
      // Milder distortion when FFT is off so Water.js still reads as a calm shore.
      distortionScale: fft.enabled ? 3.7 : 2.6
    })
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
    this.onVoluntaryEmoteAllowedChange = null
    this.lastVoluntaryEmoteAllowed = true
    this.unsubAvatarChat?.()
    this.unsubAvatarChat = null
    this.unsubAvatarChatTranslate?.()
    this.unsubAvatarChatTranslate = null
    this.overheadChatActive.clear()
    this.unsubEnvironmentDebug?.()
    this.unsubEnvironmentDebug = null
    this.photoCamera?.dispose()
    this.photoCamera = null
    this.photoChromeHandler = null
    this.host.stop()

    // Detach multi-scene (PE workers) before primary host dies — PE prefs stay on manager.
    if (this.multiScene) {
      this.multiScene.unregisterPrimary()
      this.multiScene.unbindWorld()
      this.multiScene = null
    }
    this.peMirror.reset()
    this.playerClaims.reset()
    this.inputHub.dispose()

    // Scene systems first — CameraModeArea / pointer dispose still call into player.
    this.sceneScript.gltfColliders?.setLandscapeRoot(null)
    this.sceneScript.dispose()

    this.player?.dispose()
    this.player = null
    this.unsubAvatarToon?.()
    this.unsubAvatarToon = null
    this.remoteAvatars?.dispose()
    this.remoteAvatars = null

    this.clearOcean()
    this.environment.dispose()

    this.aoiVisual.dispose()
    this.scenePromote.unbind()
    this.loadedPrimaryScene = null
    this.ezTreeGrass?.dispose()
    this.ezTreeGrass = null
    this.desertAtmosphere = null
    resetFoliageWindRegistry()
    this.landscape.state.landscapeRoot?.removeFromParent()
    this.landscape.state.landscapeRoot = null
    this.host.scene.fog = null

    this.physics.dispose()

    this.vrmPeerSync.detach()
    clearVrmRamCache()
    this.voice.setInPlay(false)
    this.voice.dispose()
    this.comms.dispose()
    this.social.dispose()

    this.assets.clearScene()
    clearGeometryCookCache()
    clearPrimedPhysxCookStreams()
    disposePhysxCookPool()

    this.host.dispose()
  }

  private async handleSendBinary(body: SendBinaryRequest) {
    // peerData with empty address[] is still room broadcast (auth-server CUSTOM_EVENT often
    // uses peerData envelope without targets). Split for accurate ?syncdebug metrics.
    const directed: Array<{ chunk: Uint8Array; addresses: string[] }> = []
    const broadcastFromPeers: Uint8Array[] = []
    for (const entry of body.peerData ?? []) {
      const addrs = (entry.address ?? []).filter(Boolean)
      for (const chunk of entry.data ?? []) {
        if (addrs.length) directed.push({ chunk, addresses: addrs })
        else broadcastFromPeers.push(chunk)
      }
    }
    const broadcast = [...(body.data ?? []), ...broadcastFromPeers]
    const sent: Uint8Array[] = []

    if (broadcast.length === 0 && directed.length === 0) {
      return { data: await this.comms.sendBinary([]) }
    }

    logSyncOutbound({ broadcast, directed })

    if (broadcast.length) {
      sent.push(...(await this.comms.sendBinary(broadcast)))
    }
    for (const entry of directed) {
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
