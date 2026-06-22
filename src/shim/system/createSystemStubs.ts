import type { MovePlayerToRequest, MovePlayerToResponse } from '../../player/movePlayerTo'
import type { OpenExternalUrlRequest, OpenExternalUrlResponse } from '../../player/openExternalUrl'
import type { TriggerEmoteRequest, TriggerEmoteResponse } from '../../player/triggerEmote'
import type { TriggerSceneEmoteRequest, TriggerSceneEmoteResponse } from '../../player/triggerSceneEmote'
import type { CommsRpcHandler, SceneWorkerBoot, SignedFetchGetHeadersResponse, SignedFetchRequest, SignedFetchResponse } from '../types'
import type { EngineApiEventState } from '../engine/EngineApiEventState'

type RpcHandler = {
  crdtSendToRenderer: (data: Uint8Array) => Promise<Uint8Array[]>
  crdtGetState: () => Promise<{ hasEntities: boolean; data: Uint8Array[] }>
  movePlayerTo: (body: MovePlayerToRequest) => Promise<MovePlayerToResponse>
  triggerEmote: (body: TriggerEmoteRequest) => Promise<TriggerEmoteResponse>
  triggerSceneEmote: (body: TriggerSceneEmoteRequest) => Promise<TriggerSceneEmoteResponse>
  openExternalUrl: (body: OpenExternalUrlRequest) => Promise<OpenExternalUrlResponse>
  commsSend: (body: { message: string }) => Promise<Record<string, never>>
  comms: CommsRpcHandler
  signedFetch: (body: SignedFetchRequest) => Promise<SignedFetchResponse>
  signedFetchGetHeaders: (body: SignedFetchRequest) => Promise<SignedFetchGetHeadersResponse>
}

function contentBaseUrl(boot: SceneWorkerBoot['scene']): string {
  const root = boot.contentsBaseUrl.replace(/\/$/, '')
  return boot.worldName ? `${root}/contents/` : `${root}/content/contents/`
}

function assetUrlForHash(boot: SceneWorkerBoot['scene'], hash: string): string {
  return `${contentBaseUrl(boot)}${encodeURIComponent(hash)}`
}

function resolveContentEntry(
  content: SceneWorkerBoot['scene']['content'],
  fileName: string
): { file: string; hash: string } | undefined {
  const direct = content.find((file) => file.file === fileName)
  if (direct) return direct
  if (fileName === 'main.composite') {
    return content.find((file) => file.file === 'assets/scene/main.composite')
  }
  return undefined
}

