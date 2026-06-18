/** DCL day/night constants (from SDK docs). */
export const SECONDS_PER_DAY = 86400
/** Noon — default skybox time (12:00). */
export const MIDDAY_SECONDS = 12 * 3600
/** Explorer slider tops out at 23:59 (1439 minutes). */
export const MINUTES_PER_DAY = 1439
export const CYCLE_RATE = 60 /** DCL seconds advanced per real second (24 min full cycle). */
export const SUNRISE = 6 * 3600 + 15 * 60 /** 6:15 → 22500 */
export const SUNSET = 19 * 3600 + 50 * 60 /** 19:50 → 71400 */
export const TRANSITION_WALL_SEC = 4
/** Directional sun + skydome disc intensity multiplier vs Explorer defaults. */
export const SUN_BRIGHTNESS = 2.1
/** Moon fill directional — Unity Generic_Skybox ~0.2–0.55 at night (separate from sun anim curve). */
export const MOON_BRIGHTNESS = 1.35
/** Hemisphere ambient — day / night multipliers on SkyboxRenderController indirect colors. */
export const HEMI_DAY_INTENSITY = 0.54
export const HEMI_NIGHT_INTENSITY = 0.65
/** Boost hemi groundColor at night — indirectGround gradient is very dark (0.08) but avatars need fill. */
export const NIGHT_GROUND_HEMI_BOOST = 3.0
/** ACES tone-mapping headroom at night (fixed daytime exposure crushes moon + hemi). */
export const NIGHT_EXPOSURE_BOOST = 1.32

export const TransitionMode = {
  TM_FORWARD: 0,
  TM_BACKWARD: 1
} as const

export type TransitionMode = (typeof TransitionMode)[keyof typeof TransitionMode]

export function normalizeDaySeconds(value: number): number {
  const mod = value % SECONDS_PER_DAY
  return mod < 0 ? mod + SECONDS_PER_DAY : mod
}

export function lerpDaySeconds(
  from: number,
  to: number,
  t: number,
  backward: boolean
): number {
  const a = normalizeDaySeconds(from)
  const b = normalizeDaySeconds(to)
  if (backward) {
    let delta = a - b
    if (delta < 0) delta += SECONDS_PER_DAY
    return normalizeDaySeconds(a - delta * t)
  }
  let delta = b - a
  if (delta < 0) delta += SECONDS_PER_DAY
  return normalizeDaySeconds(a + delta * t)
}

export function normalizedTimeOfDay(seconds: number): number {
  return normalizeDaySeconds(seconds) / SECONDS_PER_DAY
}

export function formatTimeOfDay(seconds: number): string {
  const s = normalizeDaySeconds(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function secondsToSliderMinutes(seconds: number): number {
  const s = normalizeDaySeconds(seconds)
  return Math.min(MINUTES_PER_DAY, Math.floor(s / 60))
}

export function sliderMinutesToSeconds(minutes: number): number {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(minutes)))
  return clamped * 60
}
