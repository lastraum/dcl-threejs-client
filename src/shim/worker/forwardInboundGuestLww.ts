/**
 * Platform law: guest-owned LWW that arrives via updateFromCrdt must reach the host.
 *
 * Explorer's renderer reads the same @dcl/ecs store the scene writes. This client
 * splits worker VM vs host projection. updateFromCrdt (comms / AUTH_RES / sync
 * apply) writes lastSentData and does **not** dirty getCrdtUpdates — so Material
 * / MeshRenderer / Visibility / Transform never egress, GPU colors stay stale on
 * game reset, and paintDelta no-ops because the worker already has the new bytes.
 *
 * Official crdtSceneSystem.receiveMessages broadcasts inbound CRDT to the other
 * transports. Scene handlers that call component.updateFromCrdt directly skip
 * that path. Wrap updateFromCrdt so every guest-owned LWW change is posted as
 * host CRDT. Host-owned reserved writes (injectHostLww) are not forwarded.
 */
import type { Entity } from '@dcl/ecs'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { DeleteComponent } from '@dcl/ecs/dist/serialization/crdt/deleteComponent'
import { PutComponentOperation } from '@dcl/ecs/dist/serialization/crdt/putComponent'
import { CrdtMessageType } from '@dcl/ecs/dist/serialization/crdt/types'
import { dataCompare } from '@dcl/ecs/dist/systems/crdt/utils'
import { isHostOwnedLwwEgress } from './injectHostLww'
import { coalesceCrdtChunksLww } from './workerSceneUiCrdtOutbound'

type CrdtBody = {
  type: number
  entityId: number
  componentId?: number
  timestamp?: number
  data?: Uint8Array
}

type WrappableLww = {
  componentId: number
  updateFromCrdt: (msg: CrdtBody) => unknown
}

type EngineLike = {
  componentsIter?: () => Iterable<WrappableLww>
  defineComponent?: (...args: never[]) => WrappableLww
  defineComponentFromSchema?: (...args: never[]) => WrappableLww
  __inboundGuestLwwForward?: boolean
}

const wrappedComponents = new WeakSet<object>()

const TRANSFORM_COMPONENT_ID = 1
const TRANSFORM_JUMP_M = 20

/** Last bytes posted to the host per (component, entity) — skip echoes. */
const lastForwarded = new Map<string, Uint8Array>()
const lastTransformXz = new Map<number, { x: number; z: number }>()
let applyWindowStart = 0
let applyTransformPuts = 0
let applyOtherPuts = 0
let applyJumpN = 0
let applyMaxJump = 0
let applyMaxJumpEntity = 0
let lastJumpLogAt = 0
const pendingChunks: Uint8Array[] = []
let flushScheduled = false
let postChunk: ((data: Uint8Array) => void) | null = null
type WorkerLogFn = (
  level: 'log' | 'info' | 'warn' | 'error' | 'debug',
  message: string
) => void
let log: WorkerLogFn | null = null
let lastLogAt = 0

function forwardKey(componentId: number, entityId: number): string {
  return `${componentId}:${entityId}`
}

function encodePut(entityId: number, componentId: number, timestamp: number, data: Uint8Array): Uint8Array {
  const buf = new ReadWriteByteBuffer()
  PutComponentOperation.write(entityId as Entity, timestamp, componentId, data, buf)
  return buf.toCopiedBinary()
}

function encodeDelete(entityId: number, componentId: number, timestamp: number): Uint8Array {
  const buf = new ReadWriteByteBuffer()
  DeleteComponent.write(entityId as Entity, componentId, timestamp, buf)
  return buf.toCopiedBinary()
}

function scheduleFlush(): void {
  if (flushScheduled || !postChunk) return
  flushScheduled = true
  queueMicrotask(() => {
    flushScheduled = false
    if (!pendingChunks.length || !postChunk) return
    const coalesced = coalesceCrdtChunksLww(pendingChunks.splice(0))
    let bytes = 0
    let puts = 0
    for (const chunk of coalesced) {
      if (!chunk.byteLength) continue
      bytes += chunk.byteLength
      puts++
      postChunk(chunk)
    }
    const now = performance.now()
    if (puts > 0 && log && now - lastLogAt > 2_000) {
      lastLogAt = now
      log('log', `[sceneWorker] inbound guest LWW → host — chunks=${puts} bytes=${bytes}`)
    }
  })
}

function enqueueHostCrdt(chunk: Uint8Array): void {
  if (!chunk.byteLength) return
  pendingChunks.push(chunk)
  scheduleFlush()
}

function readTransformXz(data: Uint8Array): { x: number; z: number } | null {
  if (data.byteLength < 12) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return { x: view.getFloat32(0, true), z: view.getFloat32(8, true) }
}

