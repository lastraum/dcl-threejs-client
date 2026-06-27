import type { SceneWorldBounds } from '../../player/SceneBounds'

/** Scene parcels in DCL space — SW corner of base parcel is world origin. */
export type TerrainSceneFootprint = {
  originX: number
  originZ: number
  widthM: number
  depthM: number
  parcels: string[]
  baseParcel: string
}

export function terrainFootprintFromBounds(
  parcels: string[],
  baseParcel: string,
  bounds: SceneWorldBounds
): TerrainSceneFootprint {
  return {
    originX: bounds.minX,
    originZ: bounds.minZ,
    widthM: bounds.maxX - bounds.minX,
    depthM: bounds.maxZ - bounds.minZ,
    parcels,
    baseParcel
  }
}

/** SW corner of terrain footprint in DCL scene space (base parcel SW = 0,0). */
export function terrainCompositePosition(footprint: TerrainSceneFootprint): { x: number; y: number; z: number } {
  return { x: footprint.originX, y: 0, z: footprint.originZ }
}