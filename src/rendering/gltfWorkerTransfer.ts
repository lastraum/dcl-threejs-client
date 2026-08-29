import { isAppleTouchDevice } from '../util/appleTouch'
import { isBraveBrowser } from '../util/braveBrowser'

/**
 * Off-thread GLB parse is on by default.
 * Escape hatch: `?mainglb` / `?glbparse=main` forces parseAsync on the present thread.
 * iOS: worker transfers ImageBitmaps — Safari WebGL uploads those as solid white.
 * Brave: shields/farbling + transferable skeleton buffers mis-bind skinned meshes
 * (feet detach from ankles). Same main-thread parse as iOS.
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
