/**
 * Phase D — host pose ownership modes (not a PX special case).
 * @see docs/PORTABLE_EXPERIENCE_COD.md
 */
import type { PlayerHostClaims } from './PlayerClaimMerger'

/**
 * - host_feet: normal walk; host writes reserved Player/Camera to workers
 * - host_pin: load-gate / fall-reset pin (SpaceRunner) — claim/helper only
 * - layer_drive: winning layer owns Player/Camera Transform (PX free-flight)
 */
export type HostPoseMode = 'host_feet' | 'host_pin' | 'layer_drive'

/**
 * Map continuous claims → pose mode.
 * disableAll alone does NOT imply host_pin — PX free-flight uses layer_drive.
 */
export function hostPoseModeFromClaims(claims: PlayerHostClaims): HostPoseMode {
  if (claims.poseDrive?.kind === 'pe') return 'layer_drive'
  return 'host_feet'
}

export function hostPoseModeLabel(mode: HostPoseMode): string {
  switch (mode) {
    case 'layer_drive':
      return 'layer_drive (layer owns Player/Camera Transform)'
    case 'host_pin':
      return 'host_pin (capsule freeze pad)'
    default:
      return 'host_feet (avatar locomotion)'
  }
}
