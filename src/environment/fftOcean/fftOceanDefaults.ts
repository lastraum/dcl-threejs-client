/**
 * Default FFT ocean parameters — aligned with upstream FFTOCEAN OceanMaterial
 * (@see https://github.com/gioeledallapozza/FFTOCEAN).
 */
import * as THREE from 'three'

export type FftOceanSimSettings = {
  /** Client water mesh (FFT or Water.js). When false, no water. */
  waterEnabled: boolean
  /** GPGPU FFT on (WebGL2). When false, client may fall back to Water.js. */
  enabled: boolean
  meshResolution: number
  fftResolution: number
  /** Phillips spectrum amplitude (wave energy). */
  amplitude: number
  /** Wind speed (m/s) for Phillips spectrum. */
  windSpeed: number
  /** Normalized wind direction in XZ (Three / world horizontal). */
  windDirection: THREE.Vector2
  /** Vertical displacement scale. */
  displacementScale: number
  /** Horizontal chop / peak sharpness (upstream OceanMaterial default 2.0). */
  choppyScale: number
  /** Clipmap LOD ring count. */
  clipLevels: number
  /** FFT simulation updates per second. */
  simulationHz: number
  waterDeep: string
  waterShallow: string
  foamThreshold: number
  foamScale: number
  foamPower: number
  /** Base specular intensity before outdoor-light scaling. */
  specularIntensity: number
}

/**
 * Defaults aligned with https://github.com/gioeledallapozza/FFTOCEAN OceanMaterial
 * plus ThreejsClient-tuned colors for Genesis-style island/open water.
 */
export const FFT_OCEAN_DEFAULTS: FftOceanSimSettings = {
  /**
   * Base default before biome resolution. Island/water/mountains force this true
   * via resolveFftOceanSettings({ landscapeWantsWater: true }) — biome flag owns water.
   */
  waterEnabled: false,
  enabled: true,
  meshResolution: 256,
  fftResolution: 128,
  amplitude: 0.01,
  windSpeed: 15,
  windDirection: new THREE.Vector2(0.4, 0.8).normalize(),
  displacementScale: 1.0,
  choppyScale: 2.0,
  // Outer LOD rings — level N covers ~250m * 2^N full width (level 7 ≈ 32 km).
  // Paired with camera-following clipmap so ocean stays under the camera.
  clipLevels: 7,
  simulationHz: 15,
  // Brighter tropical palette than upstream deep navy (#002b4f) — better for DCL islands
  waterDeep: '#52b9e5',
  waterShallow: '#59cdff',
  foamThreshold: 0.4,
  foamScale: 7.0,
  foamPower: 0.5,
  specularIntensity: 4.7
}

export function clampPowerOfTwo(n: number, min: number, max: number): number {
  let v = Math.max(min, Math.min(max, Math.floor(n)))
  // nearest power of two
  v = 1 << Math.round(Math.log2(v))
  return Math.max(min, Math.min(max, v))
}

export function clampPositiveInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}
