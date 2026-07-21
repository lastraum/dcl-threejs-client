import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import { EMPTY_LAND } from '../landscape/Data/EmptyLandCatalog'
import { buildInstancedScatter, type ScatterInstance } from '../landscape/gltfInstancing'
import { distributedParcelPositions } from '../landscape/parcelDistribution'
import { hashParcelCoords, mulberry32, pickInt } from '../landscape/Utils/SeededRandom'
import { parseParcelKey } from '../content/parseParcel'
import type { ActiveSceneEntity } from './fetchActiveEntities'
import { parcelSwSceneLocal } from './parcelAoi'

/**
 * Catalyst "empty land" placeholders (Builder interactive-text + SCENE.glb)
 * and true vacant parcels (no entity) — visual fill only, no scripts.
 */
export function isCatalystEmptyLandEntity(ent: ActiveSceneEntity): boolean {
  const title = ent.title.trim().toLowerCase()
  if (title === 'interactive-text' || title === 'empty' || title === 'empty parcel') {
    return true
  }
  const main = ent.main.toLowerCase()
  if (!(main === 'game.js' || main.endsWith('/game.js') || main === 'bin/game.js')) {
    return false
  }
  // Single-parcel SDK6 with only floor / scene.json — treat as empty land.
  const parcels = ent.parcels.length ? ent.parcels : ent.pointers
  if (parcels.length !== 1) return false
  const glbs = ent.content.filter((c) => /\.glb$/i.test(c.file))
  if (glbs.length === 0) return true
  if (glbs.length === 1) {
    const f = (glbs[0]!.file.split('/').pop() ?? '').toLowerCase()
    if (f === 'scene.glb' || f.includes('floorbase') || f.includes('empty')) return true
  }
  return false
}

/** Parcel should get client empty-land ground + prop scatter. */
export function isVacantForEmptyLayer(
  ent: ActiveSceneEntity | undefined
): boolean {
  if (!ent) return true
  return isCatalystEmptyLandEntity(ent)
}

type EmptyScatterCounts = {
  trees: [number, number]
  bushes: [number, number]
  rocks: [number, number]
  grass: [number, number]
}

/** Sparse Genesis City empty-land look (not forest density). */
const EMPTY_SCATTER: EmptyScatterCounts = {
  trees: [0, 2],
  bushes: [2, 5],
  rocks: [0, 1],
  grass: [4, 9]
}

/**
 * Build instanced trees/bushes/rocks/grass on vacant AOI parcels.
 * Positions are scene-local DCL meters (SW-relative); `base` enables X reflection.
 */
export async function buildEmptyParcelScatter(opts: {
  cache: AssetCache
  parcelKeys: string[]
  primaryBase: string
}): Promise<THREE.Group> {
  const root = new THREE.Group()
  root.name = 'aoi-empty-scatter'
  if (!opts.parcelKeys.length) return root

  const base = parseParcelKey(opts.primaryBase)
  const byHash = new Map<string, ScatterInstance[]>()

  const push = (hash: string, inst: ScatterInstance) => {
    let list = byHash.get(hash)
    if (!list) {
      list = []
      byHash.set(hash, list)
    }
    list.push(inst)
  }

  for (const key of opts.parcelKeys) {
    const p = parseParcelKey(key)
    const rng = mulberry32(hashParcelCoords(p.x, p.y, 91))
    const sw = parcelSwSceneLocal(key, opts.primaryBase)

    const place = (
      pool: readonly string[],
      countRange: [number, number],
      sep: number,
      inset: number,
      scaleMin: number,
      scaleSpan: number
    ) => {
      if (!pool.length) return
      const n = pickInt(rng, countRange[0], countRange[1])
      if (n <= 0) return
      const locals = distributedParcelPositions(rng, n, {
        inset,
        minSeparation: sep
      })
      for (const loc of locals) {
        const hash = pool[Math.floor(rng() * pool.length)]!
        push(hash, {
          x: sw.x + loc.x,
          z: sw.z + loc.z,
          rotY: rng() * Math.PI * 2,
          scale: scaleMin + rng() * scaleSpan
        })
      }
    }

    place(EMPTY_LAND.landscapeTrees, EMPTY_SCATTER.trees, 4.5, 2.2, 0.75, 0.35)
    place(EMPTY_LAND.bushes, EMPTY_SCATTER.bushes, 2.2, 1.4, 0.7, 0.4)
    place(EMPTY_LAND.rocks, EMPTY_SCATTER.rocks, 3, 1.6, 0.6, 0.5)
    place(EMPTY_LAND.grass, EMPTY_SCATTER.grass, 1.4, 1.0, 0.85, 0.3)
  }

  // Cap total instances per prop type for large radii
  const MAX_PER_HASH = 400
  await Promise.all(
    [...byHash.entries()].map(async ([hash, instances]) => {
      const slice = instances.slice(0, MAX_PER_HASH)
      try {
        const group = await buildInstancedScatter(
          opts.cache,
          hash,
          slice,
          `aoi-empty:${hash.slice(0, 12)}`,
          base
        )
        if (group) root.add(group)
      } catch (err) {
        console.warn('[aoi] empty scatter prop failed', hash.slice(0, 12), err)
      }
    })
  )

  root.userData.emptyParcelCount = opts.parcelKeys.length
  root.userData.instanceHashes = byHash.size
  return root
}
