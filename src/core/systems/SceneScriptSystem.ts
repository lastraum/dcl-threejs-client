import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ResolvedScene } from '../../dcl/content/types'
import { RendererComponentHost } from '../../bridge/RendererComponentHost'
import { EntityStore, type EntityStoreChange } from '../../bridge/EntityStore'
import { SDK_RESERVED } from '../../bridge/reservedEntities'
import {
  projectionViewFromProjection,
  createStoreComponents,
  type ProjectionView
} from '../../bridge/ProjectionView'
import type { MirrorComponents } from '../../bridge/mirrorComponents'
import { CrdtProjection, type ProjectionChange, type ProjectionChangeKind } from '../../bridge/CrdtProjection'
import { CrdtEncoder } from '../../bridge/CrdtEncoder'
import { ReservedEntitiesSync, type EntityPose } from '../../bridge/ReservedEntitiesSync'
import { ThreeBridge } from '../../bridge/ThreeBridge'
import { applySceneDiff } from '../../bridge/entityStoreApply'
import { materialIsScalarOnly, type PbMaterial } from '../../bridge/material/MaterialApplier'
import {
  expandTransformAncestors,
  sortEntitiesByTransformDepth,
  type DclTransformValues
} from '../../bridge/dclTransform'
import { AvatarShapeBridge } from '../../bridge/AvatarShapeBridge'
import { AvatarEmoteCommandBridge, type AvatarEmoteHandler } from '../../bridge/AvatarEmoteCommandBridge'
import { BillboardBridge } from '../../bridge/BillboardBridge'
import { VirtualCameraBridge } from '../../camera/VirtualCameraBridge'
import type { EntityWorldTransformDeps } from '../../transform/entityWorldTransform'
import { AnimatorBridge } from '../../bridge/AnimatorBridge'
import { TweenBridge } from '../../bridge/TweenBridge'
import { ParticleSystemBridge } from '../../bridge/ParticleSystemBridge'
import { fetchProfileFaceUrl } from '../../avatar/peerApi'
import { isTweenVerbose } from '../../bridge/tweenConfig'
import { dumpMotionFocusReport, isMotionFocusActive, resetBlimpPivotCache } from '../../bridge/motionFocus'
import { AvatarAttachBridge } from '../../bridge/AvatarAttachBridge'
import type { AvatarAttachTargetResolver } from '../../avatar/AvatarAttachTargets'
import { AudioSourceBridge } from '../../media/AudioSourceBridge'
import { AudioStreamBridge } from '../../media/AudioStreamBridge'
import { AudioAnalysisBridge } from '../../media/AudioAnalysisBridge'
import type { SpatialAudioAnchors } from '../../media/spatialAudioParent'
import { VideoPlayerBridge } from '../../media/VideoPlayerBridge'
import { AssetLoadBridge } from '../../media/AssetLoadBridge'
import { NftShapeBridge } from '../../bridge/NftShapeBridge'
import { SceneUiBridge } from '../../ui/scene/SceneUiBridge'
import type { LiveKitVideoBinder } from '../../media/WebVideoPlayer'
import { CollisionSystem } from '../../collision/CollisionSystem'
import {
  GLTF_COLLIDER_ENTITY_BASE,
  LANDSCAPE_COLLIDER_ENTITY_BASE,
  gltfPhysicsEntityId
} from '../../collision/GltfColliderExtractor'
import type { PhysicsColliderDesc } from '../../physics/PhysXWorld'
import { canLocomote, readLocomotionFromComponents } from '../../player/locomotion'
import { resolveEngineTickIntervalMs } from '../../client/detectPerformanceTier'
import { platformMotionDebug } from '../../debug/PlatformMotionDebug'
import { GltfColliderExtractor } from '../../collision/GltfColliderExtractor'
import type {
  CommsRpcHandler,
  MainToWorker,
  PerformanceTier,
  SceneWorkerBoot,
  SceneWorkerOutbound,
  SignedFetchHandler,
  SignedFetchGetHeadersHandler,
  WorkerUiMountSnapshotRow
} from '../../shim/types'
import type { ChangeRealmRequest, ChangeRealmResponse } from '../../player/changeRealm'
import type { CopyToClipboardRequest, CopyToClipboardResponse } from '../../player/copyToClipboard'
import type { MovePlayerToRequest, MovePlayerToResponse } from '../../player/movePlayerTo'
import type { OpenExternalUrlRequest, OpenExternalUrlResponse } from '../../player/openExternalUrl'
import type { OpenNftDialogRequest, OpenNftDialogResponse } from '../../player/openNftDialog'
import type { TeleportToRequest, TeleportToResponse } from '../../player/teleportTo'
import type { TriggerEmoteRequest, TriggerEmoteResponse } from '../../player/triggerEmote'
import type { TriggerSceneEmoteRequest, TriggerSceneEmoteResponse } from '../../player/triggerSceneEmote'
import type {
  SetCameraTransformRequest,
  SetCameraTransformResponse
} from '../../player/setCameraTransform'
import type { AssetCache } from '../../rendering/AssetCache'
import type { SceneHost } from '../../rendering/SceneHost'
import type { PlayerMirrorIdentity } from '../../bridge/playerMirrorIdentity'
import type { CommsRealmInfo } from '../../network/comms/types'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import {
  perfNoteApplyMs,
  perfNotePeels,
  perfNotePointerEdge,
  perfNoteUiMountPost,
  perfNoteUiMountReseedSkip,
  perfNoteVcHydrate,
  perfNoteVcPoseLive,
  perfSetPendingDiff
} from '../../util/perfCounters'
import { skipSceneAnimators, skipTheatreSceneScript } from '../../client/devFlags'
import { mirrorSceneBundle } from '../../dev/mirrorSceneBundle'
import { PointerEventsSystem } from '../../input/PointerEventsSystem'
import type { InputHub } from '../../input/InputHub'
import { SceneInputRelay } from '../../input/SceneInputRelay'
import { TriggerAreaSystem } from '../../input/TriggerAreaSystem'
import { CameraModeAreaSystem } from '../../input/CameraModeAreaSystem'
import type { ForcedCameraMode } from '../../input/CameraModeAreaSystem'
import {
  AvatarModifierAreaSystem,
  type AvatarModifierEffects,
  type AvatarSample
} from '../../input/AvatarModifierAreaSystem'
import { MapPinStore } from '../../input/MapPinStore'
import { RaycastSystem } from '../../input/RaycastSystem'
import { isRaycastVerbose } from '../../input/raycastConfig'
import { isGltfLoadingStateVerbose } from '../../bridge/gltfLoadingStateConfig'
import type { PhysXWorld } from '../../physics/PhysXWorld'
import { EngineApiEventBridge } from './EngineApiEventBridge'
import {
  extractSnapshotMountEntityIds,
  stripEntityDeletesFromCrdtBytes,
  stripSceneUiCrdtBytes,
  stripWorkerAuthoritativeCrdtBytes,
  uiMountSnapshotContentFp
} from '../../shim/worker/workerSceneUiCrdtOutbound'
type MovePlayerHandler = (request: MovePlayerToRequest) => boolean
type TeleportToHandler = (request: TeleportToRequest) => boolean | Promise<boolean>
type ChangeRealmHandler = (request: ChangeRealmRequest) => boolean | Promise<boolean>
type CopyToClipboardHandler = (request: CopyToClipboardRequest) => boolean | Promise<boolean>
type TriggerEmoteHandler = (request: TriggerEmoteRequest) => boolean
type TriggerSceneEmoteHandler = (request: TriggerSceneEmoteRequest) => boolean
type OpenExternalUrlHandler = (request: OpenExternalUrlRequest) => boolean | Promise<boolean>
type OpenNftDialogHandler = (request: OpenNftDialogRequest) => boolean | Promise<boolean>
type SetCameraTransformHandler = (request: SetCameraTransformRequest) => boolean

/** Async bridge ECS sync (Animator / AvatarShape load paths) — playback still runs every sync frame. */
const BRIDGE_ECS_SYNC_RUNTIME = 12

/** Log scene-input-snapshot apply on worker (`?sceneinputsnapshot`). */
const SCENE_INPUT_SNAPSHOT_VERBOSE = ((): boolean => {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).has('sceneinputsnapshot')
  } catch {
    return false
  }
})()

/** Extra pointer round-trip diagnostics (`?pointerverbose`). */
const POINTER_VERBOSE = ((): boolean => {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).has('pointerverbose')
  } catch {
    return false
  }
})()

/** Scene UI CRDT + repaint tracing (`?sceneuilog`). */
const SCENE_UI_LOG = ((): boolean => {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).has('sceneuilog')
  } catch {
    return false
  }
})()

/** Boot snapshot parity oracle (`?projparity`). */
const PROJ_PARITY_AUDIT = ((): boolean => {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).has('projparity')
  } catch {
    return false
  }
})()


/** Boot scene `bin/*.js` in a worker; projection CRDT on main thread → Three.js. */
export class SceneScriptSystem {
  readonly componentHost = new RendererComponentHost()
  /** Typed projection is the renderer-side CRDT state (inbound decode + renderer-owned writes). */
  private readonly projection = new CrdtProjection(
    this.componentHost.components,
    {
      networkEntity: this.componentHost.networkEntity,
      networkParent: this.componentHost.networkParent
    },
    new Set<Entity>([SDK_RESERVED.root, SDK_RESERVED.player, SDK_RESERVED.camera]),
    {
      cameraEntity: SDK_RESERVED.camera,
      mainCameraComponentId: this.componentHost.components.MainCamera.componentId,
      virtualCameraComponentId: this.componentHost.components.VirtualCamera.componentId
    }
  )
  private readonly storeComponents = createStoreComponents(this.componentHost.components, this.projection)
  readonly readComponents: MirrorComponents = this.storeComponents
  readonly view: ProjectionView = projectionViewFromProjection(
    this.projection,
    this.readComponents,
    SDK_RESERVED
  )
  /** Phase 2 — diff accumulated across worker ticks, drained (swapped out) by the render frame. */
  private pendingDiff = new Map<Entity, Map<number, ProjectionChangeKind>>()
  /** Wall time when pendingDiff became non-empty (age for frame-budget SLO). */
  private pendingDiffOldestAt = 0
  /** Per-entity first dirty wall time — true ageMax (not “map non-empty since”). */
  private readonly pendingDiffFirstDirtyAt = new Map<Entity, number>()
  /**
   * COD AAA frame pie — platform law (not scene-tuned heuristics).
   * One ordered drain: Motion → Materials → Structure. No dual peels.
   */
  private static readonly FRAME = {
    /** Transform/Tween/Animator apply budget (ms). */
    MOTION_MS: 4,
    MOTION_ENTITIES: 256,
    /** Scalar Material / instanceColor budget (ms). */
    MATERIAL_MS: 6,
    MATERIAL_ENTITIES: 256,
    /** Gltf attach / Mesh create entity cap + soft ms. */
    STRUCTURE_ENTITIES: 48,
    STRUCTURE_MS: 8,
    /** Pointer-edge budgets (same lanes, tighter). */
    POINTER_MOTION_MS: 4,
    POINTER_MATERIAL_MS: 4,
    POINTER_STRUCTURE_ENTITIES: 16
  } as const
  /** Admit-seal drops this frame (Material/MeshRenderer content no-ops) — ?perfdebug. */
  private admitDropCount = 0
  /**
   * Tiny set of entities to peel first after a world/level-state pointer edge.
   * Cap is hard — sceneUi board storms must never land here (edgeVis=3306 regression).
   */
  private readonly pointerEdgeVisualEntities = new Set<Entity>()
  private static readonly POINTER_EDGE_VISUAL_CAP = 24
  /** Only collect for non-sceneUi world/level-state edges. */
  private pointerEdgeVisualCollect = false
  /** Keep peeling recent missing-leaf markers after edge (getClick CRDT lag). */
  private pointerEdgeVisualUntil = 0
  private projectionDiffActive = false
  /** Phase 3: encoder is the primary source for renderer-owned outbound CRDT (reserved, tween, pointer/video results). Always on. */
  private readonly encoder = new CrdtEncoder(SDK_RESERVED, this.projection, this.componentHost.components)
  /**
   * Source-capture sink: renderer grow-only writers call this at their exact `addValue`
   * site so the outbound encoder reproduces each APPEND byte-exactly.
   *
   * **PointerEventsResult is never recorded** — PE edges reach the worker only via
   * `inject-pointer-click` (worker inject is authoritative). Encoding PE on main caused
   * ghost onMouseDown when a later grow-only flush shipped a second clock.
   */
  private readonly recordRendererAppend = (componentId: number, entity: Entity, value: unknown): void => {
    if (componentId === this.readComponents.PointerEventsResult.componentId) return
    this.encoder.recordAppend(componentId, entity, value)
  }
  private readonly recordRendererLww = (componentId: number, entity: Entity, value: unknown): void => {
    this.encoder.recordLww(componentId, entity, value)
    // SpaceRunner / ADR-215: loading-state must reach worker promptly (not only via raycast flush,
    // which is blocked during asset hydration). Coalesce same-tick LOADING→FINISHED into one deliver.
    if (componentId === this.readComponents.GltfContainerLoadingState.componentId) {
      this.scheduleGltfLoadingStateFlush(entity, value)
    }
  }
  /** Microtask-coalesced LWW push for GltfContainerLoadingState. */
  private gltfLwwFlushQueued = false
  private scheduleGltfLoadingStateFlush(entity: Entity, value: unknown): void {
    if (isGltfLoadingStateVerbose()) {
      const state = (value as { currentState?: number } | null)?.currentState
      clientDebugLog.log(
        'gltf-load',
        `queued LWW e${entity as number} state=${state ?? '?'} pending=${this.encoder.pendingLwwPutCount}`,
        { alsoConsole: true, throttleMs: 0 }
      )
    }
    if (this.gltfLwwFlushQueued) return
    this.gltfLwwFlushQueued = true
    queueMicrotask(() => {
      this.gltfLwwFlushQueued = false
      if (!this.worker || !this.running) {
        if (isGltfLoadingStateVerbose()) {
          clientDebugLog.log('gltf-load', 'flush skipped — worker not ready', {
            level: 'warn',
            alsoConsole: true
          })
        }
        return
      }
      this.flushRendererLwwToWorker({ reason: 'gltf-loading-state' })
    })
  }
  private crdtOutboundLogged = false
  /** Phase C — serializes async outbound apply + inbound deliver. */
  private crdtOutboundSerial: Promise<void> = Promise.resolve()
  /** Phase C slice 2 — coalesce worker outbounds per microtask before one encode/deliver. */
  private crdtOutboundPending: {
    id?: number
    data: Uint8Array
    uiEntities?: number[]
    uiMountSnapshot?: WorkerUiMountSnapshotRow[]
  }[] = []

  readonly reserved = new ReservedEntitiesSync(this.projection, this.readComponents, SDK_RESERVED)
  collision: CollisionSystem | null = null
  gltfColliders: GltfColliderExtractor | null = null
  pointerEvents: PointerEventsSystem | null = null
  sceneInputRelay: SceneInputRelay | null = null
  /** World InputHub — single keyboard bus; this system only subscribes. */
  private inputHub: InputHub | null = null
  private inputSubscriberId = 'primary'
  private clearPlayerMoveKeys: (() => void) | null = null
  triggerAreas: TriggerAreaSystem | null = null
  cameraModeAreas: CameraModeAreaSystem | null = null
  avatarModifiers: AvatarModifierAreaSystem | null = null
  mapPins: MapPinStore | null = null
  private setForcedCameraMode: ((mode: ForcedCameraMode | null) => void) | null = null
  private avatarModifierProviders: {
    getSamples: () => AvatarSample[]
    apply: (id: string, effects: AvatarModifierEffects) => void
  } | null = null
  raycasts: RaycastSystem | null = null
  readonly engineApiEvents = new EngineApiEventBridge()
  private bridge: ThreeBridge | null = null
  /** Cleared distance-cull experiment once so all scene GLTFs stay visible. */
  private restoredGltfCull = false
  /** Phase 4 — unified scene-graph entity store (Three.js groups keyed by ECS entity). */
  private entityStore: EntityStore | null = null
  private entityStoreUnsub: (() => void) | null = null
  private avatarShapes: AvatarShapeBridge | null = null
  private avatarEmoteBridge: AvatarEmoteCommandBridge | null = null
  private billboardBridge: BillboardBridge | null = null
  private virtualCameraBridge: VirtualCameraBridge | null = null
  private virtualCameraPlayerPose: (() => EntityPose) | null = null
  private virtualCameraCameraPose: (() => EntityPose) | null = null
  private animatorBridge: AnimatorBridge | null = null
  private tweenBridge: TweenBridge | null = null
  private particleBridge: ParticleSystemBridge | null = null
  private sceneUiBridge: SceneUiBridge | null = null
  /** `#scene-ui-root` (primary) or `#pe-ui-root` (portable experience). */
  private uiRootId: 'scene-ui-root' | 'pe-ui-root' = 'scene-ui-root'
  /**
   * Desired `#scene-ui-root` visibility from AppController play chrome.
   * Survives `prepare()` recreating the bridge (constructor always starts hidden).
   */
  private sceneUiDesiredVisible = false
  /** FocusOwner — secondary hard-mutes media and never shows scene UI. */
  private focusPolicy: import('../../dcl/multiScene/types').FocusPolicy = 'primary'
  private sceneUiResizeObserver: ResizeObserver | null = null
  private unbindSceneUiWindowResize: (() => void) | null = null
  private avatarAttachBridge: AvatarAttachBridge | null = null
  private videoPlayerBridge: VideoPlayerBridge | null = null
  private audioSourceBridge: AudioSourceBridge | null = null
  private audioStreamBridge: AudioStreamBridge | null = null
  private audioAnalysisBridge: AudioAnalysisBridge | null = null
  private assetLoadBridge: AssetLoadBridge | null = null
  private host: SceneHost | null = null
  private worker: Worker | null = null
  private running = false
  /** SceneLoop: a play-frame-tick is outstanding until play-frame-done. */
  private playFrameInFlight = false
  private playFrameInFlightAt = 0
  /** When true, gameplay crdt-outbound waits for SceneLoop.receive. */
  private sceneLoopReceiveArmed = false
  private lastSentPlayerPos = { x: Number.NaN, y: Number.NaN, z: Number.NaN }
  private lastSentPlayerRot = { x: Number.NaN, y: Number.NaN, z: Number.NaN, w: Number.NaN }
  private lastSentCamPos = { x: Number.NaN, y: Number.NaN, z: Number.NaN }
  private lastSentCamRot = { x: Number.NaN, y: Number.NaN, z: Number.NaN, w: Number.NaN }
  private lastSentPpiDir = { x: Number.NaN, y: Number.NaN, z: Number.NaN }
  private prepared = false
  private crdtTick = 0
  /** Renderer frame counter for EngineInfo (ADR-148). */
  private engineFrame = 0
  private clientPlayerPose: EntityPose | null = null
  private clientCameraPose: EntityPose | null = null
  /** Live player/camera poses sampled immediately before CRDT encode (rotation must not lag). */
  private clientPoseProvider: (() => { player: EntityPose; camera: EntityPose }) | null = null
  private getSpatialAudioPlayerRoot: (() => THREE.Object3D | null) | null = null
  private bindLiveKitVideo: LiveKitVideoBinder | null = null
  /** Scene LiveKit remote video (stream-key ingress and/or Cast). */
  private isLiveKitRemoteLive: () => boolean = () => false
  private movePlayerHandler: MovePlayerHandler | null = null
  private teleportToHandler: TeleportToHandler | null = null
  private changeRealmHandler: ChangeRealmHandler | null = null
  private copyToClipboardHandler: CopyToClipboardHandler | null = null
  private triggerEmoteHandler: TriggerEmoteHandler | null = null
  private triggerSceneEmoteHandler: TriggerSceneEmoteHandler | null = null
  private openExternalUrlHandler: OpenExternalUrlHandler | null = null
  private openNftDialogHandler: OpenNftDialogHandler | null = null
  private setCameraTransformHandler: SetCameraTransformHandler | null = null
  private nftShapeBridge: NftShapeBridge | null = null
  private commsHandler: CommsRpcHandler | null = null
  /** World — enqueue/drain per-entity PhysX cooks (`entity` = GLB just attached; omit = drain queue). */
  private collidersCookCallback: ((entity?: Entity) => void) | null = null
  private collidersPoseCallback: ((entities: Entity[]) => void) | null = null
  /**
   * World — drop PhysX statics when extract maps lose an entity.
   * Required: every syncStaticColliders call uses freezeRemoval:true, so orphans never prune.
   */
  private collidersRemoveCallback: ((entity: Entity) => void) | null = null
  /** Hydration / force-recook — full GltfContainer + MeshCollider walk. */
  private colliderFullWalkRequested = true
  /** EntityStore onChange — MeshCollider / GltfContainer structure or mask changes. */
  private readonly colliderStructureDirty = new Set<Entity>()
  /** EntityStore onChange — Transform on collider-bearing entities (pose only). */
  private readonly colliderPoseDirty = new Set<Entity>()
  private readonly lastTweenMotionEntities = new Set<Entity>()
  private readonly lastSyncFrameTransformEntities = new Set<Entity>()
  /** Full entity-graph updateMatrixWorld — skip when nothing moved. */
  private sceneGraphMatrixDirty = true
  private readonly lastPoseChangedEntities: Entity[] = []
  /**
   * Systems that moved **parts** (bone/_collider) this frame — PART path.
   * Cleared at the start of each motion pump. Prefer Animator; use this for custom systems.
   */
  private readonly systemPartColliders = new Set<Entity>()
  /**
   * Systems that moved **entity Transform** without going through Tween/CRDT/Billboard — ROOT path.
   * Cleared at the start of each motion pump.
   */
  private readonly systemTransformDirty = new Set<Entity>()
  /** Frozen after pumpMotionBridges — valid for the rest of the motion frame. */
  private physMotionSnapshot: { transformDirty: Set<Entity>; animatorPart: Set<Entity> } | null =
    null
  private platformMotionReportDumped = false
  private sceneBaseParcel: string | null = null
  /** True when syncCollision already ran incremental pose descriptor refresh this pass. */
  private colliderPosesSyncedThisPass = false
  /** Transform parent → direct children — subtree walks for pose dirty propagation. */
  private readonly transformChildren = new Map<Entity, Set<Entity>>()
  private readonly transformParent = new Map<Entity, Entity>()
  /** ECS entities that own MeshCollider / GltfContainer physics roots. */
  private readonly colliderRootEntities = new Set<Entity>()

  private pointerStructureDirty = false
  private triggerStructureDirty = false
  /**
   * Raw `main.crdt` bytes — must go to the worker intact. Projection seed drops unknown
   * component ids (no meta), which strips asset-pack Triggers/Actions and left wall
   * on_click entities without runtime PointerEvents (VoxBoards 142,-146).
   */
  private mainCrdtRawBytes: Uint8Array | null = null
  private bridgeDirty = true
  private bridgeSyncTick = 0
  private bridgeSyncEvery = BRIDGE_ECS_SYNC_RUNTIME
  private signedFetchHandler: SignedFetchHandler | null = null
  private signedFetchGetHeadersHandler: SignedFetchGetHeadersHandler | null = null
  /** Prevents overlapping inject flushes. */
  private pointerFlushInFlight = false
  private motionFocusDumped = false
  private motionFocusDumpTicks = 0
  /** Serializes boot onStart crdt-send round-trips. */
  private bootCrdtSendSerial: Promise<void> = Promise.resolve()
  /** True from worker boot until `ready` — keeps fast CRDT path during onStart after eval-done. */
  private bootPhaseActive = false
  private bootProgressReporter: ((msg: string) => void) | null = null
  private scriptBlobUrl: string | null = null
  private compileProgressTimer: ReturnType<typeof setInterval> | null = null
  /** Set when inject-pointer-click is posted; cleared on pointer-deliver-done from worker. */
  private pointerDeliverAwaitingAck = false
  private pointerDeliverFailWatchdog: ReturnType<typeof setTimeout> | null = null
  /** Click flush pending — cleared on pointer-deliver-done. */
  private pointerAwaitingWorkerApply = false
  /** Mount set commit deferred — projection UiTransform lagging worker uiEntities. */
  private projectionLagPendingUi = false
  /** performance.now when projection lag first became pending (0 = not lagging). */
  private projectionLagSinceMs = 0
  /** Worker uiEntities held until applyUiFrame can commit mount set + paint atomically. */
  private pendingUiEntities: number[] | undefined
  /** Renderer inbound held while UI mount commit is deferred — must not echo stale state to worker early. */
  private pendingInboundAfterUiMount: Uint8Array[] = []
  /** Pointer deliver done — keep worker ticks paused until mount set commits on main. */
  private pointerHoldTicksUntilMount = false
  /**
   * Max wait for UiTransform catch-up before resuming worker ticks anyway.
   * Flagtag: stuck deferred after round-reset wipe left sceneTicksPaused forever → timer dt=0 + freeze.
   */
  private static readonly UI_MOUNT_LAG_FORCE_RESUME_MS = 1200
  /** Pointer flush requested while a prior inject batch awaits pointer-deliver-done. */
  private pointerFlushCoalesceRequested = false
  /** Non-UI pointer egress held until the atomic uiEntities chunk (one batch apply). */
  private pointerOutboundDeferBuffer: {
    id?: number
    data: Uint8Array
    uiEntities?: number[]
    uiMountSnapshot?: WorkerUiMountSnapshotRow[]
  }[] = []
  /** setUiRenderer virtual canvas — may arrive before SceneUiBridge exists. */
  private pendingVirtualCanvas: { width: number; height: number } | null = null
  private projectionLagLoggedAt = 0
  private sceneUiRepaintLogCount = 0
  /** Worker pointer tick (4s) + outbound ack wait (4s) — fail only after both can complete. */
  private static readonly POINTER_DELIVER_FAIL_MS = 12_000

  private logPointer(...parts: unknown[]): void {
    if (POINTER_VERBOSE) console.log('[pointer]', ...parts)
  }

  /** Phase 4 — unified entity store (scene graph + avatar peers). */
  getEntityStore(): EntityStore | null {
    return this.entityStore
  }

  /** Gate scene ECS UI overlay — hidden during 2D landing / hydration until play chrome reveals. */
  setSceneUiVisible(visible: boolean): void {
    // Secondary focus never paints UI (FocusOwner = primary only).
    if (this.focusPolicy === 'secondary' && visible) return
    this.sceneUiDesiredVisible = visible
    this.sceneUiBridge?.setVisible(visible)
  }

  /**
   * FocusOwner policy for multi-scene:
   * - primary: media on; UI may show when play chrome asks
   * - secondary: hard mute + video stop + UI forced off
   * - pe: media on; UI owned by PE manager
   */
  setFocusPolicy(policy: import('../../dcl/multiScene/types').FocusPolicy): void {
    if (this.focusPolicy === policy) {
      // Still re-apply media/UI in case bridges were recreated after prepare.
      this.applyFocusPolicy(policy)
      return
    }
    this.focusPolicy = policy
    this.applyFocusPolicy(policy)
  }

  getFocusPolicy(): import('../../dcl/multiScene/types').FocusPolicy {
    return this.focusPolicy
  }

  private applyFocusPolicy(policy: import('../../dcl/multiScene/types').FocusPolicy): void {
    const mediaOn = policy !== 'secondary'
    this.videoPlayerBridge?.setMediaEnabled(mediaOn)
    this.audioSourceBridge?.setMediaEnabled(mediaOn)
    this.audioStreamBridge?.setMediaEnabled(mediaOn)
    this.audioAnalysisBridge?.setMediaEnabled(mediaOn)
    if (policy === 'secondary') {
      this.sceneUiDesiredVisible = false
      this.sceneUiBridge?.setVisible(false)
      // Demoted / muted secondary must never pin freecam, freeze locomotion, hide avatar,
      // or drive CameraModeArea / AvatarModifierArea (ice-cream hide / vending-machine look).
      this.clearPlayerFocusState()
      this.setAvatarModifierProviders(null)
      // Drop AvatarAttach so demoted scene props cannot stick to the player.
      try {
        this.setAvatarAttachTargets(null)
      } catch {
        /* optional */
      }
    }
  }

  /**
   * After multi-scene promote: ignore worker InputModifier.disableAll for this long so
   * half-hydrated scenes cannot pin feet while the player walks between plazas.
   */
  private focusGraceUntilMs = 0

  /**
   * FocusOwner revoke — drop InputModifier freeze + MainCamera→VC so freecam/orbit stay free.
   * Call on demote to secondary and when adopting a half-hydrated secondary as primary if needed.
   */
  clearPlayerFocusState(): void {
    try {
      const { InputModifier, MainCamera } = this.readComponents
      const { PlayerEntity, CameraEntity } = this.view
      InputModifier.deleteFrom(PlayerEntity)
      MainCamera.createOrReplace(CameraEntity, {} as never)
      this.foldProjectionChanges()
      this.projection.clearVcLiveTransformForUnbind()
      this.lastPlayerFrameMainCameraKey = 'cleared'
      this.playerEditFlightLiveLane = false
      // Worker may re-send freeze on next player-frame — grace strips disableAll.
      this.focusGraceUntilMs = performance.now() + 12_000
    } catch {
      /* teardown */
    }
  }

  /** True while post-promote grace ignores disableAll freezes. */
  isFocusGraceActive(): boolean {
    return performance.now() < this.focusGraceUntilMs
  }

  /** PE enable / late mount — rebuild interactive DOM even if layout keys match. */
  forceSceneUiRepaint(): void {
    this.sceneUiBridge?.forceRepaint()
  }

  /** Explorer [N] — refresh AvatarShape NPC overhead name tags. */
  applyAvatarShapeNameTagsVisibility(): void {
    this.avatarShapes?.applyNameTagsVisibility()
  }

  /** Loading-screen progress while the worker compiles the scene bundle (main thread is free). */
  setBootProgressReporter(fn: ((msg: string) => void) | null): void {
    this.bootProgressReporter = fn
  }

  private clearCompileProgressTimer(): void {
    if (!this.compileProgressTimer) return
    clearInterval(this.compileProgressTimer)
    this.compileProgressTimer = null
  }

  private startCompileProgressTimer(): void {
    this.clearCompileProgressTimer()
    const compileStarted = performance.now()
    this.compileProgressTimer = setInterval(() => {
      const seconds = Math.floor((performance.now() - compileStarted) / 1000)
      this.bootProgressReporter?.(`Compiling scene script… (${seconds}s)`)
    }, 1000)
  }

  /** Mirror + bridge setup — call before player spawn so reserved entities exist. */
  prepare(
    scene: ResolvedScene,
    cache: AssetCache,
    host: SceneHost,
    opts?: {
      rootName?: string
      uiRootId?: string
      /**
       * Off-DOM UI for secondary live workers — never share `#scene-ui-root`.
       * PE uses `pe-ui-root`; primary uses default `scene-ui-root`.
       */
      uiDetached?: boolean
      /** Initial FocusOwner policy (default primary). Secondary boots pass 'secondary'. */
      focusPolicy?: import('../../dcl/multiScene/types').FocusPolicy
    }
  ): void {
    if (!scene.mainEntry || !scene.entityId) return

    this.sceneBaseParcel = scene.baseParcel
    this.platformMotionReportDumped = false
    this.reserved.initialize(scene.spawn)
    this.host = host
    this.entityStore = new EntityStore(host.scene, opts?.rootName ?? 'scene-entities')
    this.entityStoreUnsub = this.entityStore.subscribe((change) => this.onEntityStoreChange(change))
    this.bridge = new ThreeBridge(scene, cache, this.entityStore, this.readComponents)
    if (opts?.focusPolicy) this.focusPolicy = opts.focusPolicy
    this.avatarShapes = new AvatarShapeBridge(this.readComponents, (entity) =>
      this.bridge?.getEntityNodes().get(entity)
    )
    // AvatarEmoteCommand is a grow-only value-set the projection doesn't model yet — keep it
    // on the engine defs + engine-backed view (migrated in a later sub-step).
    this.avatarEmoteBridge = new AvatarEmoteCommandBridge(this.readComponents, this.avatarShapes)
    this.billboardBridge = new BillboardBridge(
      this.readComponents,
      this.entityStore,
      () => this.host!.camera
    )
    this.bridge.setBillboardFacingInvalidator((entity) =>
      this.billboardBridge?.invalidateFacing(entity)
    )
    this.virtualCameraBridge = new VirtualCameraBridge(
      this.readComponents,
      this.view,
      () => this.host!.camera,
      () => this.virtualCameraPlayerPose?.() ?? this.clientPlayerPose ?? emptyEntityPose(),
      () => this.virtualCameraCameraPose?.() ?? this.clientCameraPose ?? emptyEntityPose(),
      () => this.bridge?.getEntityNodes()
    )
    this.animatorBridge = new AnimatorBridge(
      this.readComponents,
      cache,
      scene,
      () => this.bridge?.getEntityNodes(),
      (entity) => this.bridge?.ensureCloneMeshForAnimator(entity) ?? null
    )
    this.tweenBridge = new TweenBridge(this.readComponents, this.entityStore)
    this.particleBridge = new ParticleSystemBridge(
      this.readComponents,
      cache,
      scene,
      () => this.bridge?.getEntityNodes(),
      () => this.host?.camera ?? null
    )
    this.sceneUiBridge?.dispose()
    const uiDetached = opts?.uiDetached === true
    const uiRootId = uiDetached
      ? (opts?.uiRootId ?? `secondary-ui:${scene.entityId?.slice(0, 12) ?? 'anon'}`)
      : opts?.uiRootId === 'pe-ui-root'
        ? 'pe-ui-root'
        : 'scene-ui-root'
    this.uiRootId = uiRootId === 'pe-ui-root' ? 'pe-ui-root' : 'scene-ui-root'
    this.sceneUiBridge = new SceneUiBridge(scene, () => this.host?.renderer.domElement ?? null, {
      rootId: uiRootId,
      detached: uiDetached
    })
    // Bridge constructor starts hidden — re-apply play-chrome desire (teleport / re-prepare).
    // Secondary focus never reveals UI.
    this.sceneUiBridge.setVisible(
      this.focusPolicy === 'secondary' ? false : this.sceneUiDesiredVisible
    )
    if (this.pendingVirtualCanvas) {
      this.sceneUiBridge.setVirtualSize(
        this.pendingVirtualCanvas.width,
        this.pendingVirtualCanvas.height
      )
    }
    this.sceneUiBridge.bindWriteback({
      writeInputResult: (entity, value, isSubmit) => {
        const result = { value, isSubmit: isSubmit ?? false }
        this.readComponents.UiInputResult.createOrReplace(entity, result)
        this.recordRendererLww(this.readComponents.UiInputResult.componentId, entity, result)
      },
      writeDropdownResult: (entity, index) => {
        const result = { value: index }
        this.readComponents.UiDropdownResult.createOrReplace(entity, result)
        this.recordRendererLww(this.readComponents.UiDropdownResult.componentId, entity, result)
      },
      flushLww: () => this.flushRendererLwwToWorker()
    })
    this.bridge.setAvatarTextureResolver(async (userId) => {
      const url = await fetchProfileFaceUrl(userId)
      if (!url) return null
      return cache.loadTexture(url).catch(() => null)
    })
    this.avatarAttachBridge = new AvatarAttachBridge(
      this.readComponents,
      this.projection,
      () => this.bridge?.getEntityNodes(),
      () => this.bridge?.getEntityStore()?.root ?? null
    )
    this.bridge.setSkipTransformApply((entity) => this.avatarAttachBridge!.isAttachDriven(entity))
    this.videoPlayerBridge = new VideoPlayerBridge(
      this.readComponents,
      scene,
      () => this.bridge!.getEntityNodes(),
      () => this.getSpatialAudioAnchors(),
      () => this.bindLiveKitVideo,
      this.recordRendererAppend,
      this.recordRendererLww,
      () => this.isLiveKitRemoteLive()
    )
    this.videoPlayerBridge.onLwwFlush = () => this.flushRendererLwwToWorker()
    this.bridge.setVideoPlayerBridge(this.videoPlayerBridge)
    this.audioSourceBridge = new AudioSourceBridge(
      this.readComponents,
      scene,
      this.view,
      () => this.bridge!.getEntityNodes(),
      () => this.getSpatialAudioAnchors(),
      host.camera,
      this.recordRendererAppend,
      this.recordRendererLww
    )
    this.audioSourceBridge.onLwwFlush = () => this.flushRendererLwwToWorker()
    this.bridge.setAudioSourceBridge(this.audioSourceBridge)
    this.videoPlayerBridge.setAudioListener(this.audioSourceBridge.getListener())
    this.audioStreamBridge = new AudioStreamBridge(
      this.readComponents,
      this.view,
      () => this.bridge!.getEntityNodes(),
      () => this.getSpatialAudioAnchors(),
      this.audioSourceBridge.getListener(),
      this.recordRendererAppend
    )
    this.bridge.setAudioStreamBridge(this.audioStreamBridge)
    this.audioAnalysisBridge = new AudioAnalysisBridge(
      this.readComponents,
      () => this.audioSourceBridge,
      () => this.audioStreamBridge,
      () => this.videoPlayerBridge,
      this.recordRendererLww
    )
    this.audioAnalysisBridge.onLwwFlush = () => this.flushRendererLwwToWorker()
    // Apply FocusOwner after bridges exist (secondary = hard mute / video stop).
    this.applyFocusPolicy(this.focusPolicy)
    this.assetLoadBridge = new AssetLoadBridge(
      this.readComponents,
      scene,
      cache,
      this.recordRendererAppend
    )
    this.assetLoadBridge.onAppendFlush = () => this.flushRendererGrowOnlyAppends()
    this.nftShapeBridge = new NftShapeBridge(this.readComponents, cache, () => this.bridge?.getEntityNodes())
    this.collision = new CollisionSystem(host.scene)
    this.gltfColliders = new GltfColliderExtractor(host.scene)
    // Extract drop → PhysX removeStatic (cook path uses freezeRemoval and never prunes).
    const onExtractRemoved = (entity: Entity) => this.collidersRemoveCallback?.(entity)
    this.collision.setOnRemoved(onExtractRemoved)
    this.gltfColliders.setOnRemoved(onExtractRemoved)
    this.pointerEvents = new PointerEventsSystem(host.renderer.domElement)
    this.sceneInputRelay = new SceneInputRelay()
    this.triggerAreas = new TriggerAreaSystem()
    this.cameraModeAreas = new CameraModeAreaSystem()
    this.avatarModifiers = new AvatarModifierAreaSystem()
    this.mapPins = new MapPinStore()
    this.raycasts = new RaycastSystem()
    this.avatarShapes.setAssetCache(cache, scene.realm.contentUrl)
    this.bridge.setOnGltfAttached((entity) => {
      this.flushIncrementalColliders(entity)
      // ?noanim — 58bee02 added bind-on-attach; without this guard the isolation flag no longer
      // skips mixer bind (only skipped update + async sync from d35596f).
      if (skipSceneAnimators()) return
      // Explicit Animator: bind immediately (doors / grow / scripted clips).
      // Default auto-play only when the GLB has embedded clips — never promote static GPU
      // instances (terrain/plaza) or colliders extract 0 meshes from empty markers.
      const { Animator } = this.readComponents
      if (Animator.has(entity)) {
        this.bridgeDirty = true
        this.animatorBridge?.markDirty(entity)
        this.animatorBridge?.syncEntity(entity, this.view)
      } else if (this.bridge?.entityGltfHasAnimations(entity)) {
        // GPU-instanced boards (pixelwars tiles with unused export clips) have no private
        // hierarchy — skip default autoplay so we do not force clone / mixers × N.
        const nodes = this.bridge.getEntityNodes()
        const obj = nodes.get(entity)
        if (obj?.userData.dclInstanced) {
          // Rest pose on GPU instance — keep INSTANCE_COLLIDER_SHAPES + 1 draw.
        } else {
          // Includes fishing bobber float clips — rest-pose scale can hide until bind.
          this.bridgeDirty = true
          this.animatorBridge?.markDirty(entity)
          this.animatorBridge?.syncEntityAllowDefaultAutoplay(entity, this.view)
        }
      }
      // else: static terrain/props stay GPU-instanced with INSTANCE_COLLIDER_SHAPES intact
    })
    this.bridge.setRecordLww(this.recordRendererLww)
    this.bindSceneUiViewportSync(host)
    this.prepared = true
  }

