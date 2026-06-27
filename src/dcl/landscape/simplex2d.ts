/**
 * 2D simplex noise — ported from ez-tree `noise.js`.
 * @see https://github.com/dgreenheck/ez-tree/blob/main/src/app/noise.js
 */
export function simplex2d(x: number, y: number): number {
  const Cx = 0.211324865405187
  const Cy = 0.366025403784439
  const Cz = -0.577350269189626
  const Cw = 0.024390243902439

  const iX = Math.floor(x + Cy * (x + y))
  const iY = Math.floor(y + Cy * (x + y))

  const x0x = x - iX + Cx * (iX + iY)
  const x0y = y - iY + Cx * (iX + iY)

  const i1x = x0x > x0y ? 1.0 : 0.0
  const i1y = x0x > x0y ? 0.0 : 1.0

  const x12x = x0x + Cx - i1x
  const x12y = x0y + Cx - i1y
  const x12z = x0x + Cz
  const x12w = x0y + Cz

  let p0y = iY - Math.floor(iY * (1.0 / 289.0)) * 289.0
  let p0x = iX - Math.floor(iX * (1.0 / 289.0)) * 289.0

  const permute = (vx: number, vy: number, vz: number): [number, number, number] => {
    const mod = (n: number) => n - Math.floor(n / 289.0) * 289.0
    const px = mod(((vx * 34.0) + 1.0) * vx)
    const py = mod(((vy * 34.0) + 1.0) * vy)
    const pz = mod(((vz * 34.0) + 1.0) * vz)
    return [px, py, pz]
  }

  let [p0, p1, p2] = permute(p0y, p0y + i1y, p0y + 1.0)
  ;[p0, p1, p2] = permute(p0 + p0x, p1 + p0x + i1x, p2 + p0x + 1.0)

  const m0 = Math.max(0.0, 0.5 - (x0x * x0x + x0y * x0y))
  const m1 = Math.max(0.0, 0.5 - (x12x * x12x + x12y * x12y))
  const m2 = Math.max(0.0, 0.5 - (x12z * x12z + x12w * x12w))

  let m0sq = m0 * m0
  let m1sq = m1 * m1
  let m2sq = m2 * m2
  m0sq *= m0sq
  m1sq *= m1sq
  m2sq *= m2sq

  const fract = (n: number) => 2.0 * (n * Cw - Math.floor(n * Cw)) - 1.0
  const xx = fract(p0)
  const xy = fract(p1)
  const xz = fract(p2)

  const h0 = Math.abs(xx) - 0.5
  const h1 = Math.abs(xy) - 0.5
  const h2 = Math.abs(xz) - 0.5

  const ox0 = Math.floor(xx + 0.5)
  const ox1 = Math.floor(xy + 0.5)
  const ox2 = Math.floor(xz + 0.5)

  const a0x = xx - ox0
  const a1x = xy - ox1
  const a2x = xz - ox2

  const g0 = a0x * x0x + h0 * x0y
  const g1 = a1x * x12x + h1 * x12y
  const g2 = a2x * x12z + h2 * x12w

  const w0 = m0sq * (1.79284291400159 - 0.85373472095314 * (a0x * a0x + h0 * h0))
  const w1 = m1sq * (1.79284291400159 - 0.85373472095314 * (a1x * a1x + h1 * h1))
  const w2 = m2sq * (1.79284291400159 - 0.85373472095314 * (a2x * a2x + h2 * h2))

  return 130.0 * (w0 * g0 + w1 * g1 + w2 * g2)
}