function readSearchParams(): URLSearchParams | null {
  try {
    if (typeof location === 'undefined') return null
    return new URLSearchParams(location.search)
  } catch {
    return null
  }
}

/** `?tweenverbose` or `localStorage.tweenverbose=1` — log TweenState on the debug panel. */
export function isTweenVerbose(): boolean {
  const params = readSearchParams()
  if (params?.has('tweenverbose')) return true
  try {
    if (localStorage.getItem('tweenverbose') === '1') return true
  } catch {
    /* ignore */
  }
  return false
}