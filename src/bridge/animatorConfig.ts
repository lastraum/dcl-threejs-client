function readSearchParams(): URLSearchParams | null {
  try {
    if (typeof location === 'undefined') return null
    return new URLSearchParams(location.search)
  } catch {
    return null
  }
}

import { isMotionFocusActive } from './motionFocus'

/** `?animatorverbose` / `?animator` / `?blimpdebug` — log GLTF Animator bind/clip playback. */
export function isAnimatorVerbose(): boolean {
  const params = readSearchParams()
  if (params?.has('animatorverbose') || params?.has('animator')) return true
  if (isMotionFocusActive()) return true
  try {
    if (localStorage.getItem('animatorverbose') === '1') return true
  } catch {
    /* ignore */
  }
  return false
}