import type { ResolvedScene, ContentFile } from '../dcl/content/types'
import type { EngineApiEvent } from './engine/engineApiEvents'
import type { ChangeRealmRequest, ChangeRealmResponse } from '../player/changeRealm'
import type { CopyToClipboardRequest, CopyToClipboardResponse } from '../player/copyToClipboard'
import type { MovePlayerToRequest, MovePlayerToResponse } from '../player/movePlayerTo'
import type { OpenExternalUrlRequest, OpenExternalUrlResponse } from '../player/openExternalUrl'
import type { OpenNftDialogRequest, OpenNftDialogResponse } from '../player/openNftDialog'
import type { TeleportToRequest, TeleportToResponse } from '../player/teleportTo'
import type { TriggerEmoteRequest, TriggerEmoteResponse } from '../player/triggerEmote'
import type { TriggerSceneEmoteRequest, TriggerSceneEmoteResponse } from '../player/triggerSceneEmote'
import type {
  SetCameraTransformRequest,
  SetCameraTransformResponse
} from '../player/setCameraTransform'
import type { InjectPointerClickBody } from '../player/injectPointerClick'

export type AvatarAttachTransformEntry = {
  entity: number
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
  /** PlayerEntity (or remote player) — worker Transform parent for Hle/getWorldPosition. */
  parent?: number
}

/** Client hardware heuristic — passed to the scene worker for timing budgets. */
export type PerformanceTier = 'low' | 'medium' | 'high'

export type SceneWorkerDebugFlags = {
  /** `?sceneinputsnapshot` — log scene-input-snapshot apply on the worker. */
  sceneInputSnapshot?: boolean
  /** `?pointerverbose` — log PE inject + light renderer inbound (historical: pointer-crdt-deliver) in the worker. */
  pointerDeliver?: boolean
  /** `?tweenverbose` — log tween-state inject / push in the worker. */
  tweenDeliver?: boolean
  /** Log every worker onmessage arrival (`onmessage #N type=…`). */
  messageArrival?: boolean
  /** `?notheatre` — skip Genesis theatre runShowSetup + Scene 11/12 registration. */
  skipTheatre?: boolean
  /** `?sceneuilog` — throttled worker outbound + main repaint logs for scene UI sync. */
  sceneUiLog?: boolean
  /** `?sceneloop=1` — play-frame `source`/`dt`/`inFlight` walk-log line. */
  sceneLoop?: boolean
}

/** Host-owned reserved store seed — Explorer has these on the scene engine before the first tick. */
export type HostReservedSceneStore = {
  playerIdentity?: {
    userId: string
    displayName?: string
    hasConnectedWeb3?: boolean
  }
  realmInfo?: {
    baseUrl: string
    realmName: string
    networkId: number
    commsAdapter: string
    isPreview: boolean
    room?: string
    isConnectedSceneRoom: boolean
  }
}

export type SceneWorkerBoot = {
  type: 'boot'
  /** Live interactable px — worker seeds UiCanvasInformation (not SDK 7.26 1920×1080). */
  canvas?: { width: number; height: number }
  /**
   * Host loading overlay is covering the canvas — freeze scene-visible dt until release.
   * Primary Jump In / teleport only; PE / secondary boots leave this unset.
   */
  holdSceneTime?: boolean
  debug?: SceneWorkerDebugFlags
  /**
   * PlayerIdentityData + RealmInfo for the worker scene store.
   * SDK `@dcl/sdk/network` isRoomReady / joinRoster read these on the first sendBinary.
   */
  reserved?: HostReservedSceneStore
  scene: Pick<
    ResolvedScene,
    'title' | 'parcels' | 'baseParcel' | 'spawn' | 'contentsBaseUrl' | 'entityId' | 'mainEntry'
  > & {
    worldName?: string
    scriptUrl: string
    /**
     * UTF-8 script bytes — preferred for multi-MB worlds (transferable; zero-copy to worker).
     * Prefer over `scriptBlobUrl` / `scriptCode` so the worker does not re-fetch or re-clone.
     */
    scriptBytes?: Uint8Array
    /** Blob URL for main-thread-fetched script — avoids cloning multi-MB source in postMessage. */
    scriptBlobUrl?: string
    /** Inline script (fallback only — prefer `scriptBytes` / `scriptBlobUrl`). */
    scriptCode?: string
    /** Renderer CRDT snapshot for sync bundle eval (avoids get-state deadlock in worker). */
    bootCrdtSnapshot?: { hasEntities: boolean; data: Uint8Array[] }
    /** Scene files preloaded on main (composite, etc.) — avoids worker fetch during eval/onStart. */
    preloadedFiles?: Record<string, { hash: string; content: Uint8Array }>
    content: ContentFile[]
    metadataJson: string
  }
}

