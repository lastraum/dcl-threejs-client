import type { TerrainBrushMode } from './terrainSculptConstants'

export interface TerrainBrushConfig {
  sizeM: number
  strength: number
  mode: TerrainBrushMode
  waterLevelY: number
  liveStroke?: boolean
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function brushFalloff(dist: number, radius: number): number {
  const n = dist / Math.max(radius, 1e-6)
  if (n >= 1) return 0
  return Math.pow(1 - n, 2.2)
}

/** Wide, soft falloff for paint — smootherstep with slight radius bleed. */
function paintBrushFalloff(dist: number, radius: number): number {
  const n = dist / Math.max(radius * 1.12, 1e-6)
  if (n >= 1) return 0
  const t = 1 - n
  return t * t * t * (t * (t * 6 - 15) + 10)
}

const PAINT_SOFTEN_RADIUS = 2

function softenByteChannel(
  grid: Uint8Array,
  resolution: number,
  minIx: number,
  maxIx: number,
  minIz: number,
  maxIz: number,
  stride: number,
  offset: number,
  radius: number
): void {
  const w = maxIx - minIx + 1
  const h = maxIz - minIz + 1
  const src = new Float32Array(w * h)
  for (let iz = minIz; iz <= maxIz; iz++) {
    for (let ix = minIx; ix <= maxIx; ix++) {
      src[(iz - minIz) * w + (ix - minIx)] = grid[(iz * resolution + ix) * stride + offset]!
    }
  }
  const tmp = new Float32Array(src.length)
  const blurred = new Float32Array(src.length)
  boxBlurHorizontal(src, tmp, w, h, radius)
  boxBlurVertical(tmp, blurred, w, h, radius)
  for (let iz = minIz; iz <= maxIz; iz++) {
    for (let ix = minIx; ix <= maxIx; ix++) {
      const v = blurred[(iz - minIz) * w + (ix - minIx)]!
      grid[(iz * resolution + ix) * stride + offset] = Math.max(0, Math.min(255, Math.round(v)))
    }
  }
}

function softenSplatRegion(
  splat: Uint8Array,
  resolution: number,
  minIx: number,
  maxIx: number,
  minIz: number,
  maxIz: number
): void {
  for (let ch = 0; ch < 4; ch++) {
    softenByteChannel(splat, resolution, minIx, maxIx, minIz, maxIz, 4, ch, PAINT_SOFTEN_RADIUS)
  }
}

function softenLavaRegion(
  lava: Uint8Array,
  resolution: number,
  minIx: number,
  maxIx: number,
  minIz: number,
  maxIz: number
): void {
  softenByteChannel(lava, resolution, minIx, maxIx, minIz, maxIz, 1, 0, PAINT_SOFTEN_RADIUS)
}

/** `radiusM` is brush radius in world metres (matches sculpt panel “Radius” slider). */
export function computeBrushRadiusCells(
  radiusM: number,
  arenaWidthM: number,
  arenaDepthM: number,
  resolution: number
): number {
  const spanM = Math.max(arenaWidthM, arenaDepthM, 1e-6)
  return (Math.max(0, radiusM) / spanM) * resolution
}

/** Box-blur kernel — capped for 1024² interactive sculpt. */
export function smoothKernelRadiusCells(brushRadiusCells: number): number {
  return Math.max(4, Math.min(20, Math.round(brushRadiusCells * 0.35)))
}

function smoothPassCount(strength: number): number {
  if (strength < 0.35) return 1
  return 2
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

function boxBlurHorizontal(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  radius: number
): void {
  for (let iz = 0; iz < height; iz++) {
    for (let ix = 0; ix < width; ix++) {
      let sum = 0
      let count = 0
      for (let dx = -radius; dx <= radius; dx++) {
        const sx = ix + dx
        if (sx < 0 || sx >= width) continue
        sum += src[iz * width + sx]!
        count++
      }
      dst[iz * width + ix] = count > 0 ? sum / count : src[iz * width + ix]!
    }
  }
}

function boxBlurVertical(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  radius: number
): void {
  for (let iz = 0; iz < height; iz++) {
    for (let ix = 0; ix < width; ix++) {
      let sum = 0
      let count = 0
      for (let dz = -radius; dz <= radius; dz++) {
        const sz = iz + dz
        if (sz < 0 || sz >= height) continue
        sum += src[sz * width + ix]!
        count++
      }
      dst[iz * width + ix] = count > 0 ? sum / count : src[iz * width + ix]!
    }
  }
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
  const regionH = readMaxIz - readMinIz + 1

  for (let pass = 0; pass < passes; pass++) {
    const { data: region, width: regionW } = copyHeightRegion(
      heights,
      resolution,
      readMinIx,
      readMaxIx,
      readMinIz,
      readMaxIz
    )
    const tmp = new Float32Array(region.length)
    const blurred = new Float32Array(region.length)
    boxBlurHorizontal(region, tmp, regionW, regionH, kernelRadius)
    boxBlurVertical(tmp, blurred, regionW, regionH, kernelRadius)
    const passStrength = baseStrength * (pass === passes - 1 ? 1 : 0.75)

    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const dist = Math.hypot(ix - centerIx, iz - centerIz)
        if (dist > radiusCells) continue
        const falloff = brushFalloff(dist, radiusCells)
        const effective = Math.min(1, passStrength * falloff)
        const lx = ix - readMinIx
        const lz = iz - readMinIz
        const target = blurred[lz * regionW + lx]!
        const idx = iz * resolution + ix
        heights[idx] = lerp(heights[idx]!, target, effective)
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
  centerFx: number,
  centerFz: number,
  arenaWidthM: number,
  arenaDepthM: number,
  sizeM: number,
  strength: number,
  erase: boolean
): void {
  const brushRadiusCells = computeBrushRadiusCells(sizeM, arenaWidthM, arenaDepthM, resolution)
  const minIx = Math.max(0, Math.floor(centerFx - brushRadiusCells))
  const maxIx = Math.min(resolution - 1, Math.ceil(centerFx + brushRadiusCells))
  const minIz = Math.max(0, Math.floor(centerFz - brushRadiusCells))
  const maxIz = Math.min(resolution - 1, Math.ceil(centerFz + brushRadiusCells))
  const target = erase ? 0 : 255

  for (let iz = minIz; iz <= maxIz; iz++) {
    for (let ix = minIx; ix <= maxIx; ix++) {
      const dist = Math.hypot(ix + 0.5 - centerFx, iz + 0.5 - centerFz)
      if (dist > brushRadiusCells * 1.12) continue
      const t = Math.min(1, paintBrushFalloff(dist, brushRadiusCells) * strength * 1.15)
      const idx = iz * resolution + ix
      lava[idx] = Math.round(lerp(lava[idx]!, target, t))
    }
  }

  const softenMinIx = Math.max(0, minIx - PAINT_SOFTEN_RADIUS)
  const softenMaxIx = Math.min(resolution - 1, maxIx + PAINT_SOFTEN_RADIUS)
  const softenMinIz = Math.max(0, minIz - PAINT_SOFTEN_RADIUS)
  const softenMaxIz = Math.min(resolution - 1, maxIz + PAINT_SOFTEN_RADIUS)
  softenLavaRegion(lava, resolution, softenMinIx, softenMaxIx, softenMinIz, softenMaxIz)
}

export function applySplatBrush(
  rgba: Uint8Array,
  resolution: number,
  centerFx: number,
  centerFz: number,
  arenaWidthM: number,
  arenaDepthM: number,
  sizeM: number,
  strength: number,
  channel: 0 | 1 | 2 | 3,
  erase: boolean
): void {
  const brushRadiusCells = computeBrushRadiusCells(sizeM, arenaWidthM, arenaDepthM, resolution)
  const minIx = Math.max(0, Math.floor(centerFx - brushRadiusCells))
  const maxIx = Math.min(resolution - 1, Math.ceil(centerFx + brushRadiusCells))
  const minIz = Math.max(0, Math.floor(centerFz - brushRadiusCells))
  const maxIz = Math.min(resolution - 1, Math.ceil(centerFz + brushRadiusCells))
  const targets = [0, 0, 0, 0]
  if (!erase) targets[channel] = 255

  for (let iz = minIz; iz <= maxIz; iz++) {
    for (let ix = minIx; ix <= maxIx; ix++) {
      const dist = Math.hypot(ix + 0.5 - centerFx, iz + 0.5 - centerFz)
      if (dist > brushRadiusCells * 1.12) continue
      const t = Math.min(1, paintBrushFalloff(dist, brushRadiusCells) * strength * 1.15)
      const base = (iz * resolution + ix) * 4
      for (let ch = 0; ch < 4; ch++) {
        rgba[base + ch] = Math.round(lerp(rgba[base + ch]!, targets[ch]!, t))
      }
    }
  }

  const softenMinIx = Math.max(0, minIx - PAINT_SOFTEN_RADIUS)
  const softenMaxIx = Math.min(resolution - 1, maxIx + PAINT_SOFTEN_RADIUS)
  const softenMinIz = Math.max(0, minIz - PAINT_SOFTEN_RADIUS)
  const softenMaxIz = Math.min(resolution - 1, maxIz + PAINT_SOFTEN_RADIUS)
  softenSplatRegion(rgba, resolution, softenMinIx, softenMaxIx, softenMinIz, softenMaxIz)
}