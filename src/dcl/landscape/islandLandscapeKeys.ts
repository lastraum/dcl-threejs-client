import { parseParcelKey } from '../content/parseParcel'
import { PARCEL_SIZE } from '../content/types'
import { isSceneParcel, parcelKey, sceneParcelBounds } from './Utils/ParcelGrid'

/** Flat y=0 disc extends this many metres beyond the scene parcel corners. */
export const ISLAND_FLAT_MARGIN_M = 3

/** Beach ring width in metres (outside the flat scene disc). */
export const ISLAND_SHORE_RING_M = 12

export type IslandShoreLayout = {
  center: { x: number; y: number }
  coreRadius: number
  outerRadius: number
  shoreWidth: number
  /** Scene bounding diameter + margin on each side, halved (metres). */
  flatRadiusM: number
  /** Island disc outer edge in metres from scene centre. */
  outerRadiusM: number
}

/** Centroid of deployed parcel cell centers (matches visual scene footprint). */
export function sceneCenterParcel(sceneParcels: string[]): { x: number; y: number } {
  if (!sceneParcels.length) return { x: 0, y: 0 }
  let sumX = 0
  let sumY = 0
  for (const key of sceneParcels) {
    const p = parseParcelKey(key)
    sumX += p.x + 0.5
    sumY += p.y + 0.5
  }
  const n = sceneParcels.length
  return { x: sumX / n, y: sumY / n }
}

/** Furthest scene cell center from the scene centroid. */
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
 * Circular island footprint: deployed scene parcels + shore ring in a circle
 * (not a rectangular padding block).
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
 * Flat disc radius: furthest scene parcel corner from centroid + margin.
 * (Using max(width, depth)/2 leaves non-square scenes with a lopsided circle.)
 */
export function islandFlatRadiusM(sceneParcels: string[], base: { x: number; y: number }): number {
  const center = islandCenterDcl(sceneParcels, base)
  let maxDist = 0
  for (const key of sceneParcels) {
    const p = parseParcelKey(key)
    const swX = (p.x - base.x) * PARCEL_SIZE
    const swZ = (p.y - base.y) * PARCEL_SIZE
    const corners = [
      { x: swX, z: swZ },
      { x: swX + PARCEL_SIZE, z: swZ },
      { x: swX, z: swZ + PARCEL_SIZE },
      { x: swX + PARCEL_SIZE, z: swZ + PARCEL_SIZE }
    ]
    for (const c of corners) {
      maxDist = Math.max(maxDist, Math.hypot(c.x - center.x, c.z - center.z))
    }
  }
  return maxDist + ISLAND_FLAT_MARGIN_M
}

/** Scene-space centre of deployed parcels (DCL metres, +X east / +Z north). */
export function islandCenterDcl(
  sceneParcels: string[],
  base: { x: number; y: number }
): { x: number; z: number } {
  const center = sceneCenterParcel(sceneParcels)
  return {
    x: (center.x - base.x) * PARCEL_SIZE,
    z: (center.y - base.y) * PARCEL_SIZE
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
    /** Centre → flat disc → beach ring (metres). */
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