  /** Re-layout DOM overlay when the WebGL canvas rect changes (window resize, sidebar, etc.). */
  repaintSceneUiOnViewportResize(): void {
    if (!this.sceneUiBridge?.hasCommittedMountSet()) return
    this.applyUiFrame([])
  }

  private bindSceneUiViewportSync(host: SceneHost): void {
    this.unbindSceneUiViewportSync()
    const repaint = () => this.repaintSceneUiOnViewportResize()
    const onWindowResize = () => repaint()
    window.addEventListener('resize', onWindowResize)
    this.unbindSceneUiWindowResize = () => window.removeEventListener('resize', onWindowResize)
    if (typeof ResizeObserver !== 'undefined') {
      this.sceneUiResizeObserver = new ResizeObserver(() => repaint())
      this.sceneUiResizeObserver.observe(host.renderer.domElement)
    }
  }

  private unbindSceneUiViewportSync(): void {
    this.sceneUiResizeObserver?.disconnect()
    this.sceneUiResizeObserver = null
    this.unbindSceneUiWindowResize?.()
    this.unbindSceneUiWindowResize = null
  }

  /** Called by World — per-entity enqueue or queue drain while GLBs attach. */
  setCollidersCookCallback(callback: ((entity?: Entity) => void) | null): void {
    this.collidersCookCallback = callback
  }

  /** Called by World — slide PhysX actor poses after colliderPoseDirty (no cook). */
  setCollidersPoseCallback(callback: ((entities: Entity[]) => void) | null): void {
    this.collidersPoseCallback = callback
  }

  /**
   * Called by World — invalidate PhysX statics when MeshCollider / GltfContainer extracts drop.
   * ECS destroy alone only clears extract maps; freezeRemoval keeps orphan actors forever otherwise.
   */
  setCollidersRemoveCallback(callback: ((entity: Entity) => void) | null): void {
    this.collidersRemoveCallback = callback
  }

  /** External systems (tweens, scripts) can mark movers without ECS Transform writes. */
  markColliderPoseDirty(entity: Entity): void {
    const { MeshCollider, GltfContainer } = this.readComponents
    if (MeshCollider.has(entity) || GltfContainer.has(entity)) {
      this.colliderPoseDirty.add(entity)
    }
    this.markDescendantColliderPosesDirty(entity)
  }

  /** Structure change on `root` and collider-bearing descendants only (never ancestors/siblings). */
  markColliderStructureDirty(root: Entity): void {
    const { MeshCollider, GltfContainer } = this.readComponents
    if (MeshCollider.has(root) || GltfContainer.has(root)) {
      this.colliderStructureDirty.add(root)
    }
    this.markDescendantColliderStructureDirty(root)
  }

  /** Transform subtree under `root` — collider roots for scoped PhysX cook enqueue. */
  collectColliderEntitiesInSubtree(root: Entity): Entity[] {
    const out: Entity[] = []
    const stack: Entity[] = [root]
    while (stack.length > 0) {
      const entity = stack.pop()!
      if (this.colliderRootEntities.has(entity)) out.push(entity)
      const children = this.transformChildren.get(entity)
      if (children) {
        for (const child of children) stack.push(child)
      }
    }
    return out
  }

  getPhysicsColliderDesc(physEntity: number): PhysicsColliderDesc | null {
    if (physEntity >= 20_000_000) {
      const ecsEntity = (physEntity - 20_000_000) as Entity
      return this.gltfColliders?.getPhysicsColliderForEntity(ecsEntity) ?? null
    }
    if (physEntity >= 19_000_000) {
      return (
        this.gltfColliders?.getPhysicsColliders().find((d) => d.entity === physEntity) ?? null
      )
    }
    return this.collision?.getPhysicsColliderForEntity(physEntity as Entity) ?? null
  }

  /** ECS GltfContainer / MeshCollider entity → PhysX actor id(s) to cook. */
  collectPhysCookTargets(ecsEntity: Entity): number[] {
    const out: number[] = []
    if (this.collision?.hasPhysicsCollider(ecsEntity)) out.push(ecsEntity)
    if (this.gltfColliders?.hasExtractedCollider(ecsEntity)) out.push(gltfPhysicsEntityId(ecsEntity))
    return out
  }

  /** All physics descriptors — for loading reconciliation and force-recook. */
  getAllPhysicsColliderDescs(): PhysicsColliderDesc[] {
    const mesh = this.collision?.getPhysicsColliders() ?? []
    const gltf = this.gltfColliders?.getPhysicsColliders() ?? []
    return [...mesh, ...gltf]
  }

  /** Physics descriptors for motion emitter entities only — O(moved), not O(scene). */
  getPhysicsColliderDescsForEntities(entities: readonly Entity[]): PhysicsColliderDesc[] {
    const descs: PhysicsColliderDesc[] = []
    for (const entity of entities) {
      const mesh = this.collision?.getPhysicsColliderForEntity(entity)
      if (mesh) descs.push(mesh)
      const gltf = this.gltfColliders?.getPhysicsColliderForEntity(entity)
      if (gltf) descs.push(gltf)
    }
    return descs
  }

  getLastPoseChangedEntities(): readonly Entity[] {
    return this.lastPoseChangedEntities
  }

  /**
   * Motion sources that may move this frame — O(active tweens / PART doors / billboards + ground),
   * not O(all colliders) and **not** every bound decorative mixer.
   *
   * Walk lag: previously every `getActiveEntities()` with ECS Animator + extracted collider
   * entered the platform snapshot path every frame while walking — plaza paid walk-surface
   * baselines for dozens of looping props that never move PhysX hulls.
   */
  collectMotionSnapshotCandidates(groundEcs: Entity | null): Set<Entity> {
    const out = new Set<Entity>()
    const { MeshCollider, GltfContainer } = this.readComponents
    const addColliderEntity = (entity: Entity): void => {
      if (MeshCollider.has(entity) || GltfContainer.has(entity)) out.add(entity)
      // Parent Transform movers (crazy-floor-tile) — include collider-bearing descendants
      for (const e of this.expandToExtractedColliderEntities(entity)) out.add(e)
    }

    if (groundEcs !== null) {
      if (
        this.gltfColliders?.hasExtractedCollider(groundEcs) ||
        MeshCollider.has(groundEcs) ||
        this.colliderRootEntities.has(groundEcs)
      ) {
        out.add(groundEcs)
      }
    }

    for (const entity of this.tweenBridge?.getActiveTweenEntities() ?? []) {
      addColliderEntity(entity)
    }

    // PART doors / one-shots only — same set as pushColliderPartPoses (not all mixers).
    for (const entity of this.animatorBridge?.getActiveMixerEntities() ?? []) {
      if (GltfContainer.has(entity) && this.gltfColliders?.hasExtractedCollider(entity)) {
        out.add(entity)
      }
    }
    for (const entity of this.animatorBridge?.pendingShapeMotionEntities() ?? []) {
      if (GltfContainer.has(entity) && this.gltfColliders?.hasExtractedCollider(entity)) {
        out.add(entity)
      }
    }

    for (const entity of this.entityStore?.getBillboardEntities() ?? []) {
      addColliderEntity(entity)
    }

    for (const entity of this.lastSyncFrameTransformEntities) {
      addColliderEntity(entity)
    }

    return out
  }

  /** Pre-bridge walk-surface / animator-origin baselines for motion candidates. */
  snapshotMotionBaselines(
    entities: ReadonlySet<Entity>,
    feet: THREE.Vector3,
    groundEcs: Entity | null
  ): void {
    const nodes = this.bridge?.getEntityNodes()
    if (nodes) this.gltfColliders?.snapshotWalkSurfaceForEntities(nodes, entities, feet)
    if (groundEcs !== null) this.snapshotAnimatorOriginPositions(feet, groundEcs)
  }

  /** Union of all motion emitters after bridges + syncCollision — O(moved). */
  consumeFrameMotionEntities(): ReadonlySet<Entity> {
    const { transformDirty, animatorPart } = this.getPhysMotionSets()
    const out = new Set<Entity>(transformDirty)
    for (const e of animatorPart) out.add(e)
    for (const entity of this.lastPoseChangedEntities) out.add(entity)
    return out
  }

  /**
   * PhysX motion sets — **only two sources** (see `docs/COLLIDER_MOTION_POLICY.md`):
   * - `transformDirty` — entity Transform changed (Tween, Billboard, CRDT, system)
   * - `animatorPart` — Animator part/bone motion (one-shot doors) or system part mark
   *
   * Snapshot is frozen after {@link snapshotPhysMotionSets} (post-pump); safe to call repeatedly.
   */
  getPhysMotionSets(): { transformDirty: Set<Entity>; animatorPart: Set<Entity> } {
    if (this.physMotionSnapshot) return this.physMotionSnapshot
    return this.buildPhysMotionSets()
  }

  /** Call once after pumpMotionBridges so transform/animator sets stay stable for the frame. */
  snapshotPhysMotionSets(): { transformDirty: Set<Entity>; animatorPart: Set<Entity> } {
    this.physMotionSnapshot = this.buildPhysMotionSets()
    return this.physMotionSnapshot
  }

  private buildPhysMotionSets(): { transformDirty: Set<Entity>; animatorPart: Set<Entity> } {
    const transformDirty = new Set<Entity>()
    const animatorPart = new Set<Entity>()
    /** ROOT: entity itself + collider-bearing parents/children (parent-driven MeshCollider pads). */
    const addRoot = (entity: Entity): void => {
      for (const e of this.expandToExtractedColliderEntities(entity)) {
        transformDirty.add(e)
      }
    }
    const addPart = (entity: Entity): void => {
      for (const e of this.expandToExtractedColliderEntities(entity)) animatorPart.add(e)
    }

    for (const entity of this.lastSyncFrameTransformEntities) addRoot(entity)
    for (const entity of this.lastTweenMotionEntities) addRoot(entity)
    for (const entity of this.billboardBridge?.pendingMotionEntities() ?? []) addRoot(entity)
    for (const entity of this.systemTransformDirty) addRoot(entity)

    // PART: running one-shots + post-finish settle (final open pose) + this-frame sample marks.
    // Do NOT use every looping mixer — decorative loops thrash PhysX. getPartColliderEntities
    // is doors/curtains only (non-loop running or PART_SETTLE_MS window).
    for (const entity of this.animatorBridge?.getPartColliderEntities() ?? []) addPart(entity)
    for (const entity of this.animatorBridge?.pendingShapeMotionEntities() ?? []) addPart(entity)
    for (const entity of this.systemPartColliders) addPart(entity)

    return { transformDirty, animatorPart }
  }

  /**
   * @deprecated Use {@link getPhysMotionSets} — returns animatorPart only.
   */
  getAnimatedColliderEntities(_groundEcs: Entity | null = null): Set<Entity> {
    return this.getPhysMotionSets().animatorPart
  }

  /**
   * @deprecated Use {@link getPhysMotionSets}.
   */
  getFrameShapeMotionEntities(groundEcs: Entity | null): Set<Entity> {
    return this.getAnimatedColliderEntities(groundEcs)
  }

  /**
   * Animator/pointer entity may not own the GltfContainer extract — walk parents + children
   * for any entity that has multi-shape / MeshCollider physics.
   */
  private expandToExtractedColliderEntities(entity: Entity): Entity[] {
    const found: Entity[] = []
    const seen = new Set<Entity>()
    const consider = (e: Entity): void => {
      if (seen.has(e)) return
      seen.add(e)
      if (this.physEntityIdForPoseSync(e) !== null) found.push(e)
    }
    consider(entity)
    let p: Entity | undefined = this.transformParent.get(entity)
    let guard = 0
    while (p !== undefined && guard++ < 32) {
      consider(p)
      p = this.transformParent.get(p)
    }
    const stack = [...(this.transformChildren.get(entity) ?? [])]
    while (stack.length && guard++ < 64) {
      const c = stack.pop()!
      consider(c)
      const kids = this.transformChildren.get(c)
      if (kids) for (const k of kids) stack.push(k)
    }
    return found
  }

  getGltfColliderMeshWorldFingerprint(entity: Entity, digits = 2): string | null {
    return this.gltfColliders?.getColliderMeshWorldFingerprint(entity, digits) ?? null
  }

  /**
   * Force live shape locals for PART cook, then return **coarse mesh-world** fingerprints
   * for the cook gate (not full gltfColliderPoseFp — that fluttered every frame).
   */
  forceRefreshPartColliderPoses(entities: ReadonlySet<Entity>): Map<Entity, string> {
    const out = new Map<Entity, string>()
    const nodes = this.bridge?.getEntityNodes()
    if (!nodes || !this.gltfColliders) return out
    for (const entity of entities) {
      // Update shape.localMatrix for world cook; gate on coarse mesh world fp only.
      this.gltfColliders.forceRefreshAnimatedShapeLocals(entity, nodes)
      const fp = this.gltfColliders.getColliderMeshWorldFingerprint(entity, 2)
      if (fp) out.set(entity, fp)
    }
    return out
  }

  /** System moved entity Transform (root follow). Prefer writing Transform via ECS when possible. */
  markTransformDirty(entity: Entity): void {
    this.systemTransformDirty.add(entity)
    if (this.physEntityIdForPoseSync(entity) !== null) {
      this.colliderPoseDirty.add(entity)
      this.markDescendantColliderPosesDirty(entity)
    }
  }

  /**
   * System moved **child** colliders (PART path). Prefer Animator for bone doors.
   * @deprecated name — use {@link markSystemPartCollider}
   */
  markSystemAnimatedCollider(entity: Entity): void {
    this.markSystemPartCollider(entity)
  }

  /** System moved child / bone colliders this frame — PART path. */
  markSystemPartCollider(entity: Entity): void {
    this.systemPartColliders.add(entity)
  }

  /** Walk-surface Δ for motion emitter union — replaces full extracted scan. */
  recordWalkSurfaceDeltasForEntities(
    motion: ReadonlySet<Entity>,
    shapeMotion: ReadonlySet<Entity>,
    feet?: THREE.Vector3,
    standPhysEntity?: number | null
  ): Entity[] {
    const nodes = this.bridge?.getEntityNodes()
    if (!nodes || !this.gltfColliders) return []
    const entities = new Set<Entity>(motion)
    for (const entity of shapeMotion) entities.add(entity)
    const priority: Entity[] = []
    if (standPhysEntity !== null && standPhysEntity !== undefined) {
      const ecs = this.standSurfaceEcsFromPhys(standPhysEntity)
      if (ecs !== null) {
        priority.push(ecs)
        entities.add(ecs)
      }
    }
    const changed = this.gltfColliders.computeWalkSurfaceDeltasForEntities(nodes, entities, feet, priority)
    for (const entity of changed) {
      this.colliderPoseDirty.add(entity)
      this.markDescendantColliderPosesDirty(entity)
    }
    return changed
  }

  /** Live matrixWorld from Three.js — must run before isColliderSynced during loading. */
  refreshColliderDescPoses(
    poseSync?: readonly Entity[],
    shapeMotion?: ReadonlySet<Entity>
  ): void {
    const nodes = this.bridge?.getEntityNodes()
    if (!nodes) return
    this.gltfColliders?.refreshLandscapeColliderPoses()
    if (poseSync?.length) {
      this.gltfColliders?.syncPosesForEntities(nodes, poseSync, shapeMotion)
      this.collision?.syncPosesForEntities(nodes, poseSync)
    }
  }

  isAnimatedGltfColliderEntity(entity: Entity): boolean {
    const { Animator, GltfContainer } = this.readComponents
    return GltfContainer.has(entity) && Animator.has(entity)
  }

  /**
   * PhysX pose slides — only entities with live tread motion or active animated shape sync.
   * Do not blanket-sync every scene tween (static floors stay put; avoids CCT cache churn).
   */
  collectPhysXPoseSyncEntities(
    meshMotion: readonly Entity[],
    shapeMotion: ReadonlySet<Entity>
  ): Entity[] {
    const out = new Set<Entity>(meshMotion)
    for (const entity of shapeMotion) out.add(entity)
    return [...out]
  }

  /** Riding + platform-motion scope — only the PhysX actor CCT reported as ground last tick. */
  resolveStandSurfacePhysEntity(
    _feet: THREE.Vector3 | undefined,
    groundPhysEntity: number | null
  ): number | null {
    const INFINITE_GROUND = -1
    if (groundPhysEntity !== null && groundPhysEntity !== INFINITE_GROUND) {
      return groundPhysEntity
    }
    return null
  }

  /**
   * Map CCT ground PhysX actor id → ECS entity for platform riding.
   * - MeshCollider / raw collider root: phys id === ecs entity
   * - GltfContainer: phys id === GLTF_COLLIDER_ENTITY_BASE + ecs
   * - Multi-shape children (40M+): decode parent GLTF phys id → ecs
   * - Landscape / infinite ground: null (no ECS ride map)
   */
  standSurfaceEcsFromPhys(physEntity: number | null): Entity | null {
    if (physEntity === null || physEntity < 0) return null
    // Multi-shape child actors: 40_000_000 + parentPhys * 512 + slot
    const MULTI_SHAPE_CHILD_BASE = 40_000_000
    const MULTI_SHAPE_SLOT_STRIDE = 512
    if (physEntity >= MULTI_SHAPE_CHILD_BASE) {
      const parentPhys = Math.floor((physEntity - MULTI_SHAPE_CHILD_BASE) / MULTI_SHAPE_SLOT_STRIDE)
      return this.standSurfaceEcsFromPhys(parentPhys)
    }
    if (physEntity >= GLTF_COLLIDER_ENTITY_BASE) {
      return (physEntity - GLTF_COLLIDER_ENTITY_BASE) as Entity
    }
    // Landscape band — not an ECS ride entity
    if (physEntity >= LANDSCAPE_COLLIDER_ENTITY_BASE) return null
    // MeshCollider / mesh physics roots use raw ECS entity as phys id
    if (this.colliderRootEntities.has(physEntity as Entity)) {
      return physEntity as Entity
    }
    if (this.readComponents.MeshCollider.has(physEntity as Entity)) {
      return physEntity as Entity
    }
    return null
  }

  physEntityIdForPoseSync(entity: Entity): number | null {
    if (this.gltfColliders?.hasExtractedCollider(entity)) {
      return GLTF_COLLIDER_ENTITY_BASE + entity
    }
    if (this.colliderRootEntities.has(entity)) return entity
    return null
  }

  /** Re-extract / refresh one actor desc immediately before PhysX cook (loading). */
  refreshColliderBeforeCook(physEntity: number): void {
    const nodes = this.bridge?.getEntityNodes()
    if (!nodes) return
    if (physEntity >= LANDSCAPE_COLLIDER_ENTITY_BASE && physEntity < GLTF_COLLIDER_ENTITY_BASE) {
      this.gltfColliders?.refreshLandscapeColliderPoses()
      return
    }
    if (physEntity >= GLTF_COLLIDER_ENTITY_BASE) {
      const ecsEntity = (physEntity - GLTF_COLLIDER_ENTITY_BASE) as Entity
      this.gltfColliders?.invalidateEntitySyncCache(ecsEntity)
      this.gltfColliders?.syncColliderEntity(ecsEntity, this.view, this.readComponents, nodes)
      this.gltfColliders?.finalizeColliderSync()
      return
    }
    this.collision?.syncColliderEntityPose(physEntity as Entity, nodes)
  }

  /** Force fresh GLTF collider extraction from live Three.js poses (boot cook only). */
  invalidateGltfColliderSyncCache(): void {
    this.gltfColliders?.invalidateColliderSyncCache()
  }

  /**
   * Queue every GltfContainer for budgeted structure extract (48/tick) — avoids a single
   * multi-second syncCollisionForce full walk that freezes the bar at ~79%.
   */
  markAllGltfCollidersDirtyForExtract(): void {
    if (!this.bridge) return
    const { GltfContainer, Transform } = this.readComponents
    for (const [entity] of this.view.getEntitiesWith(GltfContainer, Transform)) {
      if (
        entity === this.view.RootEntity ||
        entity === this.view.PlayerEntity ||
        entity === this.view.CameraEntity
      ) {
        continue
      }
      this.colliderStructureDirty.add(entity)
    }
  }

  markSceneGraphDirty(): void {
    this.sceneGraphMatrixDirty = true
  }

  /** Propagate ECS transforms → matrixWorld on the full scene entity graph before collider extract. */
  flushSceneGraphMatrices(): void {
    if (!this.sceneGraphMatrixDirty) return
    this.entityStore?.root.updateMatrixWorld(true)
    this.sceneGraphMatrixDirty = false
  }

  /** Rewrite all GPU-instanced GLTF world matrices after hierarchy is stable. */
  refreshAllInstancedTransforms(): void {
    this.bridge?.refreshAllInstancedTransforms()
  }

  /** Pose-only refresh before runtime PhysX pose push. */
  refreshColliderPose(physEntity: number): void {
    const nodes = this.bridge?.getEntityNodes()
    if (!nodes) return
    if (physEntity >= LANDSCAPE_COLLIDER_ENTITY_BASE && physEntity < GLTF_COLLIDER_ENTITY_BASE) {
      this.gltfColliders?.refreshLandscapeColliderPoses()
      return
    }
    if (physEntity >= GLTF_COLLIDER_ENTITY_BASE) {
      const ecsEntity = (physEntity - GLTF_COLLIDER_ENTITY_BASE) as Entity
      this.gltfColliders?.syncColliderEntityPose(ecsEntity, nodes)
      return
    }
    this.collision?.syncColliderEntityPose(physEntity as Entity, nodes)
  }

  hasColliderWorkPending(): boolean {
    return (
      this.colliderFullWalkRequested ||
      this.colliderStructureDirty.size > 0 ||
      this.colliderPoseDirty.size > 0
    )
  }

  /** Whether syncCollision already ran incremental PhysX pose slides this async pass. */
  hadColliderPoseSyncThisPass(): boolean {
    return this.colliderPosesSyncedThisPass
  }

  /** Route EntityStore notifications to collision / pointer / async bridge systems (Phase 4.2–4.3). */
  private onEntityStoreChange(change: EntityStoreChange): void {
    if (change.entity !== undefined && this.entityStore?.getOwner(change.entity) === 'avatar') {
      return
    }
    const spriteSlot =
      change.entity !== undefined && this.bridge?.isAnimatedSpriteSlot(change.entity) === true

    if (change.kind === 'create' || change.kind === 'destroy') {
      if (spriteSlot) return
      this.pointerStructureDirty = true
      this.triggerStructureDirty = true
      if (change.kind === 'create') {
        const { Transform } = this.readComponents
        if (change.entity !== undefined && Transform.has(change.entity)) {
          this.linkTransformEntity(change.entity, Transform.get(change.entity).parent as Entity)
        }
      } else if (change.kind === 'destroy' && change.entity !== undefined) {
        this.unlinkTransformEntity(change.entity)
        // Always attempt collider teardown — lobby/map entity deletes must drop PhysX
        // even if colliderRootEntities was stale (never rebuilt after partial extract).
        this.removeColliderForEntity(change.entity)
      }
      return
    }

    if (change.kind !== 'put' && change.kind !== 'delete') return
    const { entity, componentId } = change
    if (entity === undefined || componentId === undefined) return

    const {
      Transform,
      MeshCollider,
      GltfContainer,
      PointerEvents,
      TriggerArea,
      MeshRenderer,
      Animator,
      AvatarShape,
      Billboard
    } = this.readComponents

    if (spriteSlot) {
      if (
        componentId === PointerEvents.componentId ||
        componentId === MeshCollider.componentId ||
        (componentId === MeshRenderer.componentId && PointerEvents.has(entity))
      ) {
        this.pointerStructureDirty = true
      }
      if (componentId === MeshCollider.componentId) {
        this.markColliderStructureDirty(entity)
      } else if (componentId === GltfContainer.componentId) {
        this.colliderStructureDirty.add(entity)
      }
      return
    }

    if (componentId === MeshCollider.componentId) {
      // put OR delete — after delete, has() is false so markColliderStructureDirty would no-op.
      if (change.kind === 'delete') {
        this.colliderStructureDirty.add(entity)
      } else {
        this.markColliderStructureDirty(entity)
      }
    } else if (componentId === GltfContainer.componentId) {
      // GltfContainer put: mark THIS entity only. Descendant walk on mass spawn
      // (3k+ GltfContainers) was O(n²) and multi-second — children get their own puts.
      // delete: always dirty so extract maps + PhysX drop (lobby HF removes walls this way too).
      if (change.kind === 'delete') {
        this.colliderStructureDirty.add(entity)
      } else if (MeshCollider.has(entity) || GltfContainer.has(entity)) {
        this.colliderStructureDirty.add(entity)
      }
    } else if (componentId === Transform.componentId) {
      if (change.kind === 'delete') {
        this.unlinkTransformEntity(entity)
        return
      }
      this.linkTransformEntity(entity, Transform.get(entity).parent as Entity)
      if (MeshCollider.has(entity) || GltfContainer.has(entity)) {
        this.colliderPoseDirty.add(entity)
      }
      this.markDescendantColliderPosesDirty(entity)
    } else if (componentId === Billboard.componentId && change.kind === 'put') {
      this.entityStore?.setBillboard(entity, true)
    }

    if (
      componentId === PointerEvents.componentId ||
      componentId === GltfContainer.componentId ||
      (componentId === MeshRenderer.componentId && PointerEvents.has(entity)) ||
      componentId === MeshCollider.componentId
    ) {
      this.pointerStructureDirty = true
    }

    // Late PE / MeshCollider after GPU instance attach — private mesh for raycast.
    // Also when Tween lands on a MeshRenderer instance (click-move must leave GPU slots).
    if (
      change.kind === 'put' &&
      (componentId === PointerEvents.componentId ||
        componentId === MeshCollider.componentId ||
        componentId === this.readComponents.Tween.componentId)
    ) {
      this.bridge?.ensurePointerMeshClone(entity)
      if (componentId === this.readComponents.Tween.componentId) {
        this.bridge?.ensureMeshRendererTweenVisual(entity)
      }
    }

    // Only TriggerArea structure / pose — do NOT dirty on every GltfContainer put
    // (plaza attach floods rebuilds and drowns diagnostics).
    if (
      componentId === TriggerArea.componentId ||
      (componentId === Transform.componentId && TriggerArea.has(entity))
    ) {
      this.triggerStructureDirty = true
    }

    const ParticleSystem = this.readComponents.ParticleSystem
    if (
      componentId === GltfContainer.componentId ||
      componentId === Animator.componentId ||
      componentId === AvatarShape.componentId ||
      componentId === ParticleSystem.componentId ||
      (componentId === Transform.componentId &&
        (Animator.has(entity) ||
          AvatarShape.has(entity) ||
          GltfContainer.has(entity) ||
          ParticleSystem.has(entity)))
    ) {
      this.bridgeDirty = true
      // Animator dirty-only bind — NOT Transform. Transform/tween motion is a different path.
      // Animator put: re-apply clips (one-shot shouldReset). Gltf put/delete: rebind or drop mixer.
      if (componentId === Animator.componentId) {
        if (change.kind === 'delete') this.animatorBridge?.markRemoved(entity)
        else this.animatorBridge?.markDirty(entity)
      } else if (componentId === GltfContainer.componentId) {
        if (change.kind === 'delete') this.animatorBridge?.markRemoved(entity)
        else this.animatorBridge?.markDirty(entity)
      }
    }
  }

  /**
   * GLB mesh landed — mark collider structure dirty only.
   * Extract / pose / PhysX cook commit in World.applyPhysicsColliders (async frame).
   * Also dirties ancestor collider poses: attaching a child can settle parent matrixWorld
   * for already-cooked solids (otherwise PhysX stays at mid-hydration pose).
   */
  flushIncrementalColliders(entity: Entity): void {
    this.markColliderStructureDirty(entity)
    this.markAncestorColliderPosesDirty(entity)
    this.pointerStructureDirty = true
  }

  /** Walk Transform parents — any already-extracted collider root must pose-slide. */
  private markAncestorColliderPosesDirty(entity: Entity): void {
    let parent = this.transformParent.get(entity)
    while (parent !== undefined) {
      if (this.colliderRootEntities.has(parent)) {
        this.colliderPoseDirty.add(parent)
      }
      parent = this.transformParent.get(parent)
    }
  }

  /**
   * Loading-screen tick — defer collider extract until prewarm/boot (syncCollisionForce).
   * Extraction during attach blocked the 900+ GLTF hydration burst on plaza-scale scenes.
   */
  flushHydrationCollisionWork(): void {
    // colliderStructureDirty accumulates; prewarmPhysicsColliders runs the authoritative full walk.
  }

  /** Full GLTF/MeshCollider extraction — hydration, spawn cook, and force-recook only. */
  syncCollisionForce(): void {
    this.colliderFullWalkRequested = true
    this.syncCollision()
  }

  private linkTransformEntity(entity: Entity, parent: Entity | undefined): void {
    const normalizedParent = parent !== undefined && parent !== 0 ? parent : undefined
    const prev = this.transformParent.get(entity)
    if (prev !== undefined && prev !== normalizedParent) {
      this.transformChildren.get(prev)?.delete(entity)
    }
    if (normalizedParent !== undefined) {
      let children = this.transformChildren.get(normalizedParent)
      if (!children) {
        children = new Set()
        this.transformChildren.set(normalizedParent, children)
      }
      children.add(entity)
      this.transformParent.set(entity, normalizedParent)
    } else {
      this.transformParent.delete(entity)
    }
  }

  private unlinkTransformEntity(entity: Entity): void {
    const parent = this.transformParent.get(entity)
    if (parent !== undefined) {
      this.transformChildren.get(parent)?.delete(entity)
      this.transformParent.delete(entity)
    }
    this.transformChildren.delete(entity)
    this.colliderRootEntities.delete(entity)
  }

  private rebuildTransformChildrenIndex(): void {
    this.transformChildren.clear()
    this.transformParent.clear()
    const { Transform } = this.readComponents
    for (const [entity] of this.view.getEntitiesWith(Transform)) {
      this.linkTransformEntity(entity, Transform.get(entity).parent as Entity)
    }
  }

  /**
   * AOI first-frame: re-resolve NetworkParent → Transform.parent after late NetworkEntity puts.
   * Returns how many transforms changed parent.
   */
  rebindAllNetworkParents(): number {
    const n = this.projection.rebindAllNetworkParents()
    if (n > 0) this.rebuildTransformChildrenIndex()
    return n
  }

  /** Children with NetworkParent whose parent NetworkEntity is not on the projection yet. */
  countUnresolvedNetworkParents(): number {
    return this.projection.countUnresolvedNetworkParents()
  }

  /** Local parent entity for NetworkParent, or null. */
  resolveNetworkParentLocalEntity(child: Entity): Entity | null {
    return this.projection.resolveNetworkParentLocalEntity(child)
  }

  /**
   * Rebuild full Transform hierarchy on EntityStore (depth-sorted) after NetworkParent rebinds.
   * Used by AOI first-frame so matrixWorld matches the ECS parent graph.
   */
  forceRelinkEntityStoreHierarchy(): number {
    if (!this.entityStore) return 0
    this.rebindAllNetworkParents()
    const { Transform } = this.readComponents
    const entities = new Set<Entity>()
    for (const [entity] of this.view.getEntitiesWith(Transform)) {
      if (
        entity === this.view.RootEntity ||
        entity === this.view.PlayerEntity ||
        entity === this.view.CameraEntity
      ) {
        continue
      }
      entities.add(entity)
    }
    expandTransformAncestors(entities, Transform, this.view)
    const ordered = sortEntitiesByTransformDepth([...entities], Transform)
    const diff = new Map<Entity, Map<number, ProjectionChangeKind>>()
    for (const entity of ordered) {
      diff.set(entity, new Map([[Transform.componentId, 'put']]))
    }
    applySceneDiff(this.entityStore, diff, this.view, this.readComponents, [], {
      notifySecondary: false,
      skipSecondaryNotify: () => true
    })
    this.entityStore.root.updateMatrixWorld(true)
    return ordered.length
  }

