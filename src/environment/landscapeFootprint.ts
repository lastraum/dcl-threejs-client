import { parseParcelKey } from '../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../dcl/content/types'
import { landscapeParcelKeys } from '../dcl/landscape/Utils/ParcelGrid'
import { parcelWorldOrigin } from '../dcl/landscape/Utils/SceneSpace'

export type LandscapeFootprint = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** Compute DCL-space AABB for scene + padding ring (parcels with ground). */
export function landscapeFootprint(
  parcels: string[],
  baseParcel: string,
  padding = 1
): LandscapeFootprint {
  const keys = landscapeParcelKeys(parcels, padding)
  const base = parseParcelKey(baseParcel)
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity

  for (const key of keys) {
    const parcel = parseParcelKey(key)
    const origin = parcelWorldOrigin(parcel, base)
    minX = Math.min(minX, origin.x)
    maxX = Math.max(maxX, origin.x + PARCEL_SIZE)
    minZ = Math.min(minZ, origin.z)
    maxZ = Math.max(maxZ, origin.z + PARCEL_SIZE)
  }

  if (!Number.isFinite(minX)) {
    return { minX: 0, maxX: PARCEL_SIZE, minZ: 0, maxZ: PARCEL_SIZE }
  }

  return { minX, maxX, minZ, maxZ }
}