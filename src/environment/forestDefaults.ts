import type { SceneForestConfig } from '../dcl/content/types'
import { EMPTY_LAND } from '../dcl/landscape/Data/EmptyLandCatalog'

export type ResolvedForestSettings = {
  /** Floor plane color (land-style solid expanse). */
  groundColor: string
  /** Outer ez-tree grass blade tint (not paint Ez Grass). */
  grassColor: string
  /** Parallel to EMPTY_LAND.trees */
  treeDensity: number[]
  /** Parallel to EMPTY_LAND.rocks */
  rockDensity: number[]
  bushDensity: number
}

export const FOREST_TREE_LABELS = ['Tree A (coral)', 'Tree B (pink)', 'Tree C (green)'] as const
export const FOREST_ROCK_LABELS = ['Rock A', 'Rock B', 'Rock C'] as const

export const FOREST_DEFAULTS: ResolvedForestSettings = {
  /** Match empty-land RED_GRASS default. */
  groundColor: '#c43c2c',
  /** Same as EZ_TREE_GRASS_TINT / land grass default. */
  grassColor: '#d44831',
  treeDensity: EMPTY_LAND.trees.map(() => 1),
  rockDensity: EMPTY_LAND.rocks.map(() => 1),
  bushDensity: 1
}

function clamp01to2(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(2, n))
}

function resolveDensityArray(
  raw: number[] | undefined,
  length: number,
  fallback: number
): number[] {
  const out: number[] = []
  for (let i = 0; i < length; i++) {
    const v = raw && typeof raw[i] === 'number' ? raw[i]! : fallback
    out.push(clamp01to2(v, fallback))
  }
  return out
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

export function resolveForestSettings(raw?: SceneForestConfig | null): ResolvedForestSettings {
  return {
    groundColor: hexOr(raw?.groundColor, FOREST_DEFAULTS.groundColor),
    grassColor: hexOr(raw?.grassColor, FOREST_DEFAULTS.grassColor),
    treeDensity: resolveDensityArray(raw?.treeDensity, EMPTY_LAND.trees.length, 1),
    rockDensity: resolveDensityArray(raw?.rockDensity, EMPTY_LAND.rocks.length, 1),
    bushDensity: clamp01to2(
      typeof raw?.bushDensity === 'number' ? raw.bushDensity : FOREST_DEFAULTS.bushDensity,
      FOREST_DEFAULTS.bushDensity
    )
  }
}

/** Mean of densities — used to scale total prop counts. */
export function meanDensity(weights: readonly number[]): number {
  if (!weights.length) return 1
  let s = 0
  for (const w of weights) s += w
  return s / weights.length
}

/**
 * Weighted pick from hashes using parallel density weights.
 * Zero-weight entries are skipped; if all zero returns first hash.
 */
export function weightedPickHash(
  rng: () => number,
  hashes: readonly string[],
  weights: readonly number[]
): string {
  if (!hashes.length) return ''
  let sum = 0
  for (let i = 0; i < hashes.length; i++) {
    sum += Math.max(0, weights[i] ?? 1)
  }
  if (sum <= 1e-8) return hashes[0]!
  let t = rng() * sum
  for (let i = 0; i < hashes.length; i++) {
    t -= Math.max(0, weights[i] ?? 1)
    if (t <= 0) return hashes[i]!
  }
  return hashes[hashes.length - 1]!
}
