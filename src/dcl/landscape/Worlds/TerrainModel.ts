import { parseParcelKey } from '../../content/parseParcel'
import { landscapeParcelKeys, sceneParcelBounds } from '../Utils/ParcelGrid'

/**
 * TS mirror of Unity Explorer `DCL.Landscape.Worlds.TerrainModel`.
 * Computes padded terrain bounds around owned (scene) parcels.
 */
export type TerrainModel = {
  minParcel: { x: number; y: number }
  maxParcel: { x: number; y: number }
  paddingInParcels: number
  landscapeParcelKeys: string[]
}

export function createTerrainModel(sceneParcels: string[], borderPadding = 1): TerrainModel {
  const bounds = sceneParcelBounds(sceneParcels)
  const keys = landscapeParcelKeys(sceneParcels, borderPadding)

  return {
    minParcel: { x: bounds.minX - borderPadding, y: bounds.minY - borderPadding },
    maxParcel: { x: bounds.maxX + borderPadding, y: bounds.maxY + borderPadding },
    paddingInParcels: borderPadding,
    landscapeParcelKeys: keys
  }
}

export function isOccupiedParcel(parcelKeyStr: string, sceneParcels: string[]): boolean {
  return sceneParcels.includes(parcelKeyStr)
}

export function parcelMapCoord(parcelKeyStr: string): { x: number; y: number } {
  return parseParcelKey(parcelKeyStr)
}
