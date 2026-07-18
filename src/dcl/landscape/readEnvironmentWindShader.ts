import type { SceneEnvironmentConfig, SceneMetadata } from '../content/types'

function parseBoolLoose(value: unknown): boolean | null {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  }
  return null
}

function readUrlWindShaderOverride(): boolean | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  return parseBoolLoose(params.get('windShader') ?? params.get('windshader'))
}

/**
 * Resolve whether the custom ez-tree grass wind vertex shader should run.
 *
 * Priority:
 * 1. URL `?windShader=0|1` (dev override)
 * 2. `scene.json` → `environment.windShader` (explicit true/false)
 * 3. Default **on** for client grass (same as original ez-tree path) —
 *    set `"windShader": false` to disable.
 *
 * ThreejsClient-only field — Unity/Godot Explorer ignore it.
 */
export function readEnvironmentWindShader(metadata?: SceneMetadata | null): boolean {
  const url = readUrlWindShaderOverride()
  if (url !== null) return url

  const env = metadata?.environment
  if (env && typeof env === 'object') {
    const raw = (env as SceneEnvironmentConfig).windShader
    if (raw !== undefined) {
      const parsed = parseBoolLoose(raw)
      if (parsed !== null) return parsed
    }
  }

  // Default on so land/forest grass always sways in the client without extra scene.json.
  return true
}
