/** iPhone / iPod — Safari WebContent jetsam is much tighter than iPad. */
export function isIphoneDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPhone|iPod/i.test(navigator.userAgent)
}

/** iPhone / iPad, including iPadOS desktop UA. */
export function isAppleTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  return (navigator.maxTouchPoints ?? 0) > 1 && /Mac/i.test(navigator.platform || navigator.userAgent)
}
