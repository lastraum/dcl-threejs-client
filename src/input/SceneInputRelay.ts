import { clientDebugLog } from '../client/debug/ClientDebugLog'
import {
  buildSceneInputSnapshot,
  sceneInputSnapshotSignature,
  type SceneInputSnapshotBody
} from '../player/sceneInputSnapshot'
import { InputAction, type InputActionValue } from './pointerConstants'

/** @deprecated SceneInputRelay tracks keys directly — kept for PlayerSystem passthrough. */
export type SceneKeyboardSnapshot = {
  forward: boolean
  backward: boolean
  left: boolean
  right: boolean
  jump: boolean
  ctrl: boolean
  action3: boolean
  action4: boolean
  action5: boolean
  action6: boolean
}

type SceneInputRelayDeps = {
  isRelayBlocked: () => boolean
  /**
   * Avatar locomotion via main InputModifier — clear overlapping move keys on the player only.
   * Does **not** gate scene relay: the scene owns isPressed() and may drive a VC, a prop,
   * UI, or nothing. Client never invents “freeze + VC ⇒ drop WASD”.
   */
  isLocomotionBlocked?: () => boolean
  clearPlayerMoveKeys?: () => void
  /** Phase 2 — level keyboard state to worker (replaces per-edge inject-scene-input). */
  publishInputSnapshot: (body: SceneInputSnapshotBody) => void
  /** High-rate worker ticks while flight keys are held. */
  pumpWorkerTick?: () => void
  /** Drop VC live-lane LWW so final worker Transform CRDT can land. */
  onFlightKeysReleased?: () => void
}

/** Keys that drive creator VC flight — pump worker engine ticks while these are held. */
const FLIGHT_TICK_ACTIONS: ReadonlySet<InputActionValue> = new Set([
  InputAction.IA_FORWARD,
  InputAction.IA_BACKWARD,
  InputAction.IA_RIGHT,
  InputAction.IA_LEFT,
  InputAction.IA_JUMP,
  InputAction.IA_WALK,
  InputAction.IA_MODIFIER, // Shift — camera-operator descend (WALK_ACTION=14)
  InputAction.IA_PRIMARY,
  InputAction.IA_SECONDARY,
  InputAction.IA_ACTION_3,
  InputAction.IA_ACTION_4,
  InputAction.IA_ACTION_5,
  InputAction.IA_ACTION_6
])

/** Explorer parity — see `inputActionBinding.ts` + WASD arrows for flight. */
const CODE_TO_ACTIONS: ReadonlyArray<{ codes: readonly string[]; actions: readonly InputActionValue[] }> = [
  { codes: ['KeyW', 'ArrowUp'], actions: [InputAction.IA_FORWARD] },
  { codes: ['KeyS', 'ArrowDown'], actions: [InputAction.IA_BACKWARD] },
  { codes: ['KeyD', 'ArrowRight'], actions: [InputAction.IA_RIGHT] },
  { codes: ['KeyA', 'ArrowLeft'], actions: [InputAction.IA_LEFT] },
  { codes: ['Space'], actions: [InputAction.IA_JUMP] },
  { codes: ['ShiftLeft', 'ShiftRight'], actions: [InputAction.IA_MODIFIER] },
  { codes: ['ControlLeft', 'ControlRight'], actions: [InputAction.IA_WALK] },
  { codes: ['KeyE'], actions: [InputAction.IA_PRIMARY] },
  { codes: ['KeyF'], actions: [InputAction.IA_SECONDARY] },
  { codes: ['Digit1', 'Numpad1'], actions: [InputAction.IA_ACTION_3] },
  { codes: ['Digit2', 'Numpad2'], actions: [InputAction.IA_ACTION_4] },
  { codes: ['Digit3', 'Numpad3'], actions: [InputAction.IA_ACTION_5] },
  { codes: ['Digit4', 'Numpad4'], actions: [InputAction.IA_ACTION_6] }
]

const codeToActions = new Map<string, readonly InputActionValue[]>()
for (const entry of CODE_TO_ACTIONS) {
  for (const code of entry.codes) {
    codeToActions.set(code, entry.actions)
  }
}

/**
 * Tracks global keyboard state and publishes level snapshots to the scene worker.
 * Scenes read `inputSystem.isPressed()` in the worker — no main-thread PointerEventsResult relay.
 */
export class SceneInputRelay {
  private deps: SceneInputRelayDeps | null = null
  private readonly relayPressed = new Set<InputActionValue>()
  private readonly codeDownCount = new Map<string, number>()
  private tickNumber = 0
  private bound = false
  private lastFlightPumpMs = 0
  private lastSnapshotSig = ''
  private static readonly FLIGHT_PUMP_MS = 16

  bind(deps: SceneInputRelayDeps): void {
    this.unbindListeners()
    this.deps = deps
    this.relayPressed.clear()
    this.codeDownCount.clear()
    this.tickNumber = 0
    this.lastSnapshotSig = ''
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    window.addEventListener('blur', this.onWindowBlur)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    this.bound = true
  }

  dispose(): void {
    this.unbindListeners()
    this.deps = null
    this.relayPressed.clear()
    this.codeDownCount.clear()
  }

  private unbindListeners(): void {
    if (!this.bound) return
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    window.removeEventListener('blur', this.onWindowBlur)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.bound = false
  }

