/**
 * Wake hidden tabs so preview multiplayer keeps simulating.
 * Prefers SharedWorker (unthrottled while a sibling tab is focused).
 */

type TickFn = () => void

let worker: SharedWorker | null = null
let port: MessagePort | null = null
const listeners = new Set<TickFn>()

function onPortMessage(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* listener errors must not kill the hub */
    }
  }
}

function ensureWorker(): void {
  if (port || typeof SharedWorker === 'undefined') return
  try {
    worker = new SharedWorker(
      new URL('./backgroundTick.shared-worker.ts', import.meta.url),
      { type: 'module', name: 'tjs-background-tick' }
    )
    port = worker.port
    port.addEventListener('message', onPortMessage)
    port.start()
  } catch {
    worker = null
    port = null
  }
}

export function subscribeBackgroundTicks(onTick: TickFn): () => void {
  ensureWorker()
  listeners.add(onTick)
  return () => {
    listeners.delete(onTick)
    if (listeners.size > 0) return
    try {
      port?.postMessage('stop')
    } catch {
      /* ignore */
    }
    port?.removeEventListener('message', onPortMessage)
    try {
      port?.close()
    } catch {
      /* ignore */
    }
    port = null
    worker = null
  }
}
