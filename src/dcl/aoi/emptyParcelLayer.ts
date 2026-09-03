import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import type { PhysicsColliderDesc } from '../../physics/PhysXWorld'
import { EMPTY_LAND } from '../landscape/Data/EmptyLandCatalog'
import type { EzTreeGrassFieldHandle } from '../landscape/EzTreeGrassField'
import { buildExplorerVacantGrassField } from '../landscape/ExplorerVacantGrassField'
import { buildInstancedScatter, type ScatterInstance } from '../landscape/gltfInstancing'
import {
  distributedParcelPositions,
  horizontalDiskFitsParcel,
  horizontalDiskHitsAabb
} from '../landscape/parcelDistribution'
import { dclSceneToLandscapeThree } from '../landscape/Utils/SceneSpace'
import { hashParcelCoords, mulberry32, pickInt } from '../landscape/Utils/SeededRandom'
import { parseParcelKey } from '../content/parseParcel'
import { PARCEL_SIZE } from '../content/types'
import { isCatalystEmptyLandEntity, type ActiveSceneEntity } from './fetchActiveEntities'
import { parcelSwSceneLocal } from './parcelAoi'

export { isCatalystEmptyLandEntity }

/** Parcel should get client empty-land prop scatter (trees/rocks). */
export function isVacantForEmptyLayer(ent: ActiveSceneEntity | undefined): boolean {
  if (!ent) return true
  return isCatalystEmptyLandEntity(ent)
}

/**
 * Reserved PhysX ids for AOI empty-land tree/rock boxes.
 * Sits just below secondary 30M; does not overlap road 21–29M hash span end.
 */
export const EMPTY_LAND_AOI_COLLIDER_ENTITY_BASE = 29_100_000
export const EMPTY_LAND_AOI_COLLIDER_ID_SPAN = 800_000

