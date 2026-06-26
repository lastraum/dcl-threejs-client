import { clientDebugLog } from '../client/debug/ClientDebugLog'
import type { PhysxSimWorkerInbound, PhysxSimWorkerOutbound } from './physxSimTypes'

let worker: Worker | null = null
let nextId = 1
let disabled = false
let ready = false
let initLogged = false

const pending = new Map<number, { resolve: (msg: PhysxSimWorkerOutbound) => void; reject: (err: Error) => void }>()

function readDisabled(): boolean {
  if (typeof window === 'undefined') return true
  return new URLSearchParams(window.location.search).has('nophysxworker')
}

/** Phase D slice 1 — opt in with `?workerphysx` (or `?physxworker`). */
export function isPhysxSimWorkerEnabled(): boolean {
  return !disabled && !readDisabled()
}

function ensureWorker(): Worker | null {
  if (!isPhysxSimWorkerEnabled()) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('../worker/physxSimWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (ev: MessageEvent<PhysxSimWorkerOutbound>) => {
      const msg = ev.data
      if (msg.type === 'ready') {
        ready = true
        return
      }
      const slot = pending.get(msg.id)
      if (!slot) return
      pending.delete(msg.id)
      if (msg.type === 'error' || msg.type === 'init-error') {
        slot.reject(new Error('message' in msg ? msg.message : 'PhysX sim worker error'))
        return
      }
      slot.resolve(msg)
    }
    worker.onerror = (err) => {
      for (const [id, slot] of pending) {
        slot.reject(new Error(err.message || 'PhysX sim worker crashed'))
        pending.delete(id)
      }
      disabled = true
      worker = null
      ready = false
    }
    return worker
  } catch (err) {
    console.warn('[physxSimBridge] worker spawn failed — main-thread PhysX fallback', err)
    disabled = true
    return null
  }
}

function rpc(msg: PhysxSimWorkerInbound, transfer: Transferable[] = []): Promise<PhysxSimWorkerOutbound> {
  const w = ensureWorker()
  if (!w) return Promise.reject(new Error('PhysX sim worker unavailable'))
  const id = msg.id
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    if (transfer.length) w.postMessage(msg, transfer)
    else w.postMessage(msg)
  })
}

/** Warm the sim worker after main PhysX boot — logs readiness; locomotion routing is D3. */
export async function warmPhysxSimWorker(): Promise<boolean> {
  if (!isPhysxSimWorkerEnabled()) return false
  const w = ensureWorker()
  if (!w) return false
  if (!ready) {
    await new Promise<void>((resolve) => {
      const prior = w.onmessage
      w.onmessage = (ev: MessageEvent<PhysxSimWorkerOutbound>) => {
        if (ev.data.type === 'ready') {
          ready = true
          w.onmessage = prior
          resolve()
          return
        }
        prior?.call(w, ev)
      }
    })
  }
  const id = nextId++
  await rpc({ type: 'init', id })
  if (!initLogged) {
    initLogged = true
    clientDebugLog.log(
      'physics',
      'PhysX sim worker ready — scene+CCT bootstrapped (locomotion mirror pending D2/D3; ?nophysxworker to opt out)',
      { level: 'success', alsoConsole: true }
    )
  }
  return true
}

export function disposePhysxSimWorker(): void {
  for (const [id, slot] of pending) {
    slot.reject(new Error('PhysX sim worker disposed'))
    pending.delete(id)
  }
  worker?.terminate()
  worker = null
  ready = false
  initLogged = false
}