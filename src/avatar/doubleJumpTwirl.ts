/**
 * Explorer-style hard-coded double-jump twirl — full 360° spin on avatar root Y.
 * Shared by DCL, VRM, and ODK locomotion (same visual language).
 */
import type * as THREE from 'three'

/** Duration for one full revolution. */
export const DOUBLE_JUMP_TWIRL_DURATION_S = 0.68

/**
 * Clockwise yaw offset for twirl progress.
 * Three.js +Y is CCW (right-hand) → negative yaw is clockwise from above / behind.
 */
export function doubleJumpTwirlYawOffset(
  elapsed: number,
  duration = DOUBLE_JUMP_TWIRL_DURATION_S
): { yawOffset: number; done: boolean } {
  const u = Math.min(1, Math.max(0, elapsed / duration))
  const eased = u * u * (3 - 2 * u)
  return {
    yawOffset: -eased * Math.PI * 2,
    done: u >= 1
  }
}

/** Mutable twirl state applied to an Object3D.rotation.y */
export class DoubleJumpTwirl {
  private elapsed = -1
  private baseYaw = 0
  private root: THREE.Object3D | null = null

  get active(): boolean {
    return this.elapsed >= 0
  }

  /** Start spin on `root` (avatar model under yaw pivot). */
  start(root: THREE.Object3D | null): void {
    if (!root) return
    this.root = root
    this.elapsed = 0
    this.baseYaw = root.rotation.y
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
    const { yawOffset, done } = doubleJumpTwirlYawOffset(this.elapsed)
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
