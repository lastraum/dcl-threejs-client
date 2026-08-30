import type { WorldMapEntry } from './worldsCatalog'

/** Keep a spawn clearing so the landing disc isn't full of trunks. */
export const FOREST_LANDING_RADIUS_M = 10
export const FOREST_SPAWN_CLEARING_M = 11.4
/** Center of the nearest occupied pool — landing 10 + 10m gap + typical pool radius. */
export const FOREST_INNER_RING_M = 24
export const FOREST_OCCUPIED_RING_M = 62
export const FOREST_EMPTY_RING_M = 48
export const FOREST_OUTER_RING_M = 118
export const FOREST_RADIUS_M = 128
export const FOREST_MIN_POOL_GAP_M = 9.5
/** Shore-to-shore gap from the landing disc to the nearest world pool. */
export const FOREST_MIN_LANDING_GAP_M = 10
export const FOREST_TREE_COUNT = 85
export const FOREST_TREE_TILE_M = 48
export const FOREST_TREE_STREAM_RADIUS_M = 200
const FOREST_TREE_SEED = 0xf04e57
const FOREST_TREES_PER_TILE = 5

export type ForestPoolPose = {
  worldName: string
  users: number
  x: number
  z: number
  radius: number
  /** 0 = most active (closest). */
  rank: number
}

export type ForestTreePose = {
  x: number
  z: number
  height: number
  width: number
}

