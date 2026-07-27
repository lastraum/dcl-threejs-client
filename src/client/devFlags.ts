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
 * Kill multi-scene AOI: no neighbor visuals, live secondaries, or promote.
 * Primary scene only. Use for CBD isolation: `?noaoi=1`.
 *
 * - Default: AOI **ON** (when Scene Distance > 0)
 * - `?noaoi` / `?skipaoi` → force off
 * - `?aoi` / `?withaoi` → force on (still needs Scene Distance > 0)
 */
export function skipAoiNeighbors(): boolean {
  const params = readSearchParams()
  if (params?.has('aoi') || params?.has('withaoi')) return false
  if (params?.has('noaoi') || params?.has('skipaoi')) return true
  return false
}

/**
 * Skip scene GLTF Animator bind + mixer playback (clips frozen; nothing advances).
 * PhysX / AOI / tweens unchanged.
 *
 * Default: animators **ON**. Isolate cost with `?noanim=1`.
 * Shared-hash sample + fair ring (AnimatorBridge) keeps in-view clips at ≥30 Hz under budget.
 */
export function skipSceneAnimators(): boolean {
  const params = readSearchParams()
  if (!params) return false
  if (params.has('anim') || params.has('sceneanim')) return false
  return params.has('noanim') || params.has('skipanim')
}

/**
 * Bottom-right animator sample HUD (bound/active/shared/fair Hz).
 * Opt-in: `?animatorhud` / `?perf` / `?perfdebug` / localStorage `animatorhud=1`.
 */
export function wantAnimatorSampleHud(): boolean {
  const params = readSearchParams()
  if (params?.has('animatorhud') || params?.has('animhud')) return true
  if (usePerfDebug()) return true
  try {
    if (localStorage.getItem('animatorhud') === '1') return true
  } catch {
    /* ignore */
  }
  return false
}