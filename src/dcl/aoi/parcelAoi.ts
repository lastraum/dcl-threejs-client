import { parseParcelKey, type ParcelCoord } from '../content/parseParcel'
import { PARCEL_SIZE } from '../content/types'

/**
 * Multi-scene AOI (FocusOwner model):
 * - **Warm + visual band** = user Scene Distance (`sceneLoadRadiusM`): roads, empty,
 *   composites, first-frame, script/manifest prefetch.
 * - **FocusOwner** = primary only (UI / audio / video / inputs / locomotion).
 * - **Live secondaries** = player→footprint ≤ enter (16m) boots; keep until player ≤ exit (80m).
 *
 * @deprecated Prefer `renderQuality.getSceneLoadRadiusM()`. Kept as fallback when
 * settings are unavailable (tests / early init). Default matches Scene Distance default (100m).
 */
export const SCENE_SCRIPT_WARM_RADIUS_M = 100

/** Absolute genesis parcel under a scene-local DCL feet position. */
export function absoluteParcelAtSceneLocal(
  dclX: number,
  dclZ: number,
  baseParcel: string
): ParcelCoord {
  const base = parseParcelKey(baseParcel)
  return {
    x: base.x + Math.floor(dclX / PARCEL_SIZE),
    y: base.y + Math.floor(dclZ / PARCEL_SIZE)
  }
}

/** Distance from a point (scene-local DCL meters) to a parcel's center (same space). */
export function distanceToParcelCenterM(
  dclX: number,
  dclZ: number,
  parcel: ParcelCoord,
  baseParcel: string
): number {
  const base = parseParcelKey(baseParcel)
  const cx = (parcel.x - base.x) * PARCEL_SIZE + PARCEL_SIZE / 2
  const cz = (parcel.y - base.y) * PARCEL_SIZE + PARCEL_SIZE / 2
  return Math.hypot(dclX - cx, dclZ - cz)
}

/**
 * Absolute parcel keys within `radiusM` of the player (scene-local feet).
 * Includes any primary scene parcels that fall inside the radius.
 */
export function parcelsInLoadRadius(
  dclX: number,
  dclZ: number,
  baseParcel: string,
  radiusM: number
): string[] {
  if (radiusM <= 0) return []
  const center = absoluteParcelAtSceneLocal(dclX, dclZ, baseParcel)
  const ring = Math.max(1, Math.ceil(radiusM / PARCEL_SIZE) + 1)
  const out: string[] = []
  for (let dx = -ring; dx <= ring; dx++) {
    for (let dy = -ring; dy <= ring; dy++) {
      const parcel = { x: center.x + dx, y: center.y + dy }
      if (distanceToParcelCenterM(dclX, dclZ, parcel, baseParcel) <= radiusM + PARCEL_SIZE * 0.5) {
        out.push(`${parcel.x},${parcel.y}`)
      }
    }
  }
  return out
}

/**
 * Stable SW for city-fill local space (Explorer roads, dirt plane, vacant scatter).
 * Parcel 0,0 — not the FocusOwner base. Scene graphs still offset from FocusOwner.
 */
export const GENESIS_CITY_FILL_ORIGIN = '0,0'

/** Genesis DCL meters from FocusOwner-local feet. */
export function genesisMetersFromSceneLocal(
  dclX: number,
  dclZ: number,
  primaryBase: string
): { x: number; z: number } {
  const base = parseParcelKey(primaryBase)
  return {
    x: dclX + base.x * PARCEL_SIZE,
    z: dclZ + base.y * PARCEL_SIZE
  }
}

/** Scene-local DCL SW corner of an absolute parcel relative to primary base. */
export function parcelSwSceneLocal(parcelKey: string, baseParcel: string): { x: number; z: number } {
  const base = parseParcelKey(baseParcel)
  const p = parseParcelKey(parcelKey)
  return {
    x: (p.x - base.x) * PARCEL_SIZE,
    z: (p.y - base.y) * PARCEL_SIZE
  }
}

/**
 * Edge distance (meters) between two absolute parcels as axis-aligned squares.
 * Adjacent parcels → 0; one parcel gap → PARCEL_SIZE (16). Overlap/same → 0.
 */
export function parcelEdgeDistanceM(a: ParcelCoord, b: ParcelCoord): number {
  const a0x = a.x * PARCEL_SIZE
  const a1x = (a.x + 1) * PARCEL_SIZE
  const a0z = a.y * PARCEL_SIZE
  const a1z = (a.y + 1) * PARCEL_SIZE
  const b0x = b.x * PARCEL_SIZE
  const b1x = (b.x + 1) * PARCEL_SIZE
  const b0z = b.y * PARCEL_SIZE
  const b1z = (b.y + 1) * PARCEL_SIZE
  const dx = Math.max(0, a0x - b1x, b0x - a1x)
  const dz = Math.max(0, a0z - b1z, b0z - a1z)
  return Math.hypot(dx, dz)
}

/**
 * Min edge distance between two scene footprints (absolute parcel keys).
 * Still used for discovery collars / nested-hole detection — **not** live boot.
 */
export function minSceneFootprintDistanceM(
  parcelsA: readonly string[],
  parcelsB: readonly string[]
): number {
  if (!parcelsA.length || !parcelsB.length) return Infinity
  let best = Infinity
  for (const ka of parcelsA) {
    let a: ParcelCoord
    try {
      a = parseParcelKey(ka.trim())
    } catch {
      continue
    }
    for (const kb of parcelsB) {
      try {
        const d = parcelEdgeDistanceM(a, parseParcelKey(kb.trim()))
        if (d < best) best = d
        if (best === 0) return 0
      } catch {
        /* bad key */
      }
    }
  }
  return best
}

/**
 * Min distance (meters) from **player feet** (scene-local DCL) to a scene footprint
 * as axis-aligned parcel squares. Inside any covered parcel → 0.
 * Live secondary enter/keep radii use this (not scene-to-scene).
 */
export function minPlayerToFootprintDistanceM(
  dclX: number,
  dclZ: number,
  footprintKeys: readonly string[],
  baseParcel: string
): number {
  if (!footprintKeys.length) return Infinity
  let best = Infinity
  for (const key of footprintKeys) {
    try {
      const sw = parcelSwSceneLocal(key.trim(), baseParcel)
      const minX = sw.x
      const maxX = sw.x + PARCEL_SIZE
      const minZ = sw.z
      const maxZ = sw.z + PARCEL_SIZE
      const dx = Math.max(0, minX - dclX, dclX - maxX)
      const dz = Math.max(0, minZ - dclZ, dclZ - maxZ)
      const d = Math.hypot(dx, dz)
      if (d < best) best = d
      if (best === 0) return 0
    } catch {
      /* bad key */
    }
  }
  return best
}

/**
 * Absolute parcel keys within `expandM` of any footprint parcel (edge distance).
 * Ensures nested hole / adjacent deployments are fetched even if the player is
 * on the far side of a multi-parcel primary.
 */
export function parcelsNearFootprint(
  footprintKeys: readonly string[],
  expandM: number
): string[] {
  if (!footprintKeys.length || expandM < 0) return []
  const ring = Math.max(0, Math.ceil(expandM / PARCEL_SIZE))
  const out = new Set<string>()
  for (const key of footprintKeys) {
    let p: ParcelCoord
    try {
      p = parseParcelKey(key.trim())
    } catch {
      continue
    }
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const q = { x: p.x + dx, y: p.y + dy }
        if (parcelEdgeDistanceM(p, q) <= expandM + 0.01) {
          out.add(`${q.x},${q.y}`)
        }
      }
    }
  }
  return [...out]
}