export function stableEmptyLandColliderEntityId(instanceKey: string): number {
  let h = 2166136261
  for (let i = 0; i < instanceKey.length; i++) {
    h ^= instanceKey.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return EMPTY_LAND_AOI_COLLIDER_ENTITY_BASE + ((h >>> 0) % EMPTY_LAND_AOI_COLLIDER_ID_SPAN)
}

type EmptyScatterCounts = {
  trees: [number, number]
  bushes: [number, number]
  rocks: [number, number]
}

/** Sparse Genesis City empty-land look (not forest density). Grass is GPU blades. */
const EMPTY_SCATTER: EmptyScatterCounts = {
  trees: [0, 2],
  bushes: [2, 5],
  rocks: [0, 1]
}

type ScatterKind = 'tree' | 'rock' | 'bush'

/** Simple box half-size in meters (scale multiplies) for tree trunks / rock boulders. */
const TREE_COLLIDER = { w: 0.55, h: 2.4, d: 0.55 }
const ROCK_COLLIDER = { w: 0.7, h: 0.55, d: 0.7 }
/**
 * Horizontal visual radius at scale 1 — canopy/bush volume, not the thin trunk box.
 * Placement must keep this disk inside the vacant parcel so trees do not hang into
 * occupied scenes (Atelier walls with a tree through the window).
 */
const SCATTER_VISUAL_RADIUS_M: Record<ScatterKind, number> = {
  tree: 3.6,
  bush: 1.4,
  rock: 0.85
}

/**
 * Build instanced trees/bushes/rocks on vacant AOI parcels + simple box colliders
 * for trees and rocks (instanced positions, not full mesh cooks).
 * Grass is Unity Explorer tufts + wildflowers, not ez-tree blades or EMPTY_LAND glTF.
 */
export async function buildEmptyParcelScatter(opts: {
  cache: AssetCache
  parcelKeys: string[]
  primaryBase: string
  /** Occupied scene parcels — scatter disks must not overlap these. */
  occupiedParcelKeys?: Iterable<string>
}): Promise<{
  root: THREE.Group
  colliders: PhysicsColliderDesc[]
  grass: EzTreeGrassFieldHandle | null
}> {
  const root = new THREE.Group()
  root.name = 'aoi-empty-scatter'
  const colliders: PhysicsColliderDesc[] = []
  if (!opts.parcelKeys.length) return { root, colliders, grass: null }

  const base = parseParcelKey(opts.primaryBase)
  const occupied = new Set<string>()
  for (const raw of opts.occupiedParcelKeys ?? []) {
    const k = raw.trim()
    if (k) occupied.add(k)
  }
  const occupiedAabbs: Array<{ minX: number; minZ: number; maxX: number; maxZ: number }> = []
  for (const key of occupied) {
    try {
      const sw = parcelSwSceneLocal(key, opts.primaryBase)
      occupiedAabbs.push({
        minX: sw.x,
        minZ: sw.z,
        maxX: sw.x + PARCEL_SIZE,
        maxZ: sw.z + PARCEL_SIZE
      })
    } catch {
      /* skip */
    }
  }
  const byHash = new Map<string, ScatterInstance[]>()
  const kindByHash = new Map<string, ScatterKind>()

  const push = (hash: string, kind: ScatterKind, inst: ScatterInstance) => {
    let list = byHash.get(hash)
    if (!list) {
      list = []
      byHash.set(hash, list)
      kindByHash.set(hash, kind)
    }
    list.push(inst)
  }

  for (const key of opts.parcelKeys) {
    const p = parseParcelKey(key)
    const rng = mulberry32(hashParcelCoords(p.x, p.y, 91))
    const sw = parcelSwSceneLocal(key, opts.primaryBase)

    const place = (
      pool: readonly string[],
      kind: ScatterKind,
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
      const r0 = SCATTER_VISUAL_RADIUS_M[kind]
      for (const loc of locals) {
        const scale = scaleMin + rng() * scaleSpan
        const radius = r0 * scale
        if (!horizontalDiskFitsParcel(loc.x, loc.z, radius)) continue
        const wx = sw.x + loc.x
        const wz = sw.z + loc.z
        if (
          occupiedAabbs.some((b) =>
            horizontalDiskHitsAabb(wx, wz, radius, b.minX, b.minZ, b.maxX, b.maxZ)
          )
        ) {
          continue
        }
        const hash = pool[Math.floor(rng() * pool.length)]!
        push(hash, kind, {
          x: wx,
          z: wz,
          rotY: rng() * Math.PI * 2,
          scale
        })
      }
    }

    place(EMPTY_LAND.landscapeTrees, 'tree', EMPTY_SCATTER.trees, 5.5, 5.8, 1.45, 0.5)
    place(EMPTY_LAND.bushes, 'bush', EMPTY_SCATTER.bushes, 2.8, 2.2, 1.15, 0.4)
    place(EMPTY_LAND.rocks, 'rock', EMPTY_SCATTER.rocks, 3, 1.8, 0.85, 0.4)
  }

  // Cap total instances per prop type for large radii
  const MAX_PER_HASH = 400
  const _pos = new THREE.Vector3()
  const _quat = new THREE.Quaternion()
  const _scale = new THREE.Vector3()
  const _mat = new THREE.Matrix4()
  const _euler = new THREE.Euler()

  await Promise.all(
    [...byHash.entries()].map(async ([hash, instances]) => {
      const slice = instances.slice(0, MAX_PER_HASH)
      const kind = kindByHash.get(hash) ?? 'bush'
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

      // Simple box colliders for trees + rocks only (walk/block).
      if (kind !== 'tree' && kind !== 'rock') return
      const box = kind === 'tree' ? TREE_COLLIDER : ROCK_COLLIDER
      for (let i = 0; i < slice.length; i++) {
        const inst = slice[i]!
        const p = dclSceneToLandscapeThree(inst.x, inst.z, base)
        const h = box.h * inst.scale
        _pos.set(p.x, h * 0.5, p.z)
        _euler.set(0, inst.rotY, 0)
        _quat.setFromEuler(_euler)
        _scale.set(box.w * inst.scale, h, box.d * inst.scale)
        _mat.compose(_pos, _quat, _scale)
        const idKey = `${hash.slice(0, 16)}:${inst.x.toFixed(2)},${inst.z.toFixed(2)}`
        colliders.push({
          entity: stableEmptyLandColliderEntityId(idKey),
          kind: 'box',
          fingerprint: `empty-aoi:v1:${kind}:${idKey}`,
          matrix: _mat.clone()
        })
      }
    })
  )

  let grass: EzTreeGrassFieldHandle | null = null
  try {
    grass = await buildExplorerVacantGrassField(opts.parcelKeys, opts.primaryBase)
    if (grass) root.add(grass.group)
  } catch (err) {
    console.warn('[aoi] vacant grass field failed', err)
    grass = null
  }

  root.userData.emptyParcelCount = opts.parcelKeys.length
  root.userData.instanceHashes = byHash.size
  root.userData.colliderCount = colliders.length
  root.userData.grassInstanceCount = grass?.group.userData.grassInstanceCount ?? 0
  return { root, colliders, grass }
}