  private rebuildColliderRootEntities(): void {
    this.colliderRootEntities.clear()
    for (const desc of this.collision?.getPhysicsColliders() ?? []) {
      this.colliderRootEntities.add(desc.entity as Entity)
    }
    for (const desc of this.gltfColliders?.getPhysicsColliders() ?? []) {
      this.colliderRootEntities.add((desc.entity - GLTF_COLLIDER_ENTITY_BASE) as Entity)
    }
  }

  private removeColliderForEntity(entity: Entity): void {
    const wasRoot = this.colliderRootEntities.has(entity)
    this.colliderStructureDirty.delete(entity)
    this.colliderPoseDirty.delete(entity)
    this.colliderRootEntities.delete(entity)
    const removedMesh = this.collision?.removeColliderEntity(entity) ?? false
    const removedGltf = this.gltfColliders?.removeColliderEntity(entity) ?? false
    // removeColliderEntity already fires onRemoved → World invalidateStaticCollider.
    // If maps were empty but we still tracked a root (stale race), force PhysX drop.
    if (!removedMesh && !removedGltf) {
      if (wasRoot) this.collidersRemoveCallback?.(entity)
      return
    }
    if (removedMesh) this.collision?.finalizeColliderSync()
    if (removedGltf) this.gltfColliders?.finalizeColliderSync()
  }

  setMovePlayerHandler(handler: MovePlayerHandler | null): void {
    this.movePlayerHandler = handler
  }

  setSetCameraTransformHandler(handler: SetCameraTransformHandler | null): void {
    this.setCameraTransformHandler = handler
  }

  setTeleportToHandler(handler: TeleportToHandler | null): void {
    this.teleportToHandler = handler
  }

  setChangeRealmHandler(handler: ChangeRealmHandler | null): void {
    this.changeRealmHandler = handler
  }

  setCopyToClipboardHandler(handler: CopyToClipboardHandler | null): void {
    this.copyToClipboardHandler = handler
  }

  /**
   * After RestrictedActions.movePlayerTo (Flagtag drown / round reset) — ensure worker
   * cooperative ticks are not left paused by a prior UI mount lag, so scene systems can
   * clear InputModifier and advance timers.
   */
  nudgePlayAfterSceneTeleport(): void {
    if (!this.running || !this.worker) return
    this.pendingUiEntities = undefined
    this.clearProjectionUiLag()
    this.forceResumeWorkerSceneTicks('move-player-to')
    // Drive one play frame immediately so PE pose + systems advance this rAF.
    this.tickPlayFrame()
  }

  /** Clear stuck sit/stool mode-freeze on the worker (WASD escape). */
  requestForceLocomotionClear(reason = 'wasd-escape'): void {
    if (!this.running || !this.worker) return
    this.worker.postMessage({
      type: 'force-locomotion-clear',
      reason
    } satisfies MainToWorker)
  }

  /**
   * Host-side stuck VirtualCamera / theater shot exit (Escape or WASD when VC owns lens).
   * Scene player-frame keeps re-emitting MainCamera→VC until the scene unbinds; suppress
   * inbound binds until the worker snapshot is clear so the player can free-look again.
   */
  private hostVcBindSuppress = false

  requestForceVirtualCameraClear(reason = 'escape-vc'): void {
    if (!this.running) return
    const { MainCamera } = this.readComponents
    const { CameraEntity } = this.view
    const main = MainCamera.getOrNull(CameraEntity) as { virtualCameraEntity?: number } | null
    const was = main?.virtualCameraEntity
    this.hostVcBindSuppress = true
    MainCamera.createOrReplace(CameraEntity, {} as never)
    this.projection.clearVcLiveTransformForUnbind()
    this.lastPlayerFrameMainCameraKey = 'cleared'
    this.vcBindHydratePullPending = false
    this.worker?.postMessage({
      type: 'force-locomotion-clear',
      reason: `vc-clear:${reason}`
    } satisfies MainToWorker)
    clientDebugLog.log(
      'vc-lens',
      `force clear MainCamera (was=${was != null ? `e${was}` : 'none'}) — ${reason}`,
      { alsoConsole: true }
    )
    console.info(`[vc-lens] force clear MainCamera (was=${was != null ? `e${was}` : 'none'}) — ${reason}`)
  }

  isHostVirtualCameraSuppressed(): boolean {
    return this.hostVcBindSuppress
  }

  setTriggerEmoteHandler(handler: TriggerEmoteHandler | null): void {
    this.triggerEmoteHandler = handler
  }

  setTriggerSceneEmoteHandler(handler: TriggerSceneEmoteHandler | null): void {
    this.triggerSceneEmoteHandler = handler
  }

  setOpenExternalUrlHandler(handler: OpenExternalUrlHandler | null): void {
    this.openExternalUrlHandler = handler
  }

  setOpenNftDialogHandler(handler: OpenNftDialogHandler | null): void {
    this.openNftDialogHandler = handler
  }

  setAvatarEmoteHandler(handler: AvatarEmoteHandler | null): void {
    this.avatarEmoteBridge?.setPlayerHandler(handler)
  }

  setAvatarAssetCache(cache: AssetCache, peerUrl?: string): void {
    this.avatarShapes?.setAssetCache(cache, peerUrl)
  }

  /** Wire local / remote / NPC skeleton resolvers — call after player avatar loads. */
  setAvatarAttachTargets(resolver: AvatarAttachTargetResolver | null): void {
    this.avatarAttachBridge?.setTargets(resolver)
  }

  /** Player capsule root for spatial audio + Transform.parent=PlayerEntity — call after initCapsule. */
  setSpatialAudioPlayerRoot(getter: (() => THREE.Object3D | null) | null): void {
    this.getSpatialAudioPlayerRoot = getter
    // Same root parents ECS entities under engine.PlayerEntity (Dead Surge tutorial arrow).
    // One-shot reparent when anchors appear (not a full Transform scan every frame).
    this.bridge?.setReservedTransformAnchors(
      getter
        ? {
            getPlayerRoot: () => this.getSpatialAudioPlayerRoot?.() ?? null,
            getCamera: () => this.host?.camera ?? null
          }
        : null,
      this.view
    )
    // PositionalAudio listener ears → avatar chest (not freecam). Same anchor as PE lights.
    const playerRoot = getter?.() ?? null
    this.audioSourceBridge?.attachListenerTo(playerRoot ?? this.host?.camera ?? null)
  }

  /** Binder for `livekit-video://current-stream` (stream-key + Cast share this src). */
  setLiveKitVideoBinder(binder: LiveKitVideoBinder | null): void {
    this.bindLiveKitVideo = binder
  }

  /** Scene LiveKit has remote video — screens prefer current-stream over admin defaultURL. */
  setLiveKitRemoteLiveCheck(check: (() => boolean) | null): void {
    this.isLiveKitRemoteLive = check ?? (() => false)
  }

  private getSpatialAudioAnchors(): SpatialAudioAnchors | null {
    if (!this.host) return null
    return {
      getPlayerRoot: () => this.getSpatialAudioPlayerRoot?.() ?? null,
      getCamera: () => this.host!.camera
    }
  }

  getAvatarShapeSkeleton(entity: Entity) {
    return this.avatarShapes?.getNpcSkeleton(entity) ?? null
  }

  /** Seed PlayerEntity identity components for scene `getPlayer()`. */
  setPlayerIdentity(identity: PlayerMirrorIdentity | null): void {
    this.reserved.setPlayerIdentity(identity)
  }

  /** Host-seeded PlayerIdentityData for Admin Tools / getPlayer parity checks. */
  getPlayerIdentity(): import('../../bridge/playerMirrorIdentity').PlayerMirrorIdentity | null {
    return this.reserved.getPlayerIdentity()
  }

  /**
   * Mirror a remote peer as host-owned PlayerIdentityData + AvatarBase + AvatarEquippedData
   * on the synthetic avatar entity (same path Unity uses for other players in-scene).
   */
  setRemotePlayerIdentity(entity: Entity, identity: PlayerMirrorIdentity | null): void {
    if (!identity) {
      const { PlayerIdentityData, AvatarBase, AvatarEquippedData } = this.readComponents
      for (const id of [
        PlayerIdentityData.componentId,
        AvatarBase.componentId,
        AvatarEquippedData.componentId
      ]) {
        this.encoder.recordComponentDelete(entity, id)
      }
      this.reserved.clearPlayerIdentityOnEntity(entity)
      return
    }
    this.reserved.applyPlayerIdentityToEntity(entity, identity)
  }

  /**
   * Seed RootEntity `RealmInfo` (incl. `isConnectedSceneRoom`) for SDK network
   * REQ_CRDT_STATE / `isStateSyncronized`. Call when LiveKit scene room flips.
   */
  setRealmInfo(info: CommsRealmInfo | null): void {
    this.reserved.setRealmInfo(info)
  }

  /**
   * Prefer a live provider so `isConnectedSceneRoom` tracks LiveKit without
   * sprinkling setRealmInfo after every connect. Refreshed each reserved sync.
   */
  setRealmInfoProvider(provider: (() => CommsRealmInfo | null) | null): void {
    this.realmInfoProvider = provider
  }

  private realmInfoProvider: (() => CommsRealmInfo | null) | null = null
  /** Last isConnectedSceneRoom pushed — detect edge for SDK network REQ_CRDT_STATE. */
  private lastSceneRoomConnected: boolean | null = null
  /**
   * Release LiveKit scene-binary hold after worker main/syncEntity settled.
   * Wired from World → CommsService.setSceneBinaryIngressHold(false).
   */
  private sceneBinaryIngressRelease: (() => void) | null = null

  setSceneBinaryIngressRelease(handler: (() => void) | null): void {
    this.sceneBinaryIngressRelease = handler
  }

  private releaseSceneBinaryIngressAfterMain(): void {
    try {
      this.sceneBinaryIngressRelease?.()
    } catch {
      /* ignore */
    }
  }

  private refreshRealmInfoFromProvider(): void {
    if (!this.realmInfoProvider) return
    const info = this.realmInfoProvider()
    this.reserved.setRealmInfo(info)
    const connected = info?.isConnectedSceneRoom === true
    if (this.lastSceneRoomConnected !== connected) {
      const prev = this.lastSceneRoomConnected
      this.lastSceneRoomConnected = connected
      // Force dirty-only encoder to re-emit RealmInfo so worker SDK RealmInfo.onChange fires
      // (isStateSyncronized → REQ_CRDT_STATE). Without this, first-true is often never seen.
      if (this.encoder && this.view) {
        this.encoder.invalidateLastSerialized(
          this.view.RootEntity,
          this.readComponents.RealmInfo.componentId
        )
      }
      if (connected) {
        clientDebugLog.log(
          'sync',
          `scene network room CONNECTED (was ${prev === null ? 'unset' : prev}) — RealmInfo pulse for isStateSyncronized`,
          { level: 'success', alsoConsole: true }
        )
        this.pushRealmInfoToWorkerNow()
      } else if (prev === true) {
        clientDebugLog.log('sync', 'scene network room DISCONNECTED — isStateSyncronized will reset', {
          level: 'warn',
          alsoConsole: true
        })
      }
    }
  }

  /**
   * Immediately deliver RealmInfo (+ reserved poses) to the worker so SDK network
   * can run requestState / syncEntity without waiting for the next ambient CRDT tick.
   */
  private pushRealmInfoToWorkerNow(): void {
    if (!this.worker || !this.running) return
    this.refreshClientPosesFromProvider()
    if (!this.clientPlayerPose || !this.clientCameraPose) {
      // Poses not ready yet — next syncClientEntities will carry RealmInfo.
      return
    }
    if (this.encoder && this.view) {
      this.encoder.invalidateLastSerialized(
        this.view.RootEntity,
        this.readComponents.RealmInfo.componentId
      )
    }
    this.prepareReservedRoundTrip(this.clientPlayerPose, this.clientCameraPose)
    const bytes = this.encodeRendererCrdt()
    if (!bytes?.byteLength) return
    const copy = bytes.slice()
    this.worker.postMessage(
      { type: 'renderer-inbound-deliver', data: [copy] } satisfies MainToWorker,
      [copy.buffer]
    )
  }

  /**
   * Call after play-ready / scene LiveKit connect — re-pulse RealmInfo so late
   * `isConnectedSceneRoom=true` always reaches SDK network (fishing / syncEntity).
   */
  pulseSceneNetworkConnected(): void {
    this.lastSceneRoomConnected = null
    this.refreshRealmInfoFromProvider()
  }

  private authServerResyncAt = 0

  /**
   * Auth-server scenes (pixelwars paint, Flagtag): SDK sets isRoomReady only when
   * RES_CRDT_STATE is processed **while** RootEntity RealmInfo exists. If RES wins the
   * race (stateIsSyncronized=true, isRoomReady still false), joinRoster / paintTick stay
   * queued forever → no teamAssigned → no Material recolors (crdt-outbound bytes=0).
   *
   * Pulse isConnectedSceneRoom false→true so RealmInfo.onChange re-runs requestState and
   * a later RES can open the room. Debounced (once per 8s).
   */
  resyncAuthServerNetworkRoom(): void {
    if (!this.worker || !this.running) return
    if (!this.realmInfoProvider) return
    const now = performance.now()
    // Was 8s — still saw AUTH_RES storms every ~4s from SDK retries + ready pulse.
    // Keep this rare: each false→true pulse clears stateIsSyncronized and re-fetches RES.
    if (now - this.authServerResyncAt < 30_000) return
    this.authServerResyncAt = now

    const live = this.realmInfoProvider()
    if (!live?.isConnectedSceneRoom) return

    clientDebugLog.log(
      'sync',
      'auth-server present — re-pulsing RealmInfo isConnectedSceneRoom for isRoomReady / teamAssigned',
      { level: 'info', alsoConsole: true }
    )

    const provider = this.realmInfoProvider
    const deliverRealm = (connected: boolean): void => {
      const base = provider?.() ?? live
      this.reserved.setRealmInfo({ ...base, isConnectedSceneRoom: connected })
      if (this.encoder && this.view) {
        this.encoder.invalidateLastSerialized(
          this.view.RootEntity,
          this.readComponents.RealmInfo.componentId
        )
      }
      this.refreshClientPosesFromProvider()
      if (!this.clientPlayerPose || !this.clientCameraPose) return
      this.prepareReservedRoundTrip(this.clientPlayerPose, this.clientCameraPose)
      const bytes = this.encodeRendererCrdt()
      if (!bytes?.byteLength) return
      const copy = bytes.slice()
      this.worker?.postMessage(
        { type: 'renderer-inbound-deliver', data: [copy] } satisfies MainToWorker,
        [copy.buffer]
      )
    }

    // Drop connected so SDK clears isRoomReady + stateIsSyncronized.
    this.lastSceneRoomConnected = false
    deliverRealm(false)

    // Re-assert after worker applies the false pulse (next frames + engine tick).
    window.setTimeout(() => {
      this.lastSceneRoomConnected = false
      deliverRealm(true)
      this.lastSceneRoomConnected = true
    }, 120)
  }

  /** Sample latest player/camera right before outbound CRDT (avoids stale rotation between sync frames). */
  setClientPoseProvider(provider: (() => { player: EntityPose; camera: EntityPose }) | null): void {
    this.clientPoseProvider = provider
  }

  /** EngineInfo + poses + RealmInfo before a renderer→worker CRDT deliver. */
  private prepareReservedRoundTrip(player: EntityPose, camera: EntityPose): void {
    this.engineFrame++
    this.reserved.setEngineCounters(this.engineFrame, this.crdtTick)
    this.reserved.prepareRendererRoundTrip(player, camera)
  }

  /** Push player/camera into the mirror before the worker calls crdtGetState at boot. */
  seedRendererEntities(player: EntityPose, camera: EntityPose): void {
    this.clientPlayerPose = player
    this.clientCameraPose = camera
    this.refreshRealmInfoFromProvider()
    this.prepareReservedRoundTrip(player, camera)
  }

  setCommsHandler(handler: CommsRpcHandler | null): void {
    this.commsHandler = handler
  }

  setSignedFetchHandler(handler: SignedFetchHandler | null): void {
    this.signedFetchHandler = handler
  }

  setSignedFetchGetHeadersHandler(handler: SignedFetchGetHeadersHandler | null): void {
    this.signedFetchGetHeadersHandler = handler
  }

  deliverCommsBinary(sender: string, data: Uint8Array): void {
    if (!this.worker) return
    const copy = data.slice()
    this.worker.postMessage(
      { type: 'comms-receive-binary', sender, data: copy } satisfies MainToWorker,
      [copy.buffer]
    )
  }

  async start(scene: ResolvedScene, cache: AssetCache, host: SceneHost): Promise<void> {
    if (!scene.mainEntry || !scene.entityId) return
    if (!this.prepared) this.prepare(scene, cache, host)
    await this.bootWorker(scene)
  }

  private revokeScriptBlobUrl(): void {
    if (!this.scriptBlobUrl) return
    URL.revokeObjectURL(this.scriptBlobUrl)
    this.scriptBlobUrl = null
  }

  private async bootWorker(scene: ResolvedScene): Promise<void> {
    if (!scene.mainEntry || !scene.entityId) return

    const mainFile = scene.content.find((c) => c.file === scene.mainEntry)
    if (!mainFile) throw new Error(`Main entry not in content: ${scene.mainEntry}`)

    const scriptUrl = scene.assetUrl(mainFile.hash)
    const scriptStarted = performance.now()
    this.bootProgressReporter?.('Fetching scene script…')
    clientDebugLog.log('scene', 'loading scene script and boot files…')
    const [fetchedScript, preloadedFiles, bootSnapshot] = await Promise.all([
      fetch(scriptUrl).then(async (res) => {
        if (!res.ok) throw new Error(`Scene script fetch failed (${res.status}): ${scriptUrl}`)
        const buf = new Uint8Array(await res.arrayBuffer())
        const codeForMirror =
          typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8').decode(buf) : ''
        if (codeForMirror) {
          mirrorSceneBundle({
            entityId: scene.entityId ?? scene.commsPointer,
            commsPointer: scene.commsPointer,
            title: scene.title,
            hash: mainFile.hash,
            scriptUrl,
            code: codeForMirror
          })
        }
        // Keep blob as fallback for older worker paths / hard refresh debugging.
        this.revokeScriptBlobUrl()
        this.scriptBlobUrl = URL.createObjectURL(
          new Blob([buf as BlobPart], { type: 'application/javascript' })
        )
        const scriptCharLength = codeForMirror.length || buf.byteLength
        clientDebugLog.log(
          'scene',
          `scene script ready (${(scriptCharLength / 1024).toFixed(0)} KB, ${((performance.now() - scriptStarted) / 1000).toFixed(1)}s)`
        )
        return { buf, scriptCharLength }
      }),
      this.preloadSceneBootFiles(scene),
      this.seedProjectionFromMainCrdt(scene).then(() => this.buildBootCrdtSnapshot())
    ])
    const scriptCharLength = fetchedScript.scriptCharLength

    // Stable worker URL — Vite content-hashes the module. Dynamic ?v= cache-bust broke
    // worker module graph and left inject messages unhandled (no pointer-deliver-done).
    this.worker = new Worker(new URL('../../shim/worker/sceneWorkerEntry.ts', import.meta.url), {
      type: 'module'
    })

    const transfer: Transferable[] = []
    const transferredBuffers = new Set<ArrayBufferLike>()
    const preloadedPayload: Record<string, { hash: string; content: Uint8Array }> = {}
    for (const [key, file] of Object.entries(preloadedFiles)) {
      const content = file.content
      const buffer = content.buffer
      if (!transferredBuffers.has(buffer)) {
        transferredBuffers.add(buffer)
        transfer.push(buffer as ArrayBuffer)
      }
      preloadedPayload[key] = { hash: file.hash, content }
    }
    // Prefer transferable UTF-8 bytes — multi-MB worlds (Dead Surge ~13MB) must not re-fetch via blob.
    let scriptBytesPayload: Uint8Array | undefined
    if (fetchedScript.buf.byteLength > 0) {
      // Copy into a standalone buffer so transfer does not detach shared views.
      const payload = fetchedScript.buf.slice()
      scriptBytesPayload = payload
      const ab = payload.buffer
      if (!transferredBuffers.has(ab)) {
        transferredBuffers.add(ab)
        transfer.push(ab as ArrayBuffer)
      }
    }
    const bootCrdtData = bootSnapshot.data.map((chunk) => chunk.slice())

    const boot: SceneWorkerBoot = {
      type: 'boot',
      debug: {
        sceneInputSnapshot: SCENE_INPUT_SNAPSHOT_VERBOSE,
        pointerDeliver: POINTER_VERBOSE,
        tweenDeliver: isTweenVerbose(),
        skipTheatre: skipTheatreSceneScript(),
        sceneUiLog: SCENE_UI_LOG
      },
      scene: {
        title: scene.title,
        parcels: scene.parcels,
        baseParcel: scene.baseParcel,
        spawn: scene.spawn,
        contentsBaseUrl: scene.contentsBaseUrl,
        entityId: scene.entityId,
        mainEntry: scene.mainEntry,
        worldName: scene.source.kind === 'world' ? scene.source.worldName : undefined,
        scriptUrl,
        scriptBytes: scriptBytesPayload,
        scriptBlobUrl: this.scriptBlobUrl ?? undefined,
        bootCrdtSnapshot: {
          hasEntities: bootSnapshot.hasEntities,
          data: bootCrdtData
        },
        preloadedFiles: Object.keys(preloadedPayload).length ? preloadedPayload : undefined,
        content: scene.content,
        metadataJson: JSON.stringify(scene.metadata ?? {})
      }
    }

    // Large worlds (10MB+) need minutes for patch + new Function; scale with size.
    // Floor 3 min, ~25ms/KB of source, cap 10 min.
    const sizeKb = Math.max(1, scriptCharLength / 1024)
    const BOOT_TIMEOUT_MS = Math.min(600_000, Math.max(180_000, Math.ceil(sizeKb * 25) + 60_000))
    clientDebugLog.log(
      'scene',
      `worker boot timeout budget ${(BOOT_TIMEOUT_MS / 1000).toFixed(0)}s for ${sizeKb.toFixed(0)} KB script`
    )
    this.bootCrdtSendSerial = Promise.resolve()
    this.bootPhaseActive = true
    await new Promise<void>((resolve, reject) => {
      if (!this.worker) return reject(new Error('Worker missing'))

      let settled = false
      const compileStartedAt = performance.now()
      let bootDeadline = compileStartedAt + BOOT_TIMEOUT_MS
      let bootTimer = 0

      const armBootTimer = (): void => {
        if (bootTimer) clearTimeout(bootTimer)
        const remaining = Math.max(1_000, bootDeadline - performance.now())
        bootTimer = window.setTimeout(() => {
          if (settled) return
          if (performance.now() < bootDeadline) {
            armBootTimer()
            return
          }
          finish(() =>
            reject(
              new Error(
                `Scene worker bundle compile timed out (${(BOOT_TIMEOUT_MS / 1000).toFixed(0)}s budget) — check console for [sceneWorker] compile / onStart logs; hard-refresh if the worker bundle is stale`
              )
            )
          )
        }, remaining)
      }

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        if (bootTimer) clearTimeout(bootTimer)
        this.clearCompileProgressTimer()
        this.revokeScriptBlobUrl()
        fn()
      }

      const noteCompileProgress = (phase: string, elapsedMs?: number, scriptKb?: number): void => {
        // Extend deadline while the worker is actively patching/compiling.
        bootDeadline = Math.max(bootDeadline, performance.now() + 90_000)
        armBootTimer()
        const sec = ((elapsedMs ?? performance.now() - compileStartedAt) / 1000).toFixed(0)
        const size = scriptKb != null ? ` · ${scriptKb} KB` : ''
        this.bootProgressReporter?.(`Compiling scene… ${phase} (${sec}s${size})`)
        clientDebugLog.log('scene', `compile-progress — ${phase} @ ${sec}s${size}`, {
          throttleMs: 2000,
          throttleKey: 'compile-progress'
        })
      }

      armBootTimer()

      this.engineApiEvents.bind((events) => {
        this.worker?.postMessage({ type: 'engine-api-enqueue', events } satisfies MainToWorker)
      })

      this.worker.onmessage = (ev: MessageEvent<SceneWorkerOutbound>) => {
        const msg = ev.data
        if (msg?.type === 'vc-bind-hydrate') {
          // FocusOwner: only primary (and PE) may drive VirtualCamera lens.
          if (this.focusPolicy === 'secondary') return
          this.applyVcBindHydrate(msg.bind, msg.graphKey)
          return
        }
        if (msg?.type === 'player-frame') {
          // Secondary must never apply InputModifier / MainCamera (freeze freecam after demote).
          if (this.focusPolicy === 'secondary') return
          this.applyPlayerFrame(msg)
          return
        }
        if (msg?.type === 'vc-pose-live') {
          if (this.focusPolicy === 'secondary') return
          this.applyVcPoseLive(msg.entity as Entity, msg.transform as DclTransformValues)
          return
        }
        if (msg?.type === 'pointer-deliver-done') {
          this.onPointerDeliverDone()
          return
        }
        if (msg?.type === 'crdt-get-state') {
          this.respondCrdtGetState(msg.id)
          return
        }
        if (msg?.type === 'compile-progress') {
          noteCompileProgress(msg.phase, msg.elapsedMs, msg.scriptKb)
          return
        }
        if (msg?.type === 'eval-done') {
          clientDebugLog.log('scene', 'Scene bundle compiled — hydrating while onStart runs', {
            level: 'success',
            alsoConsole: true
          })
          this.running = true
          this.bootProgressReporter?.('Scene script compiled — loading assets…')
          if (!settled) finish(resolve)
          return
        }
        if (msg?.type === 'crdt-send' && this.bootPhaseActive) {
          this.bootCrdtSendSerial = this.bootCrdtSendSerial
            .then(() => this.handleCrdtSendBootFast(msg))
            .catch((err) => {
              console.error(
                '[scene]',
                `boot crdt-send failed — ${err instanceof Error ? err.message : String(err)}`
              )
            })
          return
        }
        // Boot progress for loading UI; browser console only if Help → console mirror is on.
        if (msg?.type === 'log' && /\[sceneWorker\]/.test(msg.message)) {
          const line = msg.message.replace(/^\[(?:log|info|warn|error|debug)\]\s*/, '')
          clientDebugLog.log('scene', line, { throttleMs: 80, throttleKey: 'scene-worker-boot' })
          if (/patching|compiling|evaluated|script ready|transferred script|compile fallback/i.test(msg.message)) {
            noteCompileProgress(msg.message.replace(/^\[sceneWorker\]\s*/i, '').slice(0, 72))
          }
          return
        }
        void this.handleWorkerMessage(msg, () => finish(resolve), (err) => finish(() => reject(err)))
      }
      this.worker.onerror = (err) => finish(() => reject(err instanceof ErrorEvent ? err : new Error('Scene worker error')))

      this.startCompileProgressTimer()
      this.bootProgressReporter?.(`Compiling scene script… (0s, ${sizeKb.toFixed(0)} KB)`)
      // Yield so the loading screen can paint before the (still non-trivial) boot postMessage.
      requestAnimationFrame(() => {
        try {
          this.worker?.postMessage(boot, transfer)
        } catch (err) {
          finish(() =>
            reject(err instanceof Error ? err : new Error(`Scene worker boot postMessage failed — ${String(err)}`))
          )
        }
      })
    })

