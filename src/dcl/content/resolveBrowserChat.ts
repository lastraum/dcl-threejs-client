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
  if (v === '1' || v === 'true' || v === 'yes' || v === 'enabled') return true
  if (v === '0' || v === 'false' || v === 'no' || v === 'disabled') return false
  return null
}

/** Dev override — `?browserChat=disabled` / `?browserChat=enabled` (or bool aliases). */
export function readBrowserChatUrlOverride(): boolean | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const parsed = parseBoolQuery(params.get('browserChat'))
  if (parsed !== null) return parsed
  const raw = params.get('browserChat')?.trim()
  if (raw) {
    console.warn(
      `[browserChat] Unrecognized ?browserChat= value "${raw}" — use enabled, disabled, 1, or 0`
    )
  }
  return null
}

function readBrowserChatFromMetadata(metadata: SceneMetadata): boolean {
  const direct = metadata.browserChat
  if (direct && typeof direct === 'object') {
    if (direct.enabled === false || direct.disabled === true) return false
    if (direct.enabled === true || direct.disabled === false) return true
  }
  const directToggle = parseFeatureToggle(direct)
  if (directToggle === 'disabled') return false
  if (directToggle === 'enabled') return true

  const toggle = parseFeatureToggle(metadata.featureToggles?.browserChat)
  if (toggle === 'disabled') return false
  if (toggle === 'enabled') return true

  return true
}

/** Whether browser scene chat is allowed — URL override wins, then scene.json feature toggles. */
export function resolveBrowserChatEnabled(metadata: SceneMetadata): boolean {
  const url = readBrowserChatUrlOverride()
  if (url !== null) return url
  return readBrowserChatFromMetadata(metadata)
}