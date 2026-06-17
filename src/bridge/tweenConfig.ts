function readSearchParams(): URLSearchParams | null {
  try {
    if (typeof location === 'undefined') return null
    return new URLSearchParams(location.search)
  } catch {
    return null
  }
}

/** `?tweenverbose` — log TweenState transitions + progress on the client debug panel. */
export function isTweenVerbose(): boolean {
  const params = readSearchParams()
  return params?.has('tweenverbose') ?? false
}