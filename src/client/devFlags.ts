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

/** Phase D0 — log rolling main-thread physics timings (`?perfdebug`). */
export function usePerfDebug(): boolean {
  const params = readSearchParams()
  if (!params) return false
  return params.has('perfdebug') || params.has('perf')
}

/**
 * Phase D — PhysX simulate + CCT on a dedicated worker (`?workerphysx` / `?physxworker`).
 * Slice 1 warms the worker; locomotion routing lands in D2/D3. Opt out with `?nophysxworker`.
 */
export function useWorkerPhysx(): boolean {
  const params = readSearchParams()
  if (!params) return false
  if (params.has('nophysxworker')) return false
  return params.has('workerphysx') || params.has('physxworker')
}