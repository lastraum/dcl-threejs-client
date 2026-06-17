/** Parcel-seeded RNG — same parcel coords → same decoration layout (Explorer uses baked WorldsTrees.bin). */
export function hashParcelCoords(x: number, y: number, salt = 0): number {
  return ((x * 374761393 + y * 668265263 + salt * 982451653) >>> 0)
}

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

export function pickInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}
