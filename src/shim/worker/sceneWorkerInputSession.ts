import type { SceneInputSnapshotBody } from '../../player/sceneInputSnapshot'

/**
 * Worker input session — while a pointer deliver batch is open, keyboard snapshots
 * coalesce to the latest level state and apply after pointer-deliver-done.
 * Main always posts snapshots; the worker owns ordering vs pointer inject.
 */
let pointerInputSessionDepth = 0
let coalescedKeyboardSnapshot: SceneInputSnapshotBody | null = null
/** True during runSceneEnginePointerTick — react-ecs must run inside pointer phases 1/3. */
let pointerInteractiveTickActive = false
/**
 * Inject vs flush inside pointer interactive tick.
 * Inject: PET_DOWN/UP + handler onPress (allow locomotion writes).
 * Flush: fingerprint stability passes — react-ecs runs so handler state mounts before phase-4 egress.
 * Non-ui: post-phase engine.update after interactive flags would otherwise drop — keep unfreeze window.
 * Locomotion downgrade stays blocked outside the pointer batch via shouldAllowLocomotionClearDuringPointerTick.
 */
let pointerInteractivePhase: 'inject' | 'flush' | 'non-ui' | 'none' = 'none'
/** True while async pointer deliver work runs (inject → flush → deliver-done). */
let pointerDeliveryInFlightFlag = false

export function setPointerDeliveryInFlight(active: boolean): void {
  pointerDeliveryInFlightFlag = active
}

export function isPointerDeliveryInFlight(): boolean {
  return pointerDeliveryInFlightFlag
}

export function enterPointerInputSession(): void {
  pointerInputSessionDepth++
}

export function leavePointerInputSession(): SceneInputSnapshotBody | null {
  pointerInputSessionDepth = Math.max(0, pointerInputSessionDepth - 1)
  if (pointerInputSessionDepth > 0) return null
  const snap = coalescedKeyboardSnapshot
  coalescedKeyboardSnapshot = null
  return snap
}

export function isPointerInputSessionActive(): boolean {
  return pointerInputSessionDepth > 0
}

/** Latest level-state wins — snapshots are authoritative state, not edges. */
export function coalesceKeyboardSnapshotDuringPointerSession(body: SceneInputSnapshotBody): boolean {
  if (pointerInputSessionDepth <= 0) return false
  coalescedKeyboardSnapshot = body
  return true
}

export function resetPointerInputSession(): void {
  pointerInputSessionDepth = 0
  coalescedKeyboardSnapshot = null
  pointerInteractiveTickActive = false
  pointerInteractivePhase = 'none'
  pointerDeliveryInFlightFlag = false
}

export function setPointerInteractiveTickActive(active: boolean): void {
  pointerInteractiveTickActive = active
}

export function isPointerInteractiveTickActive(): boolean {
  return pointerInteractiveTickActive
}

export function setPointerInteractivePhase(phase: 'inject' | 'flush' | 'non-ui' | 'none'): void {
  pointerInteractivePhase = phase
}

export function isPointerInteractiveFlushPhase(): boolean {
  return pointerInteractiveTickActive && pointerInteractivePhase === 'flush'
}

/**
 * Intentional STOP clear only during pointer inject (onMouseDown).
 * Flush/non-ui must not clear — that is where accidental double-toggle / re-entrancy lands.
 */
export function shouldAllowLocomotionClearDuringPointerTick(): boolean {
  return pointerInteractivePhase === 'inject'
}

/**
 * Cooperative engine.update only — skip react-ecs while a pointer batch is open.
 * Pointer interactive tick sets pointerInteractiveTickActive so react-ecs still runs there.
 */
export function shouldSuppressCooperativeReactEcs(): boolean {
  if (pointerInteractiveTickActive) return false
  return pointerInputSessionDepth > 0
}