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

/** Worker→main hot path — latest InputModifier + MainCamera without CRDT ack. */
export type PlayerFrameSnapshot = {
  frameId: number
  inputModifierHas: boolean
  inputModifier?: unknown
  mainCamera: unknown
}

let frameSeq = 0
let lastSnapshotKey = ''
/** Frozen IM for egress + re-apply when cooperative ticks wipe freeze. */
let locomotionFreezeLatch: unknown | null = null
/**
 * How the latch was established:
 * - pointer-move: captured on a pointer inject that wrote freeze (MOVE CAMERA path)
 * - scene: observed from live IM outside MOVE capture (menus / lock-all)
 *
 * Only pointer-move latches may be force-cleared as "STOP" on a later UI click.
 * Menu freezes must survive Sync / non-MOVE clicks.
 */
type LocomotionFreezeLatchSource = 'pointer-move' | 'scene'
let locomotionFreezeLatchSource: LocomotionFreezeLatchSource | null = null
/** Scene wrote freeze via createOrReplace this inject. */
let freezeWrittenThisInject = false
/** Latch was set before this pointer inject started. */
let hadLatchAtInjectStart = false
/** Latch source at inject start (for STOP vs menu distinction). */
let latchSourceAtInjectStart: LocomotionFreezeLatchSource | null = null
/**
 * After STOP force-unfreeze: scene may still have editFlightActive=true and re-freeze every tick.
 * Refuse freeze writes until a fresh MOVE inject (hadLatch=false) captures freeze again.
 */
let refuseFreezeWrites = false

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

