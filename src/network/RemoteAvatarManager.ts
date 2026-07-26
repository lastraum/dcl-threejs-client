import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import { AvatarAnimations } from '../avatar/AvatarAnimations'
import { composeAvatarFromProfile } from '../avatar/AvatarComposer'
import { disposeWearableInstance } from '../avatar/loadWearable'
import { AVATAR_YAW_OFFSET, BODY_SHAPE_URN, PEER_URL } from '../avatar/constants'
import { applyAvatarPivotOffset } from '../avatar/feetAlign'
import { findHeadBone, updateNameTagAnchor } from '../avatar/headAnchor'
import { defaultProfileIdentity, identityFromAvatarProfile, type ProfileIdentity } from '../avatar/displayName'
import {
  profileFromSerializedEntry,
  resolveRemotePeerProfile,
  seedCommsPeerProfile
} from '../avatar/peerApi'
import type { AvatarProfile, BodyShape } from '../avatar/types'
import { DCL_LOCOMOTION_DEFAULTS } from '../player/locomotion'
import {
  dclToThreeVec,
  dclYawToThreeYaw,
  threeToDclQuat,
  threeToDclVec,
  type DclTransformValues
} from '../bridge/dclTransform'
import { ReservedEntitiesSync } from '../bridge/ReservedEntitiesSync'
import type { AvatarSkeletonTarget } from '../avatar/AvatarAttachTargets'
import { avatarEntityFromAddress, type EntityStore } from '../bridge/EntityStore'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { NameTag } from '../client/ui/NameTag'
import { areSceneNameTagsVisible } from '../client/ui/nameTagVisibility'
import { resolveProfileEmote, loadResolvedProfileEmote } from '../avatar/profileEmotes'
import type { AssetCache } from '../rendering/AssetCache'
import { yieldToNextFrame } from '../rendering/mainThreadYield'
import {
  createRemoteAvatarPlaceholder,
  disposeRemoteAvatarPlaceholder
} from '../avatar/remotePlaceholder'
import { stabilizeSkinnedMeshes } from '../rendering/skinnedMeshInstance'
import { VrmAvatar } from '../avatar/vrm/VrmAvatar'
import { VrmLocomotionAnimations } from '../avatar/vrm/VrmLocomotionAnimations'
import { disposeVrmRoot, prepareCustomAvatarScene } from '../avatar/vrm/VrmLoader'
import { applyVrmPivotOffset } from '../avatar/vrm/vrmFeetAlign'
import { retargetGltfClipToVrm } from '../avatar/vrm/mixamoRetarget'
import { getVrmRamBytes, getVrmRamFormat } from '../avatar/vrm/vrmRamCache'
import type { CustomAvatarFormat } from '../avatar/vrm/constants'
import { OdkAvatar } from '../avatar/odk/OdkAvatar'
import { formatTag, odkNetInfo, odkNetWarn, shortAddr, shortHash } from '../avatar/odk/odkNetLog'
import { OdkLocomotionAnimations } from '../avatar/odk/OdkLocomotionAnimations'
import { disposeOdkRoot } from '../avatar/odk/OdkLoader'
import { applyOdkPivotOffset } from '../avatar/odk/odkFeetAlign'
import { applyOdkRestCorrection, retargetGltfClipToOdk } from '../avatar/odk/odkRetarget'
import type { AvatarTransformPayload } from './comms/types'
import type { LocomotionMode } from '../player/locomotion'
import { RemoteAvatarLoadQueue } from './RemoteAvatarLoadQueue'
import type { InteractiveNameTagHit } from '../client/ui/overlayHitTest'
import { buildPlayerMirrorIdentity } from '../bridge/playerMirrorIdentity'
import { GliderProp, GlideStateWire, glideStateWantsOpen } from '../avatar/GliderProp'
import { perfNoteComposeMs } from '../util/perfCounters'

/** Packet / lerp settle epsilon (meters / radians). */
const POSE_EPS = 0.02
const POSE_YAW_EPS = 0.02
const SPEED_IDLE = 0.08
/**
 * Name-tag distance cull with hysteresis — a hard 64m edge toggled every frame when
 * camera/peer jitter around the boundary (far pills "flickering like crazy").
 */
const NAME_TAG_SHOW_M2 = 56 * 56
const NAME_TAG_HIDE_M2 = 72 * 72
/** Full head-track every frame while moving inside this radius. */
const NAME_TAG_NEAR_M2 = 28 * 28
/** Far (but not culled) tags: refresh head anchor at most this often. */
const NAME_TAG_FAR_INTERVAL_MS = 200
/** Settled near tags: idle head bob is low-frequency — ~12 Hz is enough. */
const NAME_TAG_SETTLED_INTERVAL_MS = 80

/**
 * Update-rate bands for already-tracked peers (horizontal m).
 * Compose only starts ≤20 m (RemoteAvatarLoadQueue.LOAD_DISTANCE); models are never
 * unloaded for distance — mid/far only throttle pose/anim.
 * Bands sit inside/around the load radius so loaded nearby peers are not all full-rate.
 */
/**
 * LOD bands sit inside the 20 m load radius (RemoteAvatarLoadQueue.LOAD_DISTANCE).
 * Old near=14 m made almost every loaded plaza peer full-rate (mid annulus empty).
 * Near ≤8 m full rate · mid 8–20 m throttled · far >20 m pose only (pills / outside load).
 */
const LOD_NEAR_M2 = 8 * 8
const LOD_MID_M2 = 20 * 20
/** Mid band: ~20 Hz pose; anim only if moving / emote / air. */
const LOD_MID_INTERVAL_MS = 50
/** Far band: ~12 Hz pose; no skinned anim unless emote active. */
const LOD_FAR_INTERVAL_MS = 80
/**
 * Settled loco-idle (no emote): advance mixer at ~12 Hz.
 * Looping profile emotes always run full rate within allowAnim.
 */
const ANIM_SETTLED_INTERVAL_MS = 80
/**
 * After this many seconds without a pose-changing packet, snap horizontal speed to 0.
 * Idle senders only keepalive ~3s — without this, last walk speed keeps the walk clip alive.
 */
const WIRE_MOVE_STALE_S = 0.28
/** Max seconds to dead-reckon past last packet (wire ~100 ms). */
const EXTRAP_MAX_S = 0.14
/** Position follow rate while moving (higher = stickier to path, less lag). */
const POSE_FOLLOW_RATE = 14
/** Position settle rate when nearly idle. */
const POSE_SETTLE_RATE = 18
/**
 * Nearest loaded remotes that cast shadows (GPU budget).
 * Soft sun + multi-mesh wearables dominate submitTris — keep this small.
 */
const REMOTE_SHADOW_CASTERS = 3
const SHADOW_BUDGET_INTERVAL_MS = 250
/** Sphere radius for camera-frustum anim skip (avatar torso + a bit of headroom). */
const FRUSTUM_SKIP_RADIUS_M = 1.4

const _frustum = new THREE.Frustum()
const _projScreen = new THREE.Matrix4()
const _frustumSphere = new THREE.Sphere()

/** Distance cull with hysteresis — sticky visible state. */
function nameTagWantedForDist(
  prevWanted: boolean,
  dist2: number,
  hasLocalPlayerPos: boolean
): boolean {
  if (!hasLocalPlayerPos) return true
  if (prevWanted) return dist2 <= NAME_TAG_HIDE_M2
  return dist2 <= NAME_TAG_SHOW_M2
}

type RemotePeerRecord = {
  address: string
  entity: Entity
  root: THREE.Object3D
  pivot: THREE.Group
  nameTagAnchor: THREE.Object3D
  placeholder: THREE.Group | null
  model: THREE.Object3D | null
  animations: AvatarAnimations | null
  vrmAvatar: VrmAvatar | null
  vrmLocomotion: VrmLocomotionAnimations | null
  odkAvatar: OdkAvatar | null
  odkLocomotion: OdkLocomotionAnimations | null
  renderMode: 'dcl' | 'vrm' | 'odk'
  vrmContentHash: string | null
  customAvatarFormat: CustomAvatarFormat | null
  /** Content hash of the custom mesh actually mounted (may lag vrmContentHash during swaps). */
  vrmLoadedHash: string | null
  nameTag: NameTag | null
  identity: ProfileIdentity
  bodyShape: BodyShape
  loading: Promise<void> | null
  hasPosition: boolean
  /** AvatarModifierArea hide — keeps peer but invisible. */
  modifierHidden: boolean
  pendingProfile: AvatarProfile | null
  lastEmoteId: number
  activeEmoteUrn: string | null
  pendingEmote: string | null
  profileSignature: string | null
  deferredProfileReload: boolean
  targetPosition: THREE.Vector3
  velocity: THREE.Vector3
  receivedAt: number
  horizontalSpeed: number
  smoothedSpeed: number
  targetYaw: number
  currentYaw: number
  remoteGrounded: boolean
  remoteJumping: boolean
  jumpCount: number
  prevJumpCount: number
  doubleJumpTriggered: boolean
  verticalVelocity: number
  /** RFC4 Movement.glideState */
  glideState: number
  glider: GliderProp
  /** Cached head bone for name-tag follow (avoids traverse each frame). */
  headBone: THREE.Bone | null
  /** Last time name-tag anchor was recomputed (far throttle). */
  nameTagLastAnchorAt: number
  /** Hysteresis state for distance cull (avoids edge flicker). */
  nameTagWanted: boolean
  /** Last mid/far LOD pose/anim tick (performance.now). */
  lastLodUpdateAt: number
  /** Last settled-idle mixer tick (performance.now). */
  lastAnimUpdateAt: number
  /** Custom mesh mount attempts (setPeerVrmHash / VRM parse) — max 3 with backoff. */
  customMeshAttempts: number
  customMeshRetryTimer: ReturnType<typeof setTimeout> | null
}

/** Shared extrapolated pose goal (one peer at a time in update). */
const _extrapGoal = new THREE.Vector3()
/** Reused locomotion state — avoid per-peer object alloc every anim tick. */
const _locoState: {
  horizontalSpeed: number
  targetLocomotionSpeed: number
  grounded: boolean
  nearGround: boolean
  verticalVelocity: number
  locomotionMode: LocomotionMode
  jumping: boolean
  doubleJumping: boolean
  doubleJumpTriggered: boolean
  falling: boolean
  gliding: boolean
} = {
  horizontalSpeed: 0,
  targetLocomotionSpeed: 0,
  grounded: true,
  nearGround: true,
  verticalVelocity: 0,
  locomotionMode: 'walk',
  jumping: false,
  doubleJumping: false,
  doubleJumpTriggered: false,
  falling: false,
  gliding: false
}

