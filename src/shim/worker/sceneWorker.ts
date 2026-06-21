import {
  createSystemStubs,
  evaluateSceneBundle,
  watchRendererTransportOnmessage
} from '../system/createSystemStubs'
import { createEngineApiEventState, type EngineApiEventState } from '../engine/EngineApiEventState'
import { resolveBinaryMessageBus } from './captureBinaryMessageBus'
import { installNetworkTransportHook, resolveNetworkTransportOnmessage } from './captureNetworkTransport'
import { processInboundBinaryFallback } from './inboundBinaryFallback'
import { applyRealmInfoOnEngine } from './applyRealmInfoOnEngine'
import type {
  ActiveVideoStreamsResponse,
  CommsAdapterRequest,
  CommsPublishDataRequest,
  CommsTopicRequest,
  ConsumeMessagesResponse,
  MainToWorker,
  RealmResponse,
  SceneWorkerOutbound,
  SendBinaryRequest,
  SendBinaryResponse,
  SignedFetchRequest,
  SignedFetchResponse,
  SignedFetchGetHeadersResponse,
  UserDataResponse
} from '../types'
import type { MovePlayerToRequest, MovePlayerToResponse } from '../../player/movePlayerTo'
import type { OpenExternalUrlRequest, OpenExternalUrlResponse } from '../../player/openExternalUrl'
import type { TriggerEmoteRequest, TriggerEmoteResponse } from '../../player/triggerEmote'
import type { TriggerSceneEmoteRequest, TriggerSceneEmoteResponse } from '../../player/triggerSceneEmote'
import {
  installPointerEventColliderChecker,
  patchSceneBundle
} from './pointerEventColliderCheckerPatch'
import { injectPointerClickOnEngine } from './injectPointerClick'
import { injectRendererGrowOnlyAppendsOnEngine } from './injectRendererGrowOnlyAppends'
import { injectRendererLwwPutsOnEngine } from './injectRendererLwwPuts'
import { applyAvatarAttachTransformsOnEngine } from './applyAvatarAttachTransforms'
import type { InjectPointerClickBody } from '../../player/injectPointerClick'
import { bindSceneWorkerPriorityDispatch, type SceneWorkerPriorityMessage } from './sceneWorkerBootstrap'
import { resolveSceneEngine } from './resolveSceneEngine'
import {
  installPreregisterRendererComponentsHook,
  preregisterRendererInjectedComponents
} from './preregisterRendererInjectedComponents'

const ctx = self

let requestId = 0
const pendingCrdt = new Map<number, (data: Uint8Array[]) => void>()
type QueuedCrdtItem = { id: number; data: Uint8Array; resolve: (data: Uint8Array[]) => void }
const crdtBatchQueue: QueuedCrdtItem[] = []
let crdtBatchDepth = 0
let crdtBatchIdSeq = 0
const pendingCrdtBatch = new Map<
  number,
  { resolvers: Map<number, (data: Uint8Array[]) => void>; settle: () => void }
>()
const pendingGetState = new Map<number, (state: { hasEntities: boolean; data: Uint8Array[] }) => void>()
const pendingMove = new Map<number, (body: MovePlayerToResponse) => void>()
const pendingTriggerEmote = new Map<number, (body: TriggerEmoteResponse) => void>()
const pendingTriggerSceneEmote = new Map<number, (body: TriggerSceneEmoteResponse) => void>()
const pendingOpenExternalUrl = new Map<number, (body: OpenExternalUrlResponse) => void>()
const pendingCommsAdapter = new Map<number, (body: { success: boolean }) => void>()
const pendingSendBinary = new Map<number, (body: SendBinaryResponse) => void>()
const pendingUserData = new Map<number, (body: UserDataResponse) => void>()
const pendingRealm = new Map<number, (body: RealmResponse) => void>()
const pendingIsServer = new Map<number, (body: { isServer: boolean }) => void>()
const pendingSubscribeTopic = new Map<number, (body: Record<string, never>) => void>()
const pendingUnsubscribeTopic = new Map<number, (body: Record<string, never>) => void>()
const pendingPublishData = new Map<number, (body: Record<string, never>) => void>()
const pendingConsumeMessages = new Map<number, (body: ConsumeMessagesResponse) => void>()
const pendingActiveVideoStreams = new Map<number, (body: ActiveVideoStreamsResponse) => void>()
const pendingSignedFetch = new Map<number, (body: SignedFetchResponse) => void>()
const pendingSignedFetchGetHeaders = new Map<number, (body: SignedFetchGetHeadersResponse) => void>()
const pendingCommsSend = new Map<number, (body: Record<string, never>) => void>()
const pendingInboundBinaries: Uint8Array[] = []
let rendererInboundApply: ((chunks: Uint8Array[]) => void) | null = null
let engineApiEvents: EngineApiEventState | null = null
let sceneEngine: import('@dcl/ecs').IEngine | null = null
let sceneRunning = false
let lastTick = performance.now()
/** True while scene onUpdate promise is in flight (may be awaiting crdtSendToRenderer). */
let sceneUpdateInFlight = false
/** True while pointer inbound apply + engine tick is running — scene loop yields. */
let pointerDeliveryInFlight = false
let pointerDeliveryStartedAt = 0
/** Pointer deliver deferred until scene onUpdate finishes after a crdt interrupt. */
let queuedPointerDeliver: Uint8Array[] | null = null
/** Min ms between lightweight engine ticks (pointer/getClick systems). */
const SCENE_TICK_BASE_INTERVAL_MS = 100
/** Min ms between full scene onUpdate — fast during hydration, throttled after play-ready. */
let fullSceneOnUpdateIntervalMs = 250
/** After play-ready: keep onUpdate responsive for pointer/triggers; perf throttle is engine-tick + diff consumer. */
const FULL_SCENE_ONUPDATE_INTERVAL_PLAY_MS = 400
/** Abort in-flight scene onUpdate after this — pointer inject must not queue behind Genesis-scale sync work. */
const SCENE_UPDATE_ABORT_MS = 2000
const SCENE_UPDATE_ABORT_PLAY_MS = 2500
/** Abort pointer engine tick if sceneEngine.update / onUpdate stalls awaiting main-thread CRDT. */
const POINTER_ENGINE_TICK_ABORT_MS = 4000
/** Abort timer — shorter once the scene is interactive. */
let sceneUpdateAbortMs = SCENE_UPDATE_ABORT_MS
let sceneTickIntervalMs = SCENE_TICK_BASE_INTERVAL_MS
let sceneTicksPaused = false
let sceneUpdateAbortTimer: ReturnType<typeof setTimeout> | null = null
let sceneTickTimer: ReturnType<typeof setInterval> | null = null
/** Set when inject arrives before sceneEngine is bound — drained after bundle eval. */
let pendingInjectPointer: InjectPointerClickBody | null = null
let lastHeartbeatAt = performance.now()
let sceneUpdateStartedAt = 0
let lastEngineTickAt = 0
let lastFullSceneUpdateAt = 0
/** True while a deferred sceneEngine.update tick is running. */
let engineTickInFlight = false
/** Scene exports.onUpdate — set when the cooperative loop starts. */
let sceneOnUpdate: ((dt: number) => unknown) | null = null
/** False until exports.onStart resolves — sceneEngine.update during boot can stall Rick Roll worlds. */
let sceneOnStartComplete = false
/** True from boot message until onStart completes — priority inject/deliver is queued. */
let sceneBootInProgress = false
/** Priority lane messages received while sceneBootInProgress — drained after onStart. */
const pendingBootPriority: SceneWorkerPriorityMessage[] = []
/** True after inject until deliver (or fallback) finalizes the batch. */
let pointerDeliverBatchOpen = false
let pointerDeliverAckFallbackTimer: ReturnType<typeof setTimeout> | null = null
/** Genesis composite spawn runs in exports.onUpdate — must stay on (engine.update alone does not load composite). */
const ENABLE_FULL_SCENE_ONUPDATE = true
/** Boot `debug` flags from main (`?pointerverbose` / `?tweenverbose`). */
let debugPointerDeliver = false
let debugTweenDeliver = false
let debugMessageArrival = false
/** Coalesce proactive tween-state injects into one engine tick per frame. */
let tweenEngineTickQueued = false
/** True while a proactive sendBinary flush is in flight (BinaryMessageBus inbound feed). */
let inboundBinaryFlushInFlight = false
/** Coalesce inbound scene-binary sendBinary flushes into one macrotask per burst. */
let inboundBinaryFlushQueued = false
/** Brief debounce so RES_CRDT_STATE chunks batch before BinaryMessageBus dispatch. */
const INBOUND_BINARY_FLUSH_DEBOUNCE_MS = 20
let inboundBinaryBusMissingWarned = false

