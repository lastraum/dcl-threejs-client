/**
 * Phase D — host pose ownership modes (not a PE special case).
 * @see docs/SCENE_LAYERS_PLAN.md
 */
import type { PlayerHostClaims } from './PlayerClaimMerger'

/**
 * - host_feet: normal walk; host writes reserved Player/Camera to workers
 * - host_pin: load-gate / fall-reset pin (SpaceRunner) — only when claim requests pin semantics
 * - layer_drive: winning layer owns Player/Camera Transform (PE free-flight)
 */
export type HostPoseMode = 'host_feet' | 'host_pin' | 'layer_drive'

/**
 * Map continuous claims → pose mode.
 * disableAll alone does NOT imply host_pin — PE free-flight uses layer_drive.
 */
export function hostPoseModeFromClaims(claims: PlayerHostClaims): HostPoseMode {
  if (claims.poseDrive?.kind === 'pe') return 'layer_drive'
  // Primary freeze without PE poseDrive stays host_feet (PlayerSystem may pin via legacy disableAll)
  // Explicit host_pin is reserved for future load-gate claims.
  return 'host_feet'
}

export function hostPoseModeLabel(mode: HostPoseMode): string {
  switch (mode) {
    case 'layer_drive':
      return 'layer_drive (scene owns PE/Camera Transform)'
    case 'host_pin':
      return 'host_pin (capsule freeze pad)'
    default:
      return 'host_feet (avatar locomotion)'
  }
}
