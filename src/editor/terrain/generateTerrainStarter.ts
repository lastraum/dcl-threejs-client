/**
 * Pure terrain starter generators — Minecraft-like height starters for the sculpt buffers.
 * Platform law: local deterministic only; bake still goes through existing Save → terrain.glb.
 */
import { simplex2d } from '../../dcl/landscape/simplex2d'
import { mulberry32 } from '../../dcl/landscape/Utils/SeededRandom'
import { PARCEL_SIZE } from '../../dcl/content/types'
import {
  GENESIS_HEIGHTMAP_MAX_METERS,
  TERRAIN_SEA_FLOOR_WORLD_Y
} from './terrainSculptConstants'
import type { SceneEnvironmentKind } from '../../dcl/content/types'

export type TerrainStarterTemplateId = 'flat-land' | 'rolling-hills' | 'island' | 'desert-ridges'

export type TerrainStarterTemplateMeta = {
  id: TerrainStarterTemplateId
  label: string
  emoji: string
  tip: string
  /** Optional biome dock kind when “Match biome backdrop” is on. */
  matchKind: SceneEnvironmentKind
}

export const TERRAIN_STARTER_TEMPLATES: readonly TerrainStarterTemplateMeta[] = [
  {
    id: 'flat-land',
    label: 'Flat Land',
    emoji: '🟫',
    tip: 'Near-flat ground — good blank canvas',
    matchKind: 'land'
  },
  {
    id: 'rolling-hills',
    label: 'Rolling Hills',
    emoji: '⛰',
    tip: 'Gentle hills and grass',
    matchKind: 'forest'
  },
  {
    id: 'island',
    label: 'Island',
    emoji: '🏝',
    tip: 'Shore falloff + higher interior',
    matchKind: 'island'
  },
  {
    id: 'desert-ridges',
    label: 'Desert Ridges',
    emoji: '🏜',
    tip: 'Sandy ridges and dunes',
    matchKind: 'desert'
  }
] as const

export type TerrainStarterResult = {
  heights: Float32Array
  /** RGBA splat weights 0–255 (ch0 grass, ch1 dirt, ch2 rock, ch3 sand). */
  splat: Uint8Array
  lava: Uint8Array
  grass: Uint8Array
  grassRgb: Uint8Array
}

export type GenerateTerrainStarterOpts = {
  templateId: TerrainStarterTemplateId
  /** u32 seed (from number or seedFromString). */
  seed: number
  resolution: number
  /**
   * Scene footprint in DCL meters (from sceneWorldBounds / parcels).
   * Starters cover the full multi-parcel arena — not a single 16×16 only.
   */
  widthM: number
  depthM: number
}

/** Approx parcel span of a footprint (DCL parcel = 16m). */
export function footprintParcelSpan(widthM: number, depthM: number): {
  cols: number
  rows: number
  parcels: number
} {
  const cols = Math.max(1, Math.round(widthM / PARCEL_SIZE))
  const rows = Math.max(1, Math.round(depthM / PARCEL_SIZE))
  return { cols, rows, parcels: cols * rows }
}

/** FNV-1a-ish string → u32 for human seeds (“pizza-island”). */
export function seedFromString(input: string): number {
  const s = input.trim()
  if (!s) return 1
  const asNum = Number(s)
  if (Number.isFinite(asNum) && /^-?\d+$/.test(s)) {
    return (asNum >>> 0) || 1
  }
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) || 1
}

export function randomTerrainSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1
}

function fbm2(x: number, y: number, octaves: number, seedOff: number): number {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum +=
      amp *
      simplex2d(x * freq + seedOff * 0.0017 + i * 19.1, y * freq + seedOff * 0.0023 + i * 11.7)
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return norm > 0 ? sum / norm : 0
}

/** Absolute ridge noise (ridged multifractal-ish). */
function ridge2(x: number, y: number, octaves: number, seedOff: number): number {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    const n = simplex2d(x * freq + seedOff * 0.0011 + i * 7.3, y * freq + seedOff * 0.0019 + i * 13.9)
    const r = 1 - Math.abs(n)
    sum += amp * r * r
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return norm > 0 ? sum / norm : 0
}

function clampHeight(y: number): number {
  return Math.max(
    TERRAIN_SEA_FLOOR_WORLD_Y,
    Math.min(GENESIS_HEIGHTMAP_MAX_METERS, y)
  )
}

/**
 * Generate sculpt buffers for a starter template. Pure: no Three.js / no session.
 * Deterministic for the same (templateId, seed, resolution, footprint meters).
 *
 * **Parcel size:** `widthM` × `depthM` is the full scene footprint (1×1 = 16×16m,
 * 3×2 = 48×32m, …). Heights cover the whole arena; noise uses **world meters** so
 * hill/dune wavelength stays similar across small and large multi-parcel scenes.
 */
