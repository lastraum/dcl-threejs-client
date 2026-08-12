import type { SceneLandConfig } from '../dcl/content/types'

export type ResolvedLandSettings = {
  groundColor: string
  /** Outer ez-tree grass patch density (land biome only). 0 = none, 1 = default, 2 = dense. */
  grassDensity: number
  /** Outer ez-tree grass blade tint (land biome only). Not author paint. */
  grassColor: string
}

/** Default matches RED_GRASS empty-land look + ez-tree red blade tint. */
export const LAND_DEFAULTS: ResolvedLandSettings = {
  groundColor: '#c43c2c',
  grassDensity: 1,
  /** Same as EZ_TREE_GRASS_TINT_HEX / empty-parcel blade read. */
  grassColor: '#d44831'
}

function clampGrassDensity(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return LAND_DEFAULTS.grassDensity
  return Math.max(0, Math.min(2, raw))
}

export const LAND_COLOR_PRESETS: {
  id: string
  label: string
  groundColor: string
  /** Suggested outer grass blade tint for the preset. */
  grassColor: string
}[] = [
  { id: 'red', label: 'Red grass', groundColor: '#c43c2c', grassColor: '#d44831' },
  { id: 'meadow', label: 'Meadow', groundColor: '#5a9e4a', grassColor: '#6bb85a' },
  { id: 'dry', label: 'Dry field', groundColor: '#a68b4b', grassColor: '#c4a85a' },
  { id: 'dark', label: 'Dark soil', groundColor: '#3d4a2a', grassColor: '#4a6b3a' },
  { id: 'autumn', label: 'Autumn', groundColor: '#b86a2a', grassColor: '#c97a3a' }
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
    groundColor: hexOr(raw?.groundColor, LAND_DEFAULTS.groundColor),
    grassDensity: clampGrassDensity(raw?.grassDensity),
    grassColor: hexOr(raw?.grassColor, LAND_DEFAULTS.grassColor)
  }
}
