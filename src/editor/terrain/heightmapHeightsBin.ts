/** GSH1 binary heightfield codec — genesis-games parity. */

export const HEIGHTS_BIN_MAGIC = 0x47534831

export function encodeHeightsBin(heights: Float32Array, resolution: number): ArrayBuffer {
  if (heights.length !== resolution * resolution) {
    throw new Error(`encodeHeightsBin: expected ${resolution * resolution} floats, got ${heights.length}`)
  }
  const out = new ArrayBuffer(8 + heights.byteLength)
  const view = new DataView(out)
  view.setUint32(0, HEIGHTS_BIN_MAGIC, false)
  view.setUint32(4, resolution, true)
  new Float32Array(out, 8).set(heights)
  return out
}

export type DecodedHeightsBin = { resolution: number; heights: Float32Array }

export function decodeHeightsBin(
  buf: ArrayBuffer | ArrayBufferView,
  expectedResolution?: number
): DecodedHeightsBin | null {
  const view =
    buf instanceof ArrayBuffer
      ? new DataView(buf)
      : new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.byteLength < 8) return null
  if (view.getUint32(0, false) !== HEIGHTS_BIN_MAGIC) return null
  const resolution = view.getUint32(4, true)
  if (resolution < 2 || (expectedResolution !== undefined && resolution !== expectedResolution)) return null
  const bytes = 8 + resolution * resolution * 4
  if (view.byteLength < bytes) return null
  const slice =
    buf instanceof ArrayBuffer
      ? buf.slice(8, bytes)
      : buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + bytes)
  return { resolution, heights: new Float32Array(slice) }
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