import type { PerformanceTier } from '../../shim/types'
import { renderQuality } from '../../rendering/RenderQualitySettings'
import { skipAoiNeighbors } from '../../client/devFlags'

/**
 * Open-world residency (docs/OPEN_WORLD_RESIDENCY.md).
 * Compile defaults: shells + disc + live guests ON; promote OFF.
 * `?noaoi` still wins. URL: ?aoishells=0|1  ?aoidisc=0|1  ?aoilive=0|1  ?aoipromote=0|1
 */
const AOI_NEIGHBOR_SHELLS = true
const AOI_SCENE_DISTANCE_VISUALS = true
const AOI_LIVE_GUESTS = true
/** Walk never rebases origin / never handoff-promotes. */
const AOI_STAND_ON_PROMOTE = false

/**
 * Live JS workers (scripts + CRDT). Official desktop: ~10 m load + ~10 m extra
 * keep, 4 scene threads. Player → scene footprint (any parcel), not a ring.
 * Snow @ 14 m from plaza still enters. Scene Distance is the visual disc.
 */
const LIVE_SCENE_MAX_M = 20
const LIVE_SCENE_UNLOAD_EXTRA_M = 16
/** Concurrent live isolates — desktop uses 4 threads; Three.js is costlier. */
const AOI_LIVE_SECONDARY_HARD_CAP = 4
const TERTIARY_RESIDENT_HARD_CAP = 8

export const ROAD_PHYS_RADIUS_M = 48
export const EMPTY_LAND_PHYS_RADIUS_M = 48

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

/** @deprecated Prefer secondaryLiveEnterRadiusM — kept for call sites. */
export const SECONDARY_LIVE_ENTER_M = 16
export const SECONDARY_LIVE_KEEP_M = 80
export const SECONDARY_LIVE_SCENE_PROXIMITY_M = SECONDARY_LIVE_ENTER_M
export const SECONDARY_LIVE_MAX_RADIUS_M = SECONDARY_LIVE_ENTER_M

export function secondaryLiveEnterRadiusM(): number {
  if (!aoiLiveGuests()) return 0
  const d = visualWarmRadiusM()
  if (d <= 0) return 0
  return Math.min(d, LIVE_SCENE_MAX_M)
}

export function secondaryLiveKeepRadiusM(): number {
  if (!aoiLiveGuests()) return 0
  const enter = secondaryLiveEnterRadiusM()
  if (enter <= 0) return 0
  return enter + LIVE_SCENE_UNLOAD_EXTRA_M
}

export function secondaryLiveRadiusM(): number {
  return secondaryLiveEnterRadiusM()
}

/** After play-ready, start every live-band guest (desktop = 4 scene threads).
 *  Measure-only: do not lower without a stacked live-neighbor walk log of p5 < 30. */
export const SECONDARY_LIVE_BOOT_CONCURRENCY = 4

export function tertiaryResidentCap(_tier: PerformanceTier): number {
  return TERTIARY_RESIDENT_HARD_CAP
}

export function peLiveCap(tier: PerformanceTier): number {
  if (tier === 'low') return 1
  if (tier === 'medium') return 1
  return 2
}

/** Live guests are SceneLoop 20 Hz — never a 0 ms present pump. */
export function secondaryTickIntervalMs(_tier: PerformanceTier): number {
  return 50
}

/** PE workers are SceneLoop 20 Hz — never a 0 ms present pump. */
export function peTickIntervalMs(_tier: PerformanceTier): number {
  return 50
}