function blankProfile(address: string): AvatarProfile {
  return {
    bodyShape: 'male',
    skin: '949494',
    hair: '3a3a3a',
    eyes: '3a3a3a',
    wearables: [BODY_SHAPE_URN.male],
    forceRender: [],
    emotes: [],
    fromWallet: false,
    address: address.toLowerCase()
  }
}

const REMOTE_LOCO_SPEED_CAP = DCL_LOCOMOTION_DEFAULTS.runSpeed * 1.15

function inferRemoteLocomotionMode(speed: number): LocomotionMode {
  if (speed > DCL_LOCOMOTION_DEFAULTS.runSpeed * 0.85) return 'run'
  if (speed > DCL_LOCOMOTION_DEFAULTS.jogSpeed * 0.35) return 'jog'
  return 'walk'
}

function remoteTargetLocomotionSpeed(mode: LocomotionMode): number {
  switch (mode) {
    case 'run':
      return DCL_LOCOMOTION_DEFAULTS.runSpeed
    case 'walk':
      return DCL_LOCOMOTION_DEFAULTS.walkSpeed
    default:
      return DCL_LOCOMOTION_DEFAULTS.jogSpeed
  }
}

function resolveRemoteHorizontalSpeed(
  posSpeed: number,
  velocity?: THREE.Vector3
): number {
  const cappedPos = Math.min(Math.max(0, posSpeed), REMOTE_LOCO_SPEED_CAP)
  if (!velocity) return cappedPos
  const wireHoriz = Math.hypot(velocity.x, velocity.z)
  if (wireHoriz > 0.03) return Math.min(wireHoriz, REMOTE_LOCO_SPEED_CAP)
  return cappedPos
}

