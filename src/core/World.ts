import type { Entity } from '@dcl/ecs'
import type { ResolvedScene } from '../dcl/content/types'
import * as THREE from 'three'
import { createTerrainModel } from '../dcl/landscape/Worlds/TerrainModel'
import { getSessionAssetCache, prefetchSceneManifestAssets } from '../rendering/AssetCache'
import { DebugAvatarCrowd } from '../debug/DebugAvatarCrowd'
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
import { PlayerClaimApplier } from '../dcl/multiScene/PlayerClaimMerger'
import { collectPlayerClaims } from '../dcl/multiScene/PlayerClaimMerger'
import {
  resolvePortableExperiencesPolicy,
  type PortableExperiencesPolicy
} from '../dcl/multiScene/resolvePortableExperiences'
import { renderQuality } from '../rendering/RenderQualitySettings'
import {
  skipAoiNeighbors,
  skipSceneAnimators,
  wantAnimatorSampleHud
} from '../client/devFlags'
import { AnimatorSampleHud } from '../debug/AnimatorSampleHud'
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
import { perfSetRemoteStats } from '../util/perfCounters'
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
import {
  logAdminToolsIdentitySnapshot,
  maybeLogLiveSceneAdminSignedFetch,
  probeSceneAdminForAdminTools
} from '../network/gatekeeper/adminToolsDiagnostics'
import { shortenAddress } from '../avatar/displayName'
import { buildPlayerMirrorIdentity, getOrCreateGuestAddress } from '../bridge/playerMirrorIdentity'
import type { AvatarAttachTargetResolver } from '../avatar/AvatarAttachTargets'
import { dclToThreeVec, type DclTransformValues } from '../bridge/dclTransform'
import { feetDclToPlayerEntityPosition } from '../player/dclPlayerEntity'
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
  prefetchPhysxCookStreams,
  startPhysxCookPrefetch
} from '../physics/geometryToPxMesh'
import { clearPrimedPhysxCookStreams } from '../physics/physxCookByteCache'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { isTextInputFocused } from '../client/ui/textInputFocus'
import { skipRemoteAvatars } from '../client/devFlags'
import { InputHub } from '../input/InputHub'
import { initMainThreadPerfFromUrl, recordMainThreadPerf } from '../debug/MainThreadPerf'
import { VrmPeerSync } from '../avatar/vrm/VrmPeerSync'

