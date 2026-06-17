import * as THREE from 'three'
import { parseParcelKey } from '../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../dcl/content/types'
import { sceneParcelBounds } from '../dcl/landscape/Utils/ParcelGrid'

export type SceneWorldBounds = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

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
