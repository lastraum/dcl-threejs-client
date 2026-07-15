/** SyncEntities host instrumentation — enable with `?syncdebug` or localStorage DEBUG_SYNC=1. */

import { CommsWireMessageType } from './CommsInboundQueue'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'

export type SyncWireTypeName = 'CRDT' | 'REQ_CRDT_STATE' | 'RES_CRDT_STATE' | `UNKNOWN_${number}`

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

export function syncWireTypeName(type: number): SyncWireTypeName {
  if (type === CommsWireMessageType.CRDT) return 'CRDT'
  if (type === CommsWireMessageType.REQ_CRDT_STATE) return 'REQ_CRDT_STATE'
  if (type === CommsWireMessageType.RES_CRDT_STATE) return 'RES_CRDT_STATE'
  return `UNKNOWN_${type}`
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

export function logSyncDirectedIgnored(addresses: string[]): void {
  if (!isSyncDebugEnabled() || !addresses.length) return
  const line =
    `[sync] WARN directed addresses ignored by LiveKit publish (P1) — ` +
    `targets=[${addresses.slice(0, 4).join(',')}${addresses.length > 4 ? '…' : ''}]`
  console.warn(line)
  clientDebugLog.log('sync', line, {
    level: 'warn',
    alsoConsole: false,
    throttleMs: 1000,
    throttleKey: 'sync-directed-ignored'
  })
}
