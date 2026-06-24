import type { TerrainBrushMode } from './terrainSculptConstants'

export interface TerrainBrushConfig {
  sizeM: number
  strength: number
  mode: TerrainBrushMode
  waterLevelY: number
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function brushFalloff(dist: number, radius: number): number {
  const n = dist / Math.max(radius, 1e-6)
  if (n >= 1) return 0
  return Math.pow(1 - n, 2.2)
}

function computeBrushRadiusCells(
  sizeM: number,
  arenaWidthM: number,
  arenaDepthM: number,
  resolution: number
): number {
  return (sizeM / Math.max(arenaWidthM, arenaDepthM)) * resolution
}

export function smoothKernelRadiusCells(brushRadiusCells: number): number {
  return Math.max(3, Math.min(64, Math.round(brushRadiusCells * 0.42)))
}

function smoothPassCount(strength: number): number {
  if (strength < 0.2) return 1
  if (strength < 0.45) return 2
  return 3
}

function copyHeightRegion(
  heights: Float32Array,
  resolution: number,
  minIx: number,
  maxIx: number,
  minIz: number,
  maxIz: number
): { data: Float32Array; width: number; height: number } {
  const width = maxIx - minIx + 1
  const height = maxIz - minIz + 1
  const data = new Float32Array(width * height)
  for (let iz = minIz; iz <= maxIz; iz++) {
    for (let ix = minIx; ix <= maxIx; ix++) {
      data[(iz - minIz) * width + (ix - minIx)] = heights[iz * resolution + ix]!
    }
  }
  return { data, width, height }
}

function weightedNeighborAverage(
  region: Float32Array,
  regionMinIx: number,
  regionMinIz: number,
  regionW: number,
  regionH: number,
  resolution: number,
  x: number,
  z: number,
  kernelRadius: number
): number {
  let total = 0
  let weight = 0
  const sigma = Math.max(0.85, kernelRadius * 0.42)
  const inv2sig2 = 1 / (2 * sigma * sigma)
  const r2Max = kernelRadius * kernelRadius

  for (let dz = -kernelRadius; dz <= kernelRadius; dz++) {
    for (let dx = -kernelRadius; dx <= kernelRadius; dx++) {
      const d2 = dx * dx + dz * dz
      if (d2 > r2Max) continue
      const nx = x + dx
      const nz = z + dz
      if (nx < 0 || nz < 0 || nx >= resolution || nz >= resolution) continue
      const lx = nx - regionMinIx
      const lz = nz - regionMinIz
      if (lx < 0 || lz < 0 || lx >= regionW || lz >= regionH) continue
      const w = Math.exp(-d2 * inv2sig2)
      total += region[lz * regionW + lx]! * w
      weight += w
    }
  }

  if (weight <= 0) {
    const lx = x - regionMinIx
    const lz = z - regionMinIz
    return region[lz * regionW + lx]!
  }
  return total / weight
}

function applySmoothBrush(
  heights: Float32Array,
  resolution: number,
  centerIx: number,
  centerIz: number,
  arenaWidthM: number,
  arenaDepthM: number,
  config: TerrainBrushConfig
): void {
  const radiusCells = computeBrushRadiusCells(config.sizeM, arenaWidthM, arenaDepthM, resolution)
  const kernelRadius = smoothKernelRadiusCells(radiusCells)
  const baseStrength = config.strength * 1.35
  const passes = smoothPassCount(config.strength)

  const minIx = Math.max(0, centerIx - Math.ceil(radiusCells))
  const maxIx = Math.min(resolution - 1, centerIx + Math.ceil(radiusCells))
  const minIz = Math.max(0, centerIz - Math.ceil(radiusCells))
  const maxIz = Math.min(resolution - 1, centerIz + Math.ceil(radiusCells))

  const readMinIx = Math.max(0, minIx - kernelRadius)
  const readMaxIx = Math.min(resolution - 1, maxIx + kernelRadius)
  const readMinIz = Math.max(0, minIz - kernelRadius)
  const readMaxIz = Math.min(resolution - 1, maxIz + kernelRadius)

  for (let pass = 0; pass < passes; pass++) {
    const { data: region, width: regionW } = copyHeightRegion(
      heights,
      resolution,
      readMinIx,
      readMaxIx,
      readMinIz,
      readMaxIz
    )
    const passStrength = baseStrength * (pass === passes - 1 ? 1 : 0.72)

    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const dist = Math.hypot(ix - centerIx, iz - centerIz)
        if (dist > radiusCells) continue
        const falloff = brushFalloff(dist, radiusCells)
        const effective = Math.min(1, passStrength * falloff)
        const idx = iz * resolution + ix
        const current = heights[idx]!
        const target = weightedNeighborAverage(
          region,
          readMinIx,
          readMinIz,
          regionW,
          readMaxIz - readMinIz + 1,
          resolution,
          ix,
          iz,
          kernelRadius
        )
        heights[idx] = lerp(current, target, effective)
      }
    }
  }
}