function isLocomotionClearedValue(value: unknown): boolean {
  const std = readStandardMode(value)
  if (!std) return true
  if (std.disableAll) return false
  return !std.disableWalk && !std.disableJog && !std.disableRun
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

/** MOVE CAMERA edit-flight only (not menu lock-all / character-select freeze). */
export function isWorkerMoveCameraFlightLatched(): boolean {
  return locomotionFreezeLatch !== null && locomotionFreezeLatchSource === 'pointer-move'
}

export function getWorkerLocomotionFreezeLatchSource(): 'pointer-move' | 'scene' | null {
  return locomotionFreezeLatchSource
}

export function isRefuseFreezeWrites(): boolean {
  return refuseFreezeWrites
}

export function beginPointerPlayerFrameBatch(): void {
  freezeWrittenThisInject = false
  hadLatchAtInjectStart = locomotionFreezeLatch !== null
  latchSourceAtInjectStart = locomotionFreezeLatchSource
}

function freezeLatchPayloadKey(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Update latch payload/source. Only invalidates player-frame dedupe when something
 * actually changed — refreshing the same menu freeze every tick must NOT force a
 * player-frame post (that froze the client + flooded logs).
 */
function setLocomotionFreezeLatch(value: unknown, source: LocomotionFreezeLatchSource): void {
  const next = cloneJson(value)
  const sameSource = locomotionFreezeLatchSource === source
  const samePayload =
    locomotionFreezeLatch !== null &&
    freezeLatchPayloadKey(locomotionFreezeLatch) === freezeLatchPayloadKey(next)
  locomotionFreezeLatch = next
  locomotionFreezeLatchSource = source
  if (!sameSource || !samePayload) lastSnapshotKey = ''
}

function clearLocomotionFreezeLatchState(): void {
  if (locomotionFreezeLatch === null && locomotionFreezeLatchSource === null) return
  locomotionFreezeLatch = null
  locomotionFreezeLatchSource = null
  lastSnapshotKey = ''
}

export function noteWorkerLocomotionFreezeWrite(value: unknown): void {
  if (!isLocomotionFrozenValue(value)) return
  if (refuseFreezeWrites && !(intentionalUnfreezeWindow() && !hadLatchAtInjectStart)) {
    return
  }
  refuseFreezeWrites = false
  // During pointer inject:
  // - disableAll / full lock → MOVE CAMERA (or menu) flight path
  // - mode-only (walk/jog/run) → scene sit/stool content, NOT MOVE CAMERA
  // Outside inject → always scene.
  let source: LocomotionFreezeLatchSource = 'scene'
  if (intentionalUnfreezeWindow()) {
    freezeWrittenThisInject = true
    source = isModeOnlyLocomotionFreeze(value) ? 'scene' : 'pointer-move'
  }
  setLocomotionFreezeLatch(value, source)
}

/**
 * @returns true if clear must be blocked
 *
 * Latch sources:
 * - pointer-move (MOVE CAMERA): clear only via STOP inject; sticky refuse re-freeze.
 * - scene (Flagtag lobby, death freeze, menus): scene may clear anytime — do not
 *   permanently block createOrReplace(cleared) or Flagtag join stays frozen forever.
 */
export function noteWorkerLocomotionClearWrite(): boolean {
  // Same pointer inject wrote freeze then clear (double-toggle) — keep freeze.
  if (intentionalUnfreezeWindow() && freezeWrittenThisInject) {
    return true
  }

  const clearingMoveLatch =
    locomotionFreezeLatchSource === 'pointer-move' ||
    (intentionalUnfreezeWindow() && latchSourceAtInjectStart === 'pointer-move')

  if (intentionalUnfreezeWindow()) {
    clearLocomotionFreezeLatchState()
    freezeWrittenThisInject = false
    // Sticky refuse only after STOP MOVE CAMERA — not after menu/lobby unlock clicks.
    refuseFreezeWrites = clearingMoveLatch
    return false
  }

  // Outside pointer inject: only MOVE CAMERA latch is sticky.
  // Scene freezes (Flagtag disableAll until join) must be clearable by scene systems.
  if (locomotionFreezeLatchSource === 'pointer-move') {
    return true
  }

  if (locomotionFreezeLatch) {
    clearLocomotionFreezeLatchState()
    freezeWrittenThisInject = false
  }
  return false
}

export function clearWorkerLocomotionFreezeLatch(): void {
  if (intentionalUnfreezeWindow() && !freezeWrittenThisInject) {
    clearLocomotionFreezeLatchState()
    refuseFreezeWrites = true
  }
}

/**
 * After pointer DOWN + engine.update(0): reconcile latch from live IM.
 *
 * - Mode-only freeze (walk/jog/run) from sit/stool → scene latch; second click toggles OFF.
 * - disableAll / full freeze written this inject → MOVE CAMERA latch.
 * - Live freeze with no write this inject → menu/scene lock (or getMutable freeze).
 * - disableAll menu freezes never force-clear on random clicks.
 */
export function reconcileLocomotionLatchAfterInjectDown(engine: IEngine): void {
  if (!intentionalUnfreezeWindow()) return
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const player = engine.PlayerEntity as Entity
  const live = InputModifier.getOrNull(player)
  const liveFrozen = !!(live && isLocomotionFrozenValue(live))
  const moveLatchAtStart = latchSourceAtInjectStart === 'pointer-move'
  const sceneLatchAtStart =
    latchSourceAtInjectStart === 'scene' ||
    (hadLatchAtInjectStart && locomotionFreezeLatchSource === 'scene')

  if (liveFrozen) {
    // Handler wrote freeze this inject.
    if (freezeWrittenThisInject) {
      // Sit/stool: mode-only freeze from scene content — never treat as MOVE CAMERA.
      if (isModeOnlyLocomotionFreeze(live)) {
        refuseFreezeWrites = false
        setLocomotionFreezeLatch(live, 'scene')
        workerLog('[input-modifier] latch — scene mode-freeze (sit/stool) after inject DOWN')
        return
      }
      refuseFreezeWrites = false
      setLocomotionFreezeLatch(live, 'pointer-move')
      if (!hadLatchAtInjectStart || !moveLatchAtStart) {
        workerLog('[input-modifier] latch — MOVE freeze captured after inject DOWN')
        try {
          const note = (globalThis as Record<string, unknown>).__THREEJS_NOTE_SHIM_FLIGHT_TARGET__ as
            | (() => void)
            | undefined
          note?.()
        } catch {
          /* optional hook */
        }
      }
      return
    }

    // No freeze write this inject — live freeze is menu/scene lock-all / getMutable freeze.
    if (!hadLatchAtInjectStart) {
      setLocomotionFreezeLatch(live, 'scene')
      return
    }
    if (moveLatchAtStart) {
      // Click while MOVE-latched, live still frozen, no freeze write → STOP
      forceUnfreeze(engine, 'STOP inject while MOVE latched (live still frozen)')
      return
    }
    // Second click while already scene-mode-frozen (sit/stool): toggle OFF.
    // Scene systems often throw mid-handler (e.g. missing GltfContainer) and leave freeze
    // without playing the sit emote — player must not be stuck forever.
    if (sceneLatchAtStart && isModeOnlyLocomotionFreeze(live)) {
      forceUnfreeze(engine, 'STOP inject while scene mode-freeze latched (sit/stool toggle)')
      return
    }
    // disableAll / menu lock-all — keep latch; do not unlock on Sync / other UI.
    setLocomotionFreezeLatch(live, locomotionFreezeLatchSource ?? 'scene')
    return
  }

  // Live cleared after inject — only treat as STOP when the latch was MOVE CAMERA.
  if (hadLatchAtInjectStart || locomotionFreezeLatch) {
    if (!moveLatchAtStart && locomotionFreezeLatchSource !== 'pointer-move') {
      // Scene freeze cleared by scene (or never MOVE) — drop latch, no sticky refuse.
      if (!liveFrozen) {
        clearLocomotionFreezeLatchState()
        freezeWrittenThisInject = false
      }
      return
    }
    clearLocomotionFreezeLatchState()
    freezeWrittenThisInject = false
    refuseFreezeWrites = true
    workerLog('[input-modifier] latch cleared — STOP after inject DOWN')
    try {
      const clear = (globalThis as Record<string, unknown>).__THREEJS_CLEAR_SHIM_FLIGHT_TARGET__ as
        | (() => void)
        | undefined
      clear?.()
    } catch {
      /* optional */
    }
  }
}

function forceUnfreeze(engine: IEngine, reason: string): void {
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const player = engine.PlayerEntity as Entity
  clearLocomotionFreezeLatchState()
  freezeWrittenThisInject = false
  refuseFreezeWrites = true
  InputModifier.createOrReplace(player, CLEARED_INPUT_MODIFIER as never)
  workerLog(`[input-modifier] force unfreeze — ${reason}`)
  try {
    const clear = (globalThis as Record<string, unknown>).__THREEJS_CLEAR_SHIM_FLIGHT_TARGET__ as
      | (() => void)
      | undefined
    clear?.()
  } catch {
    /* optional */
  }
}

/**
 * Main-thread escape (WASD / Space) while sit/stool mode-freeze stuck without emote.
 * Does not clear disableAll menu freezes (Flagtag lobby).
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

/** Rewrite STOP MOVE CAMERA → MOVE CAMERA so phase-4 UI snapshot matches player release. */
export function rewriteStopMoveCameraUiLabels(engine: IEngine): number {
  preregisterRendererInjectedComponents(engine)
  // Lazy import path — avoid circular deps with resolveBundledUiComponents
  const UiText = generated.UiText(engine)
  let n = 0
  for (const [entity] of engine.getEntitiesWith(UiText)) {
    const t = UiText.getOrNull(entity as Entity)
    if (!t?.value) continue
    const v = t.value
    if (v.includes('STOP MOVE CAMERA')) {
      UiText.createOrReplace(entity as Entity, {
        ...t,
        value: v.replace(/STOP MOVE CAMERA/g, 'MOVE CAMERA')
      })
      n++
    }
  }
  return n
}

/** Re-apply latched freeze when cooperative ticks wipe IM — unless STOP sticky refuse. */
export function ensureWorkerLocomotionFreezePersisted(engine: IEngine): void {
  if (refuseFreezeWrites) {
    // Keep cleared while sticky unfreeze active (MOVE CAMERA STOP only).
    preregisterRendererInjectedComponents(engine)
    const InputModifier = generated.InputModifier(engine)
    const player = engine.PlayerEntity as Entity
    const live = InputModifier.getOrNull(player)
    if (live && isLocomotionFrozenValue(live)) {
      InputModifier.createOrReplace(player, CLEARED_INPUT_MODIFIER as never)
    }
    return
  }
  if (!locomotionFreezeLatch) return
  // Scene latches follow live IM — if the scene cleared freeze, drop latch (do not re-apply).
  if (locomotionFreezeLatchSource === 'scene') {
    preregisterRendererInjectedComponents(engine)
    const InputModifier = generated.InputModifier(engine)
    const player = engine.PlayerEntity as Entity
    const live = InputModifier.getOrNull(player)
    if (!live || isLocomotionClearedValue(live)) {
      clearLocomotionFreezeLatchState()
      return
    }
    // Still frozen live — refresh latch payload only.
    setLocomotionFreezeLatch(live, 'scene')
    return
  }
  if (intentionalUnfreezeWindow() && !freezeWrittenThisInject) return
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const player = engine.PlayerEntity as Entity
  const live = InputModifier.getOrNull(player)
  if (live && isLocomotionFrozenValue(live)) {
    // Keep prior source; same payload must not invalidate player-frame dedupe.
    setLocomotionFreezeLatch(live, locomotionFreezeLatchSource ?? 'scene')
    return
  }
  // MOVE CAMERA only: re-apply latched freeze if cooperative tick wiped it.
  InputModifier.createOrReplace(player, locomotionFreezeLatch as never)
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

  if (refuseFreezeWrites) {
    // Sticky unfreeze — never re-latch from live freeze
    if (liveHas && liveModifier && isLocomotionFrozenValue(liveModifier)) {
      InputModifier.createOrReplace(player, CLEARED_INPUT_MODIFIER as never)
    }
    clearLocomotionFreezeLatchState()
  } else if (liveHas && liveModifier && isLocomotionFrozenValue(liveModifier)) {
    // First observe as scene freeze unless already tagged pointer-move.
    setLocomotionFreezeLatch(
      liveModifier,
      locomotionFreezeLatchSource === 'pointer-move' ? 'pointer-move' : 'scene'
    )
  } else if (locomotionFreezeLatch) {
    const cleared = !liveHas || !liveModifier || isLocomotionClearedValue(liveModifier)
    if (cleared && intentionalUnfreezeWindow() && !freezeWrittenThisInject) {
      clearLocomotionFreezeLatchState()
      refuseFreezeWrites = true
    }
  }

  let inputModifierHas = liveHas
  let inputModifier: unknown = liveModifier
  if (locomotionFreezeLatch && !refuseFreezeWrites) {
    const liveFrozen = liveHas && liveModifier && isLocomotionFrozenValue(liveModifier)
    if (!liveFrozen) {
      // MOVE CAMERA only: re-apply if cooperative tick wiped freeze mid-flight.
      // Scene freezes (Flagtag lobby / round reset): if live is cleared, drop latch —
      // never force-freeze after the scene unlocks (was leaving respawn permanently stuck).
      if (locomotionFreezeLatchSource === 'pointer-move') {
        if (!(intentionalUnfreezeWindow() && !freezeWrittenThisInject)) {
          inputModifierHas = true
          inputModifier = locomotionFreezeLatch
        }
      } else {
        clearLocomotionFreezeLatchState()
      }
    }
  }
  if (refuseFreezeWrites) {
    inputModifierHas = true
    inputModifier = CLEARED_INPUT_MODIFIER
  }

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
    `freezeThisInject=${freezeWrittenThisInject} hadLatch=${hadLatchAtInjectStart} refuseFreeze=${refuseFreezeWrites}`
  )
}
