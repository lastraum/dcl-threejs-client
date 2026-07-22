/**
 * scene.json featureToggles.portableExperiences — PE / smart wearable policy.
 *
 *   "featureToggles": { "portableExperiences": "enabled" | "disabled" | "hideUi" }
 *
 * - enabled (default): PE may run with UI
 * - disabled: unload PE workers, block enable
 * - hideUi: PE may run, force UI off
 */
import type { SceneFeatureToggle, SceneMetadata } from '../content/types'

export type PortableExperiencesPolicy = {
  /** PE workers allowed to run. */
  allowed: boolean
  /** When running, PE UI may show (user toggle still applies if true). */
  uiAllowed: boolean
  raw: SceneFeatureToggle | 'default'
}

function parseFeatureToggle(raw: unknown): SceneFeatureToggle | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  if (v === 'enabled') return 'enabled'
  if (v === 'disabled') return 'disabled'
  if (v === 'hideui') return 'hideUi'
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

export function resolvePortableExperiencesPolicy(metadata: SceneMetadata): PortableExperiencesPolicy {
  const url = readPortableExperiencesUrlOverride()
  const fromScene = parseFeatureToggle(metadata.featureToggles?.portableExperiences)
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
