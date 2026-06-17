/**
 * Single dedicated worker for GLB byte fetch + IndexedDB — keeps network off main thread.
 */
type FetchDone = { type: 'fetch-done'; id: number; buffer: ArrayBuffer; fromCache: boolean }
type FetchError = { type: 'fetch-error'; id: number; message: string }
type WorkerInbound = FetchDone | FetchError

type Pending = {
  resolve: (buffer: ArrayBuffer) => void
  reject: (err: Error) => void
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../worker/avatarFetchWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (ev: MessageEvent<WorkerInbound>) => {
    const msg = ev.data
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.type === 'fetch-done') {
      slot.resolve(msg.buffer)
    } else {
      slot.reject(new Error(msg.message))
    }
  }
  worker.onerror = (err) => {
    for (const slot of pending.values()) {
      slot.reject(new Error(err.message || 'avatar fetch worker failed'))
    }
    pending.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

/** Fetch GLB bytes via worker (IDB hit or network). Returns a copy owned by main thread. */
export function fetchGlbBytesOffThread(url: string, key: string): Promise<ArrayBuffer> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ensureWorker().postMessage({ type: 'fetch', id, url, key })
  })
}

export function disposeGlbFetchPool(): void {
  for (const slot of pending.values()) {
    slot.reject(new Error('GLB fetch pool disposed'))
  }
  pending.clear()
  worker?.terminate()
  worker = null
}
