/**
 * Brave (desktop/Android). UA still says Chrome; the `navigator.brave` object is
 * present even with shields up. Worker GLB transfers + WebGL farbling both hit here.
 */
export function isBraveBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & {
    brave?: { isBrave?: unknown }
    userAgentData?: { brands?: Array<{ brand?: string }> }
  }
  if (nav.brave) return true
  const brands = nav.userAgentData?.brands
  if (Array.isArray(brands) && brands.some((b) => /Brave/i.test(b.brand ?? ''))) return true
  return /Brave/i.test(navigator.userAgent)
}
