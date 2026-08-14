/**
 * Resolve FFT ocean settings: URL query (dev) overrides `scene.json` `environment.water`.
 * Simulation core ported from https://github.com/gioeledallapozza/FFTOCEAN
 */
import * as THREE from 'three'
import type { SceneMetadata, SceneWaterConfig } from '../../dcl/content/types'
import {
  clampPositiveInt,
  clampPowerOfTwo,
  FFT_OCEAN_DEFAULTS,
  type FftOceanSimSettings
} from './fftOceanDefaults'

export type FftOceanSettings = FftOceanSimSettings

function parseIntQuery(value: string | null, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function parseFloatQuery(value: string | null, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

function parseBoolQueryOptional(value: string | null): boolean | null {
  if (!value) return null
  const v = value.trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'no') return false
  if (v === '1' || v === 'true' || v === 'yes') return true
  return null
}

function fftOceanParam(params: URLSearchParams): string | null {
  return params.get('fftOcean') ?? params.get('fftocean') ?? params.get('fft')
}

function parseWindDirection(
  raw: SceneWaterConfig['windDirection'] | undefined,
  fallback: THREE.Vector2
): THREE.Vector2 {
  if (raw == null) return fallback.clone()
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const rad = (raw * Math.PI) / 180
    return new THREE.Vector2(Math.cos(rad), Math.sin(rad)).normalize()
  }
  if (typeof raw === 'object' && raw !== null) {
    const x = typeof raw.x === 'number' ? raw.x : 0
    const z = typeof raw.z === 'number' ? raw.z : typeof raw.y === 'number' ? raw.y : 0
    if (x === 0 && z === 0) return fallback.clone()
    return new THREE.Vector2(x, z).normalize()
  }
  return fallback.clone()
}

function parseHexColor(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const t = raw.trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) return t
  if (/^[0-9a-f]{6}$/i.test(t)) return `#${t}`
  return fallback
}

/** Read `environment.water` from scene.json (ThreejsClient-only). */
export function readSceneWaterConfig(metadata: SceneMetadata | null | undefined): SceneWaterConfig {
  const env = metadata?.environment
  if (!env || typeof env === 'string') return {}
  const water = env.water
  if (!water || typeof water !== 'object') return {}
  return water
}

function mergeSceneWater(base: FftOceanSimSettings, water: SceneWaterConfig): FftOceanSimSettings {
  const next = { ...base, windDirection: base.windDirection.clone() }
  // enabled = master water mesh; fft = GPGPU vs Water.js (do not conflate)
  if (typeof water.enabled === 'boolean') next.waterEnabled = water.enabled
  if (typeof water.fft === 'boolean') next.enabled = water.fft
  if (typeof water.fftResolution === 'number') {
    next.fftResolution = clampPowerOfTwo(water.fftResolution, 32, 512)
  }
  if (typeof water.meshResolution === 'number') {
    next.meshResolution = clampPositiveInt(water.meshResolution, 64, 512, next.meshResolution)
  }
  if (typeof water.amplitude === 'number' && Number.isFinite(water.amplitude)) {
    next.amplitude = Math.max(0, Math.min(1, water.amplitude))
  }
  if (typeof water.windSpeed === 'number' && Number.isFinite(water.windSpeed)) {
    next.windSpeed = Math.max(0, Math.min(80, water.windSpeed))
  }
  if (water.windDirection !== undefined) {
    next.windDirection = parseWindDirection(water.windDirection, next.windDirection)
  }
  if (typeof water.displacementScale === 'number' && Number.isFinite(water.displacementScale)) {
    next.displacementScale = Math.max(0, Math.min(10, water.displacementScale))
  }
  if (typeof water.choppyScale === 'number' && Number.isFinite(water.choppyScale)) {
    next.choppyScale = Math.max(0, Math.min(10, water.choppyScale))
  }
  if (typeof water.clipLevels === 'number') {
    next.clipLevels = clampPositiveInt(water.clipLevels, 2, 8, next.clipLevels)
  }
  if (typeof water.simulationHz === 'number' && Number.isFinite(water.simulationHz)) {
    next.simulationHz = Math.max(5, Math.min(60, water.simulationHz))
  }
  if (water.waterDeep !== undefined) next.waterDeep = parseHexColor(water.waterDeep, next.waterDeep)
  if (water.waterShallow !== undefined) {
    next.waterShallow = parseHexColor(water.waterShallow, next.waterShallow)
  }
  if (typeof water.foamThreshold === 'number' && Number.isFinite(water.foamThreshold)) {
    next.foamThreshold = Math.max(0, Math.min(2, water.foamThreshold))
  }
  if (typeof water.foamScale === 'number' && Number.isFinite(water.foamScale)) {
    next.foamScale = Math.max(0.1, Math.min(100, water.foamScale))
  }
  if (typeof water.foamPower === 'number' && Number.isFinite(water.foamPower)) {
    next.foamPower = Math.max(0.05, Math.min(10, water.foamPower))
  }
  if (typeof water.specularIntensity === 'number' && Number.isFinite(water.specularIntensity)) {
    next.specularIntensity = Math.max(0, Math.min(20, water.specularIntensity))
  }
  return next
}

