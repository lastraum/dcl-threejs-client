import { parseParcelKey } from '../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../dcl/content/types'
import type { PlayerWalkBounds } from './SceneBounds'

/** Genesis City map parcel extents (approx. full land grid). */
const CITY_MIN = -150
const CITY_MAX_X = 163
const CITY_MAX_Y = 158

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
