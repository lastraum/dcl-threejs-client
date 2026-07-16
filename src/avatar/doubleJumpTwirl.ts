/**
 * Explorer-style hard-coded double-jump twirl — full 360° spin on avatar root Y.
 * Shared by DCL, VRM, and ODK locomotion (same visual language).
 * Direction is randomized per jump (CW or CCW).
 */
import type * as THREE from 'three'

/** Duration for one full revolution. */
export const DOUBLE_JUMP_TWIRL_DURATION_S = 0.68

/**
 * Yaw offset for twirl progress.
 * Three.js +Y is CCW (right-hand) → negative yaw is clockwise from above / behind.
 * @param direction +1 = CCW, −1 = CW
 */
export function doubleJumpTwirlYawOffset(
  elapsed: number,
  duration = DOUBLE_JUMP_TWIRL_DURATION_S,
  direction: 1 | -1 = -1
): { yawOffset: number; done: boolean } {
  const u = Math.min(1, Math.max(0, elapsed / duration))
  const eased = u * u * (3 - 2 * u)
  return {
    yawOffset: direction * eased * Math.PI * 2,
    done: u >= 1
  }
}

/** Mutable twirl state applied to an Object3D.rotation.y */
export class DoubleJumpTwirl {
  private elapsed = -1
  private baseYaw = 0
  /** −1 = clockwise (default Explorer-ish), +1 = counter-clockwise */
  private direction: 1 | -1 = -1
  private root: THREE.Object3D | null = null

  get active(): boolean {
    return this.elapsed >= 0
  }

  /** Start spin on `root` (avatar model under yaw pivot). Direction is random CW/CCW. */
  start(root: THREE.Object3D | null): void {
    if (!root) return
    this.root = root
    this.elapsed = 0
    this.baseYaw = root.rotation.y
    this.direction = Math.random() < 0.5 ? -1 : 1
  }

  /** Snap yaw back and clear. */
  reset(): void {
    if (this.root && this.elapsed >= 0) {
      this.root.rotation.y = this.baseYaw
    }
    this.elapsed = -1
    this.root = null
  }

  /**
   * Advance spin. Returns true while still twirling.
   * Call with grounded cancel: if landed mid-spin after a beat, `reset()`.
   */
  update(delta: number): boolean {
    if (this.elapsed < 0 || !this.root) return false
    this.elapsed += delta
    const { yawOffset, done } = doubleJumpTwirlYawOffset(
      this.elapsed,
      DOUBLE_JUMP_TWIRL_DURATION_S,
      this.direction
    )
    if (done) {
      this.root.rotation.y = this.baseYaw
      this.elapsed = -1
      this.root = null
      return false
    }
    this.root.rotation.y = this.baseYaw + yawOffset
    return true
  }
}
