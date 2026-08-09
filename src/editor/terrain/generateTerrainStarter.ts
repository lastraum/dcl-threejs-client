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
    tip: 'Large main island + smaller satellites barely connected',
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

/** Soft elliptical land blob — 1 at centre, 0 outside rim. */
type IslandBlob = {
  x: number
  z: number
  rx: number
  rz: number
  /** Extra peak height on this mass (metres above base plateau). */
  peakBoost: number
}

function blobLand01(cx: number, cz: number, b: IslandBlob): number {
  const nx = (cx - b.x) / Math.max(0.5, b.rx)
  const nz = (cz - b.z) / Math.max(0.5, b.rz)
  const d = Math.hypot(nx, nz)
  // Solid interior, soft beach rim, hard zero past ~1.08.
  if (d >= 1.08) return 0
  if (d <= 0.55) return 1
  return smooth01((1.08 - d) / (1.08 - 0.55))
}

/**
 * Main landmass + 2–4 satellites placed so rims barely touch / thin isthmuses.
 * Centres are footprint-relative (0,0 = arena centre).
 */
function buildIslandArchipelago(
  widthM: number,
  depthM: number,
  seed: number
): IslandBlob[] {
  const rng = mulberry32(seed ^ 0xc001d00d)
  const halfW = widthM * 0.5
  const halfD = depthM * 0.5
  const minHalf = Math.min(halfW, halfD)

  // Main island: large, slightly off-centre — dominant mass in the arena.
  const mainRx = minHalf * (0.58 + rng() * 0.1)
  const mainRz = minHalf * (0.54 + rng() * 0.1)
  const main: IslandBlob = {
    x: (rng() - 0.5) * halfW * 0.12,
    z: (rng() - 0.5) * halfD * 0.12,
    rx: mainRx,
    rz: mainRz,
    peakBoost: 5 + rng() * 7
  }
  const blobs: IslandBlob[] = [main]

  const satCount = 2 + Math.floor(rng() * 3) // 2–4
  for (let i = 0; i < satCount; i++) {
    const ang = rng() * Math.PI * 2 + i * 0.7
    // Satellite size: clearly smaller than main.
    const satRx = minHalf * (0.16 + rng() * 0.12)
    const satRz = minHalf * (0.14 + rng() * 0.12)
    // Place so soft rims barely connect (slight radius overlap → thin land bridge).
    const mainReach = (mainRx + mainRz) * 0.5
    const satReach = (satRx + satRz) * 0.5
    const overlapM = 2 + rng() * 4 // barely connecting isthmus
    let dist = mainReach + satReach - overlapM
    dist = Math.max(mainReach * 0.65, dist)

    let sx = main.x + Math.cos(ang) * dist
    let sz = main.z + Math.sin(ang) * dist
    // Keep satellite footprint inside the arena with a small water margin.
    const margin = Math.max(2.5, minHalf * 0.06)
    sx = Math.max(-halfW + margin + satRx * 0.35, Math.min(halfW - margin - satRx * 0.35, sx))
    sz = Math.max(-halfD + margin + satRz * 0.35, Math.min(halfD - margin - satRz * 0.35, sz))

    blobs.push({
      x: sx,
      z: sz,
      rx: satRx,
      rz: satRz,
      peakBoost: 2 + rng() * 4
    })
  }
  return blobs
}

function landMaskFromBlobs(cx: number, cz: number, blobs: IslandBlob[]): {
  land: number
  peakBoost: number
} {
  let land = 0
  let peakBoost = 0
  for (const b of blobs) {
    const w = blobLand01(cx, cz, b)
    if (w > land) {
      land = w
      peakBoost = b.peakBoost
    } else if (w > 0.35) {
      // Bridges / overlaps pick up a little extra height.
      peakBoost = Math.max(peakBoost, b.peakBoost * 0.35)
    }
  }
  return { land, peakBoost }
}

/**
 * Generate sculpt buffers for a starter template. Pure: no Three.js / no session.
 * Deterministic for the same (templateId, seed, resolution, footprint meters).
 * Does **not** change environment.kind — starters only rewrite sculpt buffers.
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

  const halfMinM = Math.min(widthM, depthM) * 0.5
  const beachWidthM = Math.min(7, Math.max(3.5, halfMinM * 0.14))

  // Island archipelago (main + satellites) — only used by island template.
  const islandBlobs =
    opts.templateId === 'island' ? buildIslandArchipelago(widthM, depthM, seed) : []

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
          // Archipelago: one large island + smaller satellites barely connected.
          // Works on any biome (height only) — does not require island environment.kind.
          const { land, peakBoost } = landMaskFromBlobs(cx, cz, islandBlobs)
          const hills = fbm2(nxHill * 0.95, nzHill * 0.95, 4, seed)
          const detail = fbm2(nxDetail * 0.85, nzDetail * 0.85, 3, seed ^ 0x11) * 0.4
          const sea = TERRAIN_SEA_FLOOR_WORLD_Y
          const msl = ARENA_WATER_SURFACE_Y

          if (land < 0.04) {
            // Open water between islands
            h = clampHeight(sea + fbm2(nxDetail * 0.4, nzDetail * 0.4, 2, seed) * 0.15)
            s = 40
            g = 5
            d = 10
            r = 5
            grassD = 0
          } else {
            const beach = land < 0.38
            const plateau =
              msl +
              2.2 +
              peakBoost * land +
              (hills * 0.5 + 0.5) * 5 * land +
              detail * land
            // Soft ramp from seafloor through beach into interior.
            h = clampHeight(sea + (plateau - sea) * smooth01((land - 0.04) / 0.55))

            if (beach || h < msl + 0.9) {
              s = 215
              g = 20
              d = 30
              r = 8
              grassD = 5
              // Keep a wet shoulder slightly under / at MSL on the outer rim.
              if (land < 0.18) h = clampHeight(Math.min(h, msl - 0.05 + land * 0.8))
            } else if (h < msl + 5) {
              s = 70
              g = 150
              d = 45
              r = 20
              grassD = 55
            } else if (h < msl + 12) {
              g = 200
              d = 40
              r = 35
              s = 15
              grassD = Math.min(255, 100 + Math.floor(h * 4))
            } else {
              g = 70
              d = 45
              r = 155
              s = 10
              grassD = 18
            }
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
