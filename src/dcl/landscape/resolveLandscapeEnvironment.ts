import type {
  ResolvedScene,
  SceneEnvironmentConfig,
  SceneMetadata,
  SceneSkyLighting,
  SceneSource
} from '../content/types'
import {
  type LandscapeEnvironmentKind,
  landscapeEnvironmentProfile,
  LANDSCAPE_ENVIRONMENTS
} from './EnvironmentCatalog'

const KINDS = Object.keys(LANDSCAPE_ENVIRONMENTS) as LandscapeEnvironmentKind[]

/** `none?disableSun=1` (second `?` instead of `&`) — take biome token before `?` / `&`. */
function environmentKindToken(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  const cut = trimmed.search(/[?&]/)
  return cut >= 0 ? trimmed.slice(0, cut) : trimmed
}

/** Flags accidentally pasted into `?environment=none?disableSun=1`. */
function embeddedSkyFlagsFromEnvParam(raw: string | null): Partial<SceneSkyLighting> {
  if (!raw) return {}
  const idx = raw.search(/[?&]/)
  if (idx < 0) return {}
  const tail = raw.slice(idx + 1).replace(/\?/g, '&')
  const embedded = new URLSearchParams(tail)
  const disableSun = parseBoolQuery(embedded.get('disableSun'))
  const disableMoon = parseBoolQuery(embedded.get('disableMoon'))
  return {
    ...(disableSun !== null ? { disableSun } : {}),
    ...(disableMoon !== null ? { disableMoon } : {})
  }
}

function normalizeKind(raw: string | undefined | null): LandscapeEnvironmentKind | null {
  if (!raw) return null
  const key = environmentKindToken(raw)
  return (KINDS as string[]).includes(key) ? (key as LandscapeEnvironmentKind) : null
}

function readKindFromMetadata(metadata: SceneMetadata): LandscapeEnvironmentKind | null {
  const env = metadata.environment
  if (typeof env === 'string') return normalizeKind(env)
  if (env && typeof env === 'object') {
    const cfg = env as SceneEnvironmentConfig
    if (cfg.kind != null) return normalizeKind(String(cfg.kind))
    if (cfg.disableSun === true || cfg.disableMoon === true) {
      console.warn(
        '[environment] scene.json `environment` object has disableSun/disableMoon but no `kind` — ' +
          'use `{ "kind": "none", "disableSun": true }` or keep `?environment=none` in the URL.'
      )
    }
  }
  return null
}

function readSkyLightingFromMetadata(metadata: SceneMetadata): SceneSkyLighting {
  const env = metadata.environment
  if (!env || typeof env === 'string') {
    return { disableSun: false, disableMoon: false }
  }
  return {
    disableSun: env.disableSun === true,
    disableMoon: env.disableMoon === true
  }
}

function parseBoolQuery(value: string | null): boolean | null {
  if (value === null) return null
  const v = value.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes') return true
  if (v === '0' || v === 'false' || v === 'no') return false
  return null
}

/** Dev URL override (`?environment=` / `?env=`) — force biome at scene load for debugging. */
export function readLandscapeEnvironmentUrlOverride(): LandscapeEnvironmentKind | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const envRaw = params.get('environment') ?? params.get('env')
  const kind = normalizeKind(envRaw)
  if (!kind && envRaw?.trim()) {
    console.warn(
      `[environment] Unrecognized ?environment= value "${envRaw}" — use & between params, e.g. ?environment=none&disableSun=1`
    )
  }
  return kind
}

/** Dev override — `?disableSun=1` / `?disableMoon=1` (+ flags embedded in `environment=`). */
export function readSkyLightingUrlOverride(): Partial<SceneSkyLighting> | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const envRaw = params.get('environment') ?? params.get('env')
  const embedded = embeddedSkyFlagsFromEnvParam(envRaw)
  const disableSun = parseBoolQuery(params.get('disableSun')) ?? embedded.disableSun ?? null
  const disableMoon = parseBoolQuery(params.get('disableMoon')) ?? embedded.disableMoon ?? null
  if (disableSun === null && disableMoon === null) return null
  return {
    ...(disableSun !== null ? { disableSun } : {}),
    ...(disableMoon !== null ? { disableMoon } : {})
  }
}

/**
 * Celestial lighting flags: URL overrides win per-field, then `scene.json` `environment` object.
 */
export function resolveSceneSkyLighting(metadata: SceneMetadata): SceneSkyLighting {
  const fromScene = readSkyLightingFromMetadata(metadata)
  const url = readSkyLightingUrlOverride()
  if (!url) return fromScene
  return {
    disableSun: url.disableSun ?? fromScene.disableSun,
    disableMoon: url.disableMoon ?? fromScene.disableMoon
  }
}

export type ResolvedSceneEnvironment = {
  landscapeEnvironment: LandscapeEnvironmentKind
  skyLighting: SceneSkyLighting
}

function defaultLandscapeEnvironmentForSource(source: SceneSource): LandscapeEnvironmentKind {
  if (source.kind === 'world') return 'island'
  return 'none'
}

/**
 * Resolve biome + celestial flags together. URL `?environment=` always wins for biome so
 * `?environment=none&disableSun=1` cannot fall back to island when `kind` is omitted from JSON.
 *
 * Parcel scenes (`coords`) default to `none` unless `scene.json` declares `environment`.
 * Worlds default to `island` when the field is absent.
 */
export function resolveSceneEnvironment(
  metadata: SceneMetadata,
  source: SceneSource
): ResolvedSceneEnvironment {
  const urlKind = readLandscapeEnvironmentUrlOverride()
  const metaKind = readKindFromMetadata(metadata)
  let landscapeEnvironment: LandscapeEnvironmentKind
  if (urlKind) {
    landscapeEnvironment = urlKind
  } else if (metaKind) {
    landscapeEnvironment = metaKind
  } else {
    landscapeEnvironment = defaultLandscapeEnvironmentForSource(source)
  }
  return {
    landscapeEnvironment,
    skyLighting: resolveSceneSkyLighting(metadata)
  }
}

/**
 * Resolve landscape biome for a parcel scene: URL override, then scene.json, else `none`.
 */
export function resolveLandscapeEnvironment(metadata: SceneMetadata): LandscapeEnvironmentKind {
  return resolveSceneEnvironment(metadata, { kind: 'coords', x: 0, y: 0 }).landscapeEnvironment
}

export function resolveLandscapeEnvironmentProfile(metadata: SceneMetadata) {
  return landscapeEnvironmentProfile(resolveLandscapeEnvironment(metadata))
}

/** Use resolved scene biome — blank template is `none`, not re-derived from empty metadata. */
export function landscapeProfileForResolvedScene(scene: ResolvedScene) {
  return landscapeEnvironmentProfile(scene.landscapeEnvironment)
}