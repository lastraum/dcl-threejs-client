/** Ignore sub-mm PhysX/probe jitter on static floors — prevents rabbit bounce without lifts (~8 mm). */
export const MIN_PLATFORM_TRANSFER_LEN_SQ = 6.25e-5
/** Feet must be this close in XZ to a walk surface to count as standing on it. */
export const PLATFORM_STANDING_MAX_HORIZ = 2.5
/** Max |feet.y − tread.y| for standing transfer — not a 2.5 m vertical catch band. */
export const PLATFORM_STANDING_MAX_VERT = 0.45

export function isSignificantPlatformDelta(delta: { lengthSq(): number }): boolean {
  return delta.lengthSq() >= MIN_PLATFORM_TRANSFER_LEN_SQ
}