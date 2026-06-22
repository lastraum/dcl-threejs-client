/** Lightweight 2D Perlin noise for deterministic prop density (land / desert scatter). */
const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1]
] as const

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a)
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 982451653) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  return (h ^ (h >>> 16)) >>> 0
}

function grad2(h: number, x: number, y: number): number {
  const g = GRAD[h & 7]!
  return g[0] * x + g[1] * y
}

export function perlin2d(x: number, y: number, seed = 0): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const xf = x - x0
  const yf = y - y0

  const h00 = hash2(x0, y0, seed) & 255
  const h10 = hash2(x0 + 1, y0, seed) & 255
  const h01 = hash2(x0, y0 + 1, seed) & 255
  const h11 = hash2(x0 + 1, y0 + 1, seed) & 255

  const u = fade(xf)
  const v = fade(yf)

  const n00 = grad2(h00, xf, yf)
  const n10 = grad2(h10, xf - 1, yf)
  const n01 = grad2(h01, xf, yf - 1)
  const n11 = grad2(h11, xf - 1, yf - 1)

  const nx0 = lerp(n00, n10, u)
  const nx1 = lerp(n01, n11, u)
  return lerp(nx0, nx1, v)
}

/** Map Perlin sample to 0..1. */
export function perlin01(x: number, y: number, seed = 0): number {
  return perlin2d(x, y, seed) * 0.5 + 0.5
}