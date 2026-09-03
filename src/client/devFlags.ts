import { isHandheldDevice } from './ui/touchPlayLayout'
import { renderQuality, SCENE_LOAD_RADIUS_MOBILE_LITE_M } from '../rendering/RenderQualitySettings'

function readSearchParams(): URLSearchParams | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search)
}

/**
 * Skip remote avatar compose/load (comms may still connect).
 * Default **on** — remotes are product. Force off with `?noremote` / `?skipremote` for A/B.
 * `?remotes` / `?withremotes` force on.
 */
export function skipRemoteAvatars(): boolean {
  const params = readSearchParams()
  if (params?.has('remotes') || params?.has('withremotes')) return false
  if (params?.has('noremote') || params?.has('skipremote')) return true
  return false
}

/** Force bloom off for render A/B (`?nobloom` / `?skipbloom`). */
export function forceNoBloom(): boolean {
  const params = readSearchParams()
  if (!params) return false
  return params.has('nobloom') || params.has('skipbloom')
}

/** Force shadows off for render A/B (`?noshadow` / `?skipshadow`). */
export function forceNoShadow(): boolean {
  const params = readSearchParams()
  if (!params) return false
  return params.has('noshadow') || params.has('skipshadow')
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
 * Force every `clientDebugLog` / `consoleOnly` line into the browser devtools console.
 * Opt-in for hang diagnosis when Help → Debug mirror is off.
 *
 * `?consolelogs` · `?debugconsole` · `?consolelog` · `?logs`
 * Also: localStorage `dcl.debug.consoleMirror=1` or Help → “Mirror panel → browser console”.
 */
export function wantConsoleLogs(): boolean {
  const params = readSearchParams()
  if (!params) return false
  return (
    params.has('consolelogs') ||
    params.has('debugconsole') ||
    params.has('consolelog') ||
    params.has('logs')
  )
}

/**
 * Phone or iPad AOI-lite candidate: handheld profile and not `?aoi` / `?withaoi`.
 * `?nomobile` / `?notouch` skip the profile (via isHandheldDevice).
 */
export function isHandheldAoiLite(): boolean {
  const params = readSearchParams()
  if (params?.has('aoi') || params?.has('withaoi')) return false
  return isHandheldDevice()
}

/** @deprecated Use {@link isHandheldAoiLite} — phones and iPad share the lite path. */
export function isPhoneAoiLite(): boolean {
  return isHandheldAoiLite()
}

/**
 * Kill multi-scene AOI: no neighbor visuals, live secondaries, or promote.
 * Primary scene only. Use for CBD isolation: `?noaoi=1`.
 *
 * - Default: AOI **ON** (when Scene Distance > 0)
 * - `?noaoi` / `?skipaoi` → force off
 * - `?aoi` / `?withaoi` → force on (still needs Scene Distance > 0)
 * - Handheld (phone or iPad): skip while Scene Distance is left at the auto
 *   lite default (16 m). Raising the slider this session undoes skip. Walk stays
 *   open (do not set the slider to 0).
 */
export function skipAoiNeighbors(): boolean {
  const params = readSearchParams()
  if (params?.has('aoi') || params?.has('withaoi')) return false
  if (params?.has('noaoi') || params?.has('skipaoi')) return true
  if (!isHandheldAoiLite()) return false
  // Auto-skip only while they leave radius at the auto-reduced default.
  return renderQuality.getSceneLoadRadiusM() <= SCENE_LOAD_RADIUS_MOBILE_LITE_M
}

/** `?aoi` / `?withaoi` — keep neighbor AOI (still Low + live cap 1). */
export function isAoiForcedOn(): boolean {
  const params = readSearchParams()
  return !!(params?.has('aoi') || params?.has('withaoi'))
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
 * Skip play-time scene collider extract / PhysX cook / pose slides (A/B async coll).
 * CCT + infinite ground still init so you can walk; solids won't register.
 *
 * `?nophysx` · `?nocolliders` · `?skipcolliders`
 */
export function skipPhysxColliders(): boolean {
  const params = readSearchParams()
  if (!params) return false
  return (
    params.has('nophysx') ||
    params.has('nocolliders') ||
    params.has('skipcolliders') ||
    params.has('nocol')
  )
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

/**
 * Top-left main-thread frame pie (sync/rem/part/render/loop+).
 * Opt-in: `?framehud` / `?perf` / `?perfdebug` / localStorage `framehud=1`.
 */
export function wantMainFrameHud(): boolean {
  const params = readSearchParams()
  if (params?.has('framehud') || params?.has('framepie')) return true
  if (usePerfDebug()) return true
  try {
    if (localStorage.getItem('framehud') === '1') return true
  } catch {
    /* ignore */
  }
  return false
}