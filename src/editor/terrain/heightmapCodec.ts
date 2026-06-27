import {
  ARENA_TERRAIN_HEIGHT_OFFSET,
  GENESIS_HEIGHTMAP_MAX_METERS,
  TERRAIN_SCULPT_DEFAULT_RESOLUTION
} from './terrainSculptConstants'

export const SCULPT_RESOLUTION = TERRAIN_SCULPT_DEFAULT_RESOLUTION

export function worldYToNormalized(worldY: number): number {
  return Math.max(0, Math.min(1, (worldY - ARENA_TERRAIN_HEIGHT_OFFSET) / GENESIS_HEIGHTMAP_MAX_METERS))
}

export function normalizedToWorldY(norm: number): number {
  return norm * GENESIS_HEIGHTMAP_MAX_METERS + ARENA_TERRAIN_HEIGHT_OFFSET
}

export function sampleBilinearNorm(
  data: Uint8ClampedArray,
  iw: number,
  ih: number,
  u: number,
  v: number
): number {
  const fu = Math.max(0, Math.min(1, u)) * (iw - 1)
  const fv = Math.max(0, Math.min(1, v)) * (ih - 1)
  const x0 = Math.floor(fu)
  const y0 = Math.floor(fv)
  const x1 = Math.min(x0 + 1, iw - 1)
  const y1 = Math.min(y0 + 1, ih - 1)
  const tx = fu - x0
  const ty = fv - y0
  const at = (x: number, y: number) => data[(y * iw + x) * 4] / 255
  const h0 = at(x0, y0) * (1 - tx) + at(x1, y0) * tx
  const h1 = at(x0, y1) * (1 - tx) + at(x1, y1) * tx
  return h0 * (1 - ty) + h1 * ty
}

export function heightsFromImageData(pixels: ImageData, resolution: number): Float32Array {
  const out = new Float32Array(resolution * resolution)
  const { width: iw, height: ih, data } = pixels
  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const u = col / (resolution - 1)
      const v = row / (resolution - 1)
      const norm = sampleBilinearNorm(data, iw, ih, u, v)
      out[row * resolution + col] = normalizedToWorldY(norm)
    }
  }
  return out
}

export function imageDataFromHeights(heights: Float32Array, resolution: number): ImageData {
  const img = new ImageData(resolution, resolution)
  for (let i = 0; i < heights.length; i++) {
    const byte = Math.round(worldYToNormalized(heights[i]!) * 255)
    const o = i * 4
    img.data[o] = byte
    img.data[o + 1] = byte
    img.data[o + 2] = byte
    img.data[o + 3] = 255
  }
  return img
}

export function imageDataToPngBlob(img: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(img, 0, 0)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('PNG encode failed'))
    }, 'image/png')
  })
}

/** Bilinear sample of world-Y height grid at normalized arena UV (genesis shared). */
export function sampleNearestWorldY(
  heights: Float32Array,
  resolution: number,
  u: number,
  v: number
): number {
  const ix = Math.min(resolution - 1, Math.round(Math.max(0, Math.min(1, u)) * (resolution - 1)))
  const iz = Math.min(resolution - 1, Math.round(Math.max(0, Math.min(1, v)) * (resolution - 1)))
  return heights[iz * resolution + ix]!
}

export function sampleBilinearWorldY(
  heights: Float32Array,
  resolution: number,
  u: number,
  v: number
): number {
  const fu = Math.max(0, Math.min(1, u)) * (resolution - 1)
  const fv = Math.max(0, Math.min(1, v)) * (resolution - 1)
  const x0 = Math.floor(fu)
  const y0 = Math.floor(fv)
  const x1 = Math.min(x0 + 1, resolution - 1)
  const y1 = Math.min(y0 + 1, resolution - 1)
  const tx = fu - x0
  const ty = fv - y0
  const at = (x: number, y: number) => heights[y * resolution + x]!
  const h0 = at(x0, y0) * (1 - tx) + at(x1, y0) * tx
  const h1 = at(x0, y1) * (1 - tx) + at(x1, y1) * tx
  return h0 * (1 - ty) + h1 * ty
}

export function worldToHeightUv(
  wx: number,
  wz: number,
  resolution: number,
  arenaWidthM: number,
  arenaDepthM: number,
  originX = 0,
  originZ = 0
): { u: number; v: number; fx: number; fz: number; ix: number; iz: number } {
  const u = Math.max(0, Math.min(1, (wx - originX) / arenaWidthM))
  const v = Math.max(0, Math.min(1, (wz - originZ) / arenaDepthM))
  const fx = u * (resolution - 1)
  const fz = v * (resolution - 1)
  return { u, v, fx, fz, ix: Math.floor(fx), iz: Math.floor(fz) }
}

export function worldToHeightIndex(
  wx: number,
  wz: number,
  resolution: number,
  arenaWidthM: number,
  arenaDepthM: number,
  originX = 0,
  originZ = 0
): { ix: number; iz: number } {
  const { ix, iz } = worldToHeightUv(
    wx,
    wz,
    resolution,
    arenaWidthM,
    arenaDepthM,
    originX,
    originZ
  )
  return { ix, iz }
}

/** Bilinear sample of a single-channel byte grid at normalized arena UV. */
export function sampleBilinearU8(
  data: Uint8Array,
  resolution: number,
  u: number,
  v: number,
  stride = 1,
  offset = 0
): number {
  const fu = Math.max(0, Math.min(1, u)) * (resolution - 1)
  const fv = Math.max(0, Math.min(1, v)) * (resolution - 1)
  const x0 = Math.floor(fu)
  const y0 = Math.floor(fv)
  const x1 = Math.min(x0 + 1, resolution - 1)
  const y1 = Math.min(y0 + 1, resolution - 1)
  const tx = fu - x0
  const ty = fv - y0
  const at = (x: number, y: number) => data[(y * resolution + x) * stride + offset]! / 255
  const h0 = at(x0, y0) * (1 - tx) + at(x1, y0) * tx
  const h1 = at(x0, y1) * (1 - tx) + at(x1, y1) * tx
  return h0 * (1 - ty) + h1 * ty
}