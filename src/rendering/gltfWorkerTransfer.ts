import { isAppleTouchDevice } from '../util/appleTouch'

/**
 * Off-thread GLB parse is on by default.
 * Escape hatch: `?mainglb` / `?glbparse=main` forces parseAsync on the present thread.
 * iOS: worker transfers ImageBitmaps — Safari WebGL uploads those as solid white.
 */
export function isGlbOffThreadParseEnabled(): boolean {
  if (typeof location === 'undefined') return true
  if (isAppleTouchDevice()) return false
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
