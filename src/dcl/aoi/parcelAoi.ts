import { parseParcelKey, type ParcelCoord } from '../content/parseParcel'
import { PARCEL_SIZE } from '../content/types'

/**
 * Multi-scene AOI (FocusOwner model):
 * - **Warm + visual band** = user Scene Distance (`sceneLoadRadiusM`): roads, empty,
 *   composites, first-frame, script/manifest prefetch, live-secondary *eligibility*.
 * - **FocusOwner** = primary only (UI / audio / video / inputs / locomotion).
 * - **Live secondaries** = budgeted (tier cap) subset of warm band — not all-in-radius.
 *
 * @deprecated Prefer `renderQuality.getSceneLoadRadiusM()`. Kept as fallback when
 * settings are unavailable (tests / early init). Default matches Scene Distance default (100m).
 */
export const SCENE_SCRIPT_WARM_RADIUS_M = 100

/** Absolute genesis parcel under a scene-local DCL feet position. */
export function absoluteParcelAtSceneLocal(
  dclX: number,
  dclZ: number,
  baseParcel: string
): ParcelCoord {
  const base = parseParcelKey(baseParcel)
  return {
    x: base.x + Math.floor(dclX / PARCEL_SIZE),
    y: base.y + Math.floor(dclZ / PARCEL_SIZE)
  }
}

/** Distance from a point (scene-local DCL meters) to a parcel's center (same space). */
export function distanceToParcelCenterM(
  dclX: number,
  dclZ: number,
  parcel: ParcelCoord,
  baseParcel: string
): number {
  const base = parseParcelKey(baseParcel)
  const cx = (parcel.x - base.x) * PARCEL_SIZE + PARCEL_SIZE / 2
  const cz = (parcel.y - base.y) * PARCEL_SIZE + PARCEL_SIZE / 2
  return Math.hypot(dclX - cx, dclZ - cz)
}

/**
 * Absolute parcel keys within `radiusM` of the player (scene-local feet).
 * Includes any primary scene parcels that fall inside the radius.
 */
export function parcelsInLoadRadius(
  dclX: number,
  dclZ: number,
  baseParcel: string,
  radiusM: number
): string[] {
  if (radiusM <= 0) return []
  const center = absoluteParcelAtSceneLocal(dclX, dclZ, baseParcel)
  const ring = Math.max(1, Math.ceil(radiusM / PARCEL_SIZE) + 1)
  const out: string[] = []
  for (let dx = -ring; dx <= ring; dx++) {
    for (let dy = -ring; dy <= ring; dy++) {
      const parcel = { x: center.x + dx, y: center.y + dy }
      if (distanceToParcelCenterM(dclX, dclZ, parcel, baseParcel) <= radiusM + PARCEL_SIZE * 0.5) {
        out.push(`${parcel.x},${parcel.y}`)
      }
    }
  }
  return out
}

/** Scene-local DCL SW corner of an absolute parcel relative to primary base. */
export function parcelSwSceneLocal(parcelKey: string, baseParcel: string): { x: number; z: number } {
  const base = parseParcelKey(baseParcel)
  const p = parseParcelKey(parcelKey)
  return {
    x: (p.x - base.x) * PARCEL_SIZE,
    z: (p.y - base.y) * PARCEL_SIZE
  }
}
