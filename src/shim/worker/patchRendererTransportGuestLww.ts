/**
 * SDK renderer transport drops hashed guest LWW (componentId > 2048).
 * Tags shaders never needed host CRDT — worker read Tags locally. `tjs` must egress.
 */
import { TJS_COMPONENT_ID } from '../../dcl/ecs/tjsComponent'

/** Guest scene LWW ids the host mirror also registers — allow through renderer transport. */
export const RENDERER_TRANSPORT_GUEST_COMPONENT_IDS = new Set<number>([TJS_COMPONENT_ID])

type FilterableTransport = {
  filter?: (message: unknown) => boolean
  __guestLwwFilterPatched?: boolean
}

let loggedTjsEgress = false

function workerLog(message: string): void {
  const g = globalThis as Record<string, unknown>
  const fn = g.__THREEJS_WORKER_LOG__
  if (typeof fn === 'function') fn(message)
  else console.log(message)
}

/** Allow mirrored guest components through SDK `createRendererTransport` filter. */
export function patchRendererTransportGuestLww(transport: FilterableTransport): void {
  if (!transport || transport.__guestLwwFilterPatched) return
  const origFilter = transport.filter
  if (typeof origFilter !== 'function') return
  transport.__guestLwwFilterPatched = true
  transport.filter = (message: unknown) => {
    const cid = (message as { componentId?: number }).componentId
    if (typeof cid === 'number' && RENDERER_TRANSPORT_GUEST_COMPONENT_IDS.has(cid)) {
      if (!loggedTjsEgress && cid === TJS_COMPONENT_ID) {
        loggedTjsEgress = true
        workerLog(`[sceneWorker] tjs CRDT egress enabled — componentId=${cid}`)
      }
      return true
    }
    return origFilter.call(transport, message)
  }
}

export function resetRendererTransportGuestLwwLog(): void {
  loggedTjsEgress = false
}
