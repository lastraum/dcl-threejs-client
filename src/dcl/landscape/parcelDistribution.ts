import { PARCEL_SIZE } from '../content/types'
import { randomParcelLocalXZ } from './Utils/SceneSpace'

export type LocalXZ = { x: number; z: number }

/**
 * Poisson-like scatter inside a parcel — minimum separation so props don't clump.
 */
export function distributedParcelPositions(
  rng: () => number,
  count: number,
  opts: { inset?: number; minSeparation?: number; maxAttempts?: number } = {}
): LocalXZ[] {
  const inset = opts.inset ?? 1.2
  const minSep = opts.minSeparation ?? 2.8
  const maxAttempts = opts.maxAttempts ?? Math.max(count * 16, 32)
  const minSepSq = minSep * minSep
  const out: LocalXZ[] = []

  for (let attempt = 0; attempt < maxAttempts && out.length < count; attempt++) {
    const { x, z } = randomParcelLocalXZ(rng, inset)
    if (out.every((p) => (p.x - x) ** 2 + (p.z - z) ** 2 >= minSepSq)) {
      out.push({ x, z })
    }
  }

  return out
}

/**
 * Bias props toward the outer edge of a padding parcel (beach ring faces the ocean).
 * `towardOuter` 0 = random, 1 = strongly pushed to parcel edge away from scene center.
 */
export function biasedPaddingPosition(
  rng: () => number,
  parcelX: number,
  parcelY: number,
  sceneCenterPx: number,
  sceneCenterPy: number,
  towardOuter = 0.65
): LocalXZ {
  const dx = parcelX - sceneCenterPx
  const dy = parcelY - sceneCenterPy
  const len = Math.hypot(dx, dy) || 1
  const nx = dx / len
  const ny = dy / len

  const inset = 1.4
  const span = PARCEL_SIZE - inset * 2
  const baseX = inset + rng() * span
  const baseZ = inset + rng() * span

  const edgeX = nx > 0 ? PARCEL_SIZE - inset : nx < 0 ? inset : baseX
  const edgeZ = ny > 0 ? PARCEL_SIZE - inset : ny < 0 ? inset : baseZ

  return {
    x: baseX + (edgeX - baseX) * towardOuter,
    z: baseZ + (edgeZ - baseZ) * towardOuter
  }
}