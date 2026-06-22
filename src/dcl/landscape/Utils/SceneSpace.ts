import type { ParcelCoord } from '../../content/parseParcel'
import { PARCEL_SIZE } from '../../content/types'

/** DCL scene space: SW corner of base parcel is world origin; +X east, +Z north. */
export function parcelWorldOrigin(parcel: ParcelCoord, base: ParcelCoord): {
  x: number
  y: number
  z: number
} {
  return {
    x: (parcel.x - base.x) * PARCEL_SIZE,
    y: 0,
    z: (parcel.y - base.y) * PARCEL_SIZE
  }
}

/**
 * Empty-land `ground.glb` mesh is centered on the origin (±8 m).
 * Shift so the parcel SW corner stays at the parent origin, matching SDK7 coords.
 * Y is nudged slightly below y=0 so scene floors at zero do not z-fight the padding ground.
 */
export const EMPTY_LAND_GROUND_OFFSET = {
  x: PARCEL_SIZE / 2,
  y: -0.01,
  z: PARCEL_SIZE / 2
} as const

/** Parcel grid key for an absolute DCL scene-space X/Z (matches deployed parcel keys). */
export function parcelKeyFromDclScene(dclX: number, dclZ: number, base: ParcelCoord): string {
  const px = base.x + Math.floor(dclX / PARCEL_SIZE)
  const py = base.y + Math.floor(dclZ / PARCEL_SIZE)
  return `${px},${py}`
}

/**
 * Three.js position for landscape props — mirrors parcelRoot(dclToThree(sw)) + local offset,
 * not raw dclToThree on the absolute point (which would shift props onto scene parcels).
 */
export function dclSceneToLandscapeThree(
  dclX: number,
  dclZ: number,
  base: ParcelCoord
): { x: number; z: number } {
  const px = base.x + Math.floor(dclX / PARCEL_SIZE)
  const py = base.y + Math.floor(dclZ / PARCEL_SIZE)
  const swX = (px - base.x) * PARCEL_SIZE
  const swZ = (py - base.y) * PARCEL_SIZE
  const localX = dclX - swX
  const localZ = dclZ - swZ
  return { x: -swX + localX, z: swZ + localZ }
}

/** Random prop position inside a parcel in SDK7 scene space (0–16 on X/Z). */
export function randomParcelLocalXZ(
  rng: () => number,
  inset = 1.2
): { x: number; z: number } {
  const span = PARCEL_SIZE - inset * 2
  return {
    x: inset + rng() * span,
    z: inset + rng() * span
  }
}
