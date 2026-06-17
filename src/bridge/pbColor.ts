import * as THREE from 'three'

type Color3 = { r?: number; g?: number; b?: number }
type Color4 = { r?: number; g?: number; b?: number; a?: number }

export function color3ToThree(c: Color3 | undefined, fallback = 0xffffff): THREE.Color {
  if (!c) return new THREE.Color(fallback)
  return new THREE.Color(c.r ?? 1, c.g ?? 1, c.b ?? 1)
}

export function color4ToThree(c: Color4 | undefined, fallback = 0xffffff): THREE.Color {
  if (!c) return new THREE.Color(fallback)
  return new THREE.Color(c.r ?? 1, c.g ?? 1, c.b ?? 1)
}

export function color4Alpha(c: Color4 | undefined, fallback = 1): number {
  if (!c || c.a === undefined) return fallback
  return c.a
}

/**
 * DCL candelas → Three.js Point/Spot intensity.
 * Three.js 0.175 documents candelas, but this client has no tone-mapping / exposure
 * pipeline yet — raw ECS values (~16000 cd default) blow out the scene. Explorer parity
 * uses candelas / 4000 (default 16000 → intensity 4).
 */
export function lightIntensityFromCandelas(candelas: number | undefined): number {
  const v = candelas ?? 16000
  return Math.max(0, v / 4000)
}

export function lightRangeMeters(intensity: number | undefined, range: number | undefined): number {
  const i = intensity ?? 16000
  const autoRange = Math.pow(Math.max(i, 1), 0.25)
  if (range !== undefined && range >= 0) return Math.min(range, autoRange)
  return autoRange
}
