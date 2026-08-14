/**
 * Off-thread GLB parse is on by default.
 * Escape hatch: `?mainglb` / `?glbparse=main` forces parseAsync on the present thread.
 */
export function isGlbOffThreadParseEnabled(): boolean {
  if (typeof location === 'undefined') return true
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
