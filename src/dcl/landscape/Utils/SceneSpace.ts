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
 * Parent parcel root is at dclToThree(SW) = (-swX, swZ). Local offset must also
 * respect the X reflection so mesh center lands on dclToThree(parcel center):
 *   three = (-(swX+8), swZ+8)  ⇒  local = (-8, y, +8)
 * Y is nudged below y=0 so scene floors / default FloorBase at zero do not z-fight
 * the client empty-land ground (was -0.01; still fought on some published floors).
 */
export const EMPTY_LAND_GROUND_OFFSET = {
  x: -PARCEL_SIZE / 2,
  y: -0.02,
  z: PARCEL_SIZE / 2
} as const

/**
 * Terrain GLB child offset under an ECS entity whose root uses `dclToThree` on Transform.
 * Export meshes use DCL-local +8 center (mesh scale.x = -1), independent of landscape
 * EMPTY_LAND_GROUND_OFFSET (which is three-local after parent dclToThree).
 */
export function terrainGlbParcelMeshOffset(
  parcelSwX: number,
  parcelSwZ: number,
  footprintOriginX: number,
  footprintOriginZ: number
): { x: number; y: number; z: number } {
  const half = PARCEL_SIZE / 2
  const localX = parcelSwX - footprintOriginX + half
  const localZ = parcelSwZ - footprintOriginZ + half
  return { x: -localX, y: 0, z: localZ }
}

/** Parcel grid key for an absolute DCL scene-space X/Z (matches deployed parcel keys). */
export function parcelKeyFromDclScene(dclX: number, dclZ: number, base: ParcelCoord): string {
  const px = base.x + Math.floor(dclX / PARCEL_SIZE)
  const py = base.y + Math.floor(dclZ / PARCEL_SIZE)
  return `${px},${py}`
}

/**
 * Three.js position for landscape props / infinite ground — same X reflection as
 * `dclToThreePos` (threeX = −dclX). Matches editor terrain (`scale.x = -1` on DCL mesh)
 * and composite entities so land/forest no longer sit 1 parcel off on X.
 */
export function dclSceneToLandscapeThree(
  dclX: number,
  dclZ: number,
  _base?: ParcelCoord
): { x: number; z: number } {
  return { x: -dclX, z: dclZ }
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
