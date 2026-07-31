import { parseParcelKey } from '../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../dcl/content/types'
import type { PlayerWalkBounds } from './SceneBounds'

/**
 * Genesis City map parcel extents (approx. full land grid).
 * Inclusive parcel indices — ~300×300 parcels of land + shoreline.
 */
export const GENESIS_CITY_MIN = -150
export const GENESIS_CITY_MAX_X = 163
export const GENESIS_CITY_MAX_Y = 158

/** @deprecated use GENESIS_CITY_MIN */
const CITY_MIN = GENESIS_CITY_MIN
/** @deprecated use GENESIS_CITY_MAX_X */
const CITY_MAX_X = GENESIS_CITY_MAX_X
/** @deprecated use GENESIS_CITY_MAX_Y */
const CITY_MAX_Y = GENESIS_CITY_MAX_Y

/**
 * Walk bounds covering Genesis City relative to the primary scene base parcel.
 * Used when AOI Scene Distance > 0 so the player is not clamped to the primary footprint.
 */
export function genesisCityWalkBounds(baseParcel: string): PlayerWalkBounds {
  const base = parseParcelKey(baseParcel)
  return {
    mode: 'rect',
    bounds: {
      minX: (CITY_MIN - base.x) * PARCEL_SIZE,
      maxX: (CITY_MAX_X - base.x + 1) * PARCEL_SIZE,
      minZ: (CITY_MIN - base.y) * PARCEL_SIZE,
      maxZ: (CITY_MAX_Y - base.y + 1) * PARCEL_SIZE
    }
  }
}

/**
 * Genesis City rect in DCL scene-local meters (relative to primary base SW).
 * Covers SW corner of min parcel through NE corner of max parcel.
 */
export function genesisCityDclRect(baseParcel: string): {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  sizeX: number
  sizeZ: number
  centerX: number
  centerZ: number
  widthParcels: number
  depthParcels: number
} {
  const base = parseParcelKey(baseParcel)
  const minX = (GENESIS_CITY_MIN - base.x) * PARCEL_SIZE
  const maxX = (GENESIS_CITY_MAX_X - base.x + 1) * PARCEL_SIZE
  const minZ = (GENESIS_CITY_MIN - base.y) * PARCEL_SIZE
  const maxZ = (GENESIS_CITY_MAX_Y - base.y + 1) * PARCEL_SIZE
  const sizeX = maxX - minX
  const sizeZ = maxZ - minZ
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    sizeX,
    sizeZ,
    centerX: (minX + maxX) * 0.5,
    centerZ: (minZ + maxZ) * 0.5,
    widthParcels: GENESIS_CITY_MAX_X - GENESIS_CITY_MIN + 1,
    depthParcels: GENESIS_CITY_MAX_Y - GENESIS_CITY_MIN + 1
  }
}