function maybeFlushApplyProof(force = false): void {
  const now = performance.now()
  if (applyWindowStart === 0) applyWindowStart = now
  if (!force && now - applyWindowStart < 1000) return
  if (applyTransformPuts === 0 && applyOtherPuts === 0 && applyJumpN === 0) {
    applyWindowStart = now
    return
  }
  if (log) {
    log(
      'warn',
      `[sceneWorker] net-proof apply 1s — transformPuts=${applyTransformPuts} otherPuts=${applyOtherPuts} ` +
        `jump>${TRANSFORM_JUMP_M}m×${applyJumpN} maxJump=${applyMaxJump.toFixed(1)}m` +
        (applyMaxJumpEntity ? ` e${applyMaxJumpEntity}` : '')
    )
  }
  applyTransformPuts = 0
  applyOtherPuts = 0
  applyJumpN = 0
  applyMaxJump = 0
  applyMaxJumpEntity = 0
  applyWindowStart = now
}

function noteInboundTransformApply(entityId: number, data: Uint8Array): void {
  const xz = readTransformXz(data)
  applyTransformPuts++
  if (!xz) return
  const prev = lastTransformXz.get(entityId)
  lastTransformXz.set(entityId, xz)
  if (!prev) return
  const jump = Math.hypot(xz.x - prev.x, xz.z - prev.z)
  if (jump > applyMaxJump) {
    applyMaxJump = jump
    applyMaxJumpEntity = entityId
  }
  if (jump <= TRANSFORM_JUMP_M) return
  applyJumpN++
  const now = performance.now()
  if (!log || now - lastJumpLogAt < 250) return
  lastJumpLogAt = now
  log(
    'warn',
    `[sceneWorker] net-proof Transform jump ${jump.toFixed(1)}m e${entityId} ` +
      `(${prev.x.toFixed(1)},${prev.z.toFixed(1)})→(${xz.x.toFixed(1)},${xz.z.toFixed(1)})`
  )
}

export function flushInboundGuestLwwApplyProof(): void {
  maybeFlushApplyProof(true)
}

function shouldForward(componentId: number, entityId: number): boolean {
  return !isHostOwnedLwwEgress(componentId, entityId)
}

function wrapUpdateFromCrdt(comp: WrappableLww): void {
  if (wrappedComponents.has(comp)) return
  const orig = comp.updateFromCrdt.bind(comp)
  if (typeof orig !== 'function') return
  const componentId = comp.componentId
  try {
    comp.updateFromCrdt = (msg: CrdtBody) => {
      const result = orig(msg)
      const entityId = msg?.entityId
      if (typeof entityId !== 'number' || !shouldForward(componentId, entityId)) {
        return result
      }
      const type = msg.type
      const ts = typeof msg.timestamp === 'number' ? msg.timestamp : 0
      const key = forwardKey(componentId, entityId)
      if (
        type === CrdtMessageType.PUT_COMPONENT ||
        type === CrdtMessageType.PUT_COMPONENT_NETWORK
      ) {
        const data = msg.data
        if (!data?.byteLength) return result
        const prev = lastForwarded.get(key)
        if (prev && dataCompare(prev, data) === 0) return result
        lastForwarded.set(key, data)
        if (componentId === TRANSFORM_COMPONENT_ID) noteInboundTransformApply(entityId, data)
        else applyOtherPuts++
        maybeFlushApplyProof()
        enqueueHostCrdt(encodePut(entityId, componentId, ts, data))
      } else if (
        type === CrdtMessageType.DELETE_COMPONENT ||
        type === CrdtMessageType.DELETE_COMPONENT_NETWORK
      ) {
        lastForwarded.delete(key)
        enqueueHostCrdt(encodeDelete(entityId, componentId, ts))
      }
      return result
    }
    wrappedComponents.add(comp)
  } catch {
    /* frozen component */
  }
}

function wrapDefine(
  engine: EngineLike,
  key: 'defineComponent' | 'defineComponentFromSchema'
): void {
  const orig = engine[key]
  if (typeof orig !== 'function') return
  const bound = orig.bind(engine) as (...args: unknown[]) => WrappableLww
  engine[key] = ((...args: unknown[]) => {
    const comp = bound(...args)
    if (comp && typeof comp.updateFromCrdt === 'function') wrapUpdateFromCrdt(comp)
    return comp
  }) as typeof orig
}

export function resetInboundGuestLwwForward(): void {
  lastForwarded.clear()
  lastTransformXz.clear()
  pendingChunks.length = 0
  flushScheduled = false
  applyWindowStart = 0
  applyTransformPuts = 0
  applyOtherPuts = 0
  applyJumpN = 0
  applyMaxJump = 0
  applyMaxJumpEntity = 0
}

export function installInboundGuestLwwHostForward(
  engine: EngineLike,
  post: (data: Uint8Array) => void,
  logger?: WorkerLogFn
): void {
  postChunk = post
  if (logger) log = logger
  if (typeof engine.componentsIter === 'function') {
    try {
      for (const comp of engine.componentsIter()) {
        if (comp && typeof comp.updateFromCrdt === 'function') wrapUpdateFromCrdt(comp)
      }
    } catch {
      /* ignore */
    }
  }
  if (!engine.__inboundGuestLwwForward) {
    wrapDefine(engine, 'defineComponent')
    wrapDefine(engine, 'defineComponentFromSchema')
    engine.__inboundGuestLwwForward = true
  }
}
