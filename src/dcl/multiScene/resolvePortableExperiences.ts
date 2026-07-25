/**
 * scene.json featureToggles.portableExperiences — PE / smart wearable policy.
 *
 *   "featureToggles": { "portableExperiences": "enabled" | "disabled" | "hideUi" }
 *
 * - enabled (default): PE may run with UI
 * - disabled: unload PE workers, block enable; HUD icon restricted + hover tip
 * - hideUi: PE may run, force PE scene UI off
 */
import type { SceneFeatureToggle, SceneMetadata } from '../content/types'

export type PortableExperiencesPolicy = {
  /** PE workers allowed to run. */
  allowed: boolean
  /** When running, PE UI may show (user toggle still applies if true). */
  uiAllowed: boolean
  raw: SceneFeatureToggle | 'default'
}

/** Hover / panel copy when scene.json disables PE. */
export const PE_SCENE_OVERRIDE_MESSAGE =
  'This scene is overriding portable experiences'

function parseFeatureToggle(raw: unknown): SceneFeatureToggle | null {
  if (typeof raw === 'boolean') return raw ? 'enabled' : 'disabled'
  if (raw && typeof raw === 'object') {
    const o = raw as { enabled?: boolean; disabled?: boolean }
    if (o.enabled === false || o.disabled === true) return 'disabled'
    if (o.enabled === true || o.disabled === false) return 'enabled'
  }
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  if (v === 'enabled' || v === 'enable' || v === 'on' || v === 'true' || v === '1') {
    return 'enabled'
  }
  if (v === 'disabled' || v === 'disable' || v === 'off' || v === 'false' || v === '0') {
    return 'disabled'
  }
  if (v === 'hideui' || v === 'hide_ui' || v === 'hide-ui') return 'hideUi'
  return null
}

function parseBoolQuery(value: string | null): boolean | null {
  if (value === null) return null
  const v = value.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'enabled' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'no' || v === 'disabled' || v === 'off') return false
  return null
}

/** Dev override — `?portableExperiences=disabled` / `enabled`. */
export function readPortableExperiencesUrlOverride(): SceneFeatureToggle | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  for (const key of ['portableExperiences', 'portable', 'pe', 'px'] as const) {
    const raw = params.get(key)
    if (raw === null) continue
    const bool = parseBoolQuery(raw)
    if (bool === true) return 'enabled'
    if (bool === false) return 'disabled'
    const toggle = parseFeatureToggle(raw)
    if (toggle) return toggle
  }
  return null
}

function readToggleFromMetadata(metadata: SceneMetadata): SceneFeatureToggle | null {
  const ft = metadata.featureToggles
  // Official path
  const fromFeature = parseFeatureToggle(ft?.portableExperiences)
  if (fromFeature) return fromFeature
  // Aliases some deploys / older tools use
  const loose = ft as Record<string, unknown> | undefined
  if (loose) {
    for (const key of [
      'portableExperiences',
      'portableExperience',
      'portable_experiences',
      'smartWearables',
      'smartWearable'
    ]) {
      const t = parseFeatureToggle(loose[key])
      if (t) return t
    }
  }
  // Top-level alias (rare)
  const top = (metadata as { portableExperiences?: unknown }).portableExperiences
  return parseFeatureToggle(top)
}

export function resolvePortableExperiencesPolicy(metadata: SceneMetadata): PortableExperiencesPolicy {
  const url = readPortableExperiencesUrlOverride()
  const fromScene = readToggleFromMetadata(metadata)
  const raw = url ?? fromScene ?? 'default'

  if (raw === 'disabled') {
    return { allowed: false, uiAllowed: false, raw: 'disabled' }
  }
  if (raw === 'hideUi') {
    return { allowed: true, uiAllowed: false, raw: 'hideUi' }
  }
  // enabled or default
  return { allowed: true, uiAllowed: true, raw: raw === 'enabled' ? 'enabled' : 'default' }
}

/** Debug helper — log why PE is allowed/blocked for a scene. */
export function describePortableExperiencesPolicy(metadata: SceneMetadata): string {
  const policy = resolvePortableExperiencesPolicy(metadata)
  const ft = metadata.featureToggles?.portableExperiences
  return `raw=${policy.raw} allowed=${policy.allowed} ui=${policy.uiAllowed} scene.json=${JSON.stringify(ft ?? null)}`
}
