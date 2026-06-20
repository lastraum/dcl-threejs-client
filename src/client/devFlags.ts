function readSearchParams(): URLSearchParams | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search)
}

/**
 * Skip remote avatar compose/load (comms may still connect).
 * On by default in Vite dev; override with `?remote` or force with `?noremote`.
 */
export function skipRemoteAvatars(): boolean {
  const params = readSearchParams()
  if (params?.has('remote')) return false
  if (params?.has('noremote')) return true
  return import.meta.env.DEV
}