import {
  createSystemStubs,
  evaluateSceneBundle,
  watchRendererTransportOnmessage
} from '../system/createSystemStubs'
import {
  decodeCommsBinaryMessage,
  encodeCommsBinaryMessage,
  isolateCommsBinaryMessage
} from '../../network/comms/commsBinaryWire'
import {
  dropObsoleteAuthSnapshots,
  resetAuthResCoalesceClock,
  isResCrdtStateType,
  unwrapCraftedCommsMessage
} from '../../network/comms/syncDebug'
import { createEngineApiEventState, type EngineApiEventState } from '../engine/EngineApiEventState'
import type {
  ActiveVideoStreamsResponse,
  CommsAdapterRequest,
  CommsPublishDataRequest,
  CommsTopicRequest,
  ConsumeMessagesResponse,
  HostReservedSceneStore,
  MainToWorker,
  PerformanceTier,
  RealmResponse,
  SceneWorkerOutbound,
  SendBinaryRequest,
  SendBinaryResponse,
  SignedFetchRequest,
  SignedFetchResponse,
  SignedFetchGetHeadersResponse,
  UserDataResponse
} from '../types'
import type { ChangeRealmRequest, ChangeRealmResponse } from '../../player/changeRealm'
import type { CopyToClipboardRequest, CopyToClipboardResponse } from '../../player/copyToClipboard'
import type { MovePlayerToRequest, MovePlayerToResponse } from '../../player/movePlayerTo'
import type { OpenExternalUrlRequest, OpenExternalUrlResponse } from '../../player/openExternalUrl'
import type { OpenNftDialogRequest, OpenNftDialogResponse } from '../../player/openNftDialog'
import type { TeleportToRequest, TeleportToResponse } from '../../player/teleportTo'
import type { TriggerEmoteRequest, TriggerEmoteResponse } from '../../player/triggerEmote'
import type { TriggerSceneEmoteRequest, TriggerSceneEmoteResponse } from '../../player/triggerSceneEmote'
import type {
  SetCameraTransformRequest,
  SetCameraTransformResponse
} from '../../player/setCameraTransform'
import {
  installPointerEventColliderChecker,
  patchSceneBundle,
  patchSceneBundleWithCheckerStrip
} from './pointerEventColliderCheckerPatch'
import {
  installCrdtEncodeComponentMeters,
  installCrdtTransportMeterHook,
  noteCrdtSendToRenderer,
  noteSendBinaryPath,
  type CrdtSendPath
} from './workerEngUpdatePhases'

import {
  applySceneInputSnapshotOnEngine,
  isSceneInputPressedOnPlayer,
  resetWorkerInputSnapshotState,
  SCENE_INPUT_SNAPSHOT_ACTIONS,
  sceneInputSnapshotPressedEqual,
  type SceneInputSnapshotBody
} from '../../player/sceneInputSnapshot'
import { injectSceneKeyOnEngine } from '../../player/injectSceneInput'
import { nextWorkerPointerEventTimestamp } from './workerPointerEventTimestamp'
import { PointerEventType } from '../../input/pointerConstants'
import { InputAction, type InputActionValue } from '../../input/pointerConstants'
import { injectRendererGrowOnlyAppendsOnEngine } from './injectRendererGrowOnlyAppends'
import { injectRendererLwwPutsOnEngine } from './injectRendererLwwPuts'
import {
  applyAvatarAttachTransformsOnEngine,
  applyHostTransformsOnEngine
} from './applyAvatarAttachTransforms'
import type { InjectPointerClickBody } from '../../player/injectPointerClick'
import {
  diagnoseLevelStateGroundRay,
  injectLevelStatePointerEdgeOnEngine,
  injectPointerHoverOnEngine,
  isIaPointerPressedOnEngine
} from './injectPointerClick'
import { bindSceneWorkerPriorityDispatch, type SceneWorkerPriorityMessage } from './sceneWorkerBootstrap'
import {
  coalesceKeyboardSnapshotDuringPointerSession,
  clearWorkerPointerButtonsHeld,
  enterPointerInputSession,
  isPointerInputSessionActive,
  leavePointerInputSession,
  setLevelStatePointerEdgeActive,
  setLevelStatePointerHeld,
  setPointerInteractivePhase,
  setPointerInteractiveTickActive,
  setWorkerPointerButtonHeld,
  workerPointerButtonsHeldList,
  resetPointerInputSession,
  setPointerDeliveryInFlight
} from './sceneWorkerInputSession'
import { resolveSceneEngine } from './resolveSceneEngine'
import { guardVideoPlayerGetMutable } from './guardVideoPlayerGetMutable'
import { installAdminToolsVideoPlayerAutoLink } from './adminToolsVideoPlayerAutoLink'
import { installInputModifierLocomotionGuard } from './inputModifierLocomotionGuard'
import {
  clearInjectOnlySdkPollEventsDeferred,
  markDeferSdkPollEventsAfterInjectUiClick
} from './patchSdkOnUpdatePollEvents'
import {
  ensureMainCameraOnCameraEntity,
  installVirtualCameraBindGuard
} from './virtualCameraBindGuard'
import { installAvatarAttachCreateGuard } from './patchAvatarAttachCreate'
import type { Entity, IEngine } from '@dcl/ecs'
import { ensureTjsComponent } from '../../dcl/ecs/tjsComponent'
import * as extended from '@dcl/ecs/dist/components'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import {
  getLastAuthoredVirtualCanvas,
  installPreregisterRendererComponentsHook,
  installUiVirtualCanvasHook,
  preregisterRendererInjectedComponents,
  resetLastAuthoredVirtualCanvas
} from './preregisterRendererInjectedComponents'
import { installSceneWorkerFetchProxy } from './installSceneWorkerFetchProxy'
import { collectWorkerUiTransformEntityIds } from './resolveBundledUiComponents'
import { resetReactEcsOnceGuard } from './reactEcsOnce'
import {
  hasWorkerReactEcsSync,
  resetWorkerUiFingerprint,
  seedWorkerUiCanvasInformation
} from './workerSceneUiSync'
import {
  coalesceCrdtChunksLww,
  collectWorkerUiMountEntityIds,
  collectWorkerUiMountSnapshot,
  extractSnapshotMountEntityIds,
  reconcileInputModifierCrdtEgress,
  reconcileMainCameraCrdtEgress,
  reconcileWorkerAuthoritativeCrdtEgress,
  resetInputModifierEgressBaseline,
  resetWorkerSceneUiCrdtLamport,
  stripHostOwnedLwwBytes,
  stripRendererHostGrowOnlyAppendsBytes,
  stripSceneUiCrdtBytes,
  stripWorkerAuthoritativeCrdtBytes,
  uiMountSnapshotContentFp,
  uiMountSnapshotDisplayFp
} from './workerSceneUiCrdtOutbound'
import { writeHostLwwNoDirty } from './injectHostLww'
import {
  flushInboundGuestLwwApplyProof,
  installInboundGuestLwwHostForward,
  resetInboundGuestLwwForward
} from './forwardInboundGuestLww'

import {
  collectPlayerFrameSnapshot,
  describeWorkerInputModifier,
  forceClearDisableAllAfterLoadGate,
  isWorkerDisableAllFrozen,
  forceUnfreezeModeOnlyFromMain,
  isWorkerMoveCameraFlightLatched,
  resetPlayerFrameEgressBaseline,
  stripPlayerFrameComponentsFromCrdt,
  takeForcedPlayerFrameClearSnapshot
} from './workerPlayerFrameEgress'
import {
  collectTransformAncestorAnchors,
  isBoundVcPeFollowRig,
  isCinematicTweenRig,
  requestVcBindHydrateFromMain,
  resetVcBindHydrateBaseline,
  takeVcBindHydrateIfNeeded,
  worldFlattenedVcTransform
} from './workerVcBindHydrate'
import { runPlayFramePollPhase } from './workerPlayFrameScheduler'
import {
  armCooperativeReactEcsPaintFollowup
} from './sceneEngineUiScheduler'
import {
  awaitEngineUpdateIdle,
  forceReleaseEngineUpdateMutex,
  bindSceneEngineScheduler,
  drainQueuedSceneEngineTick,
  forceRecoverStuckSceneEngineTick,
  getSceneEngineTickStartedAt,
  initSceneEngineScheduler,
  isSceneEngineTickInFlight,
  isEngineUpdateInFlight,
  preemptSceneEngineTick,
  requestSceneEngineTick,
  queueSceneEngineTick,
  setSceneLoopOwnsPositiveDt,
  isSceneLoopOwnsPositiveDt,
  setHostOverlayHoldsSceneTime,
  runSceneEngineUpdateNow,
  resetSceneEngineDiagCount,
  resetSceneEngineScheduler,
  runSceneEngineBootTick,
  runSceneEnginePointerTick,
  countWorkerMeshRenderers,
  shouldAttachUiMountSnapshot,
  hostInjectNeedsSceneSystems,
  sceneEngineTickAfterInboundInject,
  sceneEngineTickDue,
  syncSceneEngineHydrationTimer,
  type RendererInboundInjectCounts
} from './sceneEngineScheduler'
import { hasGrowOnlyInjects } from './injectRendererGrowOnlyAppends'
const VIDEO_PLAYER_NULL_MUTABLE = /VideoPlayer for null not found/

const ctx = self

