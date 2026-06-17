import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import { catalystAssetUrl, EMPTY_LAND } from './Data/EmptyLandCatalog'
import { randomParcelLocalXZ } from './Utils/SceneSpace'
import { hashParcelCoords, mulberry32, pickInt } from './Utils/SeededRandom'

export type ParcelLandscapeRole = 'scene' | 'padding'

type CountRange = readonly [min: number, max: number]

/** Decoration only on empty padding parcels — scene footprint stays clear for deployed content. */
const PADDING_PROFILE = {
  trees: [0, 1] as CountRange,
  bushes: [3, 6] as CountRange,
  rocks: [0, 2] as CountRange,
  grass: [8, 14] as CountRange
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
  const clone = await cache.clone(catalystAssetUrl(hash), hash)
  clone.rotation.y = rotY
  if (scale !== 1) clone.scale.setScalar(scale)
  clone.position.set(lx, 0, lz)
  alignBaseToGround(clone)
  parent.add(clone)
}

function pickHash<T extends readonly string[]>(rng: () => number, pool: T): string {
  return pool[Math.floor(rng() * pool.length)]!
}

/**
 * Procedural empty-land props on padding parcels (world scenes only).
 * Unity Explorer: `TreeData` + `RenderGroundSystem` / `GrassIndirectRenderer`.
 */
export async function decorateParcel(
  cache: AssetCache,
  parcelX: number,
  parcelY: number,
  role: ParcelLandscapeRole,
  root: THREE.Group,
  worldScene: boolean
): Promise<void> {
  if (role === 'scene' || !worldScene) return

  const rng = mulberry32(hashParcelCoords(parcelX, parcelY))
  const profile = PADDING_PROFILE

  const treeCount = pickInt(rng, profile.trees[0], profile.trees[1])
  for (let i = 0; i < treeCount; i++) {
    const { x, z } = randomParcelLocalXZ(rng, 3)
    const scale = 0.9 + rng() * 0.2
    await placeProp(
      cache,
      pickHash(rng, EMPTY_LAND.landscapeTrees),
      root,
      x,
      z,
      rng() * Math.PI * 2,
      scale
    )
  }

  const bushCount = pickInt(rng, profile.bushes[0], profile.bushes[1])
  for (let i = 0; i < bushCount; i++) {
    const { x, z } = randomParcelLocalXZ(rng)
    const scale = 0.8 + rng() * 0.45
    await placeProp(cache, pickHash(rng, EMPTY_LAND.bushes), root, x, z, rng() * Math.PI * 2, scale)
  }

  const rockCount = pickInt(rng, profile.rocks[0], profile.rocks[1])
  for (let i = 0; i < rockCount; i++) {
    const { x, z } = randomParcelLocalXZ(rng)
    const scale = 0.7 + rng() * 0.6
    await placeProp(cache, pickHash(rng, EMPTY_LAND.rocks), root, x, z, rng() * Math.PI * 2, scale)
  }

  const grassRng = mulberry32(hashParcelCoords(parcelX, parcelY, 7))
  const grassCount = pickInt(grassRng, profile.grass[0], profile.grass[1])
  for (let i = 0; i < grassCount; i++) {
    const { x, z } = randomParcelLocalXZ(grassRng, 0.5)
    const scale = 0.65 + grassRng() * 0.55
    const rotY = grassRng() * Math.PI * 2
    await placeProp(cache, pickHash(grassRng, EMPTY_LAND.grass), root, x, z, rotY, scale)
  }
}
