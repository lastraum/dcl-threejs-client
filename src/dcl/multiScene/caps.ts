import type { PerformanceTier } from '../../shim/types'
import { renderQuality } from '../../rendering/RenderQualitySettings'

/**
 * Product multi-scene model (current shipping):
 * - **Primary only** — the scene you spawned into; FocusOwner; never promote/demote
 * - **Neighbors** — composite **GLB shells only** over Scene Distance (no workers)
 * - No live secondary workers, no stand-on handoff (perf: CBD thrash killed FPS)
 *
 * Full contract: docs/MULTI_SCENE_CONTINUITY.md
 */
/**
 * When true: single primary forever + composite GLB shells for neighbors.
 * No secondary workers, no promote/demote. Re-enable for continuity experiments.
 */
const AOI_GLB_SHELLS_ONLY = true
/** Legacy: composite shells without first-frame sample (still used when shells-only). */
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
 * Live secondary workers: nearest N by **player→scene** distance.
 * Warm + composite shells use full Scene Distance. Live scripts are expensive.
 */
export function secondaryLiveCap(tier: PerformanceTier): number {
  if (aoiGlbShellsOnly()) return 0
  if (AOI_LIVE_SECONDARIES_ONLY) return AOI_LIVE_SECONDARY_HARD_CAP
  if (tier === 'low') return 3
  if (tier === 'medium') return 6
  return 9 // high
}

/**
 * Boot / promote live secondary when **player** is within this distance of the
 * neighbor scene footprint (edge meters, scene-local).
 */
export const SECONDARY_LIVE_ENTER_M = 16

/**
 * Keep a live secondary (scripts on) until **player** is farther than this from
 * that scene's footprint. Beyond → tertiary (scripts off, meshes stay).
 */
export const SECONDARY_LIVE_KEEP_M = 80

/**
 * @deprecated use {@link SECONDARY_LIVE_ENTER_M} — historical scene-to-scene name.
 * Now means player enter radius.
 */
export const SECONDARY_LIVE_SCENE_PROXIMITY_M = SECONDARY_LIVE_ENTER_M

/** @deprecated use SECONDARY_LIVE_ENTER_M */
export const SECONDARY_LIVE_MAX_RADIUS_M = SECONDARY_LIVE_ENTER_M

/**
 * Player distance at which we **boot** a live secondary (or re-promote tertiary→secondary).
 * 0 when Scene Distance is 0 (AOI off).
 */
export function secondaryLiveEnterRadiusM(): number {
  if (aoiGlbShellsOnly()) return 0
  const warm = renderQuality.getSceneLoadRadiusM()
  if (warm <= 0) return 0
  return SECONDARY_LIVE_ENTER_M
}

/**
 * Player distance hysteresis — keep scripts on until this far from the secondary.
 * Clamped so keep ≥ enter. 0 when AOI off / GLB shells only.
 */
export function secondaryLiveKeepRadiusM(): number {
  if (aoiGlbShellsOnly()) return 0
  const warm = renderQuality.getSceneLoadRadiusM()
  if (warm <= 0) return 0
  return Math.max(SECONDARY_LIVE_ENTER_M, SECONDARY_LIVE_KEEP_M)
}

/**
 * @deprecated use {@link secondaryLiveEnterRadiusM} — was scene-adjacency; now enter radius.
 */
export function secondaryLiveRadiusM(): number {
  return secondaryLiveEnterRadiusM()
}

/**
 * When true: skip script-warm + first-frame sample; keep composite shells.
 * Live workers hard-capped (or zero under {@link aoiGlbShellsOnly}).
 */
export function aoiLiveSecondariesOnly(): boolean {
  return AOI_LIVE_SECONDARIES_ONLY || AOI_GLB_SHELLS_ONLY
}

/**
 * Single primary + neighbor **GLB shells only** — no secondary workers, no promote.
 * Default on for FPS; set false to restore enter/keep live secondary experiments.
 */
export function aoiGlbShellsOnly(): boolean {
  return AOI_GLB_SHELLS_ONLY
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
