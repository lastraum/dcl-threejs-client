import type { Entity } from '@dcl/ecs'
import type { PBPointerEventsResult } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/pointer_events_result.gen'
import type { RaycastHit } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/common/raycast_hit.gen'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import type { InjectSceneInputBody } from '../player/injectSceneInput'
import { InputAction, PointerEventType, type InputActionValue, type PointerEventTypeValue } from './pointerConstants'
import { nextPointerEventTimestamp } from './pointerEventTimestamp'

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
  ecs: MirrorComponents
  view: ProjectionView
  recordAppend: (componentId: number, entity: Entity, value: unknown) => void
  isRelayBlocked: () => boolean
  /** Scene InputModifier — avatar must not consume the same WASD keys. */
  isLocomotionBlocked?: () => boolean
  clearPlayerMoveKeys?: () => void
  injectToWorker: (body: InjectSceneInputBody) => void
}

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
 * Relays global keyboard state to the scene worker as PointerEventsResult on PlayerEntity.
 * Avatar locomotion blocking (InputModifier) is main-thread only — scenes still read
 * `inputSystem.isPressed()` for creator camera flight and similar systems.
 *
 * Uses capture-phase listeners so scene UI / avatar gates do not swallow WASD before relay.
 */
export class SceneInputRelay {
  private deps: SceneInputRelayDeps | null = null
  private readonly relayPressed = new Set<InputActionValue>()
  private readonly codeDownCount = new Map<string, number>()
  private tickNumber = 0
  private bound = false
  private lastHeartbeatMs = 0
  /** Re-assert held keys at display rate — 100ms caused ~10Hz creator camera steps. */
  private static readonly HEARTBEAT_MS = 16

  bind(deps: SceneInputRelayDeps): void {
    this.unbindListeners()
    this.deps = deps
    this.relayPressed.clear()
    this.codeDownCount.clear()
    this.tickNumber = 0
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
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
    this.bound = false
  }

  /** Re-assert held keys while creator camera flight is active (throttled — avoids inject spam). */
  sync(tickNumber: number): void {
    if (!this.deps || !this.relayPressed.size) return
    this.tickNumber = tickNumber

    if (this.deps.isRelayBlocked()) {
      this.releaseAll('blocked')
      return
    }

    if (this.deps.isLocomotionBlocked?.()) {
      this.deps.clearPlayerMoveKeys?.()
    }

    const now = performance.now()
    if (now - this.lastHeartbeatMs < SceneInputRelay.HEARTBEAT_MS) return
    this.lastHeartbeatMs = now

    for (const action of this.relayPressed) {
      this.emit(action, PointerEventType.PET_DOWN, true)
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || !this.deps) return
    if (this.deps.isRelayBlocked()) return

    const actions = codeToActions.get(e.code)
    if (!actions?.length) return

    const count = this.codeDownCount.get(e.code) ?? 0
    this.codeDownCount.set(e.code, count + 1)
    if (count > 0) return

    for (const action of actions) {
      if (this.relayPressed.has(action)) continue
      this.emit(action, PointerEventType.PET_DOWN, false)
      this.relayPressed.add(action)
    }

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

    for (const action of actions) {
      if (!this.relayPressed.has(action)) continue
      this.emit(action, PointerEventType.PET_UP, false)
      this.relayPressed.delete(action)
    }
  }

  private releaseAll(reason: string): void {
    if (!this.relayPressed.size) return
    for (const action of [...this.relayPressed]) {
      this.emit(action, PointerEventType.PET_UP, true)
    }
    this.relayPressed.clear()
    this.codeDownCount.clear()
    clientDebugLog.log('input', `scene relay release — ${reason}`, { throttleMs: 500 })
  }

  private emit(action: InputActionValue, state: PointerEventTypeValue, heartbeat: boolean): void {
    if (!this.deps) return
    const { ecs, view, recordAppend, injectToWorker } = this.deps
    const player = view.PlayerEntity
    const result: PBPointerEventsResult = {
      button: action,
      state,
      timestamp: nextPointerEventTimestamp(),
      tickNumber: this.tickNumber,
      hit: buildPlayerRelayHit(player),
      analog: undefined
    }
    ecs.PointerEventsResult.addValue(player, result)
    recordAppend(ecs.PointerEventsResult.componentId, player, result)
    injectToWorker({
      playerEntity: player as number,
      button: action,
      state,
      timestamp: result.timestamp,
      tickNumber: this.tickNumber
    })
    if (!heartbeat) {
      const line = `scene relay ${state === PointerEventType.PET_DOWN ? 'DOWN' : 'UP'} button=${action}`
      clientDebugLog.log('input', line, { throttleMs: 80, alsoConsole: true })
    }
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

function buildPlayerRelayHit(playerEntity: Entity): RaycastHit {
  return {
    entityId: playerEntity,
    position: { x: 0, y: 0, z: 0 },
    globalOrigin: undefined,
    direction: undefined,
    normalHit: { x: 0, y: 1, z: 0 },
    length: 0,
    meshName: ''
  }
}