import * as THREE from 'three'
import type { AssetCache } from '../../../rendering/AssetCache'
import { parseParcelKey, type ParcelCoord } from '../../content/parseParcel'
import { landscapeParcelKeys } from '../Utils/ParcelGrid'
import { parcelWorldOrigin } from '../Utils/SceneSpace'
import { buildInstancedGroundTiles, type TilePlacement } from '../gltfInstancing'

/** Instanced ground grid radius beyond the padding ring (land biome — fills horizon, no ocean). */
const INFINITE_RADIUS_PARCELS = 48

export type OuterScatterContext = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  landscapeKeys: Set<string>
  base: ParcelCoord
}

/**
 * Instanced ground tiles OUTSIDE the scene + padding ring only.
 * Border padding parcels are built in the parcel loop (ground + decoration).
 */
export async function buildInfiniteGround(
  cache: AssetCache,
  groundHash: string,
  sceneParcels: string[],
  baseParcel: string,
  borderPadding = 1
): Promise<THREE.Group> {
  const ctx = outerScatterContext(sceneParcels, baseParcel, borderPadding)
  const tiles: TilePlacement[] = []
  const base = ctx.base

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
  if (!Number.isFinite(minPx)) {
    minPx = maxPx = minPy = maxPy = 0
  }
  const cx = Math.floor((minPx + maxPx) * 0.5)
  const cy = Math.floor((minPy + maxPy) * 0.5)

  for (let py = cy - INFINITE_RADIUS_PARCELS; py <= cy + INFINITE_RADIUS_PARCELS; py++) {
    for (let px = cx - INFINITE_RADIUS_PARCELS; px <= cx + INFINITE_RADIUS_PARCELS; px++) {
      const key = `${px},${py}`
      if (ctx.landscapeKeys.has(key)) continue
      const origin = parcelWorldOrigin({ x: px, y: py }, base)
      tiles.push({ x: origin.x, z: origin.z })
    }
  }

  const group = await buildInstancedGroundTiles(cache, groundHash, tiles, 'landscape:infinite-ground', base)
  group.userData.infiniteTileCount = tiles.length
  return group
}

/** Context for scattering props only on the outer instanced expanse (not border padding). */
export function outerScatterContext(
  sceneParcels: string[],
  baseParcel: string,
  borderPadding = 1
): OuterScatterContext {
  const base = parseParcelKey(baseParcel)
  const landscapeKeys = new Set(landscapeParcelKeys(sceneParcels, borderPadding))

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

  const minOrigin = parcelWorldOrigin(
    { x: cx - INFINITE_RADIUS_PARCELS, y: cy - INFINITE_RADIUS_PARCELS },
    base
  )
  const maxOrigin = parcelWorldOrigin(
    { x: cx + INFINITE_RADIUS_PARCELS + 1, y: cy + INFINITE_RADIUS_PARCELS + 1 },
    base
  )

  return {
    minX: minOrigin.x,
    maxX: maxOrigin.x,
    minZ: minOrigin.z,
    maxZ: maxOrigin.z,
    landscapeKeys,
    base
  }
}