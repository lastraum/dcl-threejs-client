import { isAppleTouchDevice } from '../util/appleTouch'
import { isBraveBrowser } from '../util/braveBrowser'

/**
 * Off-thread GLB parse is on by default.
 * Escape hatch: `?mainglb` / `?glbparse=main` forces the main-thread path.
 * iOS / Brave: skip the worker. Main thread still runs the same flatten→inflate
 * bind as desktop — only the worker hop (ImageBitmap / buffer transfer) is avoided.
 * Safari paints transferred worker ImageBitmaps solid white; Brave mis-binds skinned feet.
 */
export function isGlbOffThreadParseEnabled(): boolean {
  if (typeof location === 'undefined') return true
  if (isAppleTouchDevice()) return false
  if (isBraveBrowser()) return false
  try {
    const q = new URLSearchParams(location.search)
    if (q.has('mainglb')) return false
    const raw = q.get('glbparse')
    if (raw === 'main' || raw === '0' || raw === 'off') return false
  } catch {
    /* ignore */
  }
  return true
}
