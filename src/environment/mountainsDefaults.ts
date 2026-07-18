import type { SceneMountainsConfig } from '../dcl/content/types'

export type ResolvedMountainsSettings = {
  rockDensity: number
  treeDensity: number
  backdropDensity: number
  haze: number
  hazeColor: string
  peakSnow: boolean
}

export const MOUNTAINS_DEFAULTS: ResolvedMountainsSettings = {
  rockDensity: 1,
  treeDensity: 1,
  backdropDensity: 1,
  haze: 0.01,
  hazeColor: '#9bb0c4',
  peakSnow: true
}

export const MOUNTAINS_PRESETS: { id: string; label: string; mountains: SceneMountainsConfig }[] = [
  {
    id: 'alpine',
    label: 'Alpine',
    mountains: {
      rockDensity: 1.1,
      treeDensity: 0.7,
      backdropDensity: 1.2,
      haze: 0.012,
      hazeColor: '#a8c0d8',
      peakSnow: true
    }
  },
  {
    id: 'craggy',
    label: 'Craggy',
    mountains: {
      rockDensity: 1.8,
      treeDensity: 0.35,
      backdropDensity: 1.5,
      haze: 0.008,
      hazeColor: '#8a9aaa',
      peakSnow: false
    }
  },
  {
    id: 'misty',
    label: 'Misty peaks',
    mountains: {
      rockDensity: 0.9,
      treeDensity: 1.2,
      backdropDensity: 0.8,
      haze: 0.022,
      hazeColor: '#c5d2dc',
      peakSnow: true
    }
  },
  {
    id: 'sparse',
    label: 'Sparse ridge',
    mountains: {
      rockDensity: 0.5,
      treeDensity: 0.4,
      backdropDensity: 0.6,
      haze: 0.006,
      hazeColor: '#b0c0cc',
      peakSnow: true
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

export function resolveMountainsSettings(
  raw?: SceneMountainsConfig | null
): ResolvedMountainsSettings {
  const d = MOUNTAINS_DEFAULTS
  if (!raw || typeof raw !== 'object') return { ...d }
  return {
    rockDensity: clamp(raw.rockDensity as number, 0, 2, d.rockDensity),
    treeDensity: clamp(raw.treeDensity as number, 0, 2, d.treeDensity),
    backdropDensity: clamp(raw.backdropDensity as number, 0, 2, d.backdropDensity),
    haze: clamp(raw.haze as number, 0, 0.04, d.haze),
    hazeColor: hexOr(raw.hazeColor, d.hazeColor),
    peakSnow: raw.peakSnow !== false
  }
}