export function generateTerrainStarter(opts: GenerateTerrainStarterOpts): TerrainStarterResult {
  const res = opts.resolution
  const n = res * res
  const seed = (opts.seed >>> 0) || 1
  const widthM = Math.max(PARCEL_SIZE, opts.widthM)
  const depthM = Math.max(PARCEL_SIZE, opts.depthM)
  const heights = new Float32Array(n)
  const splat = new Uint8Array(n * 4)
  const lava = new Uint8Array(n)
  const grass = new Uint8Array(n)
  const grassRgb = new Uint8Array(n * 3)
  const rng = mulberry32(seed ^ 0x9e3779b9)

  // Noise wavelengths in meters (parcel-invariant feature size).
  const HILL_WAVE_M = 28
  const DETAIL_WAVE_M = 11
  const RIDGE_WAVE_M = 32
  const DUNE_WAVE_M = 18
  // Island: fall off relative to the smaller footprint half-extent (fits multi-parcel).
  const halfMinM = Math.min(widthM, depthM) * 0.5
  const islandRadiusM = Math.max(PARCEL_SIZE * 0.45, halfMinM * 0.92)

  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const i = iz * res + ix
      const u = res <= 1 ? 0.5 : ix / (res - 1)
      const v = res <= 1 ? 0.5 : iz / (res - 1)
      // Footprint-local meters from SW corner, then centered.
      const wx = u * widthM
      const wz = v * depthM
      const cx = wx - widthM * 0.5
      const cz = wz - depthM * 0.5
      // World-metric noise coords (same hill size on 1×1 and 4×4).
      const nxHill = cx / HILL_WAVE_M
      const nzHill = cz / HILL_WAVE_M
      const nxDetail = cx / DETAIL_WAVE_M
      const nzDetail = cz / DETAIL_WAVE_M
      const distM = Math.hypot(cx, cz)
      const radial = Math.min(1.25, distM / islandRadiusM)

      let h = TERRAIN_SEA_FLOOR_WORLD_Y
      // splat channels: g,d,r,s
      let g = 0
      let d = 0
      let r = 0
      let s = 0
      let grassD = 0

      switch (opts.templateId) {
        case 'flat-land': {
          const micro = fbm2(nxDetail * 1.2, nzDetail * 1.2, 2, seed) * 0.15
          h = clampHeight(0.35 + micro)
          g = 180
          d = 40
          r = 20
          s = 15
          grassD = 40
          break
        }
        case 'rolling-hills': {
          const hills = fbm2(nxHill, nzHill, 5, seed)
          const detail = fbm2(nxDetail, nzDetail, 3, seed ^ 0x55) * 0.35
          h = clampHeight(2.5 + (hills * 0.5 + 0.5) * 14 + detail * 3)
          if (h < 3) {
            s = 160
            g = 60
            d = 40
          } else if (h < 10) {
            g = 200
            d = 40
            r = 15
            grassD = Math.min(255, 80 + Math.floor((h - 3) * 12))
          } else {
            g = 100
            d = 50
            r = 120
            grassD = 30
          }
          break
        }
        case 'island': {
          const base = fbm2(nxHill * 0.95, nzHill * 0.95, 4, seed)
          const peak = (base * 0.5 + 0.5) * 18 + 1.5
          // Falloff to sea at footprint edges (scales with multi-parcel radius).
          const fall = Math.pow(Math.max(0, 1 - radial * 1.02), 1.65)
          h = clampHeight(peak * fall)
          if (h < 1.2) {
            h = TERRAIN_SEA_FLOOR_WORLD_Y
            s = 200
            g = 20
            d = 30
            r = 10
          } else if (h < 4) {
            s = 180
            g = 50
            d = 40
            grassD = 20
          } else if (h < 12) {
            g = 190
            d = 45
            r = 25
            s = 20
            grassD = Math.min(255, 90 + Math.floor(h * 6))
          } else {
            g = 80
            d = 40
            r = 150
            grassD = 15
          }
          break
        }
        case 'desert-ridges': {
          const rid = ridge2(cx / RIDGE_WAVE_M, cz / RIDGE_WAVE_M, 4, seed)
          const dunes =
            fbm2(cx / DUNE_WAVE_M + 3, cz / (DUNE_WAVE_M * 2.2), 3, seed ^ 0xaa) * 0.4
          h = clampHeight(1.2 + rid * 12 + dunes * 4)
          s = 200
          d = 40
          r = Math.min(255, 30 + Math.floor(rid * 100))
          g = 10
          grassD = 0
          break
        }
        default:
          h = TERRAIN_SEA_FLOOR_WORLD_Y
          g = 128
      }

      heights[i] = h
      const sum = g + d + r + s || 1
      splat[i * 4] = Math.min(255, Math.round((g / sum) * 255))
      splat[i * 4 + 1] = Math.min(255, Math.round((d / sum) * 255))
      splat[i * 4 + 2] = Math.min(255, Math.round((r / sum) * 255))
      splat[i * 4 + 3] = Math.min(255, Math.round((s / sum) * 255))
      lava[i] = 0
      grass[i] = Math.min(255, Math.max(0, grassD + Math.floor((rng() - 0.5) * 20)))
      // Default plant tint (warm green-brown); user can repaint Grass tab
      if (grass[i]! > 20) {
        grassRgb[i * 3] = 0xd4
        grassRgb[i * 3 + 1] = 0x48
        grassRgb[i * 3 + 2] = 0x31
      }
    }
  }

  return { heights, splat, lava, grass, grassRgb }
}

export function templateMeta(id: TerrainStarterTemplateId): TerrainStarterTemplateMeta {
  return (
    TERRAIN_STARTER_TEMPLATES.find((t) => t.id === id) ?? TERRAIN_STARTER_TEMPLATES[0]!
  )
}
