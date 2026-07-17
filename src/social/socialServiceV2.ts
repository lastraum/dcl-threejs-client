/**
 * Minimal Social Service v2 WebSocket client (Explorer / companion path).
 * Used for community voice end + SubscribeToCommunityVoiceChatUpdates.
 */
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { createRpcClient } from '@dcl/rpc/dist/client'
import { loadService } from '@dcl/rpc/dist/codegen'
import type { RpcClientPort } from '@dcl/rpc/dist/types'
import { Empty } from '@dcl/protocol/out-ts/google/protobuf/empty.gen'
import {
  CommunityVoiceChatStatus,
  EndCommunityVoiceChatPayload,
  SocialServiceDefinition,
  type CommunityVoiceChatUpdate,
  type EndCommunityVoiceChatResponse
} from '@dcl/protocol/out-ts/decentraland/social_service/v2/social_service_v2.gen'
import { createWebSocketsTransport } from '@dcl/social-rpc-client/dist/transport'
import { signedHeaderFactory } from 'decentraland-crypto-fetch'

export { CommunityVoiceChatStatus }
export type { CommunityVoiceChatUpdate }

const SOCIAL_RPC_WS_DEFAULT = 'wss://rpc-social-service-ea.decentraland.org'
const signHeader = signedHeaderFactory()

/** Protocol / @dcl/rpc Writer types can diverge — keep a thin untyped facade. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SocialServiceClient = any

let transport: ReturnType<typeof createWebSocketsTransport> | null = null
let port: RpcClientPort | null = null
let loadedService: SocialServiceClient | null = null
let connectPromise: Promise<SocialServiceClient> | null = null
let lastIdentityKey: string | null = null

function identityKey(id: AuthIdentity): string {
  const addr = String(id.ephemeralIdentity?.address ?? '').toLowerCase()
  const exp =
    id.expiration instanceof Date
      ? id.expiration.getTime()
      : new Date(id.expiration as unknown as string | number).getTime()
  return `${addr}::${Number.isFinite(exp) ? exp : 0}`
}

function socialRpcWsUrl(): string {
  const env = (import.meta.env.VITE_SOCIAL_SERVICE_RPC_URL as string | undefined)?.trim()
  return (env || SOCIAL_RPC_WS_DEFAULT).replace(/\/$/, '')
}

function errorDetail(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err ?? '')
}

function unwrapEnd(res: EndCommunityVoiceChatResponse): void {
  const r = res.response
  if (!r) throw new Error('social_rpc: end_community_voice_empty_response')
  switch (r.$case) {
    case 'ok':
      return
    case 'invalidRequest':
      throw new Error(`social_rpc: invalid_request — ${r.invalidRequest.message ?? ''}`)
    case 'forbiddenError':
      throw new Error(`social_rpc: forbidden — ${r.forbiddenError.message ?? ''}`)
    case 'notFoundError':
      throw new Error(`social_rpc: not_found — ${r.notFoundError.message ?? ''}`)
    case 'internalServerError':
      throw new Error(`social_rpc: internal — ${r.internalServerError.message ?? ''}`)
    default:
      throw new Error('social_rpc: end_community_voice_unknown_response')
  }
}

function disconnect(): void {
  lastIdentityKey = null
  loadedService = null
  if (port) {
    try {
      port.close()
    } catch {
      /* ignore */
    }
    port = null
  }
  if (transport) {
    try {
      transport.close()
    } catch {
      /* ignore */
    }
    transport = null
  }
}

async function connectWithUrl(wsUrl: string, id: AuthIdentity): Promise<SocialServiceClient> {
  const webSocketsTransport = createWebSocketsTransport(wsUrl)
  transport = webSocketsTransport

  const signedHeaders = signHeader(id as Parameters<typeof signHeader>[0], 'GET', '/', {})
  const signedHeadersEntries: Record<string, string> = {}
  signedHeaders.forEach((value, key) => {
    signedHeadersEntries[key] = value
  })

  let connectPhase = true
  const promiseOfAuthorization = new Promise<void>((resolve, reject) => {
    webSocketsTransport.on('connect', () => {
      try {
        webSocketsTransport.sendMessage(new TextEncoder().encode(JSON.stringify(signedHeadersEntries)))
        resolve()
      } catch (e) {
        reject(e)
      }
    })
  })

  const transportFailed = new Promise<never>((_, reject) => {
    const fail = (detail: string) => {
      if (!connectPhase) return
      connectPhase = false
      reject(new Error(`Social service WebSocket (${wsUrl}): ${detail}`))
    }
    webSocketsTransport.on('error', (err: unknown) => {
      fail(errorDetail(err) || 'socket_error')
    })
    webSocketsTransport.on('close', () => {
      fail('connection_closed')
    })
  })

  webSocketsTransport.connect()

  try {
    const rpcClient = await Promise.race([createRpcClient(webSocketsTransport), transportFailed])
    await Promise.race([promiseOfAuthorization, transportFailed])
    const p = await Promise.race([rpcClient.createPort('social'), transportFailed])
    port = p
    // Cast: @dcl/protocol protobufjs Writer vs @dcl/rpc expected Writer mismatch.
    const loaded = loadService(p, SocialServiceDefinition as never) as SocialServiceClient
    loadedService = loaded
    connectPhase = false
    return loaded
  } catch (e) {
    connectPhase = false
    throw e
  }
}

export async function ensureSocialV2ServiceConnected(identity: AuthIdentity): Promise<SocialServiceClient> {
  const key = identityKey(identity)
  if (loadedService && lastIdentityKey === key) return loadedService
  if (connectPromise) return connectPromise

  if (loadedService || port || transport) disconnect()

  connectPromise = (async () => {
    const wsUrl = socialRpcWsUrl()
    try {
      const loaded = await connectWithUrl(wsUrl, identity)
      lastIdentityKey = key
      return loaded
    } catch (e) {
      disconnect()
      throw e
    }
  })()

  try {
    return await connectPromise
  } finally {
    connectPromise = null
  }
}

/** Owner/moderator: end community voice for everyone. */
export async function endCommunityVoiceChatViaSocialRpc(
  identity: AuthIdentity,
  communityId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = communityId.trim()
  if (!id) return { ok: false, error: 'community_id_required' }
  try {
    const svc = await ensureSocialV2ServiceConnected(identity)
    const res = (await svc.endCommunityVoiceChat(
      EndCommunityVoiceChatPayload.create({ communityId: id })
    )) as EndCommunityVoiceChatResponse
    unwrapEnd(res)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Server stream: community voice started / ended.
 * Resolves when the stream ends; throws on transport errors (caller should retry).
 */
export async function consumeCommunityVoiceChatUpdates(
  identity: AuthIdentity,
  onUpdate: (update: CommunityVoiceChatUpdate) => void,
  signal: AbortSignal
): Promise<void> {
  const svc = await ensureSocialV2ServiceConnected(identity)
  const stream = svc.subscribeToCommunityVoiceChatUpdates(Empty.create()) as AsyncIterable<CommunityVoiceChatUpdate>
  try {
    for await (const update of stream) {
      if (signal.aborted) return
      onUpdate(update)
    }
  } catch (e) {
    if (signal.aborted) return
    throw e
  }
}

export function disconnectSocialV2Service(): void {
  disconnect()
}
