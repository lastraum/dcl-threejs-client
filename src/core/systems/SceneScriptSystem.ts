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
import { AvatarShapeBridge } from '../../bridge/AvatarShapeBridge'
import { AvatarEmoteCommandBridge, type AvatarEmoteHandler } from '../../bridge/AvatarEmoteCommandBridge'
import { BillboardBridge } from '../../bridge/BillboardBridge'
import { AnimatorBridge } from '../../bridge/AnimatorBridge'
import { TweenBridge } from '../../bridge/TweenBridge'
import { VideoPlayerBridge } from '../../media/VideoPlayerBridge'
import { CollisionSystem } from '../../collision/CollisionSystem'
import { GltfColliderExtractor } from '../../collision/GltfColliderExtractor'
import type {
  CommsRpcHandler,
  MainToWorker,
  SceneWorkerBoot,
  SceneWorkerOutbound,
  SignedFetchHandler,
  SignedFetchGetHeadersHandler
} from '../../shim/types'
import type { MovePlayerToRequest, MovePlayerToResponse } from '../../player/movePlayerTo'
import type { OpenExternalUrlRequest, OpenExternalUrlResponse } from '../../player/openExternalUrl'
import type { TriggerEmoteRequest, TriggerEmoteResponse } from '../../player/triggerEmote'
import type { TriggerSceneEmoteRequest, TriggerSceneEmoteResponse } from '../../player/triggerSceneEmote'
import type { InjectPointerClickBody } from '../../player/injectPointerClick'
import type { AssetCache } from '../../rendering/AssetCache'
import type { SceneHost } from '../../rendering/SceneHost'
import type { PlayerMirrorIdentity } from '../../bridge/playerMirrorIdentity'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import { PointerEventType } from '../../input/pointerConstants'
import { resolveSceneEmoteFromSrc } from '../../avatar/profileEmotes'
import { getActiveSceneManifest } from '../../rendering/DclTextureResolver'
import { PointerEventsSystem } from '../../input/PointerEventsSystem'
import { EngineApiEventBridge } from './EngineApiEventBridge'

type MovePlayerHandler = (request: MovePlayerToRequest) => boolean
type TriggerEmoteHandler = (request: TriggerEmoteRequest) => boolean
type TriggerSceneEmoteHandler = (request: TriggerSceneEmoteRequest) => boolean
type OpenExternalUrlHandler = (request: OpenExternalUrlRequest) => boolean

