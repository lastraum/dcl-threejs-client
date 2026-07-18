import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import { PARCEL_SIZE } from '../content/types'
import { catalystAssetUrl, PROP_Y_SINK } from './Data/EmptyLandCatalog'
import type { LandscapeEnvironmentProfile } from './EnvironmentCatalog'
import { biasedPaddingPosition, distributedParcelPositions } from './parcelDistribution'
import { perlin01 } from './perlin2d'
import { parcelKeyFromDclScene, randomParcelLocalXZ } from './Utils/SceneSpace'
import { applyFoliageWindToObject } from './foliageWind'
import { hashParcelCoords, mulberry32, pickInt } from './Utils/SeededRandom'

/** Optional density / perlin overrides from scene.json environment.desert / .mountains */
export type DecorateDensityOpts = {
  rockDensity?: number
  treeDensity?: number
  bushDensity?: number
  backdropDensity?: number
  /** Desert rock perlin frequency (parcel units). */
  perlinScale?: number
  /** Desert: only place rocks when perlin ≥ threshold. */
  perlinThreshold?: number
}

export type ParcelLandscapeRole = 'scene' | 'padding'

type CountRange = readonly [min: number, max: number]

type DecorationCounts = {
  trees: CountRange
  bushes: CountRange
  rocks: CountRange
  grass: CountRange
  backdrop?: CountRange
}

const PADDING_PROFILE: DecorationCounts = {
  trees: [0, 1],
  bushes: [3, 6],
  rocks: [0, 2],
  grass: [8, 14]
}

/** Beach ring — clean sand only (no props). */
const ISLAND_PADDING: DecorationCounts = {
  trees: [0, 0],
  bushes: [0, 0],
  rocks: [0, 0],
  grass: [0, 0]
}

const MOUNTAIN_PADDING: DecorationCounts = {
  trees: [0, 1],
  bushes: [1, 3],
  rocks: [1, 3],
  grass: [4, 8],
  backdrop: [0, 1]
}

const DESERT_PADDING: DecorationCounts = {
  trees: [0, 0],
  bushes: [0, 1],
  rocks: [1, 3],
  grass: [2, 5]
}

/** ~5× island tree density on padding parcels. */
const FOREST_PADDING: DecorationCounts = {
  trees: [5, 10],
  bushes: [8, 14],
  rocks: [1, 3],
  grass: [18, 28]
}

function alignBaseToGround(obj: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(obj)
  if (Number.isFinite(box.min.y)) obj.position.y -= box.min.y
}

async function placeProp(
  cache: AssetCache,
  hash: string,
  parent: THREE.Group,
  lx: number,
  lz: number,
  rotY: number,
  scale: number
): Promise<void> {
  const clone = await cache.clone(catalystAssetUrl(hash), hash, { landscape: true })
  clone.rotation.y = rotY
  if (scale !== 1) clone.scale.setScalar(scale)
  // Parent is at dclToThree(SW); local X must be reflected so world = dclToThree(sw+local).
  clone.position.set(-lx, 0, lz)
  alignBaseToGround(clone)
  clone.position.y += PROP_Y_SINK[hash] ?? 0
  applyFoliageWindToObject(clone)
  parent.add(clone)
}

function pickHash<T extends readonly string[]>(rng: () => number, pool: T): string {
  return pool[Math.floor(rng() * pool.length)]!
}

function countsForProfile(profile: LandscapeEnvironmentProfile): DecorationCounts {
  if (profile.kind === 'island') return ISLAND_PADDING
  if (profile.kind === 'forest') return FOREST_PADDING
  if (profile.kind === 'mountains') return MOUNTAIN_PADDING
  if (profile.kind === 'desert') return DESERT_PADDING
  return PADDING_PROFILE
}

export type DecorateParcelContext = {
  sceneCenterPx: number
  sceneCenterPy: number
  /** Deployed scene parcel keys — props must not land on these cells. */
  sceneParcelKeys?: ReadonlySet<string>
  baseParcelX: number
  baseParcelY: number
}

/**
 * Procedural empty-land props on padding parcels (world scenes only).
 * Unity Explorer: `TreeData` + `RenderGroundSystem` / `GrassIndirectRenderer`.
 */
function scaleRange(range: CountRange, mul: number): CountRange {
  const m = Number.isFinite(mul) ? Math.max(0, Math.min(2, mul)) : 1
  if (m === 1) return range
  return [Math.round(range[0] * m), Math.max(0, Math.round(range[1] * m))] as const
}

