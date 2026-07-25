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
  ConnectivityStatus,
  EndCommunityVoiceChatPayload,
  GetFriendsPayload,
  GetFriendshipRequestsPayload,
  SocialServiceDefinition,
  UpsertFriendshipPayload,
  User,
  type CommunityVoiceChatUpdate,
  type EndCommunityVoiceChatResponse,
  type FriendConnectivityUpdate,
  type FriendProfile,
  type FriendshipRequestResponse,
  type PaginatedFriendshipRequestsResponse,
  type PaginatedFriendsProfilesResponse,
  type UpsertFriendshipResponse
} from '@dcl/protocol/out-ts/decentraland/social_service/v2/social_service_v2.gen'
import { createWebSocketsTransport } from '@dcl/social-rpc-client/dist/transport'
import { signedHeaderFactory } from 'decentraland-crypto-fetch'

/** Display seed from social-rpc FriendProfile (name + face URL + profile name color). */
export type FriendshipDisplayHint = {
  displayName: string
  faceUrl: string | null
  nameColor: string | null
}

function color3ToCss(c: { r: number; g: number; b: number } | undefined | null): string | null {
  if (!c || typeof c.r !== 'number' || typeof c.g !== 'number' || typeof c.b !== 'number') return null
  const ch = (v: number) => Math.round(v <= 1 ? Math.max(0, Math.min(1, v)) * 255 : Math.max(0, Math.min(255, v)))
  return `rgb(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)})`
}

/** Friendship graph + optional display hints (mirrors friendshipsApi.FriendshipSnapshot). */
export type FriendshipAddressSnapshot = {
  friends: Set<string>
  incoming: Set<string>
  outgoing: Set<string>
  /** Lowercased address → name/face from GetFriends / request payloads. */
  displayHints: Map<string, FriendshipDisplayHint>
}

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

function normalizeAddr(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(t) ? t : null
}

function friendProfileAddress(p: FriendProfile | undefined | null): string | null {
  return normalizeAddr(p?.address)
}

function seedFromFriendProfile(
  hints: Map<string, FriendshipDisplayHint>,
  p: FriendProfile | undefined | null
): string | null {
  const a = friendProfileAddress(p)
  if (!a || !p) return a
  const name = (p.name ?? '').trim()
  const face = (p.profilePictureUrl ?? '').trim() || null
  const nameColor = color3ToCss(p.nameColor) || null
  if (name || face || nameColor) {
    const prev = hints.get(a)
    hints.set(a, {
      displayName: name || prev?.displayName || a,
      faceUrl: face || prev?.faceUrl || null,
      nameColor: nameColor || prev?.nameColor || null
    })
  }
  return a
}

function requestAddresses(
  list: FriendshipRequestResponse[] | undefined,
  hints: Map<string, FriendshipDisplayHint>
): Set<string> {
  const out = new Set<string>()
  for (const req of list ?? []) {
    const a = seedFromFriendProfile(hints, req.friend)
    if (a) out.add(a)
  }
  return out
}

async function pageAllFriends(
  svc: SocialServiceClient,
  hints: Map<string, FriendshipDisplayHint>
): Promise<Set<string>> {
  const friends = new Set<string>()
  const limit = 50
  let offset = 0
  for (let page = 0; page < 40; page++) {
    const res = (await svc.getFriends(
      GetFriendsPayload.create({ pagination: { limit, offset } })
    )) as PaginatedFriendsProfilesResponse
    const batch = res.friends ?? []
    for (const f of batch) {
      const a = seedFromFriendProfile(hints, f)
      if (a) friends.add(a)
    }
    const total = res.paginationData?.total
    offset += batch.length
    if (batch.length === 0) break
    if (typeof total === 'number' && offset >= total) break
    if (batch.length < limit) break
  }
  return friends
}

async function pageRequests(
  svc: SocialServiceClient,
  kind: 'pending' | 'sent',
  hints: Map<string, FriendshipDisplayHint>
): Promise<Set<string>> {
  const out = new Set<string>()
  const limit = 50
  let offset = 0
  for (let page = 0; page < 40; page++) {
    const res = (await (kind === 'pending'
      ? svc.getPendingFriendshipRequests(
          GetFriendshipRequestsPayload.create({ pagination: { limit, offset } })
        )
      : svc.getSentFriendshipRequests(
          GetFriendshipRequestsPayload.create({ pagination: { limit, offset } })
        ))) as PaginatedFriendshipRequestsResponse
    if (res.response?.$case === 'internalServerError') {
      throw new Error(res.response.internalServerError.message || 'Friendship requests error')
    }
    const batch =
      res.response?.$case === 'requests' ? (res.response.requests.requests ?? []) : []
    for (const a of requestAddresses(batch, hints)) out.add(a)
    const total = res.paginationData?.total
    offset += batch.length
    if (batch.length === 0) break
    if (typeof total === 'number' && offset >= total) break
    if (batch.length < limit) break
  }
  return out
}