function decodeInboundBinaryLogLabel(chunk: Uint8Array): string {
  if (chunk.length < 3) return `binary(${chunk.byteLength}B)`
  const senderLen = chunk[0]!
  if (senderLen === 0 || 1 + senderLen + 1 > chunk.length) return `binary(${chunk.byteLength}B)`
  const sender = new TextDecoder().decode(chunk.subarray(1, 1 + senderLen))
  const messageType = chunk[1 + senderLen]!
  const typeNames: Record<number, string> = {
    4: 'CRDT_SERVER',
    5: 'CRDT_AUTHORITATIVE',
    6: 'CUSTOM_EVENT',
    7: 'CRDT',
    8: 'REQ_CRDT_STATE',
    9: 'RES_CRDT_STATE'
  }
  const typeLabel = typeNames[messageType] ?? `type${messageType}`
  return `${typeLabel} from ${sender} (${chunk.byteLength}B)`
}

/**
 * Feed queued gatekeeper scene-room payloads through sync-systems BinaryMessageBus.
 * Must use sendBinary (not rendererInboundApply) so RES_CRDT_STATE / CRDT_AUTHORITATIVE handlers run.
 */
function queueInboundCommsBinary(chunk: Uint8Array, source: 'immediate' | 'flush'): void {
  pendingInboundBinaries.push(chunk.slice())
  const label = decodeInboundBinaryLogLabel(chunk)
  if (
    label.startsWith('RES_CRDT_STATE') ||
    label.startsWith('CRDT_AUTHORITATIVE') ||
    debugMessageArrival
  ) {
    workerLog('log', `[sceneWorker] inbound-binary ${source} — queued ${label}`)
  }
  scheduleInboundBinaryFlush()
}

function scheduleInboundBinaryFlush(): void {
  if (inboundBinaryFlushQueued) return
  inboundBinaryFlushQueued = true
  setTimeout(() => {
    inboundBinaryFlushQueued = false
    void flushInboundBinaryViaSendBinary()
  }, INBOUND_BINARY_FLUSH_DEBOUNCE_MS)
}

function flushInboundBinaryFallback(chunks: Uint8Array[]): boolean {
  const applied = processInboundBinaryFallback(chunks, {
    postAuthoritativeCrdt: (data) => {
      ctx.postMessage({ type: 'authoritative-crdt', data } satisfies SceneWorkerOutbound, [data.buffer])
    },
    applyNetworkCrdt: (data) => {
      resolveNetworkTransportOnmessage()?.(data)
    },
    log: (level, message) => workerLog(level, message)
  })
  return applied > 0
}

