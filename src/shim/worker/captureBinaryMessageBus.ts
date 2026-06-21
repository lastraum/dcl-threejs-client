/** Set during bundle eval when patching sync-systems `binaryMessageBus` export. */
export const BINARY_MESSAGE_BUS_CAPTURE_KEY = '__THREEJS_BINARY_MESSAGE_BUS__'

export type CapturedBinaryMessageBus = {
  __processMessages: (messages: Uint8Array[]) => void
}

function isBinaryMessageBus(val: unknown): val is CapturedBinaryMessageBus {
  return (
    !!val &&
    typeof val === 'object' &&
    typeof (val as CapturedBinaryMessageBus).__processMessages === 'function'
  )
}

let cached: CapturedBinaryMessageBus | null = null

/** sync-systems bus — parses inbound comms frames and dispatches RES_CRDT_STATE / CRDT_AUTHORITATIVE handlers. */
export function resolveBinaryMessageBus(): CapturedBinaryMessageBus | null {
  if (cached) return cached
  const g = globalThis as Record<string, unknown>
  const bus = g[BINARY_MESSAGE_BUS_CAPTURE_KEY]
  if (!isBinaryMessageBus(bus)) return null
  cached = bus
  return bus
}