export async function decorateParcel(
  cache: AssetCache,
  parcelX: number,
  parcelY: number,
  role: ParcelLandscapeRole,
  root: THREE.Group,
  worldScene: boolean,
  profile: LandscapeEnvironmentProfile,
  ctx?: DecorateParcelContext,
  density?: DecorateDensityOpts
): Promise<void> {
  if (role === 'scene' || profile.decoration === 'none' || profile.decoration === 'perlin-instanced') {
    return
  }
  // Sparse was world-only historically; desert padding rocks should also show on
  // local / editor / coords so environment.kind=desert looks the same everywhere.
  if (profile.decoration === 'sparse' && !worldScene && profile.kind !== 'desert') return

  const rng = mulberry32(hashParcelCoords(parcelX, parcelY))
  const baseCounts = countsForProfile(profile)
  const counts: DecorationCounts = {
    trees: scaleRange(baseCounts.trees, density?.treeDensity ?? 1),
    bushes: scaleRange(baseCounts.bushes, density?.bushDensity ?? 1),
    rocks: scaleRange(baseCounts.rocks, density?.rockDensity ?? 1),
    grass: baseCounts.grass,
    backdrop: baseCounts.backdrop
      ? scaleRange(baseCounts.backdrop, density?.backdropDensity ?? 1)
      : undefined
  }
  const islandBeach = profile.kind === 'island'
  const denseForest = profile.kind === 'forest'
  const centerPx = ctx?.sceneCenterPx ?? parcelX
  const centerPy = ctx?.sceneCenterPy ?? parcelY
  const sceneParcelKeys = ctx?.sceneParcelKeys
  const baseParcelX = ctx?.baseParcelX ?? parcelX
  const baseParcelY = ctx?.baseParcelY ?? parcelY
  const desertPadding = profile.kind === 'desert' && role === 'padding'

  const landsOnSceneParcel = (lx: number, lz: number): boolean => {
    if (!sceneParcelKeys?.size) return false
    const dclX = (parcelX - baseParcelX) * PARCEL_SIZE + lx
    const dclZ = (parcelY - baseParcelY) * PARCEL_SIZE + lz
    const key = parcelKeyFromDclScene(dclX, dclZ, { x: baseParcelX, y: baseParcelY })
    return sceneParcelKeys.has(key)
  }

  const treeCount = profile.trees.length ? pickInt(rng, counts.trees[0], counts.trees[1]) : 0
  const treeSep = denseForest ? 2.4 : 5
  const treeInset = denseForest ? 1.2 : 2.5
  const forestPaddingEdge = denseForest && role === 'padding'
  const treePositions =
    islandBeach || forestPaddingEdge
      ? []
      : distributedParcelPositions(rng, treeCount, {
          inset: treeInset,
          minSeparation: treeSep,
          maxAttempts: denseForest ? treeCount * 24 : undefined
        })
  for (let i = 0; i < treeCount; i++) {
    const pos =
      islandBeach || forestPaddingEdge
        ? biasedPaddingPosition(rng, parcelX, parcelY, centerPx, centerPy, islandBeach ? 0.5 : 0.65)
        : (treePositions[i] ?? randomParcelLocalXZ(rng, 2.5))
    const scale = 0.9 + rng() * 0.2
    await placeProp(
      cache,
      pickHash(rng, profile.trees),
      root,
      pos.x,
      pos.z,
      rng() * Math.PI * 2,
      scale
    )
  }

  const bushCount = profile.bushes.length ? pickInt(rng, counts.bushes[0], counts.bushes[1]) : 0
  const bushPositions = distributedParcelPositions(rng, bushCount, { minSeparation: 2.2 })
  for (const pos of bushPositions) {
    const scale = 0.8 + rng() * 0.45
    await placeProp(cache, pickHash(rng, profile.bushes), root, pos.x, pos.z, rng() * Math.PI * 2, scale)
  }

  let rockCount = profile.rocks.length ? pickInt(rng, counts.rocks[0], counts.rocks[1]) : 0
  // Desert: perlin gate — sparse dunes of rocks rather than uniform packing.
  if (desertPadding && density?.perlinScale != null && density?.perlinThreshold != null) {
    const p = perlin01(
      parcelX * density.perlinScale,
      parcelY * density.perlinScale,
      hashParcelCoords(parcelX, parcelY, 91)
    )
    if (p < density.perlinThreshold) {
      rockCount = Math.min(rockCount, Math.floor(rockCount * (p / Math.max(0.01, density.perlinThreshold))))
    }
  }
  const rockPositions: { x: number; z: number }[] = []
  if (desertPadding) {
    for (let i = 0; i < rockCount; i++) {
      rockPositions.push(biasedPaddingPosition(rng, parcelX, parcelY, centerPx, centerPy, 0.82))
    }
  } else {
    rockPositions.push(...distributedParcelPositions(rng, rockCount, { minSeparation: 3.5 }))
  }
  for (const pos of rockPositions) {
    if (landsOnSceneParcel(pos.x, pos.z)) continue
    if (desertPadding && density?.perlinScale != null && density?.perlinThreshold != null) {
      const lp = perlin01(
        (parcelX + pos.x * 0.1) * density.perlinScale,
        (parcelY + pos.z * 0.1) * density.perlinScale,
        17
      )
      if (lp < density.perlinThreshold) continue
    }
    const scale = desertPadding ? 0.45 + rng() * 0.35 : 0.7 + rng() * 0.6
    await placeProp(cache, pickHash(rng, profile.rocks), root, pos.x, pos.z, rng() * Math.PI * 2, scale)
  }

  const grassCount =
    profile.ezTreeGrass || !profile.grass.length
      ? 0
      : pickInt(rng, counts.grass[0], counts.grass[1])
  const grassRng = mulberry32(hashParcelCoords(parcelX, parcelY, 7))
  const grassPositions = distributedParcelPositions(grassRng, grassCount, { inset: 0.5, minSeparation: 1.4 })
  for (const pos of grassPositions) {
    const scale = 0.65 + grassRng() * 0.55
    await placeProp(
      cache,
      pickHash(grassRng, profile.grass),
      root,
      pos.x,
      pos.z,
      grassRng() * Math.PI * 2,
      scale
    )
  }

  if (profile.backdropProps?.length && counts.backdrop) {
    const backdropCount = pickInt(rng, counts.backdrop[0], counts.backdrop[1])
    for (let i = 0; i < backdropCount; i++) {
      const edge = Math.floor(rng() * 4)
      const inset = 1
      const span = PARCEL_SIZE - inset * 2
      let lx = inset + rng() * span
      let lz = inset + rng() * span
      if (edge === 0) lz = inset
      else if (edge === 1) lx = PARCEL_SIZE - inset
      else if (edge === 2) lz = PARCEL_SIZE - inset
      else lx = inset
      const scale = 1.4 + rng() * 0.8
      await placeProp(
        cache,
        pickHash(rng, profile.backdropProps),
        root,
        lx,
        lz,
        rng() * Math.PI * 2,
        scale
      )
    }
  }
}