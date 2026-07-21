import { clientDebugLog } from '../client/debug/ClientDebugLog'
import {
  buildSceneInputSnapshot,
  sceneInputSnapshotSignature,
  type SceneInputSnapshotBody
} from '../player/sceneInputSnapshot'
import { InputAction, type InputActionValue } from './pointerConstants'

/**
 * Single main-thread owner of scene keyboard hardware.
 *
 * Hardware → hub → N subscribers (primary scene worker, PE workers, …).
 * Avatar locomotion is a separate consumer (PlayerInput) gated by InputModifier;
 * freeze never means “drop keys for scenes”.
 */
export type InputHubSubscriber = {
  id: string
  /** Receive level-state snapshot (pressed set). */
  publish: (body: SceneInputSnapshotBody) => void
  /** High-rate worker tick while flight / freeze keys are held. */
  pumpWorkerTick?: () => void
  /**
   * When true, republish pressed snapshot every hub.sync even if unchanged
   * (PE drone: worker pollEvents can drop isPressed without reassert).
   */
  forceRepublish?: () => boolean
  /** All flight-class keys released — drop VC live lane etc. */
  onFlightKeysReleased?: () => void
}

/** Keys that drive creator VC flight / drone continuous onUpdate. */
export const FLIGHT_TICK_ACTIONS: ReadonlySet<InputActionValue> = new Set([
  InputAction.IA_FORWARD,
  InputAction.IA_BACKWARD,
  InputAction.IA_RIGHT,
  InputAction.IA_LEFT,
  InputAction.IA_JUMP,
  InputAction.IA_WALK,
  InputAction.IA_MODIFIER,
  InputAction.IA_PRIMARY,
  InputAction.IA_SECONDARY,
  InputAction.IA_ACTION_3,
  InputAction.IA_ACTION_4,
  InputAction.IA_ACTION_5,
  InputAction.IA_ACTION_6
])

/** Explorer parity — WASD / arrows / Space / Shift / Ctrl / E F / 1–4. */
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

function isSceneHubAction(action: InputActionValue): boolean {
  return FLIGHT_TICK_ACTIONS.has(action)
}

export type InputHubOptions = {
  /**
   * Global gate — chat / settings / primary text fields.
   * When true, hub releases all keys and does not publish.
   */
  isBlocked: () => boolean
  /**
   * Avatar locomotion frozen (InputModifier) — clear capsule keys only.
   * Does **not** stop broadcasting to scene/PE subscribers.
   */
  isLocomotionBlocked?: () => boolean
  clearPlayerMoveKeys?: () => void
}

/**
 * One InputHub per World. Own window listeners once; fan-out to scene + PE workers.
 */
export class InputHub {
  private readonly pressed = new Set<InputActionValue>()
  private readonly codeDownCount = new Map<string, number>()
  private readonly subscribers = new Map<string, InputHubSubscriber>()
  private opts: InputHubOptions | null = null
  private tickNumber = 0
  private listening = false
  private lastFlightPumpMs = 0
  /** Last published signature per subscriber (forceRepublish bypasses). */
  private readonly lastSigBySub = new Map<string, string>()
  private static readonly FLIGHT_PUMP_MS = 16

  /** Wire gates and start listening (idempotent). */
  start(opts: InputHubOptions): void {
    this.opts = opts
    if (this.listening) return
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    window.addEventListener('blur', this.onWindowBlur)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    this.listening = true
    console.info('[input-hub] started — single keyboard bus for scene + PE subscribers')
  }

  dispose(): void {
    if (this.listening) {
      window.removeEventListener('keydown', this.onKeyDown, true)
      window.removeEventListener('keyup', this.onKeyUp, true)
      window.removeEventListener('blur', this.onWindowBlur)
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
      this.listening = false
    }
    this.subscribers.clear()
    this.lastSigBySub.clear()
    this.pressed.clear()
    this.codeDownCount.clear()
    this.opts = null
  }

  /**
   * Register a consumer. Replaces any previous subscriber with the same id.
   * Returns unsubscribe.
   */
  subscribe(sub: InputHubSubscriber): () => void {
    this.subscribers.set(sub.id, sub)
    this.lastSigBySub.delete(sub.id)
    // Push current level state immediately so late PE wire isn't stuck empty until next edge.
    if (this.opts && !this.opts.isBlocked()) {
      this.publishToOne(sub, true)
    }
    clientDebugLog.log('input', `hub subscribe id=${sub.id} n=${this.subscribers.size}`, {
      alsoConsole: true,
      throttleMs: 0
    })
    return () => {
      if (this.subscribers.get(sub.id) === sub) {
        this.subscribers.delete(sub.id)
        this.lastSigBySub.delete(sub.id)
      }
    }
  }

  subscriberCount(): number {
    return this.subscribers.size
  }

  /** Current pressed actions (read-only view for debug / PlayerInput bridge). */
  getPressed(): ReadonlySet<InputActionValue> {
    return this.pressed
  }

