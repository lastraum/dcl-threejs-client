import type { PhysxCookMeshPayload } from './physxCookPayload'

type CookDone = { type: 'cook-done'; id: number; stream: ArrayBuffer }
type CookError = { type: 'cook-error'; id: number; message: string }
type CookEmpty = { type: 'cook-empty'; id: number }

type WorkerInbound = CookDone | CookError | CookEmpty

type Pending = {
  resolve: (stream: ArrayBuffer | null) => void
  reject: (err: Error) => void
}

export type PhysxCookPoolRequest = {
  storageKey: string
  convex: boolean
  payload: PhysxCookMeshPayload
}

// One WASM heap per worker — a single cook worker avoids duplicate PhysX heaps and races.
const POOL_SIZE = 1

let workers: Worker[] | null = null
let nextId = 1
const pending = new Map<number, Pending>()
const workerBusy = new WeakMap<Worker, boolean>()
const workerWaiters: Array<(worker: Worker) => void> = []

const completedStreams = new Map<string, ArrayBuffer>()
const inFlight = new Map<string, Promise<ArrayBuffer | null>>()

let poolDisabled = false
let sessionWorkerCooks = 0
let sessionWorkerHits = 0

function readCookWorkerDisabled(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('nocookworker')
}

/** On by default — opt out with `?nocookworker`. */
export function isPhysxCookWorkerEnabled(): boolean {
  return !poolDisabled && !readCookWorkerDisabled()
}

function bindWorker(worker: Worker): void {
  worker.onmessage = (ev: MessageEvent<WorkerInbound>) => {
    workerBusy.set(worker, false)
    scheduleWaiters()

    const msg = ev.data
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)

    if (msg.type === 'cook-done') {
      slot.resolve(msg.stream)
    } else if (msg.type === 'cook-error') {
      slot.reject(new Error(msg.message))
    } else {
      slot.resolve(null)
    }
  }
  worker.onerror = (err) => {
    workerBusy.set(worker, false)
    scheduleWaiters()
    for (const [id, slot] of pending) {
      slot.reject(new Error(err.message || 'PhysX cook worker failed'))
      pending.delete(id)
    }
  }
}

function ensureWorkers(): Worker[] | null {
  if (!isPhysxCookWorkerEnabled()) return null
  if (workers) return workers
  try {
    workers = Array.from({ length: POOL_SIZE }, () => {
      const worker = new Worker(new URL('../worker/physxCookWorker.ts', import.meta.url), { type: 'module' })
      workerBusy.set(worker, false)
      bindWorker(worker)
      return worker
    })
    return workers
  } catch (err) {
    console.warn('[physxCookPool] worker spawn failed — main-thread cook fallback', err)
    poolDisabled = true
    return null
  }
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

function acquireWorker(): Promise<Worker> | null {
  const pool = ensureWorkers()
  if (!pool) return null
  const idle = pool.find((worker) => !workerBusy.get(worker))
  if (idle) return Promise.resolve(idle)
  return new Promise((resolve) => {
    workerWaiters.push(resolve)
  })
}

function cookOffThread(request: PhysxCookPoolRequest): Promise<ArrayBuffer | null> {
  const positions = request.payload.positions.slice()
  const indices = request.payload.use16BitIndices
    ? (request.payload.indices as Uint16Array).slice()
    : (request.payload.indices as Uint32Array).slice()

  const id = nextId++
  const transfer: Transferable[] = [positions.buffer, indices.buffer]

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const workerPromise = acquireWorker()
    if (!workerPromise) {
      pending.delete(id)
      resolve(null)
      return
    }
    void workerPromise.then((worker) => {
      workerBusy.set(worker, true)
      worker.postMessage(
        {
          type: 'cook',
          id,
          convex: request.convex,
          positions,
          indices,
          use16BitIndices: request.payload.use16BitIndices
        },
        transfer
      )
    })
  })
}