async function flushInboundBinaryViaSendBinary(): Promise<void> {
  if (!pendingInboundBinaries.length || inboundBinaryFlushInFlight || !sceneOnStartComplete) return
  inboundBinaryFlushInFlight = true
  const chunks = pendingInboundBinaries.splice(0)
  try {
    const bus = resolveBinaryMessageBus()
    if (bus) {
      bus.__processMessages(chunks)
      const hasResState = chunks.some((chunk) =>
        decodeInboundBinaryLogLabel(chunk).startsWith('RES_CRDT_STATE')
      )
      if (hasResState || debugMessageArrival) {
        workerLog(
          'log',
          `[sceneWorker] inbound-binary flush — BinaryMessageBus processed ${chunks.length} chunk(s)` +
            (hasResState ? ' (incl. RES_CRDT_STATE)' : '')
        )
      }
    } else if (flushInboundBinaryFallback(chunks)) {
      if (!inboundBinaryBusMissingWarned) {
        inboundBinaryBusMissingWarned = true
        workerLog(
          'warn',
          `[sceneWorker] BinaryMessageBus not captured — using inbound-binary fallback (${chunks.length} chunk(s))`
        )
      }
    } else {
      pendingInboundBinaries.unshift(...chunks)
      if (!inboundBinaryBusMissingWarned) {
        inboundBinaryBusMissingWarned = true
        workerLog(
          'warn',
          `[sceneWorker] inbound-binary flush deferred — BinaryMessageBus not captured (${pendingInboundBinaries.length} queued)`
        )
      }
      scheduleInboundBinaryFlush()
      return
    }
    if (sceneEngine && !pointerDeliveryInFlight && !sceneTicksPaused) {
      await runBatchedEngineUpdate(0)
    }
  } catch (err) {
    pendingInboundBinaries.unshift(...chunks)
    workerLog(
      'error',
      `[sceneWorker] inbound-binary flush failed — ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    inboundBinaryFlushInFlight = false
    if (pendingInboundBinaries.length) scheduleInboundBinaryFlush()
  }
}

function clearSceneUpdateAbortTimer(): void {
  if (sceneUpdateAbortTimer) {
    clearTimeout(sceneUpdateAbortTimer)
    sceneUpdateAbortTimer = null
  }
}

function pointerPressureActive(): boolean {
  return (
    pointerDeliveryInFlight ||
    pointerDeliverBatchOpen ||
    queuedPointerDeliver !== null ||
    pendingInjectPointer !== null
  )
}

function armSceneUpdateAbortTimer(): void {
  if (!pointerPressureActive()) return
  clearSceneUpdateAbortTimer()
  sceneUpdateAbortTimer = setTimeout(() => {
    if (!sceneUpdateInFlight) return
    workerLog(
      'error',
      `[sceneWorker] scene onUpdate exceeded ${sceneUpdateAbortMs}ms — aborting for pointer priority`
    )
    sceneUpdateInFlight = false
    // Do not set sceneTicksPaused here — pointer batches pause explicitly; a stuck pause
    // freezes worker onUpdate (campfire sprite pool) while trigger delivers keep firing.
    // Do not interrupt pending CRDT — empty responses drop composite/sprite diffs on main.
    drainQueuedPointerDeliver()
  }, sceneUpdateAbortMs)
}

function resumeSceneTicksAfterPointer(): void {
  if (pointerDeliveryInFlight || sceneUpdateInFlight || queuedPointerDeliver || pendingInjectPointer) return
  sceneTicksPaused = false
}

function postPointerDeliverDone(label: string): void {
  ctx.postMessage({ type: 'pointer-deliver-done' } satisfies SceneWorkerOutbound)
  workerLog('log', `[sceneWorker] ${label} — pointer-deliver-done posted to main`)
}

/**
 * Unblock scene ticks stuck awaiting crdtSendToRenderer so pointer delivery is not queued
 * behind an in-flight main↔worker round-trip (mirror.flushOutgoing can stall main for 500ms+).
 */
function interruptPendingCrdtRoundTrips(): void {
  if (!pendingCrdt.size && !crdtBatchQueue.length && !pendingCrdtBatch.size) return
  const ids = [...pendingCrdt.keys()]
  for (const id of ids) {
    pendingCrdt.get(id)?.([])
    pendingCrdt.delete(id)
  }
  for (const item of crdtBatchQueue.splice(0)) item.resolve([])
  for (const [batchId, batch] of pendingCrdtBatch) {
    for (const resolve of batch.resolvers.values()) resolve([])
    batch.settle()
    pendingCrdtBatch.delete(batchId)
  }
  workerLog(
    'log',
    `[sceneWorker] interrupted ${ids.length} pending crdt round-trip(s) for pointer priority`
  )
}

function beginCrdtBatch(): void {
  crdtBatchDepth++
}

async function endCrdtBatch(): Promise<void> {
  if (crdtBatchDepth <= 0) return
  crdtBatchDepth--
  if (crdtBatchDepth > 0) return
  await flushCrdtBatch()
}

async function runBatchedEngineUpdate(dt: number): Promise<void> {
  if (!sceneEngine) return
  beginCrdtBatch()
  try {
    await sceneEngine.update(dt)
  } finally {
    await endCrdtBatch()
  }
}

async function flushCrdtBatch(): Promise<void> {
  if (!crdtBatchQueue.length) return
  const items = crdtBatchQueue.splice(0)
  const batchId = ++crdtBatchIdSeq
  const resolvers = new Map<number, (data: Uint8Array[]) => void>()
  const outbound: Array<{ id: number; data: Uint8Array }> = []
  for (const item of items) {
    resolvers.set(item.id, item.resolve)
    outbound.push({ id: item.id, data: item.data })
  }
  const flushPromise = new Promise<void>((resolve) => {
    pendingCrdtBatch.set(batchId, { resolvers, settle: resolve })
  })
  const transfers = outbound.filter((entry) => entry.data.byteLength > 0).map((entry) => entry.data.buffer)
  ctx.postMessage(
    { type: 'crdt-send-batch', batchId, items: outbound } satisfies SceneWorkerOutbound,
    transfers
  )
  await flushPromise
}

/** Unblock boot when eval microtasks are stuck awaiting crdt-get-state from main. */
function interruptPendingGetStateRoundTrips(): void {
  if (!pendingGetState.size) return
  const ids = [...pendingGetState.keys()]
  for (const id of ids) {
    pendingGetState.get(id)?.({ hasEntities: false, data: [] })
    pendingGetState.delete(id)
  }
  workerLog('log', `[sceneWorker] interrupted ${ids.length} pending crdt-get-state round-trip(s)`)
}

function drainQueuedPointerDeliver(): void {
  if (pointerDeliveryInFlight || sceneUpdateInFlight || !queuedPointerDeliver) return
  const chunks = queuedPointerDeliver
  queuedPointerDeliver = null
  executePointerDelivery(chunks)
}

function preemptForPointerDelivery(): void {
  const hadSceneUpdate = sceneUpdateInFlight
  sceneUpdateInFlight = false
  engineTickInFlight = false
  clearSceneUpdateAbortTimer()
  // Never abort an in-flight pointer engine tick CRDT flush (post-onUpdate Tween sync depends on it).
  if (pointerDeliveryInFlight) return
  // Only drop in-flight CRDT during an actual pointer click batch — not scene abort / grow-only.
  if (hadSceneUpdate && pendingCrdt.size && pointerDeliverBatchOpen) interruptPendingCrdtRoundTrips()
}

function clearPointerDeliverAckFallback(): void {
  if (pointerDeliverAckFallbackTimer) {
    clearTimeout(pointerDeliverAckFallbackTimer)
    pointerDeliverAckFallbackTimer = null
  }
}

function forceRecoverStuckPointerDelivery(reason: string): void {
  if (!pointerDeliveryInFlight && !pointerDeliverBatchOpen && !sceneTicksPaused) return
  workerLog(
    'error',
    `[sceneWorker] pointer delivery recovery — ${reason} ` +
      `(inFlight=${pointerDeliveryInFlight} batchOpen=${pointerDeliverBatchOpen} ticksPaused=${sceneTicksPaused})`
  )
  clearPointerDeliverAckFallback()
  pointerDeliverBatchOpen = false
  pointerDeliveryInFlight = false
  pointerDeliveryStartedAt = 0
  sceneTicksPaused = false
  interruptPendingCrdtRoundTrips()
  postPointerDeliverDone(reason)
  drainQueuedPointerDeliver()
}

async function runPointerEngineTickWork(label: string): Promise<void> {
  if (!sceneOnStartComplete) {
    workerLog(
      'log',
      `[sceneWorker] ${label} — deferring sceneEngine.update(0) until onStart completes (boot-safe)`
    )
    return
  }
  if (!sceneEngine) {
    workerLog('warn', `[sceneWorker] ${label} — sceneEngine missing, skip update`)
    return
  }
  await runBatchedEngineUpdate(0)
  workerVerboseLog(debugPointerDeliver, 'log', `[sceneWorker] ${label} — sceneEngine.update(0) done`)
  if (sceneOnUpdate) {
    try {
      const result = sceneOnUpdate(0)
      if (result != null && typeof (result as Promise<void>).then === 'function') {
        await result
        workerVerboseLog(debugPointerDeliver, 'log', `[sceneWorker] ${label} — scene onUpdate(0) done (async)`)
      } else {
        workerVerboseLog(debugPointerDeliver, 'log', `[sceneWorker] ${label} — scene onUpdate(0) done (sync)`)
      }
    } catch (err) {
      workerLog(
        'error',
        `[sceneWorker] ${label} scene onUpdate(0) failed — ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  // onUpdate may add Tween / mutate ECS — flush to renderer before pointer batch ends.
  await runBatchedEngineUpdate(0)
  workerVerboseLog(
    debugPointerDeliver,
    'log',
    `[sceneWorker] ${label} — sceneEngine.update(0) post-onUpdate flush done`
  )
}

/**
 * Same-tick engine tick after inject + CRDT apply — getClick() must run before main resumes ticks.
 * Do not defer via setTimeout; worker priority handlers were starving the timer queue.
 */
async function runPointerEngineTickSync(label: string): Promise<void> {
  pointerDeliveryInFlight = true
  pointerDeliveryStartedAt = performance.now()
  let timedOut = false
  const abortTimer = setTimeout(() => {
    timedOut = true
    workerLog(
      'error',
      `[sceneWorker] ${label} — pointer engine tick exceeded ${POINTER_ENGINE_TICK_ABORT_MS}ms; interrupting pending CRDT`
    )
    interruptPendingCrdtRoundTrips()
  }, POINTER_ENGINE_TICK_ABORT_MS)

  try {
    await Promise.race([
      runPointerEngineTickWork(label),
      new Promise<void>((resolve) => {
        setTimeout(resolve, POINTER_ENGINE_TICK_ABORT_MS)
      })
    ])
    if (timedOut) {
      workerLog('warn', `[sceneWorker] ${label} — pointer engine tick finished after abort (partial)`)
    }
  } catch (err) {
    workerLog(
      'error',
      `[sceneWorker] ${label} pointer engine tick failed — ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    clearTimeout(abortTimer)
    pointerDeliveryInFlight = false
    pointerDeliveryStartedAt = 0
    resumeSceneTicksAfterPointer()
    drainQueuedPointerDeliver()
  }
}

/** Run engine tick + onUpdate flush, then ack main — Tween CRDT must finish before deliver-done. */
function finalizePointerDelivery(label: string): void {
  if (!pointerDeliverBatchOpen) {
    workerLog('warn', `[sceneWorker] ${label} — finalize skipped (no open pointer batch)`)
    return
  }
  pointerDeliverBatchOpen = false
  clearPointerDeliverAckFallback()
  void runPointerEngineTickSync(label).then(() => {
    postPointerDeliverDone(label)
  })
}

function armPointerDeliverAckFallback(label: string): void {
  clearPointerDeliverAckFallback()
  pointerDeliverAckFallbackTimer = setTimeout(() => {
    pointerDeliverAckFallbackTimer = null
    if (!pointerDeliverBatchOpen) return
    workerLog('warn', `[sceneWorker] ${label} — no pointer-crdt-deliver; acking inject-only batch`)
    finalizePointerDelivery(`${label}-inject-only`)
  }, 32)
}

function beginPointerDeliverBatch(label: string): void {
  pointerDeliverBatchOpen = true
  armPointerDeliverAckFallback(label)
}

/** Forward to main debug log without relying on patched console (scene onStart may restore native console). */
function workerLog(level: 'log' | 'info' | 'warn' | 'error' | 'debug', message: string): void {
  ctx.postMessage({ type: 'log', message: `[${level}] ${message}` } satisfies SceneWorkerOutbound)
}

function workerVerboseLog(
  enabled: boolean,
  level: 'log' | 'info' | 'warn' | 'error' | 'debug',
  message: string
): void {
  if (!enabled) return
  workerLog(level, message)
}

function scheduleBatchedSceneEngineTick(): void {
  if (tweenEngineTickQueued || !sceneEngine) return
  tweenEngineTickQueued = true
  setTimeout(() => {
    tweenEngineTickQueued = false
    if (!sceneEngine || pointerDeliveryInFlight || sceneTicksPaused) return
    void runBatchedEngineUpdate(0).catch((err) => {
      workerLog(
        'error',
        `[sceneWorker] batched engine tick failed — ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }, 0)
}

function scheduleBatchedTweenEngineTick(): void {
  scheduleBatchedSceneEngineTick()
}

/** Lightweight tween-state path — no pointer pause / preempt / full deliver batch. */
function deliverTweenStateInbound(chunks: Uint8Array[]): void {
  if (!sceneEngine || !sceneOnStartComplete) return
  const { tweenPuts } = injectRendererLwwPutsOnEngine(sceneEngine, chunks)
  if (tweenPuts === 0) return
  workerVerboseLog(
    debugTweenDeliver,
    'log',
    `[sceneWorker] tween-state-deliver — inject ${tweenPuts} TweenState PUT(s)`
  )
  scheduleBatchedTweenEngineTick()
}

/** TriggerAreaResult / VideoEvent — engine tick only; must not pause scene onUpdate (sprite pool). */
function deliverRendererAppendInbound(chunks: Uint8Array[]): void {
  if (!sceneEngine || !sceneOnStartComplete) return
  const { triggerAppends, videoAppends } = applyRendererInboundChunks(chunks)
  if (triggerAppends === 0 && videoAppends === 0) return
  workerVerboseLog(
    debugPointerDeliver,
    'log',
    `[sceneWorker] renderer-append-deliver — trigger=${triggerAppends} videoEvent=${videoAppends}`
  )
  scheduleBatchedSceneEngineTick()
}

function patchWorkerConsole(): void {
  const forward =
    (level: 'log' | 'info' | 'warn' | 'error' | 'debug') =>
    (...args: unknown[]) => {
      const message = args
        .map((arg) => {
          if (typeof arg === 'string') return arg
          try {
            return JSON.stringify(arg)
          } catch {
            return String(arg)
          }
        })
        .join(' ')
      workerLog(level, message)
    }

  console.log = forward('log')
  console.info = forward('info')
  console.warn = forward('warn')
  console.error = forward('error')
  console.debug = forward('debug')
}

function chunkByteCount(chunks: Uint8Array[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
}

function executePointerInjection(body: InjectPointerClickBody): void {
  preemptForPointerDelivery()
  sceneTicksPaused = true
  workerLog(
    'log',
    `[sceneWorker] inject-pointer-click entity=${body.entity} button=${body.button} ts=${body.downTimestamp}/${body.upTimestamp}`
  )
  if (!sceneEngine) {
    pendingInjectPointer = body
    workerLog('warn', '[sceneWorker] inject-pointer-click queued — sceneEngine missing (no ack until bound)')
    return
  }
  pendingInjectPointer = null
  try {
    injectPointerClickOnEngine(sceneEngine, body)
    workerLog('log', '[sceneWorker] inject-pointer-click — PointerEventsResult written')
    beginPointerDeliverBatch('inject-pointer-click')
  } catch (err) {
    workerLog(
      'error',
      `[sceneWorker] inject-pointer-click failed — ${err instanceof Error ? err.message : String(err)}`
    )
    beginPointerDeliverBatch('inject-pointer-click')
  }
}

function drainPendingInjectPointer(): void {
  if (!pendingInjectPointer || !sceneEngine) return
  const body = pendingInjectPointer
  pendingInjectPointer = null
  workerLog('log', '[sceneWorker] draining queued inject-pointer-click after sceneEngine ready')
  executePointerInjection(body)
}

/** Direct path: main posts pre-encoded pointer CRDT — no crdtSendToRenderer round-trip. */
function deliverPointerCrdtInbound(chunks: Uint8Array[]): void {
  if (!chunks?.length) {
    workerLog('warn', '[sceneWorker] pointer-crdt-deliver received — empty payload')
    return
  }
  const bytes = chunkByteCount(chunks)
  workerVerboseLog(
    debugPointerDeliver,
    'log',
    `[sceneWorker] pointer-crdt-deliver received — ${chunks.length} chunk(s), ${bytes} bytes` +
      (sceneUpdateInFlight ? ' (scene tick in flight — preempting)' : '')
  )
  if (pointerDeliveryInFlight) {
    queuedPointerDeliver = chunks
    workerVerboseLog(
      debugPointerDeliver,
      'log',
      '[sceneWorker] pointer-crdt-deliver queued — prior delivery in flight'
    )
    setTimeout(() => {
      if (queuedPointerDeliver) drainQueuedPointerDeliver()
    }, 50)
    return
  }
  executePointerDelivery(chunks)
}

function applyRendererInboundChunks(chunks: Uint8Array[]): {
  tweenPuts: number
  raycastPuts: number
  videoPlayerPuts: number
  triggerAppends: number
  videoAppends: number
  pointerAppends: number
} {
  let tweenPuts = 0
  let raycastPuts = 0
  let videoPlayerPuts = 0
  let triggerAppends = 0
  let videoAppends = 0
  let pointerAppends = 0
  if (sceneEngine) {
    const lww = injectRendererLwwPutsOnEngine(sceneEngine, chunks)
    tweenPuts = lww.tweenPuts
    raycastPuts = lww.raycastPuts
    videoPlayerPuts = lww.videoPlayerPuts
    const growOnly = injectRendererGrowOnlyAppendsOnEngine(sceneEngine, chunks)
    triggerAppends = growOnly.triggerAppends
    videoAppends = growOnly.videoAppends
    pointerAppends = growOnly.pointerAppends
  }
  if (
    tweenPuts === 0 &&
    raycastPuts === 0 &&
    videoPlayerPuts === 0 &&
    triggerAppends === 0 &&
    videoAppends === 0 &&
    pointerAppends === 0 &&
    rendererInboundApply
  ) {
    rendererInboundApply(chunks)
  }
  return { tweenPuts, raycastPuts, videoPlayerPuts, triggerAppends, videoAppends, pointerAppends }
}

function executePointerDelivery(chunks: Uint8Array[]): void {
  if (pointerDeliveryInFlight) {
    queuedPointerDeliver = chunks
    return
  }

  const canDirectInject = !!sceneEngine && sceneOnStartComplete && !pointerDeliverBatchOpen

  // Lightweight path — no scene-tick pause (tween/transform transport-only).
  if (canDirectInject) {
    try {
      const { tweenPuts, raycastPuts, videoPlayerPuts, triggerAppends, videoAppends, pointerAppends } =
        applyRendererInboundChunks(chunks)
      const needsSceneTick =
        raycastPuts > 0 ||
        videoPlayerPuts > 0 ||
        triggerAppends > 0 ||
        pointerAppends > 0
      if (needsSceneTick) {
        preemptForPointerDelivery()
        sceneTicksPaused = true
        workerVerboseLog(
          debugPointerDeliver,
          'log',
          `[sceneWorker] pointer-crdt-deliver — inject trigger=${triggerAppends} videoEvent=${videoAppends} pointer=${pointerAppends} raycast=${raycastPuts} videoPlayer=${videoPlayerPuts}`
        )
        void runPointerEngineTickSync('pointer-crdt-deliver-renderer-inject').then(() => {
          postPointerDeliverDone('pointer-crdt-deliver-renderer-inject')
        })
        return
      }
      if (tweenPuts > 0) {
        workerVerboseLog(
          debugTweenDeliver,
          'log',
          `[sceneWorker] pointer-crdt-deliver — tween inject ${tweenPuts} TweenState PUT(s)`
        )
        scheduleBatchedTweenEngineTick()
      }
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (rendererInboundApply && message.includes('already sealed')) {
        workerVerboseLog(
          debugPointerDeliver,
          'warn',
          '[sceneWorker] pointer-crdt-deliver — direct inject blocked (sealed), falling back to transport'
        )
        rendererInboundApply(chunks)
        return
      }
      workerLog('error', `[sceneWorker] pointer-crdt-deliver failed — ${message}`)
      return
    }
  }

  preemptForPointerDelivery()
  sceneTicksPaused = true
  if (!rendererInboundApply && !canDirectInject) {
    workerLog('warn', '[sceneWorker] pointer-crdt-deliver skipped — rendererInboundApply not bound')
    finalizePointerDelivery('pointer-crdt-deliver')
    return
  }
  try {
    if (pointerDeliverBatchOpen) {
      const { tweenPuts, raycastPuts, videoPlayerPuts, triggerAppends, videoAppends, pointerAppends } =
        applyRendererInboundChunks(chunks)
      workerVerboseLog(
        debugPointerDeliver,
        'log',
        `[sceneWorker] pointer-crdt-deliver — batch apply tween=${tweenPuts} raycast=${raycastPuts} videoPlayer=${videoPlayerPuts} trigger=${triggerAppends} video=${videoAppends} pointer=${pointerAppends}`
      )
      finalizePointerDelivery('pointer-crdt-deliver')
      return
    }

    applyRendererInboundChunks(chunks)
    workerVerboseLog(
      debugPointerDeliver,
      'log',
      '[sceneWorker] pointer-crdt-deliver — rendererInboundApply done (pre-onStart)'
    )
    resumeSceneTicksAfterPointer()
  } catch (err) {
    workerLog(
      'error',
      `[sceneWorker] pointer-crdt-deliver failed — ${err instanceof Error ? err.message : String(err)}`
    )
    if (pointerDeliverBatchOpen) {
      finalizePointerDelivery('pointer-crdt-deliver')
    } else {
      resumeSceneTicksAfterPointer()
    }
  }
}

type RendererTransportLike = {
  onmessage?: (message: Uint8Array) => void
  type?: string
  send?: unknown
  filter?: unknown
}

/** Keys whose getters must not be read during transport discovery (may have side effects). */
const SKIP_EXPORT_GRAPH_KEYS = new Set(['onStart', 'onUpdate', 'main'])

type RendererTransportResolveOptions = {
  /** Invoke rendererTransport export thunks (unsafe before onStart). */
  allowThunks?: boolean
  /** Read accessor properties while probing (unsafe before onStart). */
  allowGetters?: boolean
  /** Walk nested export/engine graphs when direct exports miss. */
  allowGraphSearch?: boolean
}

function readOwnProperty(obj: object, key: string, allowGetters: boolean): unknown {
  const desc = Object.getOwnPropertyDescriptor(obj, key)
  if (!desc) return undefined
  if (desc.get) {
    if (!allowGetters) return undefined
    try {
      return desc.get.call(obj)
    } catch {
      return undefined
    }
  }
  if ('value' in desc) return desc.value
  return (obj as Record<string, unknown>)[key]
}

function hasOwnFunction(obj: object, key: string): boolean {
  const desc = Object.getOwnPropertyDescriptor(obj, key)
  return !!desc && 'value' in desc && typeof desc.value === 'function'
}

/** Unwrap rendererTransport export thunks only when explicitly allowed. */
function unwrapRendererTransportExport(raw: unknown, allowThunks: boolean): unknown {
  if (raw == null) return raw
  if (typeof raw === 'function') {
    if (!allowThunks) return undefined
    try {
      return (raw as () => unknown)()
    } catch {
      return undefined
    }
  }
  return raw
}

function pickRendererTransport(val: unknown): RendererTransportLike | null {
  if (!val || typeof val !== 'object') return null
  const transport = val as RendererTransportLike
  if (transport.type === 'renderer') return transport
  if (hasOwnFunction(transport, 'onmessage')) return transport
  if (hasOwnFunction(transport, 'send') && hasOwnFunction(transport, 'filter')) return transport
  return null
}

function findRendererTransportInObject(
  root: unknown,
  maxDepth: number,
  allowGetters: boolean,
  allowThunks: boolean
): RendererTransportLike | null {
  if (root == null || maxDepth < 0) return null

  const direct = pickRendererTransport(root)
  if (direct) return direct
  if (typeof root !== 'object') return null

  const seen = new Set<object>()
  const queue: Array<{ val: unknown; depth: number }> = [{ val: root, depth: 0 }]

  while (queue.length) {
    const item = queue.shift()
    if (!item) continue
    const { val, depth } = item
    if (!val || typeof val !== 'object') continue
    if (seen.has(val)) continue
    seen.add(val)

    const picked = pickRendererTransport(val)
    if (picked) return picked

    const rec = val as Record<string, unknown>
    const nested = readOwnProperty(rec, 'rendererTransport', allowGetters)
    if (nested != null) {
      const fromNested = pickRendererTransport(unwrapRendererTransportExport(nested, allowThunks))
      if (fromNested) return fromNested
    }

    if (depth >= maxDepth) continue
    for (const key of Object.getOwnPropertyNames(rec)) {
      if (SKIP_EXPORT_GRAPH_KEYS.has(key)) continue
      const desc = Object.getOwnPropertyDescriptor(rec, key)
      if (!desc || desc.get) continue
      if (!('value' in desc)) continue
      const child = desc.value
      if (child != null && typeof child === 'object') {
        queue.push({ val: child, depth: depth + 1 })
      }
    }
  }

  return null
}

/**
 * Resolve the scene renderer transport without invoking scene export thunks (onStart/main/…).
 * Blind getter/thunk calls during boot have re-triggered scene init and stalled Rick Roll worlds.
 */
function resolveRendererTransport(
  exports: import('../system/createSystemStubs').SceneBundleExports,
  sceneEngine: import('@dcl/ecs').IEngine | null,
  options: RendererTransportResolveOptions = {}
): RendererTransportLike | null {
  const allowThunks = options.allowThunks === true
  const allowGetters = options.allowGetters === true
  const allowGraphSearch = options.allowGraphSearch !== false

  const fromExport = pickRendererTransport(
    unwrapRendererTransportExport(readOwnProperty(exports, 'rendererTransport', allowGetters), allowThunks)
  )
  if (fromExport) return fromExport

  const engineExport = readOwnProperty(exports, 'engine', allowGetters)
  if (engineExport && typeof engineExport === 'object') {
    const fromEngineExport = pickRendererTransport(
      unwrapRendererTransportExport(readOwnProperty(engineExport, 'rendererTransport', allowGetters), allowThunks)
    )
    if (fromEngineExport) return fromEngineExport
  }

  if (allowGraphSearch) {
    const fromExportsGraph = findRendererTransportInObject(exports, 2, allowGetters, allowThunks)
    if (fromExportsGraph) return fromExportsGraph

    if (sceneEngine) {
      const fromSceneEngine = findRendererTransportInObject(sceneEngine, 3, allowGetters, allowThunks)
      if (fromSceneEngine) return fromSceneEngine
    }
  }

  return null
}

function describeRendererTransportProbe(
  exports: import('../system/createSystemStubs').SceneBundleExports,
  sceneEngine: import('@dcl/ecs').IEngine | null
): string {
  const exportKeys = Object.getOwnPropertyNames(exports)
  const raw = readOwnProperty(exports, 'rendererTransport', false)
  let rendererHint = 'missing'
  if (raw != null) {
    rendererHint = typeof raw === 'function' ? 'function(deferred)' : typeof raw
    if (typeof raw === 'object') {
      const t = raw as RendererTransportLike
      rendererHint += `(type=${t.type ?? '?'},onmessage=${hasOwnFunction(t, 'onmessage') ? 'fn' : 'missing'})`
    }
  }
  const engineShape = sceneEngine
    ? `{keys:${Object.getOwnPropertyNames(sceneEngine).slice(0, 16).join('|')},update:${typeof sceneEngine.update}}`
    : 'null'
  return `exportKeys=[${exportKeys.join(',')}] rendererTransport=${rendererHint} sceneEngine=${engineShape}`
}

function bindRendererInbound(
  exports: import('../system/createSystemStubs').SceneBundleExports,
  sceneEngine: import('@dcl/ecs').IEngine | null,
  options: RendererTransportResolveOptions = {}
): void {
  if (rendererInboundApply) return

  const transport = resolveRendererTransport(exports, sceneEngine, options)
  if (!transport) {
    if (options.allowThunks || options.allowGetters) {
      workerLog(
        'warn',
        `[sceneWorker] rendererTransport not found — pointer CRDT may not reach scene systems (${describeRendererTransportProbe(exports, sceneEngine)})`
      )
    }
    return
  }

  const applyBinding = (onmessage: (chunk: Uint8Array) => void) => {
    if (rendererInboundApply) return
    rendererInboundApply = (chunks) => {
      for (const chunk of chunks) onmessage(chunk)
    }
    workerLog('log', '[sceneWorker] renderer inbound bound')
  }

  watchRendererTransportOnmessage(transport, applyBinding)
}

function rpcCrdt(data: Uint8Array): Promise<Uint8Array[]> {
  const id = ++requestId
  const copy = data.slice()
  return new Promise((resolve) => {
    if (crdtBatchDepth > 0 && sceneRunning) {
      crdtBatchQueue.push({ id, data: copy, resolve })
      return
    }
    pendingCrdt.set(id, resolve)
    const msg = { type: 'crdt-send', id, data: copy } satisfies SceneWorkerOutbound
    // Do not transfer an empty view's backing buffer — some runtimes deliver a broken payload.
    if (copy.byteLength === 0) ctx.postMessage(msg)
    else ctx.postMessage(msg, [copy.buffer])
  })
}

function rpcGetState(): Promise<{ hasEntities: boolean; data: Uint8Array[] }> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingGetState.set(id, resolve)
    if (sceneBootInProgress) {
      workerLog('log', `[sceneWorker] crdt-get-state posted id=${id} (boot)`)
    }
    ctx.postMessage({ type: 'crdt-get-state', id } satisfies SceneWorkerOutbound)
  })
}

