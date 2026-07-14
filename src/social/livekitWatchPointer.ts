/**
 * Per-wallet LiveKit watch pointer — same key as dcl-companion browser-only mode.
 * When set, Cast / scene room can target a different world/parcel than the URL.
 */
const KEY_WATCH_POINTERS = 'dcl-companion.browserOnly.watchPointers'

function readMap(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(KEY_WATCH_POINTERS)
    if (!raw) return {}
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeMap(map: Record<string, unknown>): void {
  try {
    localStorage.setItem(KEY_WATCH_POINTERS, JSON.stringify(map))
  } catch {
    /* quota */
  }
}

export function getLiveKitWatchPointer(walletAddress: string): string | null {
  const key = walletAddress.trim().toLowerCase()
  if (!key) return null
  const v = readMap()[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function setLiveKitWatchPointer(walletAddress: string, pointer: string | null): void {
  const key = walletAddress.trim().toLowerCase()
  if (!key) return
  const map = readMap()
  const p = pointer?.trim() ?? ''
  if (p) map[key] = p
  else delete map[key]
  writeMap(map)
}

/** Parse realm name, x,y, or ?realm= from a pasted watch target. */
export function parseLiveKitWatchPointerInput(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  try {
    if (/^https?:\/\//i.test(t)) {
      const u = new URL(t)
      const realm = u.searchParams.get('realm')?.trim()
      if (realm) return realm
      const path = u.pathname.replace(/^\//, '').split('/')[0]?.trim()
      if (path) return path
    }
  } catch {
    /* fall through */
  }
  const parcel = t.replace(/\s*,\s*/g, ',')
  if (/^-?\d{1,3},-?\d{1,3}$/.test(parcel)) return parcel
  return t.toLowerCase()
}