export type ForestSitterPose = {
  x: number
  z: number
  yaw: number
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

export function poolRadiusForUsers(users: number): number {
  return 2.35 + Math.log2(1 + Math.max(0, users)) * 0.42
}

export function minPoolDistanceFromOrigin(poolRadius: number): number {
  return FOREST_LANDING_RADIUS_M + poolRadius + FOREST_MIN_LANDING_GAP_M
}

/** Occupied worlds stay nearer spawn; empty worlds scatter through the forest. */
export function poolDistanceForUsers(users: number, maxUsers: number, scatter = 0.5): number {
  const u = Math.max(0, users)
  const s = Math.min(1, Math.max(0, scatter))
  if (u <= 0) {
    return FOREST_EMPTY_RING_M + s * (FOREST_OUTER_RING_M - FOREST_EMPTY_RING_M)
  }
  const max = Math.max(0, maxUsers)
  if (max <= 0) return FOREST_INNER_RING_M
  const t = 1 - Math.log2(1 + u) / Math.log2(1 + max)
  return FOREST_INNER_RING_M + t * (FOREST_OCCUPIED_RING_M - FOREST_INNER_RING_M)
}

function sortByActivity(entries: WorldMapEntry[]): WorldMapEntry[] {
  return [...entries].sort((a, b) => {
    const byUsers = b.users - a.users
    if (byUsers !== 0) return byUsers
    return a.worldName.localeCompare(b.worldName, undefined, { sensitivity: 'base' })
  })
}

/**
 * Deterministic pool layout: angle from world name, radius from occupancy.
 * Place most-active first and push later pools outward on overlap so rank
 * (closest = busiest) holds.
 */
export function layoutWorldPools(entries: WorldMapEntry[]): ForestPoolPose[] {
  const sorted = sortByActivity(entries)
  const maxUsers = sorted.reduce((m, e) => Math.max(m, e.users), 0)
  const placed: ForestPoolPose[] = []

  for (let rank = 0; rank < sorted.length; rank++) {
    const entry = sorted[rank]!
    const h = hashString(entry.worldName.toLowerCase())
    const angle = ((h % 3600) / 3600) * Math.PI * 2
    const scatter = ((h >>> 11) % 1000) / 1000
    let radius = Math.max(
      poolDistanceForUsers(entry.users, maxUsers, scatter),
      minPoolDistanceFromOrigin(poolRadiusForUsers(entry.users))
    )
    const poolR = poolRadiusForUsers(entry.users)
    let x = Math.cos(angle) * radius
    let z = Math.sin(angle) * radius

    for (let guard = 0; guard < 36; guard++) {
      let pushed = false
      const padMin = minPoolDistanceFromOrigin(poolR)
      const dPad = Math.hypot(x, z)
      if (dPad < padMin) {
        const extra = padMin - Math.max(dPad, 1e-4) + 0.08
        x += Math.cos(angle) * extra
        z += Math.sin(angle) * extra
        pushed = true
      }
      for (const other of placed) {
        const dx = x - other.x
        const dz = z - other.z
        const min = other.radius + poolR + FOREST_MIN_POOL_GAP_M
        const d = Math.hypot(dx, dz)
        if (d >= min) continue
        const extra = min - d + 0.08
        x += Math.cos(angle) * extra
        z += Math.sin(angle) * extra
        pushed = true
      }
      radius = Math.hypot(x, z)
      if (!pushed) break
    }

    placed.push({
      worldName: entry.worldName,
      users: entry.users,
      x,
      z,
      radius: poolR,
      rank
    })
  }

  return placed
}

export function layoutForestTrees(pools: ForestPoolPose[], count = FOREST_TREE_COUNT): ForestTreePose[] {
  const rng = mulberry32(FOREST_TREE_SEED)
  const trees: ForestTreePose[] = []
  let attempts = 0
  const maxAttempts = count * 36

  while (trees.length < count && attempts < maxAttempts) {
    attempts++
    const a = rng() * Math.PI * 2
    // Dense outer wall (image 15/17) plus trees between pools.
    const wall = rng() > 0.55
    const r = wall
      ? FOREST_OUTER_RING_M * 0.52 + rng() * (FOREST_RADIUS_M - FOREST_OUTER_RING_M * 0.52)
      : FOREST_SPAWN_CLEARING_M + Math.sqrt(rng()) * (FOREST_OUTER_RING_M - FOREST_SPAWN_CLEARING_M)
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    if (Math.hypot(x, z) < FOREST_SPAWN_CLEARING_M) continue

    const dist = Math.hypot(x, z)
    const height = (dist > 40 ? 18 : 12) + rng() * (dist > 40 ? 18 : 12)
    const width = height * 0.15
    let ok = true
    for (const p of pools) {
      if (Math.hypot(x - p.x, z - p.z) < p.radius + width * 0.5 + 1.6) {
        ok = false
        break
      }
    }
    if (!ok) continue
    for (const t of trees) {
      if (Math.hypot(x - t.x, z - t.z) < (width + t.width) * 0.52) {
        ok = false
        break
      }
    }
    if (!ok) continue
    trees.push({ x, z, height, width })
  }

  return trees
}

function tileRng(tx: number, tz: number): () => number {
  return mulberry32(FOREST_TREE_SEED ^ hashString(`${tx}:${tz}`))
}

/** Deterministic outer-forest trees for one world tile. Skips the catalog disc. */
export function treesForTile(tx: number, tz: number): ForestTreePose[] {
  const rng = tileRng(tx, tz)
  const tile = FOREST_TREE_TILE_M
  const out: ForestTreePose[] = []
  for (let i = 0; i < FOREST_TREES_PER_TILE; i++) {
    const x = tx * tile + (0.14 + rng() * 0.72) * tile
    const z = tz * tile + (0.14 + rng() * 0.72) * tile
    if (Math.hypot(x, z) < FOREST_RADIUS_M + 6) continue
    const height = 16 + rng() * 18
    out.push({ x, z, height, width: height * 0.15 })
  }
  return out
}

/** Outer trees in a radius around the walker — same spacing, continues forever. */
export function layoutStreamTrees(playerX: number, playerZ: number): ForestTreePose[] {
  const tile = FOREST_TREE_TILE_M
  const reach = FOREST_TREE_STREAM_RADIUS_M
  const tx0 = Math.floor((playerX - reach) / tile)
  const tz0 = Math.floor((playerZ - reach) / tile)
  const tx1 = Math.floor((playerX + reach) / tile)
  const tz1 = Math.floor((playerZ + reach) / tile)
  const out: ForestTreePose[] = []
  const r2 = reach * reach
  for (let tz = tz0; tz <= tz1; tz++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const trees = treesForTile(tx, tz)
      for (const t of trees) {
        const dx = t.x - playerX
        const dz = t.z - playerZ
        if (dx * dx + dz * dz > r2) continue
        out.push(t)
      }
    }
  }
  return out
}

/** Sitters equally spaced around the pond — 360° / n. Face the water. */
export function layoutPoolSitters(pool: ForestPoolPose, count: number): ForestSitterPose[] {
  const n = Math.max(0, Math.floor(count))
  if (n <= 0) return []
  const h = hashString(pool.worldName.toLowerCase())
  const toPad = Math.atan2(-pool.z, -pool.x)
  const step = (Math.PI * 2) / n
  const base =
    n <= 4
      ? toPad - (Math.min(step, (Math.PI * 0.72) / Math.max(1, n - 1)) * (n - 1)) / 2
      : ((h % 360) / 360) * Math.PI * 2
  const usedStep = n <= 4 ? Math.min(step, (Math.PI * 0.72) / Math.max(1, n - 1)) : step
  const minArc = 0.85
  const rim = Math.max(pool.radius + 0.7, (n * minArc) / (Math.PI * 2))
  const out: ForestSitterPose[] = []
  for (let i = 0; i < n; i++) {
    const ang = base + i * usedStep
    const x = pool.x + Math.cos(ang) * rim
    const z = pool.z + Math.sin(ang) * rim
    out.push({
      x,
      z,
      yaw: Math.atan2(-(pool.x - x), -(pool.z - z))
    })
  }
  return out
}
