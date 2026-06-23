/** Ignore sub-mm PhysX/probe jitter on static floors — prevents rabbit bounce without lifts (~8 mm). */
export const MIN_PLATFORM_TRANSFER_LEN_SQ = 6.25e-5

export function isSignificantPlatformDelta(delta: { lengthSq(): number }): boolean {
  return delta.lengthSq() >= MIN_PLATFORM_TRANSFER_LEN_SQ
}