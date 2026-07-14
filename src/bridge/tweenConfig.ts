function readSearchParams(): URLSearchParams | null {
  try {
    if (typeof location === 'undefined') return null
    return new URLSearchParams(location.search)
  } catch {
    return null
  }
}

import { isMotionFocusActive } from './motionFocus'

/**
 * Full tween / TweenState spam — do NOT couple to ?marqueeverbose.
 * That flag used to enable this and flooded Genesis boot (thousands of no-node warns).
 */
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

/**
 * NeonScreen TextureMove row-pause only — lightweight, no general tween noise.
 * `?marqueeverbose` / `?marquee` / `localStorage.marqueeverbose=1`.
 * Also on with ?tweenverbose (opt-in full debug already).
 */
export function isMarqueeVerbose(): boolean {
  const params = readSearchParams()
  if (params?.has('marqueeverbose') || params?.has('marquee')) return true
  if (params?.has('tweenverbose') || params?.has('tween')) return true
  try {
    if (localStorage.getItem('marqueeverbose') === '1') return true
    if (localStorage.getItem('tweenverbose') === '1') return true
  } catch {
    /* ignore */
  }
  return false
}