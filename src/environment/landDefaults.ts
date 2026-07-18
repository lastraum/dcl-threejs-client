import type { SceneLandConfig } from '../dcl/content/types'

export type ResolvedLandSettings = {
  groundColor: string
}

/** Default matches RED_GRASS empty-land look. */
export const LAND_DEFAULTS: ResolvedLandSettings = {
  groundColor: '#c43c2c'
}

export const LAND_COLOR_PRESETS: { id: string; label: string; groundColor: string }[] = [
  { id: 'red', label: 'Red grass', groundColor: '#c43c2c' },
  { id: 'meadow', label: 'Meadow', groundColor: '#5a9e4a' },
  { id: 'dry', label: 'Dry field', groundColor: '#a68b4b' },
  { id: 'dark', label: 'Dark soil', groundColor: '#3d4a2a' },
  { id: 'autumn', label: 'Autumn', groundColor: '#b86a2a' }
]

function hexOr(raw: string | undefined, fallback: string): string {
  if (!raw || typeof raw !== 'string') return fallback
  const t = raw.trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) {
    if (t.length === 4) {
      return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`.toLowerCase()
    }
    return t.toLowerCase()
  }
  if (/^[0-9a-f]{6}$/i.test(t)) return `#${t.toLowerCase()}`
  return fallback
}

export function resolveLandSettings(raw?: SceneLandConfig | null): ResolvedLandSettings {
  return {
    groundColor: hexOr(raw?.groundColor, LAND_DEFAULTS.groundColor)
  }
}
