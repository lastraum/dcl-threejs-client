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
import { CrdtProjection, type ProjectionChangeKind } from '../../bridge/CrdtProjection'
import { CrdtEncoder } from '../../bridge/CrdtEncoder'
import { ReservedEntitiesSync, type EntityPose } from '../../bridge/ReservedEntitiesSync'
import { ThreeBridge } from '../../bridge/ThreeBridge'
import { applySceneDiff } from '../../bridge/entityStoreApply'
import { AvatarShapeBridge } from '../../bridge/AvatarShapeBridge'
import { AvatarEmoteCommandBridge, type AvatarEmoteHandler } from '../../bridge/AvatarEmoteCommandBridge'
import { BillboardBridge } from '../../bridge/BillboardBridge'
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
import type { SpatialAudioAnchors } from '../../media/spatialAudioParent'
import { VideoPlayerBridge } from '../../media/VideoPlayerBridge'
import type { LiveKitVideoBinder } from '../../media/WebVideoPlayer'
import { CollisionSystem } from '../../collision/CollisionSystem'
import {
  GLTF_COLLIDER_ENTITY_BASE,
  LANDSCAPE_COLLIDER_ENTITY_BASE,
  gltfPhysicsEntityId
} from '../../collision/GltfColliderExtractor'
import type { PhysicsColliderDesc } from '../../physics/PhysXWorld'
import { platformMotionDebug } from '../../debug/PlatformMotionDebug'
import { GltfColliderExtractor } from '../../collision/GltfColliderExtractor'
import type {
  CommsRpcHandler,
  MainToWorker,
  PerformanceTier,
  SceneWorkerBoot,
  SceneWorkerOutbound,
  SignedFetchHandler,
  SignedFetchGetHeadersHandler
} from '../../shim/types'
import type { MovePlayerToRequest, MovePlayerToResponse } from '../../player/movePlayerTo'
import type { OpenExternalUrlRequest, OpenExternalUrlResponse } from '../../player/openExternalUrl'
import type { TriggerEmoteRequest, TriggerEmoteResponse } from '../../player/triggerEmote'
import type { TriggerSceneEmoteRequest, TriggerSceneEmoteResponse } from '../../player/triggerSceneEmote'
import type { AssetCache } from '../../rendering/AssetCache'
import type { SceneHost } from '../../rendering/SceneHost'
import type { PlayerMirrorIdentity } from '../../bridge/playerMirrorIdentity'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import { skipTheatreSceneScript, useOneWayCrdt } from '../../client/devFlags'
import { PointerEventsSystem } from '../../input/PointerEventsSystem'
import { TriggerAreaSystem } from '../../input/TriggerAreaSystem'
import { isTriggerAreaVerbose } from '../../input/triggerAreaConfig'
import { RaycastSystem } from '../../input/RaycastSystem'
import { isRaycastVerbose } from '../../input/raycastConfig'
import type { PhysXWorld } from '../../physics/PhysXWorld'
import { EngineApiEventBridge } from './EngineApiEventBridge'

type MovePlayerHandler = (request: MovePlayerToRequest) => boolean
type TriggerEmoteHandler = (request: TriggerEmoteRequest) => boolean
type TriggerSceneEmoteHandler = (request: TriggerSceneEmoteRequest) => boolean
type OpenExternalUrlHandler = (request: OpenExternalUrlRequest) => boolean

/** Async bridge ECS sync (Animator / AvatarShape load paths) — playback still runs every sync frame. */
const BRIDGE_ECS_SYNC_RUNTIME = 12

