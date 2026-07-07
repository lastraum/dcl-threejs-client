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
}

export function setPointerInteractiveTickActive(active: boolean): void {
  pointerInteractiveTickActive = active
}

/**
 * Cooperative engine.update only — skip react-ecs while a pointer batch is open.
 * Pointer interactive tick sets pointerInteractiveTickActive so react-ecs still runs there.
 */
export function shouldSuppressCooperativeReactEcs(): boolean {
  if (pointerInteractiveTickActive) return false
  return pointerInputSessionDepth > 0
}