import type { PerformanceTier } from '../../shim/types'
import { renderQuality } from '../../rendering/RenderQualitySettings'

/**
 * TEMP (AOI load test on feat/aoi-focus-owner): live secondaries only, hard cap 3.
 * No tier scaling — keeps CBD from booting 6–9 full workers.
 */
const AOI_LIVE_SECONDARIES_ONLY = true
const AOI_LIVE_SECONDARY_HARD_CAP = 3

/**
 * Live secondary workers: nearest N inside a **live radius** (not full Scene Distance).
 * Warm + tertiary still use full Scene Distance. Live scripts are expensive.
 * Multi-parcel size is not a reject gate — concurrency + live radius are the budget.
 *
 * Middle tier targets ~6 concurrent muted neighbors; scale low/high around that.
 */
export function secondaryLiveCap(tier: PerformanceTier): number {
  if (AOI_LIVE_SECONDARIES_ONLY) return AOI_LIVE_SECONDARY_HARD_CAP
  if (tier === 'low') return 3
  if (tier === 'medium') return 6
  return 9 // high
}

/**
 * Max distance for live secondary workers (meters).
 * Clamped to Scene Distance; never farther than this even if Scene Distance is 200m.
 * Farther scenes still get warm (bytes) + tertiary visuals only.
 */
export const SECONDARY_LIVE_MAX_RADIUS_M = 64

export function secondaryLiveRadiusM(): number {
  const warm = renderQuality.getSceneLoadRadiusM()
  if (warm <= 0) return 0
  // Live band only — same hard radius even when Scene Distance is huge.
  return Math.min(warm, SECONDARY_LIVE_MAX_RADIUS_M)
}

/** When true, skip script-warm / tertiary; only live secondary workers. */
export function aoiLiveSecondariesOnly(): boolean {
  return AOI_LIVE_SECONDARIES_ONLY
}

/** Only one secondary full boot at a time — parallel 2MB workers thrash CBD promotes. */
export const SECONDARY_LIVE_BOOT_CONCURRENCY = 1

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