/**
 * Production friends path — Social Service v2 WebSocket RPC
 * (docs: GetFriends / GetPendingFriendshipRequests / GetSentFriendshipRequests).
 * Seeds displayHints from FriendProfile (name + profilePictureUrl) so the HUD
 * does not N+1 fetch catalyst profiles for every friend.
 */
export async function fetchFriendshipSnapshotViaSocialRpc(
  identity: AuthIdentity
): Promise<FriendshipAddressSnapshot> {
  const svc = await ensureSocialV2ServiceConnected(identity)
  const displayHints = new Map<string, FriendshipDisplayHint>()
  const [friends, incoming, outgoing] = await Promise.all([
    pageAllFriends(svc, displayHints),
    pageRequests(svc, 'pending', displayHints),
    pageRequests(svc, 'sent', displayHints)
  ])
  return { friends, incoming, outgoing, displayHints }
}

export type FriendshipUpsertAction = 'request' | 'accept' | 'reject' | 'cancel' | 'delete'

export async function upsertFriendshipViaSocialRpc(
  identity: AuthIdentity,
  action: FriendshipUpsertAction,
  peerAddress: string,
  message?: string
): Promise<void> {
  const addr = peerAddress.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(addr)) throw new Error('Invalid address')
  const svc = await ensureSocialV2ServiceConnected(identity)
  const user = User.create({ address: addr })
  let payload: UpsertFriendshipPayload
  switch (action) {
    case 'request':
      payload = UpsertFriendshipPayload.create({
        action: {
          $case: 'request',
          request: { user, message: message?.trim() || undefined }
        }
      })
      break
    case 'accept':
      payload = UpsertFriendshipPayload.create({
        action: { $case: 'accept', accept: { user } }
      })
      break
    case 'reject':
      payload = UpsertFriendshipPayload.create({
        action: { $case: 'reject', reject: { user } }
      })
      break
    case 'cancel':
      payload = UpsertFriendshipPayload.create({
        action: { $case: 'cancel', cancel: { user } }
      })
      break
    case 'delete':
      payload = UpsertFriendshipPayload.create({
        action: { $case: 'delete', delete: { user } }
      })
      break
  }
  const res = (await svc.upsertFriendship(payload)) as UpsertFriendshipResponse
  const r = res.response
  if (!r) throw new Error('Friendship update empty response')
  switch (r.$case) {
    case 'accepted':
      return
    case 'invalidFriendshipAction':
      throw new Error(r.invalidFriendshipAction.message || 'Invalid friendship action')
    case 'internalServerError':
      throw new Error(r.internalServerError.message || 'Friendship service error')
    case 'invalidRequest':
      throw new Error(r.invalidRequest.message || 'Invalid friendship request')
    default:
      throw new Error('Friendship update failed')
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

export type FriendConnectivityEvent = {
  address: string
  /** ONLINE / AWAY → show as online; OFFLINE → offline. */
  online: boolean
  status: ConnectivityStatus
  displayName?: string
  faceUrl?: string | null
  nameColor?: string | null
}

/**
 * Server stream: friends ONLINE / OFFLINE / AWAY (global presence, not island-only).
 * On subscribe the service typically emits currently-online friends first, then deltas.
 */
export async function consumeFriendConnectivityUpdates(
  identity: AuthIdentity,
  onUpdate: (ev: FriendConnectivityEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const svc = await ensureSocialV2ServiceConnected(identity)
  // loadService may expose camelCase or the proto RPC name — try both.
  const subscribe =
    typeof svc.subscribeToFriendConnectivityUpdates === 'function'
      ? svc.subscribeToFriendConnectivityUpdates.bind(svc)
      : typeof svc.SubscribeToFriendConnectivityUpdates === 'function'
        ? svc.SubscribeToFriendConnectivityUpdates.bind(svc)
        : null
  if (!subscribe) {
    throw new Error('social_rpc: SubscribeToFriendConnectivityUpdates not available on client')
  }
  const stream = subscribe(Empty.create()) as AsyncIterable<FriendConnectivityUpdate>
  try {
    for await (const update of stream) {
      if (signal.aborted) return
      const friend = update?.friend
      const address = friendProfileAddress(friend)
      if (!address) continue
      // ONLINE=0 is default when field is omitted in protobuf encode.
      const status: ConnectivityStatus =
        typeof update.status === 'number' ? update.status : ConnectivityStatus.ONLINE
      // ONLINE + AWAY = online; OFFLINE / UNRECOGNIZED = offline.
      const online =
        status === ConnectivityStatus.ONLINE || status === ConnectivityStatus.AWAY
      const name = (friend?.name ?? '').trim()
      const face = (friend?.profilePictureUrl ?? '').trim() || null
      const nameColor = color3ToCss(friend?.nameColor) || null
      onUpdate({
        address,
        online,
        status,
        displayName: name || undefined,
        faceUrl: face,
        nameColor
      })
    }
  } catch (e) {
    if (signal.aborted) return
    throw e
  }
}

export function disconnectSocialV2Service(): void {
  disconnect()
}
