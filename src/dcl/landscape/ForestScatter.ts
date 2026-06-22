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

function pickTreeHash(rng: () => number, pool: readonly string[]): string {
  return pool[Math.floor(rng() * pool.length)]!
}

/**
 * Instanced forest on empty parcel cells outside scene + padding.
 * Density falls off with Chebyshev distance from the deployed scene footprint.
 */
export async function buildForestOuterScatter(
  cache: AssetCache,
  profile: LandscapeEnvironmentProfile,
  ctx: OuterScatterContext,
  sceneParcels: string[],
  sceneSeed: number,
  borderPadding = 1,
  onProgress?: (msg: string) => void
): Promise<THREE.Group> {
  const root = new THREE.Group()
  root.name = 'landscape:forest-scatter'

  if (!profile.trees.length) return root

  const sceneBounds = sceneParcelBounds(sceneParcels)
  const sceneParcelSet = new Set(sceneParcels)
  const base = ctx.base
  const treesByHash = new Map<string, ScatterInstance[]>()
  const bushesByHash = new Map<string, ScatterInstance[]>()

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
      if (sceneParcelSet.has(key) || ctx.landscapeKeys.has(key)) continue

      const dist = parcelDistFromScene(px, py, sceneBounds)
      const falloff = outerDistanceFalloff(dist, borderPadding)
      if (falloff < 0.06) continue

      const nx = px * 0.19
      const nz = py * 0.19
      const patch = perlin01(nx, nz, sceneSeed)
      const detail = perlin01(nx * 2.4, nz * 2.4, sceneSeed + 11)
      const density = falloff * (0.55 + patch * 0.45) * (0.7 + detail * 0.3)
      if (density < 0.12) continue

      const rng = mulberry32(hashParcelCoords(px, py, sceneSeed))
      const origin = parcelWorldOrigin({ x: px, y: py }, base)

      const treeMax = Math.max(1, Math.round(9 * density))
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

        const hash = pickTreeHash(rng, profile.trees)
        const list = treesByHash.get(hash) ?? []
        list.push({
          x: dclX,
          z: dclZ,
          rotY: rng() * Math.PI * 2,
          scale: 0.88 + rng() * 0.22
        })
        treesByHash.set(hash, list)
      }

      if (profile.bushes.length && density > 0.35 && rng() > 0.25) {
        const bushCount = pickInt(rng, 0, Math.round(4 * density))
        const bushPositions = distributedParcelPositions(rng, bushCount, { minSeparation: 1.8 })
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

  let treeTotal = 0
  for (const instances of treesByHash.values()) treeTotal += instances.length
  onProgress?.(`Forest expanse: ${treeTotal} trees (${treesByHash.size} variants)`)

  for (const [hash, instances] of treesByHash) {
    const group = await buildInstancedScatter(cache, hash, instances, `forest:trees:${hash.slice(0, 8)}`, base)
    if (group) root.add(group)
  }
  for (const [hash, instances] of bushesByHash) {
    const group = await buildInstancedScatter(cache, hash, instances, `forest:bushes:${hash.slice(0, 8)}`, base)
    if (group) root.add(group)
  }
  root.userData.forestTreeCount = treeTotal
  return root
}