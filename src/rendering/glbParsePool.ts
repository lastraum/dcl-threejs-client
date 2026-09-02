import { inflateGltf, type XferGltfPayload } from './gltfTransferable'
import type { AnimationClip, Group } from 'three'
import { isAppleTouchDevice } from '../util/appleTouch'
import { isMobilePhone } from '../client/ui/touchPlayLayout'

type ParseDone = {
  type: 'parse-done'
  id: number
  payload: XferGltfPayload
}

type ParseError = { type: 'parse-error'; id: number; message: string }

type WorkerInbound = ParseDone | ParseError

type Pending = {
  resolve: (result: { scene: Group; animations: AnimationClip[] }) => void
  reject: (err: Error) => void
}

const POOL_SIZE = (() => {
  if (typeof navigator === 'undefined') return 2
  // Concurrent parse workers are a jetsam/GPU cut — phones + Apple touch stay at 1.
  // Off-thread parse itself stays enabled on Android (see gltfWorkerTransfer).
  if (isMobilePhone() || isAppleTouchDevice()) return 1
  const cores = navigator.hardwareConcurrency ?? 4
  return Math.min(4, Math.max(2, cores - 2))
})()

let workers: Worker[] | null = null
let poolFailed = false
let nextId = 1
let firstOkLogged = false
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
      try {
        const result = inflateGltf(msg.payload)
        if (!firstOkLogged) {
          firstOkLogged = true
          console.info('[assets] GLB parse worker — transfer rebuild on main')
        }
        slot.resolve(result)
      } catch (err) {
        slot.reject(err instanceof Error ? err : new Error(String(err)))
      }
    } else {
      slot.reject(new Error(msg.message))
    }
  }
  worker.onerror = (err) => {
    workerBusy.set(worker, false)
    scheduleWaiters()
    const message = err.message || 'GLB parse worker failed'
    for (const [id, slot] of pending) {
      slot.reject(new Error(message))
      pending.delete(id)
    }
  }
}

function ensureWorkers(): Worker[] {
  if (poolFailed) throw new Error('GLB parse worker unavailable')
  if (workers) return workers
  try {
    workers = Array.from({ length: POOL_SIZE }, () => {
      const worker = new Worker(new URL('../worker/glbParseWorker.ts', import.meta.url), { type: 'module' })
      workerBusy.set(worker, false)
      bindWorker(worker)
      return worker
    })
    return workers
  } catch (err) {
    poolFailed = true
    throw err instanceof Error ? err : new Error(String(err))
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

function acquireWorker(): Promise<Worker> {
  const pool = ensureWorkers()
  const idle = pool.find((worker) => !workerBusy.get(worker))
  if (idle) return Promise.resolve(idle)
  return new Promise((resolve) => {
    workerWaiters.push(resolve)
  })
}

export function isGlbParsePoolAvailable(): boolean {
  if (poolFailed) return false
  try {
    ensureWorkers()
    return true
  } catch {
    return false
  }
}

/** Parse GLB bytes off the main thread (Draco + graph), inflate THREE on main. */
export function parseGlbOffThread(
  buffer: ArrayBuffer,
  resourcePath: string,
  urlMappings: Record<string, string> = {}
): Promise<{ scene: Group; animations: AnimationClip[] }> {
  const id = nextId++
  const payload = buffer.slice(0)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    void acquireWorker()
      .then((worker) => {
        workerBusy.set(worker, true)
        worker.postMessage({ type: 'parse', id, buffer: payload, resourcePath, urlMappings }, [payload])
      })
      .catch((err) => {
        pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
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
