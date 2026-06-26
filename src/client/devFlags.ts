function readSearchParams(): URLSearchParams | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search)
}

/**
 * Skip remote avatar compose/load (comms may still connect).
 * Enabled by default; opt out with `?noremote`. `?remote` is accepted as an alias for the default.
 */
export function skipRemoteAvatars(): boolean {
  const params = readSearchParams()
  if (params?.has('noremote')) return true
  return false
}

/** Skip Genesis theatre `runShowSetup` + Scene 11/12 composite registration (`?notheatre` / `?skiptheatre`). */
export function skipTheatreSceneScript(): boolean {
  const params = readSearchParams()
  if (!params) return false
  return params.has('notheatre') || params.has('skiptheatre')
}

/** Debug-only: skip ECS VideoPlayer decoders (`?novideo`). */
export function skipSceneVideoPlayers(): boolean {
  const params = readSearchParams()
  if (!params) return false
  return params.has('novideo')
}

/**
 * Phase C — worker outbound CRDT fire-and-forget; inbound via `renderer-inbound-deliver`.
 * Enabled by default after play-ready; opt out with `?roundtripcrdt` (or `?roundtrip`).
 */
export function useOneWayCrdt(): boolean {
  const params = readSearchParams()
  if (!params) return true
  if (params.has('roundtripcrdt') || params.has('roundtrip')) return false
  return true
}