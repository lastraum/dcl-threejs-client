/** `?raycastverbose` — log Raycast hits on the client debug panel. */
export function isRaycastVerbose(): boolean {
  try {
    if (typeof location === 'undefined') return false
    return new URLSearchParams(location.search).has('raycastverbose')
  } catch {
    return false
  }
}