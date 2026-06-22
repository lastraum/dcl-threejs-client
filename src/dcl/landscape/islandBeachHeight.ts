import * as THREE from 'three'
import type { IslandShoreLayout } from './islandLandscapeKeys'
import { perlin01 } from './perlin2d'
import { EMPTY_LAND_GROUND_OFFSET } from './Utils/SceneSpace'
import { ISLAND_WATER_SURFACE_Y } from './IslandShoreMaterial'

/** Shared with GPU island shore height — keep in sync with `islandBeachHeight.glsl`. */
export const ISLAND_BEACH_HEIGHT_CONSTANTS = {
  heightmapBlendM: 10,
  beachMaxDropM: 1.2,
  duneAmpM: 0.18,
  heightSeed: 42,
  shoreYOffset: 0.2,
  terrainBaseY: EMPTY_LAND_GROUND_OFFSET.y,
  waterLevelY: ISLAND_WATER_SURFACE_Y,
  /** Metres below water where offshore samples are treated as open ocean. */
  offshoreDepthM: 5,
  /** Wave attenuation band above/below mean sea level (metres). */
  shoreDampWidthM: 6
} as const

function fbm01(x: number, z: number, seed: number): number {
  let v = 0
  let amp = 0.5
  let freq = 1
  for (let i = 0; i < 4; i++) {
    v += amp * perlin01(x * freq, z * freq, seed + i * 17)
    freq *= 2.03
    amp *= 0.5
  }
  return v
}

/** Procedural island beach height in DCL scene metres (matches shore heightmap mesh). */
export function beachHeightAtDcl(
  dclX: number,
  dclZ: number,
  distM: number,
  layout: IslandShoreLayout
): number {
  const c = ISLAND_BEACH_HEIGHT_CONSTANTS
  const baseY = c.terrainBaseY
  if (distM <= layout.flatRadiusM) return baseY

  const blendIn = THREE.MathUtils.smoothstep(
    layout.flatRadiusM,
    layout.flatRadiusM + c.heightmapBlendM,
    distM
  )
  const beachT = THREE.MathUtils.smoothstep(layout.flatRadiusM, layout.outerRadiusM, distM)
  const shoreY = c.waterLevelY + c.shoreYOffset
  const radialBase = THREE.MathUtils.lerp(baseY, shoreY, beachT * beachT * (3 - 2 * beachT))

  const nx = dclX * 0.07
  const nz = dclZ * 0.07
  const dunes = (fbm01(nx, nz, c.heightSeed) - 0.5) * c.duneAmpM
  const edgeDrop = beachT * c.beachMaxDropM * 0.12

  return radialBase + (dunes - edgeDrop) * blendIn
}

/** Height at Three.js world XZ (display space). Offshore → below water for masking. */
export function beachHeightAtThree(
  threeX: number,
  threeZ: number,
  layout: IslandShoreLayout,
  centerThree: { x: number; z: number }
): number {
  const c = ISLAND_BEACH_HEIGHT_CONSTANTS
  const distM = Math.hypot(threeX - centerThree.x, threeZ - centerThree.z)
  if (distM > layout.outerRadiusM + 2) {
    return c.waterLevelY - c.offshoreDepthM
  }
  const dclX = -threeX
  const dclZ = threeZ
  return beachHeightAtDcl(dclX, dclZ, distM, layout)
}