import type * as THREE from 'three'
import { effectivePixelRatio, renderQuality, RenderQualityTier } from '../rendering/RenderQualitySettings'
import type { PerformanceTier } from '../shim/types'

export type { PerformanceTier } from '../shim/types'

/**
 * Scene-worker min interval between engine.update ticks after play-ready.
 * Explorer runs systems near display rate; high = ~60 Hz, medium ~15 Hz, low ~10 Hz.
 * Override: `?scenetick=25` (16–100 ms).
 *
 * Each tick's dt is wall elapsed (capped at 100ms hitch) — see sceneEngineScheduler.
 */
export function resolveEngineTickIntervalMs(tier: PerformanceTier): number {
  if (typeof window === 'undefined') return 16
  const raw = new URLSearchParams(window.location.search).get('scenetick')
  if (raw) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 16 && parsed <= 100) return parsed
  }
  if (tier === 'low') return 100
  if (tier === 'medium') return 66
  // ~60 Hz — Explorer-class system integration (timers, Tween, continuous motion).
  return 16
}

function readPerfOverride(): PerformanceTier | null {
  if (typeof window === 'undefined') return null
  const raw = new URLSearchParams(window.location.search).get('perf')
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw
  return null
}

function scoreWebGlRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext): number {
  let score = 0
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
  if (!debugInfo) return score
  const renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)).toLowerCase()
  if (
    renderer.includes('swiftshader') ||
    renderer.includes('llvmpipe') ||
    renderer.includes('microsoft basic render') ||
    renderer.includes('software')
  ) {
    score += 4
  }
  if (renderer.includes('intel')) {
    if (/hd graphics [34]\d{3}/.test(renderer) || renderer.includes('hd graphics 4')) score += 2
    else if (renderer.includes('hd graphics') || renderer.includes('uhd graphics 6')) score += 1
  }
  return score
}

/**
 * Heuristic client performance tier — drives scene-worker timing and render defaults.
 * Override with `?perf=low|medium|high` for testing.
 */
export function detectPerformanceTier(
  gl?: WebGLRenderingContext | WebGL2RenderingContext | null
): PerformanceTier {
  const override = readPerfOverride()
  if (override) return override

  let score = 0
  const cores = navigator.hardwareConcurrency ?? 4
  if (cores <= 2) score += 2
  else if (cores <= 4) score += 1

  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  if (deviceMemory !== undefined) {
    if (deviceMemory <= 4) score += 2
    else if (deviceMemory <= 6) score += 1
  }

  if (gl) score += scoreWebGlRenderer(gl)

  if (score >= 4) return 'low'
  if (score >= 2) return 'medium'
  return 'high'
}

/**
 * Apply auto render defaults on first visit (no saved Preferences).
 * When the user has persisted graphics settings, only re-apply pixel ratio from store.
 * Low devices get the Low preset (persisted so Preferences matches). Medium/high leave
 * in-memory Medium defaults without writing localStorage (user can still raise to High/Ultra).
 */
export function applyClientPerformanceDefaults(
  renderer: THREE.WebGLRenderer,
  tier: PerformanceTier
): void {
  if (renderQuality.hasPersistedSettings()) {
    renderer.setPixelRatio(effectivePixelRatio(renderQuality.getResolutionScale()))
    return
  }
  if (tier === 'low') {
    renderQuality.setTier(RenderQualityTier.Low)
    return
  }
  // medium/high: SceneHost already applied store defaults + pixel ratio via subscribe
  renderer.setPixelRatio(effectivePixelRatio(renderQuality.getResolutionScale()))
}