/** Remote player avatars — blank body first, swap to Catalyst profile when ready. */
export class RemoteAvatarManager {
  private readonly root = new THREE.Group()
  private readonly peers = new Map<string, RemotePeerRecord>()
  private contentUrl = ''
  private lambdasUrl = ''
  private assetCache: AssetCache | null = null
  private readonly scene: THREE.Scene
  private readonly loadQueue = new RemoteAvatarLoadQueue()
  private readonly peerReloadSeq = new Map<string, number>()
  /**
   * setPeerVrmHash arrived before upsertPeer — retry apply up to 3× with backoff.
   * (DAV announce often beats LiveKit join on landing→World handoff.)
   */
  private readonly pendingVrmHash = new Map<
    string,
    {
      hash: string | null
      format: CustomAvatarFormat | null
      attempts: number
      timer: ReturnType<typeof setTimeout> | null
    }
  >()
  private static readonly PEER_MESH_MAX_ATTEMPTS = 3
  /** Backoff after attempt 1, 2 (attempt 3 is final). */
  private static readonly PEER_MESH_BACKOFF_MS = [500, 1500, 3500] as const
  private entityStore: EntityStore | null = null
  private localAddress: string | null = null
  /** Local player feet (Three world) — LOD / load / tags / shadows; not freecam. */
  private readonly localPlayerWorldPos = new THREE.Vector3()
  private hasLocalPlayerPos = false
  /** Active camera for frustum anim skip (looking away from a huddle). */
  private camera: THREE.Camera | null = null
  /** Scene-local feet for provisional peer placement until first transform arrives. */
  private provisionalPositionProvider: (() => THREE.Vector3 | null) | null = null
  /** Host→scene CRDT mirror for remote PlayerIdentityData / AvatarBase / AvatarEquippedData. */
  private onPeerMirrorIdentity:
    | ((entity: Entity, identity: ReturnType<typeof buildPlayerMirrorIdentity> | null) => void)
    | null = null
  /** Peers that were speaking last voice tick — zero their bars when they drop out of the map. */
  private readonly lastSpeakingPeers = new Set<string>()
  private lastShadowBudgetAt = 0
  /**
   * After a full remote compose finishes (main-thread hitch) — World refreshes CCT cache
   * so plaza solids aren't left soft after multi-second avatar work.
   */
  private onComposeSettled: (() => void) | null = null

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.root.name = 'remote-avatars'
    scene.add(this.root)
  }

  setOnComposeSettled(handler: (() => void) | null): void {
    this.onComposeSettled = handler
  }

  /**
   * Optional local feet (Three.js scene space). Peers that join without a pose yet
   * spawn a visible placeholder here instead of staying `visible=false` forever.
   */
  setProvisionalPositionProvider(provider: (() => THREE.Vector3 | null) | null): void {
    this.provisionalPositionProvider = provider
  }

  setPeerMirrorIdentityHandler(
    handler:
      | ((entity: Entity, identity: ReturnType<typeof buildPlayerMirrorIdentity> | null) => void)
      | null
  ): void {
    this.onPeerMirrorIdentity = handler
  }

  private pushPeerMirrorIdentity(record: RemotePeerRecord, profile: AvatarProfile | null): void {
    if (!this.onPeerMirrorIdentity) return
    if (!profile) {
      this.onPeerMirrorIdentity(record.entity, null)
      return
    }
    const emoteUrns = (profile.emotes ?? [])
      .map((e) => e.urn)
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
    const identity = buildPlayerMirrorIdentity({
      address: record.address,
      profile,
      displayName: record.identity.displayName
    })
    identity.emoteUrns = emoteUrns
    this.onPeerMirrorIdentity(record.entity, identity)
  }

  /** Phase 4.5 — register remote peers in the unified EntityStore (owner `'avatar'`). */
  setEntityStore(store: EntityStore | null): void {
    this.entityStore = store
  }

  setLocalAddress(address: string | null): void {
    this.localAddress = address?.toLowerCase() ?? null
  }

  private isLocalPeer(address: string): boolean {
    const key = address.toLowerCase()
    return !!this.localAddress && key === this.localAddress
  }

  /** Remote peers with a known scene position. */
  get visiblePeerCount(): number {
    let count = 0
    for (const record of this.peers.values()) {
      if (record.hasPosition) count++
    }
    return count
  }

  /** Remote peers with a composed model (not placeholder-only). */
  get loadedPeerCount(): number {
    let count = 0
    for (const record of this.peers.values()) {
      if (record.model) count++
    }
    return count
  }

  /** Peers that still need a full avatar compose (placeholder / loading). */
  get pendingComposePeerCount(): number {
    let count = 0
    for (const record of this.peers.values()) {
      if (!record.model || record.loading) count++
    }
    return count
  }

  /** Total remote peers tracked (any state). */
  get peerCount(): number {
    return this.peers.size
  }

  /**
   * Snapshot for HUD toast: how many remotes still need compose vs total present.
   * `queuePending` is load-queue depth (active + waiting).
   */
  getComposeProgress(): {
    total: number
    loaded: number
    pending: number
    queuePending: number
  } {
    const total = this.peers.size
    let loaded = 0
    for (const record of this.peers.values()) {
      if (record.model && !record.loading) loaded++
    }
    return {
      total,
      loaded,
      pending: Math.max(0, total - loaded),
      queuePending: this.loadQueue.getPendingComposeCount()
    }
  }

  /** In-flight full avatar composes (not waiting queue). */
  get activeComposeCount(): number {
    return this.loadQueue.getActiveComposeCount()
  }

  /** Waiting + in-flight compose jobs. */
  get composeQueueDepth(): number {
    return this.loadQueue.getPendingComposeCount()
  }

  setCatalystEndpoints(contentUrl: string, lambdasUrl: string): void {
    this.contentUrl = contentUrl.replace(/\/$/, '')
    this.lambdasUrl = lambdasUrl.replace(/\/$/, '')
  }

  setAssetCache(cache: AssetCache | null): void {
    this.assetCache = cache
  }

  /**
   * Distance reference for load radius, LOD, name tags, and shadow budget.
   * Must be **local player feet** (not orbit/freecam) so looking away does not unload peers.
   */
  setLocalPlayerPosition(position: THREE.Vector3): void {
    this.localPlayerWorldPos.copy(position)
    this.hasLocalPlayerPos = true
    this.loadQueue.setLocalPlayerPosition(position)
    // Follow teleports re-push island peers before local player exists — root stays
    // invisible (hasPosition=false). Once we have feet origin, place pills.
    this.backfillProvisionalPeers()
    // Walking toward pills: refresh waiting distances; only enqueue peers not yet queued.
    // Do not re-enqueue every frame — that allocated a new run() closure + Vector3.clone each peer.
    let bulkDistance = false
    for (const [key, record] of this.peers) {
      if (record.model || !record.hasPosition) continue
      if (this.loadQueue.isQueued(key)) {
        this.loadQueue.updatePeerDistance(key, record.targetPosition, false)
        bulkDistance = true
      } else {
        this.tryStartAvatarLoad(key, record)
      }
    }
    if (bulkDistance) this.loadQueue.notifyPump()
  }

  /** @deprecated use {@link setLocalPlayerPosition} */
  setCameraPosition(position: THREE.Vector3): void {
    this.setLocalPlayerPosition(position)
  }

  /** Camera used for off-screen remote anim skip (orbit / freecam / player cam). */
  setViewCamera(camera: THREE.Camera | null): void {
    this.camera = camera
  }

  /**
   * Peers joined before local feet were ready (World rebuild / follow /goto): show
   * provisional pills so remotes are not invisible until the first RFC4 transform.
   */
  backfillProvisionalPeers(): void {
    const provisional = this.provisionalPositionProvider?.()
    if (!provisional) return
    for (const record of this.peers.values()) {
      if (record.hasPosition) continue
      if (record.modifierHidden) continue
      record.root.position.copy(provisional)
      record.targetPosition.copy(provisional)
      record.root.visible = true
      record.hasPosition = true
      if (!record.model && !record.placeholder) {
        this.attachLoadingPresentation(record)
      }
    }
  }

  /** Scene asset hydration — throttle remote composes so scene GLTF attach wins. */
  setHydrationLoading(active: boolean): void {
    this.loadQueue.setHydrationMode(active)
  }

  /**
   * Begin remote avatar pipeline after spawn/play-ready.
   * Full composes stay held briefly (collider pose resync / CCT) then plaza-staggered.
   */
  setPlayReady(plazaScale = false): void {
    this.loadQueue.setPlayReady(plazaScale)
    clientDebugLog.log(
      'network',
      `Remote avatars: collider-hold then 1 compose / 10s${plazaScale ? ' (plaza)' : ''}`,
      { alsoConsole: true, throttleMs: 30_000 }
    )
  }

  setSceneAssetPressure(gltfInflight: number, textureInflight = 0): void {
    this.loadQueue.setSceneAssetPressure(gltfInflight, textureInflight)
  }

  /** Pause starting new remote composes while local emote GLB is loading (no visibility cap). */
  setLocalEmoteLoadBusy(busy: boolean): void {
    this.loadQueue.setLocalEmoteLoadBusy(busy)
  }

  getAttachSkeleton(address: string): AvatarSkeletonTarget | null {
    const record = this.peers.get(address.toLowerCase())
    if (!record) return null
    const model = record.model ?? record.placeholder
    if (!model) return null
    return { model, nameTagAnchor: record.nameTagAnchor }
  }

  /** Scene chat line shown inside the peer's overhead name-tag pill. */
  showPeerNameTagChat(address: string, text: string): void {
    if (!areSceneNameTagsVisible()) return
    const record = this.peers.get(address.toLowerCase())
    record?.nameTag?.showChat(text)
  }

  /** Local-only private message overhead on a remote (incoming: "Name DM"). */
  showPeerNameTagDmChat(
    address: string,
    text: string,
    options: { mode: 'outgoing' | 'incoming'; peerName?: string } = { mode: 'incoming' }
  ): void {
    if (!areSceneNameTagsVisible()) return
    const record = this.peers.get(address.toLowerCase())
    record?.nameTag?.showDmChat(text, options)
  }

  /** Nearby-voice bars on remote name tags (address → 0–1 level). */
  applyVoiceLevels(levels: ReadonlyMap<string, number>): void {
    const speaking = new Set<string>()
    for (const [key, level] of levels) {
      const record = this.peers.get(key)
      if (!record?.nameTag) continue
      record.nameTag.setVoiceLevel(level)
      if (level > 0.02) speaking.add(key)
    }
    // Zero bars for peers that stopped appearing in the levels map.
    for (const key of this.lastSpeakingPeers) {
      if (speaking.has(key) || levels.has(key)) continue
      this.peers.get(key)?.nameTag?.setVoiceLevel(0)
    }
    this.lastSpeakingPeers.clear()
    for (const key of speaking) this.lastSpeakingPeers.add(key)
  }

  /**
   * Screen-space hit on a remote avatar body — used for pointer-lock pill hover.
   * Returns the peer's CSS2D pill element when the cursor is over the projected bounds.
   */
  findPeerNearScreenPoint(
    clientX: number,
    clientY: number,
    camera: THREE.Camera | null,
    slopPx = 28
  ): InteractiveNameTagHit | null {
    if (!camera) return null
    const canvas = document.querySelector('#app canvas') as HTMLCanvasElement | null
    if (!canvas) return null
    const canvasRect = canvas.getBoundingClientRect()
    if (canvasRect.width <= 0 || canvasRect.height <= 0) return null

    const _projected = new THREE.Vector3()
    const _box = new THREE.Box3()
    let best: { hit: InteractiveNameTagHit; score: number } | null = null

    for (const [address, record] of this.peers.entries()) {
      if (!record.hasPosition) continue
      const body = record.model ?? record.placeholder
      if (!body) continue

      body.updateWorldMatrix(true, true)
      _box.setFromObject(body)
      if (_box.isEmpty()) continue
      _box.expandByScalar(0.08)

      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const corner of boxCornerPoints(_box)) {
        _projected.copy(corner).project(camera)
        const sx = canvasRect.left + (_projected.x * 0.5 + 0.5) * canvasRect.width
        const sy = canvasRect.top + (-_projected.y * 0.5 + 0.5) * canvasRect.height
        minX = Math.min(minX, sx)
        maxX = Math.max(maxX, sx)
        minY = Math.min(minY, sy)
        maxY = Math.max(maxY, sy)
      }

      const inBounds =
        clientX >= minX - slopPx &&
        clientX <= maxX + slopPx &&
        clientY >= minY - slopPx &&
        clientY <= maxY + slopPx
      if (!inBounds) continue

      const element = document.querySelector<HTMLElement>(
        `.avatar-name-tag--interactive[data-peer-address="${address}"]`
      )
      if (!element) continue

      const cx = (minX + maxX) * 0.5
      const cy = (minY + maxY) * 0.5
      const score = Math.hypot(clientX - cx, clientY - cy)
      if (!best || score < best.score) {
        best = { hit: { address, element }, score }
      }
    }

    return best?.hit ?? null
  }

  getPlayerTransformDclForAddress(address: string): DclTransformValues | null {
    const record = this.peers.get(address.toLowerCase())
    if (!record || !record.hasPosition) return null
    const pos = threeToDclVec(record.root.position)
    const rot = threeToDclQuat(ReservedEntitiesSync.playerRotationFromYaw(record.currentYaw))
    return {
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotation: { x: rot.x, y: rot.y, z: rot.z, w: rot.w },
      scale: { x: 1, y: 1, z: 1 }
    }
  }

  /**
   * Peer scene root for spatial voice (PositionalAudio parent).
   * Only when we have a real pose — avoids blasting audio at origin.
   */
  getPeerRoot(address: string): THREE.Object3D | null {
    const record = this.peers.get(address.toLowerCase())
    if (!record || !record.hasPosition) return null
    return record.root
  }

  /** Visual body yaw in Three space (includes AVATAR_YAW_OFFSET). */
  getPeerYaw(address: string): number | null {
    const record = this.peers.get(address.toLowerCase())
    if (!record || !record.hasPosition) return null
    return record.currentYaw + AVATAR_YAW_OFFSET
  }

  /** World Y of the peer nametag anchor (for tour flag badge above the name). */
  getPeerNameTagWorldY(address: string): number | null {
    const record = this.peers.get(address.toLowerCase())
    if (!record || !record.hasPosition) return null
    record.nameTagAnchor.updateWorldMatrix(true, false)
    const y = record.nameTagAnchor.getWorldPosition(new THREE.Vector3()).y
    return Number.isFinite(y) ? y : null
  }

  /**
   * Photo-mode metadata samples — remotes with a pose (world-space feet/root).
   * Frustum tests happen in photoMetadata.peopleInPhotoFrustum.
   */
  collectPhotoPeopleSamples(): Array<{
    address: string
    displayName: string
    isGuest: boolean
    isEmoting: boolean
    hasClaimedName: boolean
    nameColor?: string
    faceUrl?: string | null
    wearables: string[]
    worldPosition: THREE.Vector3
    radius: number
  }> {
    const out: Array<{
      address: string
      displayName: string
      isGuest: boolean
      isEmoting: boolean
      hasClaimedName: boolean
      nameColor?: string
      faceUrl?: string | null
      wearables: string[]
      worldPosition: THREE.Vector3
      radius: number
    }> = []
    for (const [key, record] of this.peers) {
      if (!record.hasPosition || record.modifierHidden) continue
      const pos = new THREE.Vector3()
      record.root.getWorldPosition(pos)
      const emoting =
        record.renderMode === 'vrm'
          ? !!record.vrmLocomotion?.isProfileEmoteActive()
          : record.renderMode === 'odk'
            ? !!record.odkLocomotion?.isProfileEmoteActive()
            : !!record.animations?.isProfileEmoteActive()
      const profile = record.pendingProfile
      out.push({
        address: key,
        displayName: record.identity.displayName,
        isGuest: !record.identity.hasClaimedName && !profile?.fromWallet,
        isEmoting: emoting || !!record.activeEmoteUrn,
        hasClaimedName: !!record.identity.hasClaimedName,
        nameColor: record.identity.nameColor ?? profile?.nameColor,
        faceUrl: null,
        wearables: profile?.wearables ? [...profile.wearables] : [],
        worldPosition: pos,
        radius: 1.0
      })
    }
    return out
  }

  /** AvatarModifierArea samples — DCL feet positions for remotes with a known pose. */
  collectModifierSamples(out: { id: string; position: { x: number; y: number; z: number } }[]): void {
    for (const [key, record] of this.peers) {
      if (!record.hasPosition) continue
      const pos = threeToDclVec(record.root.position)
      out.push({ id: key, position: { x: pos.x, y: pos.y, z: pos.z } })
    }
  }

  /**
   * AvatarModifierArea AMT_HIDE_AVATARS — hide mesh + name tag for this peer.
   * Does not remove the peer record (still receives movement).
   */
  setModifierHidden(address: string, hidden: boolean): void {
    const record = this.peers.get(address.toLowerCase())
    if (!record) return
    record.modifierHidden = hidden
    if (record.hasPosition && !hidden) {
      record.root.visible = true
    } else if (hidden) {
      record.root.visible = false
    }
    record.glider.setBodyVisible(!hidden)
    if (record.nameTag) {
      record.nameTag.object.visible = !hidden && areSceneNameTagsVisible()
    }
  }

  setPeerVrmHash(
    address: string,
    contentHash: string | null,
    format: CustomAvatarFormat | null = null
  ): void {
    const key = address.toLowerCase()
    const record = this.peers.get(key)
    if (!record) {
      // Announce can land before LiveKit join / upsertPeer — queue with 3-try backoff.
      this.queuePendingVrmHash(key, contentHash, format)
      return
    }
    this.clearPendingVrmHash(key)
    this.applyPeerVrmHash(key, record, contentHash, format)
  }

  private applyPeerVrmHash(
    key: string,
    record: RemotePeerRecord,
    contentHash: string | null,
    format: CustomAvatarFormat | null
  ): void {
    const normalized = contentHash?.toLowerCase() ?? null
    const resolvedFormat = normalized ? (format ?? record.customAvatarFormat ?? 'vrm') : null
    if (record.vrmContentHash === normalized && record.customAvatarFormat === resolvedFormat) {
      if (
        normalized &&
        record.vrmLoadedHash === normalized &&
        (record.vrmAvatar || record.odkAvatar)
      ) {
        odkNetInfo('setPeerVrmHash — already mounted', {
          peer: shortAddr(key),
          format: formatTag(resolvedFormat),
          hash: shortHash(normalized),
          renderMode: record.renderMode
        })
        this.clearCustomMeshRetry(record)
        record.customMeshAttempts = 0
        return
      }
      if (!normalized && record.renderMode === 'dcl') return
    }
    // New equip target — reset mount retry budget.
    if (record.vrmContentHash !== normalized) {
      this.clearCustomMeshRetry(record)
      record.customMeshAttempts = 0
    }
    record.vrmContentHash = normalized
    record.customAvatarFormat = resolvedFormat
    if (!normalized) {
      odkNetInfo('setPeerVrmHash — peer cleared custom avatar', {
        peer: shortAddr(key),
        wasMode: record.renderMode
      })
      this.clearCustomMeshRetry(record)
      record.customMeshAttempts = 0
      if (record.renderMode === 'vrm' || record.renderMode === 'odk') {
        void this.reloadPeerAvatar(key, record)
      }
      return
    }
    const ramReady = !!getVrmRamBytes(normalized)
    odkNetInfo('setPeerVrmHash — reload scheduled', {
      peer: shortAddr(key),
      format: formatTag(resolvedFormat),
      hash: shortHash(normalized),
      ramReady,
      wasMode: record.renderMode,
      attempt: record.customMeshAttempts + 1
    })
    // No bytes yet: keep an existing DCL body as interim (avoid pill forever while DAV fails).
    // Still kick a first load if we have no model at all.
    if (!ramReady) {
      if (record.model && record.renderMode === 'dcl') {
        // Hash is known but bytes not in RAM — ensure we aren't stuck after a failed
        // first fetch (login). Retry custom mesh when RAM eventually fills.
        this.scheduleCustomMeshRetry(key, record, 'waiting-for-dav-bytes')
        return
      }
      if (!record.model) {
        void this.tryStartAvatarLoad(key, record, true)
      }
      return
    }
    void this.reloadPeerAvatar(key, record)
  }

  private queuePendingVrmHash(
    key: string,
    contentHash: string | null,
    format: CustomAvatarFormat | null
  ): void {
    const existing = this.pendingVrmHash.get(key)
    if (existing?.timer) clearTimeout(existing.timer)
    const attempts = existing?.attempts ?? 0
    const next: {
      hash: string | null
      format: CustomAvatarFormat | null
      attempts: number
      timer: ReturnType<typeof setTimeout> | null
    } = {
      hash: contentHash?.toLowerCase() ?? null,
      format,
      attempts,
      timer: null
    }
    this.pendingVrmHash.set(key, next)

    if (attempts >= RemoteAvatarManager.PEER_MESH_MAX_ATTEMPTS) {
      odkNetWarn('setPeerVrmHash — gave up waiting for peer record (3 tries)', {
        peer: shortAddr(key),
        format: formatTag(format),
        hash: shortHash(contentHash)
      })
      return
    }

    const delay =
      RemoteAvatarManager.PEER_MESH_BACKOFF_MS[
        Math.min(attempts, RemoteAvatarManager.PEER_MESH_BACKOFF_MS.length - 1)
      ] ?? 3500
    odkNetWarn('setPeerVrmHash — no remote peer record yet, will retry', {
      peer: shortAddr(key),
      format: formatTag(format),
      hash: shortHash(contentHash),
      attempt: attempts + 1,
      retryMs: delay
    })
    next.timer = setTimeout(() => {
      next.timer = null
      next.attempts += 1
      const record = this.peers.get(key)
      if (record) {
        this.pendingVrmHash.delete(key)
        this.applyPeerVrmHash(key, record, next.hash, next.format)
        return
      }
      // Still no record — re-queue (increments attempts).
      this.queuePendingVrmHash(key, next.hash, next.format)
    }, delay)
  }

  private flushPendingVrmHash(key: string): void {
    const pending = this.pendingVrmHash.get(key)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingVrmHash.delete(key)
    const record = this.peers.get(key)
    if (!record) return
    this.applyPeerVrmHash(key, record, pending.hash, pending.format)
  }

  private clearPendingVrmHash(key: string): void {
    const pending = this.pendingVrmHash.get(key)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingVrmHash.delete(key)
  }

  private clearCustomMeshRetry(record: RemotePeerRecord): void {
    if (record.customMeshRetryTimer) {
      clearTimeout(record.customMeshRetryTimer)
      record.customMeshRetryTimer = null
    }
  }

  /**
   * After a custom mesh parse/mount failure — retry up to 3× with backoff, then DCL fallback.
   * Keeps vrmContentHash so a later successful DAV re-fetch can still win.
   */
  private scheduleCustomMeshRetry(key: string, record: RemotePeerRecord, reason: string): void {
    if (!record.vrmContentHash) return
    if (record.customMeshAttempts >= RemoteAvatarManager.PEER_MESH_MAX_ATTEMPTS) {
      odkNetWarn('custom mesh mount gave up after 3 tries — DCL fallback', {
        peer: shortAddr(key),
        hash: shortHash(record.vrmContentHash),
        reason
      })
      const hash = record.vrmContentHash
      record.vrmContentHash = null
      record.vrmLoadedHash = null
      record.customAvatarFormat = null
      record.renderMode = 'dcl'
      this.clearCustomMeshRetry(record)
      record.customMeshAttempts = 0
      // Must go through the load queue (MAX_CONCURRENT=1 / 10s stagger) — never call
      // loadPeerAvatar outside a queue run() callback (plaza hitch under multi-peer DAV fail).
      void this.reloadPeerAvatar(key, record)
      void hash
      return
    }
    const attempt = record.customMeshAttempts
    const delay =
      RemoteAvatarManager.PEER_MESH_BACKOFF_MS[
        Math.min(attempt, RemoteAvatarManager.PEER_MESH_BACKOFF_MS.length - 1)
      ] ?? 3500
    this.clearCustomMeshRetry(record)
    odkNetInfo('custom mesh mount retry scheduled', {
      peer: shortAddr(key),
      hash: shortHash(record.vrmContentHash),
      attempt: attempt + 1,
      retryMs: delay,
      reason
    })
    record.customMeshRetryTimer = setTimeout(() => {
      record.customMeshRetryTimer = null
      if (!this.peers.has(key) || !record.vrmContentHash) return
      if (record.hasPosition && !record.placeholder && !record.model) {
        this.attachLoadingPresentation(record)
      }
      void this.reloadPeerAvatar(key, record)
    }, delay)
  }

  onPeerVrmBytesReady(
    address: string,
    contentHash: string,
    format: CustomAvatarFormat = 'vrm'
  ): void {
    const key = address.toLowerCase()
    const record = this.peers.get(key)
    if (!record) {
      // Bytes arrived before peer record — same 3-try path as setPeerVrmHash.
      this.queuePendingVrmHash(key, contentHash, format)
      return
    }
    this.clearPendingVrmHash(key)
    const hash = contentHash.toLowerCase()
    if (!record.vrmContentHash) {
      record.vrmContentHash = hash
      record.customAvatarFormat = format
    } else if (record.vrmContentHash !== hash) {
      odkNetWarn('onPeerVrmBytesReady — hash mismatch, ignoring', {
        peer: shortAddr(key),
        expected: shortHash(record.vrmContentHash),
        got: shortHash(hash),
        format: formatTag(format)
      })
      return
    } else if (!record.customAvatarFormat) {
      record.customAvatarFormat = format
    }
    if (
      record.vrmLoadedHash === hash &&
      ((record.renderMode === 'vrm' && record.vrmAvatar) ||
        (record.renderMode === 'odk' && record.odkAvatar))
    ) {
      odkNetInfo('onPeerVrmBytesReady — already mounted', {
        peer: shortAddr(key),
        format: formatTag(format),
        hash: shortHash(hash),
        renderMode: record.renderMode
      })
      this.clearCustomMeshRetry(record)
      record.customMeshAttempts = 0
      return
    }
    odkNetInfo('onPeerVrmBytesReady — reload scheduled', {
      peer: shortAddr(key),
      format: formatTag(record.customAvatarFormat ?? format),
      hash: shortHash(hash),
      bytes: getVrmRamBytes(hash)?.byteLength ?? 0
    })
    void this.reloadPeerAvatar(key, record)
  }

  playPeerEmote(address: string, emoteRef: string, incrementalId: number): void {
    const key = address.toLowerCase()
    const record = this.peers.get(key)
    if (!record || incrementalId <= record.lastEmoteId) return
    record.lastEmoteId = incrementalId

    const normalizedRef = emoteRef.trim().toLowerCase()
    const emoteActive =
      record.renderMode === 'vrm'
        ? record.vrmLocomotion?.isProfileEmoteActive()
        : record.renderMode === 'odk'
          ? record.odkLocomotion?.isProfileEmoteActive()
          : record.animations?.isProfileEmoteActive()
    if (record.activeEmoteUrn === normalizedRef && emoteActive) {
      return
    }

    if (!record.model || (record.renderMode === 'dcl' && !record.animations)) {
      record.pendingEmote = emoteRef
      return
    }
    void this.applyPeerEmote(record, emoteRef)
  }

  upsertPeer(address: string, positionDcl?: THREE.Vector3): void {
    const key = address.toLowerCase()
    if (this.isLocalPeer(key)) return
    let record = this.peers.get(key)
    if (!record) {
      const entity = avatarEntityFromAddress(key)
      const root = this.entityStore?.upsertAvatar(entity) ?? new THREE.Object3D()
      root.name = `remote-${key.slice(0, 8)}`
      root.visible = false
      const pivot = new THREE.Group()
      pivot.name = 'remote-pivot'
      const nameTagAnchor = new THREE.Object3D()
      nameTagAnchor.name = 'remote-name-tag'
      root.add(pivot)
      root.add(nameTagAnchor)
      if (!this.entityStore) this.root.add(root)

      record = {
        address: key,
        entity,
        root,
        pivot,
        nameTagAnchor,
        placeholder: null,
        model: null,
        animations: null,
        vrmAvatar: null,
        vrmLocomotion: null,
        odkAvatar: null,
        odkLocomotion: null,
        renderMode: 'dcl',
        vrmContentHash: null,
        customAvatarFormat: null,
        vrmLoadedHash: null,
        nameTag: null,
        identity: defaultProfileIdentity(key.slice(0, 8)),
        bodyShape: 'male',
        loading: null,
        hasPosition: false,
        modifierHidden: false,
        pendingProfile: null,
        lastEmoteId: 0,
        activeEmoteUrn: null,
        pendingEmote: null,
        profileSignature: null,
        deferredProfileReload: false,
        targetPosition: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        receivedAt: performance.now(),
        horizontalSpeed: 0,
        smoothedSpeed: 0,
        targetYaw: 0,
        currentYaw: 0,
        remoteGrounded: true,
        remoteJumping: false,
        jumpCount: 0,
        prevJumpCount: 0,
        doubleJumpTriggered: false,
        verticalVelocity: 0,
        glideState: GlideStateWire.PROP_CLOSED,
        glider: new GliderProp(),
        headBone: null,
        nameTagLastAnchorAt: 0,
        nameTagWanted: false,
        lastLodUpdateAt: 0,
        lastAnimUpdateAt: 0,
        customMeshAttempts: 0,
        customMeshRetryTimer: null
      }
      this.peers.set(key, record)
      void record.glider.attach(record.pivot)
      odkNetInfo('remote peer record created', { peer: shortAddr(key) })
      // Flush DAV equip that arrived before the peer record existed.
      this.flushPendingVrmHash(key)
    }

    if (positionDcl) {
      const position = dclToThreeVec(positionDcl)
      record.hasPosition = true
      record.targetPosition.copy(position)
      record.root.position.copy(position)
      record.root.visible = !record.modifierHidden
      if (!record.model && !record.placeholder) {
        this.attachLoadingPresentation(record)
      }
    } else if (!record.hasPosition) {
      // Join without pose (common right after island LiveKit connect): show a
      // provisional pill near the local player so remotes are not "invisible".
      // Do NOT compose yet — provisional is colocated with local, which would pass
      // the ≤20 m gate (or force-park at camera) and permanently load far peers.
      // First real RFC4 transform in updatePeerTransform starts the queue.
      // hasPosition stays false so we don't treat provisional as a real pose (avoids
      // "stuck next to me" when the first transform is delayed on empty-land islands).
      const provisional = this.provisionalPositionProvider?.()
      if (provisional) {
        record.root.position.copy(provisional)
        record.targetPosition.copy(provisional)
        record.root.visible = !record.modifierHidden
        if (!record.model && !record.placeholder) {
          this.attachLoadingPresentation(record)
        }
      }
    }

    // Real pose only — never force-compose provisional joins (steals slots + far skinned bodies).
    if (positionDcl) {
      this.tryStartAvatarLoad(key, record, false)
    }
  }

  applyPeerProfile(address: string, serializedProfile: string): void {
    const key = address.toLowerCase()
    if (this.isLocalPeer(key)) return
    const profile = profileFromSerializedEntry(serializedProfile, key)
    if (!profile) return

    let record = this.peers.get(key)
    if (!record) {
      this.upsertPeer(key)
      record = this.peers.get(key)
    }
    if (!record) return

    if (record.profileSignature === serializedProfile) return

    seedCommsPeerProfile(key, serializedProfile)
    record.pendingProfile = profile
    record.profileSignature = serializedProfile
    record.bodyShape = profile.bodyShape
    record.identity = identityFromAvatarProfile(profile, key)
    this.pushPeerMirrorIdentity(record, profile)
    if (!record.model && record.hasPosition) {
      this.attachLoadingPresentation(record)
    }
    if (record.model) {
      if (record.animations?.isProfileEmoteActive()) {
        record.deferredProfileReload = true
        return
      }
      void this.reloadPeerAvatar(key, record)
    } else {
      this.tryStartAvatarLoad(key, record)
    }
  }

  removePeer(address: string): void {
    const key = address.toLowerCase()
    const record = this.peers.get(key)
    if (!record) {
      this.clearPendingVrmHash(key)
      return
    }
    this.loadQueue.cancel(key)
    this.clearPendingVrmHash(key)
    this.clearCustomMeshRetry(record)
    record.glider.dispose()
    this.disposePeerModel(record)
    record.nameTag?.dispose()
    this.pushPeerMirrorIdentity(record, null)
    if (this.entityStore) {
      this.entityStore.removeAvatar(record.entity)
    } else {
      record.root.removeFromParent()
    }
    this.peerReloadSeq.delete(key)
    this.peers.delete(key)
  }

  updatePeerTransform(
    address: string,
    positionDcl: THREE.Vector3,
    yawDcl: number,
    velocity?: THREE.Vector3,
    locomotion?: Pick<AvatarTransformPayload, 'isGrounded' | 'isJumping' | 'jumpCount' | 'glideState'>
  ): void {
    const key = address.toLowerCase()
    if (this.isLocalPeer(key)) return
    const position = dclToThreeVec(positionDcl)
    const yaw = dclYawToThreeYaw(yawDcl)
    if (!this.peers.has(key)) {
      this.upsertPeer(key, positionDcl)
      clientDebugLog.log(
        'network',
        `Remote peer first transform · ${key.slice(0, 8)}… dcl=(${positionDcl.x.toFixed(1)},${positionDcl.y.toFixed(1)},${positionDcl.z.toFixed(1)}) three=(${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)})`,
        { throttleMs: 0, throttleKey: `first-pos:${key}` }
      )
      return
    }
    const record = this.peers.get(key)
    if (!record) return

    const now = performance.now()
    const prevTargetX = record.targetPosition.x
    const prevTargetY = record.targetPosition.y
    const prevTargetZ = record.targetPosition.z
    const prevVy = record.verticalVelocity

    // Keepalive / unchanged pose: skip velocity recompute + target write (Phase B pose skip).
    if (record.hasPosition) {
      const samePose =
        Math.hypot(position.x - prevTargetX, position.y - prevTargetY, position.z - prevTargetZ) <=
          POSE_EPS && Math.abs(yaw - record.targetYaw) <= POSE_YAW_EPS
      const wireHoriz = velocity ? Math.hypot(velocity.x, velocity.z) : 0
      const wireBusy =
        wireHoriz > 0.05 ||
        (velocity !== undefined && Math.abs(velocity.y) > 1.5) ||
        (locomotion?.isJumping === true) ||
        (typeof locomotion?.jumpCount === 'number' && locomotion.jumpCount > 0) ||
        (locomotion?.glideState !== undefined &&
          locomotion.glideState !== record.glideState &&
          locomotion.glideState !== GlideStateWire.PROP_CLOSED)
      const locoChanged =
        !!locomotion &&
        ((locomotion.isGrounded !== undefined && locomotion.isGrounded !== record.remoteGrounded) ||
          (locomotion.isJumping !== undefined && locomotion.isJumping !== record.remoteJumping) ||
          (locomotion.jumpCount !== undefined && locomotion.jumpCount !== record.jumpCount) ||
          (locomotion.glideState !== undefined && locomotion.glideState !== record.glideState))

      if (samePose && !wireBusy && !locoChanged) {
        // Do NOT refresh receivedAt — keepalives must not invalidate settle (ageS).
        // Snap loco speed so walk clip does not linger until the next 3s keepalive.
        if (record.horizontalSpeed > SPEED_IDLE) record.horizontalSpeed = 0
        if (record.smoothedSpeed > SPEED_IDLE) record.smoothedSpeed = 0
        if (record.velocity.x !== 0 || record.velocity.y !== 0 || record.velocity.z !== 0) {
          record.velocity.set(0, 0, 0)
        }
        if (velocity) record.verticalVelocity = velocity.y
        // Provisional joins may first wire at the same colocated pose — still start compose.
        if (!record.model) {
          this.loadQueue.updatePeerDistance(key, record.targetPosition)
          this.tryStartAvatarLoad(key, record)
        }
        return
      }
    }

    const dt = (now - record.receivedAt) / 1000

    if (record.hasPosition && dt > 0.001) {
      const dx = position.x - prevTargetX
      const dy = position.y - prevTargetY
      const dz = position.z - prevTargetZ
      const dist = Math.hypot(dx, dy, dz)
      const posSpeed = dist / dt
      record.horizontalSpeed = resolveRemoteHorizontalSpeed(posSpeed, velocity)
      record.velocity.set(dx / dt, dy / dt, dz / dt)
      if (!velocity) {
        record.verticalVelocity = record.velocity.y
      }
    } else if (velocity) {
      record.horizontalSpeed = resolveRemoteHorizontalSpeed(0, velocity)
    }

    if (locomotion) {
      if (locomotion.isGrounded !== undefined) {
        record.remoteGrounded = locomotion.isGrounded
        if (locomotion.isGrounded) {
          record.jumpCount = 0
          record.prevJumpCount = 0
        }
      }
      if (locomotion.isJumping !== undefined) record.remoteJumping = locomotion.isJumping
      if (locomotion.jumpCount !== undefined) {
        record.prevJumpCount = record.jumpCount
        record.jumpCount = locomotion.jumpCount
        if (record.jumpCount >= 2 && record.prevJumpCount < 2) {
          record.doubleJumpTriggered = true
        }
      }
      if (locomotion.glideState !== undefined) {
        record.glideState = locomotion.glideState
        record.glider.setGlideState(locomotion.glideState)
      }
    } else if (velocity && velocity.y > 6 && prevVy <= 3 && !record.remoteGrounded) {
      record.doubleJumpTriggered = true
      record.jumpCount = Math.max(record.jumpCount, 2)
    }

    if (velocity) {
      record.verticalVelocity = velocity.y
      if (velocity.y > 2) record.remoteJumping = true
    }

    if (!record.hasPosition) {
      record.root.position.copy(position)
      record.root.visible = !record.modifierHidden
    }

    record.hasPosition = true
    record.targetPosition.copy(position)
    record.targetYaw = yaw
    record.receivedAt = now

    this.loadQueue.updatePeerDistance(key, record.targetPosition)
    this.tryStartAvatarLoad(key, record)
  }

  /**
   * Per-frame remote tick. Returns counters for RenderStats / perfCounters.
   */
  update(delta: number): {
    poseSkipped: number
    animSkipped: number
    nameTagsShown: number
    remoteUpdateMs: number
    remoteAnimMs: number
    lodNear: number
    lodMid: number
    lodFar: number
  } {
    const updateT0 = performance.now()
    const now = updateT0
    let poseSkipped = 0
    let animSkipped = 0
    let nameTagsShown = 0
    let animMs = 0
    let lodNear = 0
    let lodMid = 0
    let lodFar = 0
    const tagsAllowed = areSceneNameTagsVisible()

    if (now - this.lastShadowBudgetAt >= SHADOW_BUDGET_INTERVAL_MS) {
      this.lastShadowBudgetAt = now
      this.applyRemoteShadowBudget()
    }

    // One frustum for the whole peer tick — skip skinned anim for off-camera remotes.
    let frustumReady = false
    if (this.camera) {
      this.camera.updateMatrixWorld(false)
      _projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      _frustum.setFromProjectionMatrix(_projScreen)
      frustumReady = true
    }

    for (const [key, record] of this.peers.entries()) {
      const remoteGlidingEarly =
        glideStateWantsOpen(record.glideState) ||
        record.glideState === GlideStateWire.CLOSING_PROP
      const emoteBusy = !!record.activeEmoteUrn
      const airBusy =
        record.remoteJumping ||
        record.jumpCount > 0 ||
        remoteGlidingEarly ||
        Math.abs(record.verticalVelocity) > 1.5
      const movingBusy = record.horizontalSpeed > SPEED_IDLE || airBusy || emoteBusy

      // Horizontal distance to local player feet (not freecam / orbit camera).
      let dist2 = 0
      if (this.hasLocalPlayerPos && record.hasPosition) {
        const dx = record.root.position.x - this.localPlayerWorldPos.x
        const dz = record.root.position.z - this.localPlayerWorldPos.z
        dist2 = dx * dx + dz * dz
      }

      // LOD: near ≤8 m full · mid ≤20 m throttled · far pose-only (unless emote).
      let lodIntervalMs = 0
      let allowAnim = true
      let lodBand: 'near' | 'mid' | 'far' = 'near'
      if (this.hasLocalPlayerPos && record.hasPosition) {
        if (dist2 > LOD_MID_M2) {
          lodIntervalMs = LOD_FAR_INTERVAL_MS
          allowAnim = emoteBusy
          lodBand = 'far'
        } else if (dist2 > LOD_NEAR_M2) {
          lodIntervalMs = LOD_MID_INTERVAL_MS
          // Mid: skip idle skinning — only animate walk/emote/air.
          allowAnim = movingBusy
          lodBand = 'mid'
        }
      }

      // Off-camera: drop skinned mixer unless emote (Focus / look-away from huddle).
      if (frustumReady && allowAnim && !emoteBusy && record.hasPosition) {
        _frustumSphere.center.copy(record.root.position)
        _frustumSphere.center.y += 0.9
        _frustumSphere.radius = FRUSTUM_SKIP_RADIUS_M
        if (!_frustum.intersectsSphere(_frustumSphere)) {
          allowAnim = false
        }
      }

      if (lodIntervalMs > 0 && record.lastLodUpdateAt > 0 && now - record.lastLodUpdateAt < lodIntervalMs) {
        // Still refresh name-tag visibility cheaply; skip pose/anim this frame.
        record.nameTagWanted = nameTagWantedForDist(
          record.nameTagWanted,
          dist2,
          this.hasLocalPlayerPos
        )
        const showTag =
          tagsAllowed && !record.modifierHidden && record.hasPosition && record.nameTagWanted
        if (record.nameTag && record.nameTag.object.visible !== showTag) {
          record.nameTag.object.visible = showTag
        }
        if (showTag) nameTagsShown++
        continue
      }

      if (lodBand === 'near') lodNear++
      else if (lodBand === 'mid') lodMid++
      else lodFar++

      const tickDelta =
        lodIntervalMs > 0 && record.lastLodUpdateAt > 0
          ? Math.min((now - record.lastLodUpdateAt) / 1000, 0.12)
          : delta
      record.lastLodUpdateAt = now

      // Dead-reckon a short way past the last packet so 10 Hz wire doesn't stutter.
      const ageS = Math.max(0, (now - record.receivedAt) / 1000)

      // Wire silence after stop: idle peers only keepalive ~3s — clear stale walk speed.
      if (ageS > WIRE_MOVE_STALE_S && !airBusy && !emoteBusy) {
        if (record.horizontalSpeed > SPEED_IDLE) record.horizontalSpeed = 0
        if (record.velocity.x !== 0 || record.velocity.y !== 0 || record.velocity.z !== 0) {
          record.velocity.set(0, 0, 0)
        }
      }

      const extrapS = Math.min(ageS, EXTRAP_MAX_S)
      const moving =
        record.horizontalSpeed > SPEED_IDLE ||
        Math.abs(record.verticalVelocity) > 0.6 ||
        airBusy
      if (record.hasPosition) {
        _extrapGoal.copy(record.targetPosition)
        if (moving && extrapS > 0.001) {
          // Horizontal extrap full; damp vertical (jumps already carry velocity spikes).
          _extrapGoal.x += record.velocity.x * extrapS
          _extrapGoal.y += record.velocity.y * extrapS * 0.4
          _extrapGoal.z += record.velocity.z * extrapS
        }
      }

      const followRate = moving ? POSE_FOLLOW_RATE : POSE_SETTLE_RATE
      const alpha = 1 - Math.exp(-followRate * tickDelta)
      // Faster speed decay when stopping — walk anim was lingering on remotes.
      const decelerating = record.horizontalSpeed < record.smoothedSpeed - 0.01
      const speedAlpha = 1 - Math.exp(-(decelerating ? 28 : 12) * tickDelta)
      const yawAlpha = 1 - Math.exp(-(moving ? 16 : 10) * tickDelta)

      // Settled: on target, not moving, no jump/glide/emote — skip lerp.
      const atTarget =
        record.hasPosition &&
        Math.hypot(
          record.root.position.x - record.targetPosition.x,
          record.root.position.y - record.targetPosition.y,
          record.root.position.z - record.targetPosition.z
        ) <= POSE_EPS &&
        Math.abs(record.currentYaw - record.targetYaw) <= POSE_YAW_EPS
      const settled =
        atTarget &&
        record.horizontalSpeed < SPEED_IDLE &&
        record.smoothedSpeed < SPEED_IDLE &&
        !emoteBusy &&
        !airBusy &&
        ageS > 0.05

      if (settled) {
        poseSkipped++
        record.root.position.copy(record.targetPosition)
        record.currentYaw = record.targetYaw
        record.pivot.rotation.y = record.currentYaw + AVATAR_YAW_OFFSET
        record.smoothedSpeed = 0
      } else {
        if (record.hasPosition) {
          record.root.position.lerp(_extrapGoal, alpha)
        }

        // Smooth yaw always (snapping every packet reads as jitter when wire is 10 Hz).
        let dyaw = record.targetYaw - record.currentYaw
        while (dyaw > Math.PI) dyaw -= Math.PI * 2
        while (dyaw < -Math.PI) dyaw += Math.PI * 2
        record.currentYaw += dyaw * yawAlpha
        record.pivot.rotation.y = record.currentYaw + AVATAR_YAW_OFFSET

        record.smoothedSpeed += (record.horizontalSpeed - record.smoothedSpeed) * speedAlpha
        if (record.horizontalSpeed < SPEED_IDLE && record.smoothedSpeed < 0.04) {
          record.smoothedSpeed = 0
        }
      }

      // Near/mid: skinned update. Far: pose only unless emote (looping sits/dances).
      if (allowAnim) {
        let emoteActive =
          record.renderMode === 'vrm'
            ? (record.vrmLocomotion?.isProfileEmoteActive() ?? false)
            : record.renderMode === 'odk'
              ? (record.odkLocomotion?.isProfileEmoteActive() ?? false)
              : (record.animations?.isProfileEmoteActive() ?? false)
        // Settled loco-idle (no emote): throttle mixer ~12 Hz — not when looping emotes.
        const locoIdleSettled = settled && !emoteActive && !emoteBusy
        if (
          locoIdleSettled &&
          record.lastAnimUpdateAt > 0 &&
          now - record.lastAnimUpdateAt < ANIM_SETTLED_INTERVAL_MS
        ) {
          animSkipped++
        } else {
          const animDelta =
            locoIdleSettled && record.lastAnimUpdateAt > 0
              ? Math.min((now - record.lastAnimUpdateAt) / 1000, 0.12)
              : tickDelta
          record.lastAnimUpdateAt = now

          const speed = record.smoothedSpeed
          // Local player cancels emotes on WASD; remotes must cancel when wire speed shows walk/run
          // or they keep sit loops while sliding (mauhetti-style glitch after hitch).
          if (emoteActive && speed > 0.45) {
            this.stopPeerProfileEmote(record)
            emoteActive = false
          }
          const locomotionMode = inferRemoteLocomotionMode(speed)
          const targetLocomotionSpeed =
            !emoteActive && speed > 0.08 ? remoteTargetLocomotionSpeed(locomotionMode) : 0
          const grounded = record.remoteGrounded && record.verticalVelocity > -8
          const remoteGliding =
            !grounded &&
            (glideStateWantsOpen(record.glideState) ||
              record.glideState === GlideStateWire.CLOSING_PROP)
          const jumping = record.remoteJumping && record.jumpCount <= 1 && !remoteGliding
          const doubleJumping = record.jumpCount >= 2 && !grounded && !remoteGliding

          _locoState.horizontalSpeed = emoteActive ? 0 : speed
          _locoState.targetLocomotionSpeed = targetLocomotionSpeed
          _locoState.grounded = grounded
          _locoState.nearGround = grounded
          _locoState.verticalVelocity = record.verticalVelocity
          _locoState.locomotionMode = locomotionMode
          _locoState.jumping = jumping
          _locoState.doubleJumping = doubleJumping
          _locoState.doubleJumpTriggered = record.doubleJumpTriggered
          _locoState.falling =
            !grounded &&
            !jumping &&
            !doubleJumping &&
            !remoteGliding &&
            record.verticalVelocity < -1.5
          _locoState.gliding = remoteGliding

          const animT0 = performance.now()
          if (record.renderMode === 'vrm') {
            record.vrmLocomotion?.update(animDelta, _locoState)
            record.vrmAvatar?.update(animDelta)
          } else if (record.renderMode === 'odk') {
            record.odkLocomotion?.update(animDelta, _locoState)
            record.odkAvatar?.update(animDelta)
          } else {
            record.animations?.update(animDelta, _locoState)
          }
          animMs += performance.now() - animT0

          const stillEmoting =
            record.renderMode === 'vrm'
              ? record.vrmLocomotion?.isProfileEmoteActive()
              : record.renderMode === 'odk'
                ? record.odkLocomotion?.isProfileEmoteActive()
                : record.animations?.isProfileEmoteActive()
          if (record.activeEmoteUrn && !stillEmoting) {
            record.activeEmoteUrn = null
          }
          if (record.deferredProfileReload && !stillEmoting) {
            record.deferredProfileReload = false
            void this.reloadPeerAvatar(key, record)
          }
        }
      }
      // Prop open/close + rotors — skip when fully closed and settled.
      if (!settled || remoteGlidingEarly || record.glideState !== GlideStateWire.PROP_CLOSED) {
        record.glider.update(tickDelta)
      }
      record.doubleJumpTriggered = false

      // Name tags: hysteretic distance cull + throttle head follow when far / settled.
      record.nameTagWanted = nameTagWantedForDist(
        record.nameTagWanted,
        dist2,
        this.hasLocalPlayerPos
      )
      const showTag =
        tagsAllowed && !record.modifierHidden && record.hasPosition && record.nameTagWanted
      if (record.nameTag) {
        if (record.nameTag.object.visible !== showTag) {
          record.nameTag.object.visible = showTag
        }
      }
      if (showTag) {
        nameTagsShown++
        const nameTagTarget = record.model ?? record.placeholder
        if (nameTagTarget) {
          const anchorIntervalMs =
            settled && dist2 <= NAME_TAG_NEAR_M2
              ? NAME_TAG_SETTLED_INTERVAL_MS
              : dist2 > NAME_TAG_NEAR_M2
                ? NAME_TAG_FAR_INTERVAL_MS
                : 0
          const needAnchor =
            !this.hasLocalPlayerPos ||
            anchorIntervalMs === 0 ||
            now - record.nameTagLastAnchorAt >= anchorIntervalMs
          if (needAnchor) {
            if (!record.headBone && record.model) {
              record.headBone = findHeadBone(record.model)
            }
            updateNameTagAnchor(
              record.nameTagAnchor,
              nameTagTarget,
              1.72,
              undefined,
              record.model ? record.headBone : null
            )
            record.nameTagLastAnchorAt = now
          }
        }
      }
    }

    return {
      poseSkipped,
      animSkipped,
      nameTagsShown,
      remoteUpdateMs: performance.now() - updateT0,
      remoteAnimMs: animMs,
      lodNear,
      lodMid,
      lodFar
    }
  }

  /** Disable cast on every mesh under a remote model (wearables default cast-on). */
  private setModelCastShadow(model: THREE.Object3D, cast: boolean): void {
    model.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        ;(obj as THREE.Mesh).castShadow = cast
      }
    })
  }

  /** Enable castShadow only on the nearest loaded remotes (GPU budget vs local player). */
  private applyRemoteShadowBudget(): void {
    type Ranked = { record: RemotePeerRecord; dist2: number }
    const ranked: Ranked[] = []
    for (const record of this.peers.values()) {
      if (!record.model || record.modifierHidden) continue
      let dist2 = Number.POSITIVE_INFINITY
      if (this.hasLocalPlayerPos && record.hasPosition) {
        const dx = record.root.position.x - this.localPlayerWorldPos.x
        const dz = record.root.position.z - this.localPlayerWorldPos.z
        dist2 = dx * dx + dz * dz
      }
      ranked.push({ record, dist2 })
    }
    ranked.sort((a, b) => a.dist2 - b.dist2)
    for (let i = 0; i < ranked.length; i++) {
      const cast = i < REMOTE_SHADOW_CASTERS
      const model = ranked[i]!.record.model
      if (!model) continue
      this.setModelCastShadow(model, cast)
    }
  }

  dispose(): void {
    for (const key of [...this.peers.keys()]) {
      this.removePeer(key)
    }
    for (const key of [...this.pendingVrmHash.keys()]) {
      this.clearPendingVrmHash(key)
    }
    this.root.removeFromParent()
  }

  private tryStartAvatarLoad(
    address: string,
    record: RemotePeerRecord,
    force = false
  ): Promise<void> | null {
    if (!record.hasPosition || record.model) return null
    if (record.loading && !force) return record.loading
    const key = address.toLowerCase()
    // Already queued: refresh distance only — do not allocate a new run() each frame.
    if (!force && this.loadQueue.isQueued(key)) {
      this.loadQueue.updatePeerDistance(key, record.targetPosition)
      return record.loading
    }
    // Enqueue; hard ≤20 m gate is in the load queue pump (no far fallback).
    // `loading` is set only when the job actually starts so far waiters don't stick.
    this.loadQueue.enqueue(
      address,
      record.targetPosition,
      async () => {
        if (record.model) return
        let resolveLoad!: () => void
        const loadPromise = new Promise<void>((resolve) => {
          resolveLoad = resolve
        })
        record.loading = loadPromise
        try {
          // Distance checked at pump start; once started we finish even if they walk out.
          // Models are never unloaded for distance.
          await this.loadPeerAvatar(address, record)
        } finally {
          resolveLoad()
          if (record.loading === loadPromise) record.loading = null
        }
      },
      force
    )
    return record.loading
  }

  private async reloadPeerAvatar(address: string, record: RemotePeerRecord): Promise<void> {
    const key = address.toLowerCase()
    const seq = (this.peerReloadSeq.get(key) ?? 0) + 1
    this.peerReloadSeq.set(key, seq)

    this.loadQueue.cancel(key)
    if (record.loading) {
      await record.loading.catch(() => undefined)
    }
    if (this.peerReloadSeq.get(key) !== seq) return

    this.disposePeerModel(record)
    if (record.hasPosition) {
      this.attachLoadingPresentation(record)
    }

    record.loading = null
    const pendingLoad = this.tryStartAvatarLoad(key, record, true)
    if (pendingLoad) {
      await pendingLoad.catch(() => undefined)
    }
    if (this.peerReloadSeq.get(key) !== seq) return
  }

  private ensureNameTag(record: RemotePeerRecord, loading: boolean): void {
    if (!areSceneNameTagsVisible()) {
      record.nameTag?.dispose()
      record.nameTag = null
      return
    }
    if (!record.nameTag) {
      record.nameTag = NameTag.attach(record.nameTagAnchor, record.identity.displayName, {
        textColor: record.identity.nameColor,
        claimed: record.identity.hasClaimedName,
        address: record.address,
        interactive: true
      })
    } else {
      record.nameTag.setText(record.identity.displayName)
      record.nameTag.setStyle({
        textColor: record.identity.nameColor,
        claimed: record.identity.hasClaimedName
      })
    }
    record.nameTag.setLoading(loading)
    record.nameTag.object.visible = !record.modifierHidden && areSceneNameTagsVisible()
  }

  /** Force-refresh all remote peer overhead labels (Explorer [N]). */
  applyNameTagsVisibility(): void {
    for (const record of this.peers.values()) {
      if (!areSceneNameTagsVisible()) {
        record.nameTag?.dispose()
        record.nameTag = null
        continue
      }
      const loading = !!record.placeholder && !record.model
      this.ensureNameTag(record, loading)
    }
  }

  private attachLoadingPresentation(record: RemotePeerRecord): void {
    if (!record.placeholder) {
      record.placeholder = createRemoteAvatarPlaceholder(true)
      record.pivot.add(record.placeholder)
    }
    this.ensureNameTag(record, true)
    updateNameTagAnchor(record.nameTagAnchor, record.placeholder)
  }

  private finalizeNameTag(record: RemotePeerRecord): void {
    if (record.model) {
      record.headBone = findHeadBone(record.model)
    }
    this.ensureNameTag(record, false)
    if (record.model || record.placeholder) {
      updateNameTagAnchor(
        record.nameTagAnchor,
        record.model ?? record.placeholder,
        1.72,
        undefined,
        record.headBone
      )
      record.nameTagLastAnchorAt = performance.now()
    }
  }

  private clearLoadingPresentation(record: RemotePeerRecord): void {
    if (record.placeholder) {
      disposeRemoteAvatarPlaceholder(record.placeholder)
      record.placeholder = null
    }
  }

  private async loadPeerAvatar(address: string, record: RemotePeerRecord): Promise<void> {
    const key = address.toLowerCase()
    const composeT0 = performance.now()
    try {
      if (!this.peers.has(key)) return

      const profile =
        record.pendingProfile ??
        (await resolveRemotePeerProfile(address, this.lambdasUrl || undefined)) ??
        blankProfile(address)
      record.identity = identityFromAvatarProfile(profile, address)
      record.bodyShape = profile.bodyShape
      record.pendingProfile = profile
      this.pushPeerMirrorIdentity(record, profile)

      if (!record.model && !record.placeholder) {
        this.attachLoadingPresentation(record)
      } else if (!record.nameTag) {
        this.attachLoadingPresentation(record)
      }

      if (!this.peers.has(key)) return

      // Prefer custom mesh when bytes are already in RAM.
      if (record.vrmContentHash) {
        const customBytes = getVrmRamBytes(record.vrmContentHash)
        if (customBytes) {
          const format =
            record.customAvatarFormat ??
            getVrmRamFormat(record.vrmContentHash) ??
            'vrm'
          record.customAvatarFormat = format
          odkNetInfo('loadPeerAvatar — mounting custom mesh', {
            peer: shortAddr(key),
            format: formatTag(format),
            hash: shortHash(record.vrmContentHash),
            bytes: customBytes.byteLength
          })
          if (format === 'odk') {
            await this.loadOdkPeerAvatar(key, record, customBytes)
          } else {
            await this.loadVrmPeerAvatar(key, record, customBytes)
          }
          perfNoteComposeMs(performance.now() - composeT0)
          try {
            this.onComposeSettled?.()
          } catch {
            /* never break load path */
          }
          return
        }
        // DAV announce without bytes yet (or fetch failing) — do NOT stay on pill forever.
        // Compose DCL body as interim; onPeerVrmBytesReady will swap to custom when ready.
        odkNetInfo('loadPeerAvatar — DAV pending, composing DCL interim', {
          peer: shortAddr(key),
          format: formatTag(record.customAvatarFormat),
          hash: shortHash(record.vrmContentHash)
        })
      }

      const composed = await composeAvatarFromProfile(profile, this.contentUrl || undefined, this.assetCache)
      // Let a frame paint after the (time-sliced) compose before scene-graph attach + anim bind.
      await yieldToNextFrame()
      stabilizeSkinnedMeshes(composed)

      if (!this.peers.has(key)) {
        this.disposeModel(composed)
        return
      }

      // Bytes may have arrived during Catalyst compose — prefer custom mesh.
      if (record.vrmContentHash) {
        const lateBytes = getVrmRamBytes(record.vrmContentHash)
        if (lateBytes) {
          this.disposeModel(composed)
          const format =
            record.customAvatarFormat ??
            getVrmRamFormat(record.vrmContentHash) ??
            'vrm'
          if (format === 'odk') {
            await this.loadOdkPeerAvatar(key, record, lateBytes)
          } else {
            await this.loadVrmPeerAvatar(key, record, lateBytes)
          }
          perfNoteComposeMs(performance.now() - composeT0)
          try {
            this.onComposeSettled?.()
          } catch {
            /* never break load path */
          }
          return
        }
        // Still no custom bytes — keep DCL interim (do not dispose back to pill).
      }

      record.model = composed
      record.renderMode = 'dcl'
      this.clearLoadingPresentation(record)

      record.pivot.add(record.model)
      applyAvatarPivotOffset(record.pivot, record.model)
      // Wearables default cast-on — clear immediately; nearest-N budget re-enables a few.
      this.setModelCastShadow(record.model, false)
      this.applyRemoteShadowBudget()
      this.finalizeNameTag(record)

      // Bind locomotion/emote clips on the next frame so first GPU upload isn't stacked with bind.
      await yieldToNextFrame()
      if (!this.peers.has(key) || record.model !== composed) return

      record.animations = new AvatarAnimations()
      try {
        await record.animations.bind(record.model, record.pivot, {
          bodyShape: record.bodyShape,
          peerUrl: this.contentUrl || undefined,
          assetCache: this.assetCache
        })
        record.animations.setVfxScene(this.scene)
      } catch (err) {
        console.warn(`[network] remote emotes failed for ${address}`, err)
        record.animations.dispose()
        record.animations = null
      }

      const { x, y, z } = record.targetPosition
      clientDebugLog.log(
        'network',
        `Remote avatar ready · ${record.identity.displayName} @ x=${x.toFixed(1)} y=${y.toFixed(1)} z=${z.toFixed(1)}`,
        { level: 'success' }
      )

      if (record.pendingEmote) {
        const pending = record.pendingEmote
        record.pendingEmote = null
        void this.applyPeerEmote(record, pending)
      }
      perfNoteComposeMs(performance.now() - composeT0)
      try {
        this.onComposeSettled?.()
      } catch {
        /* never break load path */
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('network', `Remote avatar failed · ${address.slice(0, 8)}… ${msg}`, { level: 'error' })
      console.warn(`[network] remote avatar failed for ${address}`, err)
      this.finalizeNameTag(record)
    } finally {
      record.loading = null
    }
  }

  private async loadOdkPeerAvatar(
    key: string,
    record: RemotePeerRecord,
    bytes: ArrayBuffer
  ): Promise<void> {
    try {
      this.disposePeerModel(record)
      if (record.hasPosition) {
        this.attachLoadingPresentation(record)
      }

      const odkAvatar = await OdkAvatar.fromBytes(bytes)
      if (!this.peers.has(key)) {
        odkAvatar.dispose()
        return
      }

      await yieldToNextFrame()
      if (!this.peers.has(key)) {
        odkAvatar.dispose()
        return
      }

      record.odkAvatar = odkAvatar
      record.model = odkAvatar.root
      record.renderMode = 'odk'
      record.vrmLoadedHash = record.vrmContentHash
      record.customAvatarFormat = 'odk'
      this.clearCustomMeshRetry(record)
      record.customMeshAttempts = 0

      this.clearLoadingPresentation(record)
      record.pivot.add(odkAvatar.root)
      prepareCustomAvatarScene(odkAvatar.root)
      applyOdkPivotOffset(record.pivot, odkAvatar.root)
      prepareCustomAvatarScene(odkAvatar.root)
      this.setModelCastShadow(odkAvatar.root, false)
      this.applyRemoteShadowBudget()
      this.finalizeNameTag(record)

      await yieldToNextFrame()
      if (!this.peers.has(key) || record.model !== odkAvatar.root) return

      record.odkLocomotion = new OdkLocomotionAnimations()
      try {
        await record.odkLocomotion.bind(odkAvatar.root)
        prepareCustomAvatarScene(odkAvatar.root)
        odkNetInfo('remote ODK locomotion active', {
          peer: shortAddr(record.address),
          name: record.identity.displayName,
          hash: shortHash(record.vrmContentHash)
        })
      } catch (err) {
        console.warn(`[network] remote ODK locomotion failed for ${record.address}`, err)
        record.odkLocomotion.dispose()
        record.odkLocomotion = null
      }

      odkNetInfo('remote ODK avatar mounted', {
        peer: shortAddr(record.address),
        name: record.identity.displayName,
        hash: shortHash(record.vrmContentHash)
      })
      clientDebugLog.log(
        'network',
        `Remote ODK ready · ${record.identity.displayName} (${record.vrmContentHash?.slice(0, 12)}…)`,
        { level: 'success' }
      )

      if (record.pendingEmote) {
        const pending = record.pendingEmote
        record.pendingEmote = null
        void this.applyPeerEmote(record, pending)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      odkNetWarn('remote ODK load failed', {
        peer: shortAddr(record.address),
        hash: shortHash(record.vrmContentHash),
        attempt: record.customMeshAttempts + 1,
        error: msg
      })
      record.customMeshAttempts += 1
      record.renderMode = 'dcl'
      this.scheduleCustomMeshRetry(key, record, msg)
    }
  }

  private async loadVrmPeerAvatar(
    key: string,
    record: RemotePeerRecord,
    bytes: ArrayBuffer
  ): Promise<void> {
    try {
      this.disposePeerModel(record)
      if (record.hasPosition) {
        this.attachLoadingPresentation(record)
      }

      const vrmAvatar = await VrmAvatar.fromBytes(bytes)
      if (!this.peers.has(key)) {
        vrmAvatar.dispose()
        return
      }

      await yieldToNextFrame()
      if (!this.peers.has(key)) {
        vrmAvatar.dispose()
        return
      }

      vrmAvatar.vrm.humanoid.autoUpdateHumanBones = false
      record.vrmAvatar = vrmAvatar
      record.model = vrmAvatar.root
      record.renderMode = 'vrm'
      record.vrmLoadedHash = record.vrmContentHash
      record.customAvatarFormat = 'vrm'
      this.clearCustomMeshRetry(record)
      record.customMeshAttempts = 0

      this.clearLoadingPresentation(record)
      record.pivot.add(vrmAvatar.root)
      prepareCustomAvatarScene(vrmAvatar.root)
      this.setModelCastShadow(vrmAvatar.root, false)
      this.applyRemoteShadowBudget()
      this.finalizeNameTag(record)

      await yieldToNextFrame()
      if (!this.peers.has(key) || record.model !== vrmAvatar.root) return

      record.vrmLocomotion = new VrmLocomotionAnimations()
      try {
        // Bind-pose feet align before retargeted clips (same as LocalAvatar).
        applyVrmPivotOffset(record.pivot, vrmAvatar.vrm, vrmAvatar.root)
        await record.vrmLocomotion.bind(vrmAvatar.vrm, vrmAvatar.root)
        prepareCustomAvatarScene(vrmAvatar.root)
      } catch (err) {
        console.warn(`[network] remote VRM locomotion failed for ${record.address}`, err)
        record.vrmLocomotion.dispose()
        record.vrmLocomotion = null
        applyVrmPivotOffset(record.pivot, vrmAvatar.vrm, vrmAvatar.root)
        prepareCustomAvatarScene(vrmAvatar.root)
      }
      record.model.visible = true
      record.pivot.visible = true

      clientDebugLog.log(
        'network',
        `Remote VRM ready · ${record.identity.displayName} (${record.vrmContentHash?.slice(0, 12)}…)`,
        { level: 'success' }
      )

      if (record.pendingEmote) {
        const pending = record.pendingEmote
        record.pendingEmote = null
        void this.applyPeerEmote(record, pending)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[network] remote VRM load failed for ${record.address}`, err)
      odkNetWarn('remote VRM load failed', {
        peer: shortAddr(record.address),
        hash: shortHash(record.vrmContentHash),
        attempt: record.customMeshAttempts + 1,
        error: msg
      })
      record.customMeshAttempts += 1
      record.renderMode = 'dcl'
      this.scheduleCustomMeshRetry(key, record, msg)
    }
  }

  private stopPeerProfileEmote(record: RemotePeerRecord): void {
    if (record.renderMode === 'vrm') {
      record.vrmLocomotion?.stopProfileEmote()
    } else if (record.renderMode === 'odk') {
      record.odkLocomotion?.stopProfileEmote()
    } else {
      record.animations?.stopProfileEmote()
    }
    record.activeEmoteUrn = null
  }

  private async applyPeerEmote(record: RemotePeerRecord, emoteRef: string): Promise<void> {
    if (!record.model) return

    const normalizedRef = emoteRef.trim().toLowerCase()
    const emoteActive =
      record.renderMode === 'vrm'
        ? record.vrmLocomotion?.isProfileEmoteActive()
        : record.renderMode === 'odk'
          ? record.odkLocomotion?.isProfileEmoteActive()
          : record.animations?.isProfileEmoteActive()
    if (record.activeEmoteUrn === normalizedRef && emoteActive) {
      return
    }

    const peerUrl = this.contentUrl || PEER_URL
    const resolved = await resolveProfileEmote(emoteRef, record.bodyShape, peerUrl)
    if (!resolved) return

    try {
      const cached = this.assetCache ? await loadResolvedProfileEmote(this.assetCache, resolved) : null
      if (!cached?.animations.length) return

      // Peer may have started walking while the emote GLB was loading.
      if (record.smoothedSpeed > 0.45 || record.horizontalSpeed > 0.45) {
        return
      }

      if (record.renderMode === 'vrm' && record.vrmAvatar && record.vrmLocomotion) {
        const clip = retargetGltfClipToVrm(cached.animations[0]!, cached.root, record.vrmAvatar.vrm)
        if (clip.tracks.length === 0) return
        if (record.vrmLocomotion.playProfileEmote(clip, resolved.loop)) {
          record.activeEmoteUrn = resolved.urn.trim().toLowerCase()
        }
        return
      }

      if (record.renderMode === 'odk' && record.odkAvatar && record.odkLocomotion) {
        const clip = retargetGltfClipToOdk(
          cached.animations[0]!,
          cached.root,
          record.odkAvatar.root
        )
        const restCorrection = record.odkLocomotion.getRestCorrection()
        if (restCorrection) applyOdkRestCorrection(clip, restCorrection)
        if (clip.tracks.length === 0) return
        if (record.odkLocomotion.playProfileEmote(clip, resolved.loop)) {
          record.activeEmoteUrn = resolved.urn.trim().toLowerCase()
        }
        return
      }

      if (!record.animations) return
      if (record.animations.playProfileEmoteFromGltf(cached, resolved.loop)) {
        record.activeEmoteUrn = resolved.urn.trim().toLowerCase()
      }
    } catch {
      /* scene / profile emote load failures are expected when assets are unavailable */
    }
  }

  private disposePeerModel(record: RemotePeerRecord): void {
    record.pivot.position.set(0, 0, 0)
    // GliderProp is a pivot child — survives body swaps; disposed only on removePeer.
    record.animations?.dispose()
    record.animations = null
    record.vrmLocomotion?.dispose()
    record.vrmLocomotion = null
    record.odkLocomotion?.dispose()
    record.odkLocomotion = null
    record.activeEmoteUrn = null
    record.vrmLoadedHash = null
    record.headBone = null
    this.clearLoadingPresentation(record)
    if (record.vrmAvatar) {
      record.pivot.remove(record.vrmAvatar.root)
      record.vrmAvatar.dispose()
      record.vrmAvatar = null
      record.model = null
      record.renderMode = 'dcl'
      return
    }
    if (record.odkAvatar) {
      record.pivot.remove(record.odkAvatar.root)
      record.odkAvatar.dispose()
      record.odkAvatar = null
      record.model = null
      record.renderMode = 'dcl'
      return
    }
    if (record.model) {
      this.disposeModel(record.model as THREE.Group)
      record.model = null
      record.renderMode = 'dcl'
    }
  }

  private disposeModel(model: THREE.Group): void {
    if (model.name === 'custom-vrm') {
      disposeVrmRoot(null, model)
    } else if (model.name === 'custom-odk') {
      disposeOdkRoot(model)
    } else {
      disposeWearableInstance(model)
    }
    model.removeFromParent()
  }
}

const _boxCornerScratch = Array.from({ length: 8 }, () => new THREE.Vector3())

function boxCornerPoints(box: THREE.Box3): THREE.Vector3[] {
  const { min, max } = box
  _boxCornerScratch[0]!.set(min.x, min.y, min.z)
  _boxCornerScratch[1]!.set(max.x, min.y, min.z)
  _boxCornerScratch[2]!.set(min.x, max.y, min.z)
  _boxCornerScratch[3]!.set(max.x, max.y, min.z)
  _boxCornerScratch[4]!.set(min.x, min.y, max.z)
  _boxCornerScratch[5]!.set(max.x, min.y, max.z)
  _boxCornerScratch[6]!.set(min.x, max.y, max.z)
  _boxCornerScratch[7]!.set(max.x, max.y, max.z)
  return _boxCornerScratch
}