export type SceneWorkerCrdtRequest = {
  type: 'crdt-send'
  id: number
  data: Uint8Array
}

/** Structured worker UI row — pointer phase 4; main applies without wire deserialize. */
export type WorkerUiMountSnapshotRow = {
  entity: number
  componentId: number
  value: unknown
}

/** Phase C — worker outbound; main applies then `crdt-outbound-ack` + `renderer-inbound-deliver`. */
export type SceneWorkerCrdtOutbound = {
  type: 'crdt-outbound'
  data: Uint8Array
  /** Correlates with `crdt-outbound-ack` for non-empty payloads (worker awaits before next tick). */
  id?: number
  /** Worker engine UiTransform entity ids after this CRDT tick — authoritative mount set for DOM. */
  uiEntities?: number[]
  /** Pointer mount batch — plain component values; bypasses CRDT wire deserialize on main. */
  uiMountSnapshot?: WorkerUiMountSnapshotRow[]
}

export type SceneWorkerReady = {
  type: 'ready'
  /** Initial worker UiTransform mount set — same authority as crdt-outbound.uiEntities. */
  uiEntities?: number[]
}
/** Bundle eval finished — main may start asset hydration while onStart runs. */
export type SceneWorkerEvalDone = { type: 'eval-done' }
/** Heartbeat while patching/compiling multi-MB bundles — main extends boot timeout. */
export type SceneWorkerCompileProgress = {
  type: 'compile-progress'
  phase: string
  elapsedMs: number
  scriptKb?: number
}
export type SceneWorkerError = { type: 'error'; message: string }
export type SceneWorkerLog = { type: 'log'; message: string }

export type SceneWorkerMovePlayerTo = {
  type: 'move-player-to'
  id: number
  body: MovePlayerToRequest
}

export type SceneWorkerTeleportTo = {
  type: 'teleport-to'
  id: number
  body: TeleportToRequest
}

export type SceneWorkerChangeRealm = {
  type: 'change-realm'
  id: number
  body: ChangeRealmRequest
}

export type SceneWorkerCopyToClipboard = {
  type: 'copy-to-clipboard'
  id: number
  body: CopyToClipboardRequest
}

export type SceneWorkerTriggerEmote = {
  type: 'trigger-emote'
  id: number
  body: TriggerEmoteRequest
}

/** Scene code → ShaderManager. Fire-and-forget (`tjs.shader(name, fn, params)`). */
export type SceneWorkerTjsShader = {
  type: 'tjs-shader'
  name: string
  fn: string
  params: Record<string, string>
}

export type SceneWorkerTriggerSceneEmote = {
  type: 'trigger-scene-emote'
  id: number
  body: TriggerSceneEmoteRequest
}

export type SceneWorkerOpenExternalUrl = {
  type: 'open-external-url'
  id: number
  body: OpenExternalUrlRequest
}

export type SceneWorkerSetCameraTransform = {
  type: 'set-camera-transform'
  id: number
  body: SetCameraTransformRequest
}

export type SceneWorkerOpenNftDialog = {
  type: 'open-nft-dialog'
  id: number
  body: OpenNftDialogRequest
}

export type CommsAdapterRequest = { connectionString: string }

export type SendBinaryRequest = {
  data?: Uint8Array[]
  peerData?: Array<{ data: Uint8Array[]; address: string[] }>
}

export type SendBinaryResponse = { data: Uint8Array[] }

export type UserDataResponse = {
  data?: {
    displayName: string
    publicKey?: string
    hasConnectedWeb3: boolean
    userId: string
    version: number
    avatar?: {
      bodyShape: string
      skinColor: string
      hairColor: string
      eyeColor: string
      wearables: string[]
      snapshots?: { face256: string; body: string }
    }
  }
}

export type RealmResponse = {
  realmInfo?: {
    baseUrl: string
    realmName: string
    networkId: number
    commsAdapter: string
    isPreview: boolean
    room?: string
    isConnectedSceneRoom?: boolean
  }
}

export type SceneWorkerSetCommsAdapter = {
  type: 'set-comms-adapter'
  id: number
  body: CommsAdapterRequest
}

export type SceneWorkerSendBinary = {
  type: 'comms-send-binary'
  id: number
  body: SendBinaryRequest
}

export type SceneWorkerCommsSend = {
  type: 'comms-send'
  id: number
  body: { message: string }
}