function applyUrlOverrides(base: FftOceanSimSettings): FftOceanSimSettings {
  if (typeof window === 'undefined') return base
  const params = new URLSearchParams(window.location.search)
  const mobile = window.innerWidth <= 768
  const next = { ...base, windDirection: base.windDirection.clone() }

  // Master water — only override when URL explicitly mentions water.
  // Do not clobber biome/scene defaults when the param is absent.
  const waterQ = parseBoolQueryOptional(params.get('water'))
  if (waterQ === true) next.waterEnabled = true
  else if (waterQ === false) next.waterEnabled = false
  if (parseBoolQueryOptional(params.get('noWater')) === true) next.waterEnabled = false
  if (parseBoolQueryOptional(params.get('disableWater')) === true) next.waterEnabled = false

  const en = parseBoolQueryOptional(fftOceanParam(params))
  if (en !== null) next.enabled = en

  if (params.has('oceanResolution')) {
    next.meshResolution = parseIntQuery(params.get('oceanResolution'), next.meshResolution)
  }
  if (params.has('fftResolution')) {
    next.fftResolution = clampPowerOfTwo(
      parseIntQuery(params.get('fftResolution'), next.fftResolution),
      32,
      512
    )
  } else if (mobile && !params.has('fftResolution')) {
    next.fftResolution = Math.min(next.fftResolution, 64)
  }

  if (params.has('oceanAmplitude')) {
    next.amplitude = Math.max(0, parseFloatQuery(params.get('oceanAmplitude'), next.amplitude))
  }
  if (params.has('oceanWind')) {
    next.windSpeed = Math.max(0, parseFloatQuery(params.get('oceanWind'), next.windSpeed))
  }
  if (params.has('oceanChoppy')) {
    next.choppyScale = Math.max(0, parseFloatQuery(params.get('oceanChoppy'), next.choppyScale))
  }
  if (params.has('oceanScale')) {
    next.displacementScale = Math.max(
      0,
      parseFloatQuery(params.get('oceanScale'), next.displacementScale)
    )
  }
  return next
}

export type ResolveFftOceanOptions = {
  /**
   * Biome profile `showWater` (island / water / mountains).
   * When true, water mesh is ON — that is the biome flag. Not a separate opt-in.
   * scene.json `water.enabled: false` or `?water=0` can still kill it.
   * When false, water stays off unless `?water=1` or scene.json `water.enabled: true`.
   */
  landscapeWantsWater?: boolean
}

/**
 * Full ocean settings:
 * defaults ← biome showWater ← scene.json environment.water ← URL.
 *
 * Biome law: island/water/mountains ⇒ waterEnabled. Do not require `?water=1`.
 */
export function resolveFftOceanSettings(
  metadata?: SceneMetadata | null,
  options?: ResolveFftOceanOptions
): FftOceanSettings {
  const sceneWater = readSceneWaterConfig(metadata)
  const fromScene = mergeSceneWater(
    {
      ...FFT_OCEAN_DEFAULTS,
      windDirection: FFT_OCEAN_DEFAULTS.windDirection.clone()
    },
    sceneWater
  )
  // Biome owns water. showWater true → mesh on, unless scene.json set enabled:false.
  if (options?.landscapeWantsWater === true) {
    if (typeof sceneWater.enabled !== 'boolean') {
      fromScene.waterEnabled = true
    }
  }
  return applyUrlOverrides(fromScene)
}

/** @deprecated Prefer resolveFftOceanSettings(scene.metadata) */
export function readFftOceanOverride(): FftOceanSettings {
  return resolveFftOceanSettings(null)
}

/**
 * Explicit URL kill only (`?water=0` / `?noWater` / `?disableWater`).
 * Does NOT default-disable water — biome showWater turns ocean on.
 */
export function isClientWaterDisabled(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  const water = parseBoolQueryOptional(params.get('water'))
  if (water === false) return true
  if (parseBoolQueryOptional(params.get('noWater')) === true) return true
  if (parseBoolQueryOptional(params.get('disableWater')) === true) return true
  return false
}

/** Keys that must trigger a full scene reload when changed (path unchanged). */
export function readSceneDevQueryKey(): string {
  if (typeof window === 'undefined') return ''
  const params = new URLSearchParams(window.location.search)
  return [
    params.get('environment') ?? params.get('env') ?? '',
    params.get('disableSun') ?? '',
    params.get('disableMoon') ?? '',
    fftOceanParam(params) ?? '',
    params.get('fftResolution') ?? '',
    params.get('oceanResolution') ?? '',
    params.get('oceanAmplitude') ?? '',
    params.get('oceanWind') ?? '',
    params.get('oceanChoppy') ?? '',
    params.get('oceanScale') ?? '',
    params.get('water') ?? '',
    params.get('noWater') ?? '',
    params.get('disableWater') ?? ''
  ].join('|')
}
