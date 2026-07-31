/**
 * Host pose ownership — host-owned input model.
 *
 * Product:
 * - host_feet: normal — WASD moves capsule; host injects Player/Camera to all workers
 * - host_pin: load-gate / fall-reset only (SpaceRunner), not PX free-flight
 *
 * There is NO "layer_drive". Scene code moves the player via movePlayerTo / forces;
 * host adopts that pose and rebroadcasts to workers.
 *
 * @see docs/PORTABLE_EXPERIENCE_COD.md
 */

export type HostPoseMode = 'host_feet' | 'host_pin'

export function hostPoseModeLabel(mode: HostPoseMode): string {
  switch (mode) {
    case 'host_pin':
      return 'host_pin (capsule freeze pad / load-gate)'
    default:
      return 'host_feet (WASD + host inject to all workers)'
  }
}
