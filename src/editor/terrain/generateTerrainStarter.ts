/**
 * Pure terrain starter generators — Minecraft-like height starters for the sculpt buffers.
 * Platform law: local deterministic only; bake still goes through existing Save → terrain.glb.
 *
 * Design goals:
 * - Fill the **parcel footprint** (not a tiny blob in the middle).
 * - Coherent biomes (one clear idea per starter).
 * - Island: land to near edges, short beach apron.
 * - Mountain range: large massifs + cliff faces, not gentle noise.
 */
import { simplex2d } from '../../dcl/landscape/simplex2d'
import { mulberry32 } from '../../dcl/landscape/Utils/SeededRandom'
import { PARCEL_SIZE } from '../../dcl/content/types'
import {
  ARENA_WATER_SURFACE_Y,
  GENESIS_HEIGHTMAP_MAX_METERS,
  TERRAIN_SEA_FLOOR_WORLD_Y
} from './terrainSculptConstants'
import type { SceneEnvironmentKind } from '../../dcl/content/types'

export type TerrainStarterTemplateId =
  | 'flat-land'
  | 'rolling-hills'
  | 'island'
  | 'desert-ridges'
  | 'mountain-range'

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
    tip: 'Near-flat ground — blank canvas',
    matchKind: 'land'
  },
  {
    id: 'rolling-hills',
    label: 'Rolling Hills',
    emoji: '⛰',
    tip: 'Broad grassy hills across the full footprint',
    matchKind: 'forest'
  },
  {
    id: 'island',
    label: 'Island',
    emoji: '🏝',
    tip: 'Fills parcels with land; short beach at the edges',
    matchKind: 'island'
  },
  {
    id: 'desert-ridges',
    label: 'Desert Ridges',
    emoji: '🏜',
    tip: 'Long sand ridges and dunes',
    matchKind: 'desert'
  },
  {
    id: 'mountain-range',
    label: 'Mountain Range',
    emoji: '🏔',
    tip: 'Large peaks, valleys, and cliff faces',
    matchKind: 'mountains'
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
  return Math.max(TERRAIN_SEA_FLOOR_WORLD_Y, Math.min(GENESIS_HEIGHTMAP_MAX_METERS, y))
}