    this.bootProgressReporter = null
    if (!this.running) this.running = true
    if (isMotionFocusActive() && typeof globalThis !== 'undefined') {
      const g = globalThis as typeof globalThis & {
        __dumpMotionFocus?: () => void
        __inspectEntity?: (id: number) => void
      }
      g.__dumpMotionFocus = () => this.dumpMotionFocusNow()
      g.__inspectEntity = (id: number) => this.inspectEntity(id as Entity)
    }
  }

  private async handleWorkerMessage(
    msg: SceneWorkerOutbound,
    onReady: () => void,
    onError: (err: Error) => void
  ): Promise<void> {
    try {
      await this.dispatchWorkerMessage(msg, onReady, onError)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('scene', `worker message failed (${msg.type}) — ${message}`, { level: 'error' })
      onError(err instanceof Error ? err : new Error(message))
    }
  }

  private async dispatchWorkerMessage(
    msg: SceneWorkerOutbound,
    onReady: () => void,
    onError: (err: Error) => void
  ): Promise<void> {
    if (msg.type === 'ready') {
      this.bootPhaseActive = false
      const readyUiEntities = msg.uiEntities
      // engine.update(0) outbound may still be in the microtask queue — paint after it lands.
      // Omit uiEntities when boot had none — never commit an empty mount over a prior flush.
      this.crdtOutboundSerial = this.crdtOutboundSerial.then(() => {
        if (readyUiEntities?.length) this.applyUiFrame([], readyUiEntities)
        else this.flushUiFrame()
      })
      clientDebugLog.log('scene', 'Scene worker ready (main thread)', { level: 'success' })
      // Worker waited for main/syncEntity — release LiveKit AUTH_RES / CRDT into the scene.
      // Buffering AUTH_RES until now prevents orphan SeedHolder (syncEntity "already in use")
      // which left paint cell ids mismatched (HUD % up, white tiles, crdt Material bytes=0).
      this.releaseSceneBinaryIngressAfterMain()
      // Ensure SDK network sees connected edge after main settled (requestState if needed).
      this.pulseSceneNetworkConnected()
      // One deferred resync only if auth-server peer is already present (joinRoster / isRoomReady).
      // Avoid hammering AUTH_RES every few seconds — that starved Material cold CRDT under load.
      window.setTimeout(() => {
        if (!this.running) return
        this.resyncAuthServerNetworkRoom()
      }, 600)
      onReady()
      return
    }
    if (msg.type === 'eval-done') {
      return
    }
    if (msg.type === 'error') {
      clientDebugLog.log('scene', msg.message, { level: 'error' })
      onError(new Error(msg.message))
      return
    }
    if (msg.type === 'log') {
      // Scene can emit thousands of unique log lines after connect.
      // Help panel only by default — browser console when Help → “Browser console logs”.
      const noisy =
        /\[DEBUG:POINTER\]|npc:staticData|Animations received|NPC added|equipment:attachments/i.test(
          msg.message
        )
      if (noisy) return
      // High-rate video/trigger append spam — panel only, hard throttle.
      if (/renderer-append-deliver/i.test(msg.message)) {
        clientDebugLog.log('scene', msg.message.replace(/^\[(?:log|info|warn|error|debug)\]\s*/, ''), {
          throttleMs: 2000,
          throttleKey: 'renderer-append-deliver'
        })
        return
      }
      const cleaned = msg.message.replace(/^\[(?:log|info|warn|error|debug)\]\s*/, '')
      // Load-gate spam (every late GLB FINISHED) was flooding DevTools + tanking FPS.
      // Keep real freeze transitions; throttle the rest.
      const loadGateNoise =
        /InputModifier after|InputModifier final|load-gate clear|GltfContainerLoadingState inject|gltf LWW/i.test(
          cleaned
        )
      const loadGateHot =
        /load-gate clear.*wasFrozen=true|disableAll=true|locomotion=blocked/i.test(cleaned)
      // Pointer / ground-ray diagnostics must not share the global 100ms scene-worker-log key
      // (was swallowing level-state isPressed-path lines during click bursts).
      const pointerDiag =
        /level-state edge done|no-target|inject RECEIVED|noTarget=|isPressed-path|isPressed-arm|sticky-clear|pointer-edge-|levelState=|edge-VFX peel|pointer ui egress|planeY0|VFXEDGE/i.test(
          cleaned
        )
      if (loadGateHot || pointerDiag) {
        console.info(`[sceneWorker] ${cleaned}`)
      }
      clientDebugLog.log('scene', cleaned, {
        throttleMs: pointerDiag ? 0 : loadGateNoise ? (loadGateHot ? 500 : 5000) : 100,
        throttleKey: pointerDiag
          ? `scene-worker-pointer-${cleaned.slice(0, 48)}`
          : loadGateNoise
            ? `scene-worker-loadgate-${cleaned.slice(0, 40)}`
            : 'scene-worker-log',
        alsoConsole: pointerDiag
      })
      return
    }
    if (msg.type === 'pointer-deliver-done') {
      this.onPointerDeliverDone()
      return
    }
    if (msg.type === 'ui-virtual-canvas') {
      this.pendingVirtualCanvas = { width: msg.width, height: msg.height }
      this.sceneUiBridge?.setVirtualSize(msg.width, msg.height)
      return
    }
    if (msg.type === 'engine-api-subscribe') {
      this.engineApiEvents.onWorkerSubscribe(msg.eventId)
      return
    }
    if (msg.type === 'engine-api-unsubscribe') {
      this.engineApiEvents.onWorkerUnsubscribe(msg.eventId)
      return
    }
    if (msg.type === 'move-player-to') {
      this.refreshClientPosesFromProvider()
      const success = this.movePlayerHandler?.(msg.body) ?? false
      this.pushReservedTransformsToWorker()
      this.worker?.postMessage({
        type: 'move-player-to-response',
        id: msg.id,
        body: { success } satisfies MovePlayerToResponse
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'teleport-to') {
      const ok = (await this.teleportToHandler?.(msg.body)) ?? false
      this.worker?.postMessage({
        type: 'teleport-to-response',
        id: msg.id,
        body: {} satisfies TeleportToResponse
      } satisfies MainToWorker)
      // Fire-and-forget navigation; response is empty per SDK even if we log failures.
      if (!ok) {
        clientDebugLog.log('scene', 'teleportTo failed or unhandled', { level: 'warn' })
      }
      return
    }
    if (msg.type === 'change-realm') {
      const success = (await this.changeRealmHandler?.(msg.body)) ?? false
      this.worker?.postMessage({
        type: 'change-realm-response',
        id: msg.id,
        body: { success } satisfies ChangeRealmResponse
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'copy-to-clipboard') {
      await this.copyToClipboardHandler?.(msg.body)
      this.worker?.postMessage({
        type: 'copy-to-clipboard-response',
        id: msg.id,
        body: {} satisfies CopyToClipboardResponse
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'trigger-emote') {
      const success = this.triggerEmoteHandler?.(msg.body) ?? false
      this.worker?.postMessage({
        type: 'trigger-emote-response',
        id: msg.id,
        body: { success } satisfies TriggerEmoteResponse
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'trigger-scene-emote') {
      const src = msg.body.src?.trim() ?? ''
      this.logPointer(`trigger-scene-emote received — src=${src}`)
      const success = this.triggerSceneEmoteHandler?.(msg.body) ?? false
      this.logPointer(`trigger-scene-emote response — success=${success} src=${src}`)
      this.worker?.postMessage({
        type: 'trigger-scene-emote-response',
        id: msg.id,
        body: { success } satisfies TriggerSceneEmoteResponse
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'open-external-url') {
      const success = (await this.openExternalUrlHandler?.(msg.body)) ?? false
      this.worker?.postMessage({
        type: 'open-external-url-response',
        id: msg.id,
        body: { success } satisfies OpenExternalUrlResponse
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'open-nft-dialog') {
      const success = (await this.openNftDialogHandler?.(msg.body)) ?? false
      this.worker?.postMessage({
        type: 'open-nft-dialog-response',
        id: msg.id,
        body: { success } satisfies OpenNftDialogResponse
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'set-camera-transform') {
      this.setCameraTransformHandler?.(msg.body)
      this.refreshClientPosesFromProvider()
      this.pushReservedTransformsToWorker()
      this.worker?.postMessage({
        type: 'set-camera-transform-response',
        id: msg.id,
        body: {} satisfies SetCameraTransformResponse
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'set-comms-adapter') {
      const body = (await this.commsHandler?.setCommunicationsAdapter(msg.body)) ?? { success: false }
      this.worker?.postMessage({
        type: 'set-comms-adapter-response',
        id: msg.id,
        body
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'comms-send-binary') {
      const body = (await this.commsHandler?.sendBinary(msg.body)) ?? { data: [] }
      this.worker?.postMessage({
        type: 'comms-send-binary-response',
        id: msg.id,
        body
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'comms-send') {
      try {
        await this.commsHandler?.send(msg.body)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        clientDebugLog.log('comms', `comms-send failed — ${detail}`, { level: 'warn' })
      }
      this.worker?.postMessage({
        type: 'comms-send-response',
        id: msg.id,
        body: {}
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'get-user-data') {
      const body = (await this.commsHandler?.getUserData()) ?? {}
      this.worker?.postMessage({
        type: 'get-user-data-response',
        id: msg.id,
        body
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'get-realm') {
      const body = (await this.commsHandler?.getRealm()) ?? {}
      this.worker?.postMessage({
        type: 'get-realm-response',
        id: msg.id,
        body
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'comms-subscribe-topic') {
      const body = (await this.commsHandler?.subscribeToTopic(msg.body)) ?? {}
      this.worker?.postMessage({
        type: 'comms-subscribe-topic-response',
        id: msg.id,
        body
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'comms-unsubscribe-topic') {
      const body = (await this.commsHandler?.unsubscribeFromTopic(msg.body)) ?? {}
      this.worker?.postMessage({
        type: 'comms-unsubscribe-topic-response',
        id: msg.id,
        body
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'comms-publish-data') {
      const body = (await this.commsHandler?.publishData(msg.body)) ?? {}
      this.worker?.postMessage({
        type: 'comms-publish-data-response',
        id: msg.id,
        body
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'comms-consume-messages') {
      const body = (await this.commsHandler?.consumeMessages(msg.body)) ?? { messages: [] }
      this.worker?.postMessage({
        type: 'comms-consume-messages-response',
        id: msg.id,
        body
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'comms-get-active-video-streams') {
      const body = (await this.commsHandler?.getActiveVideoStreams()) ?? { streams: [] }
      this.worker?.postMessage({
        type: 'comms-get-active-video-streams-response',
        id: msg.id,
        body
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'signed-fetch') {
      const body = (await this.signedFetchHandler?.(msg.body)) ?? {
        ok: false,
        status: 0,
        statusText: 'SignedFetch handler unavailable',
        body: '',
        headers: {}
      }
      this.worker?.postMessage({
        type: 'signed-fetch-response',
        id: msg.id,
        body
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'signed-fetch-get-headers') {
      const body = (await this.signedFetchGetHeadersHandler?.(msg.body)) ?? { headers: {} }
      this.worker?.postMessage({
        type: 'signed-fetch-get-headers-response',
        id: msg.id,
        body
      } satisfies MainToWorker)
      return
    }
    if (msg.type === 'play-frame-done') {
      this.playFrameInFlight = false
      this.playFrameInFlightAt = 0
      return
    }
    if (msg.type === 'crdt-outbound') {
      this.enqueueCrdtOutbound({
        id: msg.id,
        data: msg.data,
        uiEntities: msg.uiEntities,
        uiMountSnapshot: msg.uiMountSnapshot
      })
      return
    }
    if (msg.type === 'crdt-send') {
      if (this.bootPhaseActive) {
        await this.handleCrdtSendBootFast(msg)
        return
      }
      console.warn('[scene] unexpected crdt-send after boot — worker should use crdt-outbound')
      return
    }
    if (msg.type === 'crdt-get-state') {
      this.respondCrdtGetState(msg.id)
      return
    }
  }

  /**
   * Lightweight CRDT apply during worker boot (onStart).
   * Skips pointer/trigger/raycast/tween — those run after `ready` and would serialize
   * hundreds of onStart round-trips behind full renderer sync (~45s stalls).
   */
  private async handleCrdtSendBootFast(
    msg: Extract<SceneWorkerOutbound, { type: 'crdt-send' }>
  ): Promise<void> {
    try {
      this.prepareRendererOutboundState()
      this.projection.applyIncoming(msg.data)
      this.foldProjectionChanges()
      this.crdtTick++
      this.prepareRendererOutboundState()
      const encoderBytes = this.encodeRendererCrdt()
      const data = encoderBytes ? [encoderBytes] : []
      this.worker?.postMessage({ type: 'crdt-response', id: msg.id, data } satisfies MainToWorker)
    } catch (err) {
      console.error(
        '[scene]',
        `boot crdt-send failed — replying empty: ${err instanceof Error ? err.message : String(err)}`
      )
      this.worker?.postMessage({ type: 'crdt-response', id: msg.id, data: [] } satisfies MainToWorker)
      throw err
    }
  }

  private lastOutboundUiEntitiesKey = ''
  /**
   * Content-aware fp of last *applied* mount snapshot (not structure-only).
   * Skip clear+reseed only when content matches — structure-only skip left
   * timer/score rows stuck and paired badly with clear-before-skip.
   */
  private lastAppliedUiMountContentFp = ''

  private enqueueCrdtOutbound(item: {
    id?: number
    data: Uint8Array
    uiEntities?: number[]
    uiMountSnapshot?: WorkerUiMountSnapshotRow[]
  }): void {
    // Hold non-UI pointer chunks until the atomic uiEntities egress arrives.
    if (this.pointerAwaitingWorkerApply && item.uiEntities === undefined) {
      this.pointerOutboundDeferBuffer.push(item)
      return
    }
    if (this.pointerAwaitingWorkerApply && item.uiEntities !== undefined) {
      const batch = [...this.pointerOutboundDeferBuffer, item]
      this.pointerOutboundDeferBuffer = []
      // Serial with hydration batches but do not block enqueue — worker awaits ack before deliver-done.
      this.crdtOutboundSerial = this.crdtOutboundSerial
        .then(() => this.handleCrdtOutboundBatch(batch))
        .catch((err) => {
          console.error(
            '[scene]',
            `pointer ui outbound failed — ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return
    }
    // Gameplay CRDT (Material paint boards, meshes, transforms) — jump ahead of empty UI
    // fingerprint nudges sitting in the pending array (otherwise multi-second recolor lag).
    const hasGameplayPayload = (item.data?.byteLength ?? 0) > 0 && item.uiEntities === undefined
    if (hasGameplayPayload) {
      this.crdtOutboundPending.unshift(item)
    } else {
      this.crdtOutboundPending.push(item)
    }
    // Pointer / hydration UI mount must land before pointer-deliver-done.
    // Before World.start arms SceneLoop receive, keep the old immediate flush (boot).
    if (
      !this.sceneLoopReceiveArmed ||
      this.bootPhaseActive ||
      item.uiEntities !== undefined
    ) {
      this.flushCrdtOutboundPendingSynchronously()
    }
  }

  /** SceneLoop ReceiveFromScene — fold queued worker CRDT on the host clock. */
  drainQueuedCrdtOutbound(): void {
    if (!this.crdtOutboundPending.length) return
    this.flushCrdtOutboundPendingSynchronously()
  }

  private flushCrdtOutboundPendingSynchronously(): void {
    const batch = this.crdtOutboundPending.splice(0)
    if (!batch.length) return
    this.crdtOutboundSerial = this.crdtOutboundSerial
      .then(() => this.handleCrdtOutboundBatch(batch))
      .catch((err) => {
        console.error(
          '[scene]',
          `crdt-outbound handler failed — ${err instanceof Error ? err.message : String(err)}`
        )
      })
  }

  /** Throttle for WSP Phase 0.5 main apply logs. */
  private lastWsp05MainApplyLogAt = 0
  /**
   * WSP 0.5k — last processWorkerOutboundCrdtBatch sub-split (ms).
   * fold=applyIncoming+fold · uiA=mount reseed · drain=lane kick ·
   * sync=pointer+input+triggers+ray+tween · enc=encodeRendererCrdt
   * 0.5k2: sync sub — trg / ray / tw / ptr (when sync dominates).
   */
  private lastWsp05Split = {
    foldMs: 0,
    uiMs: 0,
    drainMs: 0,
    syncMs: 0,
    encMs: 0,
    trgMs: 0,
    rayMs: 0,
    twMs: 0,
    ptrMs: 0
  }

  /** Worker outbound (post-onStart) — ack + renderer-inbound-deliver. */
  private async handleCrdtOutboundBatch(
    batch: {
      id?: number
      data: Uint8Array
      uiEntities?: number[]
      uiMountSnapshot?: WorkerUiMountSnapshotRow[]
    }[]
  ): Promise<void> {
    const ackIds = batch.map((item) => item.id).filter((id): id is number => id !== undefined)
    let inbound: Uint8Array[] = []
    // WSP v2 Phase 0.5 — main apply wall (independent of worker eng.update send/encode).
    const applyT0 = performance.now()
    let batchBytes = 0
    let uiN = 0
    let snapRows = 0
    for (const item of batch) {
      batchBytes += item.data?.byteLength ?? 0
      if (item.uiEntities?.length) uiN = Math.max(uiN, item.uiEntities.length)
      if (item.uiMountSnapshot?.length) snapRows += item.uiMountSnapshot.length
    }
    this.lastWsp05Split = {
      foldMs: 0,
      uiMs: 0,
      drainMs: 0,
      syncMs: 0,
      encMs: 0,
      trgMs: 0,
      rayMs: 0,
      twMs: 0,
      ptrMs: 0
    }
    try {
      if (!this.running) return
      inbound = await this.processWorkerOutboundCrdtBatch(batch)
      if (this.pointerAwaitingWorkerApply) {
        if (inbound.length) this.pendingInboundAfterUiMount = inbound
      } else {
        this.postRendererInboundDeliver(inbound)
      }
      if (!this.crdtOutboundLogged) {
        this.crdtOutboundLogged = true
        clientDebugLog.log(
          'projection',
          'CRDT outbound ACTIVE — worker→main with ack, inbound via renderer-inbound-deliver',
          { level: 'success', alsoConsole: true }
        )
      }
    } finally {
      const applyMs = performance.now() - applyT0
      // Always meter for MainFrameHud / RenderStats pie (apply is off the worker clock).
      perfNoteApplyMs(applyMs)
      // Correlate with [wsp0] send(enc=…) — main apply is off the worker clock.
      if (applyMs >= 16) {
        const now = performance.now()
        if (now - this.lastWsp05MainApplyLogAt >= 1_500) {
          this.lastWsp05MainApplyLogAt = now
          const s = this.lastWsp05Split
          console.warn(
            `[wsp05] main crdt-apply ${applyMs.toFixed(0)}ms n=${batch.length} b=${batchBytes} ` +
              `ui=${uiN} snap=${snapRows} ack=${ackIds.length} inbound=${inbound.length} ` +
              `fold=${s.foldMs.toFixed(0)} uiA=${s.uiMs.toFixed(0)} drain=${s.drainMs.toFixed(0)} ` +
              `sync=${s.syncMs.toFixed(0)}(trg=${s.trgMs.toFixed(0)} ray=${s.rayMs.toFixed(0)} ` +
              `tw=${s.twMs.toFixed(0)} ptr=${s.ptrMs.toFixed(0)}) enc=${s.encMs.toFixed(0)}`
          )
        }
      }
      // Ack after apply (or on failure) — worker must not stall pointer-deliver-done awaiting ack.
      for (const id of ackIds) {
        this.worker?.postMessage({ type: 'crdt-outbound-ack', id } satisfies MainToWorker)
      }
    }
  }

  private filterRendererInboundDuringPointerSession(chunks: Uint8Array[]): Uint8Array[] {
    if (!this.pointerAwaitingWorkerApply && !this.pointerDeliverAwaitingAck) return chunks
    return chunks
      .map((chunk) => stripWorkerAuthoritativeCrdtBytes(chunk))
      .filter((chunk) => chunk.byteLength > 0)
  }

  private postRendererInboundDeliver(chunks: Uint8Array[]): void {
    const filtered = this.filterRendererInboundDuringPointerSession(chunks)
    if (!filtered.length || !this.worker) return
    const copies = filtered.map((chunk) => chunk.slice())
    const transfer: Transferable[] = []
    for (const chunk of copies) {
      const buffer = chunk.buffer
      if (!transfer.includes(buffer)) transfer.push(buffer)
    }
    this.worker.postMessage({ type: 'renderer-inbound-deliver', data: copies } satisfies MainToWorker, transfer)
  }

  private async processWorkerOutboundCrdtBatch(
    batch: {
      id?: number
      data: Uint8Array
      uiEntities?: number[]
      uiMountSnapshot?: WorkerUiMountSnapshotRow[]
    }[]
  ): Promise<Uint8Array[]> {
    const hasPayload = batch.some((item) => item.data?.byteLength > 0)
    const split = this.lastWsp05Split
    try {
      this.prepareRendererOutboundState()
      const projectionDeletes: ProjectionChange[] = []
      const { UiTransform, UiText, UiBackground, UiInput, UiDropdown, PointerEvents } =
        this.readComponents
      // Ui* strip path — PointerEvents on UI entities still rides the structured mount
      // snapshot (not cooperative Ui* strip). World PE without UiTransform is untouched.
      const uiComponentIds = new Set([
        UiTransform.componentId,
        UiText.componentId,
        UiBackground.componentId,
        UiInput.componentId,
        UiDropdown.componentId,
        PointerEvents.componentId
      ])
      let batchTouchesUi = false
      const uiTransformId = UiTransform.componentId
      const latestUiMountSnapshot = [...batch]
        .reverse()
        .find((item) => item.uiMountSnapshot !== undefined)?.uiMountSnapshot
      const hasUiMountSnapshot = latestUiMountSnapshot !== undefined
      /** Mount authority: structured snapshot, or hydration wire emit — never bare uiEntities metadata on play batches. */
      const latestUiEntities = this.resolveOutboundBatchMountEntities(batch, hasUiMountSnapshot)
      /** May be cleared when a partial dirty snapshot must not force a full mount commit. */
      let mountEntitiesForFrame = latestUiEntities
      const uiKey = latestUiEntities?.join(',') ?? ''
      const prevMountKey = this.lastOutboundUiEntitiesKey
      const mountChanged =
        latestUiEntities !== undefined && uiKey !== prevMountKey
      const pointerUiMountBatch =
        hasUiMountSnapshot ||
        batch.some((i) => i.uiMountSnapshot !== undefined || (i.uiEntities?.length ?? 0) > 0)
      // Decide UI reseed skip BEFORE any LWW clear. The 0a950a4 thrash guard cleared
      // always then skipped reseed on structure-only fp → permanent UiTransform=0/N
      // (mount commit deferred + force-resume lag death spiral).
      // Content-aware fp: timer/score UiText must still reseed when values change.
      let skipUiMountReseed = false
      if (hasUiMountSnapshot && latestUiMountSnapshot !== undefined && !mountChanged) {
        const contentFp = uiMountSnapshotContentFp(latestUiMountSnapshot)
        if (contentFp === this.lastAppliedUiMountContentFp && latestUiMountSnapshot.length > 0) {
          skipUiMountReseed = true
        }
      }
      // Integrity only: if mount ids have zero UiTransform, reseed (not a ratio heuristic).
      if (skipUiMountReseed && latestUiEntities?.length) {
        let withTx = 0
        for (const id of latestUiEntities) {
          if (this.view.components.UiTransform.has(id as Entity)) withTx++
        }
        if (withTx === 0) skipUiMountReseed = false
      }
      if (skipUiMountReseed) {
        perfNoteUiMountReseedSkip()
      }

      // Non-UI CRDT always applies (even when UI reseed is skipped).
      if (pointerUiMountBatch) this.projection.beginForceWorkerUiPuts()
      try {
        // Phases 1–3 non-UI first — snapshot last so deferred CRDT cannot clobber UI rows.
        const frozenMountIds = !hasUiMountSnapshot
          ? this.resolveFrozenWorkerMountIds(latestUiEntities)
          : null
        const foldT0 = performance.now()
        for (const item of batch) {
          if (item.uiMountSnapshot !== undefined) continue
          let data = item.data
          if (!data?.byteLength) continue
          const mayCarryInboundUi =
            item.uiEntities !== undefined && item.uiMountSnapshot === undefined
          if (!mayCarryInboundUi) {
            data = stripSceneUiCrdtBytes(data)
            if (frozenMountIds?.size) {
              data = stripEntityDeletesFromCrdtBytes(data, frozenMountIds)
            }
            if (!data.byteLength) continue
          }
          this.projection.applyIncoming(data)
          for (const change of this.projection.changes) {
            if (change.kind === 'delete' && change.componentId === uiTransformId) {
              projectionDeletes.push(change)
            }
            if (uiComponentIds.has(change.componentId)) {
              batchTouchesUi = true
            }
          }
          this.foldProjectionChanges()
        }
        split.foldMs += performance.now() - foldT0

        const uiT0 = performance.now()
        if (!skipUiMountReseed) {
          // Clear LWW only when we are about to re-seed.
          // COD C3 — PE clear only on full-mount / mount-set change. Partial dirty reseeds
          // (timer text) must not wipe PE LWW then re-put (ghost/hand-cursor thrash).
          if (latestUiMountSnapshot !== undefined && latestUiMountSnapshot.length > 0) {
            const snapEntities = new Set<Entity>()
            const snapTx = new Set<number>()
            for (const row of latestUiMountSnapshot) {
              snapEntities.add(row.entity as Entity)
              if (row.componentId === UiTransform.componentId) snapTx.add(row.entity)
            }
            const mountIds = latestUiEntities ?? []
            // Full mount = every listed mount id has a UiTransform row in this snapshot.
            // Partial dirty (timer) = few rows for a large mount list.
            const fullMount =
              mountIds.length > 0 && mountIds.every((id) => snapTx.has(id))
            // Partial dirty: clear only row entities we reseed (no PE wipe).
            // Full mount: do NOT wipe all LWW then re-put (was O(mount×components) hitch on
            // every select open — 180 entities × 5 comps). Force-puts overwrite; PE strip
            // drops removed catchers without a full clear.
            if (snapEntities.size > 0 && !fullMount) {
              this.projection.clearLwwSlotsForEntities(snapEntities, [
                UiTransform.componentId,
                UiText.componentId,
                UiBackground.componentId,
                UiInput.componentId,
                UiDropdown.componentId
              ])
            }
            projectionDeletes.length = 0
            this.projection.changes.length = 0
            this.sceneUiBridge?.ingestMountSnapshot(latestUiMountSnapshot)
            this.projection.applyWorkerUiMountSnapshot(
              latestUiMountSnapshot.map((row) => ({
                entity: row.entity as Entity,
                componentId: row.componentId,
                value: row.value
              })),
              { stripMissingPe: fullMount || mountChanged }
            )
            // Full mount: drop UiText/Bg/Input/Dropdown on snap entities when the snapshot
            // no longer ships that component (no blanket pre-clear).
            if (fullMount && latestUiMountSnapshot.length > 0) {
              this.pruneUiComponentsMissingFromSnapshot(latestUiMountSnapshot)
            }
            perfNoteUiMountPost()
            batchTouchesUi = true
            this.foldProjectionChanges()
            this.lastAppliedUiMountContentFp = uiMountSnapshotContentFp(latestUiMountSnapshot)
            // Partial snapshot must not force commit of a larger mount set (163 ids / 10 rows).
            // That left projection 10/163 and deferred paint forever.
            if (!fullMount && mountChanged && latestUiEntities?.length) {
              const readyIds = latestUiEntities.filter((id) =>
                this.view.components.UiTransform.has(id as Entity)
              )
              if (readyIds.length < latestUiEntities.length) {
                mountEntitiesForFrame = undefined
              }
            }
          } else if (hasUiMountSnapshot) {
            // Empty mount snapshot (welcome unmount) — still touch UI so commitMountSet([]) runs.
            projectionDeletes.length = 0
            this.sceneUiBridge?.ingestMountSnapshot([])
            perfNoteUiMountPost()
            batchTouchesUi = true
            this.lastAppliedUiMountContentFp = '0'
          }
        }
        split.uiMs += performance.now() - uiT0
      } finally {
        if (pointerUiMountBatch) this.projection.endForceWorkerUiPuts()
      }

      // COD C2 — mount commit + paint BEFORE structure/material peels so select HUD /
      // menus never wait behind a large pendingDiff drain on the same outbound batch.
      if (mountEntitiesForFrame !== undefined) this.lastOutboundUiEntitiesKey = uiKey
      {
        const uiPaintT0 = performance.now()
        if (hasPayload || batchTouchesUi || projectionDeletes.length > 0 || mountChanged) {
          if (SCENE_UI_LOG && (hasPayload || hasUiMountSnapshot)) {
            let snapshotUiTransform = 0
            let snapshotUiText = 0
            let snapshotUiBackground = 0
            if (latestUiMountSnapshot?.length) {
              const uiTextId = UiText.componentId
              const uiBackgroundId = UiBackground.componentId
              for (const row of latestUiMountSnapshot) {
                if (row.componentId === uiTransformId) snapshotUiTransform++
                else if (row.componentId === uiTextId) snapshotUiText++
                else if (row.componentId === uiBackgroundId) snapshotUiBackground++
              }
            }
            const mountSize = mountEntitiesForFrame?.length ?? latestUiEntities?.length ?? 0
            let projectionUiTransform = 0
            let projectionUiText = 0
            let projectionUiBackground = 0
            const idsForLog = mountEntitiesForFrame ?? latestUiEntities
            if (idsForLog?.length) {
              for (const entity of idsForLog) {
                const id = entity as Entity
                if (this.view.components.UiTransform.has(id)) projectionUiTransform++
                if (this.view.components.UiText.has(id)) projectionUiText++
                if (this.view.components.UiBackground.has(id)) projectionUiBackground++
              }
            }
            clientDebugLog.log(
              'scene-ui',
              `crdt batch — bytes=${batch.reduce((n, item) => n + (item.data?.byteLength ?? 0), 0)} ` +
                `snapshotRows=${latestUiMountSnapshot?.length ?? 0} touchesUi=${batchTouchesUi} mountChanged=${mountChanged} ` +
                `deletes=${projectionDeletes.length} snapshotUiTransform=${snapshotUiTransform} ` +
                `snapshotUiText=${snapshotUiText} snapshotUiBackground=${snapshotUiBackground} ` +
                `projection=${projectionUiTransform}/${mountSize} text=${projectionUiText} bg=${projectionUiBackground}`,
              { throttleMs: 1500, throttleKey: 'scene-ui-crdt-batch' }
            )
          }
          // Never defer DOM paint during pointer delivery when this batch touched UI (modal open/close).
          if (mountEntitiesForFrame !== undefined || !this.pointerHoldTicksUntilMount || batchTouchesUi) {
            this.applyUiFrame(projectionDeletes, mountEntitiesForFrame)
          }
        } else if (this.projectionLagPendingUi && batchTouchesUi) {
          this.flushUiFrame()
        }
        if (this.pendingUiEntities !== undefined && (hasUiMountSnapshot || batchTouchesUi)) {
          this.flushUiFrame()
        }
        split.uiMs += performance.now() - uiPaintT0
      }

      // COD AAA — lane drain after UI.
      // WSP 0.5k5: ambient CRDT apply only peels **motion** (short budget). Full
      // Motion+Material+Structure pie is owned by rAF syncRenderer — running the full
      // pie here stacked with rAF (drain 10–27ms on [wsp05]). Pointer edges still get
      // motion+material (structure=0) so click VFX stays same-frame.
      if (hasPayload || this.pendingDiff.size > 0) {
        const drainT0 = performance.now()
        const pointerEdge =
          this.pointerAwaitingWorkerApply || this.pointerDeliverAwaitingAck
        try {
          if (pointerEdge) {
            const F = SceneScriptSystem.FRAME
            void this.drainPendingDiffLanes({
              pointerEdge: true,
              deadlineMs: F.POINTER_MOTION_MS + F.POINTER_MATERIAL_MS
            })
          } else {
            void this.drainPendingDiffLanes({
              motionOnly: true,
              deadlineMs: SceneScriptSystem.FRAME.MOTION_MS
            })
          }
        } catch (err) {
          console.warn(
            `[scene] lane drain aborted — ${err instanceof Error ? err.message : String(err)}`
          )
        }
        split.drainMs += performance.now() - drainT0
      }

      {
        const syncT0 = performance.now()
        if (this.pointerAwaitingWorkerApply) {
          this.videoPlayerBridge?.notifyUserPointerDelivered()
          this.videoPlayerBridge?.sync(this.view)
          this.audioSourceBridge?.sync(this.view)
          this.audioStreamBridge?.sync(this.view)
          this.assetLoadBridge?.sync(this.view)
        }

        // WSP 0.5k4 — pointer/input + TriggerArea/raycast already driven every rAF
        // (updatePointerEvents / updateTriggerAreas / updateRaycasts / inputHub).
        // Re-running on every worker CRDT apply was ptr 8–30ms + trg 7–18ms on [wsp05].
        // Keep them only on live pointer edge (inject session) so PE edges stay correct.
        let t = performance.now()
        if (this.pointerAwaitingWorkerApply || this.pointerDeliverAwaitingAck) {
          this.syncPointerInput(this.crdtTick, {
            processPendingDown: false,
            processPendingUp: false
          })
          this.sceneInputRelay?.sync(this.crdtTick)
        }
        split.ptrMs += performance.now() - t
        split.trgMs = 0
        split.rayMs = 0

        t = performance.now()
        // WSP 0.5k5b — only when tweens active (encode path still needs completed states).
        const tweensLive = (this.tweenBridge?.getActiveTweenEntities()?.length ?? 0) > 0
        if (tweensLive || this.pointerAwaitingWorkerApply) {
          this.syncTweenBeforeEncode()
        }
        split.twMs += performance.now() - t

        this.crdtTick++
        split.syncMs += performance.now() - syncT0
      }

      {
        const encT0 = performance.now()
        this.prepareRendererOutboundState()
        const encoderBytes = this.encodeRendererCrdt()
        let inbound = encoderBytes ? [encoderBytes] : []
        const mountSet =
          latestUiEntities?.length && mountChanged
            ? new Set(latestUiEntities.map((e) => e as Entity))
            : undefined
        if (
          mountSet &&
          this.sceneUiBridge &&
          !this.sceneUiBridge.isMountSetReady(this.view, mountSet)
        ) {
          if (inbound.length) {
            this.pendingInboundAfterUiMount = this.filterRendererInboundDuringPointerSession(inbound)
          }
          inbound = []
        } else if (this.pointerAwaitingWorkerApply && inbound.length) {
          inbound = this.filterRendererInboundDuringPointerSession(inbound)
        }
        split.encMs += performance.now() - encT0

        if (!hasPayload && !inbound.length) return []
        return inbound
      }
    } catch (err) {
      console.error(
        '[scene]',
        `processWorkerOutboundCrdt failed — ${err instanceof Error ? err.message : String(err)}`
      )
      return []
    }
  }

  /** Sync boot snapshot response — called from worker.onmessage fast-path during boot. */
  private respondCrdtGetState(id: number): void {
    this.prepareRendererOutboundState()
    let state: { hasEntities: boolean; data: Uint8Array[] } = { hasEntities: false, data: [] }
    try {
      state = this.buildBootstrapSnapshot()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('scene', `crdt-get-state snapshot failed — ${message}`, {
        level: 'error',
        alsoConsole: true
      })
    }
    if (PROJ_PARITY_AUDIT) {
      clientDebugLog.log(
        'projection',
        `boot snapshot — sceneEntities ${this.projection.sceneEntityCount(this.reservedEntities())}, chunks ${state.data.length}`,
        { level: 'info', alsoConsole: true }
      )
    }
    this.worker?.postMessage({
      type: 'crdt-get-state-response',
      id,
      hasEntities: state.hasEntities,
      data: state.data
    } satisfies MainToWorker)
  }

  /**
   * Deployed scenes ship static ECS state in `main.crdt`. Seed the renderer projection
   * before the worker's onStart crdt-get-state — otherwise hasEntities stays false, composite
   * is missing, and hydration never receives GltfContainer (0/0 forever).
   *
   * Keep a raw copy for worker boot: projection only materializes components with registered
   * schemas (core Transform/Gltf/PE/…). Asset-pack Triggers/Actions are hashed custom ids and
   * would be dropped — worker would get hasEntities without Triggers and skip composite, so
   * on_click never registers PointerEvents (wall links show no hover).
   */
  private async seedProjectionFromMainCrdt(scene: ResolvedScene): Promise<void> {
    const entry = scene.content.find((file) => file.file === 'main.crdt')
    if (!entry?.hash) return
    try {
      const res = await fetch(scene.assetUrl(entry.hash))
      if (!res.ok) return
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (!bytes.byteLength) return
      this.mainCrdtRawBytes = bytes.slice()
      this.projection.applyIncoming(bytes)
      this.foldProjectionChanges()
      const entities = this.projection.sceneEntityCount(this.reservedEntities())
      clientDebugLog.log(
        'scene',
        `main.crdt seeded projection (${(bytes.byteLength / 1024).toFixed(0)} KB, ${entities} entities)`
      )
      console.info(
        '[scene]',
        `main.crdt raw kept for worker boot (${(bytes.byteLength / 1024).toFixed(0)} KB) — includes asset-pack Triggers`
      )
    } catch (err) {
      console.warn(
        '[scene]',
        `main.crdt seed failed — ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private async preloadSceneBootFiles(
    scene: ResolvedScene
  ): Promise<Record<string, { hash: string; content: Uint8Array }>> {
    const out: Record<string, { hash: string; content: Uint8Array }> = {}
    const names = ['main.composite', 'assets/scene/main.composite']
    await Promise.all(
      names.map(async (fileName) => {
        const entry =
          scene.content.find((file) => file.file === fileName) ??
          (fileName === 'main.composite'
            ? scene.content.find((file) => file.file === 'assets/scene/main.composite')
            : undefined)
        if (!entry?.hash) return
        try {
          const res = await fetch(scene.assetUrl(entry.hash))
          if (!res.ok) return
          const content = new Uint8Array(await res.arrayBuffer())
          out[fileName] = { hash: entry.hash, content }
          if (fileName === 'assets/scene/main.composite') {
            out['main.composite'] = { hash: entry.hash, content: content.slice() }
          }
        } catch {
          /* composite optional */
        }
      })
    )
    const keys = Object.keys(out)
    if (keys.length) {
      const kb = keys.reduce((sum, key) => sum + out[key]!.content.byteLength, 0) / 1024
      clientDebugLog.log('scene', `preloaded ${keys.length} boot file(s) (${kb.toFixed(0)} KB)`)
    }
    return out
  }

  /** Renderer CRDT snapshot for worker bundle eval (must not round-trip main during sync eval). */
  private buildBootCrdtSnapshot(): { hasEntities: boolean; data: Uint8Array[] } {
    this.prepareRendererOutboundState()
    return this.buildBootstrapSnapshot()
  }

  /**
   * e9: boot snapshot for worker onStart `crdtGetState`.
   *
   * Prefer raw `main.crdt` so custom components (asset-packs::Triggers/Actions) reach the
   * scene engine after the bundle registers them. Projection-only serialize drops unknown
   * componentIds (`putComponent` no meta → return), which produced hasEntities without
   * Triggers and skipped composite — no runtime on_click PointerEvents for wall links.
   */
  private buildBootstrapSnapshot(): { hasEntities: boolean; data: Uint8Array[] } {
    const reserved = this.reservedEntities()
    const reservedBuf = this.encoder.serializeReservedSnapshot().toBinary()
    if (this.mainCrdtRawBytes?.byteLength) {
      const data = [this.mainCrdtRawBytes.slice(), reservedBuf].filter((chunk) => chunk.byteLength > 0)
      console.info(
        '[scene]',
        `boot CRDT snapshot — raw main.crdt ${(this.mainCrdtRawBytes.byteLength / 1024).toFixed(0)} KB (asset-pack Triggers preserved)`
      )
      return { hasEntities: true, data }
    }
    const projBuf = this.projection.serializeSnapshot(undefined, reserved).toBinary()
    const data = [projBuf, reservedBuf].filter((chunk) => chunk.byteLength > 0)
    return {
      hasEntities: this.projection.sceneEntityCount(reserved) > 0,
      data
    }
  }

  /** componentId-free reserved entity id set, for the projection's scene-entity gate. */
  private reservedEntities(): Set<Entity> {
    return new Set<Entity>([SDK_RESERVED.root, SDK_RESERVED.player, SDK_RESERVED.camera])
  }

  private purgeProjectionUiOutsideWorkerMount(): void {
    const workerSet = this.sceneUiBridge?.getWorkerUiEntities()
    // null = mount never committed; empty Set = worker has zero UiTransform (welcome unmount).
    if (workerSet == null) return
    const { UiTransform, UiText, UiBackground, UiInput, UiDropdown, PointerEvents } =
      this.readComponents
    const uiIds = [
      UiTransform.componentId,
      UiText.componentId,
      UiBackground.componentId,
      UiInput.componentId,
      UiDropdown.componentId
    ]
    // PE only on UI ghosts (had UiTransform, left mount). World mesh PE has no UiTransform
    // in the UI mount set path — never purge PE globally by "outside mount".
    const uiGhosts = new Set<Entity>()
    for (const [entity] of this.view.getEntitiesWith(UiTransform)) {
      if (!workerSet.has(entity)) uiGhosts.add(entity)
    }
    if (uiGhosts.size > 0) {
      this.projection.clearLwwSlotsForEntities(uiGhosts, [...uiIds, PointerEvents.componentId])
    }
    // Drop any remaining Ui* rows outside the worker mount (empty mount → purge all Ui*).
    this.projection.purgeEntitiesOutsideSet(workerSet, uiIds)
  }

  /**
   * Single scene UI frame boundary — CRDT must already be applied to projection.
   * Mount set + DOM advance atomically; defers only when projection UiTransform lags uiEntities.
   */
  private applyUiFrame(
    projectionDeletes: readonly ProjectionChange[] = [],
    uiEntities?: number[]
  ): void {
    const bridge = this.sceneUiBridge
    if (!bridge) return
    // FocusOwner: secondary never mutates DOM (demoted primary still holds SceneUiBridge
    // for promote resume — must not fight #scene-ui-root with the new primary).
    if (this.focusPolicy === 'secondary') return

    // Asset hydration: commit mount only — no Yoga/DOM thrash (was flooding "paint deferred"
    // and stealing main-thread from GLB attach → 60s hang at ~79%).
    if (this.bridge?.isAssetHydrationMode()) {
      bridge.applyProjectionChanges(projectionDeletes)
      if (uiEntities !== undefined) {
        const nextSet = new Set(uiEntities.map((e) => e as Entity))
        if (bridge.isMountSetReady(this.view, nextSet)) {
          bridge.commitMountSet(nextSet)
          this.pendingUiEntities = undefined
        } else {
          this.pendingUiEntities = uiEntities
        }
      }
      return
    }

    bridge.applyProjectionChanges(projectionDeletes)
    // Phase C: any UI CRDT/mount path dirties paint; redundant flushes no-op via epoch.
    bridge.markContentDirty()
    this.flushUiFrame(uiEntities)
  }

  /** Committed/pending mount ids — strip DELETE_ENTITY from cooperative non-UI egress on main. */
  private resolveFrozenWorkerMountIds(latestUiEntities?: number[]): ReadonlySet<number> | null {
    const committed = this.sceneUiBridge?.getWorkerUiEntities()
    const pending = this.pendingUiEntities
    const ids =
      pending !== undefined
        ? pending
        : latestUiEntities !== undefined
          ? latestUiEntities
          : committed?.size
            ? [...committed].map((e) => e as number)
            : []
    return ids.length ? new Set(ids) : null
  }

  private resolveOutboundBatchMountEntities(
    batch: {
      data: Uint8Array
      uiEntities?: number[]
      uiMountSnapshot?: WorkerUiMountSnapshotRow[]
    }[],
    hasUiMountSnapshot: boolean
  ): number[] | undefined {
    if (hasUiMountSnapshot) {
      // Prefer explicit mount list — partial dirty snapshots no longer enumerate every UiTransform.
      const withMount = [...batch]
        .reverse()
        .find((item) => item.uiMountSnapshot !== undefined && (item.uiEntities?.length ?? 0) > 0)
      if (withMount?.uiEntities?.length) return withMount.uiEntities
      const snap = [...batch].reverse().find((item) => item.uiMountSnapshot !== undefined)
      return extractSnapshotMountEntityIds(snap?.uiMountSnapshot ?? [])
    }
    for (const item of [...batch].reverse()) {
      if (item.uiEntities === undefined || item.uiMountSnapshot !== undefined) continue
      if (!item.data?.byteLength) continue
      return item.uiEntities
    }
    return undefined
  }

  /** Resume a deferred applyUiFrame after pointer-deliver-done or when projection catches up. */
  private flushUiFrame(uiEntities?: number[]): void {
    const bridge = this.sceneUiBridge
    if (!bridge) return

    const mountUpdate = uiEntities ?? this.pendingUiEntities
    this.pendingUiEntities = undefined

    // Hydration: never paint / Yoga — attach bandwidth only.
    const hydrationFreeze = this.bridge?.isAssetHydrationMode() === true

    if (mountUpdate !== undefined) {
      const nextSet = new Set(mountUpdate.map((e) => e as Entity))
      if (!bridge.isMountSetReady(this.view, nextSet)) {
        this.pendingUiEntities = mountUpdate
        this.markProjectionUiLag(nextSet)
        // Hard-stuck 0/N after wipe: still resume worker so systems (timer dt, InputModifier clear) run.
        this.maybeForceResumeWorkerTicksOnUiLag(nextSet)
        return
      }
      if (hydrationFreeze) {
        bridge.commitMountSet(nextSet)
        this.clearProjectionUiLag()
        return
      }
      this.commitAndPaintUiMount(bridge, nextSet)
      return
    }

    if (hydrationFreeze) return

    if (!bridge.hasCommittedMountSet()) return
    if (!bridge.isMountSetReady(this.view)) {
      this.markProjectionUiLag(bridge.getWorkerUiEntities())
      this.maybeForceResumeWorkerTicksOnUiLag(bridge.getWorkerUiEntities())
      return
    }
    this.clearProjectionUiLag()
    this.purgeProjectionUiOutsideWorkerMount()
    // Phase C: skip paint walk when content epoch already painted (lag resume, double flush).
    if (bridge.isContentDirty()) {
      bridge.paint(this.view)
      this.logSceneUiRepaintIfEnabled()
    }
    if (!this.pointerAwaitingWorkerApply) {
      this.resumeWorkerSceneTicksAfterMountIfHeld()
    }
  }

  private commitAndPaintUiMount(
    bridge: NonNullable<typeof this.sceneUiBridge>,
    nextSet: Set<Entity>
  ): void {
    const mountChanged = bridge.commitMountSet(nextSet)
    this.purgeProjectionUiOutsideWorkerMount()
    // Large mount growth (select HUD 160–200 nodes): commit now, Yoga/DOM next frame so
    // pointer edge / deliver-done are not blocked ~1s by a full tree layout.
    const heavyPaint = nextSet.size >= 64 && mountChanged
    if (heavyPaint) {
      bridge.markContentDirty()
      this.clearProjectionUiLag()
      const view = this.view
      queueMicrotask(() => {
        if (!this.sceneUiBridge || this.sceneUiBridge !== bridge) return
        bridge.paint(view)
        this.logSceneUiRepaintIfEnabled()
      })
    } else {
      bridge.paint(this.view)
      this.clearProjectionUiLag()
      this.logSceneUiRepaintIfEnabled()
    }
    if (mountChanged) {
      this.pointerStructureDirty = true
      this.flushPointerStructureIfDirty()
    }
    if (!this.pointerAwaitingWorkerApply) {
      this.resumeWorkerSceneTicksAfterMountIfHeld()
    }
  }

  /**
   * After full-mount force-puts, drop Ui* components no longer in the snapshot for each
   * entity (without a pre-clear of the whole tree).
   */
  private pruneUiComponentsMissingFromSnapshot(
    rows: readonly { entity: number; componentId: number; value: unknown }[]
  ): void {
    const { UiText, UiBackground, UiInput, UiDropdown } = this.readComponents
    const present = new Map<number, Set<number>>()
    for (const row of rows) {
      let set = present.get(row.entity)
      if (!set) {
        set = new Set()
        present.set(row.entity, set)
      }
      set.add(row.componentId)
    }
    const optional = [
      UiText.componentId,
      UiBackground.componentId,
      UiInput.componentId,
      UiDropdown.componentId
    ]
    for (const [entityNum, comps] of present) {
      const entity = entityNum as Entity
      const drop: number[] = []
      for (const cid of optional) {
        if (comps.has(cid)) continue
        if (this.projection.componentMap(cid)?.has(entity)) drop.push(cid)
      }
      if (drop.length) {
        this.projection.clearLwwSlotsForEntities(new Set([entity]), drop)
      }
    }
  }

  private markProjectionUiLag(mountSet: ReadonlySet<Entity> | null | undefined): void {
    this.projectionLagPendingUi = true
    if (this.projectionLagSinceMs <= 0) this.projectionLagSinceMs = performance.now()
    this.logProjectionLagIfStale(mountSet)
  }

  private clearProjectionUiLag(): void {
    this.projectionLagPendingUi = false
    this.projectionLagSinceMs = 0
    this.projectionLagLoggedAt = 0
  }

  /**
   * If mount commit stays deferred (projection wiped / lagging), do not leave sceneTicksPaused.
   * Worker systems need real dt for Flagtag reset timer; scene must be able to clear InputModifier.
   */
  private maybeForceResumeWorkerTicksOnUiLag(mountSet: ReadonlySet<Entity> | null | undefined): void {
    if (this.projectionLagSinceMs <= 0) return
    const lagMs = performance.now() - this.projectionLagSinceMs
    if (lagMs < SceneScriptSystem.UI_MOUNT_LAG_FORCE_RESUME_MS) return

    const ecs = this.view.components
    let withTransform = 0
    if (mountSet) {
      for (const entity of mountSet) {
        if (ecs.UiTransform.has(entity)) withTransform++
      }
    }

    // Prefer paint whatever is ready so timer text can still update; else just unstick ticks.
    if (this.sceneUiBridge && mountSet && withTransform > 0) {
      const ready = new Set<Entity>()
      for (const entity of mountSet) {
        if (ecs.UiTransform.has(entity)) ready.add(entity)
      }
      console.warn(
        `[scene-ui] force partial mount — ready=${ready.size}/${mountSet.size} after ${Math.round(lagMs)}ms lag`
      )
      this.pendingUiEntities = undefined
      this.commitAndPaintUiMount(this.sceneUiBridge, ready)
      return
    }

    console.warn(
      `[scene-ui] force resume worker ticks — UiTransform ${withTransform}/${mountSet?.size ?? 0} after ${Math.round(lagMs)}ms lag`
    )
    this.pendingUiEntities = undefined
    this.clearProjectionUiLag()
    this.forceResumeWorkerSceneTicks('ui-mount-lag-timeout')
  }

  /** Resume cooperative ticks once mount set + projection UiTransform are aligned after pointer open. */
  private resumeWorkerSceneTicksAfterMountIfHeld(): void {
    if (!this.pointerHoldTicksUntilMount || !this.worker || !this.running) return
    if (!this.canResumeWorkerSceneTicksAfterPointer()) return
    this.forceResumeWorkerSceneTicks('mount-ready')
  }

  private forceResumeWorkerSceneTicks(reason: string): void {
    if (!this.worker || !this.running) return
    this.pointerHoldTicksUntilMount = false
    if (this.pendingInboundAfterUiMount.length) {
      this.postRendererInboundDeliver(this.pendingInboundAfterUiMount)
      this.pendingInboundAfterUiMount = []
    }
    this.worker.postMessage({ type: 'pause-scene-ticks', paused: false } satisfies MainToWorker)
    if (reason !== 'mount-ready') {
      clientDebugLog.log('scene-ui', `worker ticks resumed — ${reason}`)
    }
  }

  private logSceneUiRepaintIfEnabled(): void {
    if (!SCENE_UI_LOG) return
    this.sceneUiRepaintLogCount++
    if (this.sceneUiRepaintLogCount > 8 && this.sceneUiRepaintLogCount % 25 !== 0) return
    clientDebugLog.log('scene-ui', `repaint #${this.sceneUiRepaintLogCount}`)
  }

  /** Attach this system as an InputHub subscriber (`primary` / `pe:…`). */
  setInputHub(hub: InputHub | null, subscriberId?: string): void {
    this.inputHub = hub
    if (subscriberId) this.inputSubscriberId = subscriberId
    this.sceneInputRelay?.setSubscriberId(this.inputSubscriberId)
  }

  /**
   * @deprecated Hub is synced once from World.inputHub.sync — no per-system hardware sync.
   */
  syncSceneInputRelay(_tickNumber: number): void {
    // no-op
  }

  private lastPlayerFrameId = 0
  /** MOVE CAMERA — apply vc-pose-live without MainCamera bind while locomotion is frozen. */
  private playerEditFlightLiveLane = false
  private lastPlayerFrameMainCameraKey = ''
  private lastVcBindHydrateLogKey = ''
  /** One-shot pull if MainCamera is bound but VC components still missing after hydrate race. */
  private vcBindHydratePullPending = false

  /**
   * Hot path — InputModifier + MainCamera only (play mode).
   * VC Transform/VirtualCamera arrive via `vc-bind-hydrate` (graph-hash cold path).
   */
  private applyPlayerFrame(
    msg: Extract<import('../../shim/types').SceneWorkerOutbound, { type: 'player-frame' }>
  ): void {
    if (!this.running) return
    if (this.focusPolicy === 'secondary') return
    if (msg.frameId <= this.lastPlayerFrameId) return
    this.lastPlayerFrameId = msg.frameId
    const { InputModifier, MainCamera, Transform, VirtualCamera } = this.readComponents
    const { PlayerEntity, CameraEntity } = this.view
    const hadBefore = InputModifier.has(PlayerEntity)
    const frozenBefore = hadBefore
      ? readLocomotionFromComponents(this.readComponents, PlayerEntity).disableAll
      : false
    const grace = this.isFocusGraceActive()
    if (msg.inputModifierHas && msg.inputModifier !== undefined) {
      const im = msg.inputModifier as {
        disableAll?: boolean
        disableWalk?: boolean
        disableRun?: boolean
        disableJog?: boolean
        disableJump?: boolean
      }
      // Post-promote grace: strip freeze bits so dual-scene hydrate cannot pin the player.
      if (
        grace &&
        (im.disableAll || im.disableWalk || im.disableRun || im.disableJog || im.disableJump)
      ) {
        InputModifier.deleteFrom(PlayerEntity)
        if (frozenBefore) {
          console.info(
            `[player-frame] focus-grace stripped freeze frameId=${msg.frameId} ` +
              `(promote walk free while primary hydrates)`
          )
        }
      } else {
        InputModifier.createOrReplace(PlayerEntity, msg.inputModifier as never)
      }
    } else {
      // Facade deleteFrom → projection.deleteRenderer (not the unused ECS engine store).
      InputModifier.deleteFrom(PlayerEntity)
    }
    // Stuck theater / VIEW SHOT: host Escape suppress strips scene re-bind until worker clears.
    const inboundMain = (msg.mainCamera ?? {}) as { virtualCameraEntity?: number | null }
    // GP freeRevealCamera: getMutable().virtualCameraEntity = void 0 — treat 0/missing as clear.
    const inboundVcRaw = inboundMain.virtualCameraEntity
    const inboundVc =
      inboundVcRaw === undefined || inboundVcRaw === null || inboundVcRaw === 0
        ? null
        : inboundVcRaw
    if (this.hostVcBindSuppress) {
      if (inboundVc === null) {
        this.hostVcBindSuppress = false
        MainCamera.createOrReplace(CameraEntity, {} as never)
      } else {
        MainCamera.createOrReplace(CameraEntity, {} as never)
      }
    } else if (inboundVc === null) {
      // Explicit unbind — empty put so freecam/orbit recover after fishing reveal cam.
      MainCamera.createOrReplace(CameraEntity, {} as never)
    } else {
      MainCamera.createOrReplace(CameraEntity, {
        virtualCameraEntity: inboundVc
      } as never)
    }
    this.foldProjectionChanges()
    const mainCam = MainCamera.getOrNull(CameraEntity) as { virtualCameraEntity?: number } | null
    const locomotion = readLocomotionFromComponents(this.readComponents, PlayerEntity)
    // Diagnose freeze transitions only — `!imHas` is normal free play and was logging every frame.
    if (frozenBefore || locomotion.disableAll) {
      const hadAfter = InputModifier.has(PlayerEntity)
      console.info(
        `[player-frame] frameId=${msg.frameId} imHas=${msg.inputModifierHas} ` +
          `beforeFrozen=${frozenBefore} afterFrozen=${locomotion.disableAll} afterHas=${hadAfter} ` +
          `locomotion=${canLocomote(locomotion) ? 'allowed' : 'blocked'}`
      )
    }
    const vcUnbound =
      mainCam?.virtualCameraEntity === undefined || mainCam?.virtualCameraEntity === null
    // MOVE CAMERA: frozen locomotion — accept vc-pose-live whether lens is bound or not.
    // (Bound = preview through the VC being flown; unbound = free edit flight.)
    this.playerEditFlightLiveLane = !canLocomote(locomotion)
    if (vcUnbound && canLocomote(locomotion)) {
      this.projection.clearVcLiveTransformForUnbind()
      this.vcBindHydratePullPending = false
    }
    const vcKey = vcUnbound ? 'cleared' : `e${mainCam!.virtualCameraEntity}`
    if (vcKey !== this.lastPlayerFrameMainCameraKey) {
      this.lastPlayerFrameMainCameraKey = vcKey
      const vcEnt = mainCam?.virtualCameraEntity
      const hasTr = vcEnt != null && Transform.has(vcEnt as never)
      const hasVc = vcEnt != null && VirtualCamera.has(vcEnt as never)
      clientDebugLog.log(
        'vc-lens',
        `player-frame MainCamera → ${vcKey}` +
          (vcUnbound ? '' : ` transform=${hasTr} virtualCamera=${hasVc}`)
      )
      if (!vcUnbound && vcEnt != null) {
        // COD D2 — if Transform already on projection, claim live lane immediately so
        // cold CRDT cannot clobber before first hydrate/pose-live arrives.
        if (hasTr) {
          const tr = Transform.get(vcEnt as never) as {
            position: { x: number; y: number; z: number }
            rotation: { x: number; y: number; z: number; w: number }
            scale?: { x: number; y: number; z: number }
            parent?: number
          }
          this.projection.setVcLiveTransform(vcEnt as never, {
            position: tr.position,
            rotation: tr.rotation,
            scale: tr.scale ?? { x: 1, y: 1, z: 1 },
            parent: tr.parent
          })
        }
        if (!hasTr || !hasVc) {
          this.requestVcBindHydrateOnce()
        }
      }
    } else if (!vcUnbound) {
      const vcEnt = mainCam!.virtualCameraEntity!
      if (!Transform.has(vcEnt as never) || !VirtualCamera.has(vcEnt as never)) {
        this.requestVcBindHydrateOnce()
      }
    }
  }

  /** Cold-path structural hydrate — Transform + VirtualCamera + ancestors (before / with bind). */
  private applyVcBindHydrate(
    bound: import('../../shim/types').PlayerFrameBoundVc,
    graphKey: string
  ): void {
    if (!this.running) return
    const { VirtualCamera } = this.readComponents
    // Live-lane Transform so cold CRDT cannot overwrite with incomplete local hierarchy mid-frame.
    const putLiveTransform = (
      entity: number,
      tr: import('../../shim/types').PlayerFrameBoundVcTransform
    ): void => {
      this.projection.setVcLiveTransform(entity as never, {
        position: tr.position,
        rotation: tr.rotation,
        scale: tr.scale,
        parent: tr.parent as never
      })
    }
    for (const anchor of bound.anchors) {
      putLiveTransform(anchor.entity, anchor.transform)
    }
    putLiveTransform(bound.entity, bound.transform)
    VirtualCamera.createOrReplace(bound.entity as never, (bound.virtualCamera ?? {}) as never)
    this.vcBindHydratePullPending = false
    perfNoteVcHydrate()
    // Structure-only key (pose rides vc-pose-live) — log once per structure change.
    if (graphKey !== this.lastVcBindHydrateLogKey) {
      this.lastVcBindHydrateLogKey = graphKey
      const lookAt = (bound.virtualCamera as { lookAtEntity?: number } | null)?.lookAtEntity
      clientDebugLog.log(
        'vc-lens',
        `vc-bind-hydrate e${bound.entity} anchors=${bound.anchors.length} ` +
          `flat=${bound.worldFlattened === true} parent=${bound.transform.parent ?? '∅'} lookAt=${lookAt ?? '∅'} ` +
          `pos=(${bound.transform.position.x.toFixed(1)},${bound.transform.position.y.toFixed(1)},${bound.transform.position.z.toFixed(1)}) ` +
          `key=${graphKey}`
      )
    }
  }

  private requestVcBindHydrateOnce(): void {
    if (this.vcBindHydratePullPending || !this.worker) return
    this.vcBindHydratePullPending = true
    this.worker.postMessage({ type: 'request-vc-bind-hydrate' } satisfies MainToWorker)
  }

  /**
   * Worker→main live Transform (no CRDT ack wait) — pure pipe of scene engine state.
   * Worker only posts bound-VC hierarchy or edit-flight VCs after systems run.
   */
  private applyVcPoseLive(entity: Entity, transform: DclTransformValues): void {
    if (!this.running || !this.entityStore || !this.bridge) return
    perfNoteVcPoseLive()
    const { MainCamera, Transform } = this.readComponents
    const { CameraEntity } = this.view
    const main = MainCamera.getOrNull(CameraEntity) as { virtualCameraEntity?: number } | null
    const boundActive =
      main?.virtualCameraEntity !== undefined && main?.virtualCameraEntity !== null

    // Unbound: only MOVE CAMERA flight lane. Bound: trust worker filter (VC + parents/lookAt).
    if (!boundActive && !this.playerEditFlightLiveLane) return

    this.projection.setVcLiveTransform(entity, transform)

    const comps = new Map<number, ProjectionChangeKind>([[Transform.componentId, 'put']])
    const diff = new Map<Entity, Map<number, ProjectionChangeKind>>([[entity, comps]])
    applySceneDiff(this.entityStore, diff, this.view, this.readComponents, [], {
      notifySecondary: false,
      skipSecondaryNotify: () => true
    })
    this.bridge.getEntityNodes()?.get(entity)?.updateMatrixWorld(true)
  }

  /** Drop all hub keys (global — one keyboard). Prefer World.inputHub.releaseAll. */
  flushSceneKeyboardRelay(reason: string): void {
    this.inputHub?.releaseAll(reason) ?? this.sceneInputRelay?.releaseHeldKeys(reason)
  }

  /** After flight keys release / unbind — drop live-lane TS so inbound CRDT can reapply. */
  private clearVcLiveTransformLane(): void {
    this.projection.clearVcLiveTransformForUnbind()
  }

  /**
   * COD AAA — single ordered lane drain (Motion → Material(+primitive leaf) → Structure/Gltf).
   * Fixed FRAME pie only — no backlog boosts. Structure never peels Material.
   * Pointer edge: motion + material/leaf only (structureEnt=0 for Gltf).
   */
  private async drainPendingDiffLanes(opts?: {
    pointerEdge?: boolean
    /** Ambient CRDT apply — motion only; material/structure left to rAF syncRenderer. */
    motionOnly?: boolean
    deadlineMs?: number
  }): Promise<void> {
    if (!this.bridge || !this.entityStore) return
    if (!this.bridge.canConsumeDiff() || !this.pendingDiff.size) return
    const view = this.view
    const F = SceneScriptSystem.FRAME
    const edge = opts?.pointerEdge === true
    const motionOnly = opts?.motionOnly === true
    const motionCap = edge
      ? Math.min(F.MOTION_ENTITIES, 64)
      : motionOnly
        ? Math.min(F.MOTION_ENTITIES, 128)
        : F.MOTION_ENTITIES
    const matMs = edge ? F.POINTER_MATERIAL_MS : F.MATERIAL_MS
    const matEnt = edge ? 64 : F.MATERIAL_ENTITIES
    const structureEnt = edge || motionOnly ? 0 : F.STRUCTURE_ENTITIES
    const wallDeadline =
      opts?.deadlineMs !== undefined && Number.isFinite(opts.deadlineMs)
        ? performance.now() + Math.max(0, opts.deadlineMs)
        : Infinity

    // --- Motion lane (Transform/Tween/Animator…) ---
    if (performance.now() < wallDeadline) {
      const motionSlice = this.takePendingDiffSlice(new Set(['motion']), motionCap)
      if (motionSlice.size) {
        const t0 = performance.now()
        const { Transform, Tween, TweenSequence, VisibilityComponent } = this.readComponents
        const transformId = Transform.componentId
        const tweenId = Tween.componentId
        const tweenSeqId = TweenSequence.componentId
        const visibilityId = VisibilityComponent.componentId
        // Pose-fast path: Transform/Tween **and** Visibility + TweenSequence.
        // GP fishing hide (press_e plane / bobber) is jI(): visible=false + tween deletes +
        // parent stash — if Visibility waits on the async otherMotion drain it sticks on screen
        // under plaza load.
        const poseDiff = new Map<Entity, Map<number, ProjectionChangeKind>>()
        const otherMotion = new Map<Entity, Map<number, ProjectionChangeKind>>()
        const tweenEntities: Entity[] = []
        for (const [entity, comps] of motionSlice) {
          const pose = new Map<number, ProjectionChangeKind>()
          const rest = new Map<number, ProjectionChangeKind>()
          for (const [cid, kind] of comps) {
            if (
              cid === transformId ||
              cid === tweenId ||
              cid === tweenSeqId ||
              cid === visibilityId
            ) {
              pose.set(cid, kind)
              if (cid === tweenId) tweenEntities.push(entity)
            } else {
              rest.set(cid, kind)
            }
          }
          if (pose.size) poseDiff.set(entity, pose)
          if (rest.size) otherMotion.set(entity, rest)
        }
        if (poseDiff.size) {
          const tweenRefresh = this.tweenBridge?.getActiveTweenEntities() ?? []
          applySceneDiff(this.entityStore, poseDiff, view, this.readComponents, tweenRefresh, {
            skipTransformApply: (entity) =>
              this.readComponents.AvatarAttach.has(entity) ||
              this.projection.isVcLiveTransformEntity(entity),
            onReservedParent: (entity, parent, v) => {
              this.bridge?.noteReservedParentedEntity(entity, parent, v)
            }
          })
          // Group + __mesh_* + instancer matrix (zero scale when hidden).
          this.bridge.syncEcsVisibility([...poseDiff.keys()])
          this.bridge.syncInstancedTransforms([...poseDiff.keys()])
          for (const entity of tweenEntities) {
            this.bridge.ensureMeshRendererTweenVisual(entity)
          }
          // Re-apply visibility after tween promote (leaf attach can leave mesh.visible=true).
          this.bridge.syncEcsVisibility([...poseDiff.keys()])
          this.tweenBridge?.sync(view)
          this.pointerStructureDirty = true
        }
        if (otherMotion.size && performance.now() < wallDeadline) {
          const tweenRefresh = this.tweenBridge?.getActiveTweenEntities() ?? []
          await this.bridge.consumeDiff(otherMotion, view, tweenRefresh)
        }
        perfNotePeels({
          transformMs: performance.now() - t0,
          entities: motionSlice.size
        })
      }
    }

    if (motionOnly) return

    // --- Material lane: pointer-edge VFX first, then missing leaves, then Material puts ---
    if (performance.now() < wallDeadline) {
      if (performance.now() < this.pointerEdgeVisualUntil || this.pointerEdgeVisualEntities.size > 0) {
        this.peelPointerEdgeVisuals()
      }
      const prefer =
        this.pointerEdgeVisualEntities.size > 0
          ? [...this.pointerEdgeVisualEntities]
          : undefined
      this.flushMissingPrimitiveMeshRendererLeaves({
        entityCap: matEnt,
        hardMs: matMs,
        prefer
      })
      this.flushMeshRendererMaterialsFromPendingDiff({
        pointerEdge: edge,
        hardMs: matMs,
        entityCap: matEnt,
        prefer
      })
    }

    // --- Structure lane (Gltf / TextShape / …) — never on pointer edge ---
    if (!edge && structureEnt > 0 && performance.now() < wallDeadline) {
      const structureSlice = this.takePendingDiffSlice(
        new Set(['structure', 'other']),
        structureEnt
      )
      if (structureSlice.size) {
        const t0 = performance.now()
        const { spriteDiff, sceneDiff } = this.bridge.partitionSpriteDiff(structureSlice, view)
        if (spriteDiff.size) this.bridge.consumeSpriteDiff(spriteDiff, view)
        const tweenRefresh = this.tweenBridge?.getActiveTweenEntities() ?? []
        if (sceneDiff.size) await this.bridge.consumeDiff(sceneDiff, view, tweenRefresh)
        else await this.bridge.drainPendingWork()
        this.bridge.reconcileBillboardFlags()
        this.flushPointerStructureIfDirty()
        perfNotePeels({
          gltfMs: performance.now() - t0,
          entities: structureSlice.size
        })
      }
    }

    this.publishPendingDiffPerf()
    this.dropStalePendingDiff()
  }

  /**
   * Primitive MeshRenderer leaf create (no GltfContainer) — Material lane work-kind.
   * Prefer `prefer` entities (pointer-edge VFX) then scan pendingDiff for missing leaves.
   */
  private flushMissingPrimitiveMeshRendererLeaves(opts: {
    entityCap: number
    hardMs: number
    prefer?: Iterable<Entity>
  }): void {
    if (!this.bridge || !this.pendingDiff.size) return
    const { MeshRenderer, GltfContainer } = this.readComponents
    const mrId = MeshRenderer.componentId
    const t0 = performance.now()
    let applied = 0
    const tryLeaf = (entity: Entity): boolean => {
      if (applied >= opts.entityCap) return false
      if (performance.now() - t0 >= opts.hardMs && applied > 0) return false
      if (GltfContainer.has(entity)) return true
      if (!MeshRenderer.has(entity)) return true
      if (this.bridge!.hasMeshRendererLeaf(entity)) {
        const comps = this.pendingDiff.get(entity)
        if (comps?.has(mrId)) {
          comps.delete(mrId)
          this.clearPendingEntityIfEmpty(entity)
        }
        return true
      }
      if (this.bridge!.ensureMeshRendererLeaf(entity)) {
        applied++
        const comps = this.pendingDiff.get(entity)
        if (comps) {
          comps.delete(mrId)
          this.clearPendingEntityIfEmpty(entity)
        }
      }
      return true
    }
    if (opts.prefer) {
      for (const entity of opts.prefer) {
        if (!tryLeaf(entity)) break
      }
    }
    for (const entity of this.pendingDiff.keys()) {
      if (applied >= opts.entityCap) break
      if (performance.now() - t0 >= opts.hardMs && applied > 0) break
      tryLeaf(entity)
    }
    if (applied > 0) this.publishPendingDiffPerf()
  }

  /**
   * Same-batch MeshRenderer Material after worker cold CRDT applyIncoming.
   * Pointer-edge visual entities + missing-leaf first; stop collecting once we have enough.
   */
  /**
   * Human-readable Material put for debug — texture file / video / avatar / color only.
   * Not a full PbMaterial dump (too large for console).
   */
  private summarizeMaterialPut(entity: Entity): string {
    const { Material, GltfContainer, MeshCollider, TextShape, ParticleSystem } = this.readComponents
    const parts: string[] = [`e${entity as number}`]
    try {
      if (GltfContainer.has(entity)) {
        const src = (GltfContainer.get(entity) as { src?: string }).src?.trim()
        if (src) parts.push(`gltf=${src.split('/').pop() ?? src}`)
      }
      if (MeshCollider.has(entity)) parts.push('meshCollider=1')
      if (TextShape.has(entity)) parts.push('textShape=1')
      if (ParticleSystem?.has?.(entity)) parts.push('particle=1')
      if (!Material.has(entity)) {
        parts.push('material=∅')
        return parts.join(' ')
      }
      const raw = Material.get(entity) as {
        material?:
          | { $case?: string; pbr?: Record<string, unknown>; unlit?: Record<string, unknown> }
          | { pbr?: Record<string, unknown>; unlit?: Record<string, unknown> }
      }
      const m = raw?.material as
        | {
            $case?: string
            pbr?: {
              texture?: { tex?: { $case?: string; texture?: { src?: string }; videoTexture?: unknown } }
              albedoColor?: { r?: number; g?: number; b?: number; a?: number }
              emissiveTexture?: { tex?: { $case?: string; texture?: { src?: string } } }
            }
            unlit?: {
              texture?: { tex?: { $case?: string; texture?: { src?: string } } }
              diffuseColor?: { r?: number; g?: number; b?: number; a?: number }
            }
          }
        | undefined
      const caseName =
        m?.$case ??
        (m && 'pbr' in m && m.pbr ? 'pbr' : m && 'unlit' in m && m.unlit ? 'unlit' : '?')
      parts.push(`kind=${caseName}`)
      const texUnion =
        caseName === 'unlit'
          ? m?.unlit?.texture
          : m?.pbr?.texture
      const texCase = texUnion?.tex?.$case
      if (texCase === 'texture') {
        const src = (texUnion?.tex as { texture?: { src?: string } })?.texture?.src?.trim()
        parts.push(src ? `tex=${src}` : 'tex=(empty)')
      } else if (texCase === 'videoTexture') {
        parts.push('tex=videoTexture')
      } else if (texCase === 'avatarTexture') {
        parts.push('tex=avatarTexture')
      } else {
        parts.push('tex=none')
      }
      const emSrc = m?.pbr?.emissiveTexture?.tex?.$case === 'texture'
        ? (m.pbr.emissiveTexture.tex as { texture?: { src?: string } }).texture?.src?.trim()
        : undefined
      if (emSrc) parts.push(`emissiveTex=${emSrc}`)
      const col =
        caseName === 'unlit' ? m?.unlit?.diffuseColor : m?.pbr?.albedoColor
      if (col) {
        parts.push(
          `color=(${(col.r ?? 1).toFixed(2)},${(col.g ?? 1).toFixed(2)},${(col.b ?? 1).toFixed(2)},${(col.a ?? 1).toFixed(2)})`
        )
      }
    } catch (err) {
      parts.push(`summarize-err=${err instanceof Error ? err.message : String(err)}`)
    }
    return parts.join(' ')
  }

  private flushMeshRendererMaterialsFromPendingDiff(opts?: {
    pointerEdge?: boolean
    hardMs?: number
    entityCap?: number
    prefer?: Iterable<Entity>
  }): void {
    if (!this.bridge || !this.pendingDiff.size) return
    const { Material, MeshRenderer } = this.readComponents
    const matId = Material.componentId
    const hardMs =
      opts?.hardMs ??
      (opts?.pointerEdge
        ? SceneScriptSystem.FRAME.POINTER_MATERIAL_MS
        : SceneScriptSystem.FRAME.MATERIAL_MS)
    const entityCap = opts?.entityCap ?? SceneScriptSystem.FRAME.MATERIAL_ENTITIES
    const t0 = performance.now()
    let applied = 0
    let seen = 0
    let missingMesh = 0
    let failed = 0
    let missingLeafCount = 0
    /** First few Material-without-MeshRenderer drops — entity + texture path for diagnosis. */
    const missingMeshSamples: string[] = []
    // Prefer pointer-edge VFX, then missing-leaf, then recolors — cap collect (no 3k arrays).
    const preferList: Entity[] = []
    const missingLeafList: Entity[] = []
    const restList: Entity[] = []
    const seenEnt = new Set<Entity>()
    const consider = (entity: Entity, asPrefer: boolean): void => {
      if (seenEnt.has(entity)) return
      const comps = this.pendingDiff.get(entity)
      if (!comps || comps.get(matId) !== 'put') return
      if (!Material.has(entity)) {
        // Orphan material dirt — drop so pendingDiff cannot stick forever.
        comps.delete(matId)
        this.clearPendingEntityIfEmpty(entity)
        return
      }
      if (!MeshRenderer.has(entity)) {
        // Material without MeshRenderer can never paint — drop put (plaza stuck missingMesh=128).
        missingMesh++
        if (missingMeshSamples.length < 12) {
          missingMeshSamples.push(this.summarizeMaterialPut(entity))
        }
        comps.delete(matId)
        this.clearPendingEntityIfEmpty(entity)
        return
      }
      seenEnt.add(entity)
      const missing = !this.bridge!.hasMeshRendererLeaf(entity)
      if (missing) missingLeafCount++
      if (asPrefer) preferList.push(entity)
      else if (missing) missingLeafList.push(entity)
      else restList.push(entity)
    }
    if (opts?.prefer) {
      for (const entity of opts.prefer) consider(entity, true)
    }
    const collectCap = Math.max(entityCap * 2, 64)
    for (const entity of this.pendingDiff.keys()) {
      if (preferList.length + missingLeafList.length + restList.length >= collectCap) break
      consider(entity, false)
    }
    const ordered = preferList.concat(missingLeafList, restList)
    for (const entity of ordered) {
      const comps = this.pendingDiff.get(entity)
      if (!comps || comps.get(matId) !== 'put') continue
      if (!Material.has(entity) || !MeshRenderer.has(entity)) continue
      seen++
      if (applied >= entityCap) break
      if (performance.now() - t0 >= hardMs && applied > 0) break
      if (this.bridge.forceApplyMeshRendererMaterial(entity)) {
        applied++
        comps.delete(matId)
        comps.delete(MeshRenderer.componentId)
        this.clearPendingEntityIfEmpty(entity)
      } else {
        failed++
      }
    }
    if (applied > 0 || seen > 0) {
      this.publishPendingDiffPerf()
      perfNotePeels({ materialMs: performance.now() - t0, entities: applied })
    }
    // Log only real progress or rare stuck samples — every-second missingMesh=128
    // console spam was measurable main-thread cost on plaza.
    if (applied > 0 || (seen > 0 && failed > 0)) {
      clientDebugLog.log(
        'collision',
        `mesh-renderer material flush v3 — applied=${applied}/${seen} failed=${failed} missingMesh=${missingMesh} missingLeaf=${missingLeafCount} pendingDiff=${this.pendingDiff.size} admitDrop=${this.admitDropCount} edgeVis=${this.pointerEdgeVisualEntities.size}`,
        { level: 'info', alsoConsole: true, throttleMs: 2_000, throttleKey: 'mr-mat-flush' }
      )
      this.admitDropCount = 0
    } else if (missingMesh > 0) {
      const sample =
        missingMeshSamples.length > 0
          ? ` samples=[${missingMeshSamples.join(' | ')}]`
          : ''
      clientDebugLog.log(
        'collision',
        `mesh-renderer material flush v3 — dropped ${missingMesh} Material-without-MeshRenderer ` +
          `pendingDiff=${this.pendingDiff.size}${sample}`,
        {
          level: 'info',
          // On for diagnosis (user asked which material/file) — 5s throttle so plaza stays playable.
          alsoConsole: true,
          throttleMs: 5_000,
          throttleKey: 'mr-mat-flush-drop'
        }
      )
      this.admitDropCount = 0
    }
  }

  /**
   * Tag only plausible click-marker entities during a world/level-state edge.
   * Never ParticleSystem (board storms). Prefer missing-leaf MeshRenderer/Material.
   */
  private maybeTagPointerEdgeVisual(entity: Entity, componentId: number): void {
    const { MeshRenderer, Material, Tween, GltfContainer } = this.readComponents
    if (
      componentId !== MeshRenderer.componentId &&
      componentId !== Material.componentId &&
      componentId !== Tween.componentId
    ) {
      return
    }
    if (GltfContainer.has(entity)) return
    // Already have a leaf + only Material recolor → fog board, not click disc.
    if (
      componentId === Material.componentId &&
      this.bridge?.hasMeshRendererLeaf(entity) &&
      !Tween.has(entity)
    ) {
      return
    }
    if (this.pointerEdgeVisualEntities.has(entity)) return
    if (this.pointerEdgeVisualEntities.size >= SceneScriptSystem.POINTER_EDGE_VISUAL_CAP) {
      // Prefer missing-leaf newcomers: drop a sealed recolor if present.
      if (this.bridge?.hasMeshRendererLeaf(entity) && !Tween.has(entity)) return
      for (const existing of this.pointerEdgeVisualEntities) {
        if (this.bridge?.hasMeshRendererLeaf(existing) && !Tween.has(existing)) {
          this.pointerEdgeVisualEntities.delete(existing)
          break
        }
      }
      if (this.pointerEdgeVisualEntities.size >= SceneScriptSystem.POINTER_EDGE_VISUAL_CAP) return
    }
    this.pointerEdgeVisualEntities.add(entity)
  }

  /**
   * Also pick up very recent missing-leaf MeshRenderer+Material (getClick markers
   * that missed the edge set because CRDT landed one tick late).
   */
  private collectRecentMissingLeafMarkers(max: number): Entity[] {
    if (!this.bridge) return []
    const { MeshRenderer, Material, GltfContainer } = this.readComponents
    const now = performance.now()
    const out: Entity[] = []
    for (const entity of this.pendingDiff.keys()) {
      if (out.length >= max) break
      const t0 = this.pendingDiffFirstDirtyAt.get(entity) ?? 0
      if (t0 <= 0 || now - t0 > 200) continue
      if (GltfContainer.has(entity)) continue
      if (!MeshRenderer.has(entity) || !Material.has(entity)) continue
      if (this.bridge.hasMeshRendererLeaf(entity)) continue
      out.push(entity)
    }
    return out
  }

  /**
   * Peel click-marker candidates after pointer deliver — small set only.
   */
  private peelPointerEdgeVisuals(): void {
    if (!this.bridge) {
      this.pointerEdgeVisualCollect = false
      return
    }
    const recent = this.collectRecentMissingLeafMarkers(16)
    for (const e of recent) this.pointerEdgeVisualEntities.add(e)
    if (this.pointerEdgeVisualEntities.size === 0) {
      this.pointerEdgeVisualCollect = false
      return
    }
    const prefer = [...this.pointerEdgeVisualEntities].slice(0, SceneScriptSystem.POINTER_EDGE_VISUAL_CAP)
    const cap = prefer.length
    this.flushMissingPrimitiveMeshRendererLeaves({
      entityCap: cap,
      hardMs: SceneScriptSystem.FRAME.POINTER_MATERIAL_MS + 6,
      prefer
    })
    this.flushMeshRendererMaterialsFromPendingDiff({
      pointerEdge: true,
      hardMs: SceneScriptSystem.FRAME.POINTER_MATERIAL_MS + 6,
      entityCap: cap,
      prefer
    })
    for (const entity of prefer) {
      this.bridge.ensureMeshRendererTweenVisual(entity)
      // Ensure leaf even if Material put lags one frame.
      if (this.readComponents.MeshRenderer.has(entity) && !this.bridge.hasMeshRendererLeaf(entity)) {
        this.bridge.ensureMeshRendererLeaf(entity)
      }
      if (this.readComponents.Material.has(entity)) {
        this.bridge.forceApplyMeshRendererMaterial(entity)
      }
    }
    this.tweenBridge?.sync(this.view)
    if (this.tweenBridge?.hasLiveTweens()) {
      this.tweenBridge.update(1 / 30, this.view)
      this.markTweenColliderPosesDirty()
    }
    void this.particleBridge?.sync(this.view)
    this.particleBridge?.update(1 / 30)
    if (prefer.length > 0) {
      clientDebugLog.log(
        'pointer',
        `edge-VFX peel — n=${prefer.length} recentMissing=${recent.length} pendingDiff=${this.pendingDiff.size}`,
        { alsoConsole: true, throttleMs: 200, throttleKey: 'edge-vfx-peel' }
      )
    }
    this.pointerEdgeVisualEntities.clear()
    // Keep collect open until pointerEdgeVisualUntil so late MeshRenderer puts still tag.
    if (performance.now() >= this.pointerEdgeVisualUntil) {
      this.pointerEdgeVisualCollect = false
    }
  }

  private foldProjectionChanges(): void {
    const { PlayerEntity, CameraEntity, RootEntity } = this.view
    const {
      TriggerArea,
      CameraModeArea,
      AvatarModifierArea,
      MapPin,
      Transform,
      Billboard,
      MainCamera,
      InputModifier
    } = this.readComponents
    const motionNow = new Map<Entity, Map<number, ProjectionChangeKind>>()

    for (const change of this.projection.changes) {
      if (
        change.entity === PlayerEntity &&
        change.componentId === InputModifier.componentId &&
        (change.kind === 'put' || change.kind === 'delete')
      ) {
        // put (freeze) or delete (scene unlock / load-gate release) — drop held WASD either way.
        this.clearPlayerMoveKeys?.()
        if (change.kind === 'put') {
          const loc = readLocomotionFromComponents(this.readComponents, PlayerEntity)
          if (loc.disableAll) {
            console.info(
              `[projection] InputModifier PUT freeze disableAll=true on PlayerEntity (may override player-frame clear)`
            )
          }
        } else {
          console.info(`[projection] InputModifier DELETE on PlayerEntity`)
        }
      }

      if (
        change.entity === CameraEntity &&
        change.componentId === MainCamera.componentId &&
        change.kind === 'put'
      ) {
        const value = MainCamera.getOrNull(CameraEntity) as { virtualCameraEntity?: number } | null
        const vc = value?.virtualCameraEntity
        if (vc === undefined || vc === null) {
          this.projection.clearVcLiveTransformForUnbind()
        }
        this.virtualCameraBridge?.logLensParity(
          `projection MainCamera put → vc=${vc ?? 'cleared'}`
        )
      }

      if (change.kind === 'put' && change.componentId === Transform.componentId) {
        const mainVc = MainCamera.getOrNull(CameraEntity) as { virtualCameraEntity?: number } | null
        const boundVc = mainVc?.virtualCameraEntity
        if (boundVc !== undefined && boundVc !== null && change.entity === boundVc) {
          this.virtualCameraBridge?.logLensParity(`projection VC Transform put e${boundVc}`)
        }
      }

      if (change.entity === PlayerEntity || change.entity === CameraEntity || change.entity === RootEntity) {
        continue
      }

      if (
        change.componentId === TriggerArea.componentId ||
        change.componentId === CameraModeArea.componentId ||
        change.componentId === AvatarModifierArea.componentId ||
        change.componentId === MapPin.componentId ||
        (change.componentId === Transform.componentId &&
          (TriggerArea.has(change.entity) ||
            CameraModeArea.has(change.entity) ||
            AvatarModifierArea.has(change.entity)))
      ) {
        // TriggerArea / area components only — not every GltfContainer in the CRDT stream.
        this.triggerStructureDirty = true
      }

      if (change.componentId === Billboard.componentId) {
        this.entityStore?.setBillboard(change.entity, change.kind !== 'delete')
      }

      // COD admit seal — only true dirty enters pendingDiff (PhysX PART-fp analogue).
      if (change.kind === 'put' && this.bridge && this.shouldDropSealedProjectionPut(change)) {
        this.admitDropCount++
        continue
      }

      // Pointer-edge visual set — only small click-marker candidates (never board-wide).
      if (this.pointerEdgeVisualCollect && change.kind === 'put') {
        this.maybeTagPointerEdgeVisual(change.entity, change.componentId)
      }

      // Host world: motion is UpdateWorld at fold — not a pendingDiff replay.
      if (this.isHostMotionComponent(change.componentId)) {
        let motion = motionNow.get(change.entity)
        if (!motion) {
          motion = new Map()
          motionNow.set(change.entity, motion)
        }
        motion.set(change.componentId, change.kind)
        continue
      }

      if (this.tryApplyHostPrimitiveNow(change.entity, change.componentId, change.kind)) {
        continue
      }

      let comps = this.pendingDiff.get(change.entity)
      if (!comps) {
        comps = new Map()
        const now = performance.now()
        if (this.pendingDiff.size === 0) this.pendingDiffOldestAt = now
        this.pendingDiffFirstDirtyAt.set(change.entity, now)
        this.pendingDiff.set(change.entity, comps)
      }
      comps.set(change.componentId, change.kind)
    }
    if (motionNow.size) this.applyHostMotionNow(motionNow)
    this.publishPendingDiffPerf()
  }

  private isHostMotionComponent(componentId: number): boolean {
    const c = this.readComponents
    return (
      componentId === c.Transform.componentId ||
      componentId === c.Tween.componentId ||
      componentId === c.TweenSequence.componentId ||
      componentId === c.VisibilityComponent.componentId
    )
  }

  /**
   * Fold-time UpdateWorld for pose. AvatarAttach + VC live lane skip Transform
   * (rod/line / reveal cam). Same extract path as the old motion peel.
   */
  private applyHostMotionNow(
    poseDiff: Map<Entity, Map<number, ProjectionChangeKind>>
  ): void {
    if (!this.entityStore || !this.bridge) return
    const view = this.view
    const { Tween, MeshCollider, GltfContainer } = this.readComponents
    const tweenId = Tween.componentId
    const transformId = this.readComponents.Transform.componentId
    const tweenSeqId = this.readComponents.TweenSequence.componentId
    const tweenEntities: Entity[] = []
    const trsDiff = new Map<Entity, Map<number, ProjectionChangeKind>>()
    for (const [entity, comps] of poseDiff) {
      if (comps.has(tweenId)) tweenEntities.push(entity)
      if (comps.has(transformId) || comps.has(tweenId) || comps.has(tweenSeqId)) {
        trsDiff.set(entity, comps)
      }
    }
    if (trsDiff.size) {
      applySceneDiff(this.entityStore, trsDiff, view, this.readComponents, [], {
        skipTransformApply: (entity) =>
          this.readComponents.AvatarAttach.has(entity) ||
          this.projection.isVcLiveTransformEntity(entity),
        reservedAnchors: this.bridge.getReservedTransformAnchors(),
        onReservedParent: (entity, parent, v) => {
          if (this.readComponents.AvatarAttach.has(entity)) return
          this.bridge?.noteReservedParentedEntity(entity, parent, v)
        }
      })
    }
    const entities = [...poseDiff.keys()]
    this.bridge.syncEcsVisibility(entities)
    this.bridge.syncInstancedTransforms(entities)
    for (const entity of tweenEntities) {
      this.bridge.ensureMeshRendererTweenVisual(entity)
    }
    this.bridge.syncEcsVisibility(entities)
    this.tweenBridge?.sync(view)
    this.pointerStructureDirty = true
    this.sceneGraphMatrixDirty = true
    this.lastSyncFrameTransformEntities.clear()
    for (const entity of entities) {
      this.lastTweenMotionEntities.add(entity)
      this.lastSyncFrameTransformEntities.add(entity)
      if (MeshCollider.has(entity) || GltfContainer.has(entity)) {
        this.colliderPoseDirty.add(entity)
      }
      this.markDescendantColliderPosesDirty(entity)
    }
  }

  /**
   * Primitive MeshRenderer + scalar Material at fold (pointer VFX / press_e).
   * Gltf + textured maps stay in pendingDiff.
   */
  private tryApplyHostPrimitiveNow(
    entity: Entity,
    componentId: number,
    kind: ProjectionChangeKind
  ): boolean {
    if (!this.bridge || kind === 'delete') return false
    const { Material, MeshRenderer, GltfContainer } = this.readComponents
    if (GltfContainer.has(entity)) return false
    if (componentId === MeshRenderer.componentId) {
      if (!this.bridge.ensureMeshRendererLeaf(entity)) return false
      if (Material.has(entity)) {
        const pb = Material.get(entity) as PbMaterial
        if (materialIsScalarOnly(pb)) this.bridge.forceApplyMeshRendererMaterial(entity)
      }
      this.sceneGraphMatrixDirty = true
      return true
    }
    if (componentId === Material.componentId) {
      if (!MeshRenderer.has(entity)) return false
      const pb = Material.get(entity) as PbMaterial
      if (!materialIsScalarOnly(pb)) return false
      return this.bridge.forceApplyMeshRendererMaterial(entity)
    }
    return false
  }

  /**
   * Drop Material/MeshRenderer puts that cannot change Three after seal.
   * Deletes always admit. Bridge must be live (play projection).
   */
  private shouldDropSealedProjectionPut(change: ProjectionChange): boolean {
    if (!this.bridge) return false
    const { Material, MeshRenderer } = this.readComponents
    if (change.componentId === Material.componentId) {
      return this.bridge.isMaterialPutSealed(change.entity)
    }
    if (change.componentId === MeshRenderer.componentId) {
      // Gltf-hosted mesh is structure; still seal when leaf already exists.
      return this.bridge.isMeshRendererPutSealed(change.entity)
    }
    return false
  }

  /**
   * Drop structure/material/other puts that have sat unapplied for too long.
   * Motion and pointer-edge VFX stay — those must not be sealed away.
   */
  private dropStalePendingDiff(): void {
    if (!this.pendingDiff.size) return
    const now = performance.now()
    const STALE_MS = 12_000
    for (const [entity, comps] of this.pendingDiff) {
      if (this.pointerEdgeVisualEntities.has(entity)) continue
      const t0 = this.pendingDiffFirstDirtyAt.get(entity) ?? 0
      if (t0 <= 0 || now - t0 < STALE_MS) continue
      for (const cid of [...comps.keys()]) {
        const lane = this.pendingDiffLaneOf(cid, entity)
        if (lane === 'motion') continue
        comps.delete(cid)
      }
      this.clearPendingEntityIfEmpty(entity)
    }
    this.publishPendingDiffPerf()
  }

  /** Frame-budget counters for `?perfdebug` / RenderStats. */
  private publishPendingDiffPerf(): void {
    const size = this.pendingDiff.size
    const now = performance.now()
    let age = 0
    if (size > 0) {
      // True max entity age — not “time since map was last empty”.
      for (const entity of this.pendingDiff.keys()) {
        const t0 = this.pendingDiffFirstDirtyAt.get(entity) ?? this.pendingDiffOldestAt
        if (t0 > 0) age = Math.max(age, now - t0)
      }
    } else {
      this.pendingDiffOldestAt = 0
      this.pendingDiffFirstDirtyAt.clear()
    }
    perfSetPendingDiff(size, age)
  }

  private clearPendingEntityIfEmpty(entity: Entity): void {
    const pending = this.pendingDiff.get(entity)
    if (pending && pending.size === 0) {
      this.pendingDiff.delete(entity)
      this.pendingDiffFirstDirtyAt.delete(entity)
    } else if (!pending) {
      this.pendingDiffFirstDirtyAt.delete(entity)
    }
  }

  /**
   * Classify a component put into a drain lane (COD A2 corrected).
   * Primitive MeshRenderer (no GltfContainer) → material lane (leaf create + paint).
   * GltfContainer / MeshCollider / TextShape / Avatar → structure (never PE edge).
   */
  private pendingDiffLaneOf(
    componentId: number,
    entity?: Entity
  ): 'motion' | 'material' | 'structure' | 'other' {
    const c = this.readComponents
    if (
      componentId === c.Transform.componentId ||
      componentId === c.Tween.componentId ||
      componentId === c.TweenSequence.componentId ||
      componentId === c.TweenState.componentId ||
      componentId === c.Animator.componentId ||
      componentId === c.Billboard.componentId ||
      componentId === c.VisibilityComponent.componentId
    ) {
      return 'motion'
    }
    if (componentId === c.Material.componentId) return 'material'
    if (componentId === c.MeshRenderer.componentId) {
      // Primitive leaf = material-coupled; Gltf mesh stays structure.
      if (entity !== undefined && c.GltfContainer.has(entity)) return 'structure'
      return 'material'
    }
    if (
      componentId === c.GltfContainer.componentId ||
      componentId === c.MeshCollider.componentId ||
      componentId === c.GltfNodeModifiers.componentId ||
      componentId === c.TextShape.componentId ||
      componentId === c.NftShape.componentId ||
      componentId === c.AvatarShape.componentId ||
      componentId === c.AvatarAttach.componentId
    ) {
      return 'structure'
    }
    return 'other'
  }

  /**
   * Peel up to `cap` entities that have any component in `lanes` from pendingDiff.
   * Does **not** empty the whole map — structure backlog drains across frames.
   */
  private takePendingDiffSlice(
    lanes: ReadonlySet<'motion' | 'material' | 'structure' | 'other'>,
    cap: number
  ): Map<Entity, Map<number, ProjectionChangeKind>> {
    const out = new Map<Entity, Map<number, ProjectionChangeKind>>()
    if (!this.pendingDiff.size || cap <= 0) return out
    // Age-order only for moderate backlogs. Sorting 1000+ keys every peel was a multi-ms
    // hitch on PE click (pendingDiff=1400 → peel 65ms). Large backlog: FIFO Map order.
    let ordered: Entity[]
    if (this.pendingDiff.size <= 128) {
      ordered = [...this.pendingDiff.keys()].sort(
        (a, b) =>
          (this.pendingDiffFirstDirtyAt.get(a) ?? 0) - (this.pendingDiffFirstDirtyAt.get(b) ?? 0)
      )
    } else {
      ordered = [...this.pendingDiff.keys()]
    }
    for (const entity of ordered) {
      if (out.size >= cap) break
      const comps = this.pendingDiff.get(entity)
      if (!comps?.size) continue
      const sub = new Map<number, ProjectionChangeKind>()
      for (const [cid, kind] of comps) {
        if (lanes.has(this.pendingDiffLaneOf(cid, entity))) sub.set(cid, kind)
      }
      if (!sub.size) continue
      out.set(entity, sub)
      for (const cid of sub.keys()) comps.delete(cid)
      if (comps.size === 0) {
        this.pendingDiff.delete(entity)
        this.pendingDiffFirstDirtyAt.delete(entity)
      }
    }
    this.publishPendingDiffPerf()
    return out
  }

  private flushPointerStructureIfDirty(): void {
    if (!this.pointerStructureDirty) return
    this.pointerStructureDirty = false
    this.pointerEvents?.invalidatePointerCache()
  }

  /** Rebuild pointer raycast targets after collision sync (spawn / incremental colliders). */
  refreshPointerTargets(): void {
    this.pointerStructureDirty = true
    this.flushPointerStructureIfDirty()
  }

  /**
   * MeshCollider CL_POINTER poses before pointer raycast.
   * GLTF pointer targets read live scene-graph meshes (flushSceneGraphMatrices) — not PhysX extractor.
   * SDK7 Raycast `collisionMask` filters may supersede this path later.
   */
  syncPointerCollisionPoses(): void {
    if (!this.collision || !this.bridge) return
    this.collision.syncPointerPoses(this.bridge.getEntityNodes())
  }

  /**
   * MatrixWorld + CL_POINTER MeshCollider poses immediately before pointer raycast.
   * Phase C: skip when pointer system reports idle (no move / lock / pending click).
   */
  preparePointerRaycast(tickNumber = 0): void {
    if (this.pointerEvents && !this.pointerEvents.needsRaycastPrepare(tickNumber)) {
      return
    }
    this.consumeSyncFrameTransforms()
    // Only re-promote PE leaves when structure is dirty — every-raycast promote thrashed
    // MeshRenderer/GLB attach and competed with GltfContainer drain.
    if (this.pointerStructureDirty && this.bridge && this.pointerEvents) {
      const pe: Entity[] = []
      for (const [entity] of this.view.getEntitiesWith(this.readComponents.PointerEvents)) {
        if (
          entity === this.view.RootEntity ||
          entity === this.view.PlayerEntity ||
          entity === this.view.CameraEntity
        ) {
          continue
        }
        if (this.readComponents.UiTransform.has(entity)) continue
        pe.push(entity)
      }
      if (pe.length) {
        const fixed = this.bridge.ensurePointerMeshesReady(pe)
        if (fixed > 0) this.pointerStructureDirty = true
      }
    }
    this.flushPointerStructureIfDirty()
    this.flushSceneGraphMatrices()
    // Full syncCollision runs on the async frame (World.applyPhysicsColliders) — not here.
    this.syncPointerCollisionPoses()
  }

  private flushTriggerStructureIfDirty(): void {
    if (!this.triggerStructureDirty) return
    this.triggerStructureDirty = false
    this.triggerAreas?.invalidateCache()
    this.cameraModeAreas?.invalidateCache()
    this.avatarModifiers?.invalidateCache()
    this.mapPins?.invalidate()
  }

  /**
   * Unlock media playback after user interaction (or optimistically at World.start).
   * @param options.allowSound - only true for a real pointer/keyboard gesture so
   *   video can autoplay muted, then unmute when the user actually interacts.
   */
  setVideoUserGestureUnlocked(
    unlocked: boolean,
    options?: { allowSound?: boolean }
  ): void {
    this.videoPlayerBridge?.setUserGestureUnlocked(unlocked, options)
    this.audioSourceBridge?.setUserGestureUnlocked(unlocked)
    this.audioStreamBridge?.setUserGestureUnlocked(unlocked)
  }

  /** Camera-mounted THREE.AudioListener for nearby spatial voice + media. */
  getAudioListener(): import('three').AudioListener | null {
    return this.audioSourceBridge?.getListener() ?? null
  }

  getVirtualCameraBridge(): VirtualCameraBridge | null {
    return this.virtualCameraBridge
  }

  setVirtualCameraPoseProviders(player: () => EntityPose, camera: () => EntityPose): void {
    this.virtualCameraPlayerPose = player
    this.virtualCameraCameraPose = camera
  }

  /** Shared world-transform context for camera, pointer, trigger, and raycast systems. */
  getWorldTransformDeps(): EntityWorldTransformDeps | null {
    if (!this.entityStore) return null
    return {
      view: this.view,
      playerPose: () => this.virtualCameraPlayerPose?.() ?? this.clientPlayerPose ?? emptyEntityPose(),
      cameraPose: () => this.virtualCameraCameraPose?.() ?? this.clientCameraPose ?? emptyEntityPose()
    }
  }

  /**
   * LWW Lamport for PE PhysicsCombinedImpulse — used to apply eventId:0 scene writes
   * (Genesis Plaza bounce parasols) once per CRDT put.
   */
  getPhysicsImpulseLamport(): number {
    return this.projection.getLamport(
      this.readComponents.PhysicsCombinedImpulse.componentId,
      SDK_RESERVED.player
    )
  }

  /** Bind pointer raycast after player spawn — needs collision + camera + player pose. */
  bindPointerEvents(
    getPlayerPosition: () => THREE.Vector3 | null,
    isPointerBlocked: () => boolean,
    getPhysics?: () => PhysXWorld | null,
    sceneInput?: {
      isRelayBlocked: () => boolean
      isLocomotionBlocked?: () => boolean
      clearPlayerMoveKeys?: () => void
      /** PE drone / freeze — republish pressed keys every frame. */
      forceRepublishSnapshot?: () => boolean
    },
    setForcedCameraMode?: (mode: ForcedCameraMode | null) => void
  ): void {
    if (!this.pointerEvents || !this.collision || !this.bridge || !this.host) {
      clientDebugLog.log('pointer', 'bind skipped — scene not prepared', { level: 'warn' })
      return
    }
    this.clearPlayerMoveKeys = sceneInput?.clearPlayerMoveKeys ?? null
    this.setForcedCameraMode = setForcedCameraMode ?? null
    // Pointer reads/iteration go through the projection view + facade (writes via setRenderer/appendRenderer + source capture).
    this.pointerEvents.bind({
      ecs: this.readComponents,
      view: this.view,
      collision: this.collision,
      getEntityNodes: () => this.bridge!.getEntityNodes(),
      getWorldTransformDeps: () => this.getWorldTransformDeps(),
      camera: this.host.camera,
      getPlayerPosition,
      // Do not block world pointer while awaiting split-press ack (was freezing DecentraCraft
      // input for the full multi-second pointer-deliver batch). UI still uses full batch.
      isPointerBlocked: () => isPointerBlocked(),
      pointerEventsOf: (entity) => this.sceneUiBridge?.pointerEventsOf(entity) ?? null,
      flushPointerCrdt: () => {
        void this.flushPendingPointerCrdt()
      },
      prepareRaycast: () => this.preparePointerRaycast(),
      resolveMeshRendererInstanceHit: (mesh, instanceId) =>
        this.bridge?.resolveMeshRendererInstanceEntity(mesh, instanceId) ?? null,
      getMeshRendererInstancePointerMeshes: () =>
        this.bridge?.getMeshRendererInstancePointerMeshes() ?? [],
      ensurePointerMeshes: () => {
        if (!this.bridge) return
        const pe: Entity[] = []
        for (const [entity] of this.view.getEntitiesWith(this.readComponents.PointerEvents)) {
          if (
            entity === this.view.RootEntity ||
            entity === this.view.PlayerEntity ||
            entity === this.view.CameraEntity
          ) {
            continue
          }
          if (this.readComponents.UiTransform.has(entity)) continue
          pe.push(entity)
        }
        if (pe.length) this.bridge.ensurePointerMeshesReady(pe)
      },
      recordAppend: this.recordRendererAppend,
      // Primary vs PX — gate blocks hit-map pierce under the other root's dialog.
      uiRootId: this.uiRootId,
      pickUiHit: (clientX, clientY, target) =>
        this.sceneUiBridge?.pickUiPointerHit(
          clientX,
          clientY,
          this.readComponents,
          this.view,
          this.host!.camera,
          undefined,
          target
        ) ?? null,
      consumeSceneUiFieldPointer: (clientX, clientY, target) =>
        this.sceneUiBridge?.consumeFieldPointerDown(clientX, clientY, target) ?? false,
      isSceneUiFieldEntity: (entity) => this.sceneUiBridge?.isFieldEntity(entity) ?? false,
      isSceneUiTypingActive: () => this.sceneUiBridge?.isTypingActive() ?? false,
      pickUiRegionHit: (clientX, clientY) =>
        this.sceneUiBridge?.pickUiRegionHit(clientX, clientY, this.host!.camera) ?? null
    })
    let pointerEntities = 0
    for (const [entity] of this.view.getEntitiesWith(this.readComponents.PointerEvents)) {
      if (
        entity === this.view.RootEntity ||
        entity === this.view.PlayerEntity ||
        entity === this.view.CameraEntity
      ) {
        continue
      }
      pointerEntities++
    }
    this.flushPointerStructureIfDirty()

    this.triggerAreas?.bind({
      ecs: this.readComponents,
      view: this.view,
      getEntityNodes: () => this.bridge!.getEntityNodes(),
      getWorldTransformDeps: () => this.getWorldTransformDeps(),
      getPlayerWorldPosition: getPlayerPosition,
      getPhysics,
      recordAppend: this.recordRendererAppend
    })
    this.cameraModeAreas?.bind({
      ecs: this.readComponents,
      view: this.view,
      getWorldTransformDeps: () => this.getWorldTransformDeps(),
      getPlayerDclPosition: () => {
        // DCL scene-space feet/origin — same frame as CameraModeArea Transform volumes.
        const pose = this.virtualCameraPlayerPose?.() ?? this.clientPlayerPose
        if (!pose) return null
        return { x: pose.position.x, y: pose.position.y, z: pose.position.z }
      },
      setForcedCameraMode: (mode) => this.setForcedCameraMode?.(mode)
    })
    this.avatarModifiers?.bind({
      ecs: this.readComponents,
      view: this.view,
      getWorldTransformDeps: () => this.getWorldTransformDeps()
    })
    this.mapPins?.bind(this.readComponents, this.view)
    this.raycasts?.bind({
      ecs: this.readComponents,
      view: this.view,
      collision: this.collision,
      getEntityNodes: () => this.bridge!.getEntityNodes(),
      getWorldTransformDeps: () => this.getWorldTransformDeps(),
      recordLww: this.recordRendererLww
    })
    if (this.sceneInputRelay && sceneInput) {
      const consumer = {
        isRelayBlocked: sceneInput.isRelayBlocked,
        isLocomotionBlocked: sceneInput.isLocomotionBlocked,
        clearPlayerMoveKeys: sceneInput.clearPlayerMoveKeys,
        pumpWorkerTick: () => this.pumpSceneEngineTick(),
        onFlightKeysReleased: () => this.clearVcLiveTransformLane(),
        publishInputSnapshot: (body: import('../../player/sceneInputSnapshot').SceneInputSnapshotBody) =>
          this.publishSceneInputSnapshot({ ...body, tickNumber: this.crdtTick }),
        forceRepublishSnapshot: sceneInput.forceRepublishSnapshot
      }
      this.sceneInputRelay.setSubscriberId(this.inputSubscriberId)
      if (this.inputHub) {
        this.sceneInputRelay.attachToHub(this.inputHub, consumer)
      } else {
        console.warn(
          `[input] bindPointerEvents without InputHub id=${this.inputSubscriberId} — keys will not reach worker`
        )
        this.sceneInputRelay.bind(consumer)
      }
    }
    let triggerEntities = 0
    for (const [entity] of this.view.getEntitiesWith(this.readComponents.TriggerArea)) {
      if (
        entity === this.view.RootEntity ||
        entity === this.view.PlayerEntity ||
        entity === this.view.CameraEntity
      ) {
        continue
      }
      triggerEntities++
    }
    let raycastEntities = 0
    for (const [entity] of this.view.getEntitiesWith(this.readComponents.Raycast)) {
      if (
        entity === this.view.RootEntity ||
        entity === this.view.PlayerEntity ||
        entity === this.view.CameraEntity
      ) {
        continue
      }
      raycastEntities++
    }
    const bindMsg =
      `input bound — ${pointerEntities} PointerEvents · ${triggerEntities} TriggerArea · ${raycastEntities} Raycast`
    clientDebugLog.log('pointer', bindMsg, { level: 'success' })
    clientDebugLog.consoleOnly('info', `[pointer] ${bindMsg}`)
  }

  private syncTriggerAreas(): void {
    this.flushTriggerStructureIfDirty()
    this.triggerAreas?.sync()
    // FocusOwner only: secondary/tertiary residents must not hide avatars or force camera.
    if (this.focusPolicy === 'secondary') return
    this.cameraModeAreas?.sync()
    this.syncAvatarModifiers()
  }

  /** Wire player/remote samples + apply hide (World binds after spawn). */
  setAvatarModifierProviders(
    providers: {
      getSamples: () => AvatarSample[]
      apply: (id: string, effects: AvatarModifierEffects) => void
    } | null
  ): void {
    this.avatarModifierProviders = providers
  }

  isPassportDisabled(address: string): boolean {
    return this.avatarModifiers?.isPassportDisabled(address) ?? false
  }

  private syncAvatarModifiers(): void {
    if (this.focusPolicy === 'secondary') return
    if (!this.avatarModifiers || !this.avatarModifierProviders) return
    const samples = this.avatarModifierProviders.getSamples()
    this.avatarModifiers.sync(samples)
    for (const sample of samples) {
      this.avatarModifierProviders.apply(sample.id, this.avatarModifiers.getEffects(sample.id))
    }
  }

  /**
   * Multi-scene handoff: force-clear AvatarModifier hide effects for all known samples
   * (local + remotes) so demote/promote never leaves the player invisible / "vending machine".
   */
  clearAvatarModifierEffects(): void {
    if (!this.avatarModifierProviders) return
    try {
      for (const sample of this.avatarModifierProviders.getSamples()) {
        this.avatarModifierProviders.apply(sample.id, { hide: false, disablePassports: false })
      }
    } catch {
      /* ignore */
    }
  }

  private syncRaycasts(): void {
    this.raycasts?.sync(this.crdtTick)
  }

  private lastGrowOnlyFlushAt = 0
  private lastRaycastFlushAt = 0
  /**
   * Min interval between grow-only worker delivers (TriggerAreaResult, VideoEvent).
   * Keep short in play — trampoline/pad enter→impulse must not wait a full 100ms tick.
   */
  private static readonly GROW_ONLY_FLUSH_MIN_MS = 16
  private static readonly RAYCAST_FLUSH_MIN_MS = 100
  /** While GLTFs stream in, avoid light-renderer-inbound storms (each can run worker onUpdate). */
  private static readonly HYDRATION_CRDT_FLUSH_MIN_MS = 500
  private lastTweenDeliverAt = 0
  /**
   * After pointer delivery, deliver at a faster cadence for click→tweenCompleted.
   * Ambient textureMove (plaza marquee pause) always delivers via the lightweight path.
   */
  private proactiveTweenPushUntil = 0
  private static readonly TWEEN_DELIVER_MIN_MS = 100
  private static readonly TWEEN_DELIVER_FAST_MS = 50
  private static readonly PROACTIVE_TWEEN_PUSH_MS = 3000

  /**
   * Per-frame TriggerArea detection + push grow-only results to the worker.
   * CRDT round-trips alone are too sparse when the scene worker is idle.
   * Immediate flush when new enter/exit appends land so pad impulses fire this frame.
   */
  updateTriggerAreas(): void {
    if (!this.running || !this.triggerAreas) return
    const appendsBefore = this.encoder.pendingAppendCount
    this.syncTriggerAreas()
    const appendsAfter = this.encoder.pendingAppendCount
    if (appendsAfter > appendsBefore) {
      // New TriggerAreaResult — bypass throttle so Physics.apply* runs next worker tick.
      this.lastGrowOnlyFlushAt = 0
    }
    this.flushRendererGrowOnlyAppends()
  }

  private canDeliverRendererCrdtToWorker(options?: { allowDuringHydration?: boolean }): boolean {
    if (!this.worker || !this.running) return false
    if (this.pointerAwaitingWorkerApply || this.pointerFlushInFlight) return false
    // Genesis hydration — defer ambient CRDT until assets settle.
    // TriggerArea enter/impulse must still deliver (bounce parasols, join pads).
    if (!options?.allowDuringHydration && this.bridge?.isAssetHydrationMode()) return false
    return true
  }

  private rendererCrdtFlushMinMs(baseMs: number): number {
    return this.playReadyNotified ? baseMs : SceneScriptSystem.HYDRATION_CRDT_FLUSH_MIN_MS
  }

  /** Push source-captured grow-only appends (TriggerAreaResult, VideoEvent) to the worker. */
  private flushRendererGrowOnlyAppends(): void {
    // TriggerAreaResult must ship during plaza hydration — pad enter cannot wait for GLTF settle.
    if (!this.canDeliverRendererCrdtToWorker({ allowDuringHydration: true })) return
    if (this.encoder.pendingAppendCount === 0) return
    const now = performance.now()
    if (now - this.lastGrowOnlyFlushAt < this.rendererCrdtFlushMinMs(SceneScriptSystem.GROW_ONLY_FLUSH_MIN_MS)) {
      return
    }
    this.lastGrowOnlyFlushAt = now
    this.deliverRendererAppendsToWorker()
  }

  /**
   * Per-frame Raycast execution + push RaycastResult LWW to the worker.
   * CRDT round-trips alone are too sparse when the scene worker is idle.
   */
  updateRaycasts(): void {
    if (!this.running || !this.raycasts) return
    this.syncRaycasts()
    if (!this.canDeliverRendererCrdtToWorker()) return
    if (this.encoder.pendingLwwPutCount === 0) return
    const now = performance.now()
    if (now - this.lastRaycastFlushAt < this.rendererCrdtFlushMinMs(SceneScriptSystem.RAYCAST_FLUSH_MIN_MS)) {
      return
    }
    this.lastRaycastFlushAt = now
    this.deliverRendererLwwToWorker()
  }

  /**
   * Push renderer-owned `TweenState` to the worker (throttled, lightweight message).
   * Ambient textureMove needs this for tweenCompleted → scene pauseDuration → next row;
   * play-mode cold CRDT is fire-and-forget and too sparse. Uses encodeTweenStateOnly.
   *
   * **Urgent completions always deliver** (Genesis blimp TweenSequence, bobber float) —
   * even during pointer inject. Blocking those on pointerAwaiting left the blimp frozen
   * after the first orbit leg until a lucky click finished.
   */
  private deliverTweenStateToWorker(): void {
    if (!this.worker || !this.running || !this.tweenBridge?.hasEncodeDirty()) return
    // Bobber float / TweenSequence TL_RESTART (blimp orbit 0→180→360) must see completion
    // this frame or motion parks forever after the first leg.
    const urgentComplete = this.tweenBridge.hasUrgentCompletionDeliver()
    if (
      !urgentComplete &&
      (this.pointerAwaitingWorkerApply || this.pointerFlushInFlight)
    ) {
      return
    }
    // Defer ambient push while GLTFs stream — but never block sequence completion.
    if (this.bridge?.isAssetHydrationMode() && !urgentComplete) return
    const now = performance.now()
    const minMs = urgentComplete
      ? 0
      : now <= this.proactiveTweenPushUntil
        ? SceneScriptSystem.TWEEN_DELIVER_FAST_MS
        : SceneScriptSystem.TWEEN_DELIVER_MIN_MS
    if (now - this.lastTweenDeliverAt < minMs) return
    this.lastTweenDeliverAt = now

    const tweenDirty = this.tweenBridge.consumeEncodeDirty()
    this.encoder.setTweenEncodeEntities(tweenDirty)
    const bytes = this.encoder.encodeTweenStateOnly()
    if (!bytes?.byteLength) return

    if (isTweenVerbose()) {
      clientDebugLog.log(
        'motion',
        `TweenState push — ${tweenDirty.size} entity(s) [${[...tweenDirty].join(', ')}]${urgentComplete ? ' urgent' : ''}`,
        { throttleMs: 300, alsoConsole: true }
      )
    }
    const copy = bytes.slice()
    this.worker.postMessage(
      { type: 'tween-state-deliver', data: [copy] } satisfies MainToWorker,
      [copy.buffer]
    )
  }

  /**
   * Deliver renderer-owned LWW PUTs (VideoPlayer/AudioSource/GltfLoadingState).
   *
   * Channel policy (wire names are historical — both are light main→worker inbound):
   * - **GltfContainerLoadingState** → `renderer-inbound-deliver` (must not open pointer
   *   pause mid-onStart — that froze SpaceRunner forever).
   * - **Other ambient LWW** → `pointer-crdt-deliver` (light inject; no deliver-done session).
   * PE edges never use either channel — only `inject-pointer-click`.
   */
  private flushRendererLwwToWorker(opts?: { reason?: string }): void {
    if (!this.worker || !this.running) return
    if (this.encoder.pendingLwwPutCount === 0) return
    const pending = this.encoder.pendingLwwPutCount
    const lwwBytes = this.encoder.encodeLwwPutsOnly()
    if (!lwwBytes?.byteLength) return
    const copy = lwwBytes.slice()
    const gltfPath = opts?.reason === 'gltf-loading-state'
    if (isGltfLoadingStateVerbose() || gltfPath) {
      const channel = gltfPath ? 'renderer-inbound-deliver' : 'pointer-crdt-deliver'
      const msg = `→ worker ${channel} (${opts?.reason ?? 'lww'}) puts≈${pending} bytes=${copy.byteLength}`
      if (isGltfLoadingStateVerbose()) {
        clientDebugLog.log('gltf-load', msg, { throttleMs: 50 })
      } else if (gltfPath) {
        // Respect Help → Debug console mirror (plaza can emit hundreds of these).
        clientDebugLog.consoleOnly('info', `[gltf-load] ${msg}`)
      }
    }
    if (gltfPath) {
      this.worker.postMessage(
        { type: 'renderer-inbound-deliver', data: [copy] } satisfies MainToWorker,
        [copy.buffer]
      )
      return
    }
    // Wire name is historical; payload is ambient renderer LWW (not PE edges).
    this.worker.postMessage(
      { type: 'pointer-crdt-deliver', data: [copy] } satisfies MainToWorker,
      [copy.buffer]
    )
  }
  /** Deliver source-captured dynamic LWW PUTs (RaycastResult) to the worker. */
  private deliverRendererLwwToWorker(): void {
    if (!this.worker || !this.running) return
    const pending = this.encoder.pendingLwwPutCount
    const lwwBytes = this.encoder.encodeLwwPutsOnly()
    if (!lwwBytes?.byteLength) return
    const copy = lwwBytes.slice()
    clientDebugLog.log(
      'input',
      `Raycast CRDT deliver — ${pending} PUT(s), ${copy.byteLength} bytes`,
      { level: 'info', alsoConsole: isRaycastVerbose() }
    )
    // Light renderer inbound (historical message type name).
    this.worker.postMessage(
      { type: 'pointer-crdt-deliver', data: [copy] } satisfies MainToWorker,
      [copy.buffer]
    )
  }

  /**
   * Deliver grow-only appends (TriggerAreaResult, VideoEvent) to the worker.
   * Prefaces with current PE/camera Transform so scene handlers that read
   * `Transform.get(PlayerEntity)` (Genesis Plaza bounce parasols: PE.y / distance checks)
   * see the same pose used for enter detection — not a stale play-frame-tick PE.
   */
  private deliverRendererAppendsToWorker(): void {
    if (!this.worker || !this.running) return
    const pending = this.encoder.pendingAppendCount
    if (pending === 0) return

    this.refreshClientPosesFromProvider()
    if (this.clientPlayerPose && this.clientCameraPose) {
      this.prepareReservedRoundTrip(this.clientPlayerPose, this.clientCameraPose)
    }
    const reservedBytes = this.encoder.serializeReservedSnapshot().toBinary()
    const appendBytes = this.encoder.encodeAppendsOnly()
    if (!appendBytes?.byteLength) return

    const chunks: Uint8Array[] = []
    if (reservedBytes.byteLength > 0) chunks.push(reservedBytes.slice())
    chunks.push(appendBytes.slice())
    const transfer = chunks.map((c) => c.buffer)

    clientDebugLog.log(
      'input',
      `Grow-only CRDT deliver — ${pending} append(s) + PE pose (${chunks.length} chunk(s)), ${appendBytes.byteLength}B`,
      { level: 'info', throttleMs: 2000, throttleKey: 'grow-only-deliver' }
    )
    this.worker.postMessage(
      { type: 'renderer-append-deliver', data: chunks } satisfies MainToWorker,
      transfer
    )
  }

  triggerPointerAction(action: import('../../input/pointerConstants').InputActionValue, phase: 'down' | 'up'): void {
    this.pointerEvents?.triggerInputAction(action, phase)
  }

  /** ~60Hz worker ticks during held flight keys — snapshot is level-state (no edge spam). */
  private pumpSceneEngineTick(): void {
    if (!this.running || !this.worker) return
    this.worker.postMessage({ type: 'pump-scene-engine-tick' } satisfies MainToWorker)
  }

  armSceneLoopReceive(armed: boolean): void {
    this.sceneLoopReceiveArmed = armed
    if (!armed && this.crdtOutboundPending.length) this.flushCrdtOutboundPendingSynchronously()
  }

  isPlayFrameInFlight(): boolean {
    if (!this.playFrameInFlight) return false
    if (this.playFrameInFlightAt > 0 && performance.now() - this.playFrameInFlightAt > 2000) {
      this.playFrameInFlight = false
      this.playFrameInFlightAt = 0
      return false
    }
    return true
  }

  hasPendingApplyWork(): boolean {
    return this.hasContentApplyWork()
  }

  /**
   * Gltf / textured maps / unsealed structure only.
   * Motion + scalar primitives apply at fold (host world).
   */
  hasContentApplyWork(): boolean {
    if ((this.getAttachProgressLite()?.pendingMesh ?? 0) > 0) return true
    for (const [entity, comps] of this.pendingDiff) {
      for (const cid of comps.keys()) {
        if (this.pendingDiffLaneOf(cid, entity) !== 'motion') return true
      }
    }
    return false
  }

  /** Pose is written at fold. Watchdog only — do not replay Transform/Tween/Vis. */
  peelMotionSync(_deadlineMs: number): void {
    this.assertNoFoldMotionInPendingDiff('peelMotionSync')
  }

  private assertNoFoldMotionInPendingDiff(where: string): void {
    if (!this.pendingDiff.size) return
    for (const [entity, comps] of this.pendingDiff) {
      for (const cid of comps.keys()) {
        if (!this.isHostMotionComponent(cid)) continue
        console.error(`[host-motion] ${where}: e${entity} cid=${cid} still in pendingDiff`)
        return
      }
    }
  }

  /** Phase 2 — one unified worker play frame per main rAF (engine.update + pollEvents). */
  tickPlayFrame(): void {
    // Do not gate on bootPhaseActive: eval-done sets running while onStart continues, and
    // World may notifyPlayReady before worker `ready`. Blocking ticks here deadlocks SpaceRunner
    // (InputModifier.disableAll freeze-watch never gets dt / never sees Gltf FINISHED).
    if (!this.running || !this.worker) return
    // Never stack a play-frame while poll/egress is live (second engine.update).
    if (this.isPlayFrameInFlight()) return
    this.refreshClientPosesFromProvider()
    this.refreshRealmInfoFromProvider()
    const player = this.clientPlayerPose
    const camera = this.clientCameraPose
    const primaryPointer = this.pointerEvents?.getPrimaryPointerSnapshot() ?? undefined
    const poseMoved = this.playFramePoseMoved(player, camera, primaryPointer)
    this.syncPointerInput(this.crdtTick, { processPendingDown: false, processPendingUp: false })
    this.crdtTick++
    if (poseMoved) this.rememberPlayFramePose(player, camera, primaryPointer)
    this.playFrameInFlight = true
    this.playFrameInFlightAt = performance.now()
    this.worker.postMessage({
      type: 'play-frame-tick',
      ...(poseMoved && player
        ? {
            player: {
              position: {
                x: player.position.x,
                y: player.position.y,
                z: player.position.z
              },
              rotation: {
                x: player.rotation.x,
                y: player.rotation.y,
                z: player.rotation.z,
                w: player.rotation.w
              }
            }
          }
        : {}),
      ...(poseMoved && camera
        ? {
            camera: {
              position: {
                x: camera.position.x,
                y: camera.position.y,
                z: camera.position.z
              },
              rotation: {
                x: camera.rotation.x,
                y: camera.rotation.y,
                z: camera.rotation.z,
                w: camera.rotation.w
              }
            }
          }
        : {}),
      ...(primaryPointer ? { primaryPointer } : {})
    } satisfies MainToWorker)
  }

  private playFramePoseMoved(
    player: EntityPose | null,
    camera: EntityPose | null,
    ppi: { worldRayDirection: { x: number; y: number; z: number } } | undefined
  ): boolean {
    const eps = 1e-4
    const posChanged = (
      a: { x: number; y: number; z: number },
      b: { x: number; y: number; z: number }
    ): boolean =>
      Math.abs(a.x - b.x) > eps || Math.abs(a.y - b.y) > eps || Math.abs(a.z - b.z) > eps
    const rotChanged = (
      a: { x: number; y: number; z: number; w: number },
      b: { x: number; y: number; z: number; w: number }
    ): boolean =>
      Math.abs(a.x - b.x) > eps ||
      Math.abs(a.y - b.y) > eps ||
      Math.abs(a.z - b.z) > eps ||
      Math.abs(a.w - b.w) > eps
    if (player) {
      if (posChanged(player.position, this.lastSentPlayerPos)) return true
      if (rotChanged(player.rotation, this.lastSentPlayerRot)) return true
    }
    if (camera) {
      if (posChanged(camera.position, this.lastSentCamPos)) return true
      if (rotChanged(camera.rotation, this.lastSentCamRot)) return true
    }
    if (ppi && posChanged(ppi.worldRayDirection, this.lastSentPpiDir)) return true
    return Number.isNaN(this.lastSentPlayerPos.x)
  }

  private rememberPlayFramePose(
    player: EntityPose | null,
    camera: EntityPose | null,
    ppi: { worldRayDirection: { x: number; y: number; z: number } } | undefined
  ): void {
    if (player) {
      this.lastSentPlayerPos = { x: player.position.x, y: player.position.y, z: player.position.z }
      this.lastSentPlayerRot = {
        x: player.rotation.x,
        y: player.rotation.y,
        z: player.rotation.z,
        w: player.rotation.w
      }
    }
    if (camera) {
      this.lastSentCamPos = { x: camera.position.x, y: camera.position.y, z: camera.position.z }
      this.lastSentCamRot = {
        x: camera.rotation.x,
        y: camera.rotation.y,
        z: camera.rotation.z,
        w: camera.rotation.w
      }
    }
    if (ppi) {
      this.lastSentPpiDir = { ...ppi.worldRayDirection }
    }
  }

  /** Level keyboard snapshot → worker (InputHub fan-out). */
  private publishSceneInputSnapshot(
    body: import('../../player/sceneInputSnapshot').SceneInputSnapshotBody
  ): void {
    if (!this.running || !this.worker) {
      clientDebugLog.log(
        'input',
        `snapshot drop id=${this.inputSubscriberId} running=${this.running} worker=${!!this.worker} pressed=${body.pressed.length}`,
        { level: 'warn', alsoConsole: true, throttleMs: 500 }
      )
      return
    }
    this.worker.postMessage({ type: 'scene-input-snapshot', body } satisfies MainToWorker)
    if (body.pressed.length > 0) {
      clientDebugLog.log(
        'input',
        `snapshot → ${this.inputSubscriberId} pressed=[${body.pressed.join(',')}]`,
        { alsoConsole: true, throttleMs: 200 }
      )
    }
  }

  updatePointerEvents(tickNumber: number): void {
    this.pointerEvents?.updateVisuals(tickNumber)
  }

  /** Flush queued pointer down/up after worker CRDT apply — ADR-214 executeRaycast stage. */
  syncPointerInput(
    tickNumber: number,
    options?: { processPendingDown?: boolean; processPendingUp?: boolean }
  ): void {
    this.pointerEvents?.syncInput(tickNumber, options)
  }

  private logPointerFlushSkipped(reason: string): void {
    console.warn('[pointer]', `pointer flush skipped — ${reason}`)
    clientDebugLog.log('pointer', `pointer flush skipped — ${reason}`, {
      alsoConsole: false,
      level: 'warn'
    })
  }

  /**
   * Push pointer edge to worker via inject-pointer-click only.
   *
   * Platform law: inject is the only authoritative PE edge. Main never encodes
   * PointerEventsResult for the worker (`recordRendererAppend` no-ops 1063).
   * Safety: discard any PE appends that still land in the encoder before inject.
   * Do not open deliver-done on light `pointer-crdt-deliver` (no ack → 2s freeze).
   */
  async flushPendingPointerCrdt(): Promise<void> {
    if (!this.pointerEvents) {
      this.logPointerFlushSkipped('pointer system not bound')
      return
    }
    if (!this.running || !this.worker) {
      this.logPointerFlushSkipped(!this.running ? 'scene worker not running' : 'scene worker missing')
      return
    }
    if (this.pointerFlushInFlight) {
      // Do not drop the edge — retry after the in-flight flush finishes.
      this.pointerFlushCoalesceRequested = true
      this.logPointer('pointer flush coalesced — flush already in flight')
      return
    }
    if (this.pointerDeliverAwaitingAck) {
      this.pointerFlushCoalesceRequested = true
      this.logPointer('pointer flush coalesced — awaiting pointer-deliver-done')
      return
    }
    if (!this.pointerEvents.hasPendingInput() && !this.pointerEvents.hasPendingInjectPayload()) {
      this.logPointerFlushSkipped('no pending pointer down/up/inject')
      return
    }

    this.pointerFlushInFlight = true
    try {
      this.logPointer(`pointer flush start — tick=${this.crdtTick}`)
      clientDebugLog.log('pointer', `flush pending input tick=${this.crdtTick}`, {
        alsoConsole: POINTER_VERBOSE
      })
      // Explorer press lifecycle: one edge per flush.
      // CRITICAL: process UP before DOWN when both are pending. Preferring DOWN under
      // click-spam left PET_DOWN without PET_UP → getClick never fired (no VFX) and a
      // pile of DOWN-only injects froze the client.
      const hasDown = this.pointerEvents.hasPendingDown()
      const hasUp = this.pointerEvents.hasPendingUp()
      if (hasUp) {
        this.syncPointerInput(this.crdtTick, {
          processPendingDown: false,
          processPendingUp: true
        })
        this.crdtTick++
      } else if (hasDown) {
        this.syncPointerInput(this.crdtTick, {
          processPendingDown: true,
          processPendingUp: false
        })
        this.crdtTick++
      }

      // Capture inject immediately after the edge write — never re-read after encode/discard.
      const inject = this.pointerEvents.consumeInjectPayload()

      // Belt: PE should never be recorded (recordRendererAppend gates 1063). If anything
      // still queued PE appends, drop them so grow-only cannot ghost-fire EventSystem.
      if (inject || hasDown || hasUp) {
        const dropped = this.encoder.discardRecordedAppends(
          this.readComponents.PointerEventsResult.componentId
        )
        if (dropped > 0) {
          clientDebugLog.log(
            'pointer',
            `inject-only — discarded ${dropped} unexpected PointerEventsResult append(s) (should be never-record)`,
            { level: 'warn', alsoConsole: true }
          )
        }
      }

      if (!inject) {
        // Edge write failed or orphan empty flush — never arm deliver-done watchdog.
        console.warn(
          '[pointer]',
          `pointer flush — no inject after edge (down=${hasDown ? 1 : 0} up=${hasUp ? 1 : 0}); not awaiting worker`
        )
        if (
          this.pointerEvents.hasPendingUp() ||
          this.pointerEvents.hasPendingDown() ||
          this.pointerFlushCoalesceRequested
        ) {
          this.pointerFlushCoalesceRequested = false
          queueMicrotask(() => void this.flushPendingPointerCrdt())
        }
        return
      }

      this.pointerAwaitingWorkerApply = true
      // Never collect board-wide dirties from sceneUi menus (edgeVis=3306 hitch).
      this.pointerEdgeVisualCollect = !inject.sceneUi
      if (this.pointerEdgeVisualCollect) {
        this.pointerEdgeVisualEntities.clear()
        this.pointerEdgeVisualUntil = performance.now() + 250
      }
      this.deliverInjectToWorker(inject)
      // If we only sent DOWN, flush UP after deliver-done (same user click, correct order).
      if (hasDown && this.pointerEvents.hasPendingUp()) {
        this.pointerFlushCoalesceRequested = true
      }
    } finally {
      this.pointerFlushInFlight = false
      // In-flight coalesce: another press landed while we held the lock.
      if (this.pointerFlushCoalesceRequested && !this.pointerDeliverAwaitingAck) {
        this.pointerFlushCoalesceRequested = false
        queueMicrotask(() => void this.flushPendingPointerCrdt())
      }
    }
  }

  /**
   * Post inject-pointer-click and arm deliver-done. Inject-only — never pairs with
   * light renderer inbound (`pointer-crdt-deliver`; that path does not ack).
   */
  private deliverInjectToWorker(inject: import('../../player/injectPointerClick').InjectPointerClickBody): void {
    if (!this.worker) {
      console.warn('[pointer]', 'pointer deliver skipped — worker missing')
      this.pointerAwaitingWorkerApply = false
      return
    }

    // Universal edge inject: deliver-done is near-instant; never hold cooperative ticks
    // for mouse-hold duration (all scenes need isPressed + live particles/VC/tweens).
    this.pointerDeliverAwaitingAck = true
    this.pointerHoldTicksUntilMount = false
    this.armPointerDeliverWatchdog(2000)

    // Refresh PPI + camera at post time — edge ticks do not wait for play-frame-tick.
    // Scenes ray ground as CameraEntity.position × PPI.worldRayDirection; stale camera
    // under VC (player feet vs lens at y=26) breaks click VFX placement / getClick handlers.
    const ppi =
      this.pointerEvents?.getPrimaryPointerSnapshot() ?? inject.primaryPointer ?? undefined
    if (ppi) inject.primaryPointer = ppi
    inject.camera = this.capturePointerEdgeCameraDcl()
    const sc = inject.primaryPointer?.screenCoordinates
    const ray = inject.primaryPointer?.worldRayDirection
    const cam = inject.camera?.position
    const hit = inject.hitPosition
    const injectLine =
      `posting inject-pointer-click entity=${inject.entity} button=${inject.button} ` +
      `ts=${inject.downTimestamp}/${inject.upTimestamp} (inject-only)` +
      ` sceneUi=${inject.sceneUi ? 1 : 0}` +
      ` levelState=${inject.levelState ? 1 : 0}` +
      ` phase=${inject.phase ?? 'click'}` +
      ` down=[${(inject.downEntities ?? inject.entities).join(',')}]` +
      (hit
        ? ` hit=(${hit.x.toFixed(1)},${hit.y.toFixed(1)},${hit.z.toFixed(1)})`
        : ' hit=missing') +
      (sc
        ? ` ppi=(${sc.x.toFixed(0)},${sc.y.toFixed(0)})` +
          (ray ? ` ray=(${ray.x.toFixed(2)},${ray.y.toFixed(2)},${ray.z.toFixed(2)})` : '')
        : ' ppi=missing') +
      (cam ? ` cam=(${cam.x.toFixed(1)},${cam.y.toFixed(1)},${cam.z.toFixed(1)})` : ' cam=missing')
    console.log('[pointer]', injectLine)
    this.logPointer(injectLine)
    this.worker.postMessage({
      type: 'inject-pointer-click',
      body: inject,
      injectOnly: true
    } satisfies MainToWorker)
  }

  /** Live camera pose (DCL) for pointer-edge CameraEntity write. */
  private capturePointerEdgeCameraDcl(): {
    position: { x: number; y: number; z: number }
    rotation: { x: number; y: number; z: number; w: number }
  } | undefined {
    this.refreshClientPosesFromProvider()
    const cam = this.clientCameraPose
    if (!cam) return undefined
    return {
      position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
      rotation: {
        x: cam.rotation.x,
        y: cam.rotation.y,
        z: cam.rotation.z,
        w: cam.rotation.w
      }
    }
  }

  private onPointerDeliverDone(): void {
    this.logPointer('pointer-deliver-done — worker finished pointer tick + onUpdate CRDT flush')
    this.videoPlayerBridge?.notifyUserPointerDelivered()
    void this.finishPointerDeliveryAfterWorkerAck().catch((err) => {
      console.error(
        '[pointer]',
        `finishPointerDelivery failed — ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }

  /** Await outbound serial apply — UI chunk is acked before worker posts deliver-done. */
  private async finishPointerDeliveryAfterWorkerAck(): Promise<void> {
    await this.crdtOutboundSerial
    await this.finishPointerDeliveryAsync('pointer-deliver-done', { afterOutboundBatch: true })
  }

  /**
   * After PE click inject: single peel-only drain (motion + material/leaf).
   * Never fullDump. Gltf structure stays on async frames. No catch-pass / dual glow peels.
   * New MeshRenderer+Material on next cooperative CRDT admits as true dirty and peels next frame.
   */
  private applyPostPointerMotion(): void {
    if (!this.bridge || !this.entityStore) return
    const t0 = performance.now()
    const F = SceneScriptSystem.FRAME
    // Keep collecting briefly for late getClick CRDT (not board-wide).
    if (this.pointerEdgeVisualUntil > performance.now()) {
      this.pointerEdgeVisualCollect = true
    }
    this.peelPointerEdgeVisuals()
    void this.drainPendingDiffLanes({
      pointerEdge: true,
      deadlineMs: F.POINTER_MOTION_MS + F.POINTER_MATERIAL_MS
    })
      .then(() => {
        this.peelPointerEdgeVisuals()
        this.bridge?.flushMissingMeshRendererLeaves(48)
        perfNotePointerEdge(performance.now() - t0, false)
      })
      .catch((err) => {
        console.warn(
          '[pointer]',
          `post-pointer peel failed — ${err instanceof Error ? err.message : String(err)}`
        )
      })
    // Light time advance for click Tweens / particles.
    this.tweenBridge?.sync(this.view)
    if (this.tweenBridge?.hasLiveTweens()) {
      this.tweenBridge.update(1 / 30, this.view)
      this.markTweenColliderPosesDirty()
    }
    void this.particleBridge?.sync(this.view)
    this.particleBridge?.update(1 / 30)
    if (this.pointerStructureDirty) {
      const pe: Entity[] = []
      for (const [entity] of this.view.getEntitiesWith(this.readComponents.PointerEvents)) {
        if (
          entity === this.view.RootEntity ||
          entity === this.view.PlayerEntity ||
          entity === this.view.CameraEntity
        ) {
          continue
        }
        if (this.readComponents.UiTransform.has(entity)) continue
        pe.push(entity)
      }
      if (pe.length) {
        const fixed = this.bridge.ensurePointerMeshesReady(pe)
        if (fixed > 0) this.pointerStructureDirty = true
      }
      this.flushPointerStructureIfDirty()
    }
    this.flushSceneGraphMatrices()
  }

  /** Worker ticks resume only after mount set committed and projection UiTransform caught up. */
  private canResumeWorkerSceneTicksAfterPointer(): boolean {
    if (this.projectionLagPendingUi) return false
    if (this.pendingUiEntities !== undefined) return false
    return true
  }

  /**
   * Worker onUpdate may publish transform / mesh diffs (plant growth) while delivery is in flight.
   * Wait for one-way outbound, apply projection diff, then sync CL_POINTER colliders.
   */
  private async reconcilePointerCollisionAfterDelivery(opts?: { afterOutboundBatch?: boolean }): Promise<void> {
    if (!opts?.afterOutboundBatch) {
      await this.crdtOutboundSerial
    }
    // COD A3: one pointer-budgeted lane drain — never fullDump map swap.
    if (this.bridge?.canConsumeDiff() && this.pendingDiff.size) {
      const F = SceneScriptSystem.FRAME
      await this.drainPendingDiffLanes({
        pointerEdge: true,
        deadlineMs: F.POINTER_MOTION_MS + F.POINTER_MATERIAL_MS + F.STRUCTURE_MS
      })
    } else {
      this.consumeSyncFrameTransforms()
    }
    this.flushSceneGraphMatrices()
    if (this.hasColliderWorkPending()) {
      this.syncCollision()
    } else {
      this.syncPointerCollisionPoses()
    }
    const poseChanged = [...this.lastPoseChangedEntities]
    if (poseChanged.length) {
      this.collidersPoseCallback?.(poseChanged)
    }
    this.refreshPointerTargets()
    this.collidersCookCallback?.()
  }

  /** Clear pointer flush state and resume worker scene ticks after delivery (idempotent). */
  private async finishPointerDeliveryAsync(
    source: string,
    opts?: { afterOutboundBatch?: boolean }
  ): Promise<void> {
    if (!this.pointerAwaitingWorkerApply && !this.pointerDeliverAwaitingAck) return
    clientDebugLog.log('pointer', `delivery complete — ${source}`, { alsoConsole: false })
    this.pointerAwaitingWorkerApply = false
    this.pointerOutboundDeferBuffer = []
    this.clearPointerDeliverWatchdog()
    // Resume worker ticks FIRST — never leave the scene frozen while main paints Yoga
    // or awaits crdtOutboundSerial (that was an indefinite click freeze).
    this.forceResumeWorkerSceneTicks(source)
    // Flush any TweenState that was deferred while inject was in flight (blimp sequence).
    this.deliverTweenStateToWorker()
    try {
      if (!opts?.afterOutboundBatch) {
        await this.crdtOutboundSerial
      }
      this.flushUiFrame()
      await this.reconcilePointerCollisionAfterDelivery(opts)
      // Click-move / select anim: apply Tween+Transform from the inject CRDT now.
      this.applyPostPointerMotion()
      this.proactiveTweenPushUntil = performance.now() + SceneScriptSystem.PROACTIVE_TWEEN_PUSH_MS
      // Second chance after motion apply — sequence may have just completed.
      this.deliverTweenStateToWorker()
    } catch (err) {
      console.error(
        '[pointer]',
        `post-deliver apply failed — ${err instanceof Error ? err.message : String(err)}`
      )
    }
    // Mount paint lag is handled by flushUiFrame / maybeForceResumeWorkerTicksOnUiLag.
    if (
      this.pointerFlushCoalesceRequested &&
      (this.pointerEvents?.hasPendingInput() || this.pointerEvents?.hasPendingInjectPayload())
    ) {
      this.pointerFlushCoalesceRequested = false
      void this.flushPendingPointerCrdt()
    } else {
      this.pointerFlushCoalesceRequested = false
    }
  }

  /** Worker path failed — surface loudly; scene triggers/tweens did not run. */
  private failPointerDelivery(reason: string): void {
    if (!this.pointerAwaitingWorkerApply && !this.pointerDeliverAwaitingAck) return
    const message = `pointer delivery failed — ${reason} (worker must ack pointer-deliver-done)`
    console.error('[pointer]', message)
    clientDebugLog.log('pointer', message, { level: 'error', alsoConsole: true })
    this.pointerHoldTicksUntilMount = false
    this.pointerOutboundDeferBuffer = []
    // finishPointerDeliveryAsync resumes ticks before any paint await — no indefinite freeze.
    void this.finishPointerDeliveryAsync('pointer-delivery-failed')
  }

  private armPointerDeliverWatchdog(timeoutMs?: number): void {
    if (this.pointerDeliverFailWatchdog) {
      clearTimeout(this.pointerDeliverFailWatchdog)
      this.pointerDeliverFailWatchdog = null
    }
    const ms = timeoutMs ?? SceneScriptSystem.POINTER_DELIVER_FAIL_MS
    this.pointerDeliverFailWatchdog = setTimeout(() => {
      if (!this.pointerDeliverAwaitingAck) return
      this.failPointerDelivery('no worker pointer-deliver-done')
    }, ms)
  }

  private clearPointerDeliverWatchdog(): void {
    if (this.pointerDeliverFailWatchdog) {
      clearTimeout(this.pointerDeliverFailWatchdog)
      this.pointerDeliverFailWatchdog = null
    }
    this.pointerDeliverAwaitingAck = false
  }

  /** Advance tweens after inbound CRDT (scene may have just added Tween on worker). */
  private syncTweenBeforeEncode(): void {
    if (!this.tweenBridge) return
    const { Tween } = this.readComponents
    let tweenCount = 0
    for (const _ of this.view.getEntitiesWith(Tween)) tweenCount++
    this.tweenBridge.sync(this.view)
    // Encode progress accumulated by pumpMotionBridges — do not advance again here.
    this.tweenBridge.update(0, this.view)
    if (isTweenVerbose() && tweenCount > 0) {
      clientDebugLog.log(
        'motion',
        `Tween encode prep — ${tweenCount} active tween(s) before CRDT outbound`,
        { throttleMs: 400, alsoConsole: true }
      )
    }
  }

  /** Encode renderer-owned CRDT — tween path scoped to entities updated this frame. */
  private encodeRendererCrdt(): Uint8Array | null {
    const tweenDirty = this.tweenBridge?.consumeEncodeDirty() ?? null
    this.encoder.setTweenEncodeEntities(tweenDirty)
    const bytes = this.encoder.encode()
    if (isTweenVerbose() && tweenDirty?.size) {
      clientDebugLog.log(
        'motion',
        `TweenState CRDT deliver — ${tweenDirty.size} entity(s) [${[...tweenDirty].join(', ')}]`,
        { throttleMs: 300, alsoConsole: true }
      )
    }
    return bytes
  }

  /** Apply latest client poses to projection before renderer outbound CRDT. */
  private prepareRendererOutboundState(): void {
    this.projection.flushPendingMainCameraBind()
    this.refreshClientPosesFromProvider()
    this.refreshRealmInfoFromProvider()
    if (!this.clientPlayerPose || !this.clientCameraPose) return
    this.prepareReservedRoundTrip(this.clientPlayerPose, this.clientCameraPose)
  }

  private refreshClientPosesFromProvider(): void {
    if (!this.clientPoseProvider) return
    const { player, camera } = this.clientPoseProvider()
    this.clientPlayerPose = player
    this.clientCameraPose = camera
  }

  syncClientEntities(player: EntityPose, camera: EntityPose): void {
    this.clientPlayerPose = player
    this.clientCameraPose = camera
    this.refreshRealmInfoFromProvider()
    this.prepareReservedRoundTrip(player, camera)
  }

  /** After movePlayerTo — sync worker PlayerEntity before the scene reads it again. */
  private pushReservedTransformsToWorker(): void {
    if (!this.worker || !this.running) return
    this.refreshClientPosesFromProvider()
    if (!this.clientPlayerPose || !this.clientCameraPose) return
    this.refreshRealmInfoFromProvider()
    this.prepareReservedRoundTrip(this.clientPlayerPose, this.clientCameraPose)
    const bytes = this.encodeRendererCrdt()
    if (!bytes?.byteLength) return
    const copy = bytes.slice()
    this.worker.postMessage(
      { type: 'renderer-inbound-deliver', data: [copy] } satisfies MainToWorker,
      [copy.buffer]
    )
  }

  /** Fire network fetches for every GLB in the scene content manifest — downloads only, no attach. */
  prefetchGltfs(): void {
    this.bridge?.prefetchSceneGlbs()
  }

  /**
   * Yield before heavy renderer sync so worker `crdt-send` handlers can drain.
   * Composite spawn publishes GltfContainer across many round-trips during hydration.
   */
  async yieldForWorkerMessages(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }

  /**
   * Full projection → Three.js walk — use while the loading screen is still reconciling
   * transforms (prewarm / settle) after hydration ends.
   */
  async syncRendererFull(): Promise<void> {
    if (!this.bridge) return
    const view = this.view
    this.bridge.prefetchSceneGlbs()
    this.pendingDiff.clear()
    this.pointerStructureDirty = true
    await this.bridge.sync(view)
    this.colliderFullWalkRequested = true
    this.flushPointerStructureIfDirty()
    this.applyUiFrame([])
  }

  /**
   * Scene UI is event-driven — repaint when projection diff touches UI components, or when
   * mount commit was deferred waiting for UiTransform rows. Worker→main CRDT outbound already
   * calls applyUiFrame in the same batch as applyIncoming (primary path for bg/display churn).
   */
  private syncSceneUiAfterRenderer(
    sceneDiff?: Map<Entity, Map<number, ProjectionChangeKind>>
  ): void {
    if (!this.sceneUiBridge) return
    if (this.projectionLagPendingUi || this.pendingUiEntities !== undefined) {
      this.flushUiFrame()
      return
    }
    if (
      sceneDiff?.size &&
      this.sceneUiBridge.hasCommittedMountSet() &&
      this.diffTouchesSceneUi(sceneDiff)
    ) {
      this.applyUiFrame([])
    }
  }

  private diffTouchesSceneUi(diff: Map<Entity, Map<number, ProjectionChangeKind>>): boolean {
    const { UiTransform, UiText, UiBackground, UiInput, UiDropdown } = this.readComponents
    const uiIds = new Set([
      UiTransform.componentId,
      UiText.componentId,
      UiBackground.componentId,
      UiInput.componentId,
      UiDropdown.componentId
    ])
    for (const comps of diff.values()) {
      for (const id of comps.keys()) {
        if (uiIds.has(id)) return true
      }
    }
    return false
  }

  private logProjectionLagIfStale(mountSet: ReadonlySet<Entity> | null | undefined): void {
    if (!mountSet?.size) return
    const now = performance.now()
    if (this.projectionLagLoggedAt && now - this.projectionLagLoggedAt < 3000) return
    this.projectionLagLoggedAt = now
    const ecs = this.view.components
    let withTransform = 0
    for (const entity of mountSet) {
      if (ecs.UiTransform.has(entity)) withTransform++
    }
    console.warn(
      `[scene-ui] mount commit deferred — worker=${mountSet.size} projection UiTransform=${withTransform}/${mountSet.size} ` +
        '(add ?sceneuidebug for yoga/DOM detail)'
    )
  }

  /**
   * COD AAA — single ordered lane drain for play (Motion → Materials → Structure).
   * Optional deadlineMs for multi-worker residual fullWork (F1).
   * Never swaps the entire pendingDiff map (fullDump thrash).
   */
  async syncRenderer(opts?: { deadlineMs?: number }): Promise<void> {
    if (!this.bridge) return
    const view = this.view
    const F = SceneScriptSystem.FRAME
    const framePieMs = F.MOTION_MS + F.MATERIAL_MS + F.STRUCTURE_MS
    const deadlineMs =
      opts?.deadlineMs !== undefined && Number.isFinite(opts.deadlineMs)
        ? Math.max(0, opts.deadlineMs)
        : framePieMs

    // Diff consumer at runtime; full walk only while asset hydration is active.
    if (this.bridge.canConsumeDiff()) {
      // COD C2 — UI paint independent of structure backlog.
      if (this.projectionLagPendingUi || this.pendingUiEntities !== undefined) {
        this.flushUiFrame()
      }

      if (!this.pendingDiff.size) {
        await this.bridge.drainPendingWork()
        this.syncSceneUiAfterRenderer()
        return
      }
      if (!this.projectionDiffActive) {
        this.projectionDiffActive = true
        clientDebugLog.log('projection', 'diff consumer ACTIVE — rendering driven by projection diff (default)', {
          level: 'success',
          alsoConsole: true
        })
      }

      await this.drainPendingDiffLanes({ deadlineMs })
      this.syncSceneUiAfterRenderer()
      this.publishPendingDiffPerf()
      return
    }

    this.bridge.prefetchSceneGlbs()

    // Hydration — full walk reconciles everything; discard accumulated diff.
    this.pendingDiff.clear()
    this.pendingDiffOldestAt = 0
    this.pointerStructureDirty = true
    await this.bridge.sync(view)
    this.flushPointerStructureIfDirty()
    this.applyUiFrame([])
  }

  private playReadyNotified = false
  private performanceTier: PerformanceTier = 'high'

  setPerformanceTier(tier: PerformanceTier): void {
    this.performanceTier = tier
  }

  getPerformanceTier(): PerformanceTier {
    return this.performanceTier
  }

  /** Full pause — pointer delivery only; blocks engine.update (do not use during hydration). */
  setSceneWorkerTicksPaused(paused: boolean): void {
    this.worker?.postMessage({ type: 'pause-scene-ticks', paused } satisfies MainToWorker)
  }

  /**
   * Hydration perf — skip exports.onUpdate (ChessGameManager, area scripts) while
   * engine.update keeps publishing composite GltfContainer CRDT.
   */
  setSceneWorkerOnUpdatePaused(paused: boolean): void {
    this.worker?.postMessage({ type: 'pause-scene-onupdate', paused } satisfies MainToWorker)
  }

  /** Scene + PhysX colliders ready — throttle worker onUpdate (called from World after boot cook). */
  notifyPlayReady(options?: {
    plazaScale?: boolean
    engineTickIntervalMs?: number
    portableExperience?: boolean
  }): void {
    // PE: bind Animator every async frame (propellers / drone clips); primary keeps 12-frame stride.
    this.bridgeSyncEvery = options?.portableExperience ? 1 : BRIDGE_ECS_SYNC_RUNTIME
    this.setSceneWorkerOnUpdatePaused(false)
    this.setSceneWorkerTicksPaused(false)
    this.avatarShapes?.setPlayReady(true)
    // Fishing / syncEntity: ensure SDK network saw isConnectedSceneRoom after LiveKit is up.
    this.pulseSceneNetworkConnected()
    if (this.playReadyNotified) return
    this.playReadyNotified = true
    this.worker?.postMessage({
      type: 'scene-play-ready',
      performanceTier: this.performanceTier,
      plazaScale: options?.plazaScale,
      engineTickIntervalMs:
        options?.engineTickIntervalMs ?? resolveEngineTickIntervalMs(this.performanceTier),
      portableExperience: options?.portableExperience === true
    } satisfies MainToWorker)
  }

  /** Parent transform moved — mark collider poses dirty down the subtree only. */
  private markDescendantColliderPosesDirty(ancestor: Entity): void {
    const stack: Entity[] = [...(this.transformChildren.get(ancestor) ?? [])]
    while (stack.length > 0) {
      const entity = stack.pop()!
      if (this.colliderRootEntities.has(entity)) this.colliderPoseDirty.add(entity)
      const children = this.transformChildren.get(entity)
      if (children) {
        for (const child of children) stack.push(child)
      }
    }
  }

  /** Parent structure changed — mark collider structure dirty down the subtree only. */
  private markDescendantColliderStructureDirty(ancestor: Entity): void {
    const { MeshCollider, GltfContainer } = this.readComponents
    const stack: Entity[] = [...(this.transformChildren.get(ancestor) ?? [])]
    while (stack.length > 0) {
      const entity = stack.pop()!
      if (MeshCollider.has(entity) || GltfContainer.has(entity)) {
        this.colliderStructureDirty.add(entity)
      }
      const children = this.transformChildren.get(entity)
      if (children) {
        for (const child of children) stack.push(child)
      }
    }
  }

  /** Frame-start Animator GLTF root world origin — lifts that move the entity node without `_collider` Δ. */
  private readonly animatorOriginSnapshot = new Map<Entity, THREE.Vector3>()
  private readonly frameAnimatorOriginDelta = new Map<Entity, THREE.Vector3>()
  private readonly frameAnimatorOriginPos = new Map<Entity, THREE.Vector3>()

  snapshotAnimatorOriginPositions(_feet: THREE.Vector3, scopeEntity?: Entity): void {
    this.animatorOriginSnapshot.clear()
    const nodes = this.bridge?.getEntityNodes()
    if (!nodes || scopeEntity === undefined) return
    const node = nodes.get(scopeEntity)
    if (!node) return
    node.updateMatrixWorld(true)
    this.animatorOriginSnapshot.set(
      scopeEntity,
      new THREE.Vector3().setFromMatrixPosition(node.matrixWorld)
    )
  }

  /** Animator root Δ after motion bridges — only the grounded platform entity. */
  computeAnimatorOriginDeltas(_feet: THREE.Vector3, scopeEntity?: Entity): Entity[] {
    this.frameAnimatorOriginDelta.clear()
    this.frameAnimatorOriginPos.clear()
    const changed: Entity[] = []
    const nodes = this.bridge?.getEntityNodes()
    if (!nodes) return changed
    for (const [entity, snapshot] of this.animatorOriginSnapshot) {
      if (scopeEntity !== undefined && entity !== scopeEntity) continue
      const node = nodes.get(entity)
      if (!node) continue
      node.updateMatrixWorld(true)
      const pos = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld)
      const delta = pos.clone().sub(snapshot)
      this.frameAnimatorOriginPos.set(entity, pos)
      if (delta.lengthSq() > 1e-14) {
        this.frameAnimatorOriginDelta.set(entity, delta)
        changed.push(entity)
      }
    }
    return changed
  }

  consumeAnimatorOriginDeltasPhys(): Map<number, THREE.Vector3> {
    const out = new Map<number, THREE.Vector3>()
    for (const [entity, delta] of this.frameAnimatorOriginDelta) {
      out.set(GLTF_COLLIDER_ENTITY_BASE + entity, delta.clone())
    }
    return out
  }

  consumeAnimatorOriginPositionsPhys(): Map<number, THREE.Vector3> {
    const out = new Map<number, THREE.Vector3>()
    for (const [entity, pos] of this.frameAnimatorOriginPos) {
      out.set(GLTF_COLLIDER_ENTITY_BASE + entity, pos.clone())
    }
    return out
  }



  consumeWalkSurfaceDeltas(): Map<number, THREE.Vector3> {
    return this.gltfColliders?.consumeFrameWalkSurfaceDeltasPhys() ?? new Map()
  }

  consumeWalkSurfacePositions(): Map<number, THREE.Vector3> {
    return this.gltfColliders?.consumeFrameWalkSurfacePositionsPhys() ?? new Map()
  }

  motionSourceLabel(entity: Entity): string {
    const { Tween, Animator, GltfContainer } = this.readComponents
    const parts: string[] = []
    if (this.lastTweenMotionEntities.has(entity)) parts.push('tween')
    if (this.lastSyncFrameTransformEntities.has(entity)) parts.push('sync-transform')
    if (Animator.has(entity)) parts.push('animator')
    if (Tween.has(entity)) parts.push(`tween-ecs:${Tween.get(entity).mode?.$case ?? '?'}`)
    if (GltfContainer.has(entity)) parts.push('gltf-collider')
    return parts.length ? parts.join('+') : 'mesh/system'
  }

  /** One-shot ECS report — scene-wide motion + entities near the avatar (any parcel/scene). */
  dumpPlatformMotionReport(
    feet: THREE.Vector3,
    sceneOrigin?: { x: number; z: number } | null,
    nearHoriz = 96
  ): void {
    if (!platformMotionDebug.isEnabled() || this.platformMotionReportDumped) return
    this.platformMotionReportDumped = true
    const { GltfContainer, Tween, Animator, Transform } = this.readComponents
    const nodes = this.bridge?.getEntityNodes()
    const parcel = this.sceneBaseParcel ?? '?'
    const worldX = feet.x + (sceneOrigin?.x ?? 0)
    const worldZ = feet.z + (sceneOrigin?.z ?? 0)
    const lines: string[] = [
      `Platform motion report — parcel ${parcel}` +
        ` · feet scene (${feet.x.toFixed(1)}, ${feet.y.toFixed(1)}, ${feet.z.toFixed(1)})` +
        ` · world (${worldX.toFixed(1)}, ${feet.y.toFixed(1)}, ${worldZ.toFixed(1)})`
    ]
    const horizSq = (entity: Entity): number => {
      if (!Transform.has(entity)) return Number.POSITIVE_INFINITY
      const p = Transform.get(entity).position
      const dx = p.x - feet.x
      const dz = p.z - feet.z
      return dx * dx + dz * dz
    }
    const nearSq = nearHoriz * nearHoriz
    const formatTween = (entity: Entity): string => {
      const t = Tween.get(entity)
      const src = GltfContainer.has(entity) ? GltfContainer.get(entity).src : '(no gltf)'
      const pos = Transform.has(entity) ? Transform.get(entity).position : null
      const posStr = pos ? `@(${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)})` : ''
      return `  tween ${entity}${posStr} · ${t.mode?.$case ?? '?'} · ${t.playing !== false ? 'play' : 'stop'} · ${src}`
    }
    const formatAnimator = (entity: Entity): string => {
      const states = Animator.get(entity).states ?? []
      const playing = states
        .filter((s) => s.playing !== false && s.clip)
        .map((s) => s.clip)
        .join(',')
      const src = GltfContainer.has(entity) ? GltfContainer.get(entity).src : '(no gltf)'
      const pos = Transform.has(entity) ? Transform.get(entity).position : null
      const posStr = pos ? `@(${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)})` : ''
      return `  animator ${entity}${posStr} · [${playing || 'idle'}] · ${src}`
    }

    const allPlayingTweens: Entity[] = []
    const allPlayingAnimators: Entity[] = []
    for (const [entity] of this.view.getEntitiesWith(Tween)) {
      const t = Tween.get(entity)
      if (t.playing !== false) allPlayingTweens.push(entity)
    }
    for (const [entity] of this.view.getEntitiesWith(Animator)) {
      const states = Animator.get(entity).states ?? []
      if (states.some((s) => s.playing !== false && s.clip)) allPlayingAnimators.push(entity)
    }

    lines.push(`Scene-wide playing tweens (${allPlayingTweens.length}):`)
    if (allPlayingTweens.length) {
      for (const entity of allPlayingTweens.slice(0, 40)) lines.push(formatTween(entity))
      if (allPlayingTweens.length > 40) lines.push(`  … +${allPlayingTweens.length - 40} more`)
    } else {
      lines.push('  (none — lift may use Animator or scene-script Transform)')
    }

    lines.push(`Scene-wide playing animators (${allPlayingAnimators.length}):`)
    if (allPlayingAnimators.length) {
      for (const entity of allPlayingAnimators.slice(0, 40)) lines.push(formatAnimator(entity))
      if (allPlayingAnimators.length > 40) lines.push(`  … +${allPlayingAnimators.length - 40} more`)
    } else {
      lines.push('  (none)')
    }

    lines.push(`Near avatar (within ${nearHoriz}m):`)
    let nearTween = 0
    let nearAnim = 0
    let nearGltf = 0
    for (const [entity] of this.view.getEntitiesWith(Tween)) {
      if (horizSq(entity) > nearSq) continue
      nearTween++
      lines.push(formatTween(entity))
    }
    for (const [entity] of this.view.getEntitiesWith(Animator)) {
      if (horizSq(entity) > nearSq) continue
      nearAnim++
      lines.push(formatAnimator(entity))
    }
    for (const desc of this.gltfColliders?.getPhysicsColliders() ?? []) {
      const ecsEntity = (desc.entity - GLTF_COLLIDER_ENTITY_BASE) as Entity
      if (horizSq(ecsEntity) > nearSq) continue
      nearGltf++
      const src = GltfContainer.has(ecsEntity) ? GltfContainer.get(ecsEntity).src : '(no gltf)'
      const node = nodes?.has(ecsEntity) ? 'yes' : 'no'
      lines.push(`  gltf-collider ${ecsEntity} · phys=${desc.entity} · node=${node} · ${src}`)
    }
    lines.push(`Near totals — tween:${nearTween} animator:${nearAnim} gltf-collider:${nearGltf}`)
    const message = lines.join('\n')
    clientDebugLog.log('motion', message, { level: 'info' })
  }

  logPlatformMotionTick(
    feet: THREE.Vector3,
    options: {
      meshMotion: Entity[]
      poseDirty: number
      platformDeltas: { entity: number; dx: number; dy: number; dz: number }[]
      platformTransferApplied: boolean
      lastGround?: number | null
      standingPlatform?: number | null
      sceneOrigin?: { x: number; z: number } | null
    }
  ): void {
    if (!platformMotionDebug.isEnabled()) return
    const worldX = feet.x + (options.sceneOrigin?.x ?? 0)
    const worldZ = feet.z + (options.sceneOrigin?.z ?? 0)
    const parcel = this.sceneBaseParcel
    const parts = [
      parcel ? `parcel=${parcel}` : 'parcel=?',
      `feet=(${feet.x.toFixed(2)},${feet.y.toFixed(2)},${feet.z.toFixed(2)})`,
      `world=(${worldX.toFixed(1)},${feet.y.toFixed(2)},${worldZ.toFixed(1)})`,
      `poseDirty=${options.poseDirty}`,
      `meshMotion=${options.meshMotion.length}`,
      `platformΔ=${options.platformDeltas.length}`,
      `transfer=${options.platformTransferApplied ? 'yes' : 'no'}`
    ]
    if (options.lastGround != null) parts.push(`ground=${options.lastGround}`)
    if (options.standingPlatform != null) parts.push(`platform=${options.standingPlatform}`)
    if (options.meshMotion.length) {
      parts.push(
        `mesh[${options.meshMotion.map((e) => `${e}:${this.motionSourceLabel(e)}`).join(', ')}]`
      )
    }
    if (options.platformDeltas.length) {
      parts.push(
        options.platformDeltas
          .map((d) => `Δ${d.entity}=(${d.dx.toFixed(3)},${d.dy.toFixed(3)},${d.dz.toFixed(3)})`)
          .join(' ')
      )
    }
    clientDebugLog.log('motion', parts.join(' · '), {
      throttleKey: 'platform-motion-tick',
      throttleMs: 400,
      alsoConsole: true
    })
  }

  /** TweenBridge updates matrixWorld on the sync frame — mark affected collider subtrees. */
  private markTweenColliderPosesDirty(): void {
    if (!this.tweenBridge) return
    this.lastTweenMotionEntities.clear()
    const moved = this.tweenBridge.consumeTransformMotionEntities()
    // Orbit pivots (Genesis blimp): ensure parent Groups propagate world TRS to children.
    for (const entity of moved) {
      const node = this.entityStore?.getNode(entity)
      if (!node) continue
      node.matrixAutoUpdate = true
      node.updateMatrixWorld(true)
    }
    // GPU InstancedMesh stores world matrices outside entity groups — rewrite after tween pose.
    // Without this, Flagtag coins (and other instanced Tween props) look frozen.
    // Also rewrites instanced *descendants* of a moved parent (parent orbit / group spin).
    if (moved.size && this.bridge) {
      this.bridge.syncInstancedTransforms(moved)
    }
    const { MeshCollider, GltfContainer } = this.readComponents
    for (const entity of moved) {
      this.lastTweenMotionEntities.add(entity)
      if (MeshCollider.has(entity) || GltfContainer.has(entity)) {
        this.colliderPoseDirty.add(entity)
      }
      this.markDescendantColliderPosesDirty(entity)
    }
  }

  /**
   * Scene-script Transform updates arrive via projection diff — apply on the sync frame
   * before player CCT so moving platforms record walk-surface Δ the same frame.
   */
  consumeSyncFrameTransforms(): void {
    this.assertNoFoldMotionInPendingDiff('consumeSyncFrameTransforms')
  }

  /** Motion emitters (billboard / animator shape) → collider pose dirty before syncCollision. */
  private markMotionEmitterColliderDirty(): void {
    const { MeshCollider, GltfContainer } = this.readComponents
    const mark = (entity: Entity) => {
      if (MeshCollider.has(entity) || GltfContainer.has(entity)) {
        this.colliderPoseDirty.add(entity)
        this.markDescendantColliderPosesDirty(entity)
      }
    }
    for (const entity of this.billboardBridge?.pendingMotionEntities() ?? []) mark(entity)
    for (const entity of this.animatorBridge?.pendingShapeMotionEntities() ?? []) mark(entity)
  }

  /** Pose refresh before PhysX cook — keeps MeshCollider actors aligned with visuals. */
  syncCollisionPoses(): void {
    if (!this.collision || !this.bridge) return
    const nodes = this.bridge.getEntityNodes()
    this.collision.syncPoses(nodes)
    this.gltfColliders?.syncPoses(nodes, new Set())
  }

  syncCollision(): void {
    if (!this.collision || !this.bridge) return
    if (
      !this.colliderFullWalkRequested &&
      this.colliderStructureDirty.size === 0 &&
      this.colliderPoseDirty.size === 0
    ) {
      return
    }
    this.colliderPosesSyncedThisPass = false
    const nodes = this.bridge.getEntityNodes()
    const view = this.view
    const ecs = this.readComponents

    if (this.colliderFullWalkRequested) {
      this.collision.sync(view, ecs, nodes)
      this.gltfColliders?.sync(view, ecs, nodes)
      this.colliderFullWalkRequested = false
      this.colliderStructureDirty.clear()
      this.colliderPoseDirty.clear()
      this.rebuildTransformChildrenIndex()
      this.rebuildColliderRootEntities()
      // Scene graph parents may settle after extract — align PhysX poses to live matrixWorld.
      this.syncCollisionPoses()
      this.refreshPointerTargets()
      return
    }

    let structureTouched = false
    // Cap structure extracts per frame — full plaza hydrates ~1k GltfContainers; draining
    // them all in one async tick was ~100ms+ and jammed rAF (see [fps] collision=108).
    const STRUCTURE_BUDGET = 48
    const structureEntities: Entity[] = []
    if (this.colliderStructureDirty.size) {
      const allDirty = [...this.colliderStructureDirty]
      structureEntities.push(...allDirty.slice(0, STRUCTURE_BUDGET))
      const deferred = allDirty.slice(STRUCTURE_BUDGET)
      const pendingStructure = new Set<Entity>(deferred)
      for (const entity of structureEntities) {
        this.collision.syncColliderEntity(entity, view, ecs, nodes)
        if (ecs.GltfContainer.has(entity)) {
          const ready = this.gltfColliders?.syncColliderEntity(entity, view, ecs, nodes) ?? true
          if (!ready) pendingStructure.add(entity)
        }
      }
      this.colliderStructureDirty.clear()
      for (const entity of pendingStructure) this.colliderStructureDirty.add(entity)
      structureTouched = true
    }

    const poseChangedEntities: Entity[] = []
    this.lastPoseChangedEntities.length = 0
    // Child _collider matrices only for Animator PART this frame (not Transform-only dirty).
    const { animatorPart } = this.getPhysMotionSets()
    if (this.colliderPoseDirty.size) {
      for (const entity of this.colliderPoseDirty) {
        let changed = false
        if (this.collision.syncColliderEntityPose(entity, nodes)) changed = true
        const allowShapes = animatorPart.has(entity)
        if (this.gltfColliders?.syncColliderEntityPose(entity, nodes, allowShapes)) changed = true
        if (changed) poseChangedEntities.push(entity)
      }
      this.colliderPoseDirty.clear()
    }
    if (poseChangedEntities.length) {
      this.lastPoseChangedEntities.push(...poseChangedEntities)
    }

    if (structureTouched) {
      this.rebuildColliderRootEntities()
    }

    if (structureTouched || poseChangedEntities.length > 0) {
      this.collision.finalizeColliderSync()
      this.gltfColliders?.finalizeColliderSync()
    }

    if (structureTouched) {
      const cooked = structureEntities.filter((entity) => !this.colliderStructureDirty.has(entity))
      // Always enqueue cooks for every entity that finished extract this pass.
      // Previously batches ≥8 called cook with no entity → World.reconcile only validated
      // the existing queue and never discovered new post-boot extracts (SpaceRunner map1
      // + traps spawn ~30 GLBs → floors never cooked → fall-through).
      for (const entity of cooked) this.collidersCookCallback?.(entity)
      // Do NOT call collidersCookCallback() with no entity after each batch.
      // That ran World.discoverUnsynced over every plaza collider on every late GLB attach
      // batch (~40–50ms collision + thrash) and soft-killed furniture after ~1 min.
      // Per-entity enqueue above is enough for late attaches; boot uses explicit discover.
      this.refreshPointerTargets()
    }

    if (poseChangedEntities.length > 0) {
      this.colliderPosesSyncedThisPass = true
    }
  }

  /** Stable hash of all physics collider geometry + poses — skips redundant PhysX cooks. */
  getPhysicsColliderBatchFingerprint(): string {
    const mesh = this.collision?.getPhysicsBatchFingerprint() ?? ''
    const gltf = this.gltfColliders?.getPhysicsBatchFingerprint() ?? ''
    return `${mesh}::${gltf}`
  }

  /**
   * Tween / billboard / animator mixer — runs on the sync frame (before render).
   * Must not be gated on async frame backlog; Genesis blimp and other tweens freeze otherwise.
   */
  dumpMotionFocusNow(): void {
    if (!this.running) return
    const nodes = this.bridge?.getEntityNodes()
    dumpMotionFocusReport(this.readComponents, this.view, {
      hasSceneNode: (entity) => nodes?.has(entity) ?? false
    })
  }

  inspectEntity(entity: Entity): void {
    const { GltfContainer, Transform, Tween, Animator, TweenSequence } = this.readComponents
    const nodes = this.bridge?.getEntityNodes()
    const src = GltfContainer.has(entity) ? GltfContainer.get(entity).src : '(none)'
    const parent = Transform.has(entity) ? Transform.get(entity).parent : 0
    const tween = Tween.has(entity) ? Tween.get(entity).mode?.$case : '-'
    const anim = Animator.has(entity) ? (Animator.get(entity).states ?? []).map((s) => s.clip).join(',') : '-'
    const seq = TweenSequence.has(entity) ? 'yes' : 'no'
    const node = nodes?.has(entity) ? 'yes' : 'no'
    const line = `entity ${entity} · ${src} · parent ${parent} · node ${node} · tween ${tween} · animator [${anim}] · TweenSequence ${seq}`
    clientDebugLog.log('motion', line)
  }

  private maybeDumpMotionFocus(): void {
    if (!isMotionFocusActive() || this.motionFocusDumped || !this.running) return
    this.motionFocusDumpTicks++
    if (this.motionFocusDumpTicks < 180) return
    this.motionFocusDumped = true
    this.dumpMotionFocusNow()
  }

  /**
   * @param opts.skipAvatarAttach — primary player path runs attach **after** `player.update`
   *   + PE CRDT sync so hand bones / fishing rod sample this frame’s mixer (not last frame).
   */
  pumpMotionBridges(
    delta: number,
    tickNumber = 0,
    opts?: { skipAvatarAttach?: boolean }
  ): void {
    if (!this.running || !this.bridge) return
    this.maybeDumpMotionFocus()
    // Fresh animated set each frame — systems re-mark if they moved colliders.
    this.systemPartColliders.clear()
    this.systemTransformDirty.clear()
    this.physMotionSnapshot = null
    // Phase C: always sync to pick up new Tween signatures; update only when live.
    this.tweenBridge?.sync(this.view)
    if (this.tweenBridge?.hasLiveTweens()) {
      this.tweenBridge.update(delta, this.view)
      this.markTweenColliderPosesDirty()
      this.sceneGraphMatrixDirty = true
    }
    if (this.bridgeSyncTick % 2 === 0) {
      this.videoPlayerBridge?.sync(this.view)
      this.audioSourceBridge?.sync(this.view)
    }
    if (this.bridgeSyncTick % 4 === 0) {
      this.audioStreamBridge?.sync(this.view)
      this.assetLoadBridge?.sync(this.view)
      this.nftShapeBridge?.sync(this.view)
    }
    this.nftShapeBridge?.update()
    this.avatarShapes?.update(delta)
    // ?noanim — skip mixer sample (clips frozen; default auto-play never advances).
    if (!skipSceneAnimators()) {
      this.animatorBridge?.update(delta, this.view, this.animatorSampleContext())
    }
    // Primary scene stays fully live. 48/80 m is AOI neighbor shells only —
    // hiding plaza Gltfs (theatre, stage) was a residency bug, not a host-world win.
    if (!this.restoredGltfCull) {
      this.restoredGltfCull = true
      this.bridge.restoreGltfDistanceCull()
    }
    this.particleBridge?.update(delta)
    // Particles need create/sync even when Animator/Gltf is quiet — don't wait for 12-frame cadence only.
    // sync is async (texture load); throttle so we don't pile concurrent creates.
    if (this.bridgeSyncTick % 8 === 0) {
      void this.particleBridge?.sync(this.view)
    }
    if (!opts?.skipAvatarAttach) {
      this.pumpAvatarAttach()
    }
    // PlayerEntity-parented scene meshes (Dead Surge path arrow) — re-parent each frame.
    this.bridge.syncReservedParentedTransforms(this.view)
    const billed = this.entityStore?.getBillboardEntities() ?? []
    if (billed.length) {
      this.billboardBridge?.sync(this.view)
      this.billboardBridge?.update()
      this.sceneGraphMatrixDirty = true
    }
    this.markMotionEmitterColliderDirty()
    this.deliverTweenStateToWorker()
    this.videoPlayerBridge?.update(tickNumber, this.view)
    this.audioSourceBridge?.update(tickNumber, this.view)
    this.audioStreamBridge?.update(tickNumber, this.view)
    // Spectrum after media players are synced/playing — host LWW → worker readIntoView.
    this.audioAnalysisBridge?.update(this.view)
    // VideoEvent / AudioEvent / AssetLoadLoadingState appends — do not wait solely on
    // updateTriggerAreas; scenes listening via onChange need same-frame host CRDT.
    this.flushRendererGrowOnlyAppends()
  }

  /**
   * AvatarAttach bone sample + worker relative Transform batch.
   * Call after local avatar locomotion/emote mixer has advanced this frame and
   * PlayerEntity CRDT pose is current — otherwise rod/line lag one frame (painful at low FPS).
   */
  pumpAvatarAttach(): void {
    if (!this.running || !this.bridge || !this.avatarAttachBridge) return
    this.avatarAttachBridge.update(this.view)
    // AvatarAttach → private GLB clone (never GPU instance): rod/held props + Transform children
    // can animate independently while following bones.
    const attachBatch = this.avatarAttachBridge.consumeWorkerBatch()
    if (attachBatch.length) {
      this.bridge.promoteAvatarAttachGltfs(attachBatch.map((e) => e.entity as Entity))
      this.flushAvatarAttachTransformsFromBatch(attachBatch)
    }
  }

  private flushAvatarAttachTransformsFromBatch(
    batch: import('../../bridge/AvatarAttachBridge').AvatarAttachWorkerEntry[]
  ): void {
    if (!batch.length || !this.worker) return
    this.worker.postMessage({ type: 'avatar-attach-transforms', entries: batch } satisfies MainToWorker)
  }

  async syncAsyncBridges(): Promise<void> {
    if (!this.running || !this.bridge) return
    this.bridgeSyncTick++
    if (!this.bridgeDirty && this.bridgeSyncTick % this.bridgeSyncEvery !== 0) return
    this.bridgeDirty = false
    const t0 = performance.now()
    const BRIDGE_BUDGET_MS = 8
    await this.avatarShapes?.sync(this.view)
    this.avatarEmoteBridge?.sync(this.view)
    // ?noanim — skip bind + sample so no GLTF clips start or advance.
    if (!skipSceneAnimators()) {
      await this.animatorBridge?.sync(this.view)
      // Same async frame as Animator open/close apply — sample mixers so doors aren't one frame late.
      // delta=0: no frustum cull (pose apply only).
      this.animatorBridge?.update(0, this.view)
    }
    // Particles are not the beauty pass — skip create/diag when the bridge pie is already spent.
    if (performance.now() - t0 < BRIDGE_BUDGET_MS) {
      await this.particleBridge?.sync(this.view)
    }
  }

  private readonly animatorSamplePlayerWorld = new THREE.Vector3()

  /**
   * Camera for frustum + near-camera full-rate (world space).
   * Player ECS pose is scene-local — near tests use camera.matrixWorld, not PE feet.
   */
  private animatorSampleContext(): import('../../bridge/AnimatorBridge').AnimatorSampleContext | undefined {
    const camera = this.host?.camera
    if (!camera) return undefined
    this.animatorSamplePlayerWorld.setFromMatrixPosition(camera.matrixWorld)
    return { camera, playerWorld: this.animatorSamplePlayerWorld }
  }

  /**
   * After async Animator sync: refresh multi-shape locals for PART movers.
   * World calls this so doors kinematic-pose the same frame the clip starts.
   */
  refreshAnimatorColliderPosesNow(): Set<Entity> {
    const { animatorPart } = this.getPhysMotionSets()
    if (animatorPart.size) {
      this.refreshColliderDescPoses([...animatorPart], animatorPart)
    }
    return animatorPart
  }

  /** Phase-slice sample counters for top-right AnimatorSampleHud. */
  /**
   * Multi-scene tertiary LOD — pause all Animator mixers (no sample cost).
   * Secondary/primary resume clears this.
   */
  setAnimatorsAllSleeping(sleeping: boolean): void {
    this.animatorBridge?.setAllSleeping(sleeping)
  }

  getAnimatorSampleStats(): import('../../bridge/AnimatorBridge').AnimatorSampleStats | null {
    return this.animatorBridge?.getSampleStats() ?? null
  }

  /** @deprecated Prefer pumpMotionBridges + syncAsyncBridges */
  async syncBridges(delta: number): Promise<void> {
    this.pumpMotionBridges(delta)
    await this.syncAsyncBridges()
  }

  /** Sync-frame sprite UV only — tiny tracked set, not a full MeshRenderer walk. */
  syncAnimatedSprites(): void {
    this.bridge?.syncAnimatedPlaneUvs()
  }

  /** Budgeted material texture retries on the render thread — not tied to projection diff drain. */
  tickDeferredMaterials(): void {
    this.bridge?.tickDeferredMaterials()
  }

  async update(delta: number): Promise<void> {
    await this.syncRenderer()
    this.syncCollision()
    await this.syncBridges(delta)
  }

  getHydrationStats() {
    if (!this.bridge) return null
    return this.bridge.getHydrationStats(this.view)
  }

  /** G2 — MeshRenderer GPU instancing live density. */
  getMeshRendererInstanceStats(): { instances: number; buckets: number } | null {
    return this.bridge?.getMeshRendererInstanceStats() ?? null
  }

  /** Cheap mesh-queue counters for fps diagnostics (no full projection walk). */
  getAttachProgressLite(): { attached: number; pendingMesh: number; sceneTris: number } | null {
    return this.bridge?.getAttachProgressLite() ?? null
  }

  setAssetHydrationMode(enabled: boolean): void {
    this.bridge?.setAssetHydrationMode(enabled)
  }

  extendSoftHydration(durationMs: number): void {
    this.bridge?.extendSoftHydration(durationMs)
  }

  dispose(): void {
    // Next scene load re-arms hold via World.prepare; clear release hook so stale ready cannot open early.
    this.sceneBinaryIngressRelease = null
    resetBlimpPivotCache()
    this.motionFocusDumped = false
    this.motionFocusDumpTicks = 0
    this.mainCrdtRawBytes = null
    this.avatarShapes?.dispose()
    this.bridge?.dispose()
    this.bridge = null
    this.entityStore?.dispose()
    this.entityStore = null
    this.entityStoreUnsub?.()
    this.entityStoreUnsub = null
    this.avatarShapes = null
    this.avatarEmoteBridge = null
    this.billboardBridge = null
    this.virtualCameraBridge = null
    this.virtualCameraPlayerPose = null
    this.virtualCameraCameraPose = null
    this.animatorBridge = null
    this.tweenBridge = null
    this.particleBridge?.dispose()
    this.particleBridge = null
    this.unbindSceneUiViewportSync()
    this.sceneUiBridge?.dispose()
    this.sceneUiBridge = null
    this.sceneUiDesiredVisible = false
    this.focusPolicy = 'primary'
    this.pendingVirtualCanvas = null
    this.pendingUiEntities = undefined
    this.pendingInboundAfterUiMount = []
    this.pointerHoldTicksUntilMount = false
    this.pointerOutboundDeferBuffer = []
    this.pointerFlushCoalesceRequested = false
    this.projectionLagPendingUi = false
    this.projectionLagSinceMs = 0
    this.projectionLagLoggedAt = 0
    this.lastAppliedUiMountContentFp = ''
    this.lastOutboundUiEntitiesKey = ''
    this.nftShapeBridge?.dispose()
    this.nftShapeBridge = null
    this.avatarAttachBridge?.dispose()
    this.avatarAttachBridge = null
    this.videoPlayerBridge = null
    this.audioSourceBridge?.dispose()
    this.audioSourceBridge = null
    this.audioStreamBridge?.dispose()
    this.audioStreamBridge = null
    this.audioAnalysisBridge?.dispose()
    this.audioAnalysisBridge = null
    this.assetLoadBridge?.dispose()
    this.assetLoadBridge = null
    this.collision?.dispose()
    this.collision = null
    this.gltfColliders?.dispose()
    this.gltfColliders = null
    this.pointerEvents?.dispose()
    this.pointerEvents = null
    this.sceneInputRelay?.dispose()
    this.sceneInputRelay = null
    this.inputHub = null
    this.triggerAreas?.dispose()
    this.triggerAreas = null
    this.cameraModeAreas?.dispose()
    this.cameraModeAreas = null
    this.avatarModifiers?.dispose()
    this.avatarModifiers = null
    this.mapPins?.dispose()
    this.mapPins = null
    this.avatarModifierProviders = null
    this.setForcedCameraMode = null
    this.raycasts?.dispose()
    this.raycasts = null
    this.engineApiEvents.dispose()
    this.clearPointerDeliverWatchdog()
    this.worker?.terminate()
    this.worker = null
    this.host = null
    this.running = false
    this.prepared = false
  }
}

function emptyEntityPose(): EntityPose {
  return {
    position: new THREE.Vector3(),
    rotation: new THREE.Quaternion()
  }
}
