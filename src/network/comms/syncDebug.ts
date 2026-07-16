/** SyncEntities host instrumentation — enable with `?syncdebug` or localStorage DEBUG_SYNC=1. */

import { CommsWireMessageType } from './CommsInboundQueue'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'

export type SyncWireTypeName =
  | 'CRDT'
  | 'REQ_CRDT_STATE'
  | 'RES_CRDT_STATE'
  | 'CRDT_SERVER'
  | 'CRDT_AUTHORITATIVE'
  | 'CUSTOM_EVENT'
  | 'AUTH_CRDT'
  | 'AUTH_REQ_CRDT_STATE'
  | 'AUTH_RES_CRDT_STATE'
  | `UNKNOWN_${number}`

let cachedEnabled: boolean | null = null

export function isSyncDebugEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled
  if (typeof window === 'undefined') {
    cachedEnabled = false
    return false
  }
  try {
    if (window.localStorage?.getItem('DEBUG_SYNC') === '1') {
      cachedEnabled = true
      return true
    }
  } catch {
    /* private mode */
  }
  cachedEnabled = new URLSearchParams(window.location.search).has('syncdebug')
  return cachedEnabled
}

/** Re-read flags (e.g. after navigation). */
export function resetSyncDebugCache(): void {
  cachedEnabled = null
}

/**
 * Human labels for craftCommsMessage type byte.
 * Auth-server SDK reuses the same envelope with different enums (4–9).
 */
export function syncWireTypeName(type: number): SyncWireTypeName {
  switch (type) {
    case CommsWireMessageType.CRDT:
      return 'CRDT'
    case CommsWireMessageType.REQ_CRDT_STATE:
      return 'REQ_CRDT_STATE'
    case CommsWireMessageType.RES_CRDT_STATE:
      return 'RES_CRDT_STATE'
    case CommsWireMessageType.CRDT_SERVER:
      return 'CRDT_SERVER'
    case CommsWireMessageType.CRDT_AUTHORITATIVE:
      return 'CRDT_AUTHORITATIVE'
    case CommsWireMessageType.CUSTOM_EVENT:
      return 'CUSTOM_EVENT'
    case CommsWireMessageType.AUTH_CRDT:
      return 'AUTH_CRDT'
    case CommsWireMessageType.AUTH_REQ_CRDT_STATE:
      return 'AUTH_REQ_CRDT_STATE'
    case CommsWireMessageType.AUTH_RES_CRDT_STATE:
      return 'AUTH_RES_CRDT_STATE'
    default:
      return `UNKNOWN_${type}`
  }
}

/** True when type is full-state RES (serverless or auth-server). */
export function isResCrdtStateType(type: number): boolean {
  return (
    type === CommsWireMessageType.RES_CRDT_STATE ||
    type === CommsWireMessageType.AUTH_RES_CRDT_STATE
  )
}

/** True when type is REQ (serverless or auth-server). */
export function isReqCrdtStateType(type: number): boolean {
  return (
    type === CommsWireMessageType.REQ_CRDT_STATE ||
    type === CommsWireMessageType.AUTH_REQ_CRDT_STATE
  )
}

/**
 * SDK craftCommsMessage layout: [messageType:u8][payload…].
 * Returns null if buffer is empty.
 */
export function unwrapCraftedCommsMessage(
  crafted: Uint8Array
): { messageType: number; payload: Uint8Array } | null {
  if (!crafted.byteLength) return null
  return { messageType: crafted[0]!, payload: crafted.subarray(1) }
}