function smooth01(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

/**
 * Distance to nearest footprint edge (metres). 0 on border, larger inland.
 * Keeps starters filling the **rectangle** of parcels, not a floating disc.
 */
function distToEdgeM(wx: number, wz: number, widthM: number, depthM: number): number {
  return Math.min(wx, widthM - wx, wz, depthM - wz)
}

/**
 * Generate sculpt buffers for a starter template. Pure: no Three.js / no session.
 * Deterministic for the same (templateId, seed, resolution, footprint meters).
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
  const HILL_WAVE_M = 22
  const DETAIL_WAVE_M = 9
  const RIDGE_WAVE_M = 28
  const DUNE_WAVE_M = 16
  // Mountains: very large massifs + mid cliff ridges.
  const MASSIF_WAVE_M = Math.max(36, Math.min(widthM, depthM) * 0.55)
  const CLIFF_WAVE_M = Math.max(14, Math.min(widthM, depthM) * 0.22)

  // Island beach only on the outer few metres so land owns most of the parcels.
  const halfMinM = Math.min(widthM, depthM) * 0.5
  const beachWidthM = Math.min(7, Math.max(3.5, halfMinM * 0.14))

  // Range orientation (seeded): mountain spine runs along this axis.
  const spineAngle = (seed % 360) * (Math.PI / 180)
  const cosA = Math.cos(spineAngle)
  const sinA = Math.sin(spineAngle)

  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const i = iz * res + ix
      const u = res <= 1 ? 0.5 : ix / (res - 1)
      const v = res <= 1 ? 0.5 : iz / (res - 1)
      const wx = u * widthM
      const wz = v * depthM
      const cx = wx - widthM * 0.5
      const cz = wz - depthM * 0.5
      const edgeM = distToEdgeM(wx, wz, widthM, depthM)

      const nxHill = cx / HILL_WAVE_M
      const nzHill = cz / HILL_WAVE_M
      const nxDetail = cx / DETAIL_WAVE_M
      const nzDetail = cz / DETAIL_WAVE_M

      // Spine-aligned coords for mountain range.
      const along = cx * cosA + cz * sinA
      const across = -cx * sinA + cz * cosA

      let h = TERRAIN_SEA_FLOOR_WORLD_Y
      let g = 0
      let d = 0
      let r = 0
      let s = 0
      let grassD = 0

      switch (opts.templateId) {
        case 'flat-land': {
          // Dry ground above MSL (untouched default heightmap is seafloor under ocean).
          const micro = fbm2(nxDetail * 1.2, nzDetail * 1.2, 2, seed) * 0.12
          h = clampHeight(ARENA_WATER_SURFACE_Y + 1.6 + micro)
          g = 190
          d = 35
          r = 15
          s = 10
          grassD = 55
          break
        }

        case 'rolling-hills': {
          // Broad hills elevated above MSL across the whole footprint.
          const hills = fbm2(nxHill * 0.85, nzHill * 0.85, 5, seed)
          const broad = fbm2(cx / (HILL_WAVE_M * 2.2), cz / (HILL_WAVE_M * 2.2), 3, seed ^ 0x33)
          const detail = fbm2(nxDetail, nzDetail, 3, seed ^ 0x55) * 0.4
          const base =
            ARENA_WATER_SURFACE_Y +
            4.5 +
            (broad * 0.5 + 0.5) * 8 +
            (hills * 0.5 + 0.5) * 10 +
            detail * 2.5
          const edgeKeep = smooth01(edgeM / Math.max(2, beachWidthM * 0.55))
          h = clampHeight(
            ARENA_WATER_SURFACE_Y + 0.8 + (base - ARENA_WATER_SURFACE_Y) * (0.35 + 0.65 * edgeKeep)
          )
          if (h < ARENA_WATER_SURFACE_Y + 3) {
            s = 40
            g = 160
            d = 50
            grassD = 50
          } else if (h < ARENA_WATER_SURFACE_Y + 11) {
            g = 210
            d = 35
            r = 20
            grassD = Math.min(255, 100 + Math.floor((h - ARENA_WATER_SURFACE_Y) * 10))
          } else {
            g = 90
            d = 45
            r = 130
            grassD = 25
          }
          break
        }

        case 'island': {
          // Land fills the rectangle; short beach apron at parcel edges (near MSL).
          // Interior: dry plateau — not a tiny mid-disc.
          const inland = smooth01((edgeM - beachWidthM * 0.15) / beachWidthM)
          const hills = fbm2(nxHill * 0.9, nzHill * 0.9, 5, seed)
          const peak = fbm2(cx / (HILL_WAVE_M * 1.6), cz / (HILL_WAVE_M * 1.6), 3, seed ^ 0x77)
          const detail = fbm2(nxDetail * 0.9, nzDetail * 0.9, 3, seed ^ 0x11) * 0.45
          const plateau =
            ARENA_WATER_SURFACE_Y +
            6.5 +
            (hills * 0.5 + 0.5) * 9 +
            (peak * 0.5 + 0.5) * 7 +
            detail
          // Beach sits just under / at MSL so open water can still lap the edge.
          const beachFloor =
            ARENA_WATER_SURFACE_Y -
            0.35 +
            fbm2(nxDetail * 0.6, nzDetail * 0.6, 2, seed) * 0.25
          h = clampHeight(beachFloor + (plateau - beachFloor) * inland)

          if (inland < 0.35 || h < ARENA_WATER_SURFACE_Y + 1.2) {
            s = 210
            g = 25
            d = 35
            r = 8
            grassD = 8
            if (inland < 0.08) h = clampHeight(Math.min(h, ARENA_WATER_SURFACE_Y - 0.1))
          } else if (h < ARENA_WATER_SURFACE_Y + 5) {
            s = 90
            g = 120
            d = 50
            r = 15
            grassD = 45
          } else if (h < ARENA_WATER_SURFACE_Y + 13) {
            g = 200
            d = 40
            r = 30
            s = 15
            grassD = Math.min(255, 110 + Math.floor(h * 5))
          } else {
            g = 70
            d = 45
            r = 160
            s = 10
            grassD = 20
          }
          break
        }

        case 'desert-ridges': {
          const rid = ridge2(cx / RIDGE_WAVE_M, cz / RIDGE_WAVE_M, 5, seed)
          const longRidges =
            ridge2(along / (RIDGE_WAVE_M * 1.4), across / (RIDGE_WAVE_M * 0.55), 4, seed ^ 0x42) *
            0.85
          const dunes =
            fbm2(cx / DUNE_WAVE_M + 3, cz / (DUNE_WAVE_M * 2.2), 3, seed ^ 0xaa) * 0.45
          const edgeKeep = smooth01(edgeM / 3)
          const base =
            ARENA_WATER_SURFACE_Y + 2.2 + rid * 10 + longRidges * 14 + dunes * 5
          h = clampHeight(
            ARENA_WATER_SURFACE_Y +
              0.5 +
              (base - ARENA_WATER_SURFACE_Y) * (0.4 + 0.6 * edgeKeep)
          )
          s = 210
          d = 35
          r = Math.min(255, 25 + Math.floor((rid + longRidges) * 90))
          g = 8
          grassD = 0
          break
        }

        case 'mountain-range': {
          // Large massif envelope along a seeded spine + sharp ridged cliffs.
          const massif = fbm2(along / MASSIF_WAVE_M, across / (MASSIF_WAVE_M * 1.15), 4, seed)
          const massifN = massif * 0.5 + 0.5
          const acrossNorm = Math.abs(across) / Math.max(12, halfMinM * 0.85)
          const rangeEnvelope = Math.pow(Math.max(0, 1 - acrossNorm * 0.95), 1.35)
          const peaks =
            Math.pow(
              Math.max(0, fbm2(along / (MASSIF_WAVE_M * 0.7), across / MASSIF_WAVE_M, 3, seed ^ 0x91)),
              1.4
            ) *
              0.5 +
            0.5
          const cliffRidge = ridge2(along / CLIFF_WAVE_M, across / (CLIFF_WAVE_M * 0.65), 5, seed ^ 0xcd)
          const cliffSharp = Math.pow(cliffRidge, 2.4)
          const scarp = Math.pow(
            Math.max(
              0,
              ridge2(across / (CLIFF_WAVE_M * 0.5) + 2.1, along / (CLIFF_WAVE_M * 1.2), 4, seed ^ 0x17)
            ),
            2.8
          )
          const detail = fbm2(nxDetail * 0.7, nzDetail * 0.7, 3, seed ^ 0x2a) * 0.5

          const valleyFloor = ARENA_WATER_SURFACE_Y + 3.5 + massifN * 4
          const mountainBody = rangeEnvelope * (22 + peaks * 38 + massifN * 18)
          const cliffs = rangeEnvelope * (cliffSharp * 28 + scarp * 22)
          const edgeKeep = smooth01(edgeM / Math.max(2.5, beachWidthM * 0.4))
          h = clampHeight(
            (valleyFloor + mountainBody + cliffs + detail * 3) * (0.25 + 0.75 * edgeKeep)
          )

          const cliffiness = cliffSharp * 0.55 + scarp * 0.45
          if (h > 55) {
            r = 200
            d = 40
            g = 15
            s = 20
            grassD = 0
          } else if (h > 28 || cliffiness > 0.45) {
            r = Math.min(255, 140 + Math.floor(cliffiness * 120))
            d = 60
            g = 25
            s = 15
            grassD = 5
          } else if (h > ARENA_WATER_SURFACE_Y + 12) {
            g = 100
            d = 80
            r = 90
            s = 20
            grassD = 35
          } else {
            g = 160
            d = 50
            r = 30
            s = 30
            grassD = 70
          }
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
      if (grass[i]! > 20) {
        grassRgb[i * 3] = 0xd4
        grassRgb[i * 3 + 1] = 0x48
        grassRgb[i * 3 + 2] = 0x31
      }
    }
  }

  // Mountain range: second pass — amplify cliff faces from local slope so
  // vertical walls read as rock bands (coherent massifs, not soft noise).
  if (opts.templateId === 'mountain-range' && res > 4) {
    const tmp = new Float32Array(heights)
    const cellW = widthM / Math.max(1, res - 1)
    const cellD = depthM / Math.max(1, res - 1)
    for (let iz = 1; iz < res - 1; iz++) {
      for (let ix = 1; ix < res - 1; ix++) {
        const i = iz * res + ix
        const hx = (tmp[iz * res + (ix + 1)]! - tmp[iz * res + (ix - 1)]!) / (2 * cellW)
        const hz = (tmp[(iz + 1) * res + ix]! - tmp[(iz - 1) * res + ix]!) / (2 * cellD)
        const slope = Math.sqrt(hx * hx + hz * hz)
        if (slope > 1.1) {
          // Steepen cliff: pull height toward higher of neighbors for a sharper face.
          const hi = Math.max(
            tmp[iz * res + (ix + 1)]!,
            tmp[iz * res + (ix - 1)]!,
            tmp[(iz + 1) * res + ix]!,
            tmp[(iz - 1) * res + ix]!
          )
          heights[i] = clampHeight(tmp[i]! * 0.55 + hi * 0.45)
          const o = i * 4
          // Force rock on steep cells.
          splat[o] = 20
          splat[o + 1] = 50
          splat[o + 2] = 200
          splat[o + 3] = 15
          grass[i] = 0
        }
      }
    }
  }

  return { heights, splat, lava, grass, grassRgb }
}

export function templateMeta(id: TerrainStarterTemplateId): TerrainStarterTemplateMeta {
  return TERRAIN_STARTER_TEMPLATES.find((t) => t.id === id) ?? TERRAIN_STARTER_TEMPLATES[0]!
}
