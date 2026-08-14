import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import { parseParcelKey } from '../content/parseParcel'
import type { LandscapeEnvironmentProfile } from './EnvironmentCatalog'
import { distributedParcelPositions } from './parcelDistribution'
import { buildInstancedScatter, type ScatterInstance } from './gltfInstancing'
import { perlin01 } from './perlin2d'
import { hashParcelCoords, mulberry32, pickInt } from './Utils/SeededRandom'
import { parcelKeyFromDclScene, parcelWorldOrigin } from './Utils/SceneSpace'
import { sceneParcelBounds } from './Utils/ParcelGrid'
import type { OuterScatterContext } from './Systems/InfiniteGround'
import {
  OUTER_SCATTER_RADIUS_PARCELS,
  outerDistanceFalloff,
  parcelDistFromScene
} from './scatterFalloff'

function weightedPickHash(
  rng: () => number,
  pool: readonly string[],
  weights?: readonly number[]
): string {
  if (!pool.length) return ''
  if (!weights?.length) return pool[Math.floor(rng() * pool.length)]!
  let sum = 0
  for (let i = 0; i < pool.length; i++) sum += Math.max(0, weights[i] ?? 1)
  if (sum <= 1e-8) return pool[0]!
  let t = rng() * sum
  for (let i = 0; i < pool.length; i++) {
    t -= Math.max(0, weights[i] ?? 1)
    if (t <= 0) return pool[i]!
  }
  return pool[pool.length - 1]!
}

function meanDensity(weights: readonly number[] | undefined, n: number): number {
  if (!weights?.length || n <= 0) return 1
  let s = 0
  for (let i = 0; i < n; i++) s += Math.max(0, Math.min(2, weights[i] ?? 1))
  return s / n
}

export type ForestScatterDensityOpts = {
  /** Parallel to profile.trees — 0–2 each. */
  treeDensities?: number[]
  /** Parallel to profile.rocks — 0–2 each. */
  rockDensities?: number[]
  bushDensity?: number
}

/**
 * Instanced forest on empty parcel cells outside scene + padding —
 * trees, bushes, and rocks all seed to the outer radius (horizon falloff).
 */
