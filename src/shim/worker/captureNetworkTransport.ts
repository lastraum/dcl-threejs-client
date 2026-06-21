import type { RendererTransportExport } from '../system/createSystemStubs'
import { watchRendererTransportOnmessage } from '../system/createSystemStubs'

export const NETWORK_TRANSPORT_HOOK_KEY = '__THREEJS_HOOK_NETWORK_TRANSPORT__'

let networkTransportOnmessage: ((data: Uint8Array) => void) | null = null

/** Network transport onmessage — fallback when BinaryMessageBus capture misses. */
export function resolveNetworkTransportOnmessage(): ((data: Uint8Array) => void) | null {
  return networkTransportOnmessage
}

/** Wrap sync-systems network transport onmessage so processed authoritative CRDT also reaches main projection. */
export function installNetworkTransportProjectionForwarder(
  transport: RendererTransportExport,
  forward: (data: Uint8Array) => void
): void {
  watchRendererTransportOnmessage(transport, (onmessage) => {
    const original = onmessage
    const wrapped = (data: Uint8Array) => {
      if (data?.byteLength) forward(data)
      original(data)
    }
    networkTransportOnmessage = wrapped
    Object.defineProperty(transport, 'onmessage', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: wrapped
    })
    ;(globalThis as Record<string, unknown>).__THREEJS_NETWORK_TRANSPORT_HOOKED__ = true
  })
}

export function installNetworkTransportHook(forward: (data: Uint8Array) => void): void {
  const g = globalThis as Record<string, unknown>
  g[NETWORK_TRANSPORT_HOOK_KEY] = (transport: RendererTransportExport) => {
    installNetworkTransportProjectionForwarder(transport, forward)
  }
}