function queueCook(request: PhysxCookPoolRequest): Promise<ArrayBuffer | null> {
  const existing = inFlight.get(request.storageKey)
  if (existing) return existing

  const promise = cookOffThread(request)
    .then((stream) => {
      inFlight.delete(request.storageKey)
      if (stream?.byteLength) {
        completedStreams.set(request.storageKey, stream)
        sessionWorkerCooks++
      }
      return stream
    })
    .catch((err) => {
      inFlight.delete(request.storageKey)
      console.warn('[physxCookPool] cook failed —', request.storageKey.slice(0, 24), err)
      return null
    })

  inFlight.set(request.storageKey, promise)
  return promise
}

/** Completed worker stream for synchronous pickup during boot drain. */
export function takeCompletedPhysxCookStream(storageKey: string): ArrayBuffer | undefined {
  const hit = completedStreams.get(storageKey)
  if (!hit) return undefined
  completedStreams.delete(storageKey)
  sessionWorkerHits++
  return hit
}

function uniquePendingRequests(requests: PhysxCookPoolRequest[]): PhysxCookPoolRequest[] {
  const unique = new Map<string, PhysxCookPoolRequest>()
  for (const req of requests) {
    if (completedStreams.has(req.storageKey) || inFlight.has(req.storageKey)) continue
    unique.set(req.storageKey, req)
  }
  return [...unique.values()]
}

/** Queue worker cooks without blocking — call as soon as late GLTF colliders are known. */
export function startPhysxCookPrefetch(requests: PhysxCookPoolRequest[]): number {
  if (!isPhysxCookWorkerEnabled() || !requests.length) return 0
  const pending = uniquePendingRequests(requests)
  for (const req of pending) void queueCook(req)
  return pending.length
}

function isStreamReady(storageKey: string): boolean {
  return completedStreams.has(storageKey)
}

function isStreamPending(storageKey: string): boolean {
  return inFlight.has(storageKey) && !completedStreams.has(storageKey)
}

/** Fire parallel worker cooks — await before drain so main only deserializes streams. */
export async function prefetchPhysxCookStreams(
  requests: PhysxCookPoolRequest[],
  options?: { quiet?: boolean; maxWaitMs?: number }
): Promise<number> {
  if (!isPhysxCookWorkerEnabled() || !requests.length) return 0
  const pending = uniquePendingRequests(requests)
  if (!pending.length) return 0
  const started = performance.now()
  for (const req of pending) void queueCook(req)

  const maxWaitMs = options?.maxWaitMs
  if (maxWaitMs === 0) return pending.length

  const deadline =
    maxWaitMs != null && Number.isFinite(maxWaitMs) ? started + maxWaitMs : Number.POSITIVE_INFINITY

  while (performance.now() < deadline) {
    const waiting = pending.some((req) => isStreamPending(req.storageKey))
    if (!waiting) break
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
  }

  const ready = pending.filter((req) => isStreamReady(req.storageKey)).length
  if (!options?.quiet) {
    const elapsed = ((performance.now() - started) / 1000).toFixed(1)
    console.info(
      `[physxCookPool] prefetched ${ready}/${pending.length} cook stream(s) in ${elapsed}s`
    )
  }
  return ready
}

export function getPhysxCookPoolStats(): { workerCooks: number; workerHits: number; inFlight: number } {
  return {
    workerCooks: sessionWorkerCooks,
    workerHits: sessionWorkerHits,
    inFlight: inFlight.size
  }
}

/** Drop completed worker streams between boot cooks — same-tab revisits must not reuse stale streams. */
export function resetPhysxCookPoolSession(): void {
  inFlight.clear()
  completedStreams.clear()
  sessionWorkerCooks = 0
  sessionWorkerHits = 0
}

export function disposePhysxCookPool(): void {
  for (const slot of pending.values()) {
    slot.reject(new Error('PhysX cook pool disposed'))
  }
  pending.clear()
  resetPhysxCookPoolSession()
  workerWaiters.length = 0
  if (workers) {
    for (const worker of workers) worker.terminate()
    workers = null
  }
}