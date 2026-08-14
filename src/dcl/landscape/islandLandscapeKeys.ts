import { parseParcelKey } from '../content/parseParcel'
import { PARCEL_SIZE } from '../content/types'
import { isSceneParcel, parcelKey, sceneParcelBounds } from './Utils/ParcelGrid'

/**
 * Island land disc = circumcircle of the scene parcel AABB.
 * Tiny margin so beach/ocean meet the corners cleanly (no large halo).
 */
export const ISLAND_FLAT_MARGIN_M = 0.75

/**
 * Thin sand beach outside the land disc (metres).
 * Keep short — open “beachy” oceans belong on the water biome, not island.
 */
export const ISLAND_SHORE_RING_M = 6

export type IslandShoreLayout = {
  /** Parcel-grid AABB centre (parcel units). */
  center: { x: number; y: number }
  /** Parcel units: centre → furthest scene cell centre. */
  coreRadius: number
  /** Parcel units: core + shoreWidthParcels (landscape scatter ring). */
  outerRadius: number
  shoreWidth: number
  /**
   * Land disc radius in metres: centre → furthest parcel AABB corner + margin.
   * This is “the island” — a circle that just covers the rectangular footprint.
   */
  flatRadiusM: number
  /** Outer beach edge in metres (flatRadiusM + shore ring). */
  outerRadiusM: number
}

/**
 * Geometric centre of the scene parcel AABB (parcel units).
 * Midpoint of the bounding rect — not a weighted centroid of only owned cells —
 * so a 2×2 square and a sparse L-shape still get a stable circle centre.
 */
export function sceneCenterParcel(sceneParcels: string[]): { x: number; y: number } {
  if (!sceneParcels.length) return { x: 0, y: 0 }
  const bounds = sceneParcelBounds(sceneParcels)
  return {
    x: (bounds.minX + bounds.maxX + 1) / 2,
    y: (bounds.minY + bounds.maxY + 1) / 2
  }
}

/** Furthest scene cell center from the scene AABB centre (parcel units). */
export function sceneCoreRadius(sceneParcels: string[], center: { x: number; y: number }): number {
  let max = 0
  for (const key of sceneParcels) {
    const p = parseParcelKey(key)
    const dist = Math.hypot(p.x + 0.5 - center.x, p.y + 0.5 - center.y)
    max = Math.max(max, dist)
  }
  return max
}

/**
 * Circular island footprint for landscape scatter: scene parcels + circular shore ring
 * (parcel units). Visual land/beach still use flatRadiusM / outerRadiusM metres.
 */
export function islandLandscapeParcelKeys(sceneParcels: string[], shoreWidthParcels: number): string[] {
  const center = sceneCenterParcel(sceneParcels)
  const coreR = sceneCoreRadius(sceneParcels, center)
  const outerR = coreR + shoreWidthParcels

  const keys = new Set<string>()
  for (const key of sceneParcels) keys.add(key)

  const scan = Math.ceil(outerR + 1)
  const minPx = Math.floor(center.x - scan)
  const maxPx = Math.ceil(center.x + scan)
  const minPy = Math.floor(center.y - scan)
  const maxPy = Math.ceil(center.y + scan)

  for (let py = minPy; py <= maxPy; py++) {
    for (let px = minPx; px <= maxPx; px++) {
      const key = parcelKey({ x: px, y: py })
      if (keys.has(key)) continue
      const dist = Math.hypot(px + 0.5 - center.x, py + 0.5 - center.y)
      if (dist <= outerR) keys.add(key)
    }
  }

  return [...keys].sort((a, b) => {
    const pa = parseParcelKey(a)
    const pb = parseParcelKey(b)
    return pa.y - pb.y || pa.x - pb.x
  })
}

export function islandShoreParcelKeys(sceneParcels: string[], shoreWidthParcels: number): string[] {
  const all = new Set(islandLandscapeParcelKeys(sceneParcels, shoreWidthParcels))
  return [...all].filter((key) => !isSceneParcel(key, sceneParcels))
}

/**
 * Scene parcel AABB in DCL metres relative to base SW (inclusive parcel rect).
 */
export function islandParcelBoundsM(
  sceneParcels: string[],
  base: { x: number; y: number }
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const bounds = sceneParcelBounds(sceneParcels)
  return {
    minX: (bounds.minX - base.x) * PARCEL_SIZE,
    maxX: (bounds.maxX - base.x + 1) * PARCEL_SIZE,
    minZ: (bounds.minY - base.y) * PARCEL_SIZE,
    maxZ: (bounds.maxY - base.y + 1) * PARCEL_SIZE
  }
}

/**
 * Land disc radius (metres): distance from parcel AABB centre to the farthest
 * corner of that AABB, plus a tight margin. Square N×N → half-diagonal of N×16m.
 */
export function islandFlatRadiusM(sceneParcels: string[], base: { x: number; y: number }): number {
  const box = islandParcelBoundsM(sceneParcels, base)
  const halfW = (box.maxX - box.minX) * 0.5
  const halfD = (box.maxZ - box.minZ) * 0.5
  return Math.hypot(halfW, halfD) + ISLAND_FLAT_MARGIN_M
}

/**
 * Island centre in DCL metres (+X east / +Z north) — midpoint of the parcel AABB.
 */
export function islandCenterDcl(
  sceneParcels: string[],
  base: { x: number; y: number }
): { x: number; z: number } {
  const box = islandParcelBoundsM(sceneParcels, base)
  return {
    x: (box.minX + box.maxX) * 0.5,
    z: (box.minZ + box.maxZ) * 0.5
  }
}

/** Same centre in Three.js display space (X reflected). */
export function islandCenterThree(
  sceneParcels: string[],
  base: { x: number; y: number }
): { x: number; z: number } {
  const c = islandCenterDcl(sceneParcels, base)
  return { x: -c.x, z: c.z }
}

/**
 * Island geometry law:
 *   centre = parcel AABB midpoint
 *   flatRadiusM = centre → AABB corner (+ tiny margin)  → land disc
 *   outerRadiusM = flat + thin beach ring                → sand meets water
 */
export function islandShoreLayout(
  sceneParcels: string[],
  shoreWidthParcels: number,
  base?: { x: number; y: number }
): IslandShoreLayout {
  const center = sceneCenterParcel(sceneParcels)
  const coreRadius = sceneCoreRadius(sceneParcels, center)
  const outerRadius = coreRadius + shoreWidthParcels
  const bounds = sceneParcelBounds(sceneParcels)
  const baseParcel = base ?? { x: bounds.minX, y: bounds.minY }
  const flatRadiusM = islandFlatRadiusM(sceneParcels, baseParcel)
  return {
    center,
    coreRadius,
    outerRadius,
    shoreWidth: shoreWidthParcels,
    flatRadiusM,
    outerRadiusM: flatRadiusM + ISLAND_SHORE_RING_M
  }
}

/** Non-scene point inside the island disc (circular, not parcel strips). */
export function isIslandTerrainPoint(
  dclX: number,
  dclZ: number,
  base: { x: number; y: number },
  sceneParcels: string[],
  layout: IslandShoreLayout
): boolean {
  const px = base.x + Math.floor(dclX / PARCEL_SIZE)
  const py = base.y + Math.floor(dclZ / PARCEL_SIZE)
  if (isSceneParcel(parcelKey({ x: px, y: py }), sceneParcels)) return false

  const c = islandCenterDcl(sceneParcels, base)
  const distM = Math.hypot(dclX - c.x, dclZ - c.z)
  return distM <= layout.outerRadiusM
}