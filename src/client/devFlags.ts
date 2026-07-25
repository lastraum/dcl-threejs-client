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

/** Log rolling main-thread physics timings (`?perfdebug` / `?perf`). */
export function usePerfDebug(): boolean {
  const params = readSearchParams()
  if (!params) return false
  return params.has('perfdebug') || params.has('perf')
}

/**
 * Kill multi-scene AOI: no neighbor visuals, script-warm, live secondaries, or promote.
 * Primary scene only. Use for CBD / mega-scene perf isolation: `?noaoi=1`
 */
export function skipAoiNeighbors(): boolean {
  const params = readSearchParams()
  if (!params) return false
  return params.has('noaoi') || params.has('skipaoi')
}

/**
 * Skip scene GLTF Animator bind + mixer playback (clips frozen; nothing advances).
 * PhysX / AOI / tweens unchanged.
 *
 * TEMP (AOI multi-scene load test): **default ON** so animators stay off without a URL flag.
 * Re-enable scene animators with `?anim=1` or `?sceneanim=1`.
 * Legacy: `?noanim=1` still forces skip (redundant while default is off).
 */
export function skipSceneAnimators(): boolean {
  const params = readSearchParams()
  if (!params) return true
  // Explicit opt-in to restore scene mixers while default is forced off.
  if (params.has('anim') || params.has('sceneanim')) return false
  // Default: disabled (was opt-in via ?noanim only).
  return true
}