function registerWorkerTjsComponent(eng: IEngine): void {
  try {
    ensureTjsComponent(eng)
  } catch (err) {
    workerLog(
      'warn',
      `[sceneWorker] tjs component register skipped — ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

let requestId = 0
const pendingCrdt = new Map<number, (data: Uint8Array[]) => void>()
const pendingGetState = new Map<number, (state: { hasEntities: boolean; data: Uint8Array[] }) => void>()
const pendingMove = new Map<number, (body: MovePlayerToResponse) => void>()
const pendingTeleportTo = new Map<number, (body: TeleportToResponse) => void>()
const pendingChangeRealm = new Map<number, (body: ChangeRealmResponse) => void>()
const pendingCopyToClipboard = new Map<number, (body: CopyToClipboardResponse) => void>()
const pendingTriggerEmote = new Map<number, (body: TriggerEmoteResponse) => void>()
const pendingTriggerSceneEmote = new Map<number, (body: TriggerSceneEmoteResponse) => void>()
const pendingOpenExternalUrl = new Map<number, (body: OpenExternalUrlResponse) => void>()
const pendingOpenNftDialog = new Map<number, (body: OpenNftDialogResponse) => void>()
const pendingSetCameraTransform = new Map<number, (body: SetCameraTransformResponse) => void>()
const pendingCommsAdapter = new Map<number, (body: { success: boolean }) => void>()
const pendingSendBinary = new Map<number, (body: SendBinaryResponse) => void>()
const pendingUserData = new Map<number, (body: UserDataResponse) => void>()
const pendingRealm = new Map<number, (body: RealmResponse) => void>()
const pendingSubscribeTopic = new Map<number, (body: Record<string, never>) => void>()
const pendingUnsubscribeTopic = new Map<number, (body: Record<string, never>) => void>()
const pendingPublishData = new Map<number, (body: Record<string, never>) => void>()
const pendingConsumeMessages = new Map<number, (body: ConsumeMessagesResponse) => void>()
const pendingActiveVideoStreams = new Map<number, (body: ActiveVideoStreamsResponse) => void>()
const pendingSignedFetch = new Map<number, (body: SignedFetchResponse) => void>()
const pendingSignedFetchGetHeaders = new Map<number, (body: SignedFetchGetHeadersResponse) => void>()
const pendingCommsSend = new Map<number, (body: Record<string, never>) => void>()
const pendingInboundBinaries: Uint8Array[] = []
let lastUserData: NonNullable<UserDataResponse['data']> | null = null
let lastRealmInfo: NonNullable<HostReservedSceneStore['realmInfo']> | null = null
let rendererInboundApply: ((chunks: Uint8Array[]) => void) | null = null
/** Coalesce outbound empty nudges to one post per microtask (still send when uiEntities change). */
let crdtOutboundEmptyNudgeCoalesced = false
let lastOutboundUiEntitiesKey = ''
/** Mount entity key + content fingerprint — drop identical postUiMountSnapshot only. */
let lastUiMountSnapshotFp = ''
let outboundAckId = 0
const pendingOutboundAck = new Map<number, () => void>()
const OUTBOUND_ACK_TIMEOUT_MS = 4000
let engineApiEvents: EngineApiEventState | null = null
let sceneEngine: import('@dcl/ecs').IEngine | null = null
let sceneRunning = false

/** True while scene onUpdate promise is in flight (may be awaiting crdtSendToRenderer). */
let sceneUpdateInFlight = false
/** Stays true until the onUpdate promise settles — prevents overlap after abort preemption. */
let sceneUpdatePromiseActive = false
/** True while pointer inbound apply + engine tick is running — scene loop yields. */
let pointerDeliveryInFlight = false
let pointerDeliveryStartedAt = 0
/** Pointer deliver deferred until scene onUpdate finishes after a crdt interrupt. */
let queuedPointerDeliver: Uint8Array[] | null = null
/** Boot cooperative poll — responsive pointer lane before play-ready. */
const SCENE_LOOP_POLL_MS = 25
/** Play-ready engine tick floor — ~60 Hz (Explorer display-class). Override via ?scenetick=. */
const SCENE_TICK_PLAY_INTERVAL_MS = 16
/** Min ms between lightweight engine ticks during boot. */
const SCENE_TICK_BOOT_INTERVAL_MS = 100
const ENGINE_TICK_PLAY_HIGH_MS = SCENE_TICK_PLAY_INTERVAL_MS
const ENGINE_TICK_PLAY_MEDIUM_MS = 66
const ENGINE_TICK_PLAY_LOW_MS = 100
let engineTickIntervalMs = SCENE_TICK_BOOT_INTERVAL_MS
/** Min ms between full scene onUpdate — fast during hydration, throttled after play-ready. */
let fullSceneOnUpdateIntervalMs = 250
/** After play-ready: keep onUpdate responsive for pointer/triggers; perf throttle is engine-tick + diff consumer. */
const FULL_SCENE_ONUPDATE_INTERVAL_PLAY_MS = 400
const FULL_SCENE_ONUPDATE_INTERVAL_PLAY_LOW_MS = 900
const FULL_SCENE_ONUPDATE_INTERVAL_PLAY_MEDIUM_MS = 650
/** Abort in-flight scene onUpdate after this — pointer inject must not queue behind Genesis-scale sync work. */
const SCENE_UPDATE_ABORT_MS = 2000
const SCENE_UPDATE_ABORT_PLAY_MS = 600
const SCENE_UPDATE_ABORT_PLAY_MEDIUM_MS = 1400
const SCENE_UPDATE_ABORT_PLAY_LOW_MS = 2800
/** Abort pointer engine tick if sceneEngine.update / onUpdate stalls awaiting main-thread CRDT. */
const POINTER_ENGINE_TICK_ABORT_MS = 4000
/** Abort timer — shorter once the scene is interactive. */
let sceneUpdateAbortMs = SCENE_UPDATE_ABORT_MS
let sceneTickIntervalMs = SCENE_LOOP_POLL_MS
let adaptiveLowPerfMode = false
let sceneTicksPaused = false
/** PET_UP deferred until after onUpdate in the pointer interactive tick. */
let pendingSplitPointerInject: InjectPointerClickBody | null = null
/** renderer-inbound-deliver batches held while ticks pause (hydration) — flushed on resume. */
let deferredRendererInbound: Uint8Array[][] = []
/** Hydration — block heavy exports.onUpdate; engine.update still publishes composite GLTFs. */
let sceneOnUpdatePaused = false
/** Min ms between engine ticks while exports.onUpdate is paused (hydration). */
const HYDRATION_ENGINE_TICK_INTERVAL_MS = 100
/** Abort hydration/play engine tick if sceneEngine.update stalls awaiting main-thread CRDT ack. */
const ENGINE_TICK_ABORT_MS = 5000
let sceneUpdateAbortTimer: ReturnType<typeof setTimeout> | null = null
let sceneTickTimer: ReturnType<typeof setInterval> | null = null
let cooperativeTickFn: (() => void) | null = null
/** Set when inject arrives before sceneEngine is bound — drained after bundle eval. */
let pendingInjectPointer: InjectPointerClickBody | null = null
let lastHeartbeatAt = performance.now()
let sceneUpdateStartedAt = 0

/** Scene exports.onUpdate — set when the cooperative loop starts. */
let sceneOnUpdate: ((dt: number) => unknown) | null = null
/** False until exports.onStart resolves — sceneEngine.update during boot can stall Rick Roll worlds. */
let sceneOnStartComplete = false
/** True from boot message until onStart completes — priority inject/deliver is queued. */
let sceneBootInProgress = false
/** True during synchronous evaluateSceneBundle — get-state must not RPC main (deadlock). */
let sceneEvalInProgress = false
/** Boot snapshot from main — satisfies crdtGetState during bundle eval without worker↔main RPC. */
let bootCrdtSnapshot: { hasEntities: boolean; data: Uint8Array[] } | null = null
/** Live interactable px from main — seed UiCanvasInformation without inventing 1920×1080. */
let bootCanvas: { width: number; height: number } | null = null
/** Priority lane messages received while sceneBootInProgress — drained after onStart. */
const pendingBootPriority: SceneWorkerPriorityMessage[] = []
/** True after inject until deliver (or fallback) finalizes the batch. */
let pointerDeliverBatchOpen = false
let pointerDeliverAckFallbackTimer: ReturnType<typeof setTimeout> | null = null
/** Non-UI CRDT deferred during pointer tick phases 1–3 (Ui* stripped). */
const pointerDeferredNonUi: Uint8Array[] = []
/** Structured UI mount from pointer phase 4 — flushed atomically with uiEntities. */
let pointerUiMountSnapshot: import('./workerSceneUiCrdtOutbound').WorkerUiMountSnapshotRow[] | null = null
let pointerUiMountEgressPending = false
/** After scene-play-ready, main rAF posts play-frame-tick (interval only drains queues). */
let playFrameTickMainDriven = false
/**
 * PE / smart wearable worker — intentional InputModifier freezes (drone) must survive
 * GltfContainerLoadingState FINISHED; SpaceRunner load-gate force-clear is primary-only.
 */
let portableExperienceWorker = false
/** Boot `debug` flags from main (`?pointerverbose` / `?tweenverbose`). */
let debugSceneInputSnapshot = false
let debugPointerDeliver = false
let workerSnapshotPressed = new Set<InputActionValue>()

/** Latest hub pressed set. Applied at engine tick start (not on each postMessage). */
let pendingHubPressed: readonly InputActionValue[] | null = null
let pendingHubTickNumber = 0
/** Keys that went down since the last applied tick — still isPressed this tick. */
const downsThisInterval = new Set<InputActionValue>()
/** After a folded tap tick, next tick applies hub without the released key. */
let pendingTapRelease = false
const KEYBOARD_INTERACT_ACTIONS: readonly InputActionValue[] = [
  InputAction.IA_PRIMARY,
  InputAction.IA_SECONDARY
]

function resetPendingSceneInput(): void {
  pendingHubPressed = null
  pendingHubTickNumber = 0
  downsThisInterval.clear()
  pendingTapRelease = false
}
/** Serialize pointer batches — launcher must fully finish before CREATOR starts (no drainInFlight deadlock). */
let pointerDeliverSerial: Promise<void> = Promise.resolve()
let pointerDeliverWorkInFlight = false
let debugSceneUiLog = false
let sceneUiOutboundLogCount = 0
/** Cap GltfContainerLoadingState inject log spam during plaza hydration. */
let gltfLoadingStateInjectLogCount = 0
/**
 * After load-gate force-clear, keep re-posting player-frame clear for a few seconds so main
 * cannot stay frozen if the first post was dropped or overwritten by a stale CRDT PUT.
 * (SpaceRunner: bounce-trap terminals clear first; map1 FINISHED arrives a moment later.)
 */
let mainImClearSyncUntilMs = 0
/** Always log the first N post-boot UI CRDT outbounds (diagnose stuck black scrims). */
const SCENE_UI_OUTBOUND_LOG_LIMIT = 12
let debugTweenDeliver = false
let debugMessageArrival = false
/** `?sceneloop=1` — play-frame source/dt walk-log (throttled). */
let debugSceneLoop = false
let lastSceneLoopPlayFrameLogAt = 0
/**
 * SDK7 entry-points register `main` as an Infinity-priority system so it runs on the first
 * `engine.update` *after* transport `receiveMessages` applies onStart CRDT (main.crdt Names,
 * Transforms, …). Calling main before that tick is what made LobbyWorldPanel throw
 * `Scene entity not found: trigger_room_1` while the Name PUTs were still queued.
 */
function engineHasSdkStartupSystem(eng: {
  getSystems?: () => readonly { priority: number; name?: string }[]
}): boolean {
  const systems = typeof eng.getSystems === 'function' ? eng.getSystems() : []
  for (const system of systems) {
    if (system.priority === Number.POSITIVE_INFINITY) return true
    if (system.name === '_INTERNAL_startup_system') return true
  }
  return false
}

/**
 * SDK entry-points schedule `main()` as Infinity-priority system and do **not** await the
 * promise. Auth-server scenes `await import` then `syncEntity(enumId)`.
 * Host must wait until that settles before releasing LiveKit AUTH_RES (orphan NetworkEntity race).
 *
 * Signal: any `core-schema::Network-Entity` (syncEntity attached), or timeout for non-network scenes.
 *
 * Never short-circuit under ~500ms — even when NetworkEntity component is missing/empty, async
 * main must get time to finish setupClient before ingress is released.
 */
async function waitForSdkMainSettled(eng: {
  getComponentOrNull?: (name: string) => unknown
  getEntitiesWith?: (...components: unknown[]) => Iterable<unknown>
}): Promise<{ networkEntities: number; waitedMs: number; reason: string }> {
  const start = performance.now()
  const timeoutMs = 5_000
  const minWaitMs = 500
  // Let the first await inside main() (dynamic import) resolve.
  await new Promise<void>((r) => setTimeout(r, 0))

  const countNetwork = (): number => {
    const NetworkEntity = eng.getComponentOrNull?.('core-schema::Network-Entity')
    if (!NetworkEntity || typeof eng.getEntitiesWith !== 'function') return 0
    let n = 0
    try {
      for (const _ of eng.getEntitiesWith!(NetworkEntity)) n++
    } catch {
      /* ignore */
    }
    return n
  }

  // setupClient may take a few hundred ms (import + systems); poll until syncEntity attaches.
  while (performance.now() - start < timeoutMs) {
    const n = countNetwork()
    const waited = performance.now() - start
    if (n > 0 && waited >= minWaitMs) {
      // Second syncEntity (leaderboard etc.) often follows in the same async function.
      await new Promise<void>((r) => setTimeout(r, 50))
      const n2 = countNetwork()
      return {
        networkEntities: n2,
        waitedMs: Math.round(performance.now() - start),
        reason: 'syncEntity-network'
      }
    }
    await new Promise<void>((r) => setTimeout(r, 40))
  }
  return {
    networkEntities: countNetwork(),
    waitedMs: Math.round(performance.now() - start),
    reason: countNetwork() > 0 ? 'syncEntity-network-late' : 'timeout'
  }
}

async function invokeSceneMainBootstrap(
  exports: import('../system/createSystemStubs').SceneBundleExports,
  options?: { skipMain?: boolean }
): Promise<void> {
  if (!sceneEngine) return
  const initScripts = exports._initializeScripts ?? exports.initializeScripts
  // SDK Infinity startup system already calls _initializeScripts before main — skip when
  // boot tick owned bootstrap to avoid double script/UI registration.
  if (!options?.skipMain && typeof initScripts === 'function') {
    try {
      await Promise.resolve(initScripts(sceneEngine))
      workerLog('log', '[sceneWorker] initializeScripts complete')
    } catch (err) {
      workerLog(
        'warn',
        `[sceneWorker] initializeScripts failed — ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  if (options?.skipMain) {
    // Boot tick already started main() fire-and-forget — wait for syncEntity / settle.
    const settled = await waitForSdkMainSettled(
      sceneEngine as {
        getComponentOrNull?: (name: string) => unknown
        getEntitiesWith?: (...components: unknown[]) => Iterable<unknown>
      }
    )
    workerLog(
      'log',
      `[sceneWorker] scene main() owned by SDK startup — settled reason=${settled.reason} ` +
        `networkEntities=${settled.networkEntities} waited=${settled.waitedMs}ms ` +
        `UiTransform=${collectWorkerUiEntityIds().length}`
    )
    return
  }
  if (typeof exports.main !== 'function') return
  try {
    // Deploy bundles export `main:()=>$A` — the thunk returns the bootstrap fn; invoke it.
    const mainResult = await Promise.resolve(exports.main())
    if (typeof mainResult === 'function') {
      await Promise.resolve(mainResult())
    }
    workerLog(
      'log',
      `[sceneWorker] scene main() complete — UiTransform=${collectWorkerUiEntityIds().length}`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/already added to the engine/i.test(msg)) {
      workerLog('log', '[sceneWorker] scene main() skipped — UI bootstrap already applied')
      return
    }
    workerLog('error', `[sceneWorker] scene main() failed — ${msg}`)
  }
}

function clearSceneUpdateAbortTimer(): void {
  if (sceneUpdateAbortTimer) {
    clearTimeout(sceneUpdateAbortTimer)
    sceneUpdateAbortTimer = null
  }
}

function setCooperativeLoopInterval(intervalMs: number): void {
  sceneTickIntervalMs = intervalMs
  if (sceneTickTimer) clearInterval(sceneTickTimer)
  if (cooperativeTickFn) {
    sceneTickTimer = setInterval(cooperativeTickFn, intervalMs)
  }
}

function applyPlayReadyTiming(
  tier: PerformanceTier | undefined,
  reason: string,
  options?: { engineTickOverrideMs?: number }
): void {
  const low = tier === 'low' || adaptiveLowPerfMode
  const medium = !low && tier === 'medium'
  fullSceneOnUpdateIntervalMs = low
    ? FULL_SCENE_ONUPDATE_INTERVAL_PLAY_LOW_MS
    : medium
      ? FULL_SCENE_ONUPDATE_INTERVAL_PLAY_MEDIUM_MS
      : FULL_SCENE_ONUPDATE_INTERVAL_PLAY_MS
  sceneUpdateAbortMs = low
    ? SCENE_UPDATE_ABORT_PLAY_LOW_MS
    : medium
      ? SCENE_UPDATE_ABORT_PLAY_MEDIUM_MS
      : SCENE_UPDATE_ABORT_PLAY_MS
  if (
    options?.engineTickOverrideMs !== undefined &&
    options.engineTickOverrideMs >= 16 &&
    options.engineTickOverrideMs <= 100
  ) {
    engineTickIntervalMs = options.engineTickOverrideMs
  } else {
    engineTickIntervalMs = low
      ? ENGINE_TICK_PLAY_LOW_MS
      : medium
        ? ENGINE_TICK_PLAY_MEDIUM_MS
        : ENGINE_TICK_PLAY_HIGH_MS
  }
  workerLog(
    'log',
    `[sceneWorker] play-ready timing (${reason}) — tier=${tier ?? 'default'} adaptiveLow=${adaptiveLowPerfMode} ` +
      `engineTick ${engineTickIntervalMs}ms, onUpdate interval ${fullSceneOnUpdateIntervalMs}ms, abort ${sceneUpdateAbortMs}ms`
  )
  setCooperativeLoopInterval(engineTickIntervalMs)
}



/** Only call from main `pause-scene-ticks:false` — never from cooperative onUpdate / inbound paths. */
function resumeSceneTicksAfterPointer(): void {
  if (pointerDeliveryInFlight || sceneUpdateInFlight || queuedPointerDeliver || pendingInjectPointer) return
  sceneTicksPaused = false
  // Sticky promote used to unpause ticks while onUpdate was still paused → first
  // engine.update dumped the whole plaza CRDT and awaited ack (~2s FPS stall).
  if (sceneOnUpdatePaused) return
  // Pointer edge may request the next due tick immediately. Do not stack a second update.
  requestSceneEngineTick({ source: 'pointer-edge' })
}

function clearPointerEgressBuffers(): void {
  pointerDeferredNonUi.length = 0
  pointerUiMountSnapshot = null
  pointerUiMountEgressPending = false
}

function endPointerInputSessionAfterMountResume(): void {
  const snapshot = leavePointerInputSession()
  if (snapshot) applyCoalescedKeyboardSnapshot(snapshot)
  workerVerboseLog(debugPointerDeliver, 'log', '[sceneWorker] pointer input session ended (mount commit)')
}

function postPointerDeliverDone(label: string): void {
  ctx.postMessage({ type: 'pointer-deliver-done' } satisfies SceneWorkerOutbound)
  workerVerboseLog(debugPointerDeliver, 'log', `[sceneWorker] ${label} — pointer-deliver-done posted to main`)
}

/**
 * Unblock scene ticks stuck awaiting crdtSendToRenderer so pointer delivery is not queued
 * behind an in-flight main↔worker round-trip (mirror.flushOutgoing can stall main for 500ms+).
 */
function interruptPendingCrdtRoundTrips(): void {
  if (!pendingCrdt.size) return
  const ids = [...pendingCrdt.keys()]
  for (const id of ids) {
    pendingCrdt.get(id)?.([])
    pendingCrdt.delete(id)
  }
  workerLog(
    'log',
    `[sceneWorker] interrupted ${ids.length} pending crdt round-trip(s) for pointer priority`
  )
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

/** Bevy: never abort a live engine.update for pointer (skip-if-in-flight). */
function canPreemptSceneEngineTick(): boolean {
  return (
    !isSceneLoopOwnsPositiveDt() &&
    !isEngineUpdateInFlight() &&
    !isSceneEngineTickInFlight()
  )
}

function preemptForPointerDelivery(): void {
  if (!isPointerInputSessionActive()) enterPointerInputSession()
  // Prior batch may be stuck in flushPointerDeferredOutboundsAsync awaiting main acks — unblock so
  // the serial chain can finish before the next inject runs (CREATOR after launcher freeze).
  interruptPendingOutboundAcks()
  const hadSceneUpdate = sceneUpdateInFlight
  sceneUpdateInFlight = false
  if (canPreemptSceneEngineTick()) preemptSceneEngineTick()
  forceReleaseEngineUpdateMutex('pointer-deliver-preempt')
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

function shouldDeferPointerOutbound(): boolean {
  return pointerDeliverBatchOpen || pointerDeliveryInFlight || isPointerInputSessionActive()
}

/**
 * Post non-UI chunks first, then structured UI mount.
 * UI mount posts are fire-and-forget (empty data) — awaiting main ack on 300–400 row
 * snapshots deadlocked deliver-done (main 2s watchdog vs worker 4s OUTBOUND_ACK while
 * Yoga paint ran). Non-UI gameplay chunks still await ack with timeout.
 */
async function flushPointerDeferredOutboundsAsync(): Promise<void> {
  let nonUiChunks = coalesceCrdtChunksLww(pointerDeferredNonUi.splice(0))
  const eng = sceneEngine
  if (eng) {
    if (sceneOnUpdatePaused) {
      nonUiChunks = nonUiChunks
        .map((chunk) => reconcileWorkerAuthoritativeCrdtEgress(eng, chunk))
        .filter((chunk) => chunk.byteLength > 0)
      const liveAuthoritative = reconcileWorkerAuthoritativeCrdtEgress(eng, new Uint8Array(0))
      if (liveAuthoritative.byteLength > 0) {
        nonUiChunks = coalesceCrdtChunksLww([...nonUiChunks, liveAuthoritative])
      }
    } else {
      nonUiChunks = nonUiChunks
        .map((chunk) => stripPlayerFrameComponentsFromCrdt(chunk))
        .filter((chunk) => chunk.byteLength > 0)
      // Phase 4 — VC hydrate then player-frame in the same pointer batch.
      publishVcBindHydrateIfNeeded()
      publishPlayerFrameIfChanged()
    }
  }
  const uiSnapshot = pointerUiMountSnapshot
  const uiMountPending = pointerUiMountEgressPending
  pointerUiMountSnapshot = null
  pointerUiMountEgressPending = false
  const snapshotMountIds =
    uiSnapshot?.length ? extractSnapshotMountEntityIds(uiSnapshot) : []
  const uiEntities = eng
    ? collectWorkerUiMountEntityIds(eng)
    : snapshotMountIds.length
      ? snapshotMountIds
      : collectWorkerUiEntityIds()
  const ackWaits: Promise<void>[] = []

  const postOutbound = (
    data: Uint8Array,
    attachUi?: { uiEntities: number[]; uiMountSnapshot?: typeof uiSnapshot },
    opts?: { awaitAck?: boolean }
  ): void => {
    const awaitAck = opts?.awaitAck !== false
    const id = ++outboundAckId
    if (awaitAck) {
      ackWaits.push(
        new Promise<void>((resolve) => {
          let settled = false
          const finish = (): void => {
            if (settled) return
            settled = true
            pendingOutboundAck.delete(id)
            resolve()
          }
          pendingOutboundAck.set(id, finish)
          // Short timeout — pointer deliver-done must not wait on main paint.
          setTimeout(finish, Math.min(OUTBOUND_ACK_TIMEOUT_MS, 250))
        })
      )
    }
    const msg = attachUi
      ? ({
          type: 'crdt-outbound',
          id,
          data,
          uiEntities: attachUi.uiEntities,
          uiMountSnapshot: attachUi.uiMountSnapshot ?? []
        } satisfies SceneWorkerOutbound)
      : ({ type: 'crdt-outbound', id, data } satisfies SceneWorkerOutbound)
    logSceneUiOutbound(data, attachUi?.uiEntities, attachUi?.uiMountSnapshot?.length ?? 0)
    if (data.byteLength) ctx.postMessage(msg, [data.buffer])
    else ctx.postMessage(msg)
  }

  if (nonUiChunks.length) {
    const bytes = nonUiChunks.reduce((n, c) => n + c.byteLength, 0)
    workerLog(
      'warn',
      `[sceneWorker] pointer deferred CRDT flush n=${nonUiChunks.length} bytes=${bytes}`
    )
  }
  for (const chunk of nonUiChunks) {
    postOutbound(chunk, undefined, { awaitAck: true })
  }

  if (uiMountPending) {
    // Prefer full mount id list from worker engine (not only entities present in this snap)
    // so main commitMountSet matches phase-4 authority even if a row is briefly missing.
    const mountIds = sceneEngine ? collectWorkerUiMountEntityIds(sceneEngine) : uiEntities
    lastOutboundUiEntitiesKey = mountIds.join(',')
    // Content fp so cooperative postUiMountSnapshot does not drop as "identical" forever.
    const snapFp = uiMountSnapshotContentFp(uiSnapshot ?? [])
    const displayFp = uiMountSnapshotDisplayFp(uiSnapshot ?? [])
    lastUiMountSnapshotFp = `${lastOutboundUiEntitiesKey}@@d${displayFp}@@${snapFp}`
    // Never await UI mount ack — main paint of large HUDs must not stall pointer lifecycle.
    postOutbound(
      new Uint8Array(0),
      {
        uiEntities: mountIds,
        uiMountSnapshot: uiSnapshot ?? []
      },
      { awaitAck: false }
    )
    workerLog(
      'log',
      `[sceneWorker] pointer ui egress — snapshotRows=${uiSnapshot?.length ?? 0} mount=${mountIds.length} nonUiChunks=${nonUiChunks.length} (no-await-ui)`
    )
  }

  if (ackWaits.length) await Promise.all(ackWaits)
}

function forceRecoverStuckPointerDelivery(reason: string): void {
  if (
    !pointerDeliveryInFlight &&
    !pointerDeliverBatchOpen &&
    !sceneTicksPaused &&
    !pointerDeliverWorkInFlight
  ) {
    return
  }
  workerLog(
    'error',
    `[sceneWorker] pointer delivery recovery — ${reason} ` +
      `(inFlight=${pointerDeliveryInFlight} batchOpen=${pointerDeliverBatchOpen} ` +
      `deliverWork=${pointerDeliverWorkInFlight} ticksPaused=${sceneTicksPaused})`
  )
  clearPointerDeliverAckFallback()
  pointerDeliverBatchOpen = false
  pointerDeliveryInFlight = false
  setPointerDeliveryInFlight(false)
  pointerDeliveryStartedAt = 0
  pointerDeliverWorkInFlight = false
  pointerDeliverSerial = Promise.resolve()
  pendingSplitPointerInject = null
  sceneTicksPaused = false
  forceReleaseEngineUpdateMutex(reason)
  interruptPendingOutboundAcks()
  interruptPendingCrdtRoundTrips()
  void flushPointerDeferredOutboundsAsync().then(() => postPointerDeliverDone(reason))
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
  const splitInject = pendingSplitPointerInject
  pendingSplitPointerInject = null
  await runSceneEnginePointerTick(sceneEngine, async () => {
    if (!sceneOnUpdate) return
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
  }, splitInject)
  workerVerboseLog(debugPointerDeliver, 'log', `[sceneWorker] ${label} — pointer scheduler tick done`)
}

/**
 * Same-tick engine tick after inject + CRDT apply — getClick() must run before main resumes ticks.
 * Do not defer via setTimeout; worker priority handlers were starving the timer queue.
 */
async function runPointerEngineTickSync(
  label: string,
  options?: { holdSceneTicksUntilBatchDrain?: boolean }
): Promise<void> {
  pointerDeliveryInFlight = true
  setPointerDeliveryInFlight(true)
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
    setPointerDeliveryInFlight(false)
    pointerDeliveryStartedAt = 0
    if (!options?.holdSceneTicksUntilBatchDrain) {
      resumeSceneTicksAfterPointer()
      drainQueuedPointerDeliver()
    }
  }
}

/** One batch → tick → egress → deliver-done; chained so CREATOR never races launcher flush/ack. */
function schedulePointerDeliverWork(label: string): void {
  pointerDeliverSerial = pointerDeliverSerial
    .then(async () => {
      pointerDeliverWorkInFlight = true
      workerLog('log', `[sceneWorker] pointer deliver — ${label}`)
      interruptPendingCrdtRoundTrips()
      interruptPendingOutboundAcks()
      if (canPreemptSceneEngineTick()) preemptSceneEngineTick()
      forceReleaseEngineUpdateMutex('pointer-deliver')
      await awaitEngineUpdateIdle(800)
      await runPointerEngineTickSync(label, { holdSceneTicksUntilBatchDrain: true })
      await flushPointerDeferredOutboundsAsync()
      postPointerDeliverDone(label)
    })
    .catch(async (err) => {
      workerLog(
        'error',
        `[sceneWorker] pointer deliver failed (${label}) — ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      try {
        await flushPointerDeferredOutboundsAsync()
      } catch {
        /* best-effort egress before ack */
      }
      postPointerDeliverDone(`${label}-error`)
    })
    .finally(() => {
      pointerDeliverWorkInFlight = false
    })
}

/** Run engine tick + onUpdate flush, then ack main — Tween CRDT must finish before deliver-done. */
function finalizePointerDelivery(label: string): void {
  if (!pointerDeliverBatchOpen) {
    workerLog('error', `[sceneWorker] ${label} — finalize called without open pointer batch`)
    return
  }
  pointerDeliverBatchOpen = false
  clearPointerDeliverAckFallback()
  schedulePointerDeliverWork(label)
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

/** Open a deliver batch (pointer-crdt-deliver path only — edge inject uses executePointerEdge). */
function beginPointerDeliverBatch(label: string): void {
  if (!isPointerInputSessionActive()) enterPointerInputSession()
  resetWorkerSceneUiCrdtLamport()
  resetPlayerFrameEgressBaseline()
  resetVcBindHydrateBaseline()
  clearPointerEgressBuffers()
  pointerDeliverBatchOpen = true
  armPointerDeliverAckFallback(label)
}

/** Forward to main debug log without relying on patched console (scene onStart may restore native console). */
function workerLog(level: 'log' | 'info' | 'warn' | 'error' | 'debug', message: string): void {
  ctx.postMessage({ type: 'log', message: `[${level}] ${message}` } satisfies SceneWorkerOutbound)
}

/** Bound-VC follow rig — pose keys for VC + lookAt/parent entities. */
const boundVcPoseKeys = new Map<number, string>()
const editFlightVcPoseKeys = new Map<number, string>()

function applySceneInputSnapshotNow(body: SceneInputSnapshotBody): boolean {
  if (!sceneEngine) return false
  if (sceneInputSnapshotPressedEqual(workerSnapshotPressed, body.pressed)) return false
  try {
    workerSnapshotPressed = applySceneInputSnapshotOnEngine(
      sceneEngine,
      sceneEngine.PlayerEntity as number,
      body,
      workerSnapshotPressed
    )
    if (portableExperienceWorker || debugSceneInputSnapshot || body.pressed.length > 0) {
      workerLog(
        'log',
        `[sceneWorker] scene-input-snapshot pe=${portableExperienceWorker ? 1 : 0} ` +
          `tick=${body.tickNumber} pressed=[${body.pressed.join(', ')}]`
      )
    }
    return true
  } catch (err) {
    workerLog(
      'error',
      `[sceneWorker] scene-input-snapshot failed — ${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}

function applyPendingSceneInputAtTick(): void {
  if (!sceneEngine) return
  if (!pendingHubPressed && downsThisInterval.size === 0 && !pendingTapRelease) return
  const hub = pendingHubPressed ?? [...workerSnapshotPressed]
  const thisTick = new Set(hub)
  let folded = false
  for (const action of downsThisInterval) {
    if (!thisTick.has(action)) {
      thisTick.add(action)
      folded = true
    }
  }
  applySceneInputSnapshotNow({
    tickNumber: pendingHubTickNumber,
    pressed: [...thisTick]
  })
  const sawInteract = KEYBOARD_INTERACT_ACTIONS.some((action) => downsThisInterval.has(action))
  downsThisInterval.clear()
  if (folded) {
    pendingHubPressed = hub
    pendingTapRelease = true
  } else {
    pendingHubPressed = null
    pendingTapRelease = false
  }
  if (sawInteract) armCooperativeReactEcsPaintFollowup(180)
}

function applyCoalescedKeyboardSnapshot(body: SceneInputSnapshotBody): void {
  executeSceneInputSnapshot(body)
}

function executeSceneInputSnapshot(body: SceneInputSnapshotBody): void {
  if (!sceneEngine) return
  if (coalesceKeyboardSnapshotDuringPointerSession(body)) {
    // Keep latest for leavePointerInputSession; still sample at tick start.
  }
  for (const action of body.pressed) {
    if (!workerSnapshotPressed.has(action)) downsThisInterval.add(action)
  }
  pendingHubPressed = body.pressed
  pendingHubTickNumber = body.tickNumber
  queueSceneEngineTick()
}

function postPlayModeColdCrdtFireAndForget(data: Uint8Array): void {
  logSceneUiOutbound(data)
  ctx.postMessage({ type: 'crdt-outbound', data } satisfies SceneWorkerOutbound, [data.buffer])
}

/** Inbound guest LWW (Material etc.) must present now — Explorer has no cold CRDT buffer. */
function postInboundGuestLwwToHost(data: Uint8Array): void {
  if (!data.byteLength) return
  postPlayModeColdCrdtFireAndForget(data)
}

function bindInboundGuestLwwHostForward(engine: object): void {
  installInboundGuestLwwHostForward(engine, postInboundGuestLwwToHost, workerLog)
}

/** VC hydrate + player-frame after pollEvents (play mode). Scene CRDT already posted this tick. */
function completePlayFrameColdEgress(): void {
  if (sceneOnUpdatePaused) return
  // Graph-hash hydrate (independent of player-frame change) then IM/MainCamera hot path.
  publishVcBindHydrateIfNeeded()
  publishPlayerFrameIfChanged()
}

/** Structural VC bind hydrate — post before player-frame when graph changes (or main pulls). */
function publishVcBindHydrateIfNeeded(): void {
  if (!sceneEngine || !sceneOnStartComplete || sceneOnUpdatePaused) return
  const packet = takeVcBindHydrateIfNeeded(sceneEngine)
  if (!packet) return
  ctx.postMessage({
    type: 'vc-bind-hydrate',
    bind: packet.bind,
    graphKey: packet.graphKey
  } satisfies SceneWorkerOutbound)
}

function publishPlayerFrameIfChanged(): void {
  // Not gated on sceneOnStartComplete: load freezes during onStart and clears after systems
  // process host LWW must both reach main (InputModifier hot path).
  if (!sceneEngine || sceneOnUpdatePaused) return
  const snapshot = collectPlayerFrameSnapshot(sceneEngine)
  if (!snapshot) return
  ctx.postMessage({
    type: 'player-frame',
    frameId: snapshot.frameId,
    inputModifierHas: snapshot.inputModifierHas,
    ...(snapshot.inputModifier !== undefined ? { inputModifier: snapshot.inputModifier } : {}),
    mainCamera: snapshot.mainCamera
  } satisfies SceneWorkerOutbound)
}

/** Always post InputModifier clear to main — ignores sceneOnUpdatePaused + snapshot dedupe. */
function publishForcedPlayerFrameClear(reason: string): void {
  if (!sceneEngine) return
  const snapshot = takeForcedPlayerFrameClearSnapshot(sceneEngine)
  // Invalidate CRDT IM egress baseline so next cold CRDT emits DELETE not stale freeze PUT.
  resetInputModifierEgressBaseline()
  // Immediate CRDT DELETE so projection cannot re-apply a buffered freeze PUT after player-frame.
  try {
    const del = reconcileInputModifierCrdtEgress(sceneEngine, new Uint8Array(0))
    if (del.byteLength) {
      postPlayModeColdCrdtFireAndForget(del)
    }
  } catch {
    /* best-effort */
  }
  ctx.postMessage({
    type: 'player-frame',
    frameId: snapshot.frameId,
    inputModifierHas: false,
    mainCamera: snapshot.mainCamera
  } satisfies SceneWorkerOutbound)
  workerLog(
    'log',
    `[sceneWorker] player-frame FORCE clear posted frameId=${snapshot.frameId} — ${reason}`
  )
}

function vcTransformPoseKey(tr: {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
}): string {
  return [
    tr.position.x.toFixed(4),
    tr.position.y.toFixed(4),
    tr.position.z.toFixed(4),
    tr.rotation.x.toFixed(5),
    tr.rotation.y.toFixed(5),
    tr.rotation.z.toFixed(5),
    tr.rotation.w.toFixed(5)
  ].join(',')
}

function postVcPoseLive(entity: Entity, tr: {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
  parent?: number
}): void {
  ctx.postMessage({
    type: 'vc-pose-live',
    entity: entity as number,
    transform: {
      position: { x: tr.position.x, y: tr.position.y, z: tr.position.z },
      rotation: { x: tr.rotation.x, y: tr.rotation.y, z: tr.rotation.z, w: tr.rotation.w },
      scale: { x: tr.scale.x, y: tr.scale.y, z: tr.scale.z },
      parent: tr.parent as number | undefined
    }
  } satisfies SceneWorkerOutbound)
}

/**
 * Scenes often gate PE parenting on Transform.has(PlayerEntity). Seed a shell so
 * mid-session equip (weapons, attach props) gets parent=PE instead of a world-space orphan.
 */
function seedReservedTransform(
  engine: import('@dcl/ecs').IEngine,
  entity: Entity,
  position: { x: number; y: number; z: number }
): void {
  const Transform = extended.Transform(engine)
  if (Transform.has(entity)) return
  const value = {
    position,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    parent: engine.RootEntity
  }
  writeHostLwwNoDirty(Transform, entity as number, value)
  if (!Transform.has(entity)) {
    Transform.createOrReplace(entity, value)
  }
}

function ensurePlayerEntityTransform(engine: import('@dcl/ecs').IEngine): void {
  seedReservedTransform(engine, engine.PlayerEntity as Entity, { x: 0, y: 0, z: 0 })
}

function ensureCameraEntityTransform(engine: import('@dcl/ecs').IEngine): void {
  seedReservedTransform(engine, engine.CameraEntity as Entity, { x: 0, y: 1.6, z: 0 })
}

/** Player=1 / Camera=2 must exist before plaza `Ztt` → fishing `init` (Transform.get). */
function ensureReservedEntityTransforms(engine: import('@dcl/ecs').IEngine): void {
  ensurePlayerEntityTransform(engine)
  ensureCameraEntityTransform(engine)
}

/** Worker PPI apply logs — off unless `?ppidiag` (spam was a major FPS tax). */
let lastWorkerPpiLogAt = 0
const WORKER_PPI_LOG_MS = 1000
let lastWorkerPpiMissingLogAt = 0
const workerPpiDiagEnabled = (() => {
  try {
    // Worker has no location; main posts debug flags on boot — default off.
    return false
  } catch {
    return false
  }
})()

function cacheHostReserved(reserved?: HostReservedSceneStore): void {
  const identity = reserved?.playerIdentity
  if (identity?.userId) {
    lastUserData = {
      userId: identity.userId,
      displayName: identity.displayName ?? lastUserData?.displayName ?? '',
      hasConnectedWeb3: identity.hasConnectedWeb3 === true,
      version: lastUserData?.version ?? 0,
      ...(lastUserData?.publicKey ? { publicKey: lastUserData.publicKey } : {}),
      ...(lastUserData?.avatar ? { avatar: lastUserData.avatar } : {})
    }
  }
  const realm = reserved?.realmInfo
  if (realm) {
    lastRealmInfo = {
      baseUrl: realm.baseUrl || '',
      realmName: realm.realmName || '',
      networkId: Number.isFinite(realm.networkId) ? realm.networkId : 1,
      commsAdapter: realm.commsAdapter || '',
      isPreview: realm.isPreview === true,
      room: realm.room,
      isConnectedSceneRoom: realm.isConnectedSceneRoom === true
    }
  }
}

/**
 * Explorer: PlayerIdentityData + RealmInfo live on the scene store before sendBinary.
 * `@dcl/sdk/network` isRoomReady is set only when AUTH_RES is processed *and*
 * RootEntity already has RealmInfo. joinRoster / paint team read PlayerEntity.address.
 *
 * Identity: write when address is known (skip unchanged).
 * RealmInfo: seed only when missing — later host CRDT injects remain authority.
 */
function applyHostReservedSceneStore(): void {
  if (!sceneEngine) return
  preregisterRendererInjectedComponents(sceneEngine)
  let wroteIdentity = false
  let wroteRealm = false
  if (lastUserData?.userId) {
    const PlayerIdentityData = generated.PlayerIdentityData(sceneEngine)
    const existing = PlayerIdentityData.getOrNull(sceneEngine.PlayerEntity) as
      | { address?: string; isGuest?: boolean }
      | null
    const isGuest = lastUserData.hasConnectedWeb3 !== true
    if (!existing?.address || existing.address !== lastUserData.userId || existing.isGuest !== isGuest) {
      writeHostLwwNoDirty(PlayerIdentityData, sceneEngine.PlayerEntity as number, {
        address: lastUserData.userId,
        isGuest
      })
      wroteIdentity = true
    }
  }
  const RealmInfo = generated.RealmInfo(sceneEngine)
  if (!RealmInfo.getOrNull(sceneEngine.RootEntity)) {
    const info = lastRealmInfo
    writeHostLwwNoDirty(RealmInfo, sceneEngine.RootEntity as number, {
      baseUrl: info?.baseUrl ?? '',
      realmName: info?.realmName ?? '',
      networkId: info?.networkId ?? 1,
      commsAdapter: info?.commsAdapter ?? '',
      isPreview: info?.isPreview === true,
      room: info?.room,
      isConnectedSceneRoom: info ? info.isConnectedSceneRoom === true : true
    })
    wroteRealm = true
  }
  if (wroteIdentity || wroteRealm) {
    const pid = lastUserData?.userId
      ? `${lastUserData.userId.slice(0, 12)}… guest=${lastUserData.hasConnectedWeb3 !== true}`
      : 'none'
    const realm = RealmInfo.getOrNull(sceneEngine.RootEntity) as
      | { isConnectedSceneRoom?: boolean; realmName?: string }
      | null
    workerLog(
      'warn',
      `[sceneWorker] host reserved store — identity=${pid} realm=${realm?.realmName || 'seed'} ` +
        `connected=${realm?.isConnectedSceneRoom === true} wroteId=${wroteIdentity} wroteRealm=${wroteRealm}`
    )
  }
}

/** Host PointerLock on CameraEntity — skip identical so onChange does not pulse. */
function applyPointerLockOnEngine(locked: boolean): void {
  if (!sceneEngine) return
  preregisterRendererInjectedComponents(sceneEngine)
  const PointerLock = generated.PointerLock(sceneEngine)
  const cur = PointerLock.getOrNull(sceneEngine.CameraEntity) as
    | { isPointerLocked?: boolean }
    | null
  if (cur?.isPointerLocked === locked) return
  writeHostLwwNoDirty(PointerLock, sceneEngine.CameraEntity as number, {
    isPointerLocked: locked
  })
  workerLog('log', `[sceneWorker] PointerLock isPointerLocked=${locked ? 1 : 0}`)
}

/** Same-tick PlayerEntity / CameraEntity for scene systems (CameraFollowSystem, etc.). */
function applyPlayFrameReservedPoses(
  player?: {
    position: { x: number; y: number; z: number }
    rotation: { x: number; y: number; z: number; w: number }
  },
  camera?: {
    position: { x: number; y: number; z: number }
    rotation: { x: number; y: number; z: number; w: number }
  },
  primaryPointer?: {
    pointerType: number
    screenCoordinates: { x: number; y: number }
    screenDelta: { x: number; y: number }
    worldRayDirection: { x: number; y: number; z: number }
  },
  avatarAttach?: import('../types').AvatarAttachTransformEntry[],
  tweenTransforms?: import('../types').AvatarAttachTransformEntry[],
  pointerLock?: boolean
): void {
  if (!sceneEngine) return
  const Transform = extended.Transform(sceneEngine)
  const write = (
    entity: Entity,
    pose: {
      position: { x: number; y: number; z: number }
      rotation: { x: number; y: number; z: number; w: number }
    }
  ): void => {
    const prev = Transform.has(entity) ? Transform.get(entity) : undefined
    writeHostLwwNoDirty(Transform, entity as number, {
      position: pose.position,
      rotation: pose.rotation,
      scale: prev?.scale ?? { x: 1, y: 1, z: 1 },
      parent: sceneEngine!.RootEntity
    })
  }
  // Always host PE/Camera Transform before scene systems parent weapons to PlayerEntity.
  ensureReservedEntityTransforms(sceneEngine)
  if (player) write(sceneEngine.PlayerEntity as Entity, player)
  if (camera) write(sceneEngine.CameraEntity as Entity, camera)
  if (pointerLock !== undefined) applyPointerLockOnEngine(pointerLock)
  applyHostReservedSceneStore()
  // Renderer Tweens write Transform on the store the VM reads (new-catch scale, reveal cam).
  if (tweenTransforms?.length) {
    applyHostTransformsOnEngine(sceneEngine, tweenTransforms)
  }
  // AvatarAttach after PE + tweens — Hle/nBe is player × relative (fishing line tip).
  if (avatarAttach?.length) {
    applyAvatarAttachTransformsOnEngine(sceneEngine, avatarAttach)
  }
  // Live cursor ray before systems — fishing bobber aim reads PrimaryPointerInfo each tick.
  if (primaryPointer) {
    preregisterRendererInjectedComponents(sceneEngine)
    const PrimaryPointerInfo = generated.PrimaryPointerInfo(sceneEngine)
    writeHostLwwNoDirty(PrimaryPointerInfo, sceneEngine.RootEntity as number, {
      pointerType: primaryPointer.pointerType,
      screenCoordinates: primaryPointer.screenCoordinates,
      screenDelta: primaryPointer.screenDelta,
      worldRayDirection: primaryPointer.worldRayDirection
    })
    // Intentional silence — enable only if we re-wire ppidiag to the worker boot flags.
    if (workerPpiDiagEnabled) {
      const now = performance.now()
      if (now - lastWorkerPpiLogAt >= WORKER_PPI_LOG_MS) {
        lastWorkerPpiLogAt = now
        const d = primaryPointer.worldRayDirection
        const s = primaryPointer.screenCoordinates
        workerLog(
          'log',
          `[sceneWorker] PPI apply screen=(${s.x.toFixed(0)},${s.y.toFixed(0)}) ` +
            `ray=(${d.x.toFixed(3)},${d.y.toFixed(3)},${d.z.toFixed(3)})`
        )
      }
    }
  } else if (workerPpiDiagEnabled) {
    const now = performance.now()
    if (now - lastWorkerPpiMissingLogAt >= 2000) {
      lastWorkerPpiMissingLogAt = now
      workerLog('warn', '[sceneWorker] PPI missing on play-frame-tick — bobber aim may stall')
    }
  }
}

/**
 * When pointer UI holds engine ticks, CameraFollow cannot move cameraParent.
 * If the bound VC already looks like an active PE-follow rig (parent===lookAt and anchor near PE),
 * snap the anchor to live PE so the main lens does not freeze. Do NOT snap distant select/cinematic
 * stages (parent far from PE) — those keep authored hierarchy.
 */
/** Keep cameraParent = PE when UI holds engine ticks (CameraFollow may not run). */
function snapBoundPeFollowAnchorIfNearPlayer(): void {
  if (!sceneEngine || !sceneOnStartComplete) return
  if (!isBoundVcPeFollowRig(sceneEngine)) return
  const eng = sceneEngine
  const MainCamera = generated.MainCamera(eng)
  const VirtualCamera = generated.VirtualCamera(eng)
  const Transform = extended.Transform(eng)
  const main = MainCamera.getOrNull(eng.CameraEntity) as { virtualCameraEntity?: number } | null
  const vc = main?.virtualCameraEntity
  if (vc === undefined || vc === null) return

  const vcEntity = vc as Entity
  const spec = VirtualCamera.getOrNull(vcEntity) as { lookAtEntity?: number } | null
  const parent = Transform.getOrNull(vcEntity)?.parent as number | undefined
  const lookAt = spec?.lookAtEntity
  if (parent === undefined || parent === null || parent !== lookAt) return

  const pe = Transform.getOrNull(eng.PlayerEntity as Entity)
  const anchor = Transform.getOrNull(parent as Entity)
  if (!pe || !anchor) return

  const next = {
    position: { x: pe.position.x, y: pe.position.y, z: pe.position.z },
    rotation: anchor.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
    scale: anchor.scale ?? { x: 1, y: 1, z: 1 },
    parent: (anchor.parent as Entity | undefined) ?? eng.RootEntity
  }
  const eps = 1e-4
  if (
    Math.abs(anchor.position.x - next.position.x) <= eps &&
    Math.abs(anchor.position.y - next.position.y) <= eps &&
    Math.abs(anchor.position.z - next.position.z) <= eps
  ) {
    return
  }
  writeHostLwwNoDirty(Transform, parent as number, next)
}

/**
 * Bound MainCamera→VC — pipe scene Transform rows after systems (CameraFollow, etc.).
 * Keep parent/local hierarchy (do not flatten to world) so main PE-follow can read the
 * scene-authored local offset under cameraParent.
 */
function publishVcPoseLiveIfBound(): void {
  if (!sceneEngine || !sceneOnStartComplete) return
  const eng = sceneEngine
  const MainCamera = generated.MainCamera(eng)
  const VirtualCamera = generated.VirtualCamera(eng)
  const Transform = extended.Transform(eng)
  const main = MainCamera.getOrNull(eng.CameraEntity) as { virtualCameraEntity?: number } | null
  const vc = main?.virtualCameraEntity
  if (vc === undefined || vc === null) {
    boundVcPoseKeys.clear()
    return
  }

  const liveIds = new Set<number>()
  const GltfContainer = generated.GltfContainer(eng)
  const MeshRenderer = extended.MeshRenderer(eng)
  const isMeshBearing = (entity: Entity): boolean =>
    GltfContainer.has(entity) || MeshRenderer.has(entity)

  const maybePost = (
    entity: Entity,
    tr: {
      position: { x: number; y: number; z: number }
      rotation: { x: number; y: number; z: number; w: number }
      scale: { x: number; y: number; z: number }
      parent?: number
    }
  ): void => {
    const id = entity as number
    liveIds.add(id)
    const key = vcTransformPoseKey(tr)
    if (boundVcPoseKeys.get(id) === key) return
    boundVcPoseKeys.set(id, key)
    postVcPoseLive(entity, tr)
  }

  const vcEntity = vc as Entity
  const follow = isBoundVcPeFollowRig(eng)
  const vcTr = Transform.getOrNull(vcEntity)
  const spec = VirtualCamera.getOrNull(vcEntity) as { lookAtEntity?: number } | null
  const cinematic =
    !follow && isCinematicTweenRig(eng, vcTr?.parent as number | undefined, spec?.lookAtEntity)

  if (cinematic && vcTr) {
    // Reveal / tween-parent rig — post locals so Iu.position Jfe stays parent-relative.
    for (const anchor of collectTransformAncestorAnchors(eng, vcTr.parent as number | undefined)) {
      maybePost(anchor.entity as Entity, anchor.transform)
    }
    maybePost(vcEntity, {
      position: { x: vcTr.position.x, y: vcTr.position.y, z: vcTr.position.z },
      rotation: { x: vcTr.rotation.x, y: vcTr.rotation.y, z: vcTr.rotation.z, w: vcTr.rotation.w },
      scale: {
        x: vcTr.scale?.x ?? 1,
        y: vcTr.scale?.y ?? 1,
        z: vcTr.scale?.z ?? 1
      },
      parent: vcTr.parent as number | undefined
    })
    const lookAt = spec?.lookAtEntity
    if (
      lookAt !== undefined &&
      lookAt !== null &&
      lookAt !== (vc as number) &&
      !isMeshBearing(lookAt as Entity)
    ) {
      const atr = Transform.getOrNull(lookAt as Entity)
      if (atr) {
        maybePost(lookAt as Entity, {
          position: { x: atr.position.x, y: atr.position.y, z: atr.position.z },
          rotation: { x: atr.rotation.x, y: atr.rotation.y, z: atr.rotation.z, w: atr.rotation.w },
          scale: {
            x: atr.scale?.x ?? 1,
            y: atr.scale?.y ?? 1,
            z: atr.scale?.z ?? 1
          },
          parent: atr.parent as number | undefined
        })
      }
    }
  } else if (!follow) {
    // Locked / select stage — worker world pose under Root (main hierarchy is incomplete).
    const flat = worldFlattenedVcTransform(eng, vcEntity)
    maybePost(vcEntity, flat)
    // Pure-transform lookAt (plaza `vp`) Tweens after bind — keep it live or the
    // lens stays aimed at the spawn pose (0,-1,1).
    const lookAt = spec?.lookAtEntity
    if (
      lookAt !== undefined &&
      lookAt !== null &&
      lookAt !== (vc as number) &&
      lookAt !== 0 &&
      lookAt !== (eng.RootEntity as number) &&
      lookAt !== (eng.PlayerEntity as number) &&
      lookAt !== (eng.CameraEntity as number) &&
      !isMeshBearing(lookAt as Entity)
    ) {
      maybePost(lookAt as Entity, worldFlattenedVcTransform(eng, lookAt as Entity))
    }
  } else {
    // PE-follow — keep local hierarchy; pure-transform anchors only (never mesh lookAt).
    const tr = Transform.getOrNull(vcEntity)
    if (tr) {
      maybePost(vcEntity, {
        position: { x: tr.position.x, y: tr.position.y, z: tr.position.z },
        rotation: { x: tr.rotation.x, y: tr.rotation.y, z: tr.rotation.z, w: tr.rotation.w },
        scale: {
          x: tr.scale?.x ?? 1,
          y: tr.scale?.y ?? 1,
          z: tr.scale?.z ?? 1
        },
        parent: tr.parent as number | undefined
      })
    }
    const spec = VirtualCamera.getOrNull(vcEntity) as { lookAtEntity?: number } | null
    const lookAt = spec?.lookAtEntity
    if (lookAt !== undefined && lookAt !== null && lookAt !== (vc as number) && !isMeshBearing(lookAt as Entity)) {
      const atr = Transform.getOrNull(lookAt as Entity)
      if (atr) {
        maybePost(lookAt as Entity, {
          position: { x: atr.position.x, y: atr.position.y, z: atr.position.z },
          rotation: { x: atr.rotation.x, y: atr.rotation.y, z: atr.rotation.z, w: atr.rotation.w },
          scale: {
            x: atr.scale?.x ?? 1,
            y: atr.scale?.y ?? 1,
            z: atr.scale?.z ?? 1
          },
          parent: atr.parent as number | undefined
        })
      }
    }
  }

  for (const id of boundVcPoseKeys.keys()) {
    if (!liveIds.has(id)) boundVcPoseKeys.delete(id)
  }
}

/**
 * MOVE CAMERA flight — MainCamera unbound; mirror VC Transform moves (gizmo is parented under VC).
 * Phase 1 hot lane alongside player-frame (no CRDT ack wait).
 */
function publishVcPoseLiveDuringEditFlight(): void {
  // Only MOVE CAMERA (pointer-move latch) — not menu freezes.
  if (!sceneEngine || !sceneOnStartComplete || !isWorkerMoveCameraFlightLatched()) {
    editFlightVcPoseKeys.clear()
    return
  }
  const MainCamera = generated.MainCamera(sceneEngine)
  const main = MainCamera.getOrNull(sceneEngine.CameraEntity) as { virtualCameraEntity?: number } | null
  if (main?.virtualCameraEntity !== undefined && main?.virtualCameraEntity !== null) return

  const VirtualCamera = generated.VirtualCamera(sceneEngine)
  const Transform = extended.Transform(sceneEngine)
  const live = new Set<number>()
  for (const [entity] of sceneEngine.getEntitiesWith(VirtualCamera)) {
    const id = entity as number
    live.add(id)
    const tr = Transform.getOrNull(entity as Entity)
    if (!tr) continue
    const key = vcTransformPoseKey(tr)
    if (editFlightVcPoseKeys.get(id) === key) continue
    editFlightVcPoseKeys.set(id, key)
    postVcPoseLive(entity as Entity, tr)
  }
  for (const id of editFlightVcPoseKeys.keys()) {
    if (!live.has(id)) editFlightVcPoseKeys.delete(id)
  }
}

function publishVcPoseLiveEgress(): void {
  publishVcPoseLiveIfBound()
  publishVcPoseLiveDuringEditFlight()
}

function formatSceneLoopDt(dt: number): string {
  if (!(dt > 0)) return '0.000'
  const rounded = dt.toFixed(3)
  // Fail token is dt=0.000 — a legal sub-ms step must not print as that.
  return rounded === '0.000' ? dt.toFixed(6) : rounded
}

function emitSceneLoopGuestTick(tick: {
  source: 'play-frame' | 'pointer-edge' | 'hydrate'
  dt: number
}): void {
  ctx.postMessage({
    type: 'scene-loop-tick',
    source: tick.source,
    dt: tick.dt
  } satisfies SceneWorkerOutbound)
  if (!debugSceneLoop) return
  // Fail window: after the first source=play-frame line, dt=0.000 is a fail.
  // Hydrate ticks before that line are not a fail — source makes that unambiguous.
  // inFlight=0: this line is a start (deferred/idle do not emit). Host inflight stays on HUD.
  // Play-frame is ~60 Hz — log every tick freezes plaza (17→9 FPS). Pointer-edge is rare.
  if (tick.source === 'play-frame') {
    const now = performance.now()
    if (now - lastSceneLoopPlayFrameLogAt < 1000) return
    lastSceneLoopPlayFrameLogAt = now
  }
  workerLog(
    'warn',
    `[sceneloop] play-frame source=${tick.source} dt=${formatSceneLoopDt(tick.dt)} inFlight=0`
  )
}

initSceneEngineScheduler({
  log: (message) => workerLog('log', message),
  logWarn: (message) => workerLog('warn', message),
  onGuestTick: emitSceneLoopGuestTick,
  hydrationIntervalMs: HYDRATION_ENGINE_TICK_INTERVAL_MS,
  tickAbortMs: ENGINE_TICK_ABORT_MS,
  isHydration: () => sceneOnUpdatePaused,
  resolvePlayIntervalMs: () => engineTickIntervalMs,
  pointerBlocksTick: () => pointerBlocksEngineTick(),
  onBeforeEngineUpdate: () => {
    applyPendingSceneInputAtTick()
    applyHostReservedSceneStore()
  },
  queuePointerUiEgress: (snapshot) => {
    pointerUiMountSnapshot = snapshot
    pointerUiMountEgressPending = true
  },
  postUiLwwPuts: (data) => {
    postPlayModeColdCrdtFireAndForget(data)
  },
  postUiMountSnapshot: (snapshot, mountEntityIds) => {
    // Prefer explicit full mount list — empty is valid (welcome unmount → mount=[]).
    // Skipping empty left main with ghost PE catchers (hand cursor after visual dissolve).
    const uiEntities =
      mountEntityIds.length > 0
        ? mountEntityIds
        : snapshot.length > 0
          ? extractSnapshotMountEntityIds(snapshot)
          : []
    const uiKey = uiEntities.join(',')
    // Content-aware fingerprint — entity:componentId alone dropped timer/score UiText
    // updates forever (same rows, new values → fpKey match → silent skip → clock skips).
    const snapFp = uiMountSnapshotContentFp(snapshot) // shared content fp (workerSceneUiCrdtOutbound)
    const displayFp = uiMountSnapshotDisplayFp(snapshot)
    const fpKey = `${uiKey}@@d${displayFp}@@${snapFp}`
    if (fpKey === lastUiMountSnapshotFp) {
      return false
    }
    // Platform law: identical normalized content+mount never re-posts.
    // UiTransform.display (flex/none) is its own key — never fold it into other fields.
    lastUiMountSnapshotFp = fpKey
    lastOutboundUiEntitiesKey = uiKey
    logSceneUiOutbound(new Uint8Array(0), uiEntities, snapshot.length)
    ctx.postMessage({
      type: 'crdt-outbound',
      data: new Uint8Array(0),
      uiEntities,
      uiMountSnapshot: snapshot
    } satisfies SceneWorkerOutbound)
    return true
  },
  onStuckRecover: () => {
    interruptPendingOutboundAcks()
    interruptPendingCrdtRoundTrips()
    // Aborted cooperative tick may never reach onUpdate — don't leave pollEvents deferred forever.
    clearInjectOnlySdkPollEventsDeferred()
  },
  onAfterEngineTick: () => {
    publishVcBindHydrateIfNeeded()
    publishPlayerFrameIfChanged()
    publishVcPoseLiveEgress()
    if (isEditFlightMode() && workerSnapshotPressed.size > 0) {
      applyShimVcFlightFromRelay(1 / 20)
    }
  },
  onUnifiedPlayFrameComplete: async (dt) => {
    if (!sceneOnUpdate || sceneTicksPaused || pointerBlocksEngineTick()) {
      completePlayFrameColdEgress()
      ctx.postMessage({ type: 'play-frame-done' } satisfies SceneWorkerOutbound)
      return
    }
    sceneUpdateInFlight = true
    sceneUpdatePromiseActive = true
    sceneUpdateStartedAt = performance.now()
    try {
      await runPlayFramePollPhase(sceneOnUpdate, dt)
    } catch (err) {
      workerLog(
        'error',
        `[sceneWorker] play frame poll failed — ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      sceneUpdateInFlight = false
      sceneUpdatePromiseActive = false
    }
    completePlayFrameColdEgress()
    ctx.postMessage({ type: 'play-frame-done' } satisfies SceneWorkerOutbound)
  },
  onInjectOnlyUiPointerTickDone: () => {
    markDeferSdkPollEventsAfterInjectUiClick()
    workerVerboseLog(
      debugPointerDeliver,
      'log',
      '[sceneWorker] inject-only UI click — defer sdk pollEvents on next exports.onUpdate'
    )
  },
  onSceneUiInjectPointerComplete: ({ mountGrew }) => {
    // Drop pointer session so cooperative react-ecs is not suppressed (Color4.a paint path).
    // CBD Plaza: nZ(dt) fades Hr; mte() unmounts when Hr<=0 — needs real wall-clock eng.update.
    resetPointerInputSession()
    sceneTicksPaused = false
    workerLog(
      'log',
      `[sceneWorker] sceneUi inject complete — session ended, ticks unpaused (mountGrew=${mountGrew ? 1 : 0})`
    )
    if (sceneEngine && !sceneTicksPaused && !pointerBlocksEngineTick()) {
      requestSceneEngineTick({ source: 'pointer-edge' })
    }
  }
})

function workerVerboseLog(
  enabled: boolean,
  level: 'log' | 'info' | 'warn' | 'error' | 'debug',
  message: string
): void {
  if (!enabled) return
  workerLog(level, message)
}

/**
 * When true, cooperative eng.update is deferred (tickQueued).
 *
 * COD B2 — **Pointer never stops L2 clocks**: do **not** block on pointer input session
 * alone. Session only coalesces keyboard; timers/VC/tweens/isPressed reassert need
 * play-frame eng.update while mouse is held. Block only mid-inject or explicit pause.
 */
function pointerBlocksEngineTick(): boolean {
  if (sceneOnUpdatePaused) return false
  // SceneLoop owns the clock: PET inject is a store write. Blocking here
  // deferred the pointer-edge tick that EventSystem needs (getInputCommand miss).
  if (isSceneLoopOwnsPositiveDt()) {
    return sceneTicksPaused
  }
  if (pointerDeliveryInFlight || queuedPointerDeliver) return true
  return sceneTicksPaused || !!pendingInjectPointer || pointerDeliverBatchOpen
}

/**
 * Level-state reassert for keyboard relay + held pointer buttons.
 *
 * Neurolink drone (and many vehicles) use `inputSystem.isTriggered(PET_DOWN/UP)` edge
 * latches — NOT sticky `isPressed`. Those edges only count when PET timestamps land in
 * `thisFrameCommands` for the same engine.update. A one-shot DOWN on keydown is easy to
 * miss if a pointer session / skipped tick ate that frame; held flags then stay false forever.
 *
 * Always re-fire PET_DOWN with a fresh timestamp for every currently held key so
 * isTriggered(DOWN) is true every tick while the key is down. PET_UP only on release.
 *
 * Pointer: browser pointerdown/up is split across edges; without reassert, a quick click
 * never leaves a play frame with isPressed true (DOWN+UP same second → hold systems no-op).
 */
function reassertPressedKeysOnEngine(): void {
  if (!sceneEngine) return
  const player = sceneEngine.PlayerEntity as number
  const tickNumber = 0
  for (const action of SCENE_INPUT_SNAPSHOT_ACTIONS) {
    // E/F are tap edges, not holds. Reasserting PET_DOWN every play-frame while
    // WASD is held keeps isPressed(F) true and eats the next rising edge.
    if (action === InputAction.IA_PRIMARY || action === InputAction.IA_SECONDARY) continue
    const want = workerSnapshotPressed.has(action)
    if (want) {
      // Fresh DOWN every frame — isTriggered edge + isPressed both stay live.
      injectSceneKeyOnEngine(sceneEngine, {
        playerEntity: player,
        button: action,
        state: PointerEventType.PET_DOWN,
        timestamp: nextWorkerPointerEventTimestamp(),
        tickNumber
      })
      continue
    }
    // Release edge only when latest PET still looks held.
    if (!isSceneInputPressedOnPlayer(sceneEngine, player as Entity, action)) continue
    injectSceneKeyOnEngine(sceneEngine, {
      playerEntity: player,
      button: action,
      state: PointerEventType.PET_UP,
      timestamp: nextWorkerPointerEventTimestamp(),
      tickNumber
    })
  }
  // Intentionally no IA_POINTER reassert here.
  // @dcl/ecs getClick pairs last UP with the previous DOWN on that entity. Reasserting
  // PET_DOWN on PlayerEntity every play frame poisons getClick pairing for any scene.
  // isPressed(IA_POINTER) stays true from the original inject DOWN until browser UP.
}

/** Selected creator VC for shim flight — green emissive body (camera-operator SELECTED_COLOR). */
let shimFlightVcEntity: number | null = null

/**
 * Resolve selected VirtualCamera: gizmo body is parented under VC with green emissive
 * (selected) vs red (unselected) — see camera-operator setCameraBoxSelected.
 * Prefer MainCamera bind target when MOVE CAMERA previews through that lens.
 */
function resolveShimFlightVcEntity(): Entity | null {
  if (!sceneEngine) return null
  const VirtualCamera = generated.VirtualCamera(sceneEngine)
  const Transform = extended.Transform(sceneEngine)
  const Material = generated.Material(sceneEngine)
  const MainCamera = generated.MainCamera(sceneEngine)

  const main = MainCamera.getOrNull(sceneEngine.CameraEntity) as { virtualCameraEntity?: number } | null
  const bound = main?.virtualCameraEntity
  if (bound !== undefined && bound !== null && VirtualCamera.has(bound as Entity)) {
    shimFlightVcEntity = bound
    return bound as Entity
  }

  if (shimFlightVcEntity != null && VirtualCamera.has(shimFlightVcEntity as Entity)) {
    return shimFlightVcEntity as Entity
  }
  shimFlightVcEntity = null

  for (const [child, tr] of sceneEngine.getEntitiesWith(Transform)) {
    const parent = tr.parent as number | undefined
    if (parent === undefined || parent === null) continue
    if (!VirtualCamera.has(parent as Entity)) continue
    const mat = Material.getOrNull(child as Entity) as {
      material?: { $case?: string; pbr?: { emissiveColor?: { r?: number; g?: number; b?: number } } }
    } | null
    if (!mat?.material || mat.material.$case !== 'pbr') continue
    const em = mat.material.pbr?.emissiveColor
    if (!em) continue
    // SELECTED_COLOR ≈ (0.1, 1, 0.1) · UNSELECTED ≈ (1, 0.2, 0.2)
    if ((em.g ?? 0) > 0.7 && (em.r ?? 1) < 0.45) {
      shimFlightVcEntity = parent
      return parent as Entity
    }
  }

  // Single VC scene — safe fallback
  let only: Entity | null = null
  let count = 0
  for (const [entity] of sceneEngine.getEntitiesWith(VirtualCamera)) {
    only = entity as Entity
    count++
  }
  if (count === 1 && only != null) {
    shimFlightVcEntity = only as number
    return only
  }
  return null
}

export function noteShimFlightTargetFromMove(): void {
  shimFlightVcEntity = null
  const target = resolveShimFlightVcEntity()
  if (target != null) {
    workerLog('log', `[sceneWorker] shim flight target VC entity=${target as number}`)
  } else {
    workerLog('warn', '[sceneWorker] shim flight — no selected VC found (green gizmo)')
  }
}

export function clearShimFlightTarget(): void {
  shimFlightVcEntity = null
}

function multiplyQuat(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number }
): { x: number; y: number; z: number; w: number } {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  }
}

/** Yaw about world +Y (same as scene Quaternion.fromAngleAxis(deg, Up) * rotation). */
function applyYawToRotation(
  rotation: { x: number; y: number; z: number; w: number },
  deg: number
): { x: number; y: number; z: number; w: number } {
  const half = (deg * Math.PI) / 360
  const qYaw = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
  return multiplyQuat(qYaw, rotation)
}

/** Match camera-operator rigEulerToQuaternion / worldYawPitchFromLookAt. */
function yawPitchFromRotation(rotation: {
  x: number
  y: number
  z: number
  w: number
}): { yawDeg: number; pitchDeg: number } {
  // Forward = rotate (0,0,1) by quat
  const { x, y, z, w } = rotation
  const fx = 2 * (x * z + w * y)
  const fy = 2 * (y * z - w * x)
  const fz = 1 - 2 * (x * x + y * y)
  const mag = Math.hypot(fx, fy, fz) || 1
  const nx = fx / mag
  const ny = fy / mag
  const nz = fz / mag
  const yawDeg = (Math.atan2(nx, nz) * 180) / Math.PI
  const dist = Math.hypot(nx, nz)
  const pitchDeg = (Math.atan2(ny, Math.max(1e-5, dist)) * 180) / Math.PI
  return { yawDeg, pitchDeg }
}

/**
 * Match DCL `Quaternion.fromEulerDegrees(-pitchDeg, yawDeg, rollDeg)` /
 * `rigEulerToQuaternion` (Unity YawPitchRoll — NOT intrinsic XYZ).
 * Wrong order inverted pitch at yaw≈180° (default VC facing), so VIEW SHOT
 * disagreed with MOVE CAMERA when the shim wrote the pose.
 */
function rotationFromYawPitch(yawDeg: number, pitchDeg: number, rollDeg = 0): {
  x: number
  y: number
  z: number
  w: number
} {
  // fromEulerDegrees(x,y,z) → fromRotationYawPitchRoll(y_rad, x_rad, z_rad)
  const halfPitch = ((-pitchDeg) * Math.PI) / 360
  const halfYaw = (yawDeg * Math.PI) / 360
  const halfRoll = (rollDeg * Math.PI) / 360
  const c1 = Math.cos(halfPitch)
  const c2 = Math.cos(halfYaw)
  const c3 = Math.cos(halfRoll)
  const s1 = Math.sin(halfPitch)
  const s2 = Math.sin(halfYaw)
  const s3 = Math.sin(halfRoll)
  return {
    x: c2 * s1 * c3 + s2 * c1 * s3,
    y: s2 * c1 * c3 - c2 * s1 * s3,
    z: c2 * c1 * s3 - s2 * s1 * c3,
    w: c2 * c1 * c3 + s2 * s1 * s3
  }
}

/** MainCamera has a bound virtualCameraEntity (VIEW SHOT / select) — not MOVE CAMERA flight. */
/**
 * MOVE CAMERA edit flight: pointer-move freeze latch (not menu lock-all).
 * May run with MainCamera bound (lens preview) — then we fly that bound VC.
 * Character-select freezes via scene latch + bound VC — no flight pump.
 */
function isEditFlightMode(): boolean {
  return isWorkerMoveCameraFlightLatched()
}

/**
 * Fallback when scene updateCreatorEditFlight does not run (editFlightActive cleared by
 * double-toggle) but MOVE freeze is still active — move selected / bound VirtualCamera.
 *
 * Keyboard (VirtualCameraRig): WASD · Space/Shift · Digit1/2 yaw · E/F pitch.
 */
function applyShimVcFlightFromRelay(dtSec: number): number {
  if (!sceneEngine || workerSnapshotPressed.size === 0) return 0
  // Menu freezes bind VC for character select — never invent flight on scene latch.
  if (!isWorkerMoveCameraFlightLatched()) return 0
  const target = resolveShimFlightVcEntity()
  if (target == null) return 0
  const Transform = extended.Transform(sceneEngine)
  const tr = Transform.getOrNull(target)
  if (!tr) return 0
  const moveSpeed = 4
  const verticalSpeed = 3.5
  const rotateSpeed = 80
  let rotation = {
    x: tr.rotation.x,
    y: tr.rotation.y,
    z: tr.rotation.z,
    w: tr.rotation.w
  }
  const siny = 2 * (rotation.w * rotation.y + rotation.x * rotation.z)
  const cosy = 1 - 2 * (rotation.y * rotation.y + rotation.x * rotation.x)
  const yawRad = Math.atan2(siny, cosy)
  const forward = { x: Math.sin(yawRad), z: Math.cos(yawRad) }
  const right = { x: Math.cos(yawRad), z: -Math.sin(yawRad) }
  let dx = 0
  let dz = 0
  let dy = 0
  if (workerSnapshotPressed.has(InputAction.IA_FORWARD)) {
    dx += forward.x
    dz += forward.z
  }
  if (workerSnapshotPressed.has(InputAction.IA_BACKWARD)) {
    dx -= forward.x
    dz -= forward.z
  }
  if (workerSnapshotPressed.has(InputAction.IA_RIGHT)) {
    dx += right.x
    dz += right.z
  }
  if (workerSnapshotPressed.has(InputAction.IA_LEFT)) {
    dx -= right.x
    dz -= right.z
  }
  if (workerSnapshotPressed.has(InputAction.IA_JUMP) || workerSnapshotPressed.has(InputAction.IA_ACTION_5)) {
    dy += verticalSpeed * dtSec
  }
  if (
    workerSnapshotPressed.has(InputAction.IA_MODIFIER) ||
    workerSnapshotPressed.has(InputAction.IA_WALK) ||
    workerSnapshotPressed.has(InputAction.IA_ACTION_6)
  ) {
    dy -= verticalSpeed * dtSec
  }

  // Match VirtualCameraRig.updateCreatorEditFlight:
  // ACTION_3/4 (Digit1/2) = yaw · PRIMARY/SECONDARY (E/F) = pitch
  // (Panel legend says "E/F yaw" but scene code uses E/F for pitch.)
  let yawDelta = 0
  if (workerSnapshotPressed.has(InputAction.IA_ACTION_3)) yawDelta -= rotateSpeed * dtSec
  if (workerSnapshotPressed.has(InputAction.IA_ACTION_4)) yawDelta += rotateSpeed * dtSec
  if (yawDelta !== 0) {
    rotation = applyYawToRotation(rotation, yawDelta)
  }

  let pitchInput = 0
  if (workerSnapshotPressed.has(InputAction.IA_PRIMARY)) pitchInput += 1
  if (workerSnapshotPressed.has(InputAction.IA_SECONDARY)) pitchInput -= 1
  if (pitchInput !== 0) {
    const aim = yawPitchFromRotation(rotation)
    const pitchDeg = Math.max(-80, Math.min(80, aim.pitchDeg + pitchInput * rotateSpeed * dtSec))
    rotation = rotationFromYawPitch(aim.yawDeg, pitchDeg)
  }

  if (dx === 0 && dz === 0 && dy === 0 && yawDelta === 0 && pitchInput === 0) return 0
  Transform.createOrReplace(target, {
    position: {
      x: tr.position.x + dx * moveSpeed * dtSec,
      y: tr.position.y + dy,
      z: tr.position.z + dz * moveSpeed * dtSec
    },
    rotation,
    scale: tr.scale,
    parent: tr.parent
  })
  return 1
}

/**
 * Lightweight tween-state path — no pointer pause / preempt / full deliver batch.
 * Inject TweenState then engine.update(0) so tweenCompleted can fire without advancing
 * wall-clock systems (NeonScreen pauseDuration / scrollDuration).
 */
function deliverTweenStateInbound(chunks: Uint8Array[]): void {
  if (!sceneEngine || !sceneOnStartComplete) return
  const { tweenPuts } = injectRendererLwwPutsOnEngine(sceneEngine, chunks)
  if (tweenPuts === 0) return
  workerVerboseLog(
    debugTweenDeliver,
    'log',
    `[sceneWorker] tween-state-deliver — inject ${tweenPuts} TweenState PUT(s)`
  )
  // ENABLE_SDK_TWEEN_SEQUENCE=false: kernel (TweenBridge) owns hop advance.
  // Do not rearm here — that ran *before* eng.update and swallowed COMPLETED
  // so createTweenSystem never saw the edge (and would zip if the flag were on).
  if (isSceneLoopOwnsPositiveDt()) {
    queueSceneEngineTick()
    return
  }
  void runSceneEngineUpdateNow(0)
}

/**
 * Host grow-only (TriggerArea / VideoEvent / Pointer / AudioEvent / AssetLoad).
 * Apply into the guest store here; only SceneLoop starts engine.update(dt>0).
 * A lone VideoEvent offset heartbeat is store-only — next play-frame sees it.
 */
function isLoneVideoOffsetHeartbeat(counts: RendererInboundInjectCounts): boolean {
  return (
    counts.videoAppends === 1 &&
    counts.triggerAppends === 0 &&
    counts.pointerAppends === 0 &&
    counts.audioAppends === 0 &&
    counts.assetLoadAppends === 0 &&
    counts.videoPlayerPuts === 0 &&
    counts.audioSourcePuts === 0 &&
    counts.gltfLoadingStatePuts === 0 &&
    counts.uiInputResultPuts === 0 &&
    counts.uiDropdownResultPuts === 0 &&
    counts.tweenPuts === 0
  )
}

function deliverRendererAppendInbound(chunks: Uint8Array[]): void {
  if (!sceneEngine || !sceneOnStartComplete) return
  const counts = applyRendererInboundChunks(chunks)
  const growOnly = hasGrowOnlyInjects(counts)
  if (!growOnly && !hostInjectNeedsSceneSystems(counts)) return
  // Skip log for lone video-offset heartbeats (was ~2Hz spam during fishing cast).
  if (
    counts.triggerAppends > 0 ||
    counts.videoAppends > 1 ||
    counts.audioAppends > 0 ||
    counts.assetLoadAppends > 0 ||
    counts.pointerAppends > 0
  ) {
    workerLog(
      'log',
      `[sceneWorker] renderer-append-deliver — trigger=${counts.triggerAppends} videoEvent=${counts.videoAppends} audio=${counts.audioAppends} assetLoad=${counts.assetLoadAppends} pointer=${counts.pointerAppends}`
    )
  }
  // Offset heartbeats must not steal the mutex with dt=0 (plaza Tweens / fishing timers).
  if (isLoneVideoOffsetHeartbeat(counts)) return
  // TriggerArea ENTER / video src swap land in the store now; the next SceneLoop tick
  // (or the queued tick if this frame just ran) runs onChange with real dt.
  sceneEngineTickAfterInboundInject(counts)
}

function flushDeferredRendererInbound(opts?: { applyOnly?: boolean }): void {
  if (!deferredRendererInbound.length) return
  const batches = deferredRendererInbound.splice(0)
  for (const chunks of batches) {
    if (opts?.applyOnly) {
      // Inject host LWW (LoadingState etc.) and let freeze-watch systems react — do not
      // leave map/portal load freezes stuck after pointer-session resume.
      const counts = applyRendererInboundChunks(chunks)
      if (counts.gltfLoadingStatePuts > 0) {
        afterHostLwwSystemsReact(
          'deferred-applyOnly gltf LWW',
          counts.gltfLoadingStatePuts,
          counts.gltfLoadingStateTerminalPuts
        )
      }
      continue
    }
    deliverRendererInboundGeneral(chunks)
  }
}



function logSceneUiOutbound(data: Uint8Array, uiEntities?: number[], snapshotRows = 0): void {
  sceneUiOutboundLogCount++
  // Empty UI mount spam was logging every post (snapshotRows>0 always) — throttle to 1/s.
  const alwaysLog =
    sceneUiOutboundLogCount <= SCENE_UI_OUTBOUND_LOG_LIMIT ||
    (data.byteLength > 0 && sceneUiOutboundLogCount <= SCENE_UI_OUTBOUND_LOG_LIMIT + 8)
  const emptyUiThrottled =
    data.byteLength === 0 &&
    snapshotRows > 0 &&
    (sceneUiOutboundLogCount <= 8 || sceneUiOutboundLogCount % 40 === 0)
  const debugLog =
    debugSceneUiLog && (sceneUiOutboundLogCount <= 8 || sceneUiOutboundLogCount % 25 === 0)
  if (!alwaysLog && !emptyUiThrottled && !debugLog) return
  workerLog(
    'log',
    `[sceneWorker] crdt-outbound #${sceneUiOutboundLogCount} bytes=${data.byteLength} uiEntities=${uiEntities?.length ?? 0} snapshotRows=${snapshotRows}`
  )
}

/**
 * Phase C — full renderer inbound after async main encode (no crdt-response round-trip).
 *
 * Host LWW such as GltfContainerLoadingState must NEVER wait on pointer session / tick pause.
 * Scenes gate InputModifier.disableAll on LoadingState FINISHED (lobby dome, map load after
 * portal). Deferring those PUTs left players permanently locked after "start game".
 */
function deliverRendererInboundGeneral(chunks: Uint8Array[]): void {
  if (!chunks.length) return
  if (!sceneEngine) {
    rendererInboundApply?.(chunks)
    return
  }
  if (!sceneOnStartComplete) {
    const counts = applyRendererInboundChunks(chunks)
    afterHostLwwSystemsReact(
      'pre-onStart gltf LWW',
      counts.gltfLoadingStatePuts,
      counts.gltfLoadingStateTerminalPuts
    )
    return
  }

  const pointerBusy =
    pointerDeliveryInFlight || sceneTicksPaused || isPointerInputSessionActive()

  // Always inject host LWW immediately so freeze-watch systems can read currentState.
  const counts = applyRendererInboundChunks(chunks)
  if (counts.gltfLoadingStatePuts > 0) {
    afterHostLwwSystemsReact(
      pointerBusy ? 'gltf LWW (during pointer/pause)' : 'gltf LWW',
      counts.gltfLoadingStatePuts,
      counts.gltfLoadingStateTerminalPuts
    )
  }

  if (pointerBusy) {
    // Non-LWW residual already applied above via applyRendererInboundChunks (full inject).
    // Do not re-queue — re-apply would duplicate grow-only appends.
    return
  }

  sceneEngineTickAfterInboundInject(counts)
}

/** Drop / rate-limit scene console → main. Floods (NPC DEBUG:POINTER, staticData dumps) freeze the main thread. */
const WORKER_CONSOLE_DROP_RE =
  /\[DEBUG:POINTER\]|npc:staticData|Full npc:staticData|Animations received for|NPC added to state|equipment:attachments message received|First 5 items:/i
const WORKER_CONSOLE_BURST_WINDOW_MS = 1000
const WORKER_CONSOLE_BURST_MAX_LOG = 30
let workerConsoleBurstWindowStart = 0
let workerConsoleBurstCount = 0
let workerConsoleDropped = 0

function shouldForwardWorkerConsole(level: string, message: string): boolean {
  if (level === 'error' || level === 'warn') return true
  if (WORKER_CONSOLE_DROP_RE.test(message)) {
    workerConsoleDropped++
    return false
  }
  const now = performance.now()
  if (now - workerConsoleBurstWindowStart > WORKER_CONSOLE_BURST_WINDOW_MS) {
    if (workerConsoleDropped > 0) {
      workerLog(
        'log',
        `[sceneWorker] suppressed ${workerConsoleDropped} noisy scene console line(s) in the last 1s`
      )
      workerConsoleDropped = 0
    }
    workerConsoleBurstWindowStart = now
    workerConsoleBurstCount = 0
  }
  workerConsoleBurstCount++
  if (workerConsoleBurstCount > WORKER_CONSOLE_BURST_MAX_LOG) {
    workerConsoleDropped++
    return false
  }
  return true
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
      if (!shouldForwardWorkerConsole(level, message)) return
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

/**
 * Hard cap for one eng.update on a no-target edge. Genesis Plaza (fishing + particles
 * + 500+ entities) can spend >1s in a single systems pass — awaiting multiple updates
 * and blocking cooperative ticks (pointerDeliveryInFlight) collapsed FPS to teens.
 * One inject + one budgeted update per edge; follow-up dt via cooperative tick.
 */
const NO_TARGET_ENGINE_UPDATE_BUDGET_MS = 450

/**
 * No-target pointer edge (Explorer level-state) — scene-agnostic systems path.
 * PET on PlayerEntity hitEntity=0 + Camera/PPI + **one** eng.update. No UI settle.
 *
 * Platform law: isPressed arms on DOWN, falls on UP. Never invent a PE mesh.
 * Performance law: never multi-update or hard-await hung plaza systems — that blocks
 * all cooperative ticks via pointerDeliveryInFlight and tanks FPS (plaza ~13fps bug).
 */
async function runNoTargetPointerEdge(
  eng: NonNullable<typeof sceneEngine>,
  body: InjectPointerClickBody,
  phase: string,
  button: InputActionValue
): Promise<void> {
  workerLog('warn', `[sceneWorker] no-target ENTER phase=${phase} button=${button}`)
  setLevelStatePointerEdgeActive(true)
  setPointerInteractiveTickActive(false)
  setPointerInteractivePhase('inject')
  try {
    const ppi = body.primaryPointer
    if (ppi || body.camera) {
      applyPlayFrameReservedPoses(undefined, body.camera, ppi)
    }

    if (phase === 'down') {
      const sticky = isIaPointerPressedOnEngine(eng, button)
      if (ppi || body.camera) {
        applyPlayFrameReservedPoses(undefined, body.camera, ppi)
      }
      if (sticky) injectLevelStatePointerEdgeOnEngine(eng, body, 'up')
      injectLevelStatePointerEdgeOnEngine(eng, body, 'down')
      requestSceneEngineTick({ source: 'pointer-edge' })
      if (sticky) {
        workerLog('warn', '[sceneWorker] no-target DOWN sticky-clear — UP+DOWN same eng.update')
      }
      const ground = diagnoseLevelStateGroundRay(eng)
      const g = ground.ground
      const pressed = isIaPointerPressedOnEngine(eng, button)
      workerLog(
        'warn',
        `[sceneWorker] no-target DOWN isPressed-arm — pressed=${pressed ? 1 : 0} ` +
          `camY=${ground.camY?.toFixed(1) ?? '-'} rayY=${ground.rayY?.toFixed(2) ?? '-'} ` +
          `planeY0=${g ? `(${g.x.toFixed(1)},${g.z.toFixed(1)})` : 'null'} ` +
          `ppi=${ground.ppi ? 1 : 0} cam=${ground.cam ? 1 : 0} hitEntity=0`
      )
      workerLog('warn', `[sceneWorker] no-target EXIT phase=down pressed=${pressed ? 1 : 0}`)
      return
    }

    const mrBefore = countWorkerMeshRenderers(eng)
    if (ppi || body.camera) {
      applyPlayFrameReservedPoses(undefined, body.camera, ppi)
    }
    injectLevelStatePointerEdgeOnEngine(eng, body, 'up')
    requestSceneEngineTick({ source: 'pointer-edge' })
    const mrAfter = countWorkerMeshRenderers(eng)
    const delta = mrAfter - mrBefore
    const ground = diagnoseLevelStateGroundRay(eng)
    const g = ground.ground
    const stillPressed = isIaPointerPressedOnEngine(eng, button)
    workerLog(
      'warn',
      `[sceneWorker] no-target UP isPressed-path — MeshRenderer ${mrBefore}→${mrAfter} (Δ=${delta}) ` +
        `camY=${ground.camY?.toFixed(1) ?? '-'} rayY=${ground.rayY?.toFixed(2) ?? '-'} ` +
        `planeY0=${g ? `(${g.x.toFixed(1)},${g.z.toFixed(1)})` : 'null'} ` +
        `ppi=${ground.ppi ? 1 : 0} cam=${ground.cam ? 1 : 0} hitEntity=0 ` +
        `stillPressed=${stillPressed ? 1 : 0} ` +
        (delta === 0
          ? `(Δ=0: no new MeshRenderer this edge — scene gate or no unit selected)`
          : `(Δ>0: scene dirtied MeshRenderer — CRDT peel should apply)`)
    )
    workerLog('warn', `[sceneWorker] no-target EXIT phase=up Δ=${delta}`)
  } catch (err) {
    workerLog(
      'error',
      `[sceneWorker] no-target FAILED phase=${phase} — ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    throw err
  } finally {
    setLevelStatePointerEdgeActive(false)
    setPointerInteractivePhase('none')
    setPointerInteractiveTickActive(false)
  }
}

/** Serialize inject edges so DOWN always fully completes before UP (isPressed arm/release). */
let pointerInjectSerial: Promise<void> = Promise.resolve()

function enqueuePointerInject(body: InjectPointerClickBody): void {
  pointerInjectSerial = pointerInjectSerial
    .then(() => executePointerEdge(body))
    .catch((err) => {
      workerLog(
        'error',
        `[sceneWorker] inject-pointer-click edge rejected — ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      if (!pointerDeliveryInFlight) {
        pointerDeliverBatchOpen = true
        finalizePointerDelivery('inject-pointer-click-reject')
      }
    })
}

/**
 * Universal Explorer press edge for **every** scene (worker-input-architecture).
 *
 * Target classes (not scene names):
 * - no-target (level-state): PlayerEntity PET, hitEntity=0, systems-only
 * - world PE mesh: entity PET + optional UI settle for mesh-driven HUD
 * - sceneUi: react-ecs toggle path
 *
 * PET_DOWN / PET_UP only; eng.update so inputSystem + scene systems see the edge.
 */
async function executePointerHoverEdge(body: InjectPointerClickBody): Promise<void> {
  const enter = body.phase !== 'hover-leave'
  const label = enter ? 'pointer-edge-hover-enter' : 'pointer-edge-hover-leave'
  if (!sceneEngine || !sceneOnStartComplete) return
  try {
    if (body.primaryPointer || body.camera) {
      applyPlayFrameReservedPoses(undefined, body.camera, body.primaryPointer)
    }
    injectPointerHoverOnEngine(
      sceneEngine,
      body,
      enter ? PointerEventType.PET_HOVER_ENTER : PointerEventType.PET_HOVER_LEAVE
    )
    requestSceneEngineTick({ source: 'pointer-edge' })
  } catch (err) {
    workerLog(
      'warn',
      `[sceneWorker] ${label} failed — ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

async function executePointerEdge(body: InjectPointerClickBody): Promise<void> {
  if (body.phase === 'hover-enter' || body.phase === 'hover-leave') {
    await executePointerHoverEdge(body)
    return
  }
  const phase =
    body.phase === 'up' ? 'up' : body.phase === 'click' ? 'click' : 'down'
  const label = `pointer-edge-${phase}`
  const button = body.button as InputActionValue
  sceneTicksPaused = false
  if (isPointerInputSessionActive()) {
    endPointerInputSessionAfterMountResume()
  }
  const ppi = body.primaryPointer
  const sc = ppi?.screenCoordinates
  // Resolve no-target before held flags so recovered entity=PlayerEntity+hit=0 counts.
  const treatAsNoTargetEarly =
    !!body.levelState ||
    (!body.sceneUi &&
      (body.hitEntity === 0 || body.hitEntity === undefined) &&
      (body.entity === 1 ||
        (sceneEngine != null && body.entity === (sceneEngine.PlayerEntity as number))))
  // Explorer: keyboard E/F without a PE mesh are InputHub + play-frame reassert.
  // Do not run the no-target RTS edge (450ms budget + react-ecs hold).
  if (
    treatAsNoTargetEarly &&
    (button === InputAction.IA_PRIMARY || button === InputAction.IA_SECONDARY)
  ) {
    workerLog(
      'warn',
      `[sceneWorker] ${label} — keyboard level-state button=${button} (snapshot/reassert; skip no-target)`
    )
    postPointerDeliverDone(`${label}-keyboard-level`)
    return
  }
  // IA_POINTER empty-ground / scene-VC orbit: PET + PPI only. The RTS no-target path
  // (450ms budget, MeshRenderer census, react-ecs hold for the whole LMB drag)
  // starved Gulp play-frames (~13fps) while isPressed was already armed.
  if (treatAsNoTargetEarly && button === InputAction.IA_POINTER) {
    if (ppi || body.camera || body.pointerLock !== undefined) {
      applyPlayFrameReservedPoses(
        undefined,
        body.camera,
        ppi,
        undefined,
        undefined,
        body.pointerLock
      )
    }
    if (sceneEngine) {
      injectLevelStatePointerEdgeOnEngine(
        sceneEngine,
        body,
        phase === 'up' ? 'up' : 'down'
      )
      requestSceneEngineTick({ source: 'pointer-edge' })
    }
    if (phase === 'down' && !body.sceneUi) setWorkerPointerButtonHeld(button, true)
    else setWorkerPointerButtonHeld(button, false)
    workerLog(
      'warn',
      `[sceneWorker] ${label} — IA_POINTER level-state (PET+PPI; skip no-target RTS)`
    )
    postPointerDeliverDone(`${label}-pointer-level`)
    return
  }
  // Track held buttons for press lifecycle. No-target also defers cooperative
  // react-ecs between DOWN and UP so UI thrash does not starve systems on the hold window.
  const keyboardLevelState =
    treatAsNoTargetEarly &&
    (button === InputAction.IA_PRIMARY || button === InputAction.IA_SECONDARY)
  if (phase === 'down' && !body.sceneUi) {
    setWorkerPointerButtonHeld(button, true)
    // E/F level-state must not hold react-ecs (plaza reel bar / isTriggered HUD).
    if ((treatAsNoTargetEarly || body.levelState) && !keyboardLevelState) {
      setLevelStatePointerHeld(true)
    }
  } else if (phase === 'up' || phase === 'click' || body.sceneUi) {
    setWorkerPointerButtonHeld(button, false)
    if (treatAsNoTargetEarly || body.levelState || phase === 'up' || phase === 'click') {
      setLevelStatePointerHeld(false)
    }
  }
  const edgeLine =
    `[sceneWorker] ${label} e${body.entity} button=${body.button} sceneUi=${body.sceneUi ? 1 : 0} ` +
    `levelState=${body.levelState ? 1 : 0} noTarget=${treatAsNoTargetEarly ? 1 : 0} ` +
    `hitEntity=${body.hitEntity ?? '∅'} ` +
    `heldPointer=[${workerPointerButtonsHeldList().join(',')}]` +
    (sc ? ` ppi=(${sc.x.toFixed(0)},${sc.y.toFixed(0)})` : ' ppi=missing') +
    (body.camera
      ? ` camY=${body.camera.position.y.toFixed(1)}`
      : ' cam=missing') +
    (ppi?.worldRayDirection
      ? ` rayY=${ppi.worldRayDirection.y.toFixed(2)}`
      : '') +
    ` (no hold-batch freeze)`
  // Always warn — log-level edge lines were swallowed under UI thrash.
  workerLog('warn', edgeLine)
  if (!sceneEngine || !sceneOnStartComplete) {
    pendingInjectPointer = body
    workerLog('warn', `[sceneWorker] ${label} queued — sceneEngine not ready`)
    postPointerDeliverDone(`${label}-queued`)
    return
  }
  const eng = sceneEngine
  // Do not epoch-kill a live engine.update — SceneLoop law: skip-if-busy, inject
  // into the store, next pointer-edge tick sees PET. Preempt dropped the tick
  // that would have consumed the click (plaza PET_UP / getInputCommand).
  pointerDeliveryInFlight = true
  setPointerDeliveryInFlight(true)
  // Main arms ~2s deliver-done watchdog. Scene UI DOWN must finish EventSystem
  // (onMouseDown / welcome fade) — a 600ms race acked deliver-done before update
  // and the splash needed many clicks. UP can still budget-ack.
  const EDGE_ACK_BUDGET_MS = body.sceneUi ? 2000 : 1500
  try {
    if (ppi || body.camera) {
      applyPlayFrameReservedPoses(undefined, body.camera, ppi)
    }
    let edgeTimedOut = false
    let noTargetEdgeLogged = false
    const treatAsNoTarget =
      treatAsNoTargetEarly ||
      (!body.sceneUi &&
        body.entity === (eng.PlayerEntity as number) &&
        (body.hitEntity === 0 || body.hitEntity === undefined))
    const logNoTargetEdgeDone = (suffix = ''): void => {
      if (!treatAsNoTarget || noTargetEdgeLogged) return
      noTargetEdgeLogged = true
      workerLog(
        'warn',
        `[sceneWorker] no-target edge done phase=${body.phase ?? '?'} ` +
          `hitEntity=${body.hitEntity ?? 0} flag=${body.levelState ? 1 : 0} ` +
          `hit=(${body.hitPosition.x.toFixed(1)},${body.hitPosition.y.toFixed(1)},${body.hitPosition.z.toFixed(1)}) ` +
          `cam=${body.camera ? 'live' : 'missing'} ppi=${body.primaryPointer ? 1 : 0}` +
          suffix
      )
    }
    // All edges budget-ack so pointerDeliveryInFlight cannot pin cooperative ticks.
    // No-target used to hard-await hung plaza eng.update (1.5s+) → main 2s fail + ~13fps.
    const runEdgeWork = async (): Promise<void> => {
      if (treatAsNoTarget) {
        workerLog(
          'warn',
          `[sceneWorker] no-target DISPATCH phase=${phase} treat=1 eng=1`
        )
        await runNoTargetPointerEdge(eng, body, phase, button)
        logNoTargetEdgeDone()
        if (phase === 'up' && sceneOnUpdate) {
          try {
            // Short poll only — full plaza pollEvents must not own the edge.
            await Promise.race([
              runPlayFramePollPhase(sceneOnUpdate, 0),
              new Promise<void>((r) => setTimeout(r, 200))
            ])
          } catch (err) {
            workerLog(
              'warn',
              `[sceneWorker] no-target pollEvents after UP failed — ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          }
        }
      } else {
        await runSceneEnginePointerTick(eng, async () => {}, body)
      }
      await flushPointerDeferredOutboundsAsync()
    }
    // World PE + sceneUi: never budget-ack before PET lands (plaza Cast Line PET_UP).
    // No-target still races — a hung plaza eng.update used to pin main 2s and drop to ~13fps.
    const skipBudgetRace = !treatAsNoTarget
    const ackBudgetMs = treatAsNoTarget
      ? NO_TARGET_ENGINE_UPDATE_BUDGET_MS + 250
      : EDGE_ACK_BUDGET_MS
    if (skipBudgetRace) {
      await runEdgeWork()
    } else {
      await Promise.race([
        runEdgeWork(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            edgeTimedOut = true
            resolve()
          }, ackBudgetMs)
        })
      ])
    }
    if (edgeTimedOut) {
      logNoTargetEdgeDone(' (budget-timeout)')
      workerLog(
        'warn',
        `[sceneWorker] ${label} — edge budget ${ackBudgetMs}ms exceeded; acking deliver-done (partial)`
      )
      interruptPendingOutboundAcks()
      forceReleaseEngineUpdateMutex(`${label}-edge-budget`)
      try {
        await Promise.race([
          flushPointerDeferredOutboundsAsync(),
          new Promise<void>((r) => setTimeout(r, 150))
        ])
      } catch {
        /* ack regardless */
      }
    }
  } catch (err) {
    workerLog(
      'error',
      `[sceneWorker] ${label} failed — ${err instanceof Error ? err.message : String(err)}`
    )
    try {
      await Promise.race([
        flushPointerDeferredOutboundsAsync(),
        new Promise<void>((r) => setTimeout(r, 200))
      ])
    } catch {
      /* best-effort phase-4 egress before ack */
    }
  } finally {
    // sceneUi DOWN batch already injected UP — ensure hold flag never sticks.
    if (body.sceneUi) setWorkerPointerButtonHeld(button, false)
    pointerDeliveryInFlight = false
    setPointerDeliveryInFlight(false)
    sceneTicksPaused = false
    postPointerDeliverDone(label)
    resumeSceneTicksAfterPointer()
    requestSceneEngineTick({ source: 'pointer-edge' })
    // CRDT-only delivers queued while inject edge was in-flight must not sit forever
    // (main no longer arms deliver-done for CRDT-only, but residual queue still matters).
    drainQueuedPointerDeliver()
  }
}

function executePointerInjection(body: InjectPointerClickBody, _injectOnly = false): void {
  // All scenes / all targets: edge-first lifecycle, serialized so DOWN completes before UP.
  enqueuePointerInject(body)
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

const EMPTY_RENDERER_INJECT_COUNTS = {
  tweenPuts: 0,
  raycastPuts: 0,
  videoPlayerPuts: 0,
  audioSourcePuts: 0,
  gltfLoadingStatePuts: 0,
  gltfLoadingStateTerminalPuts: 0,
  reservedTransformPuts: 0,
  triggerAppends: 0,
  videoAppends: 0,
  pointerAppends: 0,
  audioAppends: 0,
  assetLoadAppends: 0,
  uiInputResultPuts: 0,
  uiDropdownResultPuts: 0
}

/**
 * Platform: host LWW (e.g. GltfContainerLoadingState) landed → run systems so scenes can
 * react (InputModifier deleteFrom, UI, etc.) → egress player-frame so main matches worker.
 *
 * When terminal LoadingState PUTs land, only a **platform** load-gate freeze may be
 * force-cleared. Scene lock-all (`latchSrc=scene`) stays until the scene deletes it.
 *
 * Free-play late attaches (pool cells etc.): one engine tick only — never the 3-tick
 * load-gate path (that flooded player-frame + tanked plaza FPS/colliders).
 */
function afterHostLwwSystemsReact(
  label: string,
  gltfPuts: number,
  terminalPuts = 0
): void {
  if (!sceneEngine || gltfPuts <= 0) return
  const eng = sceneEngine
  const inSyncWindow = performance.now() < mainImClearSyncUntilMs
  // LoadingState is already in the store. SceneLoop (or hydration) starts the real-dt
  // tick — do not invent 1/30 extra clocks that steal the play-frame mutex.
  if (playFrameTickMainDriven) queueSceneEngineTick()
  else requestSceneEngineTick({ source: 'hydrate' })

  // Fast path: terminal GLBs while free-playing and not in freeze-recovery window.
  if (
    terminalPuts > 0 &&
    !portableExperienceWorker &&
    !inSyncWindow &&
    !isWorkerDisableAllFrozen(eng)
  ) {
    publishPlayerFrameIfChanged()
    return
  }

  // Invalidate player-frame dedupe so a freeze→clear transition always ships.
  resetPlayerFrameEgressBaseline()
  publishPlayerFrameIfChanged()
  try {
    const desc = describeWorkerInputModifier(eng)
    if (/disableAll=true|frozen=true|latched=true/i.test(desc)) {
      workerLog('log', `[sceneWorker] InputModifier after ${label} — ${desc}`)
    }
  } catch {
    /* best-effort */
  }
  // Terminal load-gate: only when locomotion is actually frozen (or recovering).
  // PE workers: never force-clear — drone/vehicle freezes are intentional after GLB FINISHED.
  if (terminalPuts > 0 && !portableExperienceWorker) {
    const cleared = forceClearDisableAllAfterLoadGate(
      eng,
      `${label} terminal=${terminalPuts}`
    )
    if (cleared) {
      mainImClearSyncUntilMs = performance.now() + 4000
      publishForcedPlayerFrameClear(
        `${label} terminal=${terminalPuts} after load-gate clear`
      )
    } else if (performance.now() < mainImClearSyncUntilMs) {
      publishForcedPlayerFrameClear(
        `${label} terminal=${terminalPuts} main sync window`
      )
    }
  } else if (terminalPuts > 0 && portableExperienceWorker) {
    workerLog(
      'log',
      `[sceneWorker] load-gate skip force-clear — PE worker (intentional freeze) terminal=${terminalPuts}`
    )
  }
}

function isSealedEngineError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('already sealed')
}

function applyRendererInboundChunks(chunks: Uint8Array[]): {
  tweenPuts: number
  raycastPuts: number
  videoPlayerPuts: number
  audioSourcePuts: number
  gltfLoadingStatePuts: number
  gltfLoadingStateTerminalPuts: number
  reservedTransformPuts: number
  triggerAppends: number
  videoAppends: number
  pointerAppends: number
  audioAppends: number
  assetLoadAppends: number
  uiInputResultPuts: number
  uiDropdownResultPuts: number
} {
  let tweenPuts = 0
  let raycastPuts = 0
  let videoPlayerPuts = 0
  let audioSourcePuts = 0
  let gltfLoadingStatePuts = 0
  let gltfLoadingStateTerminalPuts = 0
  let reservedTransformPuts = 0
  let triggerAppends = 0
  let videoAppends = 0
  let pointerAppends = 0
  let audioAppends = 0
  let assetLoadAppends = 0
  let uiInputResultPuts = 0
  let uiDropdownResultPuts = 0
  if (sceneEngine) {
    try {
      const lww = injectRendererLwwPutsOnEngine(sceneEngine, chunks)
      tweenPuts = lww.tweenPuts
      raycastPuts = lww.raycastPuts
      videoPlayerPuts = lww.videoPlayerPuts
      audioSourcePuts = lww.audioSourcePuts
      gltfLoadingStatePuts = lww.gltfLoadingStatePuts
      gltfLoadingStateTerminalPuts = lww.gltfLoadingStateTerminalPuts
      reservedTransformPuts = lww.reservedTransformPuts
      uiInputResultPuts = lww.uiInputResultPuts
      uiDropdownResultPuts = lww.uiDropdownResultPuts
      const growOnly = injectRendererGrowOnlyAppendsOnEngine(sceneEngine, chunks)
      triggerAppends = growOnly.triggerAppends
      videoAppends = growOnly.videoAppends
      pointerAppends = growOnly.pointerAppends
      audioAppends = growOnly.audioAppends
      assetLoadAppends = growOnly.assetLoadAppends
      if (gltfLoadingStatePuts > 0) {
        gltfLoadingStateInjectLogCount++
        if (gltfLoadingStateInjectLogCount <= 32 || gltfLoadingStateInjectLogCount % 40 === 0) {
          workerLog(
            'log',
            `[sceneWorker] GltfContainerLoadingState inject #${gltfLoadingStateInjectLogCount} — ${gltfLoadingStatePuts} PUT(s) terminal=${gltfLoadingStateTerminalPuts}`
          )
        }
      }
    } catch (err) {
      if (!isSealedEngineError(err) || !rendererInboundApply) throw err
      workerVerboseLog(
        debugPointerDeliver,
        'warn',
        '[sceneWorker] renderer inject blocked (sealed) — falling back to transport'
      )
      rendererInboundApply(chunks)
      return EMPTY_RENDERER_INJECT_COUNTS
    }
  }
  // Transport still applies identity / camera LWW. Grow-only was already injected above —
  // re-APPEND via transport doubles TriggerArea enter (health −2), pointer, video handlers.
  if (rendererInboundApply) {
    const forTransport =
      sceneEngine != null
        ? chunks.map((c) => stripRendererHostGrowOnlyAppendsBytes(c)).filter((c) => c.byteLength > 0)
        : chunks
    if (forTransport.length) rendererInboundApply(forTransport)
  }
  return {
    tweenPuts,
    raycastPuts,
    videoPlayerPuts,
    audioSourcePuts,
    gltfLoadingStatePuts,
    gltfLoadingStateTerminalPuts,
    reservedTransformPuts,
    triggerAppends,
    videoAppends,
    pointerAppends,
    audioAppends,
    assetLoadAppends,
    uiInputResultPuts,
    uiDropdownResultPuts
  }
}

function executePointerDelivery(chunks: Uint8Array[]): void {
  if (pointerDeliveryInFlight) {
    queuedPointerDeliver = chunks
    return
  }

  /**
   * Non-batch path (no open click inject): renderer LWW / grow-only reuses this message type.
   * MUST NOT set sceneTicksPaused — pre-onStart fallthrough used to pause forever and freeze
   * SpaceRunner (InputModifier.disableAll never cleared; freeze-watch systems never tick).
   */
  if (!pointerDeliverBatchOpen) {
    const canDirectInject = !!sceneEngine && sceneOnStartComplete
    try {
      if (canDirectInject) {
        const counts = applyRendererInboundChunks(chunks)
        const {
          tweenPuts,
          raycastPuts,
          videoPlayerPuts,
          audioSourcePuts,
          gltfLoadingStatePuts,
          gltfLoadingStateTerminalPuts,
          triggerAppends,
          videoAppends,
          pointerAppends,
          audioAppends,
          assetLoadAppends,
          uiInputResultPuts,
          uiDropdownResultPuts
        } = counts
        const needsTimedSystems = hostInjectNeedsSceneSystems(counts)
        if (needsTimedSystems) {
          // Store is updated. SceneLoop owns positive dt — do not steal the mutex with dt=0.
          workerVerboseLog(
            debugPointerDeliver,
            'log',
            `[sceneWorker] pointer-crdt-deliver — light inject trigger=${triggerAppends} videoEvent=${videoAppends} audio=${audioAppends} assetLoad=${assetLoadAppends} pointer=${pointerAppends} raycast=${raycastPuts} videoPlayer=${videoPlayerPuts} audioSrc=${audioSourcePuts} gltfLoad=${gltfLoadingStatePuts} uiInput=${uiInputResultPuts} uiDropdown=${uiDropdownResultPuts}`
          )
          if (gltfLoadingStatePuts > 0) {
            afterHostLwwSystemsReact(
              'pointer-crdt timed systems',
              gltfLoadingStatePuts,
              gltfLoadingStateTerminalPuts
            )
          }
          queueSceneEngineTick()
          return
        }
        // Tween + host LWW: inject + systems without pause. Real dt when LoadingState lands
        // so scene systems (load-freeze watchers) can accumulate AF timeouts and clear IM.
        if (tweenPuts > 0 || gltfLoadingStatePuts > 0) {
          if (
            gltfLoadingStatePuts > 0 &&
            (gltfLoadingStateInjectLogCount <= 32 || gltfLoadingStateInjectLogCount % 40 === 0)
          ) {
            workerLog(
              'log',
              `[sceneWorker] pointer-crdt-deliver — gltfLoad=${gltfLoadingStatePuts} terminal=${gltfLoadingStateTerminalPuts} tween=${tweenPuts} → systems`
            )
          } else if (tweenPuts > 0) {
            workerVerboseLog(
              debugTweenDeliver,
              'log',
              `[sceneWorker] pointer-crdt-deliver — tween inject ${tweenPuts} TweenState PUT(s)`
            )
          }
          if (gltfLoadingStatePuts > 0) {
            afterHostLwwSystemsReact(
              'pointer-crdt gltf LWW',
              gltfLoadingStatePuts,
              gltfLoadingStateTerminalPuts
            )
          } else if (isSceneLoopOwnsPositiveDt()) {
            queueSceneEngineTick()
          } else {
            void runSceneEngineUpdateNow(0)
          }
        }
        return
      }

      // Pre-onStart / no engine: apply without pausing cooperative ticks.
      if (sceneEngine) {
        applyRendererInboundChunks(chunks)
      } else if (rendererInboundApply) {
        rendererInboundApply(chunks)
      } else {
        workerLog('warn', '[sceneWorker] pointer-crdt-deliver skipped — no engine/transport (pre-onStart)')
        return
      }
      workerVerboseLog(
        debugPointerDeliver,
        'log',
        '[sceneWorker] pointer-crdt-deliver — light apply (pre-onStart, no tick pause)'
      )
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
    }
    return
  }

  // Residual CRDT pointer appends (rare with inject-authoritative edges).
  // Prefer not to pause long — open batch only for finalize lifecycle.
  preemptForPointerDelivery()
  if (!rendererInboundApply && !(sceneEngine && sceneOnStartComplete)) {
    workerLog('warn', '[sceneWorker] pointer-crdt-deliver skipped — rendererInboundApply not bound')
    postPointerDeliverDone('pointer-crdt-deliver-skip')
    return
  }
  try {
    beginPointerDeliverBatch('pointer-crdt-deliver')
    const { tweenPuts, raycastPuts, videoPlayerPuts, triggerAppends, videoAppends, pointerAppends } =
      applyRendererInboundChunks(chunks)
    workerVerboseLog(
      debugPointerDeliver,
      'log',
      `[sceneWorker] pointer-crdt-deliver — batch apply tween=${tweenPuts} raycast=${raycastPuts} videoPlayer=${videoPlayerPuts} trigger=${triggerAppends} video=${videoAppends} pointer=${pointerAppends}`
    )
    finalizePointerDelivery('pointer-crdt-deliver')
  } catch (err) {
    workerLog(
      'error',
      `[sceneWorker] pointer-crdt-deliver failed — ${err instanceof Error ? err.message : String(err)}`
    )
    if (pointerDeliverBatchOpen) finalizePointerDelivery('pointer-crdt-deliver')
    else postPointerDeliverDone('pointer-crdt-deliver-error')
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
      for (const chunk of chunks) {
        const filtered = stripWorkerAuthoritativeCrdtBytes(chunk)
        if (!filtered.byteLength) continue
        onmessage(filtered)
      }
    }
    workerLog('log', '[sceneWorker] renderer inbound bound')
  }

  watchRendererTransportOnmessage(transport, applyBinding)
}

/** UiTransform ids on the worker engine — main thread must not render projection extras. */
function collectWorkerUiEntityIds(): number[] {
  if (!sceneEngine) return []
  preregisterRendererInjectedComponents(sceneEngine)
  return collectWorkerUiTransformEntityIds(sceneEngine)
}

function resolveOutboundAck(id: number): void {
  pendingOutboundAck.get(id)?.()
  pendingOutboundAck.delete(id)
}

function interruptPendingOutboundAcks(): void {
  if (!pendingOutboundAck.size) return
  const count = pendingOutboundAck.size
  for (const finish of pendingOutboundAck.values()) finish()
  pendingOutboundAck.clear()
  workerLog('log', `[sceneWorker] interrupted ${count} pending crdt-outbound-ack waiter(s)`)
}

function rpcCrdt(data: Uint8Array): Promise<Uint8Array[]> {
  // WSP v2 Phase 0b/0.5 — measure crdtSendToRenderer wall + path (nested in sendMessages).
  const t0 = performance.now()
  const inBytes = data.byteLength
  const note = (awaitedAck: boolean, path: CrdtSendPath, outBytes = inBytes) => {
    noteCrdtSendToRenderer(performance.now() - t0, outBytes, awaitedAck, path)
  }

  if (sceneEvalInProgress) {
    note(false, 'eval', 0)
    return Promise.resolve([])
  }
  let copy = data.slice()
  // Post-onStart: empty nudges are fire-and-forget; non-empty awaits crdt-outbound-ack.
  if (sceneOnStartComplete && !sceneBootInProgress) {
    if (!shouldAttachUiMountSnapshot() && copy.byteLength > 0) {
      // Hydration: snapshot is the UI path. Play: Ui* stays on the LWW wire.
      const withoutHost = stripHostOwnedLwwBytes(copy)
      const stripped = sceneOnUpdatePaused ? stripSceneUiCrdtBytes(withoutHost) : withoutHost
      if (!stripped.byteLength) {
        note(false, 'strip-ui', 0)
        return Promise.resolve([])
      }
      copy = stripped.slice()
    }
    if (sceneEngine && copy.byteLength > 0) {
      if (sceneOnUpdatePaused) {
        copy = reconcileMainCameraCrdtEgress(sceneEngine, copy).slice()
        if (copy.byteLength) copy = reconcileInputModifierCrdtEgress(sceneEngine, copy).slice()
      } else {
        copy = stripPlayerFrameComponentsFromCrdt(copy).slice()
      }
      if (!copy.byteLength) {
        note(false, 'strip-pe', 0)
        return Promise.resolve([])
      }
    }
    // Play: present this tick. Ui* LWW stays on the wire. No cold buffer.
    if (!sceneOnUpdatePaused && copy.byteLength > 0) {
      const present = stripHostOwnedLwwBytes(copy)
      if (present.byteLength) {
        const outLen = present.byteLength
        postPlayModeColdCrdtFireAndForget(present)
        note(false, 'present', outLen)
        return Promise.resolve([])
      }
    }
    if (shouldDeferPointerOutbound()) {
      if (copy.byteLength > 0) {
        const nonUi = stripHostOwnedLwwBytes(stripSceneUiCrdtBytes(copy))
        if (nonUi.byteLength) pointerDeferredNonUi.push(nonUi)
      }
      note(false, 'defer-ptr', 0)
      return Promise.resolve([])
    }
    const attachUiMount = shouldAttachUiMountSnapshot()
    // Hydration / intentional UI transport: structured snapshot (same as pointer phase-4).
    // Wire CRDT alone often lands partial UiTransform (Planetangzaar: 1/255) while mount=255.
    const uiMountSnapshot =
      attachUiMount && sceneEngine ? collectWorkerUiMountSnapshot(sceneEngine) : undefined
    const uiEntities = attachUiMount
      ? sceneEngine
        ? collectWorkerUiMountEntityIds(sceneEngine)
        : uiMountSnapshot?.length
          ? extractSnapshotMountEntityIds(uiMountSnapshot)
          : collectWorkerUiEntityIds()
      : undefined
    const uiKey = attachUiMount ? uiEntities!.join(',') : lastOutboundUiEntitiesKey
    if (copy.byteLength === 0) {
      // Empty outbound with the same UI mount set is pure thrash (spam-click
      // re-posted uiEntities every microtask → main-thread freezes, Tweens stall).
      if (attachUiMount && uiKey === lastOutboundUiEntitiesKey) {
        note(false, 'empty-dup', 0)
        return Promise.resolve([])
      }
      // Non-UI empty nudges: one post per microtask is enough for main to pump.
      if (!attachUiMount && crdtOutboundEmptyNudgeCoalesced) {
        note(false, 'empty-coal', 0)
        return Promise.resolve([])
      }
      if (!attachUiMount) {
        crdtOutboundEmptyNudgeCoalesced = true
        queueMicrotask(() => {
          crdtOutboundEmptyNudgeCoalesced = false
        })
      }
    }
    if (attachUiMount) lastOutboundUiEntitiesKey = uiKey
    // Prefer structured snapshot; strip wire Ui* so main does not double-apply partial shells.
    if (attachUiMount) {
      copy = stripHostOwnedLwwBytes(stripSceneUiCrdtBytes(copy)).slice()
    }
    if (copy.byteLength === 0) {
      logSceneUiOutbound(copy, uiEntities, uiMountSnapshot?.length ?? 0)
      const msg = attachUiMount
        ? ({
            type: 'crdt-outbound',
            data: copy,
            uiEntities,
            uiMountSnapshot: uiMountSnapshot ?? []
          } satisfies SceneWorkerOutbound)
        : ({ type: 'crdt-outbound', data: copy } satisfies SceneWorkerOutbound)
      ctx.postMessage(msg)
      note(false, 'empty-nudge', 0)
      return Promise.resolve([])
    }
    if (!sceneOnUpdatePaused) {
      const outLen = copy.byteLength
      postPlayModeColdCrdtFireAndForget(copy)
      note(false, 'present', outLen)
      return Promise.resolve([])
    }
    logSceneUiOutbound(copy, uiEntities, uiMountSnapshot?.length ?? 0)
    const id = ++outboundAckId
    const outBytes = copy.byteLength
    return new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        pendingOutboundAck.delete(id)
        note(true, 'ack', outBytes)
        resolve([])
      }
      pendingOutboundAck.set(id, finish)
      setTimeout(finish, OUTBOUND_ACK_TIMEOUT_MS)
      const msg = attachUiMount
        ? ({
            type: 'crdt-outbound',
            id,
            data: copy,
            uiEntities,
            uiMountSnapshot: uiMountSnapshot ?? []
          } satisfies SceneWorkerOutbound)
        : ({ type: 'crdt-outbound', id, data: copy } satisfies SceneWorkerOutbound)
      ctx.postMessage(msg, [copy.buffer])
    })
  }
  const id = ++requestId
  const bootBytes = copy.byteLength
  return new Promise((resolve) => {
    const finish = (value: Uint8Array[]): void => {
      note(true, 'boot', bootBytes)
      resolve(value)
    }
    pendingCrdt.set(id, finish)
    const msg = { type: 'crdt-send', id, data: copy } satisfies SceneWorkerOutbound
    // Do not transfer an empty view's backing buffer — some runtimes deliver a broken payload.
    if (copy.byteLength === 0) ctx.postMessage(msg)
    else ctx.postMessage(msg, [copy.buffer])
  })
}

function rpcGetState(): Promise<{ hasEntities: boolean; data: Uint8Array[] }> {
  if (sceneEvalInProgress) {
    if (bootCrdtSnapshot) {
      return Promise.resolve({
        hasEntities: bootCrdtSnapshot.hasEntities,
        data: bootCrdtSnapshot.data.map((chunk) => chunk.slice())
      })
    }
    return Promise.resolve({ hasEntities: false, data: [] })
  }
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

function rpcTeleportTo(body: TeleportToRequest): Promise<TeleportToResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingTeleportTo.set(id, resolve)
    ctx.postMessage({ type: 'teleport-to', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcChangeRealm(body: ChangeRealmRequest): Promise<ChangeRealmResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingChangeRealm.set(id, resolve)
    ctx.postMessage({ type: 'change-realm', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcCopyToClipboard(body: CopyToClipboardRequest): Promise<CopyToClipboardResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingCopyToClipboard.set(id, resolve)
    ctx.postMessage({ type: 'copy-to-clipboard', id, body } satisfies SceneWorkerOutbound)
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

function rpcOpenNftDialog(body: OpenNftDialogRequest): Promise<OpenNftDialogResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingOpenNftDialog.set(id, resolve)
    ctx.postMessage({ type: 'open-nft-dialog', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcSetCameraTransform(body: SetCameraTransformRequest): Promise<SetCameraTransformResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingSetCameraTransform.set(id, resolve)
    ctx.postMessage({ type: 'set-camera-transform', id, body } satisfies SceneWorkerOutbound)
  })
}

function rpcCommsAdapter(body: CommsAdapterRequest): Promise<{ success: boolean }> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingCommsAdapter.set(id, resolve)
    ctx.postMessage({ type: 'set-comms-adapter', id, body } satisfies SceneWorkerOutbound)
  })
}

/**
 * Inbound scene-binary stashed from async empty-poll responses (or other ingress).
 * Applied on the next network transport send (≤1 empty-poll interval lag when empty-fast).
 */
function takeBufferedSendBinaryInbound(): Uint8Array[] {
  if (!pendingInboundBinaries.length) return []
  return pendingInboundBinaries.splice(0)
}

const CUSTOM_EVENT_NAME_RE =
  /teamAssigned|weatherState|paintDelta|snapshot|joinRoster|paintTick|botPositions|roundReset|requestSnapshot|updateName|move|join|split|eatFood|eatPlayer|respawn|blobKnock|massUpdate|foodSpawn|foodGone|leaderboard|boostStart|spikeStart|spikeHit/

function peekCustomEventName(payload: Uint8Array): string {
  const n = Math.min(payload.byteLength, 96)
  let ascii = ''
  for (let i = 0; i < n; i++) {
    const b = payload[i]!
    ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : ' '
  }
  return ascii.match(CUSTOM_EVENT_NAME_RE)?.[0] ?? '?'
}

function isolateSendBinaryInbound(chunks: Uint8Array[] | undefined): Uint8Array[] {
  if (!chunks?.length) return []
  return chunks.map((chunk) => isolateCommsBinaryMessage(chunk))
}

let sendBinaryInboundLogCount = 0

function inboundHasRoomReadyTypes(chunks: Uint8Array[]): boolean {
  for (const chunk of chunks) {
    const decoded = decodeCommsBinaryMessage(chunk)
    if (!decoded) continue
    // AUTH_RES / RES only. AUTH_CRDT (7) and ongoing CUSTOM_EVENT are the
    // play hot path — treating them as join-critical logged every packet and
    // stalled the debug panel / main thread (auth-server combat rooms).
    if (decoded.messageType === 9 || decoded.messageType === 3 || decoded.messageType === 8) {
      return true
    }
  }
  return false
}

function noteSendBinaryInbound(chunks: Uint8Array[]): void {
  if (!chunks.length) return
  sendBinaryInboundLogCount++
  const important = inboundHasRoomReadyTypes(chunks)
  if (!important && sendBinaryInboundLogCount > 8 && sendBinaryInboundLogCount % 30 !== 0) {
    return
  }
  const types = new Map<string, number>()
  const senders = new Set<string>()
  const events: string[] = []
  for (const chunk of chunks) {
    const decoded = decodeCommsBinaryMessage(chunk)
    if (!decoded) {
      types.set('bad', (types.get('bad') ?? 0) + 1)
      continue
    }
    senders.add(decoded.sender || '(empty)')
    const name =
      decoded.messageType === 6
        ? `CUSTOM:${peekCustomEventName(decoded.payload)}`
        : decoded.messageType === 9
          ? 'AUTH_RES'
          : decoded.messageType === 7
            ? 'AUTH_CRDT'
            : `t${decoded.messageType}`
    types.set(name, (types.get(name) ?? 0) + 1)
    if (decoded.messageType === 6 && events.length < 8) {
      events.push(peekCustomEventName(decoded.payload))
    }
  }
  const typeNote = [...types.entries()].map(([k, v]) => `${k}×${v}`).join(' ')
  workerLog(
    'warn',
    `[sceneWorker] sendBinary inbound n=${chunks.length} ${typeNote} ` +
      `from=[${[...senders].slice(0, 4).join(',')}] events=[${events.join(',')}]`
  )
}

function resCrdtFirst(chunks: Uint8Array[]): Uint8Array[] {
  const res: Uint8Array[] = []
  const rest: Uint8Array[] = []
  for (const chunk of chunks) {
    const decoded = decodeCommsBinaryMessage(chunk)
    if (decoded && isResCrdtStateType(decoded.messageType)) res.push(chunk)
    else rest.push(chunk)
  }
  return res.length ? [...res, ...rest] : chunks
}

function mergeSendBinaryResponse(body: SendBinaryResponse): SendBinaryResponse {
  // RealmInfo must exist before AUTH_RES is processed or isRoomReady never flips
  // (joinRoster stays queued → no team → Snow Drift look-ahead melt never starts).
  applyHostReservedSceneStore()
  // Explorer: drain the inbound queue as-is (Bevy sendBinary → recv_binary).
  // RES-first is order only so snapshot sets isRoomReady before same-batch CRDT.
  const merged = resCrdtFirst(
    dropObsoleteAuthSnapshots(
      isolateSendBinaryInbound([...(body.data ?? []), ...takeBufferedSendBinaryInbound()])
    )
  )
  noteSendBinaryInbound(merged)
  return { data: merged }
}

function chunkHasBytes(chunk: unknown): boolean {
  if (!chunk) return false
  if (chunk instanceof Uint8Array) return chunk.byteLength > 0
  if (chunk instanceof ArrayBuffer) return chunk.byteLength > 0
  if (typeof (chunk as { byteLength?: number }).byteLength === 'number') {
    return ((chunk as { byteLength: number }).byteLength || 0) > 0
  }
  return false
}

function sendBinaryBodyHasOutbound(body: SendBinaryRequest): boolean {
  if (Array.isArray(body.data) && body.data.some(chunkHasBytes)) return true
  if (!Array.isArray(body.data) && chunkHasBytes(body.data)) return true
  for (const entry of body.peerData ?? []) {
    if (Array.isArray(entry.data) && entry.data.some(chunkHasBytes)) return true
  }
  return false
}

/**
 * Phase 0.5i — hybrid sendBinary (hardened 0.5g).
 *
 * SDK network transport is first every eng.update and always `await sendBinary`, even when
 * peerData is empty (Genesis xsend=n:0). Blocking that hop made postDump 80–120ms steady
 * and multi-second freezes when main could not answer.
 *
 * History:
 * - 0.5e fire-and-forget every frame → ~60 posts/s main thrash → 11–17 FPS
 * - 0.5f coalesce pure-async → sync weird + ~5 FPS
 * - 0.5g hybrid empty-fast / outbound-await (reverted with e–f before clean A/B)
 * - 0.5h main empty = drain only (kept; worker still awaited)
 *
 * 0.5i:
 * - **Empty**: never await RTT; resolve with buffered inbound; optional ≤20Hz empty poll
 *   (one in-flight) so queue still drains without flooding main.
 * - **Real outbound**: await main (correct multiplayer publish + drain).
 * - Stuck-flight watchdog clears empty inFlight if response lost (>2s).
 * 0.5j:
 * - **Real outbound**: post to main and resolve immediately (stash inbound on response).
 *   Awaiting main queued behind PhysX cooks / crdt-apply (Snow Drift ~11 FPS, postDump 100–270ms).
 * 0.5k:
 * - **Inbound push**: main posts `comms-inbound-push` on LiveKit arrival. Empty sendBinary
 *   returns that stash (no 50ms poll). AUTH_CRDT reaches AZ the same eng.update as Explorer.
 */
function stashSendBinaryInbound(chunks: Uint8Array[] | undefined): void {
  if (!chunks?.length) return
  for (const chunk of chunks) {
    if (chunk.byteLength) pendingInboundBinaries.push(chunk)
  }
}

function rpcSendBinary(body: SendBinaryRequest): Promise<SendBinaryResponse> {
  if (sendBinaryBodyHasOutbound(body)) {
    // Publish on main without stalling eng.update. Awaiting the RPC waited on the
    // main-thread queue (PhysX cooks / crdt-apply) — Snow Drift paintTick was
    // postDump 100–270ms and ~11 FPS even after LiveKit publish was async.
    noteSendBinaryPath('async')
    const id = ++requestId
    pendingSendBinary.set(id, (response) => {
      stashSendBinaryInbound(response.data)
    })
    ctx.postMessage({ type: 'comms-send-binary', id, body } satisfies SceneWorkerOutbound)
    return Promise.resolve(mergeSendBinaryResponse({ data: takeBufferedSendBinaryInbound() }))
  }

  // Empty: official SDK still awaits sendBinary then __processMessages(response).
  // Inbound arrives via comms-inbound-push (not a 50ms main poll).
  const buffered = takeBufferedSendBinaryInbound()
  if (buffered.length) {
    noteSendBinaryPath('fast')
    return Promise.resolve(mergeSendBinaryResponse({ data: buffered }))
  }
  noteSendBinaryPath('fast')
  return Promise.resolve({ data: [] })
}

function rpcGetUserData(): Promise<UserDataResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingUserData.set(id, (body) => {
      if (body.data?.userId) {
        lastUserData = body.data
        applyHostReservedSceneStore()
      }
      resolve(body)
    })
    ctx.postMessage({ type: 'get-user-data', id } satisfies SceneWorkerOutbound)
  })
}