export function applyHeightBrush(
  heights: Float32Array,
  resolution: number,
  centerIx: number,
  centerIz: number,
  arenaWidthM: number,
  arenaDepthM: number,
  config: TerrainBrushConfig,
  flattenTargetY: number
): void {
  if (config.mode === 'smooth') {
    applySmoothBrush(heights, resolution, centerIx, centerIz, arenaWidthM, arenaDepthM, config)
    return
  }

  const brushRadiusCells = computeBrushRadiusCells(config.sizeM, arenaWidthM, arenaDepthM, resolution)
  const baseStrength = config.strength * 1.5

  const minIx = Math.max(0, centerIx - Math.ceil(brushRadiusCells))
  const maxIx = Math.min(resolution - 1, centerIx + Math.ceil(brushRadiusCells))
  const minIz = Math.max(0, centerIz - Math.ceil(brushRadiusCells))
  const maxIz = Math.min(resolution - 1, centerIz + Math.ceil(brushRadiusCells))

  for (let iz = minIz; iz <= maxIz; iz++) {
    for (let ix = minIx; ix <= maxIx; ix++) {
      const dist = Math.hypot(ix - centerIx, iz - centerIz)
      if (dist > brushRadiusCells) continue
      const falloff = brushFalloff(dist, brushRadiusCells)
      const effective = baseStrength * falloff
      const idx = iz * resolution + ix
      const current = heights[idx]!

      if (config.mode === 'towater') {
        const t = Math.min(1, effective * 3)
        heights[idx] = lerp(current, config.waterLevelY, t)
        continue
      }

      switch (config.mode) {
        case 'raise':
          heights[idx] = current + effective
          break
        case 'lower':
          heights[idx] = current - effective
          break
        case 'flatten': {
          const diff = flattenTargetY - current
          heights[idx] = current + diff * effective * 0.4
          break
        }
      }
    }
  }
}

export function applyLavaBrush(
  lava: Uint8Array,
  resolution: number,
  centerIx: number,
  centerIz: number,
  arenaWidthM: number,
  sizeM: number,
  strength: number,
  erase: boolean
): void {
  const brushRadiusCells = (sizeM / arenaWidthM) * resolution
  const minIx = Math.max(0, centerIx - Math.ceil(brushRadiusCells))
  const maxIx = Math.min(resolution - 1, centerIx + Math.ceil(brushRadiusCells))
  const minIz = Math.max(0, centerIz - Math.ceil(brushRadiusCells))
  const maxIz = Math.min(resolution - 1, centerIz + Math.ceil(brushRadiusCells))
  const paintByte = Math.round(strength * 255)

  for (let iz = minIz; iz <= maxIz; iz++) {
    for (let ix = minIx; ix <= maxIx; ix++) {
      const dist = Math.hypot(ix - centerIx, iz - centerIz)
      if (dist > brushRadiusCells) continue
      const f = brushFalloff(dist, brushRadiusCells)
      const idx = iz * resolution + ix
      if (erase) {
        lava[idx] = Math.max(0, lava[idx]! - Math.round(paintByte * f))
      } else {
        lava[idx] = Math.min(255, lava[idx]! + Math.round(paintByte * f))
      }
    }
  }
}

export function applySplatBrush(
  rgba: Uint8Array,
  resolution: number,
  centerIx: number,
  centerIz: number,
  arenaWidthM: number,
  sizeM: number,
  strength: number,
  channel: 0 | 1 | 2 | 3,
  erase: boolean
): void {
  const brushRadiusCells = (sizeM / arenaWidthM) * resolution
  const minIx = Math.max(0, centerIx - Math.ceil(brushRadiusCells))
  const maxIx = Math.min(resolution - 1, centerIx + Math.ceil(brushRadiusCells))
  const minIz = Math.max(0, centerIz - Math.ceil(brushRadiusCells))
  const maxIz = Math.min(resolution - 1, centerIz + Math.ceil(brushRadiusCells))
  const paintByte = Math.round(strength * 255)

  for (let iz = minIz; iz <= maxIz; iz++) {
    for (let ix = minIx; ix <= maxIx; ix++) {
      const dist = Math.hypot(ix - centerIx, iz - centerIz)
      if (dist > brushRadiusCells) continue
      const f = brushFalloff(dist, brushRadiusCells)
      const idx = (iz * resolution + ix) * 4 + channel
      if (erase) {
        rgba[idx] = Math.max(0, rgba[idx]! - Math.round(paintByte * f))
      } else {
        rgba[idx] = Math.min(255, rgba[idx]! + Math.round(paintByte * f))
      }
    }
  }
}