export async function buildForestOuterScatter(
  cache: AssetCache,
  profile: LandscapeEnvironmentProfile,
  ctx: OuterScatterContext,
  sceneParcels: string[],
  sceneSeed: number,
  borderPadding = 1,
  onProgress?: (msg: string) => void,
  densityOpts?: ForestScatterDensityOpts
): Promise<THREE.Group> {
  const root = new THREE.Group()
  root.name = 'landscape:forest-scatter'

  const hasTrees = profile.trees.length > 0
  const hasBushes = profile.bushes.length > 0
  const hasRocks = profile.rocks.length > 0
  if (!hasTrees && !hasBushes && !hasRocks) return root

  const treeMean = meanDensity(densityOpts?.treeDensities, profile.trees.length)
  const rockMean = meanDensity(densityOpts?.rockDensities, profile.rocks.length)
  const bushMul =
    typeof densityOpts?.bushDensity === 'number' && Number.isFinite(densityOpts.bushDensity)
      ? Math.max(0, Math.min(2, densityOpts.bushDensity))
      : 1

  const sceneBounds = sceneParcelBounds(sceneParcels)
  const sceneParcelSet = new Set(sceneParcels)
  const base = ctx.base
  const treesByHash = new Map<string, ScatterInstance[]>()
  const bushesByHash = new Map<string, ScatterInstance[]>()
  const rocksByHash = new Map<string, ScatterInstance[]>()

  let minPx = Infinity
  let maxPx = -Infinity
  let minPy = Infinity
  let maxPy = -Infinity
  for (const key of sceneParcels) {
    const p = parseParcelKey(key)
    minPx = Math.min(minPx, p.x)
    maxPx = Math.max(maxPx, p.x)
    minPy = Math.min(minPy, p.y)
    maxPy = Math.max(maxPy, p.y)
  }
  if (!Number.isFinite(minPx)) minPx = maxPx = minPy = maxPy = 0
  const cx = Math.floor((minPx + maxPx) * 0.5)
  const cy = Math.floor((minPy + maxPy) * 0.5)

  for (let py = cy - OUTER_SCATTER_RADIUS_PARCELS; py <= cy + OUTER_SCATTER_RADIUS_PARCELS; py++) {
    for (let px = cx - OUTER_SCATTER_RADIUS_PARCELS; px <= cx + OUTER_SCATTER_RADIUS_PARCELS; px++) {
      const key = `${px},${py}`
      // Skip scene + padding tiles (padding already decorated by decorateParcel).
      if (sceneParcelSet.has(key) || ctx.landscapeKeys.has(key)) continue

      const dist = parcelDistFromScene(px, py, sceneBounds)
      const falloff = outerDistanceFalloff(dist, borderPadding)
      if (falloff < 0.06) continue

      const nx = px * 0.19
      const nz = py * 0.19
      const patch = perlin01(nx, nz, sceneSeed)
      const detail = perlin01(nx * 2.4, nz * 2.4, sceneSeed + 11)
      // Base density from distance + noise (shared by all prop classes).
      const baseDensity = falloff * (0.55 + patch * 0.45) * (0.7 + detail * 0.3)
      if (baseDensity < 0.1) continue

      const rng = mulberry32(hashParcelCoords(px, py, sceneSeed))
      const origin = parcelWorldOrigin({ x: px, y: py }, base)

      // —— Trees (horizon) ——
      if (hasTrees && treeMean >= 0.02) {
        const density = baseDensity * treeMean
        if (density >= 0.1) {
          const treeMax = Math.max(0, Math.round(9 * density))
          if (treeMax >= 1) {
            const treeMin = Math.max(0, treeMax - 3)
            const treeCount = pickInt(rng, treeMin, treeMax)
            const treePositions = distributedParcelPositions(rng, treeCount, {
              inset: 1,
              minSeparation: 2.2,
              maxAttempts: treeCount * 20
            })
            for (const pos of treePositions) {
              const dclX = origin.x + pos.x
              const dclZ = origin.z + pos.z
              const cellKey = parcelKeyFromDclScene(dclX, dclZ, base)
              if (sceneParcelSet.has(cellKey) || ctx.landscapeKeys.has(cellKey)) continue
              const hash = weightedPickHash(rng, profile.trees, densityOpts?.treeDensities)
              if (!hash) continue
              const list = treesByHash.get(hash) ?? []
              list.push({
                x: dclX,
                z: dclZ,
                rotY: rng() * Math.PI * 2,
                scale: 0.88 + rng() * 0.22
              })
              treesByHash.set(hash, list)
            }
          }
        }
      }

      // —— Bushes (horizon, same radius as trees) ——
      if (hasBushes && bushMul >= 0.02) {
        const density = baseDensity * bushMul
        // Slightly lower threshold than trees so undergrowth reaches the edge.
        if (density >= 0.08) {
          const bushMax = Math.max(0, Math.round(5 * density))
          if (bushMax >= 1) {
            const bushCount = pickInt(rng, Math.max(0, bushMax - 2), bushMax)
            const bushPositions = distributedParcelPositions(rng, bushCount, {
              inset: 0.8,
              minSeparation: 1.6,
              maxAttempts: bushCount * 16
            })
            for (const pos of bushPositions) {
              const dclX = origin.x + pos.x
              const dclZ = origin.z + pos.z
              const cellKey = parcelKeyFromDclScene(dclX, dclZ, base)
              if (sceneParcelSet.has(cellKey) || ctx.landscapeKeys.has(cellKey)) continue
              const hash = profile.bushes[Math.floor(rng() * profile.bushes.length)]!
              const list = bushesByHash.get(hash) ?? []
              list.push({
                x: dclX,
                z: dclZ,
                rotY: rng() * Math.PI * 2,
                scale: 0.75 + rng() * 0.4
              })
              bushesByHash.set(hash, list)
            }
          }
        }
      }

      // —— Rocks (horizon, same radius as trees) ——
      if (hasRocks && rockMean >= 0.02) {
        const density = baseDensity * rockMean
        if (density >= 0.1) {
          const rockMax = Math.max(0, Math.round(3 * density))
          if (rockMax >= 1) {
            const rockCount = pickInt(rng, 0, rockMax)
            const rockPositions = distributedParcelPositions(rng, rockCount, {
              inset: 1.2,
              minSeparation: 2.8,
              maxAttempts: rockCount * 18
            })
            for (const pos of rockPositions) {
              const dclX = origin.x + pos.x
              const dclZ = origin.z + pos.z
              const cellKey = parcelKeyFromDclScene(dclX, dclZ, base)
              if (sceneParcelSet.has(cellKey) || ctx.landscapeKeys.has(cellKey)) continue
              const hash = weightedPickHash(rng, profile.rocks, densityOpts?.rockDensities)
              if (!hash) continue
              const list = rocksByHash.get(hash) ?? []
              list.push({
                x: dclX,
                z: dclZ,
                rotY: rng() * Math.PI * 2,
                scale: 0.65 + rng() * 0.55
              })
              rocksByHash.set(hash, list)
            }
          }
        }
      }
    }
  }

  let treeTotal = 0
  let bushTotal = 0
  let rockTotal = 0
  for (const instances of treesByHash.values()) treeTotal += instances.length
  for (const instances of bushesByHash.values()) bushTotal += instances.length
  for (const instances of rocksByHash.values()) rockTotal += instances.length
  onProgress?.(
    `Forest expanse: ${treeTotal} trees · ${bushTotal} bushes · ${rockTotal} rocks`
  )

  for (const [hash, instances] of treesByHash) {
    const group = await buildInstancedScatter(
      cache,
      hash,
      instances,
      `forest:trees:${hash.slice(0, 8)}`,
      base
    )
    if (group) root.add(group)
  }
  for (const [hash, instances] of bushesByHash) {
    const group = await buildInstancedScatter(
      cache,
      hash,
      instances,
      `forest:bushes:${hash.slice(0, 8)}`,
      base
    )
    if (group) root.add(group)
  }
  for (const [hash, instances] of rocksByHash) {
    const group = await buildInstancedScatter(
      cache,
      hash,
      instances,
      `forest:rocks:${hash.slice(0, 8)}`,
      base
    )
    if (group) root.add(group)
  }
  root.userData.forestTreeCount = treeTotal
  root.userData.forestBushCount = bushTotal
  root.userData.forestRockCount = rockTotal
  return root
}
