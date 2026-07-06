import type { SceneInputSnapshotBody } from '../../player/sceneInputSnapshot'

/**
 * Worker input session — while a pointer deliver batch is open, keyboard snapshots
 * coalesce to the latest level state and apply after pointer-deliver-done.
 * Main always posts snapshots; the worker owns ordering vs pointer inject.
 */
let pointerInputSessionDepth = 0
let coalescedKeyboardSnapshot: SceneInputSnapshotBody | null = null

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
}