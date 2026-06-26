import type { ResolvedScene, ContentFile } from '../dcl/content/types'
import type { EngineApiEvent } from './engine/engineApiEvents'
import type { MovePlayerToRequest, MovePlayerToResponse } from '../player/movePlayerTo'
import type { OpenExternalUrlRequest, OpenExternalUrlResponse } from '../player/openExternalUrl'
import type { TriggerEmoteRequest, TriggerEmoteResponse } from '../player/triggerEmote'
import type { TriggerSceneEmoteRequest, TriggerSceneEmoteResponse } from '../player/triggerSceneEmote'
import type { InjectPointerClickBody } from '../player/injectPointerClick'

export type AvatarAttachTransformEntry = {
  entity: number
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
}

/** Client hardware heuristic — passed to the scene worker for timing budgets. */
export type PerformanceTier = 'low' | 'medium' | 'high'

export type SceneWorkerDebugFlags = {
  /** `?pointerverbose` — log pointer-crdt-deliver round-trips in the worker. */
  pointerDeliver?: boolean
  /** `?tweenverbose` — log tween-state inject / push in the worker. */
  tweenDeliver?: boolean
  /** Log every worker onmessage arrival (`onmessage #N type=…`). */
  messageArrival?: boolean
  /** `?notheatre` — skip Genesis theatre runShowSetup + Scene 11/12 registration. */
  skipTheatre?: boolean
  /** One-way worker→main outbound after play-ready (default on; `?roundtripcrdt` opts out). */
  oneWayCrdt?: boolean
}

export type SceneWorkerBoot = {
  type: 'boot'
  debug?: SceneWorkerDebugFlags
  scene: Pick<
    ResolvedScene,
    'title' | 'parcels' | 'baseParcel' | 'spawn' | 'contentsBaseUrl' | 'entityId' | 'mainEntry'
  > & {
    worldName?: string
    scriptUrl: string
    /** Blob URL for main-thread-fetched script — avoids cloning multi-MB source in postMessage. */
    scriptBlobUrl?: string
    /** Inline script (fallback only — prefer `scriptBlobUrl`). */
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

/** Phase C — fire-and-forget worker outbound; main replies via `renderer-inbound-deliver`. */
export type SceneWorkerCrdtOutbound = {
  type: 'crdt-outbound'
  data: Uint8Array
}

export type SceneWorkerReady = { type: 'ready' }
/** Bundle eval finished — main may start asset hydration while onStart runs. */
export type SceneWorkerEvalDone = { type: 'eval-done' }
export type SceneWorkerError = { type: 'error'; message: string }
export type SceneWorkerLog = { type: 'log'; message: string }

export type SceneWorkerMovePlayerTo = {
  type: 'move-player-to'
  id: number
  body: MovePlayerToRequest
}

export type SceneWorkerTriggerEmote = {
  type: 'trigger-emote'
  id: number
  body: TriggerEmoteRequest
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

export type SceneWorkerOutbound =
  | SceneWorkerReady
  | SceneWorkerEvalDone
  | SceneWorkerError
  | SceneWorkerLog
  | SceneWorkerCrdtRequest
  | SceneWorkerCrdtOutbound
  | SceneWorkerMovePlayerTo
  | SceneWorkerTriggerEmote
  | SceneWorkerTriggerSceneEmote
  | SceneWorkerOpenExternalUrl
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

export type MainToWorker =
  | SceneWorkerBoot
  | { type: 'crdt-response'; id: number; data: Uint8Array[] }
  | { type: 'crdt-get-state-response'; id: number; hasEntities: boolean; data: Uint8Array[] }
  | { type: 'move-player-to-response'; id: number; body: MovePlayerToResponse }
  | { type: 'trigger-emote-response'; id: number; body: TriggerEmoteResponse }
  | { type: 'trigger-scene-emote-response'; id: number; body: TriggerSceneEmoteResponse }
  | { type: 'open-external-url-response'; id: number; body: OpenExternalUrlResponse }
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
  | { type: 'pause-scene-ticks'; paused?: boolean }
  /** Hydration — skip exports.onUpdate only; engine.update still runs for composite CRDT. */
  | { type: 'pause-scene-onupdate'; paused?: boolean }
  | {
      type: 'scene-play-ready'
      performanceTier?: PerformanceTier
      /** Genesis-scale composite — start with relaxed onUpdate before adaptive abort kicks in. */
      plazaScale?: boolean
      /** Override engine tick interval (ms) — from `?scenetick=` on main. */
      engineTickIntervalMs?: number
    }
  | { type: 'pointer-crdt-deliver'; data: Uint8Array[] }
  | { type: 'tween-state-deliver'; data: Uint8Array[] }
  | { type: 'renderer-append-deliver'; data: Uint8Array[] }
  /** Phase C — main→worker renderer-owned inbound after async outbound apply. */
  | { type: 'renderer-inbound-deliver'; data: Uint8Array[] }
  | { type: 'inject-pointer-click'; body: InjectPointerClickBody }
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