  /**
   * Per-frame: reconcile hardware, clear avatar move keys if frozen, broadcast snapshots,
   * pump workers that need continuous ticks.
   */
  sync(tickNumber: number): void {
    if (!this.opts) return
    this.tickNumber = tickNumber
    if (this.opts.isBlocked()) {
      this.releaseAll('blocked')
      return
    }

    this.reconcileHardwareKeys()
    if (this.opts.isLocomotionBlocked?.()) {
      this.opts.clearPlayerMoveKeys?.()
    }

    for (const sub of this.subscribers.values()) {
      const force = !!sub.forceRepublish?.()
      if (this.pressed.size > 0 || force) {
        this.publishToOne(sub, force)
      }
    }

    this.pumpSubscribersIfNeeded()
  }

  /** Drop all held keys and publish empty snapshot to every subscriber. */
  releaseAll(reason: string): void {
    const hadFlight = [...this.pressed].some((a) => FLIGHT_TICK_ACTIONS.has(a))
    const hadKeys = this.pressed.size > 0
    this.pressed.clear()
    this.codeDownCount.clear()
    for (const sub of this.subscribers.values()) {
      this.publishToOne(sub, true)
      if (hadFlight) sub.onFlightKeysReleased?.()
    }
    if (hadKeys) {
      clientDebugLog.log('input', `hub release — ${reason}`, { throttleMs: 500, alsoConsole: true })
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || !this.opts) return
    if (this.opts.isBlocked()) {
      this.releaseAll('blocked')
      this.opts.clearPlayerMoveKeys?.()
      return
    }

    const actions = codeToActions.get(e.code)
    if (!actions?.length) return

    const count = this.codeDownCount.get(e.code) ?? 0
    this.codeDownCount.set(e.code, count + 1)
    if (count > 0) return

    let changed = false
    for (const action of actions) {
      if (this.pressed.has(action)) continue
      this.pressed.add(action)
      changed = true
      clientDebugLog.log('input', `hub DOWN button=${action}`, { throttleMs: 80, alsoConsole: true })
    }
    if (changed) {
      for (const sub of this.subscribers.values()) this.publishToOne(sub, false)
    }

    if (actions.some((a) => isSceneHubAction(a))) {
      e.preventDefault()
      if (this.opts.isLocomotionBlocked?.()) {
        this.opts.clearPlayerMoveKeys?.()
      }
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.opts) return
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
      if (!this.pressed.has(action)) continue
      this.pressed.delete(action)
      changed = true
      if (FLIGHT_TICK_ACTIONS.has(action)) releasedFlight = true
      clientDebugLog.log('input', `hub UP button=${action}`, { throttleMs: 80, alsoConsole: true })
    }
    if (!changed) return

    for (const sub of this.subscribers.values()) {
      this.publishToOne(sub, false)
      if (releasedFlight && !this.pressed.size) sub.onFlightKeysReleased?.()
    }
  }

  private onWindowBlur = (): void => {
    this.releaseAll('blur')
  }

  private onVisibilityChange = (): void => {
    this.releaseAll(document.visibilityState === 'hidden' ? 'hidden' : 'visible')
  }

  private reconcileHardwareKeys(): void {
    let releasedFlight = false
    let changed = false
    for (const action of [...this.pressed]) {
      if (this.isActionPhysicallyDown(action)) continue
      this.pressed.delete(action)
      changed = true
      if (FLIGHT_TICK_ACTIONS.has(action)) releasedFlight = true
    }
    if (!changed) return
    for (const sub of this.subscribers.values()) {
      this.publishToOne(sub, false)
      if (releasedFlight && !this.pressed.size) sub.onFlightKeysReleased?.()
    }
  }

  private isActionPhysicallyDown(action: InputActionValue): boolean {
    for (const [code, actions] of codeToActions) {
      if (!actions.includes(action)) continue
      if ((this.codeDownCount.get(code) ?? 0) > 0) return true
    }
    return false
  }

  private publishToOne(sub: InputHubSubscriber, force: boolean): void {
    const sig = sceneInputSnapshotSignature([...this.pressed])
    if (!force && sig === this.lastSigBySub.get(sub.id)) return
    this.lastSigBySub.set(sub.id, sig)
    sub.publish(buildSceneInputSnapshot(this.tickNumber, this.pressed))
  }

  private pumpSubscribersIfNeeded(): void {
    const now = performance.now()
    if (now - this.lastFlightPumpMs < InputHub.FLIGHT_PUMP_MS) return

    let anyPump = false
    for (const sub of this.subscribers.values()) {
      if (!sub.pumpWorkerTick) continue
      const force = !!sub.forceRepublish?.()
      if (this.pressed.size === 0 && !force) continue
      if (this.pressed.size > 0) {
        let flight = false
        for (const action of this.pressed) {
          if (FLIGHT_TICK_ACTIONS.has(action)) {
            flight = true
            break
          }
        }
        if (!flight && !force) continue
      }
      sub.pumpWorkerTick()
      anyPump = true
    }
    if (anyPump) this.lastFlightPumpMs = now
  }
}
