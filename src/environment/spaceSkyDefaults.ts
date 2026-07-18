import type { SceneSpaceConfig } from '../dcl/content/types'

/** Resolved space look after defaults + clamps. */
export type ResolvedSpaceSettings = {
  skyColor: string
  nebulaColor: string
  starDensity: number
  starBrightness: number
  stars: boolean
  fogDensity: number
  ambient: number
  rimColor: string
  rimIntensity: number
  twinkle: number
}

export const SPACE_SKY_DEFAULTS: ResolvedSpaceSettings = {
  skyColor: '#020208',
  nebulaColor: '#1a0a3a',
  starDensity: 0.65,
  starBrightness: 1,
  stars: true,
  fogDensity: 0.008,
  ambient: 0.35,
  rimColor: '#6ecbff',
  rimIntensity: 0.85,
  twinkle: 1
}

/** Named looks for the editor preset chips. */
export const SPACE_SKY_PRESETS: { id: string; label: string; space: SceneSpaceConfig }[] = [
  {
    id: 'void',
    label: 'Deep void',
    space: {
      skyColor: '#020208',
      nebulaColor: '#0a0618',
      starDensity: 0.55,
      starBrightness: 0.9,
      stars: true,
      fogDensity: 0.004,
      ambient: 0.22,
      rimColor: '#8ab4ff',
      rimIntensity: 0.55,
      twinkle: 0.7
    }
  },
  {
    id: 'nebula',
    label: 'Violet nebula',
    space: {
      skyColor: '#0a0418',
      nebulaColor: '#5b1d8a',
      starDensity: 0.75,
      starBrightness: 1.15,
      stars: true,
      fogDensity: 0.012,
      ambient: 0.45,
      rimColor: '#d48cff',
      rimIntensity: 1.1,
      twinkle: 1.2
    }
  },
  {
    id: 'cyber',
    label: 'Cyber teal',
    space: {
      skyColor: '#020a0e',
      nebulaColor: '#063545',
      starDensity: 0.7,
      starBrightness: 1.05,
      stars: true,
      fogDensity: 0.01,
      ambient: 0.4,
      rimColor: '#3dffe8',
      rimIntensity: 1.25,
      twinkle: 1.4
    }
  },
  {
    id: 'ember',
    label: 'Ember star',
    space: {
      skyColor: '#0c0402',
      nebulaColor: '#4a1208',
      starDensity: 0.5,
      starBrightness: 0.85,
      stars: true,
      fogDensity: 0.014,
      ambient: 0.38,
      rimColor: '#ff8a4c',
      rimIntensity: 1.35,
      twinkle: 0.9
    }
  },
  {
    id: 'aurora',
    label: 'Aurora',
    space: {
      skyColor: '#030812',
      nebulaColor: '#0d3b2e',
      starDensity: 0.8,
      starBrightness: 1.25,
      stars: true,
      fogDensity: 0.009,
      ambient: 0.5,
      rimColor: '#7dffb3',
      rimIntensity: 1.15,
      twinkle: 1.6
    }
  }
]

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

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

export function resolveSpaceSettings(raw?: SceneSpaceConfig | null): ResolvedSpaceSettings {
  const d = SPACE_SKY_DEFAULTS
  if (!raw || typeof raw !== 'object') return { ...d }
  return {
    skyColor: hexOr(raw.skyColor, d.skyColor),
    nebulaColor: hexOr(raw.nebulaColor, d.nebulaColor),
    starDensity: clamp(raw.starDensity as number, 0, 1, d.starDensity),
    starBrightness: clamp(raw.starBrightness as number, 0, 2, d.starBrightness),
    stars: raw.stars !== false,
    fogDensity: clamp(raw.fogDensity as number, 0, 0.05, d.fogDensity),
    ambient: clamp(raw.ambient as number, 0, 2, d.ambient),
    rimColor: hexOr(raw.rimColor, d.rimColor),
    rimIntensity: clamp(raw.rimIntensity as number, 0, 3, d.rimIntensity),
    twinkle: clamp(raw.twinkle as number, 0, 4, d.twinkle)
  }
}
