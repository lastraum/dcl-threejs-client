import type { LocomotionMode } from '../../player/locomotion'
import { DCL_LOCOMOTION_DEFAULTS } from '../../player/locomotion'

/**
 * Mixamo mp-* timeScale when moving at each DCL mode reference speed.
 * Tuned from genesis-games (1.0 walk @ 5 m/s, 1.35 jog @ 9 m/s) scaled to DCL 1.5 / 8 / 12 m/s.
 * Do not derive from hip keyframes — cyclic root motion path length is not travel speed.
 */
export const VRM_MODE_TIME_SCALE_AT_REF: Record<LocomotionMode, number> = {
  walk: 1.0,
  jog: 1.6,
  run: 1.85
}

const MODE_MIN_TIME_SCALE: Record<LocomotionMode, number> = {
  walk: 0.35,
  jog: 0.78,
  run: 1.05
}

const MODE_REF_SPEED: Record<LocomotionMode, number> = {
  walk: DCL_LOCOMOTION_DEFAULTS.walkSpeed,
  jog: DCL_LOCOMOTION_DEFAULTS.jogSpeed,
  run: DCL_LOCOMOTION_DEFAULTS.runSpeed
}

/** DCL-style ratio scaling with Mixamo calibration at full mode speed. */
export function vrmLocomotionTimeScale(mode: LocomotionMode, horizontalSpeed: number): number {
  if (horizontalSpeed < 0.05) return 1
  const ref = Math.max(MODE_REF_SPEED[mode], 0.001)
  const ratio = horizontalSpeed / ref
  const full = VRM_MODE_TIME_SCALE_AT_REF[mode]
  return Math.max(MODE_MIN_TIME_SCALE[mode], ratio * full)
}