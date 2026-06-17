import type { ResolvedScene, ContentFile } from '../dcl/content/types'
import type { EngineApiEvent } from './engine/engineApiEvents'
import type { MovePlayerToRequest, MovePlayerToResponse } from '../player/movePlayerTo'
import type { OpenExternalUrlRequest, OpenExternalUrlResponse } from '../player/openExternalUrl'
import type { TriggerEmoteRequest, TriggerEmoteResponse } from '../player/triggerEmote'
import type { TriggerSceneEmoteRequest, TriggerSceneEmoteResponse } from '../player/triggerSceneEmote'
import type { InjectPointerClickBody } from '../player/injectPointerClick'

export type SceneWorkerBoot = {
  type: 'boot'
  scene: Pick<
    ResolvedScene,
    'title' | 'parcels' | 'baseParcel' | 'spawn' | 'contentsBaseUrl' | 'entityId' | 'mainEntry'
  > & {
    worldName?: string
    scriptUrl: string
    content: ContentFile[]
    metadataJson: string
  }
}

export type SceneWorkerCrdtRequest = {
  type: 'crdt-send'
  id: number
  data: Uint8Array
}

export type SceneWorkerReady = { type: 'ready' }
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
  | SceneWorkerError
  | SceneWorkerLog
  | SceneWorkerCrdtRequest
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
  | { type: 'scene-play-ready' }
  | { type: 'pointer-crdt-deliver'; data: Uint8Array[] }
  | { type: 'inject-pointer-click'; body: InjectPointerClickBody }

export type CrdtGetStateResponse = {
  hasEntities: boolean
  data: Uint8Array[]
}

export type CommsTopicRequest = { topic: string }
export type CommsPublishDataRequest = { topic: string; data: string }
export type CommsTopicMessage = { sender: string; data: string }
export type ConsumeMessagesResponse = { messages: CommsTopicMessage[] }
export type ActiveVideoStreamsResponse = { streams: never[] }

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
