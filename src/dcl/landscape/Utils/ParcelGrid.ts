import { parseParcelKey, type ParcelCoord } from '../../content/parseParcel'

export type ParcelBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export function parcelKey(coord: ParcelCoord): string {
  return `${coord.x},${coord.y}`
}

export function sceneParcelBounds(sceneParcels: string[]): ParcelBounds {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const key of sceneParcels) {
    const { x, y } = parseParcelKey(key)
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }

  if (!Number.isFinite(minX)) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  }

  return { minX, maxX, minY, maxY }
}

/** Scene footprint + border padding ring (Unity TerrainModel.borderPadding). */
export function landscapeParcelKeys(sceneParcels: string[], padding = 1): string[] {
  const bounds = sceneParcelBounds(sceneParcels)
  const keys = new Set<string>()

  for (let y = bounds.minY - padding; y <= bounds.maxY + padding; y++) {
    for (let x = bounds.minX - padding; x <= bounds.maxX + padding; x++) {
      keys.add(parcelKey({ x, y }))
    }
  }

  return [...keys].sort((a, b) => {
    const pa = parseParcelKey(a)
    const pb = parseParcelKey(b)
    return pa.y - pb.y || pa.x - pb.x
  })
}

export function isSceneParcel(key: string, sceneParcels: string[]): boolean {
  return sceneParcels.includes(key)
}
