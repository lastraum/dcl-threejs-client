import type { PerformanceTier } from '../../shim/types'
import { renderQuality } from '../../rendering/RenderQualitySettings'

/**
 * Product multi-scene model (FocusOwner + LOD rings):
 * - **Primary** — FocusOwner (UI/audio/video/inputs)
 * - **Live secondaries** — muted workers, scene-to-scene ≤16m, hard-capped
 * - **Tertiary** — roads / empty / composites (no worker) over Scene Distance
 *
 * Composite-first for plaza shells; live only for modest/nested neighbors.
 * Skip script-warm + first-frame sample thrash (those dual-boot CBD freezes).
 */
const AOI_LIVE_SECONDARIES_ONLY = true
/** Hard cap on concurrent muted live secondary workers (dense Genesis). */
const AOI_LIVE_SECONDARY_HARD_CAP = 3

/**
 * Road **PhysX** furniture only within this player radius (meters).
 * Visual roads still cover full Scene Distance — CCT doesn't need 200m of planters.
 */
export const ROAD_PHYS_RADIUS_M = 48

/** Max retained composite tertiary entities (LRU; multi-parcel shells preferred). */
export const COMPOSITE_MAX_RETAINED = 16

/**
 * Composite GLB budget by distance from player (scene-local meters).
 * Near = denser shell; far = silhouette only.
 */
export function compositeMaxGltfsForDistance(distM: number, parcelCount: number): number {
  const multi = parcelCount >= 16
  if (distM <= 32) return multi ? 80 : 40
  if (distM <= 64) return multi ? 48 : 24
  if (distM <= 100) return multi ? 24 : 12
  return multi ? 12 : 6
}

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
 * Live secondary eligibility: **scene-to-scene** footprint edge distance (meters).
 * Not player distance — nested hole scenes (Spring in plaza cutout) sit ~0m from
 * primary parcels and always qualify. Player frustum LOD is separate.
 * One parcel = 16m; 16m ≈ adjacent + same-parcel contact.
 */
export const SECONDARY_LIVE_SCENE_PROXIMITY_M = 16

/** @deprecated use SECONDARY_LIVE_SCENE_PROXIMITY_M — kept for call-site greps. */
export const SECONDARY_LIVE_MAX_RADIUS_M = SECONDARY_LIVE_SCENE_PROXIMITY_M

/**
 * Scene-adjacency band for live workers. Independent of player Scene Distance
 * (warm/composite still use Scene Distance). Returns 0 only if Scene Distance is 0
 * (AOI fully off).
 */
export function secondaryLiveRadiusM(): number {
  const warm = renderQuality.getSceneLoadRadiusM()
  if (warm <= 0) return 0
  return SECONDARY_LIVE_SCENE_PROXIMITY_M
}

/**
 * When true: skip script-warm + first-frame sample; keep composite tertiary for
 * multi-parcel neighbors (plaza ring around nested hole scenes). Live workers still
 * hard-capped. Full dual-worker plaza+nested thrash is what crashed CBD promotes.
 */
export function aoiLiveSecondariesOnly(): boolean {
  return AOI_LIVE_SECONDARIES_ONLY
}

/**
 * Auto-boot live workers only for modest neighbors (nested hole scenes, buildings).
 * Plaza-scale multi-parcel estates stay as composite meshes unless demoted sticky /
 * under-feet priority. Dual full plaza workers freeze the tab.
 */
export const SECONDARY_LIVE_AUTO_MAX_PARCELS = 16

/** Only one secondary full boot at a time — parallel 2MB workers thrash CBD promotes. */
export const SECONDARY_LIVE_BOOT_CONCURRENCY = 1

/** Concurrent portable-experience workers. */
export function peLiveCap(tier: PerformanceTier): number {
  if (tier === 'low') return 1
  if (tier === 'medium') return 1
  return 2
}

/**
 * Live secondary **scripts** run every frame (same as primary onUpdate rate).
 * FocusOwner still mutes video / audio / scene UI / privileged input for secondaries.
 * @see SceneScriptSystem.applyFocusPolicy('secondary')
 */
export function secondaryTickIntervalMs(_tier: PerformanceTier): number {
  return 0
}

/**
 * PE must run every frame like a primary scene (drone InputModifier, entity remove, etc.).
 */
export function peTickIntervalMs(_tier: PerformanceTier): number {
  return 0
}