/** Extra pointer round-trip diagnostics (`?pointerverbose`). */
const POINTER_VERBOSE = ((): boolean => {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).has('pointerverbose')
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
    new Set<Entity>([SDK_RESERVED.root, SDK_RESERVED.player, SDK_RESERVED.camera])
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
  private projectionDiffActive = false
  /** Phase 3: encoder is the primary source for renderer-owned outbound CRDT (reserved, tween, pointer/video results). Always on. */
  private readonly encoder = new CrdtEncoder(SDK_RESERVED, this.projection, this.componentHost.components)
  /**
   * Source-capture sink: renderer grow-only writers (pointer results, video events) call
   * this at their exact `addValue` site so the outbound encoder reproduces each APPEND
   * byte-exactly.
   */
  private readonly recordRendererAppend = (componentId: number, entity: Entity, value: unknown): void => {
    this.encoder.recordAppend(componentId, entity, value)
  }
  private readonly recordRendererLww = (componentId: number, entity: Entity, value: unknown): void => {
    this.encoder.recordLww(componentId, entity, value)
  }
  private encoderEnabledLogged = false
  private oneWayCrdtLogged = false
  /** Phase C — serializes async outbound apply + inbound deliver. */
  private crdtOutboundSerial: Promise<void> = Promise.resolve()
  /** Phase C slice 2 — coalesce worker outbounds per microtask before one encode/deliver. */
  private crdtOutboundPending: Uint8Array[] = []
  private crdtOutboundFlushQueued = false
  readonly reserved = new ReservedEntitiesSync(this.projection, this.readComponents, SDK_RESERVED)
  collision: CollisionSystem | null = null
  gltfColliders: GltfColliderExtractor | null = null
  pointerEvents: PointerEventsSystem | null = null
  triggerAreas: TriggerAreaSystem | null = null
  raycasts: RaycastSystem | null = null
  readonly engineApiEvents = new EngineApiEventBridge()
  private bridge: ThreeBridge | null = null
  /** Phase 4 — unified scene-graph entity store (Three.js groups keyed by ECS entity). */
  private entityStore: EntityStore | null = null
  private entityStoreUnsub: (() => void) | null = null
  private avatarShapes: AvatarShapeBridge | null = null
  private avatarEmoteBridge: AvatarEmoteCommandBridge | null = null
  private billboardBridge: BillboardBridge | null = null
  private animatorBridge: AnimatorBridge | null = null
  private tweenBridge: TweenBridge | null = null
  private particleBridge: ParticleSystemBridge | null = null
  private avatarAttachBridge: AvatarAttachBridge | null = null
  private videoPlayerBridge: VideoPlayerBridge | null = null
  private audioSourceBridge: AudioSourceBridge | null = null
  private audioStreamBridge: AudioStreamBridge | null = null
  private host: SceneHost | null = null
  private worker: Worker | null = null
  private running = false
  private prepared = false
  private crdtTick = 0
  private clientPlayerPose: EntityPose | null = null
  private clientCameraPose: EntityPose | null = null
  /** Live player/camera poses sampled immediately before CRDT encode (rotation must not lag). */
  private clientPoseProvider: (() => { player: EntityPose; camera: EntityPose }) | null = null
  private getSpatialAudioPlayerRoot: (() => THREE.Object3D | null) | null = null
  private bindLiveKitVideo: LiveKitVideoBinder | null = null
  private movePlayerHandler: MovePlayerHandler | null = null
  private triggerEmoteHandler: TriggerEmoteHandler | null = null
  private triggerSceneEmoteHandler: TriggerSceneEmoteHandler | null = null
  private openExternalUrlHandler: OpenExternalUrlHandler | null = null
  private commsHandler: CommsRpcHandler | null = null
  /** World — enqueue/drain per-entity PhysX cooks (`entity` = GLB just attached; omit = drain queue). */
  private collidersCookCallback: ((entity?: Entity) => void) | null = null
  private collidersPoseCallback: ((entities: Entity[]) => void) | null = null
  /** Hydration / force-recook — full GltfContainer + MeshCollider walk. */
  private colliderFullWalkRequested = true
  /** EntityStore onChange — MeshCollider / GltfContainer structure or mask changes. */
  private readonly colliderStructureDirty = new Set<Entity>()
  /** EntityStore onChange — Transform on collider-bearing entities (pose only). */
  private readonly colliderPoseDirty = new Set<Entity>()
  private readonly lastTweenMotionEntities = new Set<Entity>()
  private readonly lastSyncFrameTransformEntities = new Set<Entity>()
  private readonly lastPoseChangedEntities: Entity[] = []
  private platformMotionReportDumped = false
  private sceneBaseParcel: string | null = null
  /** True when syncCollision already pushed incremental pose slides this async pass. */
  private colliderPosesSyncedThisPass = false
  /** Transform parent → direct children — subtree walks for pose dirty propagation. */
  private readonly transformChildren = new Map<Entity, Set<Entity>>()
  private readonly transformParent = new Map<Entity, Entity>()
  /** ECS entities that own MeshCollider / GltfContainer physics roots. */
  private readonly colliderRootEntities = new Set<Entity>()

  private pointerStructureDirty = false
  private triggerStructureDirty = false
  private bridgeDirty = true
  private bridgeSyncTick = 0
  private bridgeSyncEvery = BRIDGE_ECS_SYNC_RUNTIME
  private signedFetchHandler: SignedFetchHandler | null = null
  private signedFetchGetHeadersHandler: SignedFetchGetHeadersHandler | null = null
  /** Pointer append bytes captured at flush, sent via pointer-crdt-deliver. */
  private readonly pointerResponseStash: Uint8Array[] = []
  /** Prevents overlapping flush encodes while mirror flushOutgoing is awaited. */
  private pointerFlushInFlight = false
  private motionFocusDumped = false
  private motionFocusDumpTicks = 0
  /** Serializes crdt-send round-trips so mirror/encoder/stash cannot race. */
  private crdtSendSerial: Promise<void> = Promise.resolve()
  private bootCrdtSendSerial: Promise<void> = Promise.resolve()
  /** True from worker boot until `ready` — keeps fast CRDT path during onStart after eval-done. */
  private bootPhaseActive = false
  private bootProgressReporter: ((msg: string) => void) | null = null
  private scriptBlobUrl: string | null = null
  private compileProgressTimer: ReturnType<typeof setInterval> | null = null
  /** Set when pointer-crdt-deliver is posted; cleared on pointer-deliver-done from worker. */
  private pointerDeliverAwaitingAck = false
  private pointerDeliverWatchdog: ReturnType<typeof setTimeout> | null = null
  private pointerDeliverFailWatchdog: ReturnType<typeof setTimeout> | null = null
  /** Click flush pending — cleared on pointer-deliver-done. */
  private pointerAwaitingWorkerApply = false
  /** True after one watchdog retry — avoids infinite inject loops. */
  private pointerDeliverRetried = false
  /** Plant watering / onUpdate can exceed 800ms — extend wait; never re-post CRDT (double-deliver). */
  private static readonly POINTER_DELIVER_STALL_MS = 800
  private static readonly POINTER_DELIVER_FAIL_MS = 2_500
  private static readonly POINTER_DELIVER_FAIL_EXTENDED_MS = 4_500

  private logPointer(...parts: unknown[]): void {
    if (POINTER_VERBOSE) console.log('[pointer]', ...parts)
  }

  /** Phase 4 — unified entity store (scene graph + avatar peers). */
  getEntityStore(): EntityStore | null {
    return this.entityStore
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
  prepare(scene: ResolvedScene, cache: AssetCache, host: SceneHost): void {
    if (!scene.mainEntry || !scene.entityId) return

    this.sceneBaseParcel = scene.baseParcel
    this.platformMotionReportDumped = false
    this.reserved.initialize(scene.spawn)
    this.host = host
    this.entityStore = new EntityStore(host.scene, 'scene-entities')
    this.entityStoreUnsub = this.entityStore.subscribe((change) => this.onEntityStoreChange(change))
    this.bridge = new ThreeBridge(scene, cache, this.entityStore, this.readComponents)
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
    this.animatorBridge = new AnimatorBridge(
      this.readComponents,
      cache,
      scene,
      () => this.bridge?.getEntityNodes()
    )
    this.tweenBridge = new TweenBridge(this.readComponents, this.entityStore)
    this.particleBridge = new ParticleSystemBridge(
      this.readComponents,
      cache,
      scene,
      () => this.bridge?.getEntityNodes()
    )
    this.bridge.setAvatarTextureResolver(async (userId) => {
      const url = await fetchProfileFaceUrl(userId)
      if (!url) return null
      return cache.loadTexture(url).catch(() => null)
    })
    this.avatarAttachBridge = new AvatarAttachBridge(
      this.readComponents,
      this.projection,
      () => this.bridge?.getEntityNodes()
    )
    this.bridge.setSkipTransformApply((entity) => this.avatarAttachBridge!.isAttachDriven(entity))
    this.videoPlayerBridge = new VideoPlayerBridge(
      this.readComponents,
      scene,
      () => this.bridge!.getEntityNodes(),
      () => this.getSpatialAudioAnchors(),
      () => this.bindLiveKitVideo,
      this.recordRendererAppend,
      this.recordRendererLww
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
    this.collision = new CollisionSystem(host.scene)
    this.gltfColliders = new GltfColliderExtractor(host.scene)
    this.animatorBridge.setShapeMotionProbe((entity) => {
      const nodes = this.bridge?.getEntityNodes()
      if (!nodes || !this.gltfColliders) return false
      return this.gltfColliders.probeColliderMeshMotion(entity, nodes)
    })
    this.pointerEvents = new PointerEventsSystem(host.renderer.domElement)
    this.triggerAreas = new TriggerAreaSystem()
    this.raycasts = new RaycastSystem()
    this.avatarShapes.setAssetCache(cache, scene.realm.contentUrl)
    this.bridge.setOnGltfAttached((entity) => this.flushIncrementalColliders(entity))
    this.prepared = true
  }

  /** Called by World — per-entity enqueue or queue drain while GLBs attach. */
  setCollidersCookCallback(callback: ((entity?: Entity) => void) | null): void {
    this.collidersCookCallback = callback
  }

  /** Called by World — slide PhysX actor poses after colliderPoseDirty (no cook). */
  setCollidersPoseCallback(callback: ((entities: Entity[]) => void) | null): void {
    this.collidersPoseCallback = callback
  }

  /** External systems (tweens, scripts) can mark movers without ECS Transform writes. */
  markColliderPoseDirty(entity: Entity): void {
    this.colliderPoseDirty.add(entity)
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
   * Motion sources that may move this frame — O(active tweens/animators/billboards + ground),
   * not O(all colliders).
   */
  collectMotionSnapshotCandidates(groundEcs: Entity | null): Set<Entity> {
    const out = new Set<Entity>()
    const { MeshCollider, GltfContainer } = this.readComponents

    if (groundEcs !== null && this.gltfColliders?.hasExtractedCollider(groundEcs)) {
      out.add(groundEcs)
    }

    for (const entity of this.tweenBridge?.getActiveTweenEntities() ?? []) {
      if (MeshCollider.has(entity) || GltfContainer.has(entity)) out.add(entity)
    }

    for (const entity of this.animatorBridge?.getActiveEntities() ?? []) {
      if (
        GltfContainer.has(entity) &&
        this.gltfColliders?.hasExtractedCollider(entity) &&
        this.isAnimatedGltfCollider(entity)
      ) {
        out.add(entity)
      }
    }

    for (const entity of this.entityStore?.getBillboardEntities() ?? []) {
      if (MeshCollider.has(entity) || GltfContainer.has(entity)) out.add(entity)
    }

    for (const entity of this.lastSyncFrameTransformEntities) {
      if (MeshCollider.has(entity) || GltfContainer.has(entity)) out.add(entity)
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
    const out = new Set<Entity>()
    for (const entity of this.lastTweenMotionEntities) out.add(entity)
    for (const entity of this.billboardBridge?.consumeMotionEntities() ?? []) out.add(entity)
    for (const entity of this.animatorBridge?.consumeShapeMotionEntities() ?? []) out.add(entity)
    for (const entity of this.lastSyncFrameTransformEntities) out.add(entity)
    for (const entity of this.lastPoseChangedEntities) out.add(entity)
    return out
  }

  /** Animator shape motion + grounded animated platform (post-bridge). */
  getFrameShapeMotionEntities(groundEcs: Entity | null): Set<Entity> {
    const out = new Set<Entity>(this.animatorBridge?.pendingShapeMotionEntities() ?? [])
    if (groundEcs !== null && this.isAnimatedGltfColliderEntity(groundEcs)) out.add(groundEcs)
    return out
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
    if (standPhysEntity !== null && standPhysEntity !== undefined && standPhysEntity >= GLTF_COLLIDER_ENTITY_BASE) {
      const ecs = (standPhysEntity - GLTF_COLLIDER_ENTITY_BASE) as Entity
      priority.push(ecs)
      entities.add(ecs)
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

  private isAnimatedGltfCollider(entity: Entity): boolean {
    return this.isAnimatedGltfColliderEntity(entity)
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

  private lastStandSurfacePhys: number | null = null

  /**
   * Riding + PhysX bounds scope — CCT-grounded scene actor wins; animated tread hints apply
   * only before CCT registers scene geometry (infinite plane / airborne).
   */
  resolveStandSurfacePhysEntity(
    feet: THREE.Vector3 | undefined,
    groundPhysEntity: number | null
  ): number | null {
    const INFINITE_GROUND = -1
    const hasSceneGround =
      groundPhysEntity !== null && groundPhysEntity !== INFINITE_GROUND

    if (hasSceneGround) {
      this.lastStandSurfacePhys = groundPhysEntity
      return groundPhysEntity
    }

    const nodes = this.bridge?.getEntityNodes()
    let animatedPhys: number | null = null
    if (feet && nodes && this.gltfColliders) {
      const under = this.gltfColliders.findAnimatedStandSurfaceAmong(
        nodes,
        feet,
        this.animatorBridge?.getActiveEntities() ?? [],
        (entity) => this.isAnimatedGltfCollider(entity)
      )
      if (under !== null) animatedPhys = GLTF_COLLIDER_ENTITY_BASE + under
    }

    if (animatedPhys === null && feet && nodes && this.lastStandSurfacePhys !== null) {
      const ecs = this.standSurfaceEcsFromPhys(this.lastStandSurfacePhys)
      if (
        ecs !== null &&
        this.gltfColliders?.hasAnimatedStandContact(ecs, nodes, feet)
      ) {
        animatedPhys = this.lastStandSurfacePhys
      }
    }

    if (animatedPhys === null && feet && nodes && this.gltfColliders) {
      const staticUnder = this.gltfColliders.findStaticStandSurfaceNearFeet(nodes, feet)
      if (staticUnder !== null) animatedPhys = GLTF_COLLIDER_ENTITY_BASE + staticUnder
    }

    this.lastStandSurfacePhys = animatedPhys
    return animatedPhys
  }

  standSurfaceEcsFromPhys(physEntity: number | null): Entity | null {
    if (physEntity === null || physEntity < GLTF_COLLIDER_ENTITY_BASE) return null
    return (physEntity - GLTF_COLLIDER_ENTITY_BASE) as Entity
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

  /** Propagate ECS transforms → matrixWorld on the full scene entity graph before collider extract. */
  flushSceneGraphMatrices(): void {
    this.entityStore?.root.updateMatrixWorld(true)
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
        if (this.colliderRootEntities.has(change.entity)) {
          this.removeColliderForEntity(change.entity)
        }
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
      if (componentId === MeshCollider.componentId || componentId === GltfContainer.componentId) {
        this.colliderStructureDirty.add(entity)
      }
      return
    }

    if (componentId === MeshCollider.componentId || componentId === GltfContainer.componentId) {
      this.colliderStructureDirty.add(entity)
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

    if (
      componentId === TriggerArea.componentId ||
      componentId === GltfContainer.componentId ||
      (componentId === Transform.componentId && TriggerArea.has(entity))
    ) {
      this.triggerStructureDirty = true
    }

    if (
      componentId === GltfContainer.componentId ||
      componentId === Animator.componentId ||
      componentId === AvatarShape.componentId ||
      (componentId === Transform.componentId &&
        (Animator.has(entity) || AvatarShape.has(entity) || GltfContainer.has(entity)))
    ) {
      this.bridgeDirty = true
    }
  }

  /** Re-extract colliders for one entity that just received a GLTF mesh, then enqueue PhysX cook. */
  flushIncrementalColliders(entity: Entity): void {
    this.colliderStructureDirty.add(entity)
    this.pointerStructureDirty = true
    // Hydration batches collider extract on the loading tick — per-attach sync blocked attach bursts.
    if (this.bridge?.isAssetHydrationMode()) return
    this.syncCollision()
    this.flushPointerStructureIfDirty()
    this.collidersCookCallback?.(entity)
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
    this.colliderStructureDirty.delete(entity)
    this.colliderPoseDirty.delete(entity)
    this.colliderRootEntities.delete(entity)
    const removedMesh = this.collision?.removeColliderEntity(entity) ?? false
    const removedGltf = this.gltfColliders?.removeColliderEntity(entity) ?? false
    if (!removedMesh && !removedGltf) return
    if (removedMesh) this.collision?.finalizeColliderSync()
    if (removedGltf) this.gltfColliders?.finalizeColliderSync()
  }

  setMovePlayerHandler(handler: MovePlayerHandler | null): void {
    this.movePlayerHandler = handler
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

  /** Player capsule root for spatial audio on PlayerEntity — call after initCapsule. */
  setSpatialAudioPlayerRoot(getter: (() => THREE.Object3D | null) | null): void {
    this.getSpatialAudioPlayerRoot = getter
  }

  /** LiveKit scene cast binder for `livekit-video://current-stream` VideoPlayer.src. */
  setLiveKitVideoBinder(binder: LiveKitVideoBinder | null): void {
    this.bindLiveKitVideo = binder
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

  /** Sample latest player/camera right before outbound CRDT (avoids stale rotation between sync frames). */
  setClientPoseProvider(provider: (() => { player: EntityPose; camera: EntityPose }) | null): void {
    this.clientPoseProvider = provider
  }

  /** Push player/camera into the mirror before the worker calls crdtGetState at boot. */
  seedRendererEntities(player: EntityPose, camera: EntityPose): void {
    this.clientPlayerPose = player
    this.clientCameraPose = camera
    this.reserved.prepareRendererRoundTrip(player, camera)
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
    console.info('[scene] loading scene script and boot files…')
    const [, preloadedFiles, bootSnapshot] = await Promise.all([
      fetch(scriptUrl).then(async (res) => {
        if (!res.ok) throw new Error(`Scene script fetch failed (${res.status}): ${scriptUrl}`)
        const code = await res.text()
        this.revokeScriptBlobUrl()
        this.scriptBlobUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
        console.info(
          `[scene] scene script ready (${(code.length / 1024).toFixed(0)} KB, ${((performance.now() - scriptStarted) / 1000).toFixed(1)}s)`
        )
      }),
      this.preloadSceneBootFiles(scene),
      this.seedProjectionFromMainCrdt(scene).then(() => this.buildBootCrdtSnapshot())
    ])

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
    const bootCrdtData = bootSnapshot.data.map((chunk) => chunk.slice())

    const boot: SceneWorkerBoot = {
      type: 'boot',
      debug: {
        pointerDeliver: POINTER_VERBOSE,
        tweenDeliver: isTweenVerbose(),
        skipTheatre: skipTheatreSceneScript(),
        oneWayCrdt: useOneWayCrdt()
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

    const BOOT_TIMEOUT_MS = 120_000
    this.bootCrdtSendSerial = Promise.resolve()
    this.bootPhaseActive = true
    await new Promise<void>((resolve, reject) => {
      if (!this.worker) return reject(new Error('Worker missing'))

      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(bootTimer)
        this.clearCompileProgressTimer()
        this.revokeScriptBlobUrl()
        fn()
      }

      const bootTimer = window.setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              'Scene worker bundle compile timed out (120s) — check console for [sceneWorker] compile / onStart logs; hard-refresh if the worker bundle is stale'
            )
          )
        )
      }, BOOT_TIMEOUT_MS)

      this.engineApiEvents.bind((events) => {
        this.worker?.postMessage({ type: 'engine-api-enqueue', events } satisfies MainToWorker)
      })

      this.worker.onmessage = (ev: MessageEvent<SceneWorkerOutbound>) => {
        const msg = ev.data
        if (msg?.type === 'pointer-deliver-done') {
          this.onPointerDeliverDone()
          return
        }
        if (msg?.type === 'crdt-get-state') {
          this.respondCrdtGetState(msg.id)
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
        void this.handleWorkerMessage(msg, () => finish(resolve), (err) => finish(() => reject(err)))
      }
      this.worker.onerror = (err) => finish(() => reject(err instanceof ErrorEvent ? err : new Error('Scene worker error')))

      this.startCompileProgressTimer()
      this.bootProgressReporter?.('Compiling scene script… (0s)')
      // Yield so the loading screen can paint before the (still non-trivial) boot postMessage clone.
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
      clientDebugLog.log('scene', 'Scene worker ready (main thread)', { level: 'success' })
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
      clientDebugLog.log('scene', msg.message, { alsoConsole: true })
      return
    }
    if (msg.type === 'pointer-deliver-done') {
      this.onPointerDeliverDone()
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
      const success = this.movePlayerHandler?.(msg.body) ?? false
      this.worker?.postMessage({
        type: 'move-player-to-response',
        id: msg.id,
        body: { success } satisfies MovePlayerToResponse
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
      const success = this.openExternalUrlHandler?.(msg.body) ?? false
      this.worker?.postMessage({
        type: 'open-external-url-response',
        id: msg.id,
        body: { success } satisfies OpenExternalUrlResponse
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
    if (msg.type === 'crdt-outbound') {
      this.enqueueCrdtOutbound(msg.data)
      return
    }
    if (msg.type === 'crdt-send') {
      if (this.bootPhaseActive) {
        await this.handleCrdtSendBootFast(msg)
        return
      }
      const isNudge = !msg.data?.byteLength
      if (isNudge || this.pointerAwaitingWorkerApply) {
        // Priority lane — empty nudge / pointer flush must not queue behind mirror.flushOutgoing.
        await this.handleCrdtSend(msg)
      } else {
        await (this.crdtSendSerial = this.crdtSendSerial
          .then(() => this.handleCrdtSend(msg))
          .catch((err) => {
            console.error(
              '[scene]',
              `crdt-send handler failed — ${err instanceof Error ? err.message : String(err)}`
            )
          }))
      }
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

  private enqueueCrdtOutbound(data: Uint8Array): void {
    this.crdtOutboundPending.push(data)
    if (this.crdtOutboundFlushQueued) return
    this.crdtOutboundFlushQueued = true
    queueMicrotask(() => {
      this.crdtOutboundFlushQueued = false
      const batch = this.crdtOutboundPending
      this.crdtOutboundPending = []
      if (!batch.length) return
      this.crdtOutboundSerial = this.crdtOutboundSerial
        .then(() => this.handleCrdtOutboundBatch(batch))
        .catch((err) => {
          console.error(
            '[scene]',
            `crdt-outbound handler failed — ${err instanceof Error ? err.message : String(err)}`
          )
        })
    })
  }

  /** Phase C — worker outbound without blocking on `crdt-response`; inbound via `renderer-inbound-deliver`. */
  private async handleCrdtOutboundBatch(batch: Uint8Array[]): Promise<void> {
    if (!this.playReadyNotified) return
    const inbound = await this.processWorkerOutboundCrdtBatch(batch)
    // Do not syncRenderer per outbound — plaza engine ticks flood main (~15/s) and
    // each full bridge drain was ~15 FPS. Walkability is kept by round-trip until
    // play-ready + onAsyncFrame syncRenderer / syncPlayerMotionFrame pose slides.
    this.postRendererInboundDeliver(inbound)
    if (!this.oneWayCrdtLogged) {
      this.oneWayCrdtLogged = true
      clientDebugLog.log(
        'projection',
        'one-way CRDT ACTIVE — worker outbound async, inbound via renderer-inbound-deliver',
        { level: 'success', alsoConsole: true }
      )
    }
  }

  private postRendererInboundDeliver(chunks: Uint8Array[]): void {
    if (!chunks.length || !this.worker) return
    const copies = chunks.map((chunk) => chunk.slice())
    const transfer: Transferable[] = []
    for (const chunk of copies) {
      const buffer = chunk.buffer
      if (!transfer.includes(buffer)) transfer.push(buffer)
    }
    this.worker.postMessage({ type: 'renderer-inbound-deliver', data: copies } satisfies MainToWorker, transfer)
  }

  private async processWorkerOutboundCrdtBatch(batch: Uint8Array[]): Promise<Uint8Array[]> {
    const hasPayload = batch.some((data) => data?.byteLength > 0)
    try {
      this.prepareRendererOutboundState()
      for (const data of batch) {
        this.projection.applyIncoming(data)
        this.foldProjectionChanges()
      }

      if (this.pointerAwaitingWorkerApply) {
        this.videoPlayerBridge?.notifyUserPointerDelivered()
        this.videoPlayerBridge?.sync(this.view)
        this.audioSourceBridge?.sync(this.view)
        this.audioStreamBridge?.sync(this.view)
      }

      this.syncPointerInput(this.crdtTick, { processPendingDown: false, processPendingUp: false })
      this.syncTriggerAreas()
      this.syncRaycasts()
      this.syncTweenBeforeEncode()
      this.crdtTick++

      this.prepareRendererOutboundState()
      const encoderBytes = this.encodeRendererCrdt()
      const inbound = encoderBytes ? [encoderBytes] : []

      if (!hasPayload && !inbound.length) return []
      return inbound
    } catch (err) {
      console.error(
        '[scene]',
        `processWorkerOutboundCrdt failed — ${err instanceof Error ? err.message : String(err)}`
      )
      return []
    }
  }

  /** Worker → main CRDT round-trip (serialized to avoid mirror/encoder races). */
  private async handleCrdtSend(msg: Extract<SceneWorkerOutbound, { type: 'crdt-send' }>): Promise<void> {
    const isNudge = !msg.data?.byteLength

    // Empty nudge — respond without awaiting mirror.flushOutgoing (scene ticks must not stall behind it).
    if (isNudge && !this.pointerAwaitingWorkerApply && !this.pointerResponseStash.length) {
      try {
        this.prepareRendererOutboundState()
        this.projection.applyIncoming(msg.data)
        this.foldProjectionChanges()
        this.syncPointerInput(this.crdtTick, { processPendingDown: false, processPendingUp: false })
        this.syncTriggerAreas()
        this.syncRaycasts()
        this.syncTweenBeforeEncode()
        this.crdtTick++
        this.prepareRendererOutboundState()
        const encoderBytes = this.encodeRendererCrdt()
        const data = encoderBytes ? [encoderBytes] : []
        this.worker?.postMessage({ type: 'crdt-response', id: msg.id, data } satisfies MainToWorker)
        return
      } catch (err) {
        console.error(
          '[scene]',
          `nudge fast crdt-response failed — ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    try {
      this.prepareRendererOutboundState()
      this.projection.applyIncoming(msg.data)
      this.foldProjectionChanges()

      if (this.pointerAwaitingWorkerApply) {
        this.videoPlayerBridge?.notifyUserPointerDelivered()
        this.videoPlayerBridge?.sync(this.view)
        this.audioSourceBridge?.sync(this.view)
        this.audioStreamBridge?.sync(this.view)
      }

      // Hover + PrimaryPointerInfo only. PET_DOWN/UP stay queued until click flush → pointer-crdt-deliver.
      this.syncPointerInput(this.crdtTick, { processPendingDown: false, processPendingUp: false })
      this.syncTriggerAreas()
      this.syncRaycasts()
      this.syncTweenBeforeEncode()
      this.crdtTick++

      this.prepareRendererOutboundState()

      const encoderBytes = this.encodeRendererCrdt()
      const data = encoderBytes ? [encoderBytes] : []

      if (!this.encoderEnabledLogged) {
        this.encoderEnabledLogged = true
        clientDebugLog.log('projection', 'encoder ACTIVE — crdt-response driven by CrdtEncoder (projection path)', {
          level: 'success',
          alsoConsole: true
        })
      }
      this.worker?.postMessage({ type: 'crdt-response', id: msg.id, data } satisfies MainToWorker)
    } catch (err) {
      console.error(
        '[scene]',
        `crdt-send failed — replying empty: ${err instanceof Error ? err.message : String(err)}`
      )
      this.worker?.postMessage({ type: 'crdt-response', id: msg.id, data: [] } satisfies MainToWorker)
      throw err
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
   */
  private async seedProjectionFromMainCrdt(scene: ResolvedScene): Promise<void> {
    const entry = scene.content.find((file) => file.file === 'main.crdt')
    if (!entry?.hash) return
    try {
      const res = await fetch(scene.assetUrl(entry.hash))
      if (!res.ok) return
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (!bytes.byteLength) return
      this.projection.applyIncoming(bytes)
      this.foldProjectionChanges()
      const entities = this.projection.sceneEntityCount(this.reservedEntities())
      console.info(
        `[scene] main.crdt seeded projection (${(bytes.byteLength / 1024).toFixed(0)} KB, ${entities} entities)`
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
      console.info(`[scene] preloaded ${keys.length} boot file(s) (${kb.toFixed(0)} KB)`)
    }
    return out
  }

  /** Renderer CRDT snapshot for worker bundle eval (must not round-trip main during sync eval). */
  private buildBootCrdtSnapshot(): { hasEntities: boolean; data: Uint8Array[] } {
    this.prepareRendererOutboundState()
    return this.buildBootstrapSnapshot()
  }

  /** e9: projection + encoder boot snapshot (replaces mirror.getState on the wire). */
  private buildBootstrapSnapshot(): { hasEntities: boolean; data: Uint8Array[] } {
    const reserved = this.reservedEntities()
    const projBuf = this.projection.serializeSnapshot(undefined, reserved).toBinary()
    const reservedBuf = this.encoder.serializeReservedSnapshot().toBinary()
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

  /** Fold the latest projection decode batch into the render-frame diff accumulator. */
  private foldProjectionChanges(): void {
    const { PlayerEntity, CameraEntity, RootEntity } = this.view
    const { TriggerArea, Transform, Billboard, MeshCollider, GltfContainer } = this.readComponents

    for (const change of this.projection.changes) {
      if (change.entity === PlayerEntity || change.entity === CameraEntity || change.entity === RootEntity) {
        continue
      }

      if (
        change.componentId === TriggerArea.componentId ||
        (change.componentId === Transform.componentId && TriggerArea.has(change.entity))
      ) {
        this.triggerStructureDirty = true
      }

      // Post-play-ready only — hydration/composite spawn floods transforms and must not
      // slide or ack world-baked colliders before spawn seal (boot walk/pointer regression).
      if (this.playReadyNotified) {
        if (change.componentId === Transform.componentId && change.kind !== 'delete') {
          if (MeshCollider.has(change.entity) || GltfContainer.has(change.entity)) {
            this.colliderPoseDirty.add(change.entity)
          }
          this.markDescendantColliderPosesDirty(change.entity)
        }

        if (
          change.componentId === GltfContainer.componentId ||
          change.componentId === MeshCollider.componentId
        ) {
          this.colliderStructureDirty.add(change.entity)
          this.pointerStructureDirty = true
        }
      }

      if (change.componentId === Billboard.componentId) {
        this.entityStore?.setBillboard(change.entity, change.kind !== 'delete')
      }

      let comps = this.pendingDiff.get(change.entity)
      if (!comps) {
        comps = new Map()
        this.pendingDiff.set(change.entity, comps)
      }
      comps.set(change.componentId, change.kind)
    }
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

  /** MatrixWorld + collider pose sync immediately before pointer raycast. */
  preparePointerRaycast(): void {
    this.flushSceneGraphMatrices()
    // Full syncCollision runs on the async frame (World.applyPhysicsColliders) — not here.
    // Per-raycast incremental sync during composite spawn corrupted sealed boot colliders.
    this.syncCollisionPoses()
  }

  private flushTriggerStructureIfDirty(): void {
    if (!this.triggerStructureDirty) return
    this.triggerStructureDirty = false
    this.triggerAreas?.invalidateCache()
  }

  setVideoUserGestureUnlocked(unlocked: boolean): void {
    this.videoPlayerBridge?.setUserGestureUnlocked(unlocked)
    this.audioSourceBridge?.setUserGestureUnlocked(unlocked)
    this.audioStreamBridge?.setUserGestureUnlocked(unlocked)
  }

  /** Bind pointer raycast after player spawn — needs collision + camera + player pose. */
  bindPointerEvents(
    getPlayerPosition: () => THREE.Vector3 | null,
    isPointerBlocked: () => boolean,
    getPhysics?: () => PhysXWorld | null
  ): void {
    if (!this.pointerEvents || !this.collision || !this.bridge || !this.host) {
      clientDebugLog.log('pointer', 'bind skipped — scene not prepared', { level: 'warn' })
      return
    }
    // Pointer reads/iteration go through the projection view + facade (writes via setRenderer/appendRenderer + source capture).
    this.pointerEvents.bind({
      ecs: this.readComponents,
      view: this.view,
      collision: this.collision,
      getEntityNodes: () => this.bridge!.getEntityNodes(),
      camera: this.host.camera,
      getPlayerPosition,
      isPointerBlocked,
      flushPointerCrdt: () => {
        void this.flushPendingPointerCrdt()
      },
      prepareRaycast: () => this.preparePointerRaycast(),
      recordAppend: this.recordRendererAppend
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
      getPlayerWorldPosition: getPlayerPosition,
      getPhysics,
      recordAppend: this.recordRendererAppend
    })
    this.raycasts?.bind({
      ecs: this.readComponents,
      view: this.view,
      collision: this.collision,
      getEntityNodes: () => this.bridge!.getEntityNodes(),
      recordLww: this.recordRendererLww
    })
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
    clientDebugLog.log(
      'pointer',
      `input bound — ${pointerEntities} PointerEvents · ${triggerEntities} TriggerArea · ${raycastEntities} Raycast`,
      { level: 'success' }
    )
  }

  private syncTriggerAreas(): void {
    this.flushTriggerStructureIfDirty()
    this.triggerAreas?.sync()
  }

  private syncRaycasts(): void {
    this.raycasts?.sync(this.crdtTick)
  }

  private lastGrowOnlyFlushAt = 0
  private lastRaycastFlushAt = 0
  /** Min interval between grow-only worker delivers (TriggerAreaResult, VideoEvent). */
  private static readonly GROW_ONLY_FLUSH_MIN_MS = 100
  private static readonly RAYCAST_FLUSH_MIN_MS = 100
  /** While GLTFs stream in, avoid pointer-crdt-deliver storms (each can run worker onUpdate). */
  private static readonly HYDRATION_CRDT_FLUSH_MIN_MS = 500
  private lastTweenDeliverAt = 0
  /** Proactive TweenState push only after pointer delivery (click→complete parity). */
  private proactiveTweenPushUntil = 0
  private static readonly TWEEN_DELIVER_MIN_MS = 100
  private static readonly PROACTIVE_TWEEN_PUSH_MS = 3000

  /**
   * Per-frame TriggerArea detection + push grow-only results to the worker.
   * CRDT round-trips alone are too sparse when the scene worker is idle.
   */
  updateTriggerAreas(): void {
    if (!this.running || !this.triggerAreas) return
    this.syncTriggerAreas()
    this.flushRendererGrowOnlyAppends()
  }

  private canDeliverRendererCrdtToWorker(): boolean {
    if (!this.worker || !this.running) return false
    if (this.pointerAwaitingWorkerApply || this.pointerFlushInFlight) return false
    // Genesis hydration — defer worker onUpdate until assets settle (see sceneWorker abort logs).
    if (this.bridge?.isAssetHydrationMode()) return false
    return true
  }

  private rendererCrdtFlushMinMs(baseMs: number): number {
    return this.playReadyNotified ? baseMs : SceneScriptSystem.HYDRATION_CRDT_FLUSH_MIN_MS
  }

  /** Push source-captured grow-only appends (TriggerAreaResult, VideoEvent) to the worker. */
  private flushRendererGrowOnlyAppends(): void {
    if (!this.canDeliverRendererCrdtToWorker()) return
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
   * Push `TweenState` to the worker after pointer delivery only (throttled).
   * Ambient Genesis tweens use the normal worker `crdt-send` path — no hot-loop push.
   */
  private deliverTweenStateToWorker(): void {
    if (performance.now() > this.proactiveTweenPushUntil) return
    if (!this.worker || !this.running || !this.tweenBridge?.hasEncodeDirty()) return
    if (this.pointerAwaitingWorkerApply || this.pointerFlushInFlight) return
    const now = performance.now()
    if (now - this.lastTweenDeliverAt < SceneScriptSystem.TWEEN_DELIVER_MIN_MS) return
    this.lastTweenDeliverAt = now

    const tweenDirty = this.tweenBridge.consumeEncodeDirty()
    this.encoder.setTweenEncodeEntities(tweenDirty)
    const bytes = this.encoder.encodeTweenStateOnly()
    if (!bytes?.byteLength) return

    if (isTweenVerbose()) {
      clientDebugLog.log(
        'motion',
        `TweenState push — ${tweenDirty.size} entity(s) [${[...tweenDirty].join(', ')}]`,
        { throttleMs: 300, alsoConsole: true }
      )
    }
    const copy = bytes.slice()
    this.worker.postMessage(
      { type: 'tween-state-deliver', data: [copy] } satisfies MainToWorker,
      [copy.buffer]
    )
  }

  /** Deliver renderer-owned LWW PUTs (VideoPlayer/AudioSource sync) — not blocked by pointer-await. */
  private flushRendererLwwToWorker(): void {
    if (!this.worker || !this.running) return
    if (this.encoder.pendingLwwPutCount === 0) return
    const lwwBytes = this.encoder.encodeLwwPutsOnly()
    if (!lwwBytes?.byteLength) return
    const copy = lwwBytes.slice()
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
    this.worker.postMessage(
      { type: 'pointer-crdt-deliver', data: [copy] } satisfies MainToWorker,
      [copy.buffer]
    )
  }

  /** Deliver source-captured grow-only appends (TriggerAreaResult, etc.) to the worker. */
  private deliverRendererAppendsToWorker(): void {
    if (!this.worker || !this.running) return
    const pending = this.encoder.pendingAppendCount
    const appendBytes = this.encoder.encodeAppendsOnly()
    if (!appendBytes?.byteLength) return
    const copy = appendBytes.slice()
    clientDebugLog.log(
      'input',
      `Grow-only CRDT deliver — ${pending} append(s), ${copy.byteLength} bytes`,
      { level: 'info', alsoConsole: isTriggerAreaVerbose() }
    )
    this.worker.postMessage(
      { type: 'renderer-append-deliver', data: [copy] } satisfies MainToWorker,
      [copy.buffer]
    )
  }

  triggerPointerAction(action: import('../../input/pointerConstants').InputActionValue, phase: 'down' | 'up'): void {
    this.pointerEvents?.triggerInputAction(action, phase)
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

  /** Push pointer CRDT to worker via inject + pointer-crdt-deliver. */
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
      this.logPointerFlushSkipped('flush already in flight')
      return
    }
    if (!this.pointerEvents.hasPendingInput()) {
      this.logPointerFlushSkipped('no pending pointer down/up')
      return
    }

    this.pointerFlushInFlight = true
    try {
      this.logPointer(`pointer flush start — tick=${this.crdtTick}`)
      clientDebugLog.log('pointer', `flush pending input tick=${this.crdtTick}`, {
        alsoConsole: POINTER_VERBOSE
      })
      this.syncPointerInput(this.crdtTick, { processPendingDown: true, processPendingUp: true })
      this.crdtTick++

      // Source-capture already queued appends — encode pointer appends only (no player/camera LWW).
      const pendingAppends = this.encoder.pendingAppendCount
      const appendBytes = this.encoder.encodeAppendsOnly()
      if (appendBytes) {
        this.pointerResponseStash.length = 0
        this.pointerResponseStash.push(appendBytes.slice())
      } else {
        console.warn(
          '[pointer]',
          `pointer flush — encoder append encode empty (pendingAppends=${pendingAppends})`
        )
        this.pointerResponseStash.length = 0
      }
      this.consolidatePointerStash()
      const stashedBytes = this.pointerResponseStash.reduce((n, c) => n + c.byteLength, 0)
      const flushMsg = `pointer flush — stashed ${this.pointerResponseStash.length} chunk(s), ${stashedBytes} bytes; delivering to worker`
      if (stashedBytes > 0) this.logPointer(flushMsg)
      else console.warn('[pointer]', flushMsg)
      clientDebugLog.log('pointer', flushMsg, {
        alsoConsole: false,
        level: stashedBytes ? 'success' : 'warn'
      })
      this.pointerAwaitingWorkerApply = true
      this.deliverPointerToWorker()
    } finally {
      this.pointerFlushInFlight = false
    }
  }

  /** Deliver pointer to worker — inject first (priority lane), then CRDT; pause after queue. */
  private deliverPointerToWorker(): void {
    if (!this.worker) {
      console.warn('[pointer]', 'pointer deliver skipped — worker missing')
      return
    }
    this.pointerDeliverAwaitingAck = true
    this.pointerDeliverRetried = false
    this.armPointerDeliverWatchdog('pointer — no worker pointer-deliver-done (inject or crdt-deliver)')

    const inject = this.pointerEvents?.consumeInjectPayload()
    if (inject) {
      this.logPointer(
        `posting inject-pointer-click entity=${inject.entity} button=${inject.button} ts=${inject.downTimestamp}/${inject.upTimestamp}`
      )
      this.worker.postMessage({ type: 'inject-pointer-click', body: inject } satisfies MainToWorker)
    } else {
      this.logPointer('inject payload missing — direct CRDT only')
    }

    this.deliverPointerCrdtDirect()
    // Worker sets sceneTicksPaused during inject/deliver; do not pause from main mid-flight —
    // it raced post-onUpdate engine.update CRDT (Tween sync) before deliver-done.
  }

  /** Post pre-encoded pointer CRDT directly to worker (parallel to inject). */
  private deliverPointerCrdtDirect(): void {
    if (!this.worker) return
    const chunks = this.pointerResponseStash.filter((c) => c.byteLength > 0)
    if (!chunks.length) {
      this.logPointer('pointer-crdt-deliver skipped — stash empty')
      return
    }
    const bytes = chunks.reduce((n, c) => n + c.byteLength, 0)
    this.logPointer(`posting pointer-crdt-deliver — ${chunks.length} chunk(s), ${bytes} bytes`)
    const copies = chunks.map((c) => c.slice())
    const transfer = copies.map((c) => c.buffer)
    this.worker.postMessage({ type: 'pointer-crdt-deliver', data: copies } satisfies MainToWorker, transfer)
  }

  private onPointerDeliverDone(): void {
    this.logPointer('pointer-deliver-done — worker finished pointer tick + onUpdate CRDT flush')
    this.videoPlayerBridge?.notifyUserPointerDelivered()
    void this.finishPointerDeliveryAsync('pointer-deliver-done')
  }

  /**
   * Worker onUpdate may publish transform / mesh diffs (plant growth) while delivery is in flight.
   * Wait for one-way outbound, apply projection diff, then sync CL_POINTER colliders.
   */
  private async reconcilePointerCollisionAfterDelivery(): Promise<void> {
    await this.crdtOutboundSerial
    const bridge = this.bridge
    const tweenRefresh = this.tweenBridge?.getActiveTweenEntities() ?? []
    if (bridge?.canConsumeDiff() && this.pendingDiff.size) {
      const diff = this.pendingDiff
      this.pendingDiff = new Map()
      await bridge.consumeDiff(diff, this.view, tweenRefresh)
    } else {
      this.consumeSyncFrameTransforms()
    }
    this.flushSceneGraphMatrices()
    if (this.hasColliderWorkPending()) {
      this.syncCollision()
    } else {
      this.syncCollisionPoses()
    }
    const poseChanged = [...this.lastPoseChangedEntities]
    if (poseChanged.length) {
      this.collidersPoseCallback?.(poseChanged)
    }
    this.refreshPointerTargets()
    this.collidersCookCallback?.()
  }

  /** Clear pointer flush state and resume worker scene ticks after delivery (idempotent). */
  private async finishPointerDeliveryAsync(source: string): Promise<void> {
    if (!this.pointerAwaitingWorkerApply && !this.pointerDeliverAwaitingAck) return
    clientDebugLog.log('pointer', `delivery complete — ${source}`, { alsoConsole: false })
    this.pointerAwaitingWorkerApply = false
    this.pointerDeliverRetried = false
    this.clearPointerDeliverWatchdog()
    await this.reconcilePointerCollisionAfterDelivery()
    this.proactiveTweenPushUntil = performance.now() + SceneScriptSystem.PROACTIVE_TWEEN_PUSH_MS
    this.worker?.postMessage({ type: 'pause-scene-ticks', paused: false } satisfies MainToWorker)
  }

  private finishPointerDelivery(source: string): void {
    void this.finishPointerDeliveryAsync(source)
  }

  /** Worker path failed — surface loudly; scene triggers/tweens did not run. */
  private failPointerDelivery(reason: string): void {
    if (!this.pointerAwaitingWorkerApply && !this.pointerDeliverAwaitingAck) return
    const message = `pointer delivery failed — ${reason} (worker must ack pointer-deliver-done)`
    console.error('[pointer]', message)
    clientDebugLog.log('pointer', message, { level: 'error', alsoConsole: true })
    this.finishPointerDelivery('pointer-delivery-failed')
  }

  /** Extend ack timeout — worker onUpdate (plant growth) can exceed 800ms; never re-post CRDT. */
  private recoverStalledPointerDelivery(): void {
    if (!this.pointerDeliverAwaitingAck || !this.worker) return
    if (this.pointerDeliverRetried) return
    this.pointerDeliverRetried = true
    console.warn('[pointer]', 'pointer delivery still in flight — extending ack timeout (no CRDT retry)')
    this.armPointerDeliverWatchdog(
      'pointer — no worker pointer-deliver-done after extended wait',
      SceneScriptSystem.POINTER_DELIVER_FAIL_EXTENDED_MS,
      false
    )
  }

  private armPointerDeliverWatchdog(
    detail: string,
    failAfterMs: number = SceneScriptSystem.POINTER_DELIVER_FAIL_MS,
    armStallWatchdog = true
  ): void {
    if (this.pointerDeliverWatchdog) {
      clearTimeout(this.pointerDeliverWatchdog)
      this.pointerDeliverWatchdog = null
    }
    if (this.pointerDeliverFailWatchdog) {
      clearTimeout(this.pointerDeliverFailWatchdog)
      this.pointerDeliverFailWatchdog = null
    }
    if (armStallWatchdog) {
      this.pointerDeliverWatchdog = setTimeout(() => {
        if (!this.pointerDeliverAwaitingAck) return
        console.error('[pointer]', `pointer deliver stalled — ${detail}`)
        this.recoverStalledPointerDelivery()
      }, SceneScriptSystem.POINTER_DELIVER_STALL_MS)
    }
    this.pointerDeliverFailWatchdog = setTimeout(() => {
      if (!this.pointerDeliverAwaitingAck) return
      this.failPointerDelivery('no worker pointer-deliver-done after retry')
    }, failAfterMs)
  }

  private clearPointerDeliverWatchdog(): void {
    if (this.pointerDeliverWatchdog) {
      clearTimeout(this.pointerDeliverWatchdog)
      this.pointerDeliverWatchdog = null
    }
    if (this.pointerDeliverFailWatchdog) {
      clearTimeout(this.pointerDeliverFailWatchdog)
      this.pointerDeliverFailWatchdog = null
    }
    this.pointerDeliverAwaitingAck = false
  }

  /** Merge multiple stashed CRDT blobs into one append-only chunk. */
  private consolidatePointerStash(): void {
    if (this.pointerResponseStash.length <= 1) return
    const total = this.pointerResponseStash.reduce((n, c) => n + c.byteLength, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of this.pointerResponseStash) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    this.pointerResponseStash.length = 0
    this.pointerResponseStash.push(merged)
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
    this.refreshClientPosesFromProvider()
    if (!this.clientPlayerPose || !this.clientCameraPose) return
    this.reserved.prepareRendererRoundTrip(this.clientPlayerPose, this.clientCameraPose)
    this.syncProjectionReservedTransforms()
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
    this.reserved.prepareRendererRoundTrip(player, camera)
    this.syncProjectionReservedTransforms()
  }

  /** Keep projection player/camera LWW ahead of stale worker inbound (avoids spawn snap on click). */
  private syncProjectionReservedTransforms(): void {
    const { Transform } = this.readComponents
    const { PlayerEntity, CameraEntity } = this.view
    if (Transform.has(PlayerEntity)) {
      this.projection.setRenderer(Transform.componentId, PlayerEntity, Transform.get(PlayerEntity))
    }
    if (Transform.has(CameraEntity)) {
      this.projection.setRenderer(Transform.componentId, CameraEntity, Transform.get(CameraEntity))
    }
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
  }

  /** ECS projection → Three.js — runs during hydration before the worker loop is marked running. */
  async syncRenderer(): Promise<void> {
    if (!this.bridge) return
    const view = this.view

    // Diff consumer at runtime; full walk only while asset hydration is active.
    if (this.bridge.canConsumeDiff()) {
      const diff = this.pendingDiff
      this.pendingDiff = new Map<Entity, Map<number, ProjectionChangeKind>>()
      if (!diff.size) {
        await this.bridge.drainPendingWork()
        return
      }
      if (!this.projectionDiffActive) {
        this.projectionDiffActive = true
        clientDebugLog.log('projection', 'diff consumer ACTIVE — rendering driven by projection diff (default)', {
          level: 'success',
          alsoConsole: true
        })
      }
      const { spriteDiff, sceneDiff } = this.bridge.partitionSpriteDiff(diff, view)
      if (spriteDiff.size) this.bridge.consumeSpriteDiff(spriteDiff, view)
      const tweenRefresh = this.tweenBridge?.getActiveTweenEntities() ?? []
      if (sceneDiff.size) await this.bridge.consumeDiff(sceneDiff, view, tweenRefresh)
      else await this.bridge.drainPendingWork()
      this.bridge.reconcileBillboardFlags()
      this.flushPointerStructureIfDirty()
      return
    }

    this.bridge.prefetchSceneGlbs()

    // Hydration — full walk reconciles everything; discard accumulated diff.
    this.pendingDiff.clear()
    this.pointerStructureDirty = true
    await this.bridge.sync(view)
    this.flushPointerStructureIfDirty()
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
  notifyPlayReady(options?: { plazaScale?: boolean; engineTickIntervalMs?: number }): void {
    this.bridgeSyncEvery = BRIDGE_ECS_SYNC_RUNTIME
    this.setSceneWorkerOnUpdatePaused(false)
    this.setSceneWorkerTicksPaused(false)
    if (this.playReadyNotified) return
    this.playReadyNotified = true
    this.worker?.postMessage({
      type: 'scene-play-ready',
      performanceTier: this.performanceTier,
      plazaScale: options?.plazaScale,
      engineTickIntervalMs: options?.engineTickIntervalMs
    } satisfies MainToWorker)
  }

  /** When a parent Transform moves, child GltfContainer / MeshCollider world poses change too. */
  private markDescendantColliderPosesDirty(ancestor: Entity): void {
    const stack: Entity[] = [ancestor]
    while (stack.length > 0) {
      const entity = stack.pop()!
      if (this.colliderRootEntities.has(entity)) this.colliderPoseDirty.add(entity)
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
    clientDebugLog.log('motion', message, { level: 'info', alsoConsole: true })
    console.info('[motion]', message)
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
    const { MeshCollider, GltfContainer } = this.readComponents
    for (const entity of this.tweenBridge.consumeTransformMotionEntities()) {
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
    if (!this.running || !this.bridge || !this.entityStore || !this.pendingDiff.size) return
    if (!this.bridge.canConsumeDiff()) return

    const { Transform, AvatarAttach } = this.readComponents
    const transformDiff = new Map<Entity, Map<number, ProjectionChangeKind>>()
    for (const [entity, comps] of this.pendingDiff) {
      const transformKind = comps.get(Transform.componentId)
      if (transformKind === undefined) continue
      transformDiff.set(entity, new Map([[Transform.componentId, transformKind]]))
    }
    if (!transformDiff.size) return

    const tweenRefresh = (this.tweenBridge?.getActiveTweenEntities() ?? []).filter(
      (entity) => !AvatarAttach.has(entity)
    )
    applySceneDiff(this.entityStore, transformDiff, this.view, this.readComponents, tweenRefresh)
    this.lastSyncFrameTransformEntities.clear()
    for (const entity of transformDiff.keys()) this.lastSyncFrameTransformEntities.add(entity)

    for (const entity of transformDiff.keys()) {
      const pending = this.pendingDiff.get(entity)
      if (!pending) continue
      pending.delete(Transform.componentId)
      if (pending.size === 0) this.pendingDiff.delete(entity)
    }
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
    const structureEntities = [...this.colliderStructureDirty]
    if (this.colliderStructureDirty.size) {
      const pendingStructure = new Set<Entity>()
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
    const shapeMotion = this.animatorBridge?.pendingShapeMotionEntities()
    if (this.colliderPoseDirty.size) {
      for (const entity of this.colliderPoseDirty) {
        let changed = false
        if (this.collision.syncColliderEntityPose(entity, nodes)) changed = true
        const allowShapes = shapeMotion?.has(entity) ?? false
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
      if (cooked.length >= 8) {
        this.collidersCookCallback?.()
      } else {
        for (const entity of cooked) this.collidersCookCallback?.(entity)
      }
      this.refreshPointerTargets()
    }

    if (poseChangedEntities.length > 0) {
      this.collidersPoseCallback?.(poseChangedEntities)
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
    clientDebugLog.log('motion', line, { alsoConsole: true })
    console.info('[motion]', line)
  }

  private maybeDumpMotionFocus(): void {
    if (!isMotionFocusActive() || this.motionFocusDumped || !this.running) return
    this.motionFocusDumpTicks++
    if (this.motionFocusDumpTicks < 180) return
    this.motionFocusDumped = true
    this.dumpMotionFocusNow()
  }

  pumpMotionBridges(delta: number, tickNumber = 0): void {
    if (!this.running || !this.bridge) return
    this.maybeDumpMotionFocus()
    this.tweenBridge?.sync(this.view)
    this.videoPlayerBridge?.sync(this.view)
    this.audioSourceBridge?.sync(this.view)
    this.audioStreamBridge?.sync(this.view)
    this.avatarShapes?.update(delta)
    this.animatorBridge?.update(delta)
    this.particleBridge?.update(delta)
    this.avatarAttachBridge?.update(this.view)
    this.flushAvatarAttachTransforms()
    this.tweenBridge?.update(delta, this.view)
    this.markTweenColliderPosesDirty()
    this.billboardBridge?.sync(this.view)
    this.billboardBridge?.update()
    this.markMotionEmitterColliderDirty()
    this.deliverTweenStateToWorker()
    this.videoPlayerBridge?.update(tickNumber, this.view)
    this.audioSourceBridge?.update(tickNumber, this.view)
    this.audioStreamBridge?.update(tickNumber, this.view)
  }

  private flushAvatarAttachTransforms(): void {
    const batch = this.avatarAttachBridge?.consumeWorkerBatch()
    if (!batch?.length || !this.worker) return
    this.worker.postMessage({ type: 'avatar-attach-transforms', entries: batch } satisfies MainToWorker)
  }

  async syncAsyncBridges(): Promise<void> {
    if (!this.running || !this.bridge) return
    this.bridgeSyncTick++
    if (!this.bridgeDirty && this.bridgeSyncTick % this.bridgeSyncEvery !== 0) return
    this.bridgeDirty = false
    await this.avatarShapes?.sync(this.view)
    this.avatarEmoteBridge?.sync(this.view)
    await this.animatorBridge?.sync(this.view)
    await this.particleBridge?.sync(this.view)
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

  setAssetHydrationMode(enabled: boolean): void {
    this.bridge?.setAssetHydrationMode(enabled)
  }

  extendSoftHydration(durationMs: number): void {
    this.bridge?.extendSoftHydration(durationMs)
  }

  dispose(): void {
    resetBlimpPivotCache()
    this.motionFocusDumped = false
    this.motionFocusDumpTicks = 0
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
    this.animatorBridge = null
    this.tweenBridge = null
    this.particleBridge?.dispose()
    this.particleBridge = null
    this.avatarAttachBridge?.dispose()
    this.avatarAttachBridge = null
    this.videoPlayerBridge = null
    this.audioSourceBridge?.dispose()
    this.audioSourceBridge = null
    this.audioStreamBridge?.dispose()
    this.audioStreamBridge = null
    this.collision?.dispose()
    this.collision = null
    this.gltfColliders?.dispose()
    this.gltfColliders = null
    this.pointerEvents?.dispose()
    this.pointerEvents = null
    this.triggerAreas?.dispose()
    this.triggerAreas = null
    this.raycasts?.dispose()
    this.raycasts = null
    this.engineApiEvents.dispose()
    this.clearPointerDeliverWatchdog()
    this.pointerResponseStash.length = 0
    this.worker?.terminate()
    this.worker = null
    this.host = null
    this.running = false
    this.prepared = false
  }
}
