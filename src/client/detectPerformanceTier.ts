import type * as THREE from 'three'
import { renderQuality, RenderQualityTier } from '../rendering/RenderQualitySettings'
import type { PerformanceTier } from '../shim/types'

export type { PerformanceTier } from '../shim/types'

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

/** Lower pixel ratio and render quality on weak GPUs — call once after WebGL context exists. */
export function applyClientPerformanceDefaults(
  renderer: THREE.WebGLRenderer,
  tier: PerformanceTier
): void {
  if (tier === 'low') {
    renderQuality.setTier(RenderQualityTier.Low)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1))
    return
  }
  if (tier === 'medium') {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25))
  }
}