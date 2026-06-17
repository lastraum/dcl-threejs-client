import { PARCEL_SIZE } from './types'

export type ParcelCoord = { x: number; y: number }

export function parseParcelKey(key: string): ParcelCoord {
  const [xs, ys] = key.split(',')
  return { x: Number(xs), y: Number(ys) }
}

export function parcelWorldOrigin(parcel: ParcelCoord, base: ParcelCoord): { x: number; z: number } {
  return {
    x: (parcel.x - base.x) * PARCEL_SIZE,
    z: (parcel.y - base.y) * PARCEL_SIZE
  }
}

export function parcelCenterWorld(parcel: ParcelCoord, base: ParcelCoord): { x: number; z: number } {
  const o = parcelWorldOrigin(parcel, base)
  return { x: o.x + PARCEL_SIZE / 2, z: o.z + PARCEL_SIZE / 2 }
}