export function summarizeWireTypes(chunks: readonly Uint8Array[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const chunk of chunks) {
    const unwrapped = unwrapCraftedCommsMessage(chunk)
    const name = unwrapped ? syncWireTypeName(unwrapped.messageType) : 'EMPTY'
    counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

function formatTypeCounts(counts: Record<string, number>): string {
  return (
    Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ') || 'none'
  )
}

export function logSyncOutbound(opts: {
  broadcast: readonly Uint8Array[]
  directed: ReadonlyArray<{ chunk: Uint8Array; addresses: string[] }>
}): void {
  if (!isSyncDebugEnabled()) return
  const broadcastTypes = summarizeWireTypes(opts.broadcast)
  const directedChunks = opts.directed.map((d) => d.chunk)
  const directedTypes = summarizeWireTypes(directedChunks)
  let bytes = 0
  for (const c of opts.broadcast) bytes += c.byteLength
  for (const d of opts.directed) bytes += d.chunk.byteLength
  const targets = [
    ...new Set(opts.directed.flatMap((d) => d.addresses).filter(Boolean))
  ]
  const directedNote =
    opts.directed.length > 0
      ? ` directed=${opts.directed.length} targets=[${targets.slice(0, 4).join(',')}${targets.length > 4 ? '…' : ''}]`
      : ''
  const line =
    `[sync] sendBinary out — broadcast=${opts.broadcast.length} (${formatTypeCounts(broadcastTypes)})` +
    `${directedNote} (${formatTypeCounts(directedTypes)}) bytes=${bytes}`
  console.info(line)
  clientDebugLog.log('sync', line, { alsoConsole: false, throttleMs: 200, throttleKey: 'sync-out' })
}

export function logSyncInbound(opts: {
  sender: string
  messageType: number
  payloadBytes: number
}): void {
  if (!isSyncDebugEnabled()) return
  const line =
    `[sync] inbound — type=${syncWireTypeName(opts.messageType)}` +
    ` from=${opts.sender.slice(0, 12)}… payload=${opts.payloadBytes}B`
  console.info(line)
  clientDebugLog.log('sync', line, { alsoConsole: false, throttleMs: 100, throttleKey: 'sync-in' })
}

export function logSyncDrain(opts: { count: number; totalBytes: number }): void {
  if (!isSyncDebugEnabled()) return
  if (opts.count === 0) return
  const line = `[sync] drain → worker — msgs=${opts.count} bytes=${opts.totalBytes}`
  console.info(line)
  clientDebugLog.log('sync', line, { alsoConsole: false, throttleMs: 200, throttleKey: 'sync-drain' })
}

/** LiveKit directed publish (P1) — SDK peerData addresses → destinationIdentities. */
export function logSyncDirectedPublish(
  requested: readonly string[],
  resolved: readonly string[]
): void {
  if (!isSyncDebugEnabled() || !requested.length) return
  const req = requested.slice(0, 4).join(',')
  const res = resolved.slice(0, 4).join(',')
  const line =
    `[sync] directed publish — requested=[${req}${requested.length > 4 ? '…' : ''}]` +
    ` resolved=[${res}${resolved.length > 4 ? '…' : ''}] n=${resolved.length}`
  console.info(line)
  clientDebugLog.log('sync', line, {
    alsoConsole: false,
    throttleMs: 500,
    throttleKey: 'sync-directed-publish'
  })
}

/** Oversized scene-binary chunk skipped (LIVEKIT_MAX_SIZE parity). */
export function logSyncOversizedSkip(opts: {
  phase: 'crafted' | 'publish'
  bytes: number
  limit: number
}): void {
  if (!isSyncDebugEnabled()) {
    // Always warn once-throttled for real drops even without ?syncdebug
  }
  const line =
    `[sync] SKIP oversized ${opts.phase} packet — ${opts.bytes}B > limit ${opts.limit}B ` +
    `(SDK LIVEKIT_MAX_SIZE parity)`
  console.warn(line)
  clientDebugLog.log('sync', line, {
    level: 'warn',
    alsoConsole: false,
    throttleMs: 2000,
    throttleKey: `sync-oversized-${opts.phase}`
  })
}

/** Fallback path cannot honor directed peers (e.g. RFC5). */
export function logSyncDirectedFallback(addresses: readonly string[], reason: string): void {
  if (!isSyncDebugEnabled() || !addresses.length) return
  const line =
    `[sync] WARN directed fallback (${reason}) — broadcast instead of ` +
    `targets=[${addresses.slice(0, 4).join(',')}${addresses.length > 4 ? '…' : ''}]`
  console.warn(line)
  clientDebugLog.log('sync', line, {
    level: 'warn',
    alsoConsole: false,
    throttleMs: 1000,
    throttleKey: 'sync-directed-fallback'
  })
}