function rpcMovePlayerTo(body: MovePlayerToRequest): Promise<MovePlayerToResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingMove.set(id, resolve)
    ctx.postMessage({ type: 'move-player-to', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcTriggerEmote(body: TriggerEmoteRequest): Promise<TriggerEmoteResponse> {
  const id = ++requestId
  const emote = body.predefinedEmote?.trim()
  if (emote) workerLog('log', `[sceneWorker] triggerEmote → ${emote}`)
  return new Promise((resolve) => {
    pendingTriggerEmote.set(id, resolve)
    ctx.postMessage({ type: 'trigger-emote', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcTriggerSceneEmote(body: TriggerSceneEmoteRequest): Promise<TriggerSceneEmoteResponse> {
  const id = ++requestId
  const src = body.src?.trim()
  if (src) {
    console.log('[sceneWorker]', `triggerSceneEmote RPC → ${src}`)
    workerLog('log', `[sceneWorker] triggerSceneEmote RPC → ${src}`)
  }
  return new Promise((resolve) => {
    pendingTriggerSceneEmote.set(id, resolve)
    ctx.postMessage({ type: 'trigger-scene-emote', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcOpenExternalUrl(body: OpenExternalUrlRequest): Promise<OpenExternalUrlResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingOpenExternalUrl.set(id, resolve)
    ctx.postMessage({ type: 'open-external-url', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcCommsAdapter(body: CommsAdapterRequest): Promise<{ success: boolean }> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingCommsAdapter.set(id, resolve)
    ctx.postMessage({ type: 'set-comms-adapter', id, body } satisfies SceneWorkerOutbound)
  })
}

function mergeSendBinaryResponse(body: SendBinaryResponse): SendBinaryResponse {
  if (!pendingInboundBinaries.length) return body
  return { data: [...body.data, ...pendingInboundBinaries.splice(0)] }
}

function rpcSendBinary(body: SendBinaryRequest): Promise<SendBinaryResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingSendBinary.set(id, (response) => resolve(mergeSendBinaryResponse(response)))
    ctx.postMessage({ type: 'comms-send-binary', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcGetUserData(): Promise<UserDataResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingUserData.set(id, resolve)
    ctx.postMessage({ type: 'get-user-data', id } satisfies SceneWorkerOutbound)
  })
}

function rpcGetRealm(): Promise<RealmResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingRealm.set(id, resolve)
    ctx.postMessage({ type: 'get-realm', id } satisfies SceneWorkerOutbound)
  })
}

function rpcIsServer(): Promise<{ isServer: boolean }> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingIsServer.set(id, resolve)
    ctx.postMessage({ type: 'is-server', id } satisfies SceneWorkerOutbound)
  })
}

function rpcSubscribeTopic(body: CommsTopicRequest): Promise<Record<string, never>> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingSubscribeTopic.set(id, resolve)
    ctx.postMessage({ type: 'comms-subscribe-topic', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcUnsubscribeTopic(body: CommsTopicRequest): Promise<Record<string, never>> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingUnsubscribeTopic.set(id, resolve)
    ctx.postMessage({ type: 'comms-unsubscribe-topic', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcPublishData(body: CommsPublishDataRequest): Promise<Record<string, never>> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingPublishData.set(id, resolve)
    ctx.postMessage({ type: 'comms-publish-data', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcConsumeMessages(body: CommsTopicRequest): Promise<ConsumeMessagesResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingConsumeMessages.set(id, resolve)
    ctx.postMessage({ type: 'comms-consume-messages', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcGetActiveVideoStreams(): Promise<ActiveVideoStreamsResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingActiveVideoStreams.set(id, resolve)
    ctx.postMessage({ type: 'comms-get-active-video-streams', id } satisfies SceneWorkerOutbound)
  })
}

function rpcCommsSend(body: { message: string }): Promise<Record<string, never>> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingCommsSend.set(id, resolve)
    ctx.postMessage({ type: 'comms-send', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcSignedFetch(body: SignedFetchRequest): Promise<SignedFetchResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingSignedFetch.set(id, resolve)
    ctx.postMessage({ type: 'signed-fetch', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcSignedFetchGetHeaders(body: SignedFetchRequest): Promise<SignedFetchGetHeadersResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingSignedFetchGetHeaders.set(id, resolve)
    ctx.postMessage({ type: 'signed-fetch-get-headers', id, body } satisfies SceneWorkerOutbound)
  })
}

async function startSceneLoop(exports: ReturnType<typeof evaluateSceneBundle>): Promise<void> {
  sceneRunning = true
  lastTick = performance.now()
  sceneTickIntervalMs = SCENE_TICK_BASE_INTERVAL_MS

  const sceneUpdate = exports.onUpdate
  sceneOnUpdate = sceneUpdate ?? null
  workerLog(
    'log',
    `[sceneWorker] scene loop started — onUpdate=${sceneUpdate ? 'present' : 'absent'}, interval=${SCENE_TICK_BASE_INTERVAL_MS}ms cooperative`
  )

  let heartbeatPass = 0
  setInterval(() => {
    if (!sceneRunning) return
    heartbeatPass++
    const now = performance.now()
    const sinceLast = now - lastHeartbeatAt
    if (sinceLast > 10_000) {
      workerLog(
        'error',
        `[sceneWorker] heartbeat stalled ${Math.round(sinceLast)}ms — worker event loop blocked ` +
          `(sceneUpdateInFlight=${sceneUpdateInFlight} pointerDeliveryInFlight=${pointerDeliveryInFlight})`
      )
    }
    if (sceneUpdateInFlight && sceneUpdateStartedAt > 0 && now - sceneUpdateStartedAt > 8_000) {
      workerLog(
        'error',
        `[sceneWorker] scene onUpdate running >8s — pointer inject/deliver messages will queue behind it`
      )
    }
    if (
      pointerDeliveryInFlight &&
      pointerDeliveryStartedAt > 0 &&
      now - pointerDeliveryStartedAt > POINTER_ENGINE_TICK_ABORT_MS + 1_000
    ) {
      forceRecoverStuckPointerDelivery('heartbeat-stuck-pointer-delivery')
    }
    lastHeartbeatAt = now
    workerLog(
      'log',
      `[sceneWorker] heartbeat — tick=${heartbeatPass} sceneUpdateInFlight=${sceneUpdateInFlight} pointerDeliveryInFlight=${pointerDeliveryInFlight} pendingCrdt=${pendingCrdt.size} sceneEngine=${sceneEngine ? 'ok' : 'missing'} sceneTickIntervalMs=${sceneTickIntervalMs}`
    )
  }, 5000)

  const scheduleSceneUpdate = (dt: number): void => {
    if (!sceneUpdate || sceneUpdateInFlight) return
    lastFullSceneUpdateAt = performance.now()
    setTimeout(() => {
      if (
        sceneTicksPaused ||
        pendingInjectPointer ||
        queuedPointerDeliver ||
        pointerDeliveryInFlight
      ) {
        return
      }
      sceneUpdateInFlight = true
      sceneUpdateStartedAt = performance.now()
      armSceneUpdateAbortTimer()
      void Promise.resolve(sceneUpdate(dt))
        .then(async () => {
          if (!sceneEngine || sceneTicksPaused) return
          try {
            await runBatchedEngineUpdate(0)
          } catch (err) {
            workerLog(
              'error',
              `[sceneWorker] post-onUpdate engine flush failed — ${err instanceof Error ? err.message : String(err)}`
            )
          }
        })
        .catch((err) => {
          workerLog(
            'error',
            `[sceneWorker] scene tick failed — ${err instanceof Error ? err.message : String(err)}`
          )
        })
        .finally(() => {
          clearSceneUpdateAbortTimer()
          sceneUpdateInFlight = false
          resumeSceneTicksAfterPointer()
          drainQueuedPointerDeliver()
        })
    }, 0)
  }

  const scheduleEngineTick = (dt: number): void => {
    if (!sceneEngine || sceneUpdateInFlight || pointerDeliveryInFlight || engineTickInFlight) return
    if (sceneTicksPaused || pendingInjectPointer || queuedPointerDeliver) return
    engineTickInFlight = true
    setTimeout(() => {
      engineTickInFlight = false
      if (!sceneEngine || sceneTicksPaused || pendingInjectPointer || pointerDeliveryInFlight) return
      lastEngineTickAt = performance.now()
      try {
        void runBatchedEngineUpdate(dt)
      } catch (err) {
        workerLog(
          'error',
          `[sceneWorker] engine tick failed — ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }, 0)
  }

  const runCooperativeTick = (): void => {
    if (!sceneRunning) return
    const now = performance.now()
    const dt = Math.min((now - lastTick) / 1000, 0.1)
    lastTick = now

    const pointerPending =
      sceneTicksPaused || pendingInjectPointer || queuedPointerDeliver || pointerDeliveryInFlight

    if (
      sceneEngine &&
      !sceneUpdateInFlight &&
      !pointerPending &&
      !engineTickInFlight &&
      now - lastEngineTickAt >= SCENE_TICK_BASE_INTERVAL_MS
    ) {
      scheduleEngineTick(dt)
    }

    if (
      ENABLE_FULL_SCENE_ONUPDATE &&
      sceneUpdate &&
      !sceneTicksPaused &&
      !sceneUpdateInFlight &&
      !pointerDeliveryInFlight &&
      !engineTickInFlight &&
      !queuedPointerDeliver &&
      !pendingInjectPointer &&
      now - lastFullSceneUpdateAt >= fullSceneOnUpdateIntervalMs
    ) {
      scheduleSceneUpdate(dt)
    }
  }

  if (sceneTickTimer) clearInterval(sceneTickTimer)
  sceneTickTimer = setInterval(runCooperativeTick, SCENE_TICK_BASE_INTERVAL_MS)
  runCooperativeTick()
}

/** onStart + post-onStart setup — scheduled as a macrotask so eval microtasks can finish first. */
async function completeSceneBoot(exports: import('../system/createSystemStubs').SceneBundleExports): Promise<void> {
  workerLog('log', '[sceneWorker] onStart — begin')
  const onStartWatchdog = setTimeout(() => {
    workerLog(
      'error',
      '[sceneWorker] onStart exceeded 45s — likely stuck awaiting renderer RPC (crdt-get-state / crdt-send)'
    )
  }, 45_000)
  try {
    if (exports.onStart) await exports.onStart()
  } finally {
    clearTimeout(onStartWatchdog)
  }
  sceneOnStartComplete = true
  sceneBootInProgress = false
  workerLog('log', '[sceneWorker] onStart — complete')
  drainPendingBootPriority()
  if (!sceneEngine) {
    sceneEngine = resolveSceneEngine(exports)
  }
  drainPendingInjectPointer()
  if (!sceneEngine) {
    const message =
      '[sceneWorker] FATAL — sceneEngine null after onStart; pointer inject and engine.update(0) unavailable'
    workerLog('error', message)
    ctx.postMessage({ type: 'error', message } satisfies SceneWorkerOutbound)
    return
  }
  workerLog('log', '[sceneWorker] sceneEngine ok after onStart')
  try {
    installPointerEventColliderChecker(sceneEngine)
    workerLog('log', '[sceneWorker] pointerEventColliderChecker installed (post-onStart)')
  } catch (err) {
    workerLog(
      'warn',
      `[sceneWorker] pointerEventColliderChecker install failed — ${err instanceof Error ? err.message : String(err)}`
    )
  }
  patchWorkerConsole()
  bindRendererInbound(exports, sceneEngine, {
    allowThunks: true,
    allowGetters: true,
    allowGraphSearch: true
  })
  try {
    await runBatchedEngineUpdate(0)
    workerLog('log', '[sceneWorker] post-onStart engine.update(0) — composite CRDT flushed to renderer')
  } catch (err) {
    workerLog(
      'error',
      `[sceneWorker] post-onStart engine.update failed — ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (exports.onUpdate) {
    try {
      await Promise.resolve(exports.onUpdate(0))
      workerLog('log', '[sceneWorker] post-onStart onUpdate(0) — composite spawn kickstarted')
    } catch (err) {
      workerLog(
        'error',
        `[sceneWorker] post-onStart onUpdate failed — ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  workerLog(
    'log',
    `scene worker ready — onStart complete (binaryMessageBus=${resolveBinaryMessageBus() ? 'ok' : 'missing'})`
  )
  scheduleInboundBinaryFlush()
  ctx.postMessage({ type: 'ready' } satisfies SceneWorkerOutbound)
  startSceneLoop(exports).catch((err) =>
    workerLog(
      'error',
      `[sceneWorker] scene loop failed to start — ${err instanceof Error ? err.message : String(err)}`
    )
  )
}

async function handleMainToWorkerMessage(msg: MainToWorker): Promise<void> {
  if (msg.type === 'scene-play-ready') {
    fullSceneOnUpdateIntervalMs = FULL_SCENE_ONUPDATE_INTERVAL_PLAY_MS
    sceneUpdateAbortMs = SCENE_UPDATE_ABORT_PLAY_MS
    sceneTickIntervalMs = SCENE_TICK_BASE_INTERVAL_MS
    workerLog(
      'log',
      `[sceneWorker] scene-play-ready — onUpdate interval ${fullSceneOnUpdateIntervalMs}ms, abort ${sceneUpdateAbortMs}ms`
    )
    return
  }
  if (msg.type === 'crdt-response') {
    pendingCrdt.get(msg.id)?.(msg.data)
    pendingCrdt.delete(msg.id)
    return
  }
  if (msg.type === 'crdt-response-batch') {
    const batch = pendingCrdtBatch.get(msg.batchId)
    if (batch) {
      for (const item of msg.items) {
        batch.resolvers.get(item.id)?.(item.data)
        batch.resolvers.delete(item.id)
      }
      for (const resolve of batch.resolvers.values()) resolve([])
      batch.settle()
      pendingCrdtBatch.delete(msg.batchId)
    }
    return
  }
  if (msg.type === 'crdt-get-state-response') {
    if (sceneBootInProgress) {
      workerLog(
        'log',
        `[sceneWorker] crdt-get-state-response id=${msg.id} chunks=${msg.data?.length ?? 0} hasEntities=${msg.hasEntities}`
      )
    }
    pendingGetState.get(msg.id)?.({ hasEntities: msg.hasEntities, data: msg.data })
    pendingGetState.delete(msg.id)
    return
  }
  if (msg.type === 'move-player-to-response') {
    pendingMove.get(msg.id)?.(msg.body)
    pendingMove.delete(msg.id)
    return
  }
  if (msg.type === 'trigger-emote-response') {
    pendingTriggerEmote.get(msg.id)?.(msg.body)
    pendingTriggerEmote.delete(msg.id)
    return
  }
  if (msg.type === 'trigger-scene-emote-response') {
    pendingTriggerSceneEmote.get(msg.id)?.(msg.body)
    pendingTriggerSceneEmote.delete(msg.id)
    return
  }
  if (msg.type === 'open-external-url-response') {
    pendingOpenExternalUrl.get(msg.id)?.(msg.body)
    pendingOpenExternalUrl.delete(msg.id)
    return
  }
  if (msg.type === 'set-comms-adapter-response') {
    pendingCommsAdapter.get(msg.id)?.(msg.body)
    pendingCommsAdapter.delete(msg.id)
    return
  }
  if (msg.type === 'comms-send-binary-response') {
    pendingSendBinary.get(msg.id)?.(msg.body)
    pendingSendBinary.delete(msg.id)
    return
  }
  if (msg.type === 'get-user-data-response') {
    pendingUserData.get(msg.id)?.(msg.body)
    pendingUserData.delete(msg.id)
    return
  }
  if (msg.type === 'get-realm-response') {
    pendingRealm.get(msg.id)?.(msg.body)
    pendingRealm.delete(msg.id)
    return
  }
  if (msg.type === 'comms-subscribe-topic-response') {
    pendingSubscribeTopic.get(msg.id)?.(msg.body)
    pendingSubscribeTopic.delete(msg.id)
    return
  }
  if (msg.type === 'comms-unsubscribe-topic-response') {
    pendingUnsubscribeTopic.get(msg.id)?.(msg.body)
    pendingUnsubscribeTopic.delete(msg.id)
    return
  }
  if (msg.type === 'comms-publish-data-response') {
    pendingPublishData.get(msg.id)?.(msg.body)
    pendingPublishData.delete(msg.id)
    return
  }
  if (msg.type === 'comms-consume-messages-response') {
    pendingConsumeMessages.get(msg.id)?.(msg.body)
    pendingConsumeMessages.delete(msg.id)
    return
  }
  if (msg.type === 'comms-get-active-video-streams-response') {
    pendingActiveVideoStreams.get(msg.id)?.(msg.body)
    pendingActiveVideoStreams.delete(msg.id)
    return
  }
  if (msg.type === 'signed-fetch-response') {
    pendingSignedFetch.get(msg.id)?.(msg.body)
    pendingSignedFetch.delete(msg.id)
    return
  }
  if (msg.type === 'signed-fetch-get-headers-response') {
    pendingSignedFetchGetHeaders.get(msg.id)?.(msg.body)
    pendingSignedFetchGetHeaders.delete(msg.id)
    return
  }
  if (msg.type === 'comms-send-response') {
    pendingCommsSend.get(msg.id)?.(msg.body)
    pendingCommsSend.delete(msg.id)
    return
  }
  if (msg.type === 'comms-receive-binary') {
    queueInboundCommsBinary(msg.data, 'immediate')
    return
  }
  if (msg.type === 'realm-info-update') {
    if (sceneEngine) {
      applyRealmInfoOnEngine(sceneEngine, msg.realmInfo, { forceNotify: true })
      workerLog(
        'log',
        `[sceneWorker] RealmInfo update — isConnectedSceneRoom=${msg.realmInfo.isConnectedSceneRoom === true}`
      )
    }
    if (msg.realmInfo.isConnectedSceneRoom === true) {
      scheduleInboundBinaryFlush()
    }
    return
  }
  if (msg.type === 'is-server-response') {
    pendingIsServer.get(msg.id)?.(msg.body)
    pendingIsServer.delete(msg.id)
    return
  }
  if (msg.type === 'engine-api-enqueue') {
    engineApiEvents?.enqueueMany(msg.events)
    return
  }
  if (msg.type === 'avatar-attach-transforms') {
    if (sceneEngine) {
      applyAvatarAttachTransformsOnEngine(sceneEngine, msg.entries)
    }
    return
  }
  if (msg.type === 'tween-state-deliver') {
    deliverTweenStateInbound(msg.data)
    return
  }
  if (msg.type === 'renderer-append-deliver') {
    deliverRendererAppendInbound(msg.data)
    return
  }

  if (msg.type !== 'boot') return

  try {
    sceneOnStartComplete = false
    sceneBootInProgress = true
    pendingBootPriority.length = 0
    debugPointerDeliver = msg.debug?.pointerDeliver === true
    debugTweenDeliver = msg.debug?.tweenDeliver === true
    debugMessageArrival = msg.debug?.messageArrival === true
    patchWorkerConsole()
    workerLog('log', 'scene worker boot — console forwarding active')
    const res = await fetch(msg.scene.scriptUrl)
    if (!res.ok) throw new Error(`Script fetch ${res.status}`)
    const code = await res.text()

    engineApiEvents = createEngineApiEventState({
      onSubscribe: (eventId) => ctx.postMessage({ type: 'engine-api-subscribe', eventId } satisfies SceneWorkerOutbound),
      onUnsubscribe: (eventId) =>
        ctx.postMessage({ type: 'engine-api-unsubscribe', eventId } satisfies SceneWorkerOutbound)
    })

    const { requireMap } = createSystemStubs(msg.scene, {
      crdtSendToRenderer: rpcCrdt,
      crdtGetState: rpcGetState,
      movePlayerTo: rpcMovePlayerTo,
      triggerEmote: rpcTriggerEmote,
      triggerSceneEmote: rpcTriggerSceneEmote,
      openExternalUrl: rpcOpenExternalUrl,
      commsSend: rpcCommsSend,
      comms: {
        setCommunicationsAdapter: rpcCommsAdapter,
        send: rpcCommsSend,
        sendBinary: rpcSendBinary,
        isServer: rpcIsServer,
        getUserData: rpcGetUserData,
        getRealm: rpcGetRealm,
        subscribeToTopic: rpcSubscribeTopic,
        unsubscribeFromTopic: rpcUnsubscribeTopic,
        publishData: rpcPublishData,
        consumeMessages: rpcConsumeMessages,
        getActiveVideoStreams: rpcGetActiveVideoStreams
      },
      signedFetch: rpcSignedFetch,
      signedFetchGetHeaders: rpcSignedFetchGetHeaders,
      isServer: rpcIsServer
    }, engineApiEvents)

    // Yield so priority inject/deliver messages posted during stub setup can run before bundle eval.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    installPreregisterRendererComponentsHook()
    let authoritativeForwardLogged = false
    installNetworkTransportHook((data) => {
      if (!data?.byteLength) return
      const copy = data.slice()
      if (!authoritativeForwardLogged && copy.byteLength > 512) {
        authoritativeForwardLogged = true
        workerLog('log', `[sceneWorker] authoritative CRDT → main projection (${copy.byteLength}B)`)
      }
      ctx.postMessage({ type: 'authoritative-crdt', data: copy } satisfies SceneWorkerOutbound, [copy.buffer])
    })
    const exports = evaluateSceneBundle(code, requireMap, patchSceneBundle)
    if ((globalThis as Record<string, unknown>).__THREEJS_NETWORK_TRANSPORT_HOOKED__ === true) {
      workerLog('log', '[sceneWorker] network transport projection forwarder installed')
    } else {
      workerLog(
        'warn',
        '[sceneWorker] network transport hook missing — authoritative CRDT may not reach main projection'
      )
    }
    sceneEngine = resolveSceneEngine(exports)
    if (sceneEngine) {
      try {
        preregisterRendererInjectedComponents(sceneEngine)
      } catch (err) {
        workerLog(
          'warn',
          `[sceneWorker] renderer component preregister skipped — ${err instanceof Error ? err.message : String(err)}`
        )
      }
      const engineId = (sceneEngine as { _id?: number })._id
      workerLog(
        'log',
        `[sceneWorker] sceneEngine bound after bundle eval${engineId != null ? ` (_id=${engineId})` : ''}`
      )
    } else {
      workerLog('warn', '[sceneWorker] sceneEngine not found after bundle eval — inject will queue until onStart')
    }
    if (sceneEngine && msg.realmInfo) {
      applyRealmInfoOnEngine(sceneEngine, msg.realmInfo)
      workerLog(
        'log',
        `[sceneWorker] RealmInfo applied — isConnectedSceneRoom=${msg.realmInfo.isConnectedSceneRoom === true} realm=${msg.realmInfo.realmName ?? ''}`
      )
    } else if (msg.realmInfo) {
      workerLog('warn', '[sceneWorker] RealmInfo boot payload skipped — sceneEngine not bound yet')
    }
    // Do not drain inject before onStart — executePointerInjection runs sceneEngine.update(0)
    // via schedulePointerDeliveryComplete and can block the boot handler before onStart (Rick Roll).
    workerLog('log', '[sceneWorker] boot — post-eval inject drain skipped (deferred until after onStart)')
    // Invoke onStart synchronously — a post-eval setTimeout(0) never fired when bundle eval left
    // microtasks stuck awaiting crdt-get-state. Boot handler returns right after onStart is invoked
    // so main can answer get-state while onStart awaits.
    workerLog('log', '[sceneWorker] boot — invoking onStart')
    const bootWatchdog = setTimeout(() => {
      if (sceneOnStartComplete) return
      workerLog(
        'warn',
        `[sceneWorker] boot watchdog 8s — onStart incomplete; pendingGetState=${pendingGetState.size} pendingCrdt=${pendingCrdt.size}`
      )
      if (pendingGetState.size) interruptPendingGetStateRoundTrips()
      if (pendingCrdt.size) interruptPendingCrdtRoundTrips()
    }, 8_000)
    void completeSceneBoot(exports)
      .catch((err) => {
        sceneBootInProgress = false
        sceneRunning = false
        ctx.postMessage({
          type: 'error',
          message: err instanceof Error ? err.message : String(err)
        } satisfies SceneWorkerOutbound)
      })
      .finally(() => clearTimeout(bootWatchdog))
    return
  } catch (err) {
    sceneBootInProgress = false
    sceneRunning = false
    ctx.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    } satisfies SceneWorkerOutbound)
  }
}

/** High-frequency messages excluded from arrival log unless `debug.messageArrival`. */
const QUIET_MESSAGE_TYPES = new Set<string>([
  'crdt-response',
  'crdt-get-state-response',
  'pointer-crdt-deliver',
  'tween-state-deliver'
])
let workerMessageCount = 0

/** Raw postMessage arrival proof — only when `debug.messageArrival` is set at boot. */
function logWorkerMessageArrival(type: string, count: number): void {
  if (!debugMessageArrival || QUIET_MESSAGE_TYPES.has(type)) return
  try {
    ctx.postMessage({
      type: 'log',
      message: `[debug] [sceneWorker] onmessage #${count} type=${type}`
    } satisfies SceneWorkerOutbound)
  } catch {
    /* worker shutting down */
  }
}

/**
 * Single source of truth for inbound messages. Runs the real handler inside a try/catch that
 * forwards thrown errors to main instead of dying silently.
 */
async function dispatchMainToWorkerMessage(msg: MainToWorker): Promise<void> {
  const type = (msg as { type?: string })?.type ?? 'undefined'
  try {
    await handleMainToWorkerMessage(msg)
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      message: `[sceneWorker] message handler threw for type=${type} — ${
        err instanceof Error ? err.message : String(err)
      }`
    } satisfies SceneWorkerOutbound)
  }
}

function dispatchPriorityMessageCore(msg: SceneWorkerPriorityMessage): void {
  workerMessageCount++
  logWorkerMessageArrival(msg.type, workerMessageCount)

  if (msg.type === 'pause-scene-ticks') {
    sceneTicksPaused = msg.paused !== false
    if (sceneTicksPaused) {
      preemptForPointerDelivery()
    } else {
      resumeSceneTicksAfterPointer()
    }
    workerVerboseLog(
      debugPointerDeliver,
      'log',
      `[sceneWorker] scene ticks ${sceneTicksPaused ? 'paused' : 'resumed'}`
    )
    return
  }
  if (msg.type === 'inject-pointer-click') {
    try {
      executePointerInjection(msg.body as InjectPointerClickBody)
    } catch (err) {
      workerLog(
        'error',
        `[sceneWorker] inject-pointer-click handler threw — ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      pointerDeliverBatchOpen = true
      finalizePointerDelivery('inject-pointer-click-error')
    }
    return
  }
  if (msg.type === 'pointer-crdt-deliver') {
    try {
      deliverPointerCrdtInbound(msg.data)
    } catch (err) {
      workerLog(
        'error',
        `[sceneWorker] pointer-crdt-deliver handler threw — ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      pointerDeliverBatchOpen = true
      finalizePointerDelivery('pointer-crdt-deliver-error')
    }
    return
  }
}

function dispatchPriorityMessage(msg: SceneWorkerPriorityMessage): void {
  if (sceneBootInProgress && !sceneOnStartComplete) {
    pendingBootPriority.push(msg)
    return
  }
  dispatchPriorityMessageCore(msg)
}

function drainPendingBootPriority(): void {
  if (!pendingBootPriority.length) return
  const batch = pendingBootPriority.splice(0)
  workerLog('log', `[sceneWorker] draining ${batch.length} queued priority message(s) after onStart`)
  for (const msg of batch) dispatchPriorityMessageCore(msg)
}

bindSceneWorkerPriorityDispatch(dispatchPriorityMessage)

// Non-priority messages (boot, crdt-response, RPC responses, …).
ctx.addEventListener(
  'message',
  (ev: MessageEvent<MainToWorker>) => {
    void dispatchMainToWorkerMessage(ev.data)
  },
  { capture: false }
)