function rpcGetRealm(): Promise<RealmResponse> {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingRealm.set(id, (body) => {
      if (body.realmInfo) {
        cacheHostReserved({
          realmInfo: {
            baseUrl: body.realmInfo.baseUrl || '',
            realmName: body.realmInfo.realmName || '',
            networkId: body.realmInfo.networkId,
            commsAdapter: body.realmInfo.commsAdapter || '',
            isPreview: body.realmInfo.isPreview === true,
            room: body.realmInfo.room,
            isConnectedSceneRoom: body.realmInfo.isConnectedSceneRoom === true
          }
        })
        applyHostReservedSceneStore()
      }
      resolve(body)
    })
    ctx.postMessage({ type: 'get-realm', id } satisfies SceneWorkerOutbound)
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
  // Visible in worker console + main [sceneWorker] if mirrored — proves scene called ADR SignedFetch.
  try {
    const u = typeof body?.url === 'string' ? body.url : ''
    workerLog(
      'log',
      `[SignedFetch] worker→main ${body?.init?.method ?? 'GET'} ${u.slice(0, 120)}`
    )
  } catch {
    /* ignore */
  }
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
  sceneTickIntervalMs = SCENE_LOOP_POLL_MS
  engineTickIntervalMs = SCENE_TICK_BOOT_INTERVAL_MS

  const rawOnUpdate = exports.onUpdate
  const sceneUpdate =
    rawOnUpdate &&
    (async (dt: number) => {
      try {
        await Promise.resolve(rawOnUpdate(dt))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (VIDEO_PLAYER_NULL_MUTABLE.test(message)) return
        throw err
      }
    })
  sceneOnUpdate = sceneUpdate ?? null
  workerLog(
    'log',
    `[sceneWorker] scene loop started — onUpdate=${sceneUpdate ? 'present' : 'absent'}, poll=${SCENE_LOOP_POLL_MS}ms engineTick=${engineTickIntervalMs}ms`
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

    if (
      isSceneEngineTickInFlight() &&
      getSceneEngineTickStartedAt() > 0 &&
      now - getSceneEngineTickStartedAt() > ENGINE_TICK_ABORT_MS + 500
    ) {
      forceRecoverStuckSceneEngineTick('heartbeat-stuck-engine-tick')
    }
    lastHeartbeatAt = now
    let realmConnected = '-'
    if (sceneEngine) {
      try {
        const RealmInfo = generated.RealmInfo(sceneEngine)
        const realm = RealmInfo.getOrNull(sceneEngine.RootEntity) as
          | { isConnectedSceneRoom?: boolean }
          | null
        realmConnected = realm?.isConnectedSceneRoom === true ? '1' : '0'
      } catch {
        realmConnected = '?'
      }
    }
    workerLog(
      'log',
      `[sceneWorker] heartbeat — tick=${heartbeatPass} sceneUpdateInFlight=${sceneUpdateInFlight} sceneUpdatePromiseActive=${sceneUpdatePromiseActive} pointerDeliveryInFlight=${pointerDeliveryInFlight} engineTickInFlight=${isSceneEngineTickInFlight()} pendingCrdt=${pendingCrdt.size} sceneEngine=${sceneEngine ? 'ok' : 'missing'} sceneTickIntervalMs=${sceneTickIntervalMs} realmConnected=${realmConnected}`
    )
    flushInboundGuestLwwApplyProof()
  }, 5000)

  const runCooperativeTick = (): void => {
    if (!sceneRunning) return
    const now = performance.now()

    drainQueuedSceneEngineTick()

    // Phase 2 — play mode engine ticks are main rAF-driven (play-frame-tick); hydration uses interval.
    const intervalDrivesEngineTick = sceneOnUpdatePaused || !playFrameTickMainDriven
    if (intervalDrivesEngineTick && !pointerBlocksEngineTick() && sceneEngineTickDue(now)) {
      requestSceneEngineTick({ source: 'hydrate' })
    }
  }

  cooperativeTickFn = runCooperativeTick
  if (sceneTickTimer) clearInterval(sceneTickTimer)
  sceneTickTimer = setInterval(runCooperativeTick, SCENE_LOOP_POLL_MS)
  runCooperativeTick()
  syncSceneEngineHydrationTimer()
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
  if (sceneEngine) registerWorkerTjsComponent(sceneEngine)
  drainPendingInjectPointer()
  if (!sceneEngine) {
    const message =
      '[sceneWorker] FATAL — sceneEngine null after onStart; pointer inject and engine.update(0) unavailable'
    workerLog('error', message)
    ctx.postMessage({ type: 'error', message } satisfies SceneWorkerOutbound)
    return
  }
  workerLog('log', '[sceneWorker] sceneEngine ok after onStart')
  applyHostReservedSceneStore()
  // Before the boot tick: plaza fetch-pages → Ztt → fishing init does Transform.get(PlayerEntity).
  ensureReservedEntityTransforms(sceneEngine)
  // Scene addUiRenderer/setUiRenderer virtual size wins over the live boot canvas.
  // Overwriting 1920×1080 with CSS px made react-ecs-ui-scale (fontSize*H) and host
  // Yoga (authored 1920) double-scale — plaza NICE CATCH title collapsed to ~8px.
  const authoredVirtual = getLastAuthoredVirtualCanvas()
  if (authoredVirtual) {
    seedWorkerUiCanvasInformation(sceneEngine, authoredVirtual.width, authoredVirtual.height)
  } else if (bootCanvas) {
    seedWorkerUiCanvasInformation(sceneEngine, bootCanvas.width, bootCanvas.height)
  }
  try {
    guardVideoPlayerGetMutable(sceneEngine)
  } catch (err) {
    workerLog(
      'warn',
      `[sceneWorker] VideoPlayer getMutable guard skipped — ${err instanceof Error ? err.message : String(err)}`
    )
  }
  try {
    if (installAdminToolsVideoPlayerAutoLink(sceneEngine)) {
      workerLog(
        'log',
        '[sceneWorker] AdminTools videoPlayers auto-link installed (empty list → discover VideoPlayers)'
      )
    }
  } catch (err) {
    workerLog(
      'warn',
      `[sceneWorker] AdminTools videoPlayers auto-link skipped — ${err instanceof Error ? err.message : String(err)}`
    )
  }
  try {
    installPointerEventColliderChecker(sceneEngine)
    workerLog('log', '[sceneWorker] pointerEventColliderChecker installed (post-onStart)')
    installVirtualCameraBindGuard(sceneEngine)
    ensureMainCameraOnCameraEntity(sceneEngine)
    installInputModifierLocomotionGuard(sceneEngine)
    installAvatarAttachCreateGuard(sceneEngine)
    workerLog(
      'log',
      '[sceneWorker] virtualCamera bind + AvatarAttach create guards installed (post-onStart)'
    )
    const g = globalThis as Record<string, unknown>
    g.__THREEJS_NOTE_SHIM_FLIGHT_TARGET__ = () => noteShimFlightTargetFromMove()
    g.__THREEJS_CLEAR_SHIM_FLIGHT_TARGET__ = () => clearShimFlightTarget()
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
  if (!hasWorkerReactEcsSync(sceneEngine)) {
    workerLog(
      'warn',
      '[sceneWorker] scene UI scheduler inactive — bundled engine system loop was not partitioned'
    )
  }
  bindSceneEngineScheduler(sceneEngine)
  installCrdtEncodeComponentMeters(sceneEngine)
  bindInboundGuestLwwHostForward(sceneEngine)
  // Explorer order: onStart only queues crdtGetState via transport.onmessage.
  // First engine.update receives those messages (Name/Transform/…) then runs systems.
  // SDK entry-points schedule main() as Infinity priority so it sees main.crdt entities.
  const sdkStartupOwnsMain = engineHasSdkStartupSystem(
    sceneEngine as { getSystems?: () => readonly { priority: number; name?: string }[] }
  )
  try {
    await runSceneEngineBootTick(sceneEngine)
    const postUpdateUi = collectWorkerUiEntityIds().length
    workerLog(
      'log',
      `[sceneWorker] post-onStart boot tick — UiTransform=${postUpdateUi} composite CRDT flushed` +
        (sdkStartupOwnsMain ? ' (SDK startup main ran this tick)' : '')
    )
  } catch (err) {
    workerLog(
      'error',
      `[sceneWorker] post-onStart boot tick failed — ${err instanceof Error ? err.message : String(err)}`
    )
  }
  await invokeSceneMainBootstrap(exports, { skipMain: sdkStartupOwnsMain })
  bindInboundGuestLwwHostForward(sceneEngine)
  // Scene main() often creates VC entities; ensure CameraEntity hosts MainCamera so systems that
  // gate on MainCamera.has(CameraEntity) can assign virtualCameraEntity on first tick.
  ensureMainCameraOnCameraEntity(sceneEngine)
  ensureReservedEntityTransforms(sceneEngine)

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
  workerLog('log', 'scene worker ready — onStart complete')
  // Prefer structured UI snapshot on ready — same authority as hydration attachUiMount.
  // Bare uiEntities without rows left main deferred (e.g. Planetangzaar mount=255, projection=1).
  const readyUiSnapshot =
    sceneEngine ? collectWorkerUiMountSnapshot(sceneEngine) : []
  const readyUiEntities = readyUiSnapshot.length
    ? extractSnapshotMountEntityIds(readyUiSnapshot)
    : collectWorkerUiEntityIds()
  if (readyUiEntities.length) lastOutboundUiEntitiesKey = readyUiEntities.join(',')
  if (readyUiEntities.length && readyUiSnapshot.length) {
    // Post snapshot as a CRDT-outbound before ready paint so serial queue can apply rows first.
    ctx.postMessage({
      type: 'crdt-outbound',
      data: new Uint8Array(0),
      uiEntities: readyUiEntities,
      uiMountSnapshot: readyUiSnapshot
    } satisfies SceneWorkerOutbound)
    workerLog(
      'log',
      `[sceneWorker] ready UI snapshot — mount=${readyUiEntities.length} rows=${readyUiSnapshot.length}`
    )
  }
  ctx.postMessage(
    readyUiEntities.length
      ? ({ type: 'ready', uiEntities: readyUiEntities } satisfies SceneWorkerOutbound)
      : ({ type: 'ready' } satisfies SceneWorkerOutbound)
  )
  syncSceneEngineHydrationTimer()
  startSceneLoop(exports).catch((err) =>
    workerLog(
      'error',
      `[sceneWorker] scene loop failed to start — ${err instanceof Error ? err.message : String(err)}`
    )
  )
}