/** Diff frames between safety full-resyncs (self-heals any missed diff / mid-sync race). */
const FULL_RESYNC_INTERVAL = 480
/** Pose-only collision sync during hydration (tweened entities). */
const COLLISION_POSE_SYNC_HYDRATION = 4
/** Runtime pose-only sync — static Genesis colliders rarely move. */
const COLLISION_POSE_SYNC_RUNTIME = 30
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
  private readonly projection = new CrdtProjection(this.componentHost.components, {
    networkEntity: this.componentHost.networkEntity,
    networkParent: this.componentHost.networkParent
  })
  private readonly storeComponents = createStoreComponents(this.componentHost.components, this.projection)
  readonly readComponents: MirrorComponents = this.storeComponents
  readonly view: ProjectionView = projectionViewFromProjection(
    this.projection,
    this.readComponents,
    SDK_RESERVED
  )
  /** Phase 2 — diff accumulated across worker ticks, drained (swapped out) by the render frame. */
  private pendingDiff = new Map<Entity, Map<number, ProjectionChangeKind>>()
  private fullResyncCountdown = 0
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
  private encoderEnabledLogged = false
  readonly reserved = new ReservedEntitiesSync(this.projection, this.readComponents, SDK_RESERVED)
  collision: CollisionSystem | null = null
  gltfColliders: GltfColliderExtractor | null = null
  pointerEvents: PointerEventsSystem | null = null
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
  private videoPlayerBridge: VideoPlayerBridge | null = null
  private host: SceneHost | null = null
  private worker: Worker | null = null
  private running = false
  private prepared = false
  private crdtTick = 0
  private clientPlayerPose: EntityPose | null = null
  private clientCameraPose: EntityPose | null = null
  private movePlayerHandler: MovePlayerHandler | null = null
  private triggerEmoteHandler: TriggerEmoteHandler | null = null
  private triggerSceneEmoteHandler: TriggerSceneEmoteHandler | null = null
  private openExternalUrlHandler: OpenExternalUrlHandler | null = null
  private commsHandler: CommsRpcHandler | null = null
  private collidersCookCallback: (() => void) | null = null
  private collisionDirty = true
  private collisionPoseTick = 0
  private collisionPoseSyncEvery = COLLISION_POSE_SYNC_HYDRATION
  private pointerStructureDirty = false
  private bridgeDirty = true
  private bridgeSyncTick = 0
  private bridgeSyncEvery = BRIDGE_ECS_SYNC_RUNTIME
  private signedFetchHandler: SignedFetchHandler | null = null
  private signedFetchGetHeadersHandler: SignedFetchGetHeadersHandler | null = null
  /** Pointer append bytes captured at flush, sent via pointer-crdt-deliver. */
  private readonly pointerResponseStash: Uint8Array[] = []
  /** Prevents overlapping flush encodes while mirror flushOutgoing is awaited. */
  private pointerFlushInFlight = false
  /** Serializes crdt-send round-trips so mirror/encoder/stash cannot race. */
  private crdtSendSerial: Promise<void> = Promise.resolve()
  /** Set when pointer-crdt-deliver is posted; cleared on pointer-deliver-done from worker. */
  private pointerDeliverAwaitingAck = false
  private pointerDeliverWatchdog: ReturnType<typeof setTimeout> | null = null
  private pointerFallbackWatchdog: ReturnType<typeof setTimeout> | null = null
  /** Click flush pending — cleared on pointer-deliver-done. */
  private pointerAwaitingWorkerApply = false
  /** Last inject payload — retried when worker ack stalls. */
  private lastInjectPayload: InjectPointerClickBody | null = null
  /** Emote src fired via main-thread fallback after worker ack stalls. */
  private fallbackPointerEmoteSrc: string | null = null
  /** True after one watchdog retry — avoids infinite inject loops. */
  private pointerDeliverRetried = false

  private logPointer(...parts: unknown[]): void {
    if (POINTER_VERBOSE) console.log('[pointer]', ...parts)
  }

  /** Phase 4 — unified entity store (scene graph + avatar peers). */
  getEntityStore(): EntityStore | null {
    return this.entityStore
  }

  /** Mirror + bridge setup — call before player spawn so reserved entities exist. */
  prepare(scene: ResolvedScene, cache: AssetCache, host: SceneHost): void {
    if (!scene.mainEntry || !scene.entityId) return

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
      () => this.bridge?.getEntityNodes(),
      () => this.host!.camera
    )
    this.animatorBridge = new AnimatorBridge(
      this.readComponents,
      cache,
      scene,
      () => this.bridge?.getEntityNodes()
    )
    this.tweenBridge = new TweenBridge(this.readComponents, () => this.bridge?.getEntityNodes())
    this.videoPlayerBridge = new VideoPlayerBridge(this.readComponents, scene, this.recordRendererAppend)
    this.bridge.setVideoPlayerBridge(this.videoPlayerBridge)
    this.collision = new CollisionSystem(host.scene)
    this.gltfColliders = new GltfColliderExtractor(host.scene)
    this.pointerEvents = new PointerEventsSystem(host.renderer.domElement)
    this.avatarShapes.setAssetCache(cache, scene.realm.contentUrl)
    this.bridge.setOnGltfAttached(() => this.flushIncrementalColliders())
    this.prepared = true
  }

  /** Called by World — incremental PhysX cook while GLBs attach during hydration. */
  setCollidersCookCallback(callback: (() => void) | null): void {
    this.collidersCookCallback = callback
  }

  /** Route EntityStore notifications to collision / pointer / async bridge systems (Phase 4.2–4.3). */
  private onEntityStoreChange(change: EntityStoreChange): void {
    if (change.entity !== undefined && this.entityStore?.getOwner(change.entity) === 'avatar') {
      return
    }

    if (change.kind === 'create' || change.kind === 'destroy') {
      this.pointerStructureDirty = true
      this.collisionDirty = true
      return
    }

    if (change.kind !== 'put' && change.kind !== 'delete') return
    const { entity, componentId } = change
    if (entity === undefined || componentId === undefined) return

    const { Transform, MeshCollider, GltfContainer, PointerEvents, MeshRenderer, Animator, AvatarShape } =
      this.readComponents

    if (
      componentId === MeshCollider.componentId ||
      componentId === GltfContainer.componentId ||
      (componentId === Transform.componentId &&
        (MeshCollider.has(entity) || GltfContainer.has(entity)))
    ) {
      this.collisionDirty = true
    }

    if (
      componentId === PointerEvents.componentId ||
      componentId === GltfContainer.componentId ||
      componentId === MeshRenderer.componentId ||
      componentId === MeshCollider.componentId
    ) {
      this.pointerStructureDirty = true
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

  /** Re-extract colliders for entities that just received a GLTF mesh, then cook into PhysX. */
  flushIncrementalColliders(): void {
    this.collisionDirty = true
    this.pointerStructureDirty = true
    this.syncCollision()
    // During hydration, PhysX cook runs on the next hydration tick (budgeted batch).
    if (this.bridge?.isAssetHydrationMode()) return
    this.collidersCookCallback?.()
  }

  /** Full GLTF/MeshCollider extraction — use before spawn cook and each hydration tick. */
  syncCollisionForce(): void {
    this.collisionDirty = true
    this.syncCollision()
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

  /** Seed PlayerEntity identity components for scene `getPlayer()`. */
  setPlayerIdentity(identity: PlayerMirrorIdentity | null): void {
    this.reserved.setPlayerIdentity(identity)
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

  private async bootWorker(scene: ResolvedScene): Promise<void> {
    if (!scene.mainEntry || !scene.entityId) return

    const mainFile = scene.content.find((c) => c.file === scene.mainEntry)
    if (!mainFile) throw new Error(`Main entry not in content: ${scene.mainEntry}`)

    this.worker = new Worker(new URL('../../shim/worker/sceneWorkerEntry.ts', import.meta.url), {
      type: 'module'
    })

    const boot: SceneWorkerBoot = {
      type: 'boot',
      scene: {
        title: scene.title,
        parcels: scene.parcels,
        baseParcel: scene.baseParcel,
        spawn: scene.spawn,
        contentsBaseUrl: scene.contentsBaseUrl,
        entityId: scene.entityId,
        mainEntry: scene.mainEntry,
        worldName: scene.source.kind === 'world' ? scene.source.worldName : undefined,
        scriptUrl: scene.assetUrl(mainFile.hash),
        content: scene.content,
        metadataJson: JSON.stringify(scene.metadata ?? {})
      }
    }

    await new Promise<void>((resolve, reject) => {
      if (!this.worker) return reject(new Error('Worker missing'))

      this.engineApiEvents.bind((events) => {
        this.worker?.postMessage({ type: 'engine-api-enqueue', events } satisfies MainToWorker)
      })

      this.worker.onmessage = (ev: MessageEvent<SceneWorkerOutbound>) => {
        const msg = ev.data
        // Priority lane — pointer-deliver-done must not queue behind handleCrdtSend.
        if (msg?.type === 'pointer-deliver-done') {
          this.onPointerDeliverDone()
          return
        }
        void this.handleWorkerMessage(msg, resolve, reject)
      }
      this.worker.onerror = (err) => reject(err)

      this.worker.postMessage(boot)
    })

    this.running = true
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
      clientDebugLog.log('scene', 'Scene worker ready (main thread)', { level: 'success' })
      onReady()
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
      await this.commsHandler?.send(msg.body)
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
    if (msg.type === 'crdt-send') {
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
        id: msg.id,
        hasEntities: state.hasEntities,
        data: state.data
      } satisfies MainToWorker)
      return
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
        this.crdtTick++
        this.prepareRendererOutboundState()
        const encoderBytes = this.encoder.encode()
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

      // Hover + PrimaryPointerInfo only. PET_DOWN/UP stay queued until click flush → pointer-crdt-deliver.
      this.syncPointerInput(this.crdtTick, { processPendingDown: false, processPendingUp: false })
      this.crdtTick++

      this.prepareRendererOutboundState()

      const encoderBytes = this.encoder.encode()
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

    for (const change of this.projection.changes) {
      if (change.entity === PlayerEntity || change.entity === CameraEntity || change.entity === RootEntity) {
        continue
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

  setVideoUserGestureUnlocked(unlocked: boolean): void {
    this.videoPlayerBridge?.setUserGestureUnlocked(unlocked)
  }

  /** Bind pointer raycast after player spawn — needs collision + camera + player pose. */
  bindPointerEvents(getPlayerPosition: () => THREE.Vector3 | null, isPointerBlocked: () => boolean): void {
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
    clientDebugLog.log(
      'pointer',
      `input bound — ${pointerEntities} PointerEvents entities (E / click to interact)`,
      { level: 'success' }
    )
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
    this.fallbackPointerEmoteSrc = null
    this.pointerDeliverRetried = false
    this.armPointerDeliverWatchdog('pointer — no worker ack within 800ms (inject or crdt-deliver)')

    const inject = this.pointerEvents?.consumeInjectPayload()
    if (inject) {
      this.lastInjectPayload = inject
      this.logPointer(
        `posting inject-pointer-click entity=${inject.entity} button=${inject.button} ts=${inject.downTimestamp}/${inject.upTimestamp}`
      )
      this.worker.postMessage({ type: 'inject-pointer-click', body: inject } satisfies MainToWorker)
    } else {
      this.logPointer('inject payload missing — direct CRDT only')
    }

    this.deliverPointerCrdtDirect()
    this.worker.postMessage({ type: 'pause-scene-ticks', paused: true } satisfies MainToWorker)
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
    this.logPointer('pointer-deliver-done — worker applied pointer CRDT and ticked scene')
    this.finishPointerDelivery('pointer-deliver-done')
  }

  /** Clear pointer flush state and resume worker scene ticks after delivery (idempotent). */
  private finishPointerDelivery(source: string, options?: { keepFallbackEmote?: boolean }): void {
    if (!this.pointerAwaitingWorkerApply && !this.pointerDeliverAwaitingAck) return
    clientDebugLog.log('pointer', `delivery complete — ${source}`, { alsoConsole: false })
    this.pointerAwaitingWorkerApply = false
    this.lastInjectPayload = null
    if (!options?.keepFallbackEmote) this.fallbackPointerEmoteSrc = null
    this.pointerDeliverRetried = false
    this.clearPointerDeliverWatchdog()
    this.worker?.postMessage({ type: 'pause-scene-ticks', paused: false } satisfies MainToWorker)
  }

  /** Resolve scene emote src from inject entity chain (PET_DOWN/PET_UP + hoverText/manifest). */
  private resolveEmoteFromInject(inject: InjectPointerClickBody): string | null {
    const entities = this.collectPointerFallbackEntities(inject)
    const stores: Array<{ ecs: MirrorComponents }> = [{ ecs: this.readComponents }]

    for (const entity of entities) {
      for (const { ecs } of stores) {
        const spec = ecs.PointerEvents.getOrNull(entity) as
          | { pointerEvents: Array<{ eventType?: number; eventInfo?: { hoverText?: string } }> }
          | null
        if (!spec?.pointerEvents?.length) continue

        for (const entry of spec.pointerEvents) {
          const eventType = entry.eventType ?? PointerEventType.PET_DOWN
          if (eventType !== PointerEventType.PET_DOWN && eventType !== PointerEventType.PET_UP) continue

          const hover = entry.eventInfo?.hoverText?.trim() ?? ''
          const emoteSrc =
            this.resolveTriggerSceneEmoteSrc(hover) ?? this.resolveEmoteFromManifestHover(hover)
          if (emoteSrc) return emoteSrc
        }
      }
    }
    return null
  }

  /**
   * Main-thread triggerSceneEmote — last-resort fallback when worker pointer delivery stalls.
   */
  private tryMainThreadPointerFallback(inject: InjectPointerClickBody): boolean {
    if (this.fallbackPointerEmoteSrc) return false

    const emoteSrc = this.resolveEmoteFromInject(inject)
    if (!emoteSrc) {
      console.warn('[pointer]', `main-thread pointer fallback — no triggerSceneEmote match entity=${inject.entity}`)
      return false
    }

    if (!this.triggerSceneEmoteHandler?.({ src: emoteSrc })) return false

    console.warn('[pointer]', `main-thread pointer fallback — entity=${inject.entity}`)
    this.logPointer(`fallback triggerSceneEmote — src=${emoteSrc}`)
    this.fallbackPointerEmoteSrc = emoteSrc
    this.finishPointerDelivery('main-thread emote fallback', { keepFallbackEmote: true })
    return true
  }

  /** Entities to inspect for emergency triggerSceneEmote fallback (inject chain + Transform parents). */
  private collectPointerFallbackEntities(inject: InjectPointerClickBody): Entity[] {
    const seen = new Set<number>()
    const out: Entity[] = []
    const add = (raw: number): void => {
      if (seen.has(raw)) return
      seen.add(raw)
      out.push(raw as Entity)
    }

    for (const raw of inject.entities.length ? inject.entities : [inject.entity]) add(raw)
    add(inject.hitEntity)
    add(inject.entity)

    let current = inject.entity as Entity
    const { RootEntity, PlayerEntity, CameraEntity } = this.view
    for (let depth = 0; depth < 24; depth++) {
      const parent = this.readComponents.Transform.getOrNull(current)?.parent as Entity | undefined
      if (parent === undefined || parent === RootEntity || parent === PlayerEntity || parent === CameraEntity) {
        break
      }
      add(parent)
      current = parent
    }
    return out
  }

  /** Parse triggerSceneEmote src from hoverText (`triggerSceneEmote:path`) or scene content paths. */
  private resolveTriggerSceneEmoteSrc(hoverText: string): string | null {
    const hover = hoverText.trim()
    if (!hover) return null
    if (hover.startsWith('triggerSceneEmote:')) {
      const src = hover.slice('triggerSceneEmote:'.length).trim()
      return src || null
    }
    if (resolveSceneEmoteFromSrc(hover, false)) return hover
    if (hover.includes('/') || /\.(glb|gltf|json)$/i.test(hover)) {
      return hover.startsWith('./') ? hover : `./${hover.replace(/^\.\//, '')}`
    }
    return null
  }

  /** Match hover label (e.g. "WATER PLANTS") to a scene `_emote.glb` in the deployed manifest. */
  private resolveEmoteFromManifestHover(hoverText: string): string | null {
    const manifest = getActiveSceneManifest()
    if (!manifest?.content?.length) return null

    const emotes = manifest.content
      .map((f) => f.file)
      .filter((file) => /_emote\.glb$/i.test(file))
    if (!emotes.length) return null

    const hover = hoverText.trim().toLowerCase()
    if (!hover) return null

    const tokens = hover.split(/[\s_-]+/).filter((t) => t.length > 2)
    for (const file of emotes) {
      const lower = file.toLowerCase()
      if (tokens.some((t) => lower.includes(t))) {
        return file.startsWith('./') ? file : `./${file.replace(/^\.\//, '')}`
      }
    }

    if (/water|plant|watering/i.test(hover)) {
      const match = emotes.find((f) => /water|watering|plant/i.test(f))
      if (match) {
        return match.startsWith('./') ? match : `./${match.replace(/^\.\//, '')}`
      }
    }

    return null
  }

  /** One retry when inject + direct CRDT stall; no infinite inject loop. */
  private recoverStalledPointerDelivery(): void {
    if (!this.pointerDeliverAwaitingAck || !this.worker) return
    if (this.pointerDeliverRetried) return
    this.pointerDeliverRetried = true
    console.warn('[pointer]', 'recovering stalled pointer delivery — single retry inject/CRDT')
    if (this.lastInjectPayload) {
      this.worker.postMessage({
        type: 'inject-pointer-click',
        body: this.lastInjectPayload
      } satisfies MainToWorker)
    }
    this.deliverPointerCrdtDirect()
  }

  private armPointerDeliverWatchdog(detail: string): void {
    if (this.pointerDeliverWatchdog) {
      clearTimeout(this.pointerDeliverWatchdog)
      this.pointerDeliverWatchdog = null
    }
    this.pointerDeliverWatchdog = setTimeout(() => {
      if (!this.pointerDeliverAwaitingAck) return
      console.error('[pointer]', `pointer deliver stalled — ${detail}`)
      this.recoverStalledPointerDelivery()
    }, 400)
    if (this.pointerFallbackWatchdog) {
      clearTimeout(this.pointerFallbackWatchdog)
      this.pointerFallbackWatchdog = null
    }
    this.pointerFallbackWatchdog = setTimeout(() => {
      if (this.fallbackPointerEmoteSrc || !this.lastInjectPayload) return
      if (!this.pointerAwaitingWorkerApply && !this.pointerDeliverAwaitingAck) return
      this.tryMainThreadPointerFallback(this.lastInjectPayload)
    }, 1200)
  }

  private clearPointerDeliverWatchdog(): void {
    if (this.pointerDeliverWatchdog) {
      clearTimeout(this.pointerDeliverWatchdog)
      this.pointerDeliverWatchdog = null
    }
    if (this.pointerFallbackWatchdog) {
      clearTimeout(this.pointerFallbackWatchdog)
      this.pointerFallbackWatchdog = null
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

  /** Apply latest client poses to projection before renderer outbound CRDT. */
  private prepareRendererOutboundState(): void {
    if (!this.clientPlayerPose || !this.clientCameraPose) return
    this.reserved.prepareRendererRoundTrip(this.clientPlayerPose, this.clientCameraPose)
    this.syncProjectionReservedTransforms()
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

  /** ECS projection → Three.js — runs during hydration before the worker loop is marked running. */
  async syncRenderer(): Promise<void> {
    if (!this.bridge) return
    const view = this.view

    // Phase 2 default: drive the bridge from the projection diff once assets settle.
    // A full walk still runs during hydration (canConsumeDiff false) and on periodic safety resync.
    const useDiff = this.bridge.canConsumeDiff() && this.fullResyncCountdown > 0
    if (useDiff) {
      const diff = this.pendingDiff
      this.pendingDiff = new Map<Entity, Map<number, ProjectionChangeKind>>()
      this.fullResyncCountdown--
      if (!diff.size) return
      if (!this.projectionDiffActive) {
        this.projectionDiffActive = true
        clientDebugLog.log('projection', 'diff consumer ACTIVE — rendering driven by projection diff (default)', {
          level: 'success',
          alsoConsole: true
        })
      }
      await this.bridge.consumeDiff(diff, view)
      this.collisionDirty = true
      this.flushPointerStructureIfDirty()
      return
    }

    this.bridge.prefetchSceneGlbs()

    // Full walk reconciles everything — discard the accumulated diff so it isn't re-applied.
    this.pendingDiff.clear()
    this.collisionDirty = true
    this.pointerStructureDirty = true
    await this.bridge.sync(view)
    if (this.projectionDiffActive) {
      clientDebugLog.log('projection', 'diff consumer — periodic full-resync (safety pass)', {
        level: 'info',
        throttleMs: 30_000,
        alsoConsole: POINTER_VERBOSE
      })
    }
    this.fullResyncCountdown = FULL_RESYNC_INTERVAL
    this.flushPointerStructureIfDirty()
  }

  /** Hydration done — throttle worker onUpdate and widen full-resync interval for runtime perf. */
  notifyPlayReady(): void {
    this.fullResyncCountdown = FULL_RESYNC_INTERVAL
    this.collisionPoseSyncEvery = COLLISION_POSE_SYNC_RUNTIME
    this.bridgeSyncEvery = BRIDGE_ECS_SYNC_RUNTIME
    this.worker?.postMessage({ type: 'scene-play-ready' } satisfies MainToWorker)
  }

  syncCollision(): void {
    if (!this.collision || !this.bridge) return
    this.collisionPoseTick++
    const periodicPose = this.collisionPoseTick % this.collisionPoseSyncEvery === 0
    const nodes = this.bridge.getEntityNodes()

    if (this.collisionDirty) {
      const view = this.view
      this.collision.sync(view, this.readComponents, nodes)
      this.gltfColliders?.sync(view, this.readComponents, nodes)
      this.collisionDirty = false
      return
    }

    if (!periodicPose) return
    this.collision.syncPoses(nodes)
    this.gltfColliders?.syncPoses(nodes)
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
  pumpMotionBridges(delta: number, tickNumber = 0): void {
    if (!this.running || !this.bridge) return
    this.tweenBridge?.sync(this.view)
    this.videoPlayerBridge?.sync(this.view)
    this.billboardBridge?.update()
    this.avatarShapes?.update(delta)
    this.animatorBridge?.update(delta)
    this.tweenBridge?.update(delta, this.view)
    this.videoPlayerBridge?.update(tickNumber, this.view)
  }

  async syncAsyncBridges(): Promise<void> {
    if (!this.running || !this.bridge) return
    this.bridgeSyncTick++
    if (!this.bridgeDirty && this.bridgeSyncTick % this.bridgeSyncEvery !== 0) return
    this.bridgeDirty = false
    await this.avatarShapes?.sync(this.view)
    this.avatarEmoteBridge?.sync(this.view)
    await this.animatorBridge?.sync(this.view)
  }

  /** @deprecated Prefer pumpMotionBridges + syncAsyncBridges */
  async syncBridges(delta: number): Promise<void> {
    this.pumpMotionBridges(delta)
    await this.syncAsyncBridges()
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
    this.videoPlayerBridge = null
    this.collision?.dispose()
    this.collision = null
    this.gltfColliders?.dispose()
    this.gltfColliders = null
    this.pointerEvents?.dispose()
    this.pointerEvents = null
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
