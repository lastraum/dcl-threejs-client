function readSearchParams(): URLSearchParams | null {
  try {
    if (typeof location === 'undefined') return null
    return new URLSearchParams(location.search)
  } catch {
    return null
  }
}

import { isMotionFocusActive } from './motionFocus'

/** `?tweenverbose` / `?tween` / `?blimpdebug` — log TweenState on the debug panel. */
export function isTweenVerbose(): boolean {
  const params = readSearchParams()
  if (params?.has('tweenverbose') || params?.has('tween')) return true
  if (isMotionFocusActive()) return true
  try {
    if (localStorage.getItem('tweenverbose') === '1') return true
  } catch {
    /* ignore */
  }
  return false
}