  /** Per-frame hook — republish snapshot + pump worker ticks while flight keys are held. */
  sync(tickNumber: number): void {
    if (!this.deps) return
    this.tickNumber = tickNumber
    if (this.deps.isRelayBlocked()) {
      this.releaseAll('blocked')
      return
    }

    this.reconcileHardwareKeys()
    // InputModifier freezes the avatar only — still relay keys so the scene can read isPressed.
    if (this.deps.isLocomotionBlocked?.()) {
      this.deps.clearPlayerMoveKeys?.()
    }
    if (this.relayPressed.size > 0) {
      this.publishSnapshotIfChanged()
    }

    if (!this.deps.pumpWorkerTick || !this.relayPressed.size) return
    let needsPump = false
    for (const action of this.relayPressed) {
      if (FLIGHT_TICK_ACTIONS.has(action)) {
        needsPump = true
        break
      }
    }
    if (!needsPump) return

    const now = performance.now()
    if (now - this.lastFlightPumpMs < SceneInputRelay.FLIGHT_PUMP_MS) return
    this.lastFlightPumpMs = now
    this.deps.pumpWorkerTick()
  }

  /** Drop relayed keys and publish empty snapshot to the worker. */
  releaseHeldKeys(reason: string): void {
    this.releaseAll(reason)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || !this.deps) return
    // Chat / text fields win — never preventDefault WASD into a focused input.
    if (this.deps.isRelayBlocked()) {
      this.releaseAll('blocked')
      this.deps.clearPlayerMoveKeys?.()
      return
    }

    const actions = codeToActions.get(e.code)
    if (!actions?.length) return

    const count = this.codeDownCount.get(e.code) ?? 0
    this.codeDownCount.set(e.code, count + 1)
    if (count > 0) return

    let changed = false
    for (const action of actions) {
      if (this.relayPressed.has(action)) continue
      this.relayPressed.add(action)
      changed = true
      clientDebugLog.log('input', `scene relay DOWN button=${action}`, { throttleMs: 80, alsoConsole: true })
    }
    if (changed) this.publishSnapshotIfChanged()

    if (actions.some((a) => isSceneRelayAction(a))) {
      e.preventDefault()
      if (this.deps.isLocomotionBlocked?.()) {
        this.deps.clearPlayerMoveKeys?.()
        e.stopPropagation()
      }
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.deps) return

    const actions = codeToActions.get(e.code)
    if (!actions?.length) return

    const count = this.codeDownCount.get(e.code) ?? 0
    const next = Math.max(0, count - 1)
    if (next > 0) {
      this.codeDownCount.set(e.code, next)
      return
    }
    this.codeDownCount.delete(e.code)

    let releasedFlight = false
    let changed = false
    for (const action of actions) {
      if (!this.relayPressed.has(action)) continue
      this.relayPressed.delete(action)
      changed = true
      if (FLIGHT_TICK_ACTIONS.has(action)) releasedFlight = true
      clientDebugLog.log('input', `scene relay UP button=${action}`, { throttleMs: 80, alsoConsole: true })
    }
    if (changed) {
      this.publishSnapshotIfChanged()
      if (releasedFlight && !this.relayPressed.size) this.deps.onFlightKeysReleased?.()
    }
  }

  private onWindowBlur = (): void => {
    this.releaseAll('blur')
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.releaseAll('hidden')
    }
  }

  private releaseAll(reason: string): void {
    const hadFlight = [...this.relayPressed].some((action) => FLIGHT_TICK_ACTIONS.has(action))
    const hadKeys = this.relayPressed.size > 0
    this.relayPressed.clear()
    this.codeDownCount.clear()
    this.publishSnapshotIfChanged()
    if (hadKeys) {
      clientDebugLog.log('input', `scene relay release — ${reason}`, { throttleMs: 500 })
    }
    if (hadFlight) this.deps?.onFlightKeysReleased?.()
  }

  private reconcileHardwareKeys(): void {
    let releasedFlight = false
    let changed = false
    for (const action of [...this.relayPressed]) {
      if (this.isActionPhysicallyDown(action)) continue
      this.relayPressed.delete(action)
      changed = true
      if (FLIGHT_TICK_ACTIONS.has(action)) releasedFlight = true
    }
    if (!changed) return
    this.publishSnapshotIfChanged()
    if (releasedFlight && !this.relayPressed.size) this.deps?.onFlightKeysReleased?.()
  }

  private isActionPhysicallyDown(action: InputActionValue): boolean {
    for (const [code, actions] of codeToActions) {
      if (!actions.includes(action)) continue
      if ((this.codeDownCount.get(code) ?? 0) > 0) return true
    }
    return false
  }

  private publishSnapshotIfChanged(): void {
    if (!this.deps) return
    const sig = sceneInputSnapshotSignature([...this.relayPressed])
    if (sig === this.lastSnapshotSig) return
    this.lastSnapshotSig = sig
    this.deps.publishInputSnapshot(buildSceneInputSnapshot(this.tickNumber, this.relayPressed))
  }
}

function isSceneRelayAction(action: InputActionValue): boolean {
  return (
    action === InputAction.IA_FORWARD ||
    action === InputAction.IA_BACKWARD ||
    action === InputAction.IA_LEFT ||
    action === InputAction.IA_RIGHT ||
    action === InputAction.IA_JUMP ||
    action === InputAction.IA_WALK ||
    action === InputAction.IA_MODIFIER ||
    action === InputAction.IA_PRIMARY ||
    action === InputAction.IA_SECONDARY ||
    action === InputAction.IA_ACTION_3 ||
    action === InputAction.IA_ACTION_4 ||
    action === InputAction.IA_ACTION_5 ||
    action === InputAction.IA_ACTION_6
  )
}