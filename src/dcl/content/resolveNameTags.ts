/**
 * Overhead avatar name tags — scene.json + URL debug override.
 *
 * Prefer deploy path (verify Catalyst stores unknown keys):
 *   "featureToggles": { "nameTags": "disabled" }
 *
 * Top-level alias:
 *   "nameTags": "disabled" | { "enabled": false }
 *
 * URL (wins for local QA):
 *   ?nameTags=disabled | ?nameTags=0 | ?nameTags=enabled | ?nameTags=1
 */
import type { SceneFeatureToggle, SceneMetadata } from './types'

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
  if (v === '1' || v === 'true' || v === 'yes' || v === 'enabled' || v === 'on' || v === 'show') {
    return true
  }
  if (v === '0' || v === 'false' || v === 'no' || v === 'disabled' || v === 'off' || v === 'hide') {
    return false
  }
  return null
}

/** Dev override — `?nameTags=disabled` / `?nameTags=enabled` (or bool aliases). */
export function readNameTagsUrlOverride(): boolean | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  for (const key of ['nameTags', 'nametags', 'name-tags'] as const) {
    const parsed = parseBoolQuery(params.get(key))
    if (parsed !== null) return parsed
    const raw = params.get(key)?.trim()
    if (raw) {
      console.warn(
        `[nameTags] Unrecognized ?${key}= value "${raw}" — use enabled, disabled, 1, 0, show, or hide`
      )
    }
  }
  return null
}

function toggleToVisible(toggle: SceneFeatureToggle | null): boolean | null {
  if (toggle === 'disabled' || toggle === 'hideUi') return false
  if (toggle === 'enabled') return true
  return null
}

function readNameTagsFromMetadata(metadata: SceneMetadata): boolean {
  // 1) Official-shaped deploy path — featureToggles.nameTags
  const fromFeature = toggleToVisible(parseFeatureToggle(metadata.featureToggles?.nameTags))
  if (fromFeature !== null) return fromFeature

  // 2) Top-level alias
  const direct = metadata.nameTags
  if (direct && typeof direct === 'object') {
    if (direct.enabled === false || direct.disabled === true) return false
    if (direct.enabled === true || direct.disabled === false) return true
  }
  const fromTop = toggleToVisible(parseFeatureToggle(direct))
  if (fromTop !== null) return fromTop

  return true
}

/** Whether overhead name tags should render — URL override wins, then scene.json. */
export function resolveNameTagsVisible(metadata: SceneMetadata): boolean {
  const url = readNameTagsUrlOverride()
  if (url !== null) return url
  return readNameTagsFromMetadata(metadata)
}
