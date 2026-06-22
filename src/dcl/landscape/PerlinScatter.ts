import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import { PARCEL_SIZE } from '../content/types'
import type { LandscapeEnvironmentProfile } from './EnvironmentCatalog'
import { hashParcelCoords, mulberry32 } from './Utils/SeededRandom'
import { perlin01 } from './perlin2d'
import { buildInstancedScatter, type ScatterInstance } from './gltfInstancing'
import type { OuterScatterContext } from './Systems/InfiniteGround'

export type ScatterBounds = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

const LAND_TREE_SCALE = 0.85
const LAND_ROCK_SCALE = 0.75

function isInsideLandscape(worldX: number, worldZ: number, ctx: OuterScatterContext): boolean {
  const px = ctx.base.x + Math.floor(worldX / PARCEL_SIZE)
  const py = ctx.base.y + Math.floor(worldZ / PARCEL_SIZE)
  return ctx.landscapeKeys.has(`${px},${py}`)
}

/**
 * Perlin scatter on the outer land expanse only — skips border padding parcels.
 */
export async function buildPerlinInstancedScatter(
  cache: AssetCache,
  profile: LandscapeEnvironmentProfile,
  ctx: OuterScatterContext,
  sceneSeed: number,
  onProgress?: (msg: string) => void
): Promise<THREE.Group> {
  const root = new THREE.Group()
  root.name = 'landscape:perlin-scatter'

  const cell = 10
  const trees: ScatterInstance[] = []
  const rocks: ScatterInstance[] = []

  for (let z = ctx.minZ; z < ctx.maxZ; z += cell) {
    for (let x = ctx.minX; x < ctx.maxX; x += cell) {
      if (isInsideLandscape(x, z, ctx)) continue

      const nx = x * 0.035
      const nz = z * 0.035
      const density = perlin01(nx, nz, sceneSeed)
      const detail = perlin01(nx * 2.8, nz * 2.8, sceneSeed + 17)

      if (density > 0.68 && detail > 0.52) {
        const rng = mulberry32(hashParcelCoords(Math.floor(x), Math.floor(z), sceneSeed))
        trees.push({
          x: x + rng() * cell,
          z: z + rng() * cell,
          rotY: rng() * Math.PI * 2,
          scale: LAND_TREE_SCALE + rng() * 0.25
        })
      } else if (density > 0.45 && detail < 0.38) {
        const rng = mulberry32(hashParcelCoords(Math.floor(x), Math.floor(z), sceneSeed + 3))
        rocks.push({
          x: x + rng() * cell,
          z: z + rng() * cell,
          rotY: rng() * Math.PI * 2,
          scale: LAND_ROCK_SCALE + rng() * 0.5
        })
      }
    }
  }

  onProgress?.(`Outer scatter: ${trees.length} trees, ${rocks.length} rocks`)

  const treeHash = profile.trees[0]
  if (treeHash && trees.length) {
    const treeGroup = await buildInstancedScatter(cache, treeHash, trees, 'scatter:trees', ctx.base)
    if (treeGroup) root.add(treeGroup)
  }

  const rockHash = profile.rocks[0]
  if (rockHash && rocks.length) {
    const rockGroup = await buildInstancedScatter(cache, rockHash, rocks, 'scatter:rocks', ctx.base)
    if (rockGroup) root.add(rockGroup)
  }

  return root
}

/** Sparse desert props on padding parcels — per-parcel instanced batches. */
export async function buildSparseScatter(
  cache: AssetCache,
  profile: LandscapeEnvironmentProfile,
  bounds: ScatterBounds,
  sceneSeed: number
): Promise<THREE.Group> {
  const root = new THREE.Group()
  root.name = 'landscape:sparse-scatter'

  const cell = PARCEL_SIZE
  const rocks: ScatterInstance[] = []
  const grass: ScatterInstance[] = []

  for (let z = bounds.minZ; z < bounds.maxZ; z += cell) {
    for (let x = bounds.minX; x < bounds.maxX; x += cell) {
      const density = perlin01(x * 0.06, z * 0.06, sceneSeed)
      if (density < 0.5) continue

      const rng = mulberry32(hashParcelCoords(Math.floor(x / cell), Math.floor(z / cell), sceneSeed))
      if (profile.rocks.length && rng() > 0.5) {
        rocks.push({
          x: x + 2 + rng() * 12,
          z: z + 2 + rng() * 12,
          rotY: rng() * Math.PI * 2,
          scale: 0.65 + rng() * 0.45
        })
      }
      if (profile.grass.length && rng() > 0.65) {
        grass.push({
          x: x + rng() * PARCEL_SIZE,
          z: z + rng() * PARCEL_SIZE,
          rotY: rng() * Math.PI * 2,
          scale: 0.7 + rng() * 0.35
        })
      }
    }
  }

  if (profile.rocks[0] && rocks.length) {
    const g = await buildInstancedScatter(cache, profile.rocks[0], rocks, 'scatter:desert-rocks')
    if (g) root.add(g)
  }
  if (profile.grass[0] && grass.length) {
    const g = await buildInstancedScatter(cache, profile.grass[0], grass, 'scatter:desert-grass')
    if (g) root.add(g)
  }

  return root
}