export type SceneWorkerGetUserData = { type: 'get-user-data'; id: number }
export type SceneWorkerGetRealm = { type: 'get-realm'; id: number }
export type SceneWorkerSubscribeTopic = { type: 'comms-subscribe-topic'; id: number; body: CommsTopicRequest }
export type SceneWorkerUnsubscribeTopic = { type: 'comms-unsubscribe-topic'; id: number; body: CommsTopicRequest }
export type SceneWorkerPublishData = { type: 'comms-publish-data'; id: number; body: CommsPublishDataRequest }
export type SceneWorkerConsumeMessages = { type: 'comms-consume-messages'; id: number; body: CommsTopicRequest }
export type SceneWorkerGetActiveVideoStreams = { type: 'comms-get-active-video-streams'; id: number }
export type SceneWorkerSignedFetch = { type: 'signed-fetch'; id: number; body: SignedFetchRequest }
export type SceneWorkerSignedFetchGetHeaders = {
  type: 'signed-fetch-get-headers'
  id: number
  body: SignedFetchRequest
}

export type PlayerFrameBoundVcTransform = {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
  parent?: number
}

/** Bound MainCamera→VC snapshot for main projection (Transform + VirtualCamera + anchors). */
export type PlayerFrameBoundVc = {
  entity: number
  virtualCamera: unknown
  /**
   * VC Transform for main.
   * - Follow rig (parent===lookAt): local + parent hierarchy via `anchors`.
   * - Cinematic tween rig (VC child of Transform-only parents): locals + ancestor anchors.
   * - Locked/select stage: **worker world pose under Root** (`worldFlattened`).
   */
  transform: PlayerFrameBoundVcTransform
  /** Parent / lookAt anchors (follow, cinematic tween chain, or flattened lookAt). */
  anchors: Array<{ entity: number; transform: PlayerFrameBoundVcTransform }>
  /** True when `transform` is already world-space under RootEntity (do not re-parent on main). */
  worldFlattened?: boolean
}

export type SceneWorkerOutbound =
  | SceneWorkerReady
  | SceneWorkerEvalDone
  | SceneWorkerCompileProgress
  | SceneWorkerError
  | SceneWorkerLog
  | SceneWorkerCrdtRequest
  | SceneWorkerCrdtOutbound
  | SceneWorkerMovePlayerTo
  | SceneWorkerTeleportTo
  | SceneWorkerChangeRealm
  | SceneWorkerCopyToClipboard
  | SceneWorkerTriggerEmote
  | SceneWorkerTjsShader
  | SceneWorkerTriggerSceneEmote
  | SceneWorkerOpenExternalUrl
  | SceneWorkerOpenNftDialog
  | SceneWorkerSetCameraTransform
  | SceneWorkerSetCommsAdapter
  | SceneWorkerSendBinary
  | SceneWorkerCommsSend
  | SceneWorkerGetUserData
  | SceneWorkerGetRealm
  | SceneWorkerSubscribeTopic
  | SceneWorkerUnsubscribeTopic
  | SceneWorkerPublishData
  | SceneWorkerConsumeMessages
  | SceneWorkerGetActiveVideoStreams
  | SceneWorkerSignedFetch
  | SceneWorkerSignedFetchGetHeaders
  | { type: 'engine-api-subscribe'; eventId: string }
  | { type: 'engine-api-unsubscribe'; eventId: string }
  | { type: 'crdt-get-state'; id: number }
  | { type: 'pointer-deliver-done' }
  /** Worker finished the play-frame that SceneLoop marked in-flight (or declined a new tick). */
  | { type: 'play-frame-done' }
  /** Applied guest tick — HUD last dt/source. Not a second clock. */
  | {
      type: 'scene-loop-tick'
      source: 'play-frame' | 'pointer-edge' | 'hydrate'
      dt: number
    }
  | { type: 'ui-virtual-canvas'; width: number; height: number }
  /** Bound VC world Transform — bypasses CRDT ack latency for lens + gizmo pose sync. */
  | {
      type: 'vc-pose-live'
      entity: number
      transform: PlayerFrameBoundVcTransform
    }
  /**
   * Structural hydrate for bound MainCamera→VirtualCamera (Transform + VirtualCamera + ancestors).
   * Posted before player-frame when bind graph changes. player-frame stays IM + MainCamera only.
   */
  | {
      type: 'vc-bind-hydrate'
      bind: PlayerFrameBoundVc
      graphKey: string
    }
  /**
   * Hot player state — InputModifier + MainCamera without CRDT ack (play mode).
   * See docs/ARCHITECTURE.md (player-frame hot path).
   */
  | {
      type: 'player-frame'
      frameId: number
      inputModifierHas: boolean
      inputModifier?: unknown
      mainCamera: unknown
    }

