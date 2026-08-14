import type { SceneDesertConfig } from '../dcl/content/types'

export type ResolvedDesertSettings = {
  sandColor: string
  rockDensity: number
  perlinScale: number
  perlinThreshold: number
  haze: number
  dustStorm: boolean
  dustIntensity: number
  tumbleweeds: boolean
  tumbleweedCount: number
  /** Dust / tumbleweeds spawn on scene parcels as well as outer dunes. */
  acrossParcels: boolean
  dunes: boolean
  /** When false (default), dune height is flattened under scene parcels. */
  dunesOnParcels: boolean
  duneHeight: number
  duneWidth: number
  duneLength: number
  duneWindDeg: number
  duneRipple: number
}

export const DESERT_DEFAULTS: ResolvedDesertSettings = {
  sandColor: '#d4a858',
  rockDensity: 1,
  perlinScale: 0.55,
  perlinThreshold: 0.42,
  haze: 0.006,
  dustStorm: false,
  dustIntensity: 0.55,
  tumbleweeds: false,
  tumbleweedCount: 12,
  acrossParcels: true,
  dunes: true,
  dunesOnParcels: false,
  duneHeight: 1.1,
  duneWidth: 22,
  duneLength: 70,
  duneWindDeg: 25,
  duneRipple: 0.35
}

export const DESERT_PRESETS: { id: string; label: string; desert: SceneDesertConfig }[] = [
  {
    id: 'dunes',
    label: 'Golden dunes',
    desert: {
      sandColor: '#d4a858',
      rockDensity: 0.7,
      perlinScale: 0.45,
      perlinThreshold: 0.5,
      haze: 0.005,
      dustStorm: false,
      tumbleweeds: true,
      tumbleweedCount: 10,
      acrossParcels: true,
      dunes: true,
      dunesOnParcels: false,
      duneHeight: 0.9,
      duneWidth: 28,
      duneLength: 90,
      duneWindDeg: 20,
      duneRipple: 0.25
    }
  },
  {
    id: 'redrock',
    label: 'Red rock',
    desert: {
      sandColor: '#c47a4a',
      rockDensity: 1.6,
      perlinScale: 0.7,
      perlinThreshold: 0.35,
      haze: 0.008,
      dustStorm: false,
      tumbleweeds: false,
      acrossParcels: true,
      dunes: true,
      dunesOnParcels: false,
      duneHeight: 1.6,
      duneWidth: 16,
      duneLength: 55,
      duneWindDeg: 40,
      duneRipple: 0.2
    }
  },
  {
    id: 'storm',
    label: 'Dust storm',
    desert: {
      sandColor: '#c9a06a',
      rockDensity: 0.9,
      perlinScale: 0.55,
      perlinThreshold: 0.4,
      haze: 0.018,
      dustStorm: true,
      dustIntensity: 0.85,
      tumbleweeds: true,
      tumbleweedCount: 24,
      acrossParcels: true,
      dunes: true,
      dunesOnParcels: false,
      duneHeight: 1.3,
      duneWidth: 20,
      duneLength: 65,
      duneWindDeg: 15,
      duneRipple: 0.45
    }
  },
  {
    id: 'bleach',
    label: 'Bleached flats',
    desert: {
      sandColor: '#e8d5a8',
      rockDensity: 0.35,
      perlinScale: 0.3,
      perlinThreshold: 0.62,
      haze: 0.004,
      dustStorm: false,
      tumbleweeds: true,
      tumbleweedCount: 6,
      acrossParcels: false,
      dunes: false,
      dunesOnParcels: false,
      duneHeight: 0,
      duneWidth: 30,
      duneLength: 80,
      duneWindDeg: 0,
      duneRipple: 0
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

export function resolveDesertSettings(raw?: SceneDesertConfig | null): ResolvedDesertSettings {
  const d = DESERT_DEFAULTS
  if (!raw || typeof raw !== 'object') return { ...d }
  return {
    sandColor: hexOr(raw.sandColor, d.sandColor),
    rockDensity: clamp(raw.rockDensity as number, 0, 2, d.rockDensity),
    perlinScale: clamp(raw.perlinScale as number, 0.05, 2, d.perlinScale),
    perlinThreshold: clamp(raw.perlinThreshold as number, 0, 1, d.perlinThreshold),
    haze: clamp(raw.haze as number, 0, 0.04, d.haze),
    dustStorm: raw.dustStorm === true,
    dustIntensity: clamp(raw.dustIntensity as number, 0, 1, d.dustIntensity),
    tumbleweeds: raw.tumbleweeds === true,
    tumbleweedCount: Math.round(clamp(raw.tumbleweedCount as number, 0, 80, d.tumbleweedCount)),
    acrossParcels: raw.acrossParcels !== false,
    dunes: raw.dunes !== false,
    // Explicit true only — dunes stay off scene parcels by default.
    dunesOnParcels: raw.dunesOnParcels === true,
    duneHeight: clamp(raw.duneHeight as number, 0, 16, d.duneHeight),
    duneWidth: clamp(raw.duneWidth as number, 4, 80, d.duneWidth),
    duneLength: clamp(raw.duneLength as number, 8, 200, d.duneLength),
    duneWindDeg: clamp(raw.duneWindDeg as number, 0, 360, d.duneWindDeg),
    duneRipple: clamp(raw.duneRipple as number, 0, 1, d.duneRipple)
  }
}
