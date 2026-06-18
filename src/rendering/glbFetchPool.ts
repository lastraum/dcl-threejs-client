import { normalizeGlbCacheKey } from './glbByteCache'

/**
 * Pool of workers for GLB byte fetch + IndexedDB — parallel network during avatar/scene storms.
 */
type FetchDone = { type: 'fetch-done'; id: number; buffer: ArrayBuffer; fromCache: boolean }
type FetchError = { type: 'fetch-error'; id: number; message: string }
type WorkerInbound = FetchDone | FetchError

type Pending = {
  resolve: (buffer: ArrayBuffer) => void
  reject: (err: Error) => void
}

const POOL_SIZE = 3

let workers: Worker[] | null = null
const inflightByKey = new Map<string, Promise<ArrayBuffer>>()
let nextId = 1
const pending = new Map<number, Pending>()
const workerBusy = new WeakMap<Worker, boolean>()
const workerWaiters: Array<(worker: Worker) => void> = []

function bindWorker(worker: Worker): void {
  worker.onmessage = (ev: MessageEvent<WorkerInbound>) => {
    workerBusy.set(worker, false)
    scheduleWaiters()

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
    workerBusy.set(worker, false)
    scheduleWaiters()
    for (const [id, slot] of pending) {
      slot.reject(new Error(err.message || 'avatar fetch worker failed'))
      pending.delete(id)
    }
  }
}

function ensureWorkers(): Worker[] {
  if (workers) return workers
  workers = Array.from({ length: POOL_SIZE }, () => {
    const worker = new Worker(new URL('../worker/avatarFetchWorker.ts', import.meta.url), { type: 'module' })
    workerBusy.set(worker, false)
    bindWorker(worker)
    return worker
  })
  return workers
}

function scheduleWaiters(): void {
  if (!workers) return
  for (const worker of workers) {
    if (workerBusy.get(worker)) continue
    const waiter = workerWaiters.shift()
    if (!waiter) return
    waiter(worker)
  }
}

function acquireWorker(): Promise<Worker> {
  const pool = ensureWorkers()
  const idle = pool.find((worker) => !workerBusy.get(worker))
  if (idle) return Promise.resolve(idle)
  return new Promise((resolve) => {
    workerWaiters.push(resolve)
  })
}

function fetchGlbBytesOffThreadOnce(url: string, key: string): Promise<ArrayBuffer> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    void acquireWorker().then((worker) => {
      workerBusy.set(worker, true)
      worker.postMessage({ type: 'fetch', id, url, key })
    })
  })
}

/** Fetch GLB bytes via worker pool (IDB hit or network). Dedupes concurrent fetches per cache key. */
export function fetchGlbBytesOffThread(url: string, key: string): Promise<ArrayBuffer> {
  const cacheKey = normalizeGlbCacheKey(key)
  const inflight = inflightByKey.get(cacheKey)
  if (inflight) return inflight.then((buffer) => buffer.slice(0))

  const task = fetchGlbBytesOffThreadOnce(url, cacheKey)
    .then((buffer) => buffer.slice(0))
    .finally(() => {
      inflightByKey.delete(cacheKey)
    })

  inflightByKey.set(cacheKey, task)
  return task
}

export function disposeGlbFetchPool(): void {
  inflightByKey.clear()
  for (const slot of pending.values()) {
    slot.reject(new Error('GLB fetch pool disposed'))
  }
  pending.clear()
  workerWaiters.length = 0
  if (workers) {
    for (const worker of workers) worker.terminate()
    workers = null
  }
}