export type MainToWorker =
  | SceneWorkerBoot
  | { type: 'crdt-response'; id: number; data: Uint8Array[] }
  | { type: 'crdt-get-state-response'; id: number; hasEntities: boolean; data: Uint8Array[] }
  | { type: 'move-player-to-response'; id: number; body: MovePlayerToResponse }
  | { type: 'teleport-to-response'; id: number; body: TeleportToResponse }
  | { type: 'change-realm-response'; id: number; body: ChangeRealmResponse }
  | { type: 'copy-to-clipboard-response'; id: number; body: CopyToClipboardResponse }
  | { type: 'trigger-emote-response'; id: number; body: TriggerEmoteResponse }
  | { type: 'trigger-scene-emote-response'; id: number; body: TriggerSceneEmoteResponse }
  | { type: 'open-external-url-response'; id: number; body: OpenExternalUrlResponse }
  | { type: 'open-nft-dialog-response'; id: number; body: OpenNftDialogResponse }
  | { type: 'set-camera-transform-response'; id: number; body: SetCameraTransformResponse }
  | { type: 'set-comms-adapter-response'; id: number; body: { success: boolean } }
  | { type: 'comms-send-binary-response'; id: number; body: SendBinaryResponse }
  | { type: 'get-user-data-response'; id: number; body: UserDataResponse }
  | { type: 'get-realm-response'; id: number; body: RealmResponse }
  | { type: 'comms-subscribe-topic-response'; id: number; body: Record<string, never> }
  | { type: 'comms-unsubscribe-topic-response'; id: number; body: Record<string, never> }
  | { type: 'comms-publish-data-response'; id: number; body: Record<string, never> }
  | { type: 'comms-consume-messages-response'; id: number; body: ConsumeMessagesResponse }
  | { type: 'comms-get-active-video-streams-response'; id: number; body: ActiveVideoStreamsResponse }
  | { type: 'signed-fetch-response'; id: number; body: SignedFetchResponse }
  | { type: 'signed-fetch-get-headers-response'; id: number; body: SignedFetchGetHeadersResponse }
  | { type: 'comms-send-response'; id: number; body: Record<string, never> }
  | { type: 'engine-api-enqueue'; events: EngineApiEvent[] }
  | { type: 'comms-receive-binary'; sender: string; data: Uint8Array }
  /**
   * LiveKit scene-binary already encoded for BinaryMessageBus (same bytes as
   * sendBinary response). Push on arrival so AUTH_CRDT / CUSTOM_EVENT do not wait
   * for the next empty sendBinary poll.
   */
  | { type: 'comms-inbound-push'; data: Uint8Array[] }
  | { type: 'pause-scene-ticks'; paused?: boolean }
  /** Hydration — skip exports.onUpdate only; engine.update still runs for composite CRDT. */
  | { type: 'pause-scene-onupdate'; paused?: boolean }
  /**
   * Host loading overlay covering play — engine.update(0) so splash/addSystem clocks
   * do not burn under the overlay. Release after overlay dismiss + scene UI reveal.
   */
  | { type: 'hold-scene-time-for-host-overlay'; held: boolean }
  | {
      type: 'scene-play-ready'
      performanceTier?: PerformanceTier
      /** Genesis-scale composite — start with relaxed onUpdate before adaptive abort kicks in. */
      plazaScale?: boolean
      /** Override engine tick interval (ms) — from `?scenetick=` on main. */
      engineTickIntervalMs?: number
      /**
       * Portable experience / smart wearable worker.
       * Skips SpaceRunner-style load-gate InputModifier force-clear (PE drone freezes are intentional
       * and survive GLB FINISHED; force-clear was wiping freeze + breaking WASD flight).
       */
      portableExperience?: boolean
      /** Late refresh of reserved identity / RealmInfo (scene room connect after boot). */
      reserved?: HostReservedSceneStore
    }
  /**
   * Light main→worker renderer CRDT (grow-only / ambient LWW). Historical name —
   * not PE edges (those are `inject-pointer-click` only). Does not open deliver-done.
   */
  | { type: 'pointer-crdt-deliver'; data: Uint8Array[] }
  | { type: 'tween-state-deliver'; data: Uint8Array[] }
  | { type: 'renderer-append-deliver'; data: Uint8Array[] }
  /**
   * Main→worker renderer inbound that must not open the pointer pause path
   * (e.g. GltfContainerLoadingState mid-onStart). Same light apply family as
   * pointer-crdt-deliver; separate type for boot-safe routing.
   */
  | { type: 'renderer-inbound-deliver'; data: Uint8Array[] }
  | { type: 'crdt-outbound-ack'; id: number }
  | { type: 'inject-pointer-click'; body: InjectPointerClickBody; injectOnly?: boolean }
  /** Main: player pressed WASD/Space while mode-only sit freeze stuck — clear worker IM. */
  | { type: 'force-locomotion-clear'; reason?: string }
  | { type: 'pump-scene-engine-tick' }
  /** Main: MainCamera bound but VC Transform/VirtualCamera still missing — one-shot hydrate pull. */
  | { type: 'request-vc-bind-hydrate' }
  /**
   * Phase 2 — main rAF drives one unified worker play frame (engine.update + pollEvents).
   * Optional reserved poses apply *before* systems (CameraFollowSystem reads PlayerEntity).
   */
  | {
      type: 'play-frame-tick'
      player?: {
        position: { x: number; y: number; z: number }
        rotation: { x: number; y: number; z: number; w: number }
      }
      camera?: {
        position: { x: number; y: number; z: number }
        rotation: { x: number; y: number; z: number; w: number }
      }
      /**
       * Host PrimaryPointerInfo for this frame (plaza fishing bobber aim).
       * Applied before engine.update so systems see a live ray even when CRDT
       * dirty-only outbound is delayed by a long scene tick.
       */
      primaryPointer?: {
        pointerType: number
        screenCoordinates: { x: number; y: number }
        screenDelta: { x: number; y: number }
        worldRayDirection: { x: number; y: number; z: number }
      }
      /**
       * AvatarAttach relative Transform — applied after PE write, before systems.
       * Explorer: bone pose is on the store when getWorldPosition/Hle runs (fishing line).
       */
      avatarAttach?: AvatarAttachTransformEntry[]
      /**
       * Renderer Tween interpolated Transform — Explorer writes these on the scene
       * store (`scale.y` UI, cinematic parents) before the next engine.update.
       */
      tweenTransforms?: AvatarAttachTransformEntry[]
    }
  /** Level keyboard state — authoritative worker input path (phase 2). */
  | { type: 'scene-input-snapshot'; body: import('../player/sceneInputSnapshot').SceneInputSnapshotBody }
  | { type: 'avatar-attach-transforms'; entries: AvatarAttachTransformEntry[] }

