import type { PerformanceTier } from '../../shim/types'

/**
 * Live secondary workers inside Scene Distance warm band (not first-frame / tertiary).
 * Warm-all ≠ live-all: nearest N only (+ sticky demoted primary for walk-back if modest).
 * Large multi-parcel plazas still refuse live/sticky (see sceneWeight.ts).
 *
 * Middle tier targets ~6 concurrent muted neighbors; scale low/high around that.
 */
export function secondaryLiveCap(tier: PerformanceTier): number {
  if (tier === 'low') return 3
  if (tier === 'medium') return 6
  return 9 // high
}

/** Concurrent portable-experience workers. */
export function peLiveCap(tier: PerformanceTier): number {
  if (tier === 'low') return 1
  if (tier === 'medium') return 1
  return 2
}

/** Secondary onUpdate throttle — primary always every frame. */
export function secondaryTickIntervalMs(tier: PerformanceTier): number {
  if (tier === 'low') return 500
  if (tier === 'medium') return 250
  return 150
}

/**
 * PE must run every frame like a primary scene (drone InputModifier, entity remove, etc.).
 * Tier no longer throttles PE — only secondary live workers are duty-cycled.
 */
export function peTickIntervalMs(_tier: PerformanceTier): number {
  return 0
}
