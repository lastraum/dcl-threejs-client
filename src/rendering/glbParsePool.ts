import type { AnimationClip, Group } from 'three'

type ParseDone = {
  type: 'parse-done'
  id: number
  scene: Group
  animations: AnimationClip[]
}

type ParseError = { type: 'parse-error'; id: number; message: string }

type WorkerInbound = ParseDone | ParseError

type Pending = {
  resolve: (result: { scene: Group; animations: AnimationClip[] }) => void
  reject: (err: Error) => void
}

const POOL_SIZE = (() => {
  if (typeof navigator === 'undefined') return 4
  const cores = navigator.hardwareConcurrency ?? 4
  return Math.min(6, Math.max(3, cores - 1))
})()

let workers: Worker[] | null = null
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

    if (msg.type === 'parse-done') {
      slot.resolve({ scene: msg.scene, animations: msg.animations })
    } else {
      slot.reject(new Error(msg.message))
    }
  }
  worker.onerror = (err) => {
    workerBusy.set(worker, false)
    scheduleWaiters()
    for (const [id, slot] of pending) {
      slot.reject(new Error(err.message || 'GLB parse worker failed'))
      pending.delete(id)
    }
  }
}

function ensureWorkers(): Worker[] {
  if (workers) return workers
  workers = Array.from({ length: POOL_SIZE }, () => {
    const worker = new Worker(new URL('../worker/glbParseWorker.ts', import.meta.url), { type: 'module' })
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

/** Parse GLB bytes off the main thread (Draco decode + glTF graph build). */
export function parseGlbOffThread(
  buffer: ArrayBuffer,
  resourcePath: string,
  urlMappings: Record<string, string> = {}
): Promise<{ scene: Group; animations: AnimationClip[] }> {
  const id = nextId++
  const payload = buffer.slice(0)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    void acquireWorker().then((worker) => {
      workerBusy.set(worker, true)
      worker.postMessage({ type: 'parse', id, buffer: payload, resourcePath, urlMappings }, [payload])
    })
  })
}

export function disposeGlbParsePool(): void {
  for (const slot of pending.values()) {
    slot.reject(new Error('GLB parse pool disposed'))
  }
  pending.clear()
  workerWaiters.length = 0
  if (workers) {
    for (const worker of workers) worker.terminate()
    workers = null
  }
}