export type CrdtGetStateResponse = {
  hasEntities: boolean
  data: Uint8Array[]
}

export type CommsTopicRequest = { topic: string }
export type CommsPublishDataRequest = { topic: string; data: string }
export type CommsTopicMessage = { sender: string; data: string }
export type ConsumeMessagesResponse = { messages: CommsTopicMessage[] }
export type ActiveVideoStream = {
  identity: string
  trackSid: string
  /** Matches `VideoTrackSourceType` in comms_api.proto (0 unknown, 1 camera, 2 screen share). */
  sourceType: number
}

export type ActiveVideoStreamsResponse = { streams: ActiveVideoStream[] }

export type SignedFetchInit = {
  method?: string
  body?: string
  headers?: Record<string, string> | Array<{ key: string; value: string }>
}

export type SignedFetchRequest = {
  url: string
  init?: SignedFetchInit
}

export type SignedFetchResponse = {
  ok: boolean
  status: number
  statusText: string
  body: string
  headers: Record<string, string>
}

export type SignedFetchGetHeadersResponse = {
  headers: Record<string, string>
}

export type SignedFetchHandler = (body: SignedFetchRequest) => Promise<SignedFetchResponse>
export type SignedFetchGetHeadersHandler = (
  body: SignedFetchRequest
) => Promise<SignedFetchGetHeadersResponse>

export type CommsRpcHandler = {
  setCommunicationsAdapter: (body: CommsAdapterRequest) => Promise<{ success: boolean }>
  send: (body: { message: string }) => Promise<Record<string, never>>
  sendBinary: (body: SendBinaryRequest) => Promise<SendBinaryResponse>
  getUserData: () => Promise<UserDataResponse>
  getRealm: () => Promise<RealmResponse>
  subscribeToTopic: (body: CommsTopicRequest) => Promise<Record<string, never>>
  unsubscribeFromTopic: (body: CommsTopicRequest) => Promise<Record<string, never>>
  publishData: (body: CommsPublishDataRequest) => Promise<Record<string, never>>
  consumeMessages: (body: CommsTopicRequest) => Promise<ConsumeMessagesResponse>
  getActiveVideoStreams: () => Promise<ActiveVideoStreamsResponse>
}
