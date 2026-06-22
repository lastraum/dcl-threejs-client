import type { ParcelBounds } from './Utils/ParcelGrid'

/** Outer scatter ring radius in parcel cells beyond the deployed scene footprint. */
export const OUTER_SCATTER_RADIUS_PARCELS = 48

export function parcelDistFromScene(px: number, py: number, bounds: ParcelBounds): number {
  const dx = Math.max(bounds.minX - px, 0, px - bounds.maxX)
  const dy = Math.max(bounds.minY - py, 0, py - bounds.maxY)
  return Math.max(dx, dy)
}

/** Full density just outside the padding ring → 0 at the outer radius. */
export function outerDistanceFalloff(distParcels: number, paddingDepth = 1): number {
  if (distParcels > OUTER_SCATTER_RADIUS_PARCELS) return 0
  const inner = paddingDepth
  const span = OUTER_SCATTER_RADIUS_PARCELS - inner
  const t = Math.max(0, (distParcels - inner) / span)
  return (1 - t) * (1 - t)
}