import { PetManager } from '../pets/PetManager'
import { PetPeerSync } from '../pets/PetPeerSync'
import { PetContextMenu } from '../pets/PetContextMenu'
import { getActivePetEntry } from '../pets/petInventoryStorage'
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
  /** Help → Debug crowd harness (local composed avatars for multi-avatar FPS tests). */
  private debugAvatarCrowd: DebugAvatarCrowd | null = null
  private readonly vrmPeerSync = new VrmPeerSync()
  /** Client pets (DPET over RFC4 — not scene CRDT). */
  private readonly petPeerSync = new PetPeerSync()
  private readonly petManager = new PetManager()
  private petContextMenu: PetContextMenu | null = null
  private petContextMenuBound = false
  private readonly onCanvasPetContextMenu = (ev: MouseEvent): void => {
    this.handlePetContextMenu(ev)
  }
  /** Community tour flag (session-owned manager bound here for spine attach + tick). */
  private followFlagManager: import('../social/FollowFlagManager').FollowFlagManager | null = null
  /** AppController: Tour Focus cam publish (leader) + apply (follower). */
  private tourFocusTick: ((delta: number) => void) | null = null
  private avatarAttachResolver: import('../avatar/AvatarAttachTargets').AvatarAttachTargetResolver | null =
    null
  /** Explorer In-World Camera (photo fly mode) — dedicated lens, not orbit freecam. */
  private photoCamera: PhotoCameraController | null = null
  private photoChromeHandler: ((visible: boolean) => void) | null = null
  /** Last loaded scene — photo metadata place name. */
  private photoSceneTitle = 'Scene'
  private playerMode = !useOrbitMode()
  private editorPreviewMode = false
  /** AppController — RestrictedActions teleportTo / changeRealm. */
  private navigateHandler:
    | ((target: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>) => void)
    | null = null
  private lastGltfColliderCount = 0
  private loggedGltfPhysMismatch = false
  private collidersPhysLastLog = 0

  private loggedFinalizePoseDiag = false
  private loggedPlatformMotionDebugHint = false
  private collidersLoadingComplete = false
  /**
   * Platform gate: primary-scene colliders prepared (single prep path).
   * Player locomotion blocked until true.
   */
  private collidersReady = false
  private lastPhysicsBatchFp = ''
  private signedFetchSceneContext: SignedFetchSceneContext | null = null
  private sceneCommsConnected = false
  private pendingColliderCooks = 0
  private readonly colliderCookQueue = new Set<number>()
  /** Extract while GLBs attach; PhysX cook runs in prepareCollidersForPlay. */
  private deferPhysxCooks = true
  private readonly colliderCookPriority = new THREE.Vector3()
  private warmStaticScenePending = false
  private colliderCookDrainInFlight = false
  private bootAssetsTimedOut = false
  private lastNeverCookedScanMs = 0
  /** Missing-actor scan only (no near-player thrash). */
  private static readonly NEVER_COOKED_SCAN_MS = 1_500
  private lastColliderHealthLogMs = 0
  private lastLoggedStaticCount = -1
  /** SQ soft watchdog interval (probe-only; not full O(static) diag). */
  private lastSqSoftWatchMs = 0

  /** Runtime burst (e.g. theatre composite spawns). */
  private runtimeColliderBurstUntil = 0
  /** True after prepareCollidersForPlay finishes cooking. */
  private spawnColliderSealComplete = false
  /**
   * Last PART hull fingerprint written to PhysX (cook-once + move).
   * Unchanged → skip (decorative loops with fixed hulls no-op).
   */
  private readonly partMotionPoseFp = new Map<number, string>()
  private loggedPartNoCollider = new Set<number>()
  private unsubAvatarChat: (() => void) | null = null
  private unsubAvatarChatTranslate: (() => void) | null = null
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
  /** Phase B — continuous layer claims (replaces PeMainThreadMirror). */
  private readonly claimApplier = new PlayerClaimApplier()
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
  /** Always-on top-right phase-slice animator counters. */
  private readonly animatorSampleHud = new AnimatorSampleHud()

  /** Per-tick budget while GLBs still attaching on the loading screen. */
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
    // Peer avatar compose: CCT cache only — never reinsert/rebuild after seal.
    this.remoteAvatars.setOnComposeSettled(() => {
      if (!this.collidersLoadingComplete) return
      this.physics.invalidateControllerCache()
    })

    this.unsubEnvironmentDebug = environmentDebug.subscribe(() => this.applyEnvironmentDebugVisibility())

    this.petManager.bindScene(this.host.scene)
    this.petManager.attachPeerSync(this.petPeerSync)
    this.wireCommsHandlers()
    this.bindPetContextMenu()
    this.bindIslandLiveKitReady()
  }

  /** Empty land: multiplayer is island-only — re-probe DAV/DPET once island LiveKit is up. */
  private bindIslandLiveKitReady(): void {
    this.comms.onIslandLiveKitReady = () => {
      const addr = this.session.getAddress() ?? null
      void this.reannounceDavAndPets(addr, 'island LiveKit ready')
    }
  }

  /**
   * Force local DAV + DPET re-announce and probe peers.
   * Restore pets **before** pet onSceneConnected so we never broadcast a premature Clear.
   */
  private async reannounceDavAndPets(
    address: string | null,
    reason: string
  ): Promise<void> {
    this.vrmPeerSync.setLocalAddress(address)
    this.petPeerSync.setLocalAddress(address)
    if (address) this.petManager.setLocalWallet(address)
    // Inventory first so pet equip is known before onSceneConnected re-announces.
    await this.petManager.restoreFromInventory(address)
    await this.vrmPeerSync.onSceneConnected()
    await this.petPeerSync.onSceneConnected()
    if (this.remoteAvatars) {
      this.vrmPeerSync.replayAllPeerEquips(this.remoteAvatars)
    }
    this.vrmPeerSync.scheduleLoginWantAnnounceRetries()
    this.petPeerSync.scheduleLoginWantAnnounceRetries()
    console.info(`[pets/vrm] ${reason} — re-announce + WantAnnounce retries`)
  }

  /**
   * Landing → play: take the shell's live CommsService (already in world+scene rooms).
   * Does **not** disconnect LiveKit — only rewires peer handlers onto this World.
   */
  adoptComms(shellComms: CommsService, opts?: { isWorld?: boolean }): void {
    const addr = this.session.getAddress() ?? null
    if (this.comms === shellComms) {
      this.sceneCommsConnected = shellComms.isLiveKitConnected()
      if (opts?.isWorld != null) this.comms.pruneUnusedLiveKitForTarget({ isWorld: opts.isWorld })
      // Handoff cleared chat handlers — re-bind 3D SocialService immediately.
      this.social.rewireComms(this.comms)
      // Same LiveKit instance, but World just attached — re-seed peers + force local equip out.
      this.comms.notifyHandlersOfCurrentPeers()
      void this.reannounceDavAndPets(addr, 'adoptComms (same session)')
      return
    }
    this.vrmPeerSync.detach()
    this.petPeerSync.detach()
    const unused = this.comms
    this.comms = shellComms
    // Fresh World service never joined — safe to dispose without killing LiveKit.
    unused.dispose()

    this.wireCommsHandlers()
    this.bindIslandLiveKitReady()
    // Shell cleared setChatHandler(null) on transfer — bind 3D chat NOW (not after long spawn).
    this.social.rewireComms(this.comms)
    this.sceneCommsConnected = this.comms.isLiveKitConnected()
    if (opts?.isWorld != null) this.comms.pruneUnusedLiveKitForTarget({ isWorld: opts.isWorld })
    this.petManager.setLocalWallet(addr)
    this.petManager.attachPeerSync(this.petPeerSync)
    // Peers already in the room never re-fire join — push them into RemoteAvatarManager.
    this.comms.notifyHandlersOfCurrentPeers()
    this.syncVoiceRoom()
    // Local guest VRM + pet equip often announced before World handlers existed — re-push now.
    void this.reannounceDavAndPets(addr, 'adoptComms (new session)')
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
    clientDebugLog.log('chat', `3d social bootstrapped · ${scene.commsPointer}`)
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
      clientDebugLog.log('voice', `rooms changed ${this.comms.describeLiveKitRooms()}`)
      this.voice.dumpStatus('rooms-changed', true)
      this.logAllRoomsAudio('rooms-changed')
    }
    this.voice.bindRoomsProvider(() => this.comms.getVoiceLiveKitRooms())
    this.voice.bindStatusProvider(() => this.comms.describeLiveKitRooms())
    this.voice.bindInventoryProvider(() => this.comms.describeAllRoomsAudioInventory())
    this.wireVoiceSpatial()
    this.voice.refreshRooms()
    clientDebugLog.log('voice', `syncVoiceRoom ${this.comms.describeLiveKitRooms()}`)
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
    clientDebugLog.log(
      'voice',
      `unlocked · displayName=${dn ?? '(none)'} · ${this.comms.describeLiveKitRooms()}`
    )
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
    let lastUnlockMs = 0
    const onGesture = (): void => {
      if (!this.voice.isInPlay()) return
      if (!this.voice.needsPlaybackUnlock() && this.voice.getSnapshot().remoteCount > 0) return
      const now = performance.now()
      // Pointer spam was unlockRemotePlayback every click/frame and nuked FPS.
      if (now - lastUnlockMs < 1500) return
      lastUnlockMs = now
      void this.voice.unlockRemotePlayback('user-gesture')
    }
    window.addEventListener('pointerdown', onGesture, true)
    window.addEventListener('keydown', onGesture, true)
  }

  /** Log scene/world/island remote track inventory (find mic on wrong room). */
  logAllRoomsAudio(reason: string): void {
    const inv = this.comms.describeAllRoomsAudioInventory()
    clientDebugLog.log('voice', `all-rooms inventory (${reason}):\n${inv}`)
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

    this.petPeerSync.attach(this.comms, {
      onPeerPetChanged: (address, contentHash, category, meshYawOffsetDeg) => {
        this.petManager.onPeerPetChanged(address, contentHash, category, meshYawOffsetDeg ?? 0)
      },
      onPeerPetBytesReady: (address, contentHash, category, meshYawOffsetDeg) => {
        void this.petManager.onPeerPetBytesReady(
          address,
          contentHash,
          category,
          meshYawOffsetDeg ?? 0
        )
      },
      onPeerPetPose: (address, pose) => {
        this.petManager.onPeerPetPose(address, pose)
      }
    })
    this.petManager.setPeerFeetProvider((address) => {
      const root = this.remoteAvatars?.getPeerRoot(address)
      if (!root) return null
      return root.position.clone()
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
          void this.petPeerSync.onPeerJoined(address)
          // Announce may have landed before this peer was tracked — re-apply.
          this.petPeerSync.replayPeerEquip(address)
          void this.social.ensurePeerProfile(address)
          this.social.onRemotePeerJoined(address)
        },
        onPeerLeave: (address) => {
          if (skipRemoteAvatars()) return
          this.vrmPeerSync.onPeerLeave(address)
          this.petPeerSync.onPeerLeave(address)
          this.petManager.removeRemote(address)
          this.remoteAvatars?.removePeer(address)
          this.social.onRemotePeerLeft(address)
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
    const addr = this.session.getAddress() ?? null
    this.vrmPeerSync.setLocalAddress(addr)
    this.petPeerSync.setLocalAddress(addr)
    this.petManager.setLocalWallet(addr)
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
    // Join-without-pose remotes park at scene spawn (Three feet), never at local player.
    this.remoteAvatars?.setProvisionalSpawnPosition(this.seedPosesFromSpawn(scene.spawn).feetThree)

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
        this.landscape.state.landscapeRoot.visible = true
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
    // ?noaoi keeps walk open if radius > 0, but skips neighbor systems.
    const aoiOff = skipAoiNeighbors()
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
    // Neighbors stay off until notifyPlayReady (setNeighborActivityEnabled).
    // ?noaoi=1 — never bind AOI / promote / live secondaries (primary-only CBD debug).
    this.multiScene?.setSecondaryActivityEnabled(false)
    if (openCityWalk && !aoiOff) {
      this.aoiVisual.bind({
        scene,
        cache: this.assets,
        hostScene: this.host.scene,
        syncRoadColliders: (descs) => {
          // Runtime road rebuilds use cache-invalidate only (no simulate(0) — see PhysXWorld).
          this.physics.syncAoiRoadColliders(descs)
        },
        clearRoadColliders: () => this.physics.clearAoiRoadColliders(),
        syncEmptyLandColliders: (descs) => {
          this.physics.syncAoiEmptyLandColliders(descs)
        },
        clearEmptyLandColliders: () => this.physics.clearAoiEmptyLandColliders(),
        purgeEmptyLandColliders: (entityIds) => {
          this.physics.purgeAoiEmptyLandColliders(entityIds)
        },
        onSecondaryCandidates: (candidates) => {
          this.multiScene?.reconcileSecondaries(candidates)
        }
      })
      this.scenePromote.bind(scene)
      // Prewarm default ground + roads + scatter for Scene Distance while primary hydrates.
      const spawnFeet = scene.spawn
        ? { x: scene.spawn.x, z: scene.spawn.z }
        : { x: 8, z: 8 }
      this.aoiVisual.prewarmVisuals(spawnFeet.x, spawnFeet.z)
      console.info(
        `[aoi] Genesis walk — Scene Distance warm=${renderQuality.getSceneLoadRadiusM()}m · FocusOwner=primary · base=${scene.baseParcel}`
      )
    } else if (aoiOff) {
      this.aoiVisual.unbind()
      this.scenePromote.unbind()
      this.multiScene?.disposeSecondariesOnly()
      console.info(
        `[aoi] DISABLED (?noaoi) — primary only · base=${scene.baseParcel} parcels=${scene.parcels.length}`
      )
    }
    if (skipSceneAnimators()) {
      console.info(
        '[perf] scene animators OFF (?noanim) — AnimatorBridge bind/update skipped'
      )
    } else {
      console.info(
        '[perf] scene animators ON — shared-hash sample + fair ring (in-view target ≥30 Hz, near every frame)'
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
      this.applySignedFetchSceneContext(scene)
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
        // Scene code moved the player (not WASD) — host capsule is truth; rebroadcast to all workers.
        if (ok) {
          this.rebroadcastHostPosesToAllLayers()
          this.sceneScript.nudgePlayAfterSceneTeleport()
          this.kickPostTeleportColliderCatchup()
        }
        return ok
      })
      this.sceneScript.setSetCameraTransformHandler((request) =>
        this.player!.setTestingCameraTransform(request)
      )
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
        clientDebugLog.consoleOnly('info', `[pointer] triggerSceneEmote handler — src=${src}`)
        const resolved = resolveSceneEmoteFromSrc(src, request.loop ?? false)
        if (!resolved) {
          clientDebugLog.log('pointer', `triggerSceneEmote miss — ${src}`, { level: 'warn' })
          clientDebugLog.consoleOnly('warn', `[pointer] triggerSceneEmote miss — ${src}`)
          return false
        }
        clientDebugLog.log('pointer', `triggerSceneEmote → ${resolved.urn}`)
        clientDebugLog.consoleOnly('info', `[pointer] triggerSceneEmote → ${resolved.urn}`)
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
    this.petPeerSync.setLocalAddress(address)
    this.petManager.setLocalWallet(address)

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
      // SDK network: pulse RealmInfo.isConnectedSceneRoom for fishing/syncEntity.
      this.sceneScript.pulseSceneNetworkConnected()
      onProgress?.('Receiving peer updates…')
      await this.reannounceDavAndPets(address, 'early scene comms (reuse)')
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
      // Gatekeeper seed + any room remotes already present (follow teleports miss join events).
      this.comms.notifyHandlersOfCurrentPeers()
      this.syncVoiceRoom()
      clientDebugLog.log('network', 'Early scene comms connected during hydration', {
        level: 'success',
        alsoConsole: true
      })
      this.sceneScript.pulseSceneNetworkConnected()
      onProgress?.('Receiving peer updates…')
      await this.reannounceDavAndPets(address, 'early scene comms (fresh connect)')
      return
    }
    if (connectResult.reason === 'comms_disabled') {
      // Content-only or broken LiveKit — play solo without chat/peers.
      onProgress?.('Multiplayer unavailable — continuing solo')
      void this.petManager.restoreFromInventory(address)
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
    // Walk blocked until prepareCollidersForPlay + capsule succeed.
    this.collidersReady = false
    this.player.setCollidersReady(false)

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
        this.petPeerSync.setLocalAddress(address)
        this.petManager.setLocalWallet(address)
        const connectResult = await this.comms.connectSceneRoom(this.buildCommsTarget(scene))
        this.sceneCommsConnected = connectResult.ok
        if (connectResult.ok) {
          this.comms.seedArchipelagoSceneLocal(scene.spawn.x, scene.spawn.y, scene.spawn.z)
          this.comms.notifyHandlersOfCurrentPeers()
          await this.vrmPeerSync.onSceneConnected()
          await this.petPeerSync.onSceneConnected()
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
        void this.petManager.restoreFromInventory(address)
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

    // ONE platform prep: settle graph → entity-local cook → ready. No integrity ladder.
    await this.prepareCollidersForPlay(scene, onProgress)

    // Hold avatar + CCT out of the scene until authored colliders solidly under spawn.
    const provenFeet = await this.waitForSpawnFloorReady(scene.spawn, onProgress)

    onProgress?.('Loading avatar…')
    this.player.setAssetCache(this.assets, scene.realm.contentUrl)
    await this.player.loadAvatar(onProgress)
    this.bindAvatarAttachTargets()
    // Avatar load can take seconds — slide poses only (no full-scene recook).
    await this.sceneScript.yieldForWorkerMessages()
    await this.sceneScript.syncRendererFull()
    this.sceneScript.flushSceneGraphMatrices()
    this.sceneScript.refreshAllInstancedTransforms()
    this.pushAllColliderPosesToPhysX()
    // After seal: only cook truly missing actors (never force-recook — kills plaza SQ).
    await this.ensurePrimaryColliderIntegrity('post-avatar', 48, { postSeal: true })
    this.physics.warmStaticScene()
    await this.player.initCapsule(
      scene.spawn,
      walkBounds,
      this.sceneScript.readComponents,
      onProgress,
      provenFeet
    )
    // Commit SQ after capsule exists so CCT and sweeps share a live tree.
    this.physics.commitStaticSceneQueryAfterCapsule()
    // Missing-only integrity — no geom force-recook thrash.
    await this.ensurePrimaryColliderIntegrity('pre-walk', 24, { postSeal: true })
    this.physics.warmStaticScene()
    // Platform gate open — solids prepared before free walk.
    this.collidersReady = true
    this.player.setCollidersReady(true)
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
    // Clear auth banner for fishing / SignedFetch debugging (filter console for "[auth]").
    {
      const addr = this.session.getAddress()
      const id = this.session.getAuthIdentity()
      const prof = this.session.getProfile()
      const ctx = this.signedFetchSceneContext
      // warn so it survives "default levels" / React DevTools noise — not an error.
      console.warn(
        `[auth] play-ready address=${addr ? addr.slice(0, 12) + '…' : 'NONE'} ` +
          `identity=${id ? 'yes' : 'NO'} guest=${this.loginIsGuest} ` +
          `displayName=${prof?.displayName ?? 'null'} ` +
          `hasConnectedWeb3=${!!addr && !this.loginIsGuest} ` +
          `signedFetchCtx=${ctx?.sceneId ? `yes parcel=${ctx.parcel} realm=${ctx.realmName}` : 'NO'}`
      )
      if (!id) {
        console.warn(
          '[auth] No AuthIdentity — scene SignedFetch will be unsigned; fishing Colyseus auth will fail'
        )
      } else {
        console.warn(
          '[auth] Wallet OK — look for [SignedFetch] start/ok on /auth-token and matchmake; ' +
            'gatekeeper scene-admin 401 is separate (not fishing).'
        )
      }
      // Admin Tools smart-item: wallet ∈ gatekeeper scene-admin (not Places ownerAddresses).
      this.runAdminToolsDiagnostics('play-ready')
    }
    if (worldFeet) {
      this.physics.logStaticCollidersNear(worldFeet.x, worldFeet.y, worldFeet.z, 16)
      // Follow /goto: island peers may have joined before capsule existed.
      // Re-affirm spawn provisional + local feet; real poses still come from RFC4 Movement.
      this.remoteAvatars?.setProvisionalSpawnPosition(this.seedPosesFromSpawn(scene.spawn).feetThree)
      this.remoteAvatars?.setCameraPosition(worldFeet)
      this.remoteAvatars?.backfillProvisionalPeers()
      this.comms.notifyHandlersOfCurrentPeers()
    }
    this.logBootColliderDiag()
    this.sceneScript.syncClientEntities(this.player.getEntityPose(), this.player.getCameraEntityPose())
    this.physics.invalidateControllerCache()
    this.sceneScript.flushSceneGraphMatrices()
    // One more instance rewrite at spawn — catch late parent transforms.
    this.sceneScript.refreshAllInstancedTransforms()
    this.pushAllColliderPosesToPhysX()
    this.physics.warmStaticScene()
    this.sceneScript.preparePointerRaycast()
    this.sceneScript.refreshPointerTargets()
    // After capsule exists — re-equip + re-announce so late peers see guest VRM / pets.
    if (address) {
      void this.reannounceDavAndPets(address, 'post-spawn')
    }
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
    // Phase A — primary is a layer
    this.multiScene?.registerPrimary(this.sceneScript)
    // AOI warm/live/visuals only after primary is play-ready — dual-boot kills CBD.
    // Honor ?noaoi so neighbors never start.
    if (!skipAoiNeighbors()) {
      this.aoiVisual.setNeighborActivityEnabled(true)
      this.scenePromote.setNeighborActivityEnabled(true)
      this.multiScene?.setSecondaryActivityEnabled(true)
    }
    if (!skipRemoteAvatars()) {
      this.remoteAvatars?.setPlayReady(plazaScale)
    }
    this.player.setOnUserGestureUnlock(() => {
      // Real pointer/key gesture — unmute scene video + re-issue play().
      this.sceneScript.setVideoUserGestureUnlocked(true, { allowSound: true })
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

    this.avatarAttachResolver = resolver
    this.sceneScript.setAvatarAttachTargets(resolver)
    this.bindFollowFlagCct()
  }

  /**
   * Bind session-scoped tour flag manager (AppController). Re-bound on each World
   * so the prop tracks the leader CCT / peer root across /goto rebuilds.
   */
  setFollowFlagManager(
    manager: import('../social/FollowFlagManager').FollowFlagManager | null
  ): void {
    this.followFlagManager?.unbindScene()
    this.followFlagManager = manager
    this.bindFollowFlagCct()
  }

  /** Tour Focus frame hook — runs after remote avatar pose so leader feet are current. */
  setTourFocusTick(tick: ((delta: number) => void) | null): void {
    this.tourFocusTick = tick
  }

  /** Pets panel enable/disable / settings save — restore active pet + re-announce DPET. */
  async onActivePetInventoryChange(): Promise<void> {
    const address = this.session.getAddress() ?? null
    this.petManager.setLocalWallet(address)
    this.petPeerSync.setLocalAddress(address)
    // Live settings tweak (clip map / yaw / category) without full GLB reload when possible.
    const entry = getActivePetEntry(address)
    const current = this.petManager.getLocalSpec()
    if (entry && current?.contentHash === entry.contentHash) {
      this.petManager.setLocalAnimClipMap(entry.animClipMap)
      this.petManager.setLocalMeshYawOffsetDeg(entry.meshYawOffsetDeg ?? 0)
      if (entry.category !== current.category) {
        await this.petManager.setLocalCategory(entry.category)
      }
      return
    }
    await this.petManager.restoreFromInventory(address)
  }

  /** Settings-panel animation track preview. */
  playPetClipPreview(contentHash: string, clipName: string): Promise<boolean> {
    return this.petManager.playClipPreview(contentHash, clipName)
  }

  stopPetClipPreview(): void {
    this.petManager.stopClipPreview()
  }

  private bindPetContextMenu(): void {
    if (this.petContextMenuBound) return
    const canvas = this.host.renderer.domElement
    canvas.addEventListener('contextmenu', this.onCanvasPetContextMenu)
    this.petContextMenuBound = true
    if (!this.petContextMenu) {
      this.petContextMenu = new PetContextMenu({
        onAction: (action, target) => {
          if (action === 'disable' && target.kind === 'local') {
            void this.petManager.disableLocal()
          } else if (action === 'view-owner' && target.kind === 'remote') {
            window.dispatchEvent(
              new CustomEvent('dcl-open-profile', { detail: { address: target.ownerAddress } })
            )
          } else if (action === 'view-info') {
            const msg =
              target.kind === 'local'
                ? `Your pet · ${target.name} · ${target.category}`
                : `Pet · ${target.name} · ${target.category} · owner ${target.ownerAddress.slice(0, 10)}…`
            console.info('[pets]', msg)
            clientDebugLog.log('pets', msg, { level: 'info' })
          } else if (action === 'report') {
            console.info('[pets] report — coming soon')
          }
        }
      })
    }
  }

  private unbindPetContextMenu(): void {
    if (!this.petContextMenuBound) return
    this.host.renderer.domElement.removeEventListener('contextmenu', this.onCanvasPetContextMenu)
    this.petContextMenuBound = false
  }

  private handlePetContextMenu(ev: MouseEvent): void {
    if (!this.playerMode || !this.player) return
    const canvas = this.host.renderer.domElement
    const hit = this.petManager.pickAtPointer(ev.clientX, ev.clientY, this.host.camera, canvas)
    if (!hit) return
    ev.preventDefault()
    ev.stopPropagation()
    const localSpec = this.petManager.getLocalSpec()
    if (hit.kind === 'local' && localSpec) {
      this.petContextMenu?.show(
        {
          kind: 'local',
          name: localSpec.nickname || localSpec.fileName || 'Pet',
          category: localSpec.category,
          hash: localSpec.contentHash
        },
        ev.clientX,
        ev.clientY
      )
      return
    }
    if (hit.kind === 'remote' && hit.address) {
      const hash = this.petPeerSync.getPeerEquippedHash(hit.address) ?? ''
      const category = this.petPeerSync.getPeerCategory(hit.address) ?? 'walking'
      this.petContextMenu?.show(
        {
          kind: 'remote',
          name: 'Pet',
          category,
          hash,
          ownerAddress: hit.address
        },
        ev.clientX,
        ev.clientY
      )
    }
  }

  private bindFollowFlagCct(): void {
    if (!this.followFlagManager) return
    this.followFlagManager.bind(this.host.scene, {
      getLocalWallet: () =>
        this.avatarAttachResolver?.getLocalWallet() ??
        this.session.getAddress()?.toLowerCase() ??
        null,
      getLocalCctRoot: () => this.player?.getPlayerFeetRoot() ?? null,
      getLocalYaw: () => (this.player ? this.player.getNetworkYaw() : null),
      getRemoteCctRoot: (address) => this.remoteAvatars?.getPeerRoot(address) ?? null,
      getRemoteYaw: (address) => this.remoteAvatars?.getPeerYaw(address) ?? null,
      getLocalNameTagWorldY: () => {
        const anchor = this.player?.getLocalAvatar()?.nameTagAnchor
        if (!anchor) return null
        anchor.updateWorldMatrix(true, false)
        const y = anchor.getWorldPosition(new THREE.Vector3()).y
        return Number.isFinite(y) ? y : null
      },
      getRemoteNameTagWorldY: (address) =>
        this.remoteAvatars?.getPeerNameTagWorldY(address) ?? null,
      getCamera: () => this.host.camera
    })
  }

  /**
   * Tour Locations “Add photo”: open Camera Reel in tour mode.
   * Caller should hide the tour modal; onExit(false) when Esc/cancel without a shot.
   */
  beginTourLocationPhotoCapture(opts: {
    onCapture: (
      result: import('../photo/photoCapture').PhotoCaptureResult
    ) => void | Promise<void>
    onExit: (captured: boolean) => void
  }): void {
    if (!this.playerMode || !this.player) {
      opts.onExit(false)
      return
    }
    if (this.isAnyVirtualCameraActive()) {
      opts.onExit(false)
      return
    }
    this.ensurePhotoCamera()
    this.photoCamera?.beginTourLocationCapture(opts)
  }

  isTourLocationPhotoCapture(): boolean {
    return this.photoCamera?.isTourLocationCapture() === true
  }

  /** Block until scene GLBs/textures hydrate — call after `loadScene`, before `start()`. */
  waitForSceneAssets(
    scene: ResolvedScene,
    onProgress?: (msg: string, fraction?: number) => void,
    options?: WaitForSceneAssetsOptions
  ) {
    // Before CCT exists, spawn feet are the best local-player reference for load radius.
    const spawnFeet = new THREE.Vector3(scene.spawn.x, scene.spawn.y, scene.spawn.z)
    if (!skipRemoteAvatars()) {
      this.remoteAvatars?.setLocalPlayerPosition(spawnFeet)
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
    // Optimistic play unlock only — stay muted so browser autoplay policy allows
    // frames. Sound unlocks on the first real pointer/key gesture.
    this.sceneScript.setVideoUserGestureUnlocked(true, { allowSound: false })
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
          // Avatar load/LOD/tags use player feet — freecam/orbit must not change distances.
          this.remoteAvatars?.setLocalPlayerPosition(
            this.player?.getWorldPosition() ?? this.host.camera.position
          )
          // Frustum anim skip uses the active view camera (player or freecam).
          this.remoteAvatars?.setViewCamera(this.host.camera)
        }
        if (!this.editorPreviewMode) {
          this.environment.update(delta, this.sceneScript.view, this.sceneScript.readComponents)
          this.syncOutdoorLighting()
        }

        if (this.playerMode && this.player) {
          // Multi-scene secondary boots flip global content map — reassert primary every frame
          // so primary asset resolve never sticks on a neighbor's manifest mid-walk.
          if (this.loadedPrimaryScene) {
            this.assets.setScene(this.loadedPrimaryScene)
          }
          // COD PX claim order: layers tick → merge claims → PlayerHost (capsule/lens).
          const platformT0 = performance.now()
          this.syncPlayerMotionFrame(delta, startFrame)
          const platformMs = performance.now() - platformT0
          // Prior-frame poses for worker reserved inject (players move after claims below).
          let playerPose = this.player.getEntityPose()
          let cameraPose = this.player.getCameraEntityPose()
          // Keyboard bus first — PX/primary onUpdate this frame sees isPressed for drone WASD.
          this.inputHub.sync(startFrame)
          this.sceneScript.syncClientEntities(playerPose, cameraPose)
          this.sceneScript.updateTriggerAreas()
          this.sceneScript.tickPlayFrame()
          this.multiScene?.tickSync(playerPose, cameraPose, startFrame)
          this.pumpPeMotionBridges(delta, startFrame)
          this.pumpSecondaryMotionBridges(delta, startFrame)
          // Phase B: continuous claims (locomotion / camera / poseDrive / force) before capsule.
          this.applyLayerPlayerClaims()
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
          playerPose = this.player.getEntityPose()
          cameraPose = this.player.getCameraEntityPose()

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
          // Keep scene asset pressure on the load queue after play-ready so remote composes
          // don't fight late GLB attach / collider pose resync (walk-through under remotes).
          const assetStats = this.assets.getLoadStats()
          this.remoteAvatars?.setSceneAssetPressure(
            assetStats.gltfInflight,
            assetStats.textureInflight
          )
          this.vrmPeerSync.gcStaleFetches()
          this.petPeerSync.gcStaleFetches()
          // Always tick remote pose (skipping frames made peers look choppy).
          // LOD inside RemoteAvatarManager already throttles far anim work.
          const remoteTick = this.remoteAvatars?.update(delta)
          if (this.remoteAvatars) {
            perfSetRemoteStats({
              visible: this.remoteAvatars.visiblePeerCount,
              loaded: this.remoteAvatars.loadedPeerCount,
              composePending: this.remoteAvatars.composeQueueDepth,
              composeActive: this.remoteAvatars.activeComposeCount,
              poseSkipped: remoteTick?.poseSkipped ?? 0,
              animSkipped: remoteTick?.animSkipped ?? 0,
              nameTagsShown: remoteTick?.nameTagsShown ?? 0,
              remoteUpdateMs: remoteTick?.remoteUpdateMs ?? 0,
              remoteAnimMs: remoteTick?.remoteAnimMs ?? 0,
              lodNear: remoteTick?.lodNear ?? 0,
              lodMid: remoteTick?.lodMid ?? 0,
              lodFar: remoteTick?.lodFar ?? 0
            })
          }
        }
        // Local pet leash (owner feet Y + category height) then remote pet lerp.
        if (this.player) {
          const feet = this.player.getWorldPosition()
          // Real owner speed — pets were hardcoded to 0 so they never left idle
          // while walking with you (and remotes only ever saw idle pose.anim).
          this.petManager.updateLocal(
            delta,
            feet,
            this.player.getPlayerYaw(),
            this.player.getHorizontalSpeed()
          )
          this.petManager.updateRemotes(delta, feet)
        }
        // Tour flag: spine attach for local or remote leader (after avatar pose ticks).
        this.followFlagManager?.update(delta)
        // Debug crowd idle anim (Help → Avatar crowd).
        this.debugAvatarCrowd?.update(delta)
        // Tour Focus: leader freecam publish + follower lens apply (needs remote pose).
        this.tourFocusTick?.(delta)
        // Spatial voice reparents as peer poses land (cheap map walk).
        this.voice.tickSpatial()
        this.comms.flushBroadcast()

        // Tweens / billboards / GLTF animators — player path runs in syncPlayerMotionFrame first.
        if (!this.editorPreviewMode && (!this.playerMode || !this.player)) {
          this.sceneScript.pumpMotionBridges(delta, startFrame)
        }
        if (this.playerMode && this.player) {
          this.sceneScript.preparePointerRaycast(startFrame)
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
        this.refreshAnimatorSampleHud(delta)
      },
      onAsyncFrame: async (_delta) => {
        if (this.editorPreviewMode) return

        const t0 = performance.now()
        await this.sceneScript.syncRenderer()
        const rendererMs = performance.now() - t0

        // Async pointer prepare only when dirty — full flush already ran on sync if needed.
        if (this.playerMode && this.player) {
          this.sceneScript.preparePointerRaycast(startFrame)
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
        // Animator.sync is async-only — PART kinematic pose same frame open/close applies.
        if (this.playerMode && this.player && this.collidersLoadingComplete && !this.deferPhysxCooks) {
          this.sceneScript.snapshotPhysMotionSets()
          const part = this.sceneScript.refreshAnimatorColliderPosesNow()
          if (part.size > 0) this.pushColliderPartPoses(part)
        }
        const bridgesOnlyMs = performance.now() - t2
        // PE + secondary async projection + multi-scene colliders into PhysX.
        const t3 = performance.now()
        let multiMs = 0
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
          multiMs = performance.now() - t3
        }
        const totalMs = performance.now() - t0
        // Diagnose multi-second async frames (was ~3300ms = cold GLB parse await / 3k pending walk).
        // bridges = primary Animator/Avatar/Particle only; multi = PE+secondary async + cook.
        if (totalMs > 100) {
          // Lite counters only — full getHydrationStats walks every GltfContainer (was 3k+).
          const lite = this.sceneScript.getAttachProgressLite()
          clientDebugLog.consoleOnly(
            'warn',
            `[fps] async breakdown ${totalMs.toFixed(0)}ms — renderer=${rendererMs.toFixed(0)} ` +
              `collision=${collisionMs.toFixed(0)} bridges=${bridgesOnlyMs.toFixed(0)} multi=${multiMs.toFixed(0)} ` +
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

    // 1) Transform writers (CRDT) already applied. 2) Tween/Billboard/Animator.
    this.sceneScript.pumpMotionBridges(delta, startFrame)
    this.refreshAnimatorSampleHud(delta)
    if (this.sceneScript.hasColliderWorkPending()) {
      this.sceneScript.syncCollision()
    }

    // Two PhysX sources only (docs/COLLIDER_MOTION_POLICY.md): Transform dirty | Animator part.
    const physReady = this.collidersLoadingComplete && !this.deferPhysxCooks
    const { transformDirty, animatorPart } = physReady
      ? this.sceneScript.snapshotPhysMotionSets()
      : { transformDirty: new Set<Entity>(), animatorPart: new Set<Entity>() }

    if (transformDirty.size > 0) {
      this.pushColliderRootPoses(transformDirty)
    }
    if (animatorPart.size > 0) {
      this.sceneScript.refreshColliderDescPoses([...animatorPart], animatorPart)
      this.pushColliderPartPoses(animatorPart)
    }

    let meshMotion: Entity[] = []
    if (physReady && needsPlatformPipeline && feet) {
      const groundEcs = groundEcsEarly
      const frameMotion = this.sceneScript.consumeFrameMotionEntities()
      meshMotion = this.sceneScript.recordWalkSurfaceDeltasForEntities(
        frameMotion,
        animatorPart,
        feet,
        standPhysEntity
      )
      if (this.sceneScript.hasColliderWorkPending()) {
        this.sceneScript.syncCollision()
      }
      const poseSync = this.sceneScript.collectPhysXPoseSyncEntities(meshMotion, animatorPart)
      const platformEntities = new Set<Entity>(poseSync)
      for (const e of transformDirty) platformEntities.add(e)
      if (groundEcs !== null) platformEntities.add(groundEcs)

      let platformDescs: ReturnType<SceneScriptSystem['getPhysicsColliderDescsForEntities']> | null =
        null
      const ensurePlatformDescs = (): NonNullable<typeof platformDescs> => {
        if (!platformDescs) {
          platformDescs = this.sceneScript.getPhysicsColliderDescsForEntities([...platformEntities])
        }
        return platformDescs
      }

      const groundIsMoving =
        groundEcs !== null &&
        (meshMotion.includes(groundEcs) ||
          animatorPart.has(groundEcs) ||
          transformDirty.has(groundEcs))
      const standScoped = standPhysEntity !== null && standPhysEntity !== -1

      if (groundIsMoving || animatorPart.size > 0 || transformDirty.size > 0) {
        const descs = ensurePlatformDescs()
        if (!onSceneGround || animatorPart.size > 0 || transformDirty.size > 0) {
          this.physics.snapshotActorRootPoses(descs)
        }
        if (animatorPart.size > 0 && standScoped) {
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
      if (
        feet &&
        groundEcs !== null &&
        (groundIsMoving || animatorPart.has(groundEcs) || transformDirty.has(groundEcs))
      ) {
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


  private applyPhysicsColliders(): void {
    if (!this.playerMode || !this.collidersLoadingComplete || this.deferPhysxCooks) return
    const colliderWork = this.sceneScript.hasColliderWorkPending()

    if (colliderWork) {
      this.sceneScript.syncCollision()
      const poseChanged = this.sceneScript.getLastPoseChangedEntities()
      if (poseChanged.length) {
        this.applyColliderPoseSlides([...poseChanged])
      }
    }

    // Missing PhysX actors only (late attaches) — no full-scene thrash.
    this.maybeDiscoverMissingColliderActors()

    if (colliderWork || this.colliderCookQueue.size > 0) {
      this.reconcileColliderCookQueue()
    }
    if (this.colliderCookQueue.size > 0) {
      void this.scheduleColliderCookDrain()
    }

    // Fast SQ soft watchdog — sweep only (no O(static) membership scan every 500ms).
    // Full diagnoseSceneQueryAt walks ~3k+ WASM actors and was a continuous walk tax.
    if (this.spawnColliderSealComplete && this.collidersReady) {
      const nowWatch = performance.now()
      if (nowWatch - this.lastSqSoftWatchMs > 1500) {
        this.lastSqSoftWatchMs = nowWatch
        const feetW = this.player?.getWorldPosition()
        if (feetW) {
          const probe = this.physics.probeWalkSurfaceFeetY(
            feetW.x,
            feetW.z,
            feetW.y + 2.5,
            6,
            feetW.y
          )
          // Heal only when SQ truly misses (probe null), not when CCT stands on infinite ground.
          if (probe == null) {
            this.physics.tryHealPostSealSceneQuery(feetW.x, feetW.y, feetW.z)
          }
        }
      }
    }

    // Health log: static count drop or rare summary — NOT O(n) soft diagnostics every 8s
    // while standing on infinite ground (expected on Genesis roads / empty land).
    const now = performance.now()
    const staticN = this.physics.staticColliderCount
    const staticDropped =
      this.lastLoggedStaticCount >= 0 && staticN < this.lastLoggedStaticCount - 5
    if (staticDropped || now - this.lastColliderHealthLogMs > 30_000) {
      this.lastColliderHealthLogMs = now
      const descs = this.sceneScript.getAllPhysicsColliderDescs()
      const extracted = descs.length
      let missing = 0
      for (const d of descs) {
        if (this.physics.isAoiRoadColliderEntity(d.entity)) continue
        if (this.physics.isAoiEmptyLandColliderEntity(d.entity)) continue
        if (!this.physics.hasStaticActor(d.entity)) missing++
      }
      const ground = this.physics.getLastGroundPhysEntity()
      const feet = this.player?.getWorldPosition()
      const sides = this.physics.getLastCctHitSides()
      // Only log when something is wrong or count changed — skip spam on healthy infinite ground.
      if (missing > 0 || staticDropped || staticN !== this.lastLoggedStaticCount) {
        console.info(
          `[phys] health static=${staticN} extracted≈${extracted} missing≈${missing} ` +
            `queue=${this.colliderCookQueue.size} seal=${this.spawnColliderSealComplete} ` +
            `groundPhys=${ground ?? 'none'} sides=${sides ? 'yes' : 'no'} feet=${
              feet
                ? `(${feet.x.toFixed(1)},${feet.y.toFixed(2)},${feet.z.toFixed(1)})`
                : '?'
            }`
        )
      }
      // Soft recovery only when actors are missing or SQ truly fails — NOT when
      // groundPhys=-1 (infinite plane is normal on roads/empty Genesis parcels).
      if (feet && missing > 0) {
        const probe = this.physics.probeWalkSurfaceFeetY(feet.x, feet.z, feet.y + 2.5, 6, feet.y)
        if (probe == null) {
          this.physics.tryHealPostSealSceneQuery(feet.x, feet.y, feet.z)
        }
        this.discoverMissingColliderActors()
      }
      this.lastLoggedStaticCount = staticN
    }
  }

  /**
   * Live-matrix collider extract in rAF chunks (plaza: 475+ GLTFs).
   *
   * COD (docs/STATIC_COLLIDER_COD.md): dirty-all / invalidate-all only on the
   * **authoritative boot extract**. Catch-up passes drain pending dirties only —
   * never re-walk every GLB + wipe the sync cache (that was the ~79% hitch).
   */
  private async extractCollidersChunked(
    onProgress?: (msg: string) => void,
    label = 'Extracting colliders',
    options?: { invalidateAll?: boolean; markAllDirty?: boolean; maxPasses?: number }
  ): Promise<void> {
    this.sceneScript.flushSceneGraphMatrices()
    this.sceneScript.refreshAllInstancedTransforms()
    const invalidateAll = options?.invalidateAll === true
    const markAllDirty = options?.markAllDirty === true
    const maxPasses = options?.maxPasses ?? 64
    // Drop mid-hydration extracts only when explicitly rebuilding the extract set.
    if (invalidateAll) {
      this.sceneScript.invalidateGltfColliderSyncCache()
    }
    if (markAllDirty) {
      this.sceneScript.markAllGltfCollidersDirtyForExtract()
    }
    for (let i = 0; i < maxPasses; i++) {
      if (!this.sceneScript.hasColliderWorkPending()) break
      this.sceneScript.syncCollision()
      onProgress?.(`${label}… ${i + 1}`)
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
    }
    // Authoritative boot only — force-walk remaining dirties once.
    if (markAllDirty && this.sceneScript.hasColliderWorkPending()) {
      this.sceneScript.syncCollisionForce()
    }
    this.refreshColliderCookStats()
  }

  /**
   * Single platform prep before floor probe / capsule / walk.
   * COD: settle → extract once → cook missing → integrity → seal (freeze thrash, no SQ rebuild).
   * See docs/STATIC_COLLIDER_COD.md.
   */
  private async prepareCollidersForPlay(
    scene: ResolvedScene,
    onProgress?: (msg: string) => void
  ): Promise<void> {
    if (!this.playerMode) return
    const started = performance.now()
    dclToThreeVec(
      new THREE.Vector3(scene.spawn.x, scene.spawn.y, scene.spawn.z),
      this.colliderCookPriority
    )

    onProgress?.('Preparing collisions…')
    // Wait for GLB graph BEFORE cook (pendingMesh→0). Early 4s soft-exit was sealing incomplete plaza.
    await this.waitForColliderGraphSettle(onProgress)

    this.sceneScript.setSceneWorkerTicksPaused(true)
    try {
      await this.sceneScript.yieldForWorkerMessages()
      await this.sceneScript.syncRendererFull()
      // Authoritative live extract once (dirty-all). Settle already progressive-extracted;
      // this pass freezes final matrixWorld into collider descs.
      await this.extractCollidersChunked(onProgress, 'Extracting colliders', {
        invalidateAll: true,
        markAllDirty: true
      })

      // Cook missing/unsynced only. Do NOT clearGeometryCookCache / clearGltfStaticActors
      // — wiping plaza actors then recooking from partial extract was the soft-init death spiral.
      this.deferPhysxCooks = false
      this.physics.clearFailedCookCaches()
      this.colliderCookQueue.clear()
      this.reconcileColliderCookQueue()
      // Ensure every extracted desc is in the queue if not live+synced.
      this.discoverMissingColliderActors()

      const assetsTimedOut = this.bootAssetsTimedOut
      const maxWallMs = assetsTimedOut
        ? World.LOADING_COLLIDER_WALL_TIMED_OUT_MS
        : World.LOADING_COLLIDER_WALL_MS
      const cookStarted = performance.now()

      while (this.colliderCookQueue.size > 0) {
        if (performance.now() - cookStarted > maxWallMs) {
          const pending = this.colliderCookQueue.size
          const registered = this.physics.gltfStaticActorCount
          const extracted = this.lastGltfColliderCount
          if (assetsTimedOut && registered > 0) {
            console.warn(
              `[phys] prepare timed out — gltf=${registered}/${extracted} pending=${pending}`
            )
            break
          }
          throw new Error(
            `[phys] prepare incomplete after ${(maxWallMs / 1000).toFixed(0)}s — ` +
              `gltf=${registered}/${extracted} pending=${pending}`
          )
        }
        if (this.sceneScript.hasColliderWorkPending()) {
          this.sceneScript.syncCollision()
          this.reconcileColliderCookQueue()
          this.discoverMissingColliderActors()
        }
        await this.drainColliderCookQueue({ mode: 'boot' })
        const gltfCount = this.lastGltfColliderCount
        const registered = this.physics.gltfStaticActorCount
        const pending = this.colliderCookQueue.size
        onProgress?.(
          `Cooking collisions… ${registered}/${gltfCount}` +
            (pending > 0 ? ` (${pending} left)` : '')
        )
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
      }

      // COD: mid-cook late attaches — progressive pending only (no invalidate-all / markAll).
      await this.sceneScript.syncRendererFull()
      this.sceneScript.flushSceneGraphMatrices()
      this.sceneScript.refreshAllInstancedTransforms()
      if (this.sceneScript.hasColliderWorkPending()) {
        await this.extractCollidersChunked(onProgress, 'Late collider attaches', {
          invalidateAll: false,
          markAllDirty: false,
          maxPasses: 16
        })
      }
      this.reconcileColliderCookQueue()
      this.discoverMissingColliderActors()
      let guard = 0
      while (this.colliderCookQueue.size > 0 && guard < 256) {
        await this.drainColliderCookQueue({ mode: 'boot' })
        guard++
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
      }

      this.recookAnimatedGltfEntityLocal()
      this.pushAllColliderPosesToPhysX()
      // Never zero-dt simulate after plaza cook — that softs CCT while bounds still look solid.
      this.physics.setAllowZeroDtWarmSim(false)

      // Integrity before SQ seal (Genesis soft load).
      await this.ensurePrimaryColliderIntegrity('prepare-seal', 96)

      this.pushAllColliderPosesToPhysX()
      // COD seal owns: reinsertAll once + forceDynamicTreeRebuild once + freeze thrash.
      // Without that commit: static=1100 maps ok, sweepFeetY=MISS (plaza walk-through).
      this.physics.warmStaticScene()
      this.physics.sealStaticSceneQuery()

      this.collidersLoadingComplete = true
      this.spawnColliderSealComplete = true
      this.lastPhysicsBatchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()

      const staticN = this.physics.staticColliderCount
      const gltfN = this.physics.gltfStaticActorCount
      const extracted = this.lastGltfColliderCount
      const elapsed = ((performance.now() - started) / 1000).toFixed(1)
      console.info(
        `[phys] colliders ready — static=${staticN} gltf=${gltfN}/${extracted} ` +
          `pending=${this.colliderCookQueue.size} sealedSQ=true (${elapsed}s)`
      )
      this.physics.logStaticCollidersNear(
        this.colliderCookPriority.x,
        this.colliderCookPriority.y,
        this.colliderCookPriority.z,
        20,
        'pre-play-spawn'
      )
      // Must not be MISS after seal — if MISS, SQ commit failed (P0).
      const diag = this.physics.diagnoseSceneQueryAt(
        this.colliderCookPriority.x,
        this.colliderCookPriority.y,
        this.colliderCookPriority.z,
        'pre-play'
      )
      const probe = this.physics.probeWalkSurfaceFeetY(
        this.colliderCookPriority.x,
        this.colliderCookPriority.z,
        this.colliderCookPriority.y + 2.5,
        8,
        this.colliderCookPriority.y
      )
      console.info(
        `[phys] pre-play sweepFeetY=${probe != null ? probe.toFixed(2) : 'MISS'} ` +
          `rawDidHit=${diag.didHit} inScene=${diag.inScene}/${diag.map} ` +
          `(MISS = P0 SQ bug — check seal probe= line)`
      )
      onProgress?.('Collisions ready')
    } finally {
      this.sceneScript.setSceneWorkerTicksPaused(false)
      this.sceneScript.setAssetHydrationMode(false)
    }
  }

  /**
   * Count primary descs without PhysX actors and boot-cook them. Logs mismatch so
   * "walls in bounds but ghost walk" is diagnosable. Skips AOI road / empty-land bands.
   */
  private async ensurePrimaryColliderIntegrity(
    label: string,
    maxPasses: number,
    options?: { postSeal?: boolean }
  ): Promise<{ missing: number; registered: number; extracted: number }> {
    const postSeal = options?.postSeal === true || this.spawnColliderSealComplete
    this.sceneScript.flushSceneGraphMatrices()
    this.sceneScript.refreshAllInstancedTransforms()
    this.discoverMissingColliderActors()
    // Pre-seal: re-cook geom-mismatched actors (scale settle).
    // Post-seal: missing actors only — force-recook replaceStatic thrash softs plaza SQ.
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (this.physics.isAoiRoadColliderEntity(desc.entity)) continue
      if (this.physics.isAoiEmptyLandColliderEntity(desc.entity)) continue
      if (!this.physics.hasStaticActor(desc.entity)) {
        this.colliderCookQueue.add(desc.entity)
        continue
      }
      if (!postSeal && !this.physics.geomFingerprintMatches(desc)) {
        this.colliderCookQueue.add(desc.entity)
      }
    }
    let guard = 0
    const drainMode = postSeal ? 'play' : 'boot'
    while (this.colliderCookQueue.size > 0 && guard < maxPasses) {
      await this.drainColliderCookQueue({ mode: drainMode })
      guard++
    }
    this.pushAllColliderPosesToPhysX()
    this.physics.refreshStaticAfterRuntimeGeometryChange()

    let missing = 0
    let geomMismatch = 0
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (this.physics.isAoiRoadColliderEntity(desc.entity)) continue
      if (this.physics.isAoiEmptyLandColliderEntity(desc.entity)) continue
      if (!this.physics.hasStaticActor(desc.entity)) {
        missing++
        continue
      }
      if (!this.physics.geomFingerprintMatches(desc)) geomMismatch++
    }
    const registered = this.physics.gltfStaticActorCount
    const extracted = this.lastGltfColliderCount
    const bad =
      missing > 8 || geomMismatch > 8 || (extracted > 50 && registered < extracted * 0.5)
    const msg =
      `[phys] integrity ${label} — gltf=${registered}/${extracted} missing=${missing} ` +
      `geomMismatch=${geomMismatch} pending=${this.colliderCookQueue.size} ` +
      `static=${this.physics.staticColliderCount}`
    clientDebugLog.log('collision', msg, {
      level: bad ? 'warn' : 'success',
      alsoConsole: true
    })
    return { missing, registered, extracted }
  }

  /**
   * Play-time: queue extracts that never got a PhysX actor (late structure attach).
   * Does NOT rescan pose-unsynced full scene (that was the thrash / soft-after-load path).
   */
  private maybeDiscoverMissingColliderActors(): void {
    if (!this.collidersLoadingComplete || this.deferPhysxCooks) return
    const now = performance.now()
    if (now - this.lastNeverCookedScanMs < World.NEVER_COOKED_SCAN_MS) return
    this.lastNeverCookedScanMs = now
    this.discoverMissingColliderActors()
  }

  /**
   * Enqueue PhysX actors that are truly absent.
   * Pose / scale drift is NOT "missing" — that used isColliderSynced (exact pose fp) and
   * permanently re-queued 2 plaza entities every 2s → replaceStatic thrash → solids vanish.
   * Pose = slide; scale geom mismatch = bounded recook via {@link enqueueScaleDriftRecooks}.
   */
  private discoverMissingColliderActors(): void {
    let added = 0
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (this.physics.isAoiRoadColliderEntity(desc.entity)) continue
      if (this.physics.isAoiEmptyLandColliderEntity(desc.entity)) continue
      if (this.physics.hasStaticActor(desc.entity)) continue
      // Permanent cook failure — re-queueing every 2s only thrashes and softs neighbors.
      if (this.physics.hasFailedCookFingerprint(desc.fingerprint)) continue
      if (!this.colliderCookQueue.has(desc.entity)) added++
      this.colliderCookQueue.add(desc.entity)
    }
    this.enqueueScaleDriftRecooks()
    this.pendingColliderCooks = this.colliderCookQueue.size
    if (added > 0) {
      clientDebugLog.log(
        'collision',
        `Missing actors — +${added} (queue=${this.colliderCookQueue.size} static=${this.physics.staticColliderCount})`,
        { level: 'info', throttleMs: 3_000 }
      )
      this.maybeBeginRuntimeColliderBurst(this.colliderCookQueue.size - added)
    }
  }

  /**
   * Scale-drift geom recook at most once per entity per cooldown (COD allowed exception).
   * Only when geom fingerprint no longer matches a live actor — never pose-only, never tree rebuild.
   */
  private readonly scaleDriftRecookAt = new Map<number, number>()
  private static readonly SCALE_DRIFT_RECOOK_COOLDOWN_MS = 8_000

  private enqueueScaleDriftRecooks(): void {
    if (!this.collidersLoadingComplete) return
    const now = performance.now()
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (!desc.shapes?.length) continue
      if (this.physics.isAoiRoadColliderEntity(desc.entity)) continue
      if (this.physics.isAoiEmptyLandColliderEntity(desc.entity)) continue
      if (!this.physics.hasStaticActor(desc.entity)) continue
      // Geom fingerprint cleared by scale gate — needs recook, not pose-only.
      if (this.physics.geomFingerprintMatches(desc)) continue
      const last = this.scaleDriftRecookAt.get(desc.entity) ?? 0
      if (now - last < World.SCALE_DRIFT_RECOOK_COOLDOWN_MS) continue
      this.scaleDriftRecookAt.set(desc.entity, now)
      this.colliderCookQueue.add(desc.entity)
    }
  }

  /**
   * After RestrictedActions.movePlayerTo (SpaceRunner map↔lobby, Flagtag drown-respawn):
   * re-scan never-cooked extracts near the new feet and open a short cook burst so gravity
   * can land on real floors once the scene load freeze clears (no mid-air soft-hold).
   */
  private kickPostTeleportColliderCatchup(): void {
    if (!this.playerMode || !this.collidersLoadingComplete || this.deferPhysxCooks) return
    this.sceneScript.flushSceneGraphMatrices()
    // Force never-cooked scan even if the periodic throttle would skip — teleports are rare.
    this.lastNeverCookedScanMs = 0
    this.discoverMissingColliderActors()
    this.runtimeColliderBurstUntil = Math.max(
      this.runtimeColliderBurstUntil,
      performance.now() + World.RUNTIME_COLLIDER_BURST_MS
    )
    const near = this.countNearPlayerColliderQueue(40)
    if (near > 0 || this.colliderCookQueue.size > 0) {
      clientDebugLog.consoleOnly(
        'info',
        `[phys] post-teleport cook catch-up — queue=${this.colliderCookQueue.size} near40m=${near}`
      )
    }
  }

  /**
   * Block until GLB attach pressure is low enough that matrixWorld is trustworthy
   * for PhysX cooks. Genesis plaza used to soft-exit after 4s with hundreds of
   * pendingMesh still queued — then cook sealed incomplete solids (walk-through).
   * Prefer pendingMesh===0; soft-exit when attached/entities ≥ 0.97 and pending is
   * stable for 2s. Pool/disco may attach forever — also respect hard maxMs.
   */
  private async waitForColliderGraphSettle(
    onProgress?: (msg: string) => void,
    maxMs = 45_000
  ): Promise<void> {
    if (!this.playerMode) return
    const started = performance.now()
    let lastPending = -1
    let stableSince = 0
    const stableNeedMs = 600
    const softStableMs = 2_000
    onProgress?.('Waiting for scene colliders…')
    // Seed budgeted extract once — COD: one markAll at settle start; never full-walk every rAF.
    this.sceneScript.markAllGltfCollidersDirtyForExtract()
    while (performance.now() - started < maxMs) {
      await this.sceneScript.yieldForWorkerMessages()
      await this.sceneScript.syncRendererFull()
      this.sceneScript.flushSceneGraphMatrices()
      this.sceneScript.refreshAllInstancedTransforms()
      // Progressive budgeted extract only — never invalidate-all / force every settle frame
      // (that re-traversed 700+ GLBs each rAF and froze at 79%).
      if (this.sceneScript.hasColliderWorkPending()) {
        this.sceneScript.syncCollision()
      }
      const lite = this.sceneScript.getAttachProgressLite()
      const pending = lite?.pendingMesh ?? 0
      const attached = lite?.attached ?? 0
      const hydra = this.sceneScript.getHydrationStats()
      const entities = Math.max(1, hydra?.gltfEntities ?? attached + pending)
      const attachRatio = attached / entities
      const now = performance.now()
      if (pending === lastPending) {
        if (stableSince <= 0) stableSince = now
        const stableFor = now - stableSince
        // Ideal: nothing left to attach.
        if (pending === 0 && stableFor >= stableNeedMs) break
        // Soft: nearly complete attach + pending stuck (infinite pool tails).
        if (pending > 0 && attachRatio >= 0.97 && stableFor >= softStableMs) {
          console.warn(
            `[World] collider graph soft-settle — pendingMesh=${pending} ` +
              `attached=${attached}/${entities} (${(attachRatio * 100).toFixed(0)}%) ` +
              `after ${((now - started) / 1000).toFixed(1)}s`
          )
          break
        }
      } else {
        stableSince = 0
        lastPending = pending
      }
      onProgress?.(
        pending > 0
          ? `Waiting for scene colliders… ${attached}/${entities} attached, ${pending} left`
          : 'Waiting for scene colliders…'
      )
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
    }
    const lite = this.sceneScript.getAttachProgressLite()
    clientDebugLog.log(
      'collision',
      `[World] collider graph settle — pendingMesh=${lite?.pendingMesh ?? 0} ` +
        `attached=${lite?.attached ?? '?'} ` +
        `t=${((performance.now() - started) / 1000).toFixed(1)}s`,
      { level: 'info', alsoConsole: true }
    )
  }

  



  


  /** Single in-flight cook drain — never stack async drains from attach callbacks. */
  private async scheduleColliderCookDrain(): Promise<void> {
    if (this.colliderCookDrainInFlight) return
    this.colliderCookDrainInFlight = true
    try {
      if (this.colliderCookQueue.size === 0) return
      const burstActive = performance.now() < this.runtimeColliderBurstUntil
      let passes = 0
      const maxPasses = burstActive ? 4 : 2
      while (this.colliderCookQueue.size > 0 && passes < maxPasses) {
        await this.drainColliderCookQueue({ mode: 'play' })
        passes++
      }
      this.scheduleStaticGeometryWarm()
    } finally {
      this.colliderCookDrainInFlight = false
    }
  }

  /** @deprecated alias — waitForSpawnFloorReady still drains mid-probe. */
  private async drainPendingColliderCooksInitialOnly(): Promise<void> {
    if (this.colliderCookQueue.size === 0) return
    await this.drainColliderCookQueue({ mode: 'play' })
    this.scheduleStaticGeometryWarm()
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
    this.collidersReady = false
    this.player?.setCollidersReady(false)
    this.deferPhysxCooks = true
    this.spawnColliderSealComplete = false
    this.colliderCookQueue.clear()
    this.pendingColliderCooks = 0
    this.lastPhysicsBatchFp = ''
    this.lastNeverCookedScanMs = 0
    this.physics.setAllowZeroDtWarmSim(true)
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

  /**
   * Incremental pose push — entity-local actors.
   * Slide T+R always; queue hot-replace cook when scale/geom/partial still unsynced.
   */
  private applyColliderPoseSlidesForPhysIds(physIds: number[]): void {
    if (!this.playerMode || !physIds.length) return
    for (const physId of physIds) {
      if (this.physics.isAoiRoadColliderEntity(physId)) continue
      if (this.physics.isAoiEmptyLandColliderEntity(physId)) continue
      this.sceneScript.refreshColliderPose(physId)
    }
    const descs = this.collectColliderDescs(physIds)
    const slideDescs: PhysicsColliderDesc[] = []
    for (const desc of descs) {
      if (this.physics.isAoiRoadColliderEntity(desc.entity)) continue
      if (this.physics.isAoiEmptyLandColliderEntity(desc.entity)) continue
      if (
        this.physics.isWorldBakedStatic(desc.entity) ||
        this.physics.needsWorldBakedPoseRecook(desc)
      ) {
        // World-baked (landscape) cannot slide — recook when pose drifts.
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

  /**
   * Slide entity-root T+R for all multi-shape / primitive statics.
   * NEVER re-extract shape local matrices + relative-slide against cook baselines
   * (that double-transformed plaza solids → soft world / toggle).
   * Play-time PART movers use pushColliderPartPoses (kinematic); ROOT uses pushColliderRootPoses.
   *
   * After seal: still allowed once (post-avatar settle) but pose-fp gates no-ops;
   * each real setGlobalPose reinserts that one actor for SQ (PhysXWorld).
   */
  private pushAllColliderPosesToPhysX(): void {
    if (!this.playerMode) return
    this.sceneScript.flushSceneGraphMatrices()
    // Pose-only: entity matrixWorld → desc.matrix. Do not invalidate/re-extract shape locals.
    this.sceneScript.syncCollisionPoses()
    const descs = this.sceneScript.getAllPhysicsColliderDescs()
    if (!descs.length) return
    // force:false — unmoved statics already in SQ from cook; do not thrash reinsert.
    const updated = this.physics.applyStaticColliderPoseUpdates(descs, {
      force: false,
      actorRootOnly: true
    })
    if (updated > 0) this.physics.warmStaticScene()
    this.lastPhysicsBatchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()
  }

  /**
   * Gate play until a walk surface exists under scene.json spawn (probe only).
   * Does **not** CCT-settle or return a lower floor Y — placement stays at authored
   * feet; the capsule freefalls with gravity after initCapsule.
   *
   * @returns authored spawn feet (Three space) when a surface is under the column, else null.
   */
  private async waitForSpawnFloorReady(
    spawn: ResolvedScene['spawn'],
    onProgress?: (msg: string) => void
  ): Promise<THREE.Vector3 | null> {
    const feetY = spawn.fromSpawnPoints ? spawn.y : spawn.y <= 0.01 ? 1 : spawn.y
    const spawnThree = dclToThreeVec(new THREE.Vector3(spawn.x, feetY, spawn.z))
    const elevated = spawnThree.y > 8
    // Seal already completed in sealBootCollidersBeforeSpawn — do not hang 30s on towers.
    const maxWaitMs = elevated ? 8_000 : 5_000
    const probeSoftAcceptMs = elevated ? 1_500 : 2_000
    const probeMaxDrop = elevated ? 12 : 8
    const started = performance.now()
    let attempt = 0
    let lastProgressLog = 0
    let lastProbeY: number | null = null
    let probeOkSince = 0
    let probeOkStreak = 0

    onProgress?.(
      this.spawnColliderSealComplete
        ? 'Checking spawn ground…'
        : 'Waiting for floor colliders…'
    )
    console.info(
      `[World] spawn floor wait — authored feet three=(${spawnThree.x.toFixed(1)}, ${spawnThree.y.toFixed(2)}, ${spawnThree.z.toFixed(1)})` +
        ` elevated=${elevated} sealed=${this.spawnColliderSealComplete} maxWait=${(maxWaitMs / 1000).toFixed(0)}s` +
        ` (probe only — no CCT settle)`
    )

    while (performance.now() - started < maxWaitMs) {
      attempt++
      // COD: after seal the SQ tree is already committed. Mass pose-push + cook-drain
      // during this wait killed plaza SQ within ~2s (probe=0.20 → MISS while map=1100).
      // Unsealed path may still settle cooks; sealed path is probe-only.
      if (!this.spawnColliderSealComplete) {
        await this.sceneScript.yieldForWorkerMessages()
        this.sceneScript.flushSceneGraphMatrices()
        this.pushAllColliderPosesToPhysX()
        this.reconcileColliderCookQueue()
        await this.drainPendingColliderCooksInitialOnly()
        this.pushAllColliderPosesToPhysX()
        this.physics.warmStaticScene()
      }

      // Prefer deck near authored Y — never the highest roof/arch hit.
      const probed = this.physics.probeWalkSurfaceFeetY(
        spawnThree.x,
        spawnThree.z,
        spawnThree.y + 1.2,
        probeMaxDrop,
        spawnThree.y
      )
      const probeOk = probed != null && isPlausibleSpawnSurfaceY(probed, spawnThree.y)
      const now = performance.now()
      if (probeOk && probed != null) {
        lastProbeY = probed
        probeOkStreak++
        if (probeOkSince <= 0) probeOkSince = now
      } else {
        probeOkStreak = 0
        probeOkSince = 0
      }

      // Sealed: one solid probe is enough — pre-play already proved SQ at this column.
      if (this.spawnColliderSealComplete && probeOk && lastProbeY != null) {
        const elapsed = ((now - started) / 1000).toFixed(1)
        console.info(
          `[World] spawn floor ready — sealed probe after ${elapsed}s (attempts=${attempt}` +
            `, probeY=${lastProbeY.toFixed(2)}, place authoredY=${spawnThree.y.toFixed(2)})`
        )
        onProgress?.('Floor ready')
        return spawnThree.clone()
      }

      // Surface under column is enough — place at authored Y and drop (no CCT snap).
      if (
        !this.spawnColliderSealComplete &&
        lastProbeY != null &&
        probeOkStreak >= 3 &&
        probeOkSince > 0 &&
        now - probeOkSince >= probeSoftAcceptMs
      ) {
        const elapsed = ((now - started) / 1000).toFixed(1)
        console.info(
          `[World] spawn floor ready — probe under column after ${elapsed}s (attempts=${attempt}` +
            `, probeY=${lastProbeY.toFixed(2)}, place authoredY=${spawnThree.y.toFixed(2)})`
        )
        onProgress?.('Floor ready')
        return spawnThree.clone()
      }

      // Early exit when first solid probe (elevated drop-in scenes, unsealed path).
      if (!this.spawnColliderSealComplete && probeOk && lastProbeY != null && elevated) {
        const elapsed = ((now - started) / 1000).toFixed(1)
        console.info(
          `[World] spawn floor ready — elevated probe after ${elapsed}s` +
            ` (probeY=${lastProbeY.toFixed(2)}, place authoredY=${spawnThree.y.toFixed(2)})`
        )
        onProgress?.('Floor ready')
        return spawnThree.clone()
      }

      if (now - lastProgressLog > 2000) {
        lastProgressLog = now
        const sec = ((now - started) / 1000).toFixed(0)
        onProgress?.(
          probeOk
            ? `Finding spawn ground… ${sec}s`
            : `Finding spawn ground… ${sec}s (no surface yet)`
        )
        this.physics.logStaticCollidersNear(spawnThree.x, spawnThree.y, spawnThree.z, 16)
        clientDebugLog.log(
          'player',
          `spawn floor wait — t=${sec}s attempt=${attempt} probe=${probed?.toFixed(2) ?? 'none'} sealed=${this.spawnColliderSealComplete}`,
          { alsoConsole: true, level: 'info' }
        )
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 120))
    }

    const elapsed = ((performance.now() - started) / 1000).toFixed(1)
    console.warn(
      `[World] spawn floor wait timed out after ${elapsed}s (attempts=${attempt}) — spawning at authored` +
        (lastProbeY != null ? ` (had probe y=${lastProbeY.toFixed(2)})` : ' (may freefall)')
    )
    this.physics.logStaticCollidersNear(spawnThree.x, spawnThree.y, spawnThree.z, 16)
    onProgress?.('Spawn ground timed out — spawning at authored…')
    // Always authored placement — gravity handles the drop.
    return spawnThree.clone()
  }

  


  /**
   * Transform dirty → ROOT follow (actor pose = entity). Never rewrites shape geometry.
   * See `docs/COLLIDER_MOTION_POLICY.md`.
   */
  private pushColliderRootPoses(transformDirty: ReadonlySet<Entity>): void {
    if (!this.playerMode || !transformDirty.size) return
    this.sceneScript.refreshColliderDescPoses([...transformDirty])
    const descs = this.sceneScript.getPhysicsColliderDescsForEntities([...transformDirty])
    if (!descs.length) return
    // Prefer kinematic root pose for multi-shape already promoted; else static root slide.
    let updated = 0
    const staticRoot: PhysicsColliderDesc[] = []
    for (const desc of descs) {
      if (desc.shapes?.length && this.physics.isKinematicActor(desc.entity)) {
        if (this.physics.updateKinematicMultiShapePose(desc)) updated++
      } else {
        staticRoot.push(desc)
      }
    }
    if (staticRoot.length) {
      // force:false — unmoved statics must not re-touch SQ (COD: cook once, leave alone).
      updated += this.physics.applyStaticColliderPoseUpdates(staticRoot, {
        force: false,
        actorRootOnly: true
      })
    }
    // Also fold CRDT pose-dirty roots not already covered.
    const lastDirty = this.sceneScript.getLastPoseChangedEntities()
    if (lastDirty.length) {
      const extra = lastDirty.filter((e) => !transformDirty.has(e))
      if (extra.length) {
        this.sceneScript.refreshColliderDescPoses(extra)
        const extraDescs = this.sceneScript
          .getPhysicsColliderDescsForEntities(extra)
          .filter((d) => !this.physics.isKinematicActor(d.entity))
        if (extraDescs.length) {
          updated += this.physics.applyStaticColliderPoseUpdates(extraDescs, {
            force: false,
            actorRootOnly: true
          })
        }
      }
    }
    if (updated > 0) this.physics.refreshStaticColliderQueries()
    this.lastPhysicsBatchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()
  }

  /**
   * PART follow — platform path for child/bone hull motion (Animator / system part).
   * Refresh live shape locals → when hull world fingerprint changes, world-cook that
   * entity only ({@link PhysXWorld.applyPartColliderMotions}). See policy doc.
   */
  private pushColliderPartPoses(animatorPart: ReadonlySet<Entity>): void {
    if (!this.playerMode || !animatorPart.size) return

    // Live mesh/bone worlds → shape.localMatrix (world cook uses entity × local).
    const poseFps = this.sceneScript.forceRefreshPartColliderPoses(animatorPart)

    const descs: PhysicsColliderDesc[] = []
    const pendingFp = new Map<number, string>()

    for (const entity of animatorPart) {
      const physId = this.sceneScript.physEntityIdForPoseSync(entity)
      if (physId === null) continue
      const desc = this.sceneScript.getPhysicsColliderDesc(physId)
      if (!desc) {
        if (!this.loggedPartNoCollider.has(entity)) {
          this.loggedPartNoCollider.add(entity)
          console.warn(
            `[phys] PART entity ${entity} has no collider extract (need physics hull / MeshCollider)`
          )
        }
        continue
      }

      if (!desc.shapes?.length) {
        descs.push(desc)
        continue
      }

      const poseFp =
        poseFps.get(entity) ??
        this.sceneScript.getGltfColliderMeshWorldFingerprint(entity, 2) ??
        ''
      if (!poseFp) {
        if (!this.loggedPartNoCollider.has(entity)) {
          this.loggedPartNoCollider.add(entity)
          console.warn(
            `[phys] PART entity ${entity} has multi-shape extract but no live hull fingerprint`
          )
        }
        continue
      }
      // Stable hull pose (coarse) → no PhysX work.
      if (this.partMotionPoseFp.get(desc.entity) === poseFp) continue

      descs.push(desc)
      pendingFp.set(desc.entity, poseFp)
    }

    if (!descs.length) return

    // No cook budget — coarse fp gate limits work. Every meaningfully moved hull cooks.
    const { updated, doneIds } = this.physics.applyPartColliderMotions(descs)

    for (const physId of doneIds) {
      const fp = pendingFp.get(physId)
      if (fp) this.partMotionPoseFp.set(physId, fp)
    }

    if (updated > 0) this.physics.refreshStaticColliderQueries()
    // Intentional: no per-frame console spam (was flooding at 50+ logs/s during thrash).
    this.lastPhysicsBatchFp = this.sceneScript.getPhysicsColliderBatchFingerprint()
  }

  /**
   * Animator multi-shape at boot — entity-local cook so PART kinematics have baselines.
   */
  private recookAnimatedGltfEntityLocal(): void {
    const stale: PhysicsColliderDesc[] = []
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (!desc.fingerprint.startsWith('gltf-entity:')) continue
      const ecsEntity = (desc.entity - GLTF_COLLIDER_ENTITY_BASE) as Entity
      if (!this.sceneScript.isAnimatedGltfColliderEntity(ecsEntity)) continue
      // Always re-register with geometryCache so shapeBaselineLocal is present for slides.
      stale.push(desc)
    }
    if (!stale.length) return
    const result = this.physics.syncStaticColliders(stale, {
      cookBudget: stale.length,
      freezeRemoval: true,
      forceRecookOnPoseChange: true,
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
    } else if (!this.collidersReady) {
      // Pre-ready only: full discover. After ready, per-entity attach handles late GLBs.
      this.discoverUnsyncedColliderCooks()
    } else {
      this.discoverMissingColliderActors()
    }
    this.maybeBeginRuntimeColliderBurst(queueBefore)
  }

  /**
   * Enqueue every extracted descriptor that is not live+synced in PhysX.
   * Boot / post-structure only — not on every late GLB attach (that thrashed plaza solids).
   */
  private discoverUnsyncedColliderCooks(): void {
    if (this.deferPhysxCooks) {
      this.pendingColliderCooks = this.colliderCookQueue.size
      return
    }
    this.sceneScript.flushSceneGraphMatrices()
    let added = 0
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (this.physics.isAoiRoadColliderEntity(desc.entity)) continue
      if (this.physics.isAoiEmptyLandColliderEntity(desc.entity)) continue
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
      clientDebugLog.consoleOnly(
        'info',
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
    const slideDescs: PhysicsColliderDesc[] = []
    // Subtree roots + the entity itself (extract may land before colliderRootEntities rebuild).
    const entities = new Set(this.sceneScript.collectColliderEntitiesInSubtree(ecsEntity))
    entities.add(ecsEntity)
    for (const entity of entities) {
      for (const physId of this.sceneScript.collectPhysCookTargets(entity)) {
        if (this.physics.isAoiRoadColliderEntity(physId)) continue
      if (this.physics.isAoiEmptyLandColliderEntity(physId)) continue
        const hasActor = this.physics.hasStaticActor(physId)
        if (hasActor) {
          // ALWAYS refresh extract from live matrixWorld then pose-slide PhysX.
          // Skipping this after integrity left solids at pre-attach poses while meshes
          // finished loading → walk-through furniture with static=1000+ (plaza soft load).
          this.sceneScript.refreshColliderPose(physId)
          const desc = this.sceneScript.getPhysicsColliderDesc(physId)
          if (!desc) continue
          if (this.physics.isWorldBakedStatic(desc.entity)) {
            // World-baked cannot slide — queue recook if pose drifted.
            if (!this.physics.isColliderSynced(desc)) {
              this.colliderCookQueue.add(physId)
              enqueuedPhysIds.push(physId)
            } else {
              this.colliderCookQueue.delete(physId)
            }
            continue
          }
          slideDescs.push(desc)
          continue
        }
        // Never-cooked — full refresh + enqueue.
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
    if (slideDescs.length) {
      const updated = this.physics.applyStaticColliderPoseUpdates(slideDescs, {
        force: false,
        actorRootOnly: true
      })
      if (updated > 0) this.physics.refreshStaticColliderQueries()
      for (const desc of slideDescs) {
        // Scale/geom mismatch still needs recook; pure T+R is synced after slide.
        if (this.physics.isColliderSynced(desc)) {
          this.colliderCookQueue.delete(desc.entity)
        } else {
          this.colliderCookQueue.add(desc.entity)
          enqueuedPhysIds.push(desc.entity)
        }
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


  /**
   * Platform cook drain.
   * - boot: high budget, force recook, entity-local geometry (slides work after play)
   * - play: low budget, force recook only for queued unsynced / never-cooked
   * Never pre-removes live actors (replaceStaticWithCook only).
   *
   * Legacy option names (loading/integrity/initialOnly) map to boot/play for callers not yet migrated.
   */
  private async drainColliderCookQueue(options?: {
    mode?: 'boot' | 'play'
    hydration?: boolean
    loading?: boolean
    integrity?: boolean
    initialOnly?: boolean
  }): Promise<void> {
    const burstActive = performance.now() < this.runtimeColliderBurstUntil
    const bootMode =
      options?.mode === 'boot' ||
      options?.loading === true ||
      options?.hydration === true ||
      options?.integrity === true
    const playMode = !bootMode
    const budget = bootMode
      ? World.LOADING_COLLIDER_COOK_BUDGET
      : burstActive
        ? World.RUNTIME_COLLIDER_BURST_BUDGET
        : World.RUNTIME_COLLIDER_COOK_BUDGET

    const toCook: PhysicsColliderDesc[] = []
    const queueOrder = bootMode
      ? this.sortedColliderCookQueue(this.colliderCookPriority)
      : this.sortedColliderCookQueue()
    for (const physId of queueOrder) {
      if (toCook.length >= budget) break
      const desc = this.sceneScript.getPhysicsColliderDesc(physId)
      if (!desc) {
        this.colliderCookQueue.delete(physId)
        continue
      }
      // Play: skip already-synced (boot force-rebuilds from live extracts).
      if (playMode && this.physics.isColliderSynced(desc)) {
        this.colliderCookQueue.delete(physId)
        continue
      }
      this.sceneScript.flushSceneGraphMatrices()
      this.sceneScript.refreshColliderBeforeCook(physId)
      const fresh = this.sceneScript.getPhysicsColliderDesc(physId)
      if (!fresh) continue
      if (playMode && this.physics.isColliderSynced(fresh)) {
        this.colliderCookQueue.delete(physId)
        continue
      }
      toCook.push(fresh)
    }

    if (!toCook.length) {
      this.pendingColliderCooks = this.colliderCookQueue.size
      this.refreshColliderCookStats()
      return
    }

    try {
      // Platform policy: entity-local multi-shape (pose slides work; recook on scale/geom).
      await prefetchPhysxCookStreams(buildPhysxCookPrefetchRequests(toCook, true), {
        quiet: true,
        maxWaitMs: bootMode ? 0 : 12
      })

      // Play: never force-recook on pose-only drift (slide path). Boot still force-rebuilds.
      // forceRecook=true on every late-attach queue was soft-window thrash (replaceStatic churn).
      const result = this.physics.syncStaticColliders(toCook, {
        cookBudget: toCook.length,
        freezeRemoval: true,
        forceRecookOnPoseChange: bootMode,
        geometryCache: true
      })
      for (const desc of toCook) {
        if (this.physics.isColliderSynced(desc)) {
          this.colliderCookQueue.delete(desc.entity)
        }
      }
      if (result.geometryChanged) {
        if (bootMode) this.physics.warmStaticScene()
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
      // Stale fingerprints only — never clearAll (that softs the whole plaza for seconds).
      this.physics.staleNonRoadColliderFingerprints()
      this.colliderCookQueue.clear()
      this.sceneScript.invalidateGltfColliderSyncCache()
    }

    this.sceneScript.flushSceneGraphMatrices()
    this.sceneScript.refreshAllInstancedTransforms()
    this.sceneScript.syncCollisionForce()

    // Full re-enqueue (do not rely on post-boot reconcile — it only prunes the live queue).
    for (const desc of this.sceneScript.getAllPhysicsColliderDescs()) {
      if (this.physics.isAoiRoadColliderEntity(desc.entity)) continue
      if (this.physics.isAoiEmptyLandColliderEntity(desc.entity)) continue
      this.colliderCookQueue.add(desc.entity)
    }
    this.pendingColliderCooks = this.colliderCookQueue.size
    const queued = this.colliderCookQueue.size

    if (!options?.quiet) {
      clientDebugLog.log(
        'collision',
        `Manual recook — hot-replace ${queued} collider(s)…`,
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
        const maxPasses = Math.max(64, Math.ceil(queued / 48) + 8)
        while (this.colliderCookQueue.size > 0 && passes < maxPasses) {
          // integrity:true keeps live actors until each replace succeeds.
          await this.drainColliderCookQueue({ integrity: true })
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
        this.physics.refreshStaticAfterRuntimeGeometryChange()
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
   * After asset hydration: extract colliders and begin progressive PhysX cook so
   * prepareCollidersForPlay seals a nearly-full set instead of cooking from zero.
   * Does not set collidersLoadingComplete — that is the prepare seal only.
   */
  async prewarmPhysicsColliders(
    _scene: ResolvedScene,
    onProgress?: (msg: string, fraction?: number) => void,
    options: { assetsTimedOut?: boolean } = {}
  ): Promise<void> {
    if (!this.playerMode) return
    this.bootAssetsTimedOut = options.assetsTimedOut ?? false
    this.resetColliderBootState()

    // Light prewarm only — authoritative extract+seal is prepareCollidersForPlay.
    // Do not seal SQ here (that froze reinsert before final cook on plaza).
    onProgress?.('Preparing collisions…', World.COLLIDER_COOK_PROGRESS_START)
    await this.sceneScript.syncRendererFull()
    await this.extractCollidersChunked(
      (msg) => onProgress?.(msg, World.COLLIDER_COOK_PROGRESS_START + 0.05),
      'Prewarming colliders',
      { invalidateAll: true, markAllDirty: true, maxPasses: 24 }
    )

    this.deferPhysxCooks = false
    this.colliderCookQueue.clear()
    this.reconcileColliderCookQueue()
    this.discoverMissingColliderActors()
    const prewarmBudget = 16
    let passes = 0
    while (this.colliderCookQueue.size > 0 && passes < prewarmBudget) {
      await this.drainColliderCookQueue({ mode: 'boot' })
      passes++
      const registered = this.physics.gltfStaticActorCount
      const extracted = this.lastGltfColliderCount
      onProgress?.(
        `Cooking collisions… ${registered}/${extracted}`,
        World.COLLIDER_COOK_PROGRESS_START +
          World.COLLIDER_COOK_PROGRESS_RANGE * Math.min(0.85, registered / Math.max(1, extracted))
      )
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
    }

    const extracted = this.lastGltfColliderCount
    const registered = this.physics.gltfStaticActorCount
    clientDebugLog.log(
      'collision',
      `[phys] prewarm cook — gltf=${registered}/${extracted} pending=${this.colliderCookQueue.size}`,
      { level: 'info', alsoConsole: true }
    )
    onProgress?.(
      extracted > 0
        ? `Colliders cooking (${registered}/${extracted} GLTF)…`
        : 'Preparing collisions…',
      World.COLLIDER_COOK_PROGRESS_START + World.COLLIDER_COOK_PROGRESS_RANGE * 0.5
    )
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
      this.multiScene.unbindWorld()
    }
    this.multiScene = runtime
    if (!runtime || !this.loadedPrimaryScene) return
    runtime.setOnLiveSecondaryIds((ids) => {
      this.aoiVisual.setLiveSecondaryIds(ids)
      this.aoiVisual.setResidentParcelKeys(runtime.residentParcelKeys())
    })
    // PE worker: full main-thread surface (identity, pointer, keys, avatar modifiers, physics lamport).
    runtime.pe.setOnPeWorkerReady((system, physOffset) => {
      this.wirePeWorkerToMainThread(system, physOffset)
    })
    // Impulse Lamport = max(primary, all PX) so bounce pads / thrusters fire once.
    this.player?.setImpulseLamportProvider(() => {
      if (!this.multiScene) return this.sceneScript.getPhysicsImpulseLamport()
      return this.claimApplier.impulseLamportAcross(
        this.multiScene.layers.list(),
        this.sceneScript
      )
    })
    runtime.registerPrimary(this.sceneScript)
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
   * Wire a PE SceneScriptSystem to main-thread player/input/physics — same surface as primary
   * minus exclusive privileges (teleport still via arbiter).
   */
  private wirePeWorkerToMainThread(
    system: import('./systems/SceneScriptSystem').SceneScriptSystem,
    physOffset = 0
  ): void {
    system.setPlayerIdentity(
      buildPlayerMirrorIdentity({
        address: this.session.getAddress(),
        profile: this.session.getProfile()
      })
    )
    system.setRealmInfo(this.comms.getRealmInfo())
    system.setClientPoseProvider(() => ({
      player: this.player!.getEntityPose(),
      camera: this.player!.getCameraEntityPose()
    }))
    system.setVirtualCameraPoseProviders(
      () => this.player!.getEntityPose(),
      () => this.player!.getCameraEntityPose()
    )
    // PE entity delete → drop PhysX statics in the PE id namespace (freezeRemoval would leave ghosts).
    system.setCollidersRemoveCallback((entity) => {
      this.onColliderEntityRemovedWithOffset(entity, physOffset)
    })
    system.setCollidersPoseCallback((entities) => {
      // Pose slides use remapped phys ids in multi-scene tick; skip primary-only slide path.
      void entities
    })
    // PE is a full scene runtime — play-ready so engine ticks match primary.
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
        isLocomotionBlocked: () => this.player?.isLocomotionBlocked() ?? false,
        clearPlayerMoveKeys: () => this.player?.clearMoveKeys(),
        // Keys always fan out; no force-republish special case for PX freeze (host owns WASD).
        forceRepublishSnapshot: () => false
      },
      (mode) => this.player?.setForcedCameraMode(mode)
    )
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
    // Emote wheel modal — B/0-9/E owned by HUD; never fan-out E (IA_PRIMARY) to workers.
    if (document.querySelector('.emote-wheel-overlay:not([hidden])')) return true
    if (document.querySelector('.settings-overlay.is-open')) return true
    if (document.querySelector('.preferences-panel.is-open')) return true
    if (document.querySelector('.keybinds-overlay.is-open')) return true
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
      isLocomotionBlocked: () => this.player?.isLocomotionBlocked() ?? false,
      clearPlayerMoveKeys: () => this.player?.clearMoveKeys()
    })
  }

  /** Last selected lens owner for one-shot logs (primary vs pe). */
  private lastVcBridgeOwner: 'none' | 'primary' | 'pe' = 'none'

  /**
   * PlayerSystem only had the primary VirtualCameraBridge. PE drone/vehicle cameras live on the
   * PE SceneScriptSystem — switch the player lens to any PE that has MainCamera→VC bound.
   */
  private selectActiveVirtualCameraBridge(): void {
    if (!this.player) return
    const peSystems = this.multiScene?.pe.getRunningSystems() ?? []
    for (const sys of peSystems) {
      const bridge = sys.getVirtualCameraBridge()
      if (!bridge) continue
      if (bridge.isMainCameraVcBound() || bridge.isActive()) {
        this.player.setVirtualCameraBridge(bridge)
        if (this.lastVcBridgeOwner !== 'pe') {
          this.lastVcBridgeOwner = 'pe'
          console.info(
            `[pe] VirtualCamera lens → PE bridge (mainBound=${bridge.isMainCameraVcBound()} active=${bridge.isActive()})`
          )
        }
        return
      }
    }
    this.player.setVirtualCameraBridge(this.sceneScript.getVirtualCameraBridge())
    if (this.lastVcBridgeOwner === 'pe') {
      this.lastVcBridgeOwner = 'primary'
      console.info('[pe] VirtualCamera lens → primary (PE VC unbound)')
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

  /**
   * Live secondary Animator/Tween advance (≤3 graphs). Tertiary is intentionally frozen.
   * Without this, sticky demoted scenes keep scripts but clips freeze mid-pose.
   */
  private pumpSecondaryMotionBridges(delta: number, frame: number): void {
    for (const sys of this.multiScene?.getSecondaryMotionSystems() ?? []) {
      try {
        sys.pumpMotionBridges(delta, frame)
      } catch (err) {
        console.warn('[multi-scene] secondary pumpMotionBridges failed', err)
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
   * Collect layer claims → host (camera / force / primary freeze).
   * PX never freezes WASD; scene-authored moves use movePlayerTo → host → rebroadcast.
   */
  private applyLayerPlayerClaims(): void {
    if (!this.multiScene || !this.player) return
    if (!this.multiScene.layers.has('primary')) {
      this.multiScene.registerPrimary(this.sceneScript)
    }
    const layers = this.multiScene.layers.list()
    const claims = collectPlayerClaims(layers)
    this.claimApplier.apply(claims, {
      primary: this.sceneScript,
      player: this.player,
      setVirtualCameraBridge: (bridge) => {
        this.player?.setVirtualCameraBridge(
          bridge ?? this.sceneScript.getVirtualCameraBridge()
        )
      },
      primaryVirtualCameraBridge: () => this.sceneScript.getVirtualCameraBridge(),
      drainPrivilegedIntents: () => this.drainPePrivilegedIntents(),
      rebroadcastHostPoses: () => this.rebroadcastHostPosesToAllLayers(),
      layers
    })
  }

  /**
   * After scene-authored player moves (movePlayerTo / forces applied on capsule):
   * host already has the new feet — push to every layer worker (primary + PX + secondary).
   * This is NOT input; scene code moved the player.
   */
  private rebroadcastHostPosesToAllLayers(): void {
    if (!this.player) return
    const player = this.player.getEntityPose()
    const camera = this.player.getCameraEntityPose()
    this.sceneScript.syncClientEntities(player, camera)
    this.sceneScript.pushReservedTransformsToWorker()
    for (const sys of this.multiScene?.pe.getRunningSystems() ?? []) {
      try {
        sys.syncClientEntities(player, camera)
        sys.pushReservedTransformsToWorker()
      } catch {
        /* ignore */
      }
    }
    for (const sys of this.multiScene?.getSecondaryMotionSystems() ?? []) {
      try {
        sys.syncClientEntities(player, camera)
      } catch {
        /* ignore */
      }
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
    let sceneMovedPlayer = false

    const move = arbiter.take('movePlayer')
    if (move && move.kind === 'pe') {
      try {
        const ok = this.player.movePlayerTo(
          move.payload as Parameters<PlayerSystem['movePlayerTo']>[0]
        )
        if (ok) {
          sceneMovedPlayer = true
          this.sceneScript.nudgePlayAfterSceneTeleport()
        }
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

    // PX/primary scene code moved the player — host is truth; rebroadcast to all workers.
    if (sceneMovedPlayer) this.rebroadcastHostPosesToAllLayers()
  }

  /**
   * In-world promote (no World rebuild) — only when target is already a live secondary.
   * AppController force-boots under-feet first, then calls this. Failure must **not**
   * seamless-jump (continuity: prior primary stays until handoff succeeds).
   */
  async tryPromoteInWorld(target: { x: number; y: number }): Promise<boolean> {
    const multi = this.multiScene
    if (!multi || !this.player) return false

    const handoff = multi.takeSecondaryForPromote(target.x, target.y)
    if (!handoff) {
      console.info(
        `[promote] no live secondary @ ${target.x},${target.y} — wait for force-boot (no unload)`
      )
      return false
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

    // Point multi-scene at NEW primary SW *before* demote so sticky offset is correct.
    // (Demoted prior primary must leave host origin; host origin becomes new SW.)
    multi.notifyPrimaryChanged(newScene)

    // Demote old primary → sticky secondary (meshes MUST stay — never dispose into void).
    // Do this before wiring new primary so entity roots stay valid.
    if (oldScene?.entityId && oldScene.mainEntry && oldScene.entityId !== newScene.entityId) {
      // Revoke FocusOwner before sticky adopt (mute media/UI; drop InputHub; clear hide/camera).
      oldPrimary.clearAvatarModifierEffects()
      oldPrimary.setFocusPolicy('secondary')
      oldPrimary.setInputHub(null)
      oldPrimary.setAvatarModifierProviders(null)
      // Player must leave demoted scene's AvatarModifier hide + CameraModeArea force.
      this.player.setModifierHidden(false)
      this.player.setForcedCameraMode(null)
      const demoted = await multi.demotePrimaryToSecondary(
        oldPrimary,
        oldScene,
        newScene.baseParcel
      )
      if (demoted) {
        // Platform continuity: remapped colliders under secondary phys offset are already
        // captured on the sticky slot. Invalidate native primary ids only AFTER we have
        // the remapped snapshot — then push remapped into PhysX so plaza walk stays solid.
        const remapped = multi.collectResidentColliders()
        for (const id of demoted.primaryPhysIds) {
          this.physics.invalidateStaticCollider(id)
        }
        if (remapped.length > 0) {
          try {
            // One-shot register under secondary ids — never forceRecook (geometry already cooked).
            this.physics.syncStaticColliders(remapped, {
              cookBudget: Math.min(32, remapped.length),
              freezeRemoval: true,
              forceRecookOnPoseChange: false,
              geometryCache: true
            })
            multi.markResidentCollidersSynced()
            console.info(
              `[promote] sticky colliders kept “${oldScene.title}” remapped=${remapped.length} ` +
                `(invalidated native=${demoted.primaryPhysIds.length})`
            )
          } catch (err) {
            console.warn('[promote] sticky collider keep failed', err)
          }
        } else {
          console.warn(
            `[promote] sticky colliders EMPTY “${oldScene.title}” — plaza PhysX may void until recook`
          )
        }
        console.info(
          `[promote] prior primary sticky resident “${oldScene.title}” parcels=${oldScene.parcels?.length ?? '?'} ` +
            `base=${oldScene.baseParcel} → offset vs ${newScene.baseParcel}`
        )
      } else {
        // Continuity P0: never dispose — leave system muted on host even if slot adopt failed.
        console.error(
          `[promote] demote failed for “${oldScene.title}” — keeping system resident (no dispose)`
        )
        try {
          const store = oldPrimary.getEntityStore()
          if (store?.root) {
            store.root.name = `secondary-orphan:${oldScene.entityId.slice(0, 16)}`
            store.root.visible = true
            if (store.root.parent !== this.host.scene) {
              this.host.scene.add(store.root)
            }
          }
        } catch {
          /* ignore */
        }
      }
    } else if (oldPrimary !== newSystem) {
      // Same entity or missing identity — keep old graph on host (never dispose blindly).
      console.warn(
        '[promote] skip demote (same/missing entity) — keeping old primary graph resident (no dispose)'
      )
      try {
        const store = oldPrimary.getEntityStore()
        if (store?.root && oldPrimary !== newSystem) {
          store.root.visible = true
          store.root.name = `secondary-orphan:same:${oldScene?.entityId?.slice(0, 12) ?? 'x'}`
          if (store.root.parent !== this.host.scene) {
            this.host.scene.add(store.root)
          }
        }
      } catch {
        /* ignore */
      }
    }

    this.sceneScript = newSystem
    this.loadedPrimaryScene = newScene
    this.assets.setScene(newScene)
    this.multiScene?.registerPrimary(newSystem)

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
      if (ok) this.kickPostTeleportColliderCatchup()
      return ok
    })
    this.sceneScript.setSetCameraTransformHandler((request) =>
      this.player!.setTestingCameraTransform(request)
    )
    this.sceneScript.setTriggerEmoteHandler((request) => {
      const emote = request.predefinedEmote?.trim()
      if (!emote) return false
      void this.playLocalEmote(emote, { loop: undefined, sceneTriggered: true })
      return true
    })
    // FocusOwner swap: media + UI for adopted primary; InputHub primary subscriber.
    // CRITICAL: rebind player locomotion reads to the NEW primary MirrorComponents.
    this.player.setReadComponents(this.sceneScript.readComponents)
    this.player.setImpulseLamportProvider(() => this.sceneScript.getPhysicsImpulseLamport())
    // Clear freeze + arm grace (worker freezes stripped on player-frame).
    this.sceneScript.clearPlayerFocusState()
    this.sceneScript.setFocusPolicy('primary')
    this.sceneScript.setInputHub(this.inputHub, 'primary')
    this.sceneScript.setSceneUiVisible(true)
    this.player.releaseSceneFreezeHold('promote-handoff')
    // Never leave AvatarModifier hide or CameraModeArea from the previous primary.
    this.player.setModifierHidden(false)
    this.player.setForcedCameraMode(null)
    // Rebind AvatarAttach + AvatarModifierArea to NEW primary only (not demoted sticky).
    this.bindAvatarAttachTargets()
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

    // Comms / signed-fetch context for new primary (Admin Tools gatekeeper scope).
    this.applySignedFetchSceneContext(newScene)
    this.runAdminToolsDiagnostics('primary-promote')

    // P0: rebind scene origin to NEW primary base BEFORE feet restore / soft-route.
    // applyRealmAbout alone does NOT update sceneOriginMeters — that left feet in old
    // local space under the new base → soft-route warped (e.g. -141,99 + stale local
    // → -135,107) and CBD looked unloaded.
    const originBefore = { ...this.comms.getSceneOrigin() }
    this.comms.applyRealmAbout(newScene.realm, newScene.commsPointer)
    this.comms.bindSceneTarget(this.buildCommsTarget(newScene))
    this.session.setCatalystEndpoints(newScene.realm.contentUrl, newScene.realm.lambdasUrl)

    // Feet stay put in Genesis space under the NEW origin.
    const ok = this.restoreGenesisFeet(genesis)
    // Platform camera: freecam orbit is durable player state — rebind VC bridge for the
    // new primary, clear MainCamera (already in clearPlayerFocusState), snap boom to feet.
    // Never reseed yaw/pitch/dist from scene VC (that was the "reset mode" snap).
    this.player.setVirtualCameraBridge(this.sceneScript.getVirtualCameraBridge())
    this.player.notifySceneFocusHandoff()
    const originAfter = this.comms.getSceneOrigin()
    const feetAfter = this.player.getPosition()
    const baseParts = newScene.baseParcel.split(',').map((s) => Number.parseInt(s.trim(), 10))
    const baseX = Number.isFinite(baseParts[0]) ? baseParts[0]! : 0
    const baseY = Number.isFinite(baseParts[1]) ? baseParts[1]! : 0
    const softPx = baseX + Math.floor(feetAfter.x / 16)
    const softPy = baseY + Math.floor(feetAfter.z / 16)
    console.info(
      `[promote] origin (${originBefore.x},${originBefore.z})→(${originAfter.x},${originAfter.z}) ` +
        `feetLocal=(${feetAfter.x.toFixed(1)},${feetAfter.z.toFixed(1)}) ` +
        `softParcel=${softPx},${softPy} restoreOk=${ok} ` +
        `genesis=(${genesis.x.toFixed(1)},${genesis.z.toFixed(1)})`
    )

    // Sticky secondaries already retargeted before demote; re-sync live ids + AOI hide.
    multi.setOnLiveSecondaryIds((ids) => {
      this.aoiVisual.setLiveSecondaryIds(ids)
      // Keep empty-land skip set in lockstep with residents.
      this.aoiVisual.setResidentParcelKeys(multi.residentParcelKeys())
    })
    multi.syncLiveSecondaryVisibility()
    // CRITICAL: register demoted plaza parcels BEFORE retarget refresh paints scatter/empty.
    // Include prior primary parcels explicitly (sticky demote) so CBD never gets trees.
    const residentKeys = new Set(multi.residentParcelKeys())
    if (oldScene?.parcels) {
      for (const p of oldScene.parcels) if (p) residentKeys.add(p.trim())
    }
    if (oldScene?.baseParcel) residentKeys.add(oldScene.baseParcel.trim())
    this.aoiVisual.setResidentParcelKeys([...residentKeys])
    // Re-assert demoted mesh offsets after origin change. Colliders already registered
    // once above — do NOT forceRecook here (that was the CBD→snow→CBD 3fps death spiral).
    multi.notifyPrimaryChanged(newScene)
    // Pose-only refresh if retarget dirtied colliders (cheap; fingerprints unchanged → no recook).
    {
      const remapped = multi.collectResidentColliders()
      if (remapped.length > 0) {
        try {
          this.physics.syncStaticColliders(remapped, {
            cookBudget: 8,
            freezeRemoval: true,
            forceRecookOnPoseChange: false,
            geometryCache: true
          })
          multi.markResidentCollidersSynced()
        } catch (err) {
          console.warn('[promote] sticky collider retarget sync failed', err)
        }
      }
    }

    // AOI: retarget with CORRECTED local feet (after restore) — no unbind wipe.
    // Kill live secondary reconcile during settle (dual-worker freeze). Visuals OK.
    multi.setSecondaryActivityEnabled(false)
    // Only new primary runs scripts during settle — sticky/plaza tertiary (meshes stay).
    multi.forceAllResidentsTertiary('promote-settle')
    // Ensure demoted roots stay visible after tertiary mode (CBD must not look empty).
    multi.ensureResidentsVisible()
    this.aoiVisual.retargetPrimary(newScene, feetAfter.x, feetAfter.z)
    // retargetPrimary already liveReconcileEnabled=false; visuals neighborActivity on.
    this.scenePromote.bind(newScene)
    // Promote evaluate OK; soft-route force-boot gated by isSecondaryActivityEnabled().
    this.scenePromote.setNeighborActivityEnabled(true)

    // Soft-route URL to feet parcel under new origin (not stale -135,107 warp).
    this.promoteSoftRoute?.(softPx, softPy)
    // Archipelago island seed uses genesis from new origin + local feet.
    this.comms.seedArchipelagoSceneLocal(feetAfter.x, genesis.y, feetAfter.z)

    console.info(
      `[promote] HANDOFF OK stickyParcels=${multi.residentParcelKeys().length} ` +
        `liveIds=${multi.secondaryManager?.liveEntityIds().size ?? 0} ` +
        `newPrimary="${newScene.title}" base=${newScene.baseParcel} soft=${softPx},${softPy}`
    )

    // Re-register colliders under primary entity ids (secondary-offset actors were
    // invalidated above). Prefer geometryCache + no forceRecook — walk-back must not
    // re-trimesh the entire plaza (that was continuous 3fps with Missing-actors thrash).
    this.colliderCookQueue.clear()
    try {
      this.sceneScript.syncCollisionForce()
    } catch (err) {
      console.warn('[promote] primary syncCollisionForce failed', err)
    }
    this.reconcileColliderCookQueue()
    try {
      const descs = this.sceneScript.getAllPhysicsColliderDescs?.() ?? []
      if (descs.length > 0) {
        // Bounded first push — remaining cooks trickle via cook queue (not 128 main-thread).
        this.physics.syncStaticColliders(descs, {
          cookBudget: Math.min(48, descs.length),
          freezeRemoval: true,
          forceRecookOnPoseChange: false,
          geometryCache: true
        })
        console.info(`[promote] primary colliders force-sync n=${descs.length}`)
      }
    } catch {
      /* optional API */
    }
    if (this.colliderCookQueue.size > 0) {
      void this.scheduleColliderCookDrain()
    }

    // Longer settle: dual full workers after walk-back thrash freeze locomotion.
    const SETTLE_LIVE_SECONDARIES_MS = 8_000
    window.setTimeout(() => {
      if (this.loadedPrimaryScene?.entityId !== newScene.entityId) return
      // Re-assert free locomotion when settle ends (in case worker re-froze mid-grace).
      this.sceneScript.clearPlayerFocusState()
      this.player?.releaseSceneFreezeHold('promote-settle-end')
      multi.setSecondaryActivityEnabled(true)
      // Allow live-secondary candidate emit + boots (visuals already on).
      this.aoiVisual.setNeighborActivityEnabled(true)
      const p = this.player?.getPosition()
      if (p) this.aoiVisual.update(p.x, p.z, true)
      console.info(
        `[promote] live secondaries re-enabled after ${SETTLE_LIVE_SECONDARIES_MS}ms settle ` +
          `(primary “${newScene.title}” hydrating alone; sticky demoted stayed resident; freeze re-cleared)`
      )
    }, SETTLE_LIVE_SECONDARIES_MS)

    console.info(
      `[promote] handoff+demote OK “${newScene.title}” base=${newScene.baseParcel}` +
        ` prev=${oldScene?.title ?? 'none'} restoreFeet=${ok}` +
        ` (prev sticky resident; new boots pause ${SETTLE_LIVE_SECONDARIES_MS}ms)`
    )
    return true
  }

  /** Help → Debug multi-avatar perf harness. */
  getOrCreateDebugAvatarCrowd(): DebugAvatarCrowd {
    if (!this.debugAvatarCrowd) {
      this.debugAvatarCrowd = new DebugAvatarCrowd({
        scene: this.host.scene,
        getPlayerFeet: () => this.getPlayerWorldPosition(),
        contentUrl: this.session.getContentUrl(),
        lambdasUrl: this.session.getLambdasUrl()
      })
    } else {
      this.debugAvatarCrowd.setCatalyst(this.session.getContentUrl(), this.session.getLambdasUrl())
    }
    return this.debugAvatarCrowd
  }

  getDebugAvatarCrowd(): DebugAvatarCrowd | null {
    return this.debugAvatarCrowd
  }

  getRemoteAvatarManager(): RemoteAvatarManager | null {
    return this.remoteAvatars
  }

  /** Tour Focus follower — freeze locomotion / freecam while lens is taken over. */
  setPlayerTourFocusActive(active: boolean): void {
    this.player?.setTourFocusActive(active)
  }

  /** Leader freecam snapshot for Tour Focus wire (null if no player). */
  getPlayerFreecamState(): {
    yaw: number
    pitch: number
    dist: number
    firstPerson: boolean
  } | null {
    return this.player?.getFreecamState() ?? null
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
    this.vrmPeerSync.setLocalAddress(address ?? null)
    await this.vrmPeerSync.onLocalEquipChanged(address)
    // Comms may still be settling after backpack close — re-push a few times.
    this.vrmPeerSync.scheduleLoginWantAnnounceRetries()
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
      if (!isChatTextLine(event.line)) return
      // Prefer live translation when already ready (cache hit / fast auto-translate).
      const display = chatTranslationService.displayText(event.line.id, event.line.text)
      const text = overheadChatText(display)
      if (!text) return

      // 1:1 DMs — local client only (already private transport). Explorer-style DM badge.
      if (event.channelKey.startsWith('dm:')) {
        const peerAddr = event.channelKey.slice(3).toLowerCase()
        const local = this.session.getAddress()?.toLowerCase() ?? ''
        const sender = event.line.senderAddress?.toLowerCase() || (event.line.self ? local : '')
        if (!sender) return
        const peerName =
          this.social.getDmPeers().find((p) => p.address === peerAddr)?.displayName ||
          this.social.getPeerDisplay(peerAddr).displayName
        if (event.line.self || (local && sender === local)) {
          this.player?.showNameTagDmChat(text, { mode: 'outgoing', peerName })
        } else if (!skipRemoteAvatars()) {
          this.remoteAvatars?.showPeerNameTagDmChat(sender, text, { mode: 'incoming' })
        }
        return
      }

      if (!event.channelKey.startsWith('scene:')) return
      const address = event.line.senderAddress?.toLowerCase()
      if (!address) return
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

  /**
   * Animator sample HUD — opt-in via `?animatorhud` / `?perf` / localStorage.
   * Hidden by default so ship builds don't paint debug chrome every frame.
   */
  private refreshAnimatorSampleHud(frameDt: number): void {
    if (!wantAnimatorSampleHud()) return
    if (skipSceneAnimators()) {
      this.animatorSampleHud.setDisabled('OFF (?noanim)')
      return
    }
    const stats = this.sceneScript.getAnimatorSampleStats()
    if (!stats) {
      this.animatorSampleHud.setDisabled('no bridge yet')
      return
    }
    // If pump path skipped update this frame, still show last stats with fresh display fps.
    if (stats.frameDt <= 0 && frameDt > 0) {
      this.animatorSampleHud.update({
        ...stats,
        frameDt,
        displayFps: 1 / frameDt
      })
      return
    }
    this.animatorSampleHud.update(stats)
  }

  dispose(): void {
    this.onVoluntaryEmoteAllowedChange = null
    this.lastVoluntaryEmoteAllowed = true
    this.animatorSampleHud.dispose()
    this.followFlagManager?.unbindScene()
    this.followFlagManager = null
    this.debugAvatarCrowd?.dispose()
    this.debugAvatarCrowd = null
    this.tourFocusTick = null
    this.avatarAttachResolver = null
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
      this.multiScene.unbindWorld()
      this.multiScene = null
    }
    this.claimApplier.reset()
    this.inputHub.dispose()

    // Scene systems first — CameraModeArea / pointer dispose still call into player.
    this.sceneScript.gltfColliders?.setLandscapeRoot(null)
    this.sceneScript.dispose()

    this.player?.dispose()
    this.player = null
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
    this.petPeerSync.detach()
    this.petManager.dispose()
    this.unbindPetContextMenu()
    this.petContextMenu?.dispose()
    this.petContextMenu = null
    // Do NOT clearVrmRamCache() here — tour / follow /goto rebuilds World and must
    // remount remote custom VRMs from session RAM. AppController clears on leave-play.
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

  private buildUserDataLogged = false

  /**
   * Bind signed-fetch scene scope to the loaded scene root.
   * Admin Tools / scene-bans / stream-access all key off this identity.
   */
  private applySignedFetchSceneContext(scene: {
    entityId?: string | null
    baseParcel: string
    realm: { realmName?: string }
    source: { kind: string }
  }): void {
    const sceneId = (scene.entityId ?? '').trim()
    const parcel = (scene.baseParcel ?? '').trim()
    const realmName = (scene.realm.realmName || 'main').trim() || 'main'
    const isWorld = scene.source.kind === 'world'
    // Worlds must send worlds-content-server hostname so gatekeeper treats the place
    // as a world (owner via Worlds API), not Genesis parcel 0,0 land operators.
    const realmHostname = isWorld
      ? `worlds-content-server.decentraland.org/world/${realmName}`
      : 'realm.decentraland.org'
    this.signedFetchSceneContext = {
      sceneId,
      parcel,
      realmName,
      isWorld,
      isGuest: this.loginIsGuest,
      realmHostname,
      realmProtocol: isWorld ? 'v3' : 'https'
    }

    if (!sceneId) {
      console.warn(
        `[admin-tools] signedFetch context EMPTY sceneId parcel=${parcel || '—'} realm=${realmName} — ` +
          `GET /scene-admin will not scope to a place; Admin Tools UI will stay hidden`
      )
    } else {
      console.warn(
        `[admin-tools] signedFetch context — sceneId=${sceneId.slice(0, 20)}… ` +
          `parcel=${parcel || '—'} realm=${realmName} world=${isWorld} ` +
          `hostname=${realmHostname} guest=${this.loginIsGuest}`
      )
    }

    this.sceneScript.setSignedFetchHandler(async (body) => {
      const res = await performSignedFetch(body, this.session.getAuthIdentity(), {
        ...this.signedFetchSceneContext!,
        isGuest: this.loginIsGuest
      })
      maybeLogLiveSceneAdminSignedFetch(
        body.url,
        res.status,
        res.ok,
        res.body ?? '',
        this.session.getAddress() ?? null
      )
      return res
    })
    this.sceneScript.setSignedFetchGetHeadersHandler(async (body) =>
      performGetSignedHeaders(body, this.session.getAuthIdentity(), {
        ...this.signedFetchSceneContext!,
        isGuest: this.loginIsGuest
      })
    )
  }

  /**
   * COD: getUserData.userId, PlayerIdentityData.address, and session wallet must match
   * (lowercased). Then probe gatekeeper scene-admin the same way Admin Tools does.
   */
  private runAdminToolsDiagnostics(label: string): void {
    const wallet = this.session.getAddress()?.trim().toLowerCase() || null
    const userData = this.buildUserData()
    const userId =
      typeof userData.data?.userId === 'string'
        ? userData.data.userId.trim().toLowerCase()
        : null
    const pid =
      this.sceneScript.getPlayerIdentity()?.address?.trim().toLowerCase() ?? null
    const realm = this.comms.getRealmInfo()
    const ctx = this.signedFetchSceneContext

    logAdminToolsIdentitySnapshot(
      {
        wallet,
        userId,
        playerIdentityAddress: pid,
        isGuest: this.loginIsGuest,
        hasAuthIdentity: !!this.session.getAuthIdentity(),
        isPreview: realm.isPreview === true,
        sceneId: ctx?.sceneId ?? '',
        parcel: ctx?.parcel ?? '',
        realmName: ctx?.realmName ?? realm.realmName ?? '',
        isWorld: ctx?.isWorld ?? false
      },
      label
    )

    void probeSceneAdminForAdminTools({
      identity: this.session.getAuthIdentity(),
      sceneContext: this.signedFetchSceneContext
        ? { ...this.signedFetchSceneContext, isGuest: this.loginIsGuest }
        : null,
      wallet,
      isPreview: realm.isPreview === true
    })
  }

  private buildUserData() {
    // COD: always lowercase — asset-packs compares userId.toLowerCase() to admin list.
    const addressRaw = this.session.getAddress()
    const address = addressRaw?.trim().toLowerCase() || null
    const profile = this.session.getProfile()
    const identity = this.session.getAuthIdentity()
    if (!this.buildUserDataLogged) {
      this.buildUserDataLogged = true
      console.info(
        `[auth] getUserData address=${address ? address.slice(0, 12) + '…' : 'NONE'} ` +
          `identity=${identity ? 'yes' : 'NO'} guest=${this.loginIsGuest} ` +
          `displayName=${profile?.displayName ?? (address ? 'wallet' : 'Guest')}`
      )
    }
    if (!address) {
      const guestId = getOrCreateGuestAddress().trim().toLowerCase()
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
        // Guest wallet-less identity still has address but not Web3.
        hasConnectedWeb3: !this.loginIsGuest,
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
