import * as THREE from 'three'
import { parseParcelKey } from '../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../dcl/content/types'
import { islandCenterDcl, islandShoreLayout } from '../dcl/landscape/islandLandscapeKeys'
import { sceneParcelBounds } from '../dcl/landscape/Utils/ParcelGrid'

export type SceneWorldBounds = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export type CircularWalkBounds = {
  centerX: number
  centerZ: number
  radiusM: number
}

export type PlayerWalkBounds =
  | { mode: 'rect'; bounds: SceneWorldBounds }
  | { mode: 'circle'; circle: CircularWalkBounds }

/** Scene footprint in world meters — SW corner of base parcel is origin. */
export function sceneWorldBounds(parcels: string[], baseParcel: string): SceneWorldBounds {
  const base = parseParcelKey(baseParcel)
  const bounds = sceneParcelBounds(parcels)
  return {
    minX: (bounds.minX - base.x) * PARCEL_SIZE,
    maxX: (bounds.maxX - base.x + 1) * PARCEL_SIZE,
    minZ: (bounds.minY - base.y) * PARCEL_SIZE,
    maxZ: (bounds.maxY - base.y + 1) * PARCEL_SIZE
  }
}

/** Walkable landscape footprint (scene + padding / island shore ring) in world meters. */
export function landscapeWorldBounds(landscapeParcelKeys: string[], baseParcel: string): SceneWorldBounds {
  const base = parseParcelKey(baseParcel)
  const bounds = sceneParcelBounds(landscapeParcelKeys)
  return {
    minX: (bounds.minX - base.x) * PARCEL_SIZE,
    maxX: (bounds.maxX - base.x + 1) * PARCEL_SIZE,
    minZ: (bounds.minY - base.y) * PARCEL_SIZE,
    maxZ: (bounds.maxY - base.y + 1) * PARCEL_SIZE
  }
}

/** Island — circular walk limit matching the procedural shore disc (+ shallow wade margin). */
export function islandCircularWalkBounds(
  sceneParcels: string[],
  baseParcel: string,
  shoreWidthParcels: number,
  wadeMarginM = 4
): PlayerWalkBounds {
  const base = parseParcelKey(baseParcel)
  const layout = islandShoreLayout(sceneParcels, shoreWidthParcels, parseParcelKey(baseParcel))
  const center = islandCenterDcl(sceneParcels, base)
  return {
    mode: 'circle',
    circle: {
      centerX: center.x,
      centerZ: center.z,
      radiusM: layout.outerRadiusM + wadeMarginM
    }
  }
}

export function clampToSceneBounds(
  position: THREE.Vector3,
  bounds: SceneWorldBounds,
  margin = 0.35
): boolean {
  const x = THREE.MathUtils.clamp(position.x, bounds.minX + margin, bounds.maxX - margin)
  const z = THREE.MathUtils.clamp(position.z, bounds.minZ + margin, bounds.maxZ - margin)
  const changed = x !== position.x || z !== position.z
  position.x = x
  position.z = z
  return changed
}

export function clampToCircularBounds(
  position: THREE.Vector3,
  circle: CircularWalkBounds,
  margin = 0.35
): boolean {
  const maxR = Math.max(0.5, circle.radiusM - margin)
  const dx = position.x - circle.centerX
  const dz = position.z - circle.centerZ
  const dist = Math.hypot(dx, dz)
  if (dist <= maxR) return false
  const scale = maxR / dist
  position.x = circle.centerX + dx * scale
  position.z = circle.centerZ + dz * scale
  return true
}

export function clampToWalkBounds(
  position: THREE.Vector3,
  walk: PlayerWalkBounds,
  margin = 0.35
): boolean {
  return walk.mode === 'circle'
    ? clampToCircularBounds(position, walk.circle, margin)
    : clampToSceneBounds(position, walk.bounds, margin)
}

export function isInsideSceneBounds(
  position: THREE.Vector3,
  bounds: SceneWorldBounds,
  margin = 0.35
): boolean {
  return (
    position.x >= bounds.minX + margin &&
    position.x <= bounds.maxX - margin &&
    position.z >= bounds.minZ + margin &&
    position.z <= bounds.maxZ - margin
  )
}