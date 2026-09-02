import type { PerformanceTier } from '../../shim/types'
import { renderQuality } from '../../rendering/RenderQualitySettings'
import { skipAoiNeighbors } from '../../client/devFlags'

/**
 * Open-world residency (docs/OPEN_WORLD_RESIDENCY.md).
 * Compile defaults: shells + disc + live guests + stand-on promote ON.
 * `?noaoi` still wins. URL: ?aoishells=0|1  ?aoidisc=0|1  ?aoilive=0|1  ?aoipromote=0|1
 */
const AOI_NEIGHBOR_SHELLS = true
const AOI_SCENE_DISTANCE_VISUALS = true
const AOI_LIVE_GUESTS = true
/** Stand-on a live SDK7 footprint → in-world primary handoff (origin rebase). */
const AOI_STAND_ON_PROMOTE = true

/**
 * Live guests (secondary workers with scripts). Enter is a fraction of Scene
 * Distance (not the full visual disc); keep = hysteresis band. Ranking is
 * player→occupied-footprint (empty/road excluded).
 */
const LIVE_SCENE_UNLOAD_EXTRA_M = 16
/** Concurrent live guests — nearest occupied scenes in the inner ring only. */
const AOI_LIVE_SECONDARY_HARD_CAP = 4
const TERTIARY_RESIDENT_HARD_CAP = 16

export const ROAD_PHYS_RADIUS_M = 48
export const EMPTY_LAND_PHYS_RADIUS_M = 48
/**
 * Occupied-neighbor collision arm — enable/disable already-cooked hulls.
 * Visual shells may cook out to Scene Distance (~200 m) but stay disabled until
 * the player is within this ring. Walk out → disable (no destroy/recook).
 */
export const NEIGHBOR_SCENE_PHYS_COLLIDE_RADIUS_M = 64
/** Hysteresis past the collide ring before disabling (reduces edge flicker). */
export const NEIGHBOR_SCENE_PHYS_COLLIDE_KEEP_M = 72
/**
 * Occupied-scene PhysX (floors/walls / live guests / composite shells).
 * Live guests cook from the worker; SDK6/composite shells cook `_collider`
 * hulls from the attached GLB (CityTiles like JR Art are never live guests).
 */
export const LIVE_SCENE_PHYS_RADIUS_M = NEIGHBOR_SCENE_PHYS_COLLIDE_RADIUS_M

/** Shadow / env-caster / near-PhysX keep. Also the visual cliff while !aoiSceneDistanceVisuals(). */
export const AOI_SHELL_ENTER_M = 48
export const AOI_SHELL_KEEP_M = 80

export const COMPOSITE_MAX_RETAINED = 24

function urlFlag(name: string): boolean | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  if (!params.has(name)) return null
  const raw = (params.get(name) ?? '1').trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'off') return false
  return true
}

function urlBool(name: string, compileDefault: boolean): boolean {
  const override = urlFlag(name)
  return override === null ? compileDefault : override
}

export function aoiNeighborShells(): boolean {
  if (skipAoiNeighbors()) return false
  return urlBool('aoishells', AOI_NEIGHBOR_SHELLS)
}

export function aoiSceneDistanceVisuals(): boolean {
  if (skipAoiNeighbors()) return false
  return urlBool('aoidisc', AOI_SCENE_DISTANCE_VISUALS)
}

export function aoiLiveGuests(): boolean {
  if (skipAoiNeighbors()) return false
  return urlBool('aoilive', AOI_LIVE_GUESTS)
}

export function aoiStandOnPromote(): boolean {
  if (skipAoiNeighbors()) return false
  if (!aoiLiveGuests()) return false
  return urlBool('aoipromote', AOI_STAND_ON_PROMOTE)
}

/** Compat: true when live guests are off (old “shells-only / never promote” gate). */
export function aoiGlbShellsOnly(): boolean {
  return !aoiLiveGuests()
}

/** @deprecated Folded into aoiNeighborShells / aoiLiveGuests. Always false. */
export function aoiLiveSecondariesOnly(): boolean {
  return false
}

export function compositeMaxGltfsForDistance(distM: number, _parcelCount: number): number {
  const d = visualWarmRadiusM()
  if (d <= 0 || distM > d) return 0
  if (distM <= Math.min(48, d * 0.35)) return 24
  if (distM <= Math.min(120, d * 0.75)) return 8
  return 3
}

export function visualWarmRadiusM(): number {
  const pref = renderQuality.getSceneLoadRadiusM()
  if (pref <= 0) return 0
  if (!aoiSceneDistanceVisuals()) return Math.min(pref, AOI_SHELL_KEEP_M)
  return pref
}

export function secondaryLiveCap(tier: PerformanceTier): number {
  if (!aoiLiveGuests()) return 0
  if (tier === 'low') return 1
  if (tier === 'medium') return 2
  return AOI_LIVE_SECONDARY_HARD_CAP
}

/** Near band edge — same as composite shell near LOD (min(48, SD×0.35)). */
export function aoiNearBandRadiusM(): number {
  const d = visualWarmRadiusM()
  if (d <= 0) return 0
  return Math.min(48, d * 0.35)
}

/** @deprecated Prefer secondaryLiveEnterRadiusM — kept for call sites. */
export const SECONDARY_LIVE_ENTER_M = 16
export const SECONDARY_LIVE_KEEP_M = 80
export const SECONDARY_LIVE_SCENE_PROXIMITY_M = SECONDARY_LIVE_ENTER_M
export const SECONDARY_LIVE_MAX_RADIUS_M = SECONDARY_LIVE_ENTER_M

export function secondaryLiveEnterRadiusM(): number {
  if (!aoiLiveGuests()) return 0
  const d = renderQuality.getSceneLoadRadiusM()
  if (d <= 0) return 0
  return Math.min(d * 0.35, 22)
}

export function secondaryLiveKeepRadiusM(): number {
  if (!aoiLiveGuests()) return 0
  const d = renderQuality.getSceneLoadRadiusM()
  if (d <= 0) return 0
  const enter = secondaryLiveEnterRadiusM()
  if (enter <= 0) return 0
  return Math.min(d, Math.max(enter + LIVE_SCENE_UNLOAD_EXTRA_M, d * 0.6))
}

export function secondaryLiveRadiusM(): number {
  return secondaryLiveEnterRadiusM()
}

/** One cold boot at a time — stacked isolate soak guard. */
export const SECONDARY_LIVE_BOOT_CONCURRENCY = 1

export function tertiaryResidentCap(_tier: PerformanceTier): number {
  return TERTIARY_RESIDENT_HARD_CAP
}

export function peLiveCap(tier: PerformanceTier): number {
  if (tier === 'low') return 1
  if (tier === 'medium') return 1
  return 2
}

/**
 * Standing-in + one leftover mute secondary per send.
 * `?sceneloopfair=0` restores exclusive one-secondary slot.
 */
const SCENE_LOOP_FAIR_MUTE = true

export function sceneLoopFairMute(): boolean {
  if (skipAoiNeighbors()) return false
  return urlBool('sceneloopfair', SCENE_LOOP_FAIR_MUTE)
}

/** Live guests are SceneLoop 20 Hz — never a 0 ms present pump. */
export function secondaryTickIntervalMs(_tier: PerformanceTier): number {
  return 50
}

/**
 * Fallback pose-rebase interval when SceneLoop does not own the PE clock.
 * Occupied PE send due is 16 ms in PeSlotGuest — this must stay 50 (never 0).
 */
export function peTickIntervalMs(_tier: PerformanceTier): number {
  return 50
}
