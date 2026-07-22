import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import {
  isPointerInteractiveTickActive,
  shouldAllowLocomotionClearDuringPointerTick
} from './sceneWorkerInputSession'
import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import {
  stripComponentIdsFromCrdtBytes,
  WORKER_AUTHORITATIVE_COMPONENT_IDS
} from './workerSceneUiCrdtOutbound'

/**
 * Platform model (all layers — primary, PE, secondary):
 *
 * - Scene systems own InputModifier on PlayerEntity.
 * - Live IM is source of truth. Host observes freeze; does not invent freeze sources
 *   (no pointer-move vs scene taxonomy, no sticky STOP, no host re-freeze).
 * - Free-flight = live locomotion freeze → host pose / vc-pose-live may follow worker.
 * - Tick path is always cooperative requestSceneEngineTick (no MOVE CAMERA pump).
 */

/** Worker→main hot path — latest InputModifier + MainCamera without CRDT ack. */
export type PlayerFrameSnapshot = {
  frameId: number
  inputModifierHas: boolean
  inputModifier?: unknown
  mainCamera: unknown
}

let frameSeq = 0
let lastSnapshotKey = ''
/** Last observed frozen IM (egress observation only — never re-applied over live clear). */
let locomotionFreezeLatch: unknown | null = null
/** Scene wrote freeze via createOrReplace this inject. */
let freezeWrittenThisInject = false
/** Latch was set before this pointer inject started. */
let hadLatchAtInjectStart = false

type StandardMode = {
  disableAll?: boolean
  disableWalk?: boolean
  disableJog?: boolean
  disableRun?: boolean
}

function readStandardMode(value: unknown): StandardMode | null {
  if (!value || typeof value !== 'object') return null
  const root = value as {
    mode?: { $case?: string; standard?: StandardMode } & StandardMode
    $case?: string
    standard?: StandardMode
  }
  const mode = root.mode
  if (mode) {
    if (mode.$case === 'standard' && mode.standard) return mode.standard
    if (mode.standard) return mode.standard
  }
  if (root.$case === 'standard' && root.standard) return root.standard
  if (root.standard && typeof root.standard === 'object') return root.standard
  return null
}

function isLocomotionFrozenValue(value: unknown): boolean {
  const std = readStandardMode(value)
  if (!std) return false
  if (std.disableAll) return true
  return !!(std.disableWalk || std.disableJog || std.disableRun)
}

/** Sit/stool style: walk+jog+run off, not full lock-all (Flagtag lobby uses disableAll). */
function isModeOnlyLocomotionFreeze(value: unknown): boolean {
  const std = readStandardMode(value)
  if (!std || std.disableAll) return false
  return !!(std.disableWalk || std.disableJog || std.disableRun)
}

function intentionalUnfreezeWindow(): boolean {
  return isPointerInteractiveTickActive() && shouldAllowLocomotionClearDuringPointerTick()
}

function cloneJson<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

export const CLEARED_INPUT_MODIFIER = {
  mode: {
    $case: 'standard' as const,
    standard: {
      disableAll: false,
      disableWalk: false,
      disableJog: false,
      disableRun: false,
      disableJump: false,
      disableEmote: false,
      disableDoubleJump: false,
      disableGliding: false
    }
  }
}

const WORKER_LOG_KEY = '__THREEJS_WORKER_LOG__'

function workerLog(message: string): void {
  const log = (globalThis as Record<string, unknown>)[WORKER_LOG_KEY] as
    | ((message: string) => void)
    | undefined
  if (log) log(message)
  else console.log(message)
}

export function isWorkerLocomotionFreezeLatched(): boolean {
  return locomotionFreezeLatch !== null
}

/**
 * @deprecated Dual freeze taxonomy removed. Always false — kept so stale imports fail soft.
 * Prefer isWorkerSceneFreeFlightActive / live InputModifier.
 */
export function isWorkerMoveCameraFlightLatched(): boolean {
  return false
}

/**
 * Scene free-flight: live InputModifier freezes locomotion.
 * Same rule for primary, PE, secondary — layer kind is irrelevant.
 * Host pose claims / vc-pose-live follow this, not a latch source enum.
 */
export function isWorkerSceneFreeFlightActive(engine: IEngine | null | undefined): boolean {
  if (!engine) return locomotionFreezeLatch !== null
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const live = InputModifier.getOrNull(engine.PlayerEntity as Entity)
  if (live && isLocomotionFrozenValue(live)) return true
  return locomotionFreezeLatch !== null
}

/** @deprecated Source taxonomy removed — always null. */
export function getWorkerLocomotionFreezeLatchSource(): 'pointer-move' | 'scene' | null {
  return null
}

/** @deprecated Sticky STOP removed — scene owns freeze writes. */
export function isRefuseFreezeWrites(): boolean {
  return false
}

/**
 * Layer identity for diagnostics / future policy. Freeze path no longer branches on PE.
 */
export function setWorkerPortableExperienceMode(_isPe: boolean): void {
  /* no-op — free-flight is live IM freeze for every layer */
}

export function beginPointerPlayerFrameBatch(): void {
  freezeWrittenThisInject = false
  hadLatchAtInjectStart = locomotionFreezeLatch !== null
}

function freezeLatchPayloadKey(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function setLocomotionFreezeLatch(value: unknown): void {
  const next = cloneJson(value)
  const samePayload =
    locomotionFreezeLatch !== null &&
    freezeLatchPayloadKey(locomotionFreezeLatch) === freezeLatchPayloadKey(next)
  locomotionFreezeLatch = next
  if (!samePayload) lastSnapshotKey = ''
}

function clearLocomotionFreezeLatchState(): void {
  if (locomotionFreezeLatch === null) return
  locomotionFreezeLatch = null
  lastSnapshotKey = ''
}

/** Observe a freeze write from scene systems (any layer). */
export function noteWorkerLocomotionFreezeWrite(value: unknown): void {
  if (!isLocomotionFrozenValue(value)) return
  if (intentionalUnfreezeWindow()) freezeWrittenThisInject = true
  setLocomotionFreezeLatch(value)
}

/**
 * Observe a clear write. Scene always wins — host never blocks clear.
 * @returns true if clear must be blocked (always false under platform model)
 */
export function noteWorkerLocomotionClearWrite(): boolean {
  clearLocomotionFreezeLatchState()
  freezeWrittenThisInject = false
  return false
}

export function clearWorkerLocomotionFreezeLatch(): void {
  clearLocomotionFreezeLatchState()
}

/**
 * After pointer DOWN + engine.update(0): latch follows live IM only.
 * No STOP MOVE CAMERA / sit-toggle host force — scene handlers own that.
 */
export function reconcileLocomotionLatchAfterInjectDown(engine: IEngine): void {
  if (!intentionalUnfreezeWindow()) return
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const player = engine.PlayerEntity as Entity
  const live = InputModifier.getOrNull(player)
  if (live && isLocomotionFrozenValue(live)) {
    setLocomotionFreezeLatch(live)
    return
  }
  clearLocomotionFreezeLatchState()
  freezeWrittenThisInject = false
}

function forceUnfreeze(engine: IEngine, reason: string): void {
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const player = engine.PlayerEntity as Entity
  clearLocomotionFreezeLatchState()
  freezeWrittenThisInject = false
  InputModifier.createOrReplace(player, CLEARED_INPUT_MODIFIER as never)
  workerLog(`[input-modifier] force unfreeze — ${reason}`)
}

/**
 * Main-thread escape (WASD / Space) while sit/stool mode-freeze stuck without emote.
 * Does not clear disableAll freezes (lobby / free-flight).
 */
export function forceUnfreezeModeOnlyFromMain(engine: IEngine, reason: string): boolean {
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const player = engine.PlayerEntity as Entity
  const live = InputModifier.getOrNull(player)
  if (!live || !isLocomotionFrozenValue(live)) return false
  if (!isModeOnlyLocomotionFreeze(live)) return false
  forceUnfreeze(engine, reason)
  return true
}

/**
 * After host reports terminal GltfContainerLoadingState: release stuck disableAll load freezes.
 */
export function forceClearDisableAllAfterLoadGate(engine: IEngine, reason: string): boolean {
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const player = engine.PlayerEntity as Entity
  const live = InputModifier.getOrNull(player)
  const wasFrozen = !!(live && isLocomotionFrozenValue(live) && readStandardMode(live)?.disableAll)
  clearLocomotionFreezeLatchState()
  freezeWrittenThisInject = false
  lastSnapshotKey = ''

  if (wasFrozen) {
    try {
      InputModifier.deleteFrom(player)
    } catch {
      /* fall through */
    }
    if (InputModifier.has(player)) {
      const still = InputModifier.getOrNull(player)
      if (still && isLocomotionFrozenValue(still)) {
        InputModifier.createOrReplace(player, CLEARED_INPUT_MODIFIER as never)
      } else if (still && isLocomotionFrozenValue(still) === false) {
        try {
          InputModifier.deleteFrom(player)
        } catch {
          /* keep cleared put */
        }
      }
    }
    if (InputModifier.has(player) && isLocomotionFrozenValue(InputModifier.getOrNull(player))) {
      InputModifier.createOrReplace(player, CLEARED_INPUT_MODIFIER as never)
    }
  }

  const after = InputModifier.getOrNull(player)
  const stillFrozen = !!(after && isLocomotionFrozenValue(after))
  workerLog(
    `[input-modifier] load-gate clear disableAll — ${reason} wasFrozen=${wasFrozen} stillFrozen=${stillFrozen} has=${InputModifier.has(player)}`
  )
  return wasFrozen || stillFrozen
}

/**
 * Force player-frame with InputModifier cleared (has=false). Bypasses dedupe.
 */
export function takeForcedPlayerFrameClearSnapshot(engine: IEngine): PlayerFrameSnapshot {
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const MainCamera = generated.MainCamera(engine)
  const player = engine.PlayerEntity as Entity
  const camera = engine.CameraEntity as Entity
  clearLocomotionFreezeLatchState()
  freezeWrittenThisInject = false
  try {
    if (InputModifier.has(player)) InputModifier.deleteFrom(player)
  } catch {
    InputModifier.createOrReplace(player, CLEARED_INPUT_MODIFIER as never)
  }
  if (!MainCamera.has(camera)) {
    MainCamera.createOrReplace(camera, {})
  }
  const mainCamera = MainCamera.getOrNull(camera) ?? {}
  lastSnapshotKey = ''
  frameSeq++
  return {
    frameId: frameSeq,
    inputModifierHas: false,
    mainCamera: cloneJson(mainCamera)
  }
}

/**
 * Sync latch with live IM. Scene cleared → drop latch. Never re-apply host freeze over live clear.
 */
export function ensureWorkerLocomotionFreezePersisted(engine: IEngine): void {
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const player = engine.PlayerEntity as Entity
  const live = InputModifier.getOrNull(player)
  if (live && isLocomotionFrozenValue(live)) {
    setLocomotionFreezeLatch(live)
    return
  }
  if (locomotionFreezeLatch) {
    clearLocomotionFreezeLatchState()
  }
}

function stableSnapshotKey(inputModifierHas: boolean, inputModifier: unknown, mainCamera: unknown): string {
  try {
    return JSON.stringify({ inputModifierHas, inputModifier, mainCamera })
  } catch {
    return `${inputModifierHas}|${String(inputModifier)}|${String(mainCamera)}`
  }
}

export function resetPlayerFrameEgressBaseline(): void {
  lastSnapshotKey = ''
}

export function collectPlayerFrameSnapshot(engine: IEngine): PlayerFrameSnapshot | null {
  ensureWorkerLocomotionFreezePersisted(engine)
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const MainCamera = generated.MainCamera(engine)
  const player = engine.PlayerEntity as Entity
  const camera = engine.CameraEntity as Entity
  const liveModifier = InputModifier.getOrNull(player)
  const liveHas = InputModifier.has(player)

  if (liveHas && liveModifier && isLocomotionFrozenValue(liveModifier)) {
    setLocomotionFreezeLatch(liveModifier)
  } else if (locomotionFreezeLatch) {
    clearLocomotionFreezeLatchState()
  }

  const inputModifierHas = liveHas
  const inputModifier: unknown = liveModifier

  // Host shell so MainCamera.has(CameraEntity) is true for scene iso/top systems.
  if (!MainCamera.has(camera)) {
    MainCamera.createOrReplace(camera, {})
  }
  const mainCamera = MainCamera.getOrNull(camera) ?? {}
  const key = stableSnapshotKey(inputModifierHas, inputModifier, mainCamera)
  if (key === lastSnapshotKey) return null
  lastSnapshotKey = key
  frameSeq++
  const vc =
    (mainCamera as { virtualCameraEntity?: number | null } | null)?.virtualCameraEntity ?? null
  if (vc !== null && vc !== undefined) {
    workerLog(`[vc-lens] player-frame egress MainCamera → e${vc}`)
  }
  return {
    frameId: frameSeq,
    inputModifierHas,
    ...(inputModifierHas && inputModifier !== undefined ? { inputModifier: cloneJson(inputModifier) } : {}),
    mainCamera: cloneJson(mainCamera)
  }
}

export function stripPlayerFrameComponentsFromCrdt(data: Uint8Array): Uint8Array {
  return stripComponentIdsFromCrdtBytes(data, WORKER_AUTHORITATIVE_COMPONENT_IDS)
}

export function isPlayerFrameHotPathEnabled(isPlayMode: boolean): boolean {
  return isPlayMode
}

export function describeWorkerInputModifier(engine: IEngine): string {
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const live = InputModifier.getOrNull(engine.PlayerEntity as Entity)
  const has = InputModifier.has(engine.PlayerEntity as Entity)
  const std = readStandardMode(live)
  return (
    `imHas=${has} frozen=${isLocomotionFrozenValue(live)} latched=${locomotionFreezeLatch !== null} ` +
    `disableAll=${!!std?.disableAll} walk=${!!std?.disableWalk} jog=${!!std?.disableJog} run=${!!std?.disableRun} ` +
    `freezeThisInject=${freezeWrittenThisInject} hadLatch=${hadLatchAtInjectStart}`
  )
}
