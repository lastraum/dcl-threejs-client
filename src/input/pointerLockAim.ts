/**
 * Fixed screen aim while the WebGL canvas owns pointer lock.
 * Explorer-style: always the same place on the canvas (above center so it
 * sits over the avatar's head, not the torso) — not world-projected.
 *
 * Written by PlayerSystem from canvas rect; read by reticle + PointerEventsSystem.
 */

/** NDC Y: 0 = center, +1 = top. ~0.28 keeps reticle clearly above mid-screen. */
export const POINTER_LOCK_AIM_NDC_Y = 0.28

export type PointerLockAimState = {
  active: boolean
  /** CSS client coordinates for the reticle / UI hit tests. */
  clientX: number
  clientY: number
  /** Three.js NDC for raycasts (−1…1). */
  ndcX: number
  ndcY: number
}

export const pointerLockAim: PointerLockAimState = {
  active: false,
  clientX: 0,
  clientY: 0,
  ndcX: 0,
  ndcY: POINTER_LOCK_AIM_NDC_Y
}

export function clearPointerLockAim(): void {
  pointerLockAim.active = false
}

/** Place aim at fixed canvas NDC (center-x, elevated-y). */
export function setPointerLockAimFromCanvas(rect: DOMRectReadOnly): void {
  const ndcX = 0
  const ndcY = POINTER_LOCK_AIM_NDC_Y
  pointerLockAim.active = true
  pointerLockAim.ndcX = ndcX
  pointerLockAim.ndcY = ndcY
  pointerLockAim.clientX = rect.left + (ndcX * 0.5 + 0.5) * rect.width
  pointerLockAim.clientY = rect.top + (-ndcY * 0.5 + 0.5) * rect.height
}
