import type { PerformanceTier } from '../../shim/types'
import { renderQuality } from '../../rendering/RenderQualitySettings'

/**
 * Product multi-scene model (FocusOwner + LOD rings):
 * - **Primary** — FocusOwner (UI/audio/video/inputs)
 * - **Live secondaries** — muted workers, scripts every frame, scene-to-scene ≤16m, hard-capped
 * - **Tertiary residents** — scripts OFF + visual LOD when leave ring / under cap (never unload on demote)
 * - **Tertiary composites** — roads / empty / AOI shells over Scene Distance (no worker)
 *
 * Parcel count never refuses secondary boot or picks mode. Budget = radius + cap + serial boot.
 * Full contract: docs/MULTI_SCENE_CONTINUITY.md
 */
const AOI_LIVE_SECONDARIES_ONLY = true
/** Hard cap on concurrent muted live secondary workers (dense Genesis). */
const AOI_LIVE_SECONDARY_HARD_CAP = 3
/**
 * Max tertiary residents (scripts-off, meshes stay). Over cap → dispose farthest non-sticky.
 * Sticky demoted primaries never count against eviction of continuity-critical slots.
 */
const TERTIARY_RESIDENT_HARD_CAP = 8

/**
 * Road **PhysX** furniture only within this player radius (meters).
 * Visual roads still cover full Scene Distance — CCT doesn't need 200m of planters.
 */
export const ROAD_PHYS_RADIUS_M = 48

/**
 * Empty-land tree/rock **PhysX** boxes only within this player radius.
 * Visual scatter (trees/rocks/grass instancing) stays sticky across the warm band;
 * far props are decoration until you walk near them.
 */
export const EMPTY_LAND_PHYS_RADIUS_M = 48

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

/** Only one secondary full boot at a time — parallel 2MB workers thrash CBD promotes. */
export const SECONDARY_LIVE_BOOT_CONCURRENCY = 1

/**
 * Cap on scripts-off tertiary residents (mesh graphs retained after leave-ring / large demote).
 * Live secondary cap is separate — a slot in secondary mode does not count here.
 */
export function tertiaryResidentCap(_tier: PerformanceTier): number {
  return TERTIARY_RESIDENT_HARD_CAP
}

/** Concurrent portable-experience workers. */
export function peLiveCap(tier: PerformanceTier): number {
  if (tier === 'low') return 1
  if (tier === 'medium') return 1
  return 2
}

/**
 * Live secondary **scripts** cadence (Explorer under load drops scene tick rate).
 * High: every frame (dense CBD continuity). Medium/low: 30/20 Hz ambient — HOT
 * primary stays full rate; FocusOwner still mutes media/UI for secondaries.
 * @see SceneScriptSystem.applyFocusPolicy('secondary')
 * @see docs/WORKER_SYSTEM_PIE.md
 */
export function secondaryTickIntervalMs(tier: PerformanceTier): number {
  if (tier === 'low') return 50
  if (tier === 'medium') return 33
  return 0
}

/**
 * PE must run every frame like a primary scene (drone InputModifier, entity remove, etc.).
 */
export function peTickIntervalMs(_tier: PerformanceTier): number {
  return 0
}