export function createSystemStubs(
  boot: SceneWorkerBoot['scene'],
  rpc: RpcHandler,
  engineApiEvents: EngineApiEventState
): {
  requireMap: Record<string, unknown>
  engineApi: EngineApiStub
} {
  const engineApi: EngineApiStub = {
    crdtSendToRenderer: async (body: { data: Uint8Array }) => {
      const data = await rpc.crdtSendToRenderer(body.data)
      return { data }
    },
    crdtGetState: async () => rpc.crdtGetState()
  }

  const requireMap = {
    '~system/Runtime': {
      getSceneInformation: async () => ({
        urn: boot.entityId ?? '',
        content: boot.content.map((entry) => ({ file: entry.file, hash: entry.hash })),
        metadataJson: boot.metadataJson,
        baseUrl: contentBaseUrl(boot)
      }),
      getRealm: async () => {
        const res = await rpc.comms.getRealm()
        return res.realmInfo ?? {
          baseUrl: boot.contentsBaseUrl,
          realmName: boot.worldName ?? 'local',
          networkId: 1,
          commsAdapter: '',
          isPreview: true,
          isConnectedSceneRoom: false
        }
      },
      getExplorerInformation: async () => ({
        agent: 'Decentraland/ThreejsClient',
        platform: 'web',
        configurations: {}
      }),
      getWorldTime: async () => ({ seconds: Math.floor(Date.now() / 1000) }),
      readFile: async (body: { fileName: string }) => {
        const cached = boot.preloadedFiles?.[body.fileName]
        if (cached?.content?.byteLength) {
          return { content: cached.content.slice(), hash: cached.hash }
        }
        const entry = resolveContentEntry(boot.content, body.fileName)
        if (!entry) throw new Error(`readFile: ${body.fileName} not found in scene content`)
        const res = await fetch(assetUrlForHash(boot, entry.hash))
        if (!res.ok) throw new Error(`readFile: ${body.fileName} (${res.status})`)
        return { content: new Uint8Array(await res.arrayBuffer()), hash: entry.hash }
      }
    },
    '~system/EngineApi': {
      crdtSendToRenderer: engineApi.crdtSendToRenderer,
      crdtGetState: engineApi.crdtGetState,
      sendBatch: async (_body?: { actions?: unknown[] }) => ({ events: engineApiEvents.drainEvents() }),
      isServer: async () => ({ isServer: false }),
      subscribe: async (body: { eventId: string }) => {
        engineApiEvents.subscribe(body.eventId)
        return {}
      },
      unsubscribe: async (body: { eventId: string }) => {
        engineApiEvents.unsubscribe(body.eventId)
        return {}
      }
    },
    '~system/RestrictedActions': {
      movePlayerTo: async (body: MovePlayerToRequest) => rpc.movePlayerTo(body),
      triggerEmote: async (body: TriggerEmoteRequest) => rpc.triggerEmote(body),
      triggerSceneEmote: async (body: TriggerSceneEmoteRequest) => rpc.triggerSceneEmote(body),
      openExternalUrl: async (body: OpenExternalUrlRequest) => rpc.openExternalUrl(body),
      openNftDialog: async () => ({}),
      setCommunicationsAdapter: async (body: { connectionString: string }) =>
        rpc.comms.setCommunicationsAdapter(body)
    },
    '~system/CommunicationsController': {
      send: async (body: { message: string }) => rpc.commsSend(body),
      sendBinary: async (body: {
        data?: Uint8Array[]
        peerData?: Array<{ data: Uint8Array[]; address: string[] }>
      }) => rpc.comms.sendBinary(body)
    },
    '~system/CommsApi': {
      getActiveVideoStreams: async () => rpc.comms.getActiveVideoStreams(),
      subscribeToTopic: async (body: { topic: string }) => rpc.comms.subscribeToTopic(body),
      unsubscribeFromTopic: async (body: { topic: string }) => rpc.comms.unsubscribeFromTopic(body),
      publishData: async (body: { topic: string; data: string }) => rpc.comms.publishData(body),
      consumeMessages: async (body: { topic: string }) => rpc.comms.consumeMessages(body)
    },
    '~system/UserIdentity': {
      getUserData: async () => rpc.comms.getUserData(),
      getUserPublicKey: async () => {
        const res = await rpc.comms.getUserData()
        return { address: res.data?.publicKey }
      }
    },
    '~system/SignedFetch': {
      signedFetch: async (body: SignedFetchRequest) => rpc.signedFetch(body),
      getHeaders: async (body: SignedFetchRequest) => rpc.signedFetchGetHeaders(body)
    }
  } as Record<string, unknown>

  return {
    requireMap,
    engineApi
  }
}

export type SceneBundleExports = {
  onStart?: () => Promise<void>
  onUpdate?: (dt: number) => Promise<void>
  main?: () => unknown
  /** @dcl/sdk runtime export — used to apply renderer CRDT inbound. */
  rendererTransport?: RendererTransportExport
  /** SDK7 scenes also export the engine singleton. */
  engine?: import('@dcl/ecs').IEngine
}

export type RendererTransportExport = {
  type?: string
  onmessage?: (message: Uint8Array) => void
}

function readOwnOnmessage(
  transport: RendererTransportExport
): ((message: Uint8Array) => void) | undefined {
  const desc = Object.getOwnPropertyDescriptor(transport, 'onmessage')
  if (!desc || desc.get) return undefined
  if ('value' in desc && typeof desc.value === 'function') {
    return desc.value as (message: Uint8Array) => void
  }
  return undefined
}

/** Bind when addTransport assigns rendererTransport.onmessage after bundle eval. */
export function watchRendererTransportOnmessage(
  transport: RendererTransportExport,
  onBound: (onmessage: (chunk: Uint8Array) => void) => void
): void {
  const existing = readOwnOnmessage(transport)
  if (existing) {
    onBound(existing.bind(transport))
    return
  }
  let current: ((message: Uint8Array) => void) | undefined
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: () => current,
    set(fn) {
      current = fn
      if (typeof fn === 'function') onBound(fn.bind(transport))
    }
  })
}

export type EngineApiStub = {
  crdtSendToRenderer: (body: { data: Uint8Array }) => Promise<{ data: Uint8Array[] }>
  crdtGetState: () => Promise<{ hasEntities: boolean; data: Uint8Array[] }>
}

export function evaluateSceneBundle(
  code: string,
  requireMap: Record<string, unknown>,
  transformCode?: (source: string) => string
): SceneBundleExports {
  const require = (id: string) => {
    const mod = requireMap[id]
    if (mod) return mod
    throw new Error(`Cannot find module '${id}'`)
  }
  const module = { exports: {} as SceneBundleExports }
  const source = transformCode ? transformCode(code) : code
  const fn = new Function('require', 'module', 'exports', source)
  fn(require, module, module.exports)
  return module.exports
}