async function handleMainToWorkerMessage(msg: MainToWorker): Promise<void> {
  if (msg.type === 'hold-scene-time-for-host-overlay') {
    setHostOverlayHoldsSceneTime(msg.held === true)
    workerLog(
      'log',
      `[sceneWorker] host overlay ${msg.held === true ? 'holds' : 'releases'} scene time`
    )
    return
  }
  if (msg.type === 'force-locomotion-clear') {
    if (sceneEngine) {
      const ok = forceUnfreezeModeOnlyFromMain(
        sceneEngine,
        msg.reason ?? 'main WASD/Space mode-freeze escape'
      )
      if (ok) {
        workerLog('log', `[sceneWorker] force-locomotion-clear — ${msg.reason ?? 'escape'}`)
      }
      // Escape from stuck VIEW SHOT / theater VirtualCamera (host suppress pairs with this).
      if (msg.reason?.includes('vc-clear') || msg.reason?.includes('escape-vc')) {
        try {
          const MainCamera = generated.MainCamera(sceneEngine)
          MainCamera.createOrReplace(sceneEngine.CameraEntity, {})
          workerLog('log', `[sceneWorker] force MainCamera clear — ${msg.reason}`)
        } catch (err) {
          workerLog(
            'warn',
            `[sceneWorker] force MainCamera clear failed — ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
    }
    return
  }
  if (msg.type === 'scene-play-ready') {
    cacheHostReserved(msg.reserved)
    applyHostReservedSceneStore()
    portableExperienceWorker = msg.portableExperience === true
    // Do NOT set playFrameTickMainDriven yet — World often notifies play-ready while main still
    // has bootPhaseActive (eval-done resolved, worker `ready` not processed). Switching to
    // main-driven ticks before the first play-frame-tick stops the hydration interval and
    // freezes SpaceRunner systems (InputModifier load-lock never clears).
    applyPlayReadyTiming(msg.performanceTier, 'scene-play-ready', {
      engineTickOverrideMs: msg.engineTickIntervalMs
    })
    workerLog(
      'log',
      `[sceneWorker] scene-play-ready — keep interval ticks until first play-frame-tick from main` +
        (portableExperienceWorker ? ' pe=1' : '')
    )
    // Kick one engine tick so load-freeze systems can see GltfContainerLoadingState FINISHED.
    if (sceneOnStartComplete && sceneEngine) {
      requestSceneEngineTick({ source: 'hydrate' })
    }
    return
  }
  if (msg.type === 'play-frame-tick') {
    if (!playFrameTickMainDriven) {
      playFrameTickMainDriven = true
      setSceneLoopOwnsPositiveDt(true)
      resetSceneEngineDiagCount()
      workerLog('log', '[sceneWorker] first play-frame-tick — main now drives engine ticks')
    }
    // Reserved poses + pointer first — same message as the tick so CameraFollow /
    // fishing bobber systems see live PE + PrimaryPointerInfo before engine.update.
    if (
      sceneEngine &&
      (msg.player ||
        msg.camera ||
        msg.primaryPointer ||
        msg.pointerLock !== undefined ||
        msg.avatarAttach?.length ||
        msg.tweenTransforms?.length)
    ) {
      applyPlayFrameReservedPoses(
        msg.player,
        msg.camera,
        msg.primaryPointer,
        msg.avatarAttach,
        msg.tweenTransforms,
        msg.pointerLock
      )
    }
    // Snap active PE-follow anchors even when UI holds engine.update (pointer select / menus).
    snapBoundPeFollowAnchorIfNearPlayer()
    // Reassert level keys every play frame so pollEvents cannot drop isPressed mid-hold
    // AND so isTriggered(PET_DOWN) edges fire every tick (Neurolink drone latches).
    reassertPressedKeysOnEngine()
    // COD B1: play-frame is the sole cooperative clock. Always request eng.update when
    // scene is not fully paused. pointerBlocksTick() only defers mid-inject — not sessions.
    // Do not gate on sceneUpdateInFlight (poll is outside eng.update flight).
    if (sceneEngine && !sceneOnUpdatePaused) {
      const tickReq = requestSceneEngineTick({ source: 'play-frame' })
      // Deferred = a tick is already running. PPI/camera were applied above — ack so
      // main keeps streaming play-frames (Explorer ~rAF). Holding done for 2s made
      // fishing bobber/line Tweens and cast→idle timers step in multi-second jumps.
      if (tickReq === 'idle' || tickReq === 'deferred') {
        ctx.postMessage({ type: 'play-frame-done' } satisfies SceneWorkerOutbound)
      }
      // If inject is mid-flight, request queues; still keep VC live poses hot.
      if (pointerDeliveryInFlight || pointerDeliverBatchOpen || pendingInjectPointer) {
        if (sceneOnStartComplete) {
          publishVcBindHydrateIfNeeded()
          publishVcPoseLiveIfBound()
        }
      }
    } else {
      ctx.postMessage({ type: 'play-frame-done' } satisfies SceneWorkerOutbound)
    }
    return
  }
  if (msg.type === 'request-vc-bind-hydrate') {
    requestVcBindHydrateFromMain()
    publishVcBindHydrateIfNeeded()
    return
  }
  if (msg.type === 'crdt-response') {
    pendingCrdt.get(msg.id)?.(msg.data)
    pendingCrdt.delete(msg.id)
    return
  }
  if (msg.type === 'crdt-outbound-ack') {
    resolveOutboundAck(msg.id)
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
  if (msg.type === 'teleport-to-response') {
    pendingTeleportTo.get(msg.id)?.(msg.body)
    pendingTeleportTo.delete(msg.id)
    return
  }
  if (msg.type === 'change-realm-response') {
    pendingChangeRealm.get(msg.id)?.(msg.body)
    pendingChangeRealm.delete(msg.id)
    return
  }
  if (msg.type === 'copy-to-clipboard-response') {
    pendingCopyToClipboard.get(msg.id)?.(msg.body)
    pendingCopyToClipboard.delete(msg.id)
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
  if (msg.type === 'open-nft-dialog-response') {
    pendingOpenNftDialog.get(msg.id)?.(msg.body)
    pendingOpenNftDialog.delete(msg.id)
    return
  }
  if (msg.type === 'set-camera-transform-response') {
    pendingSetCameraTransform.get(msg.id)?.(msg.body)
    pendingSetCameraTransform.delete(msg.id)
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
    if (msg.body.data?.userId) lastUserData = msg.body.data
    pendingUserData.get(msg.id)?.(msg.body)
    pendingUserData.delete(msg.id)
    applyHostReservedSceneStore()
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
  if (msg.type === 'comms-inbound-push') {
    stashSendBinaryInbound(msg.data)
    return
  }
  if (msg.type === 'comms-receive-binary') {
    // LiveKit body is craftCommsMessage: [messageType:u8][payload…]. Do not force CRDT —
    // auth-server types 4–9 (AUTH_RES, CUSTOM_EVENT, …) must reach BinaryMessageBus handlers.
    const unwrapped = unwrapCraftedCommsMessage(msg.data)
    if (unwrapped) {
      pendingInboundBinaries.push(
        encodeCommsBinaryMessage(msg.sender, unwrapped.messageType, unwrapped.payload)
      )
    }
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
  if (msg.type === 'renderer-inbound-deliver') {
    deliverRendererInboundGeneral(msg.data)
    return
  }
  if (msg.type === 'scene-input-snapshot') {
    executeSceneInputSnapshot(msg.body)
    return
  }
  if (msg.type === 'pump-scene-engine-tick') {
    // Held keys stay in the store; SceneLoop play-frame is the only positive-dt starter.
    reassertPressedKeysOnEngine()
    queueSceneEngineTick()
    return
  }
  if (msg.type !== 'boot') return

  try {
    sceneOnStartComplete = false
    sceneBootInProgress = true
    resetInboundGuestLwwForward()
    resetAuthResCoalesceClock()
    lastUserData = null
    lastRealmInfo = null
    cacheHostReserved(msg.reserved)
    playFrameTickMainDriven = false
    portableExperienceWorker = false
    resetSceneEngineScheduler()
    setHostOverlayHoldsSceneTime(msg.holdSceneTime === true)
    if (msg.holdSceneTime === true) {
      workerLog('log', '[sceneWorker] boot — host overlay holds scene time (dt=0 until overlay gone)')
    }
    resetWorkerUiFingerprint()
    resetLastAuthoredVirtualCanvas()
    pendingOutboundAck.clear()
    pendingBootPriority.length = 0
    debugSceneInputSnapshot = msg.debug?.sceneInputSnapshot === true
    debugPointerDeliver = msg.debug?.pointerDeliver === true
    resetWorkerInputSnapshotState()
    resetPendingSceneInput()
    workerSnapshotPressed = new Set()
    clearWorkerPointerButtonsHeld()
    resetPointerInputSession()
    pointerDeliverSerial = Promise.resolve()
    pointerDeliverWorkInFlight = false
    debugTweenDeliver = msg.debug?.tweenDeliver === true
    debugMessageArrival = msg.debug?.messageArrival === true
    debugSceneUiLog = msg.debug?.sceneUiLog === true
    // Only `?sceneloop` owns the per-tick walk-log. Other verbose flags used to
    // enable it too and printed ~120 lines/s (worker + main) on a busy plaza.
    debugSceneLoop = msg.debug?.sceneLoop === true
    sceneUiOutboundLogCount = 0
    deferredRendererInbound.length = 0
    installSceneWorkerFetchProxy()
    workerLog('log', '[sceneWorker] CRDT — round-trip during onStart only; outbound after onStart')
    const skipTheatre = msg.debug?.skipTheatre === true
    ;(globalThis as Record<string, unknown>).__THREEJS_SKIP_THEATRE__ = skipTheatre
    patchWorkerConsole()
    if (skipTheatre) {
      workerLog('log', '[sceneWorker] theatre skip enabled — runShowSetup + Scene 11/12 registration suppressed (?notheatre)')
    }
    workerLog('log', 'scene worker boot — console forwarding active')
    bootCrdtSnapshot = msg.scene.bootCrdtSnapshot
      ? {
          hasEntities: msg.scene.bootCrdtSnapshot.hasEntities,
          data: msg.scene.bootCrdtSnapshot.data.map((chunk) => chunk.slice())
        }
      : null
    bootCanvas =
      msg.canvas && msg.canvas.width > 0 && msg.canvas.height > 0
        ? { width: Math.floor(msg.canvas.width), height: Math.floor(msg.canvas.height) }
        : null

    let code: string
    const scriptSource = msg.scene.scriptBlobUrl ?? msg.scene.scriptUrl
    if (msg.scene.scriptBytes && msg.scene.scriptBytes.byteLength > 0) {
      code = new TextDecoder('utf-8').decode(msg.scene.scriptBytes)
      workerLog(
        'log',
        `[sceneWorker] using transferred script bytes (${(code.length / 1024).toFixed(0)} KB)`
      )
    } else if (msg.scene.scriptCode) {
      code = msg.scene.scriptCode
      workerLog(
        'log',
        `[sceneWorker] using inline script (${(code.length / 1024).toFixed(0)} KB)`
      )
    } else {
      workerLog(
        'log',
        `[sceneWorker] fetching script ${msg.scene.scriptBlobUrl ? 'from blob URL' : msg.scene.scriptUrl}`
      )
      const res = await fetch(scriptSource)
      if (!res.ok) throw new Error(`Script fetch ${res.status}`)
      code = await res.text()
      workerLog('log', `[sceneWorker] script fetched (${(code.length / 1024).toFixed(0)} KB)`)
    }

    const scriptKb = Math.round(code.length / 1024)
    const bootPhaseStarted = performance.now()
    const reportCompileProgress = (phase: string): void => {
      const elapsedMs = performance.now() - bootPhaseStarted
      ctx.postMessage({
        type: 'compile-progress',
        phase,
        elapsedMs,
        scriptKb
      } satisfies SceneWorkerOutbound)
      workerLog('log', `[sceneWorker] ${phase} (${(elapsedMs / 1000).toFixed(1)}s, ${scriptKb} KB)`)
    }
    reportCompileProgress('script ready — starting patch')

    engineApiEvents = createEngineApiEventState({
      onSubscribe: (eventId) => ctx.postMessage({ type: 'engine-api-subscribe', eventId } satisfies SceneWorkerOutbound),
      onUnsubscribe: (eventId) =>
        ctx.postMessage({ type: 'engine-api-unsubscribe', eventId } satisfies SceneWorkerOutbound)
    })

    const { requireMap } = createSystemStubs(msg.scene, {
      crdtSendToRenderer: rpcCrdt,
      crdtGetState: rpcGetState,
      movePlayerTo: rpcMovePlayerTo,
      teleportTo: rpcTeleportTo,
      changeRealm: rpcChangeRealm,
      copyToClipboard: rpcCopyToClipboard,
      triggerEmote: rpcTriggerEmote,
      triggerSceneEmote: rpcTriggerSceneEmote,
      openExternalUrl: rpcOpenExternalUrl,
      openNftDialog: rpcOpenNftDialog,
      setCameraTransform: rpcSetCameraTransform,
      commsSend: rpcCommsSend,
      comms: {
        setCommunicationsAdapter: rpcCommsAdapter,
        send: rpcCommsSend,
        sendBinary: rpcSendBinary,
        getUserData: rpcGetUserData,
        getRealm: rpcGetRealm,
        subscribeToTopic: rpcSubscribeTopic,
        unsubscribeFromTopic: rpcUnsubscribeTopic,
        publishData: rpcPublishData,
        consumeMessages: rpcConsumeMessages,
        getActiveVideoStreams: rpcGetActiveVideoStreams
      },
      signedFetch: rpcSignedFetch,
      signedFetchGetHeaders: rpcSignedFetchGetHeaders
    }, engineApiEvents)

    // Yield so priority inject/deliver messages posted during stub setup can run before bundle eval.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    // Allow the next bundle's first createReactBasedUiSystem to register (worker reuse).
    resetReactEcsOnceGuard()
    installPreregisterRendererComponentsHook()
    installCrdtTransportMeterHook()
    ;(globalThis as Record<string, unknown>).__THREEJS_WORKER_LOG__ = (message: string) => {
      workerLog('log', message)
    }
    installUiVirtualCanvasHook((width, height) => {
      if (sceneEngine) seedWorkerUiCanvasInformation(sceneEngine, width, height)
      workerLog('log', `[sceneWorker] ui virtual canvas ${width}×${height}`)
      ctx.postMessage({ type: 'ui-virtual-canvas', width, height } satisfies SceneWorkerOutbound)
    })
    const evalStarted = performance.now()
    const evalKb = (code.length / 1024).toFixed(0)
    const patchStarted = performance.now()
    reportCompileProgress(`patching scene bundle (${evalKb} KB)`)
    const logPatchStep = (step: string, ms: number) => {
      if (ms < 0) {
        // Step starting — critical for multi-MB bundles so we know which patch hung.
        workerLog('log', `[sceneWorker] patch — starting ${step}`)
        reportCompileProgress(`starting ${step}`)
        return
      }
      workerLog('log', `[sceneWorker] patch — ${step} ${ms.toFixed(0)}ms`)
      reportCompileProgress(`done ${step}`)
    }
    // One primary patch pass — do not pre-build checker strip (doubles work on 10MB+ worlds).
    const compositePatched = patchSceneBundle(code, logPatchStep)
    workerLog(
      'log',
      `[sceneWorker] bundle patch ready (${((performance.now() - patchStarted) / 1000).toFixed(2)}s)`
    )
    // Yield so main can paint progress and process heartbeats before the long new Function.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    reportCompileProgress('compiling scene bundle (new Function) — may take minutes for multi-MB scripts')
    // ADR-133 / Unity TweenPlugin / Bevy: kernel owns TweenSequence at renderer
    // framerate. Must be false *before* bundle eval — createTweenSystem reads it
    // at engine init. If unset, SDK Sequence hops on leftover COMPLETED and zips
    // multi-leg paths (plaza cast 15×~60ms).
    ;(globalThis as Record<string, unknown>).ENABLE_SDK_TWEEN_SEQUENCE = false
    sceneEvalInProgress = true
    // Heartbeat while compile runs — new Function is sync so we only tick around it.
    const compileHeartbeat = setInterval(() => {
      reportCompileProgress('still compiling new Function…')
    }, 5_000)
    let exports: ReturnType<typeof evaluateSceneBundle>
    const compileBundle = (source: string, label: string): ReturnType<typeof evaluateSceneBundle> | null => {
      try {
        reportCompileProgress(label)
        const result = evaluateSceneBundle(source, requireMap)
        workerLog('log', `[sceneWorker] ${label} — ok`)
        return result
      } catch (err) {
        workerLog(
          'warn',
          `[sceneWorker] ${label} failed — ${err instanceof Error ? err.message : String(err)}`
        )
        return null
      }
    }
    try {
      // Prefer patched; only fall back on failure (avoids 2–3× full compile of multi-MB deadsurg-scale bundles).
      let compiled = compileBundle(compositePatched, 'compiled capture-patched bundle')
      if (!compiled) {
        reportCompileProgress('compile fallback — original bundle')
        compiled = compileBundle(code, 'compiled original bundle')
      }
      if (!compiled) {
        reportCompileProgress('compile fallback — checker-stripped patch')
        const checkerPatched = patchSceneBundleWithCheckerStrip(code, logPatchStep)
        compiled = compileBundle(checkerPatched, 'compiled checker-patched bundle')
      }
      if (!compiled) {
        throw new Error('Scene bundle compile failed (original and patched sources are invalid)')
      }
      exports = compiled
    } finally {
      clearInterval(compileHeartbeat)
      sceneEvalInProgress = false
    }
    reportCompileProgress('bundle evaluated — posting eval-done')
    const timings = (exports as { __evalTimings?: { patchMs: number; compileMs: number; executeMs: number } })
      .__evalTimings
    workerLog(
      'log',
      `[sceneWorker] scene bundle evaluated (${((performance.now() - evalStarted) / 1000).toFixed(2)}s` +
        (timings
          ? ` — patch ${timings.patchMs.toFixed(0)}ms, compile ${timings.compileMs.toFixed(0)}ms, run ${timings.executeMs.toFixed(0)}ms`
          : '') +
        ')'
    )
    ctx.postMessage({ type: 'eval-done' } satisfies SceneWorkerOutbound)
    sceneEngine = resolveSceneEngine(exports)
    if (sceneEngine) registerWorkerTjsComponent(sceneEngine)
    bindSceneEngineScheduler(sceneEngine)
    if (sceneEngine) {
      ensureReservedEntityTransforms(sceneEngine)
      applyHostReservedSceneStore()
      try {
        preregisterRendererInjectedComponents(sceneEngine)
      } catch (err) {
        workerLog(
          'warn',
          `[sceneWorker] renderer component preregister skipped — ${err instanceof Error ? err.message : String(err)}`
        )
      }
      installCrdtEncodeComponentMeters(sceneEngine)
      bindInboundGuestLwwHostForward(sceneEngine)
      const engineId = (sceneEngine as { _id?: number })._id
      workerLog(
        'log',
        `[sceneWorker] sceneEngine bound after bundle eval${engineId != null ? ` (_id=${engineId})` : ''}`
      )
    } else {
      workerLog('warn', '[sceneWorker] sceneEngine not found after bundle eval — inject will queue until onStart')
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
  'crdt-outbound',
  'pointer-crdt-deliver',
  'tween-state-deliver',
  'renderer-inbound-deliver'
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
      // Apply deferred inbound without cooperative engine tick — tick would run react-ecs and
      // close menus before main finishes mount commit after pointer open.
      flushDeferredRendererInbound({ applyOnly: true })
      endPointerInputSessionAfterMountResume()
      resumeSceneTicksAfterPointer()
    }
    workerVerboseLog(
      debugPointerDeliver,
      'log',
      `[sceneWorker] scene ticks ${sceneTicksPaused ? 'paused' : 'resumed'}`
    )
    return
  }
  if (msg.type === 'pause-scene-onupdate') {
    const wasPaused = sceneOnUpdatePaused
    sceneOnUpdatePaused = msg.paused !== false
    if (sceneOnUpdatePaused && !wasPaused) resetSceneEngineDiagCount()
    syncSceneEngineHydrationTimer()
    workerLog(
      'log',
      `[sceneWorker] scene onUpdate ${sceneOnUpdatePaused ? 'paused (hydration)' : 'resumed'}`
    )
    if (!sceneOnUpdatePaused && wasPaused) completePlayFrameColdEgress()
    return
  }
  if (msg.type === 'inject-pointer-click') {
    const body = msg.body as InjectPointerClickBody
    const phase =
      body?.phase === 'up'
        ? 'up'
        : body?.phase === 'click'
          ? 'click'
          : body?.phase === 'hover-enter' || body?.phase === 'hover-leave'
            ? body.phase
            : 'down'
    // No-target = empty ray (Explorer level-state): not scene UI, not a PE mesh hit.
    const noTarget =
      !body?.sceneUi &&
      (body?.levelState === true ||
        body?.hitEntity === 0 ||
        body?.hitEntity === undefined)
    // Sync decision log BEFORE enqueue — proves the message hit the live worker bundle.
    workerLog(
      'warn',
      `[sceneWorker] inject RECEIVED e${body?.entity ?? '?'} sceneUi=${body?.sceneUi ? 1 : 0} ` +
        `levelState=${body?.levelState ? 1 : 0} phase=${phase} ` +
        `hitEntity=${body?.hitEntity ?? '∅'} noTarget=${noTarget ? 1 : 0} ` +
        `eng=${sceneEngine ? 1 : 0} onStart=${sceneOnStartComplete ? 1 : 0} meshWake=1`
    )
    try {
      enqueuePointerInject(body)
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

ctx.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  const msg = ev.reason instanceof Error ? ev.reason.message : String(ev.reason ?? '')
  if (!/Profile not initialized|Couldn't fetch profile data/i.test(msg)) return
  ev.preventDefault()
  workerLog('warn', `[sceneWorker] ${msg} (continuing)`)
})

// Non-priority messages (boot, crdt-response, RPC responses, …).
ctx.addEventListener(
  'message',
  (ev: MessageEvent<MainToWorker>) => {
    void dispatchMainToWorkerMessage(ev.data)
  },
  { capture: false }
)
