/**
 * A* veins on the forest floor — detour around tree trunks, stop at pool shores.
 */
import {
  FOREST_LANDING_RADIUS_M,
  FOREST_RADIUS_M,
  type ForestTreePose
} from './worldsForestLayout'

export type VeinWaypoint = { x: number; z: number }

export type VeinPath = {
  live: boolean
  destX: number
  destZ: number
  points: VeinWaypoint[]
  kind: 'pool' | 'tree'
}

export type VeinPoolInput = {
  x: number
  z: number
  radius: number
  live: boolean
}

export const VEIN_GRID_CELL_M = 1.35
const TREE_CLEAR_M = 1.15
const POOL_CLEAR_M = 0.28
const MAX_EXPAND = 24_000
const RIBBON_HALF_M = 0.36

const N8: Array<[number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, 1.414],
  [1, -1, 1.414],
  [-1, 1, 1.414],
  [-1, -1, 1.414]
]

type Grid = {
  cell: number
  origin: number
  w: number
  blocked: Uint8Array
}

type Cell = { ix: number; iz: number }

function makeGrid(): Grid {
  const cell = VEIN_GRID_CELL_M
  const origin = -FOREST_RADIUS_M
  const w = Math.ceil((FOREST_RADIUS_M * 2) / cell) + 2
  return { cell, origin, w, blocked: new Uint8Array(w * w) }
}

function inGrid(g: Grid, ix: number, iz: number): boolean {
  return ix >= 0 && iz >= 0 && ix < g.w && iz < g.w
}

function idx(g: Grid, ix: number, iz: number): number {
  return iz * g.w + ix
}

function worldToCell(g: Grid, x: number, z: number): Cell {
  return {
    ix: Math.max(0, Math.min(g.w - 1, Math.floor((x - g.origin) / g.cell))),
    iz: Math.max(0, Math.min(g.w - 1, Math.floor((z - g.origin) / g.cell)))
  }
}

function cellToWorld(g: Grid, ix: number, iz: number): VeinWaypoint {
  return {
    x: g.origin + (ix + 0.5) * g.cell,
    z: g.origin + (iz + 0.5) * g.cell
  }
}

function stampCircle(g: Grid, x: number, z: number, radius: number): void {
  const r = Math.max(g.cell * 0.6, radius)
  const min = worldToCell(g, x - r, z - r)
  const max = worldToCell(g, x + r, z + r)
  const r2 = r * r
  for (let iz = min.iz; iz <= max.iz; iz++) {
    for (let ix = min.ix; ix <= max.ix; ix++) {
      const p = cellToWorld(g, ix, iz)
      const dx = p.x - x
      const dz = p.z - z
      if (dx * dx + dz * dz <= r2) g.blocked[idx(g, ix, iz)] = 1
    }
  }
}

function clearCircle(g: Grid, x: number, z: number, radius: number): void {
  const r = Math.max(g.cell * 0.55, radius)
  const min = worldToCell(g, x - r, z - r)
  const max = worldToCell(g, x + r, z + r)
  const r2 = r * r
  for (let iz = min.iz; iz <= max.iz; iz++) {
    for (let ix = min.ix; ix <= max.ix; ix++) {
      const p = cellToWorld(g, ix, iz)
      const dx = p.x - x
      const dz = p.z - z
      if (dx * dx + dz * dz <= r2) g.blocked[idx(g, ix, iz)] = 0
    }
  }
}

function nearestOpen(g: Grid, ix: number, iz: number): Cell | null {
  if (inGrid(g, ix, iz) && !g.blocked[idx(g, ix, iz)]) return { ix, iz }
  for (let rad = 1; rad <= 8; rad++) {
    for (let dz = -rad; dz <= rad; dz++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== rad) continue
        const nx = ix + dx
        const nz = iz + dz
        if (inGrid(g, nx, nz) && !g.blocked[idx(g, nx, nz)]) return { ix: nx, iz: nz }
      }
    }
  }
  return null
}

function losClear(g: Grid, ax: number, az: number, bx: number, bz: number): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (g.cell * 0.45)))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = ax + (bx - ax) * t
    const z = az + (bz - az) * t
    const c = worldToCell(g, x, z)
    if (g.blocked[idx(g, c.ix, c.iz)]) return false
  }
  return true
}

function smoothPath(g: Grid, pts: VeinWaypoint[]): VeinWaypoint[] {
  if (pts.length <= 2) return pts
  const out: VeinWaypoint[] = [pts[0]!]
  let i = 0
  while (i < pts.length - 1) {
    let j = pts.length - 1
    while (j > i + 1) {
      const a = pts[i]!
      const b = pts[j]!
      if (losClear(g, a.x, a.z, b.x, b.z)) break
      j--
    }
    out.push(pts[j]!)
    i = j
  }
  return out
}

function heapSiftUp(heap: number[], fOf: Float32Array, i: number): void {
  while (i > 0) {
    const p = (i - 1) >> 1
    if (fOf[heap[p]!]! <= fOf[heap[i]!]!) break
    const tmp = heap[p]!
    heap[p] = heap[i]!
    heap[i] = tmp
    i = p
  }
}

function heapSiftDown(heap: number[], fOf: Float32Array, i: number): void {
  const n = heap.length
  while (true) {
    let best = i
    const l = i * 2 + 1
    const r = l + 1
    if (l < n && fOf[heap[l]!]! < fOf[heap[best]!]!) best = l
    if (r < n && fOf[heap[r]!]! < fOf[heap[best]!]!) best = r
    if (best === i) break
    const tmp = heap[i]!
    heap[i] = heap[best]!
    heap[best] = tmp
    i = best
  }
}

function astar(g: Grid, start: Cell, goal: Cell): VeinWaypoint[] | null {
  const n = g.w * g.w
  const gScore = new Float32Array(n)
  gScore.fill(1e9)
  const parent = new Int32Array(n)
  parent.fill(-1)
  const closed = new Uint8Array(n)
  const fOf = new Float32Array(n)
  fOf.fill(1e9)
  const heap: number[] = []

  const s = idx(g, start.ix, start.iz)
  const t = idx(g, goal.ix, goal.iz)
  gScore[s] = 0
  fOf[s] = Math.hypot(goal.ix - start.ix, goal.iz - start.iz)
  heap.push(s)

  let expands = 0
  while (heap.length && expands < MAX_EXPAND) {
    expands++
    const cur = heap[0]!
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      heapSiftDown(heap, fOf, 0)
    }
    if (cur === t) break
    if (closed[cur]) continue
    closed[cur] = 1
    const cx = cur % g.w
    const cz = (cur / g.w) | 0
    for (const [dx, dz, cost] of N8) {
      const nx = cx + dx
      const nz = cz + dz
      if (!inGrid(g, nx, nz)) continue
      const ni = idx(g, nx, nz)
      if (g.blocked[ni] || closed[ni]) continue
      const ng = gScore[cur]! + cost
      if (ng >= gScore[ni]!) continue
      parent[ni] = cur
      gScore[ni] = ng
      fOf[ni] = ng + Math.hypot(goal.ix - nx, goal.iz - nz)
      heap.push(ni)
      heapSiftUp(heap, fOf, heap.length - 1)
    }
  }

  if (parent[t] < 0 && s !== t) return null
  const cells: number[] = []
  let c = t
  let guard = 0
  while (c >= 0 && guard++ < n) {
    cells.push(c)
    if (c === s) break
    c = parent[c]!
  }
  cells.reverse()
  if (cells[0] !== s) return null
  return cells.map((id) => cellToWorld(g, id % g.w, (id / g.w) | 0))
}

function rimPoint(x: number, z: number, radius: number): VeinWaypoint {
  const d = Math.hypot(x, z) || 1
  return { x: (x / d) * radius, z: (z / d) * radius }
}

function resamplePath(pts: VeinWaypoint[], spacing: number): VeinWaypoint[] {
  if (pts.length < 2) return pts
  const out: VeinWaypoint[] = [pts[0]!]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const seg = Math.hypot(b.x - a.x, b.z - a.z)
    if (seg < 1e-4) continue
    let used = 0
    while (carry + (seg - used) >= spacing) {
      const need = spacing - carry
      const t = (used + need) / seg
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })
      used += need
      carry = 0
    }
    carry += seg - used
  }
  const last = pts[pts.length - 1]!
  const tail = out[out.length - 1]!
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > spacing * 0.25) out.push(last)
  else out[out.length - 1] = last
  return out
}

function hash21(x: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function fade(t: number): number {
  return t * t * (3 - 2 * t)
}

function valueNoise(x: number, z: number): number {
  const x0 = Math.floor(x)
  const z0 = Math.floor(z)
  const fx = fade(x - x0)
  const fz = fade(z - z0)
  const a = hash21(x0, z0)
  const b = hash21(x0 + 1, z0)
  const c = hash21(x0, z0 + 1)
  const d = hash21(x0 + 1, z0 + 1)
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz
}

function fbm(x: number, z: number): number {
  let n = 0
  let amp = 1
  let freq = 1
  let sum = 0
  for (let i = 0; i < 3; i++) {
    n += (valueNoise(x * freq, z * freq) * 2 - 1) * amp
    sum += amp
    amp *= 0.5
    freq *= 2.07
  }
  return n / sum
}

/** Organic lateral wobble — pin the landing and tree ends. */
export function wiggleTreePath(pts: VeinWaypoint[], destX: number, destZ: number): VeinWaypoint[] {
  const dense = resamplePath(pts, 0.62)
  if (dense.length < 3) return dense
  const seed = destX * 0.17 + destZ * 0.31
  const lens: number[] = [0]
  let acc = 0
  for (let i = 1; i < dense.length; i++) {
    acc += Math.hypot(dense[i]!.x - dense[i - 1]!.x, dense[i]!.z - dense[i - 1]!.z)
    lens.push(acc)
  }
  const total = Math.max(acc, 1e-4)
  const out: VeinWaypoint[] = []
  for (let i = 0; i < dense.length; i++) {
    const p = dense[i]!
    if (i === 0 || i === dense.length - 1) {
      out.push({ x: p.x, z: p.z })
      continue
    }
    const prev = dense[i - 1]!
    const next = dense[i + 1]!
    let tx = next.x - prev.x
    let tz = next.z - prev.z
    const len = Math.hypot(tx, tz) || 1
    tx /= len
    tz /= len
    const t = lens[i]! / total
    const ends = Math.sin(Math.PI * t)
    const n = fbm(lens[i]! * 0.16 + seed, seed * 2.1)
    const amp = 1.35 * ends
    out.push({ x: p.x - tz * n * amp, z: p.z + tx * n * amp })
  }
  return out
}

type Disc = { x: number; z: number; r: number }

function pushOffDiscs(pts: VeinWaypoint[], discs: Disc[], extra: number): void {
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i]!
      for (const d of discs) {
        const dx = p.x - d.x
        const dz = p.z - d.z
        const dist = Math.hypot(dx, dz)
        const min = d.r + extra
        if (dist >= min) continue
        const s = (min - dist) / (dist > 1e-4 ? dist : 1)
        p.x += (dist > 1e-4 ? dx : 1) * s
        p.z += (dist > 1e-4 ? dz : 0) * s
      }
    }
  }
}

export function distPointToSeg(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): number {
  const abx = bx - ax
  const abz = bz - az
  const apx = px - ax
  const apz = pz - az
  const ab2 = abx * abx + abz * abz
  const t = ab2 > 1e-8 ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / ab2)) : 0
  return Math.hypot(ax + abx * t - px, az + abz * t - pz)
}

/** True when any segment of the polyline enters the disc. */
export function polylineHitsDisc(
  points: VeinWaypoint[],
  x: number,
  z: number,
  radius: number
): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    if (distPointToSeg(x, z, a.x, a.z, b.x, b.z) < radius) return true
  }
  return false
}

function radialFallback(start: VeinWaypoint, goal: VeinWaypoint): VeinWaypoint[] {
  const dx = goal.x - start.x
  const dz = goal.z - start.z
  const d = Math.hypot(dx, dz)
  const n = Math.max(2, Math.ceil(d / 1.15) + 1)
  const pts: VeinWaypoint[] = []
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    pts.push({ x: start.x + dx * t, z: start.z + dz * t })
  }
  return pts
}

/**
 * One path per pool: landing rim → shore, walking around tree discs and other pools.
 */
export function buildVeinPaths(pools: VeinPoolInput[], trees: ForestTreePose[]): VeinPath[] {
  const g = makeGrid()
  const treeDiscs: Disc[] = trees.map((t) => ({
    x: t.x,
    z: t.z,
    r: t.width * 0.5 + TREE_CLEAR_M
  }))
  for (const d of treeDiscs) stampCircle(g, d.x, d.z, d.r)
  for (const p of pools) stampCircle(g, p.x, p.z, p.radius + POOL_CLEAR_M)

  const paths: VeinPath[] = []
  for (const pool of pools) {
    const destR = Math.max(FOREST_LANDING_RADIUS_M + 1.4, Math.hypot(pool.x, pool.z))
    const startW = rimPoint(pool.x, pool.z, FOREST_LANDING_RADIUS_M + 0.15)
    const shoreR = Math.max(FOREST_LANDING_RADIUS_M + 1.1, destR - pool.radius - 0.32)
    const goalW = rimPoint(pool.x, pool.z, shoreR)

    clearCircle(g, goalW.x, goalW.z, g.cell * 1.1)
    const startHint = worldToCell(g, startW.x, startW.z)
    const goalHint = worldToCell(g, goalW.x, goalW.z)
    const startCell = nearestOpen(g, startHint.ix, startHint.iz)
    const goalCell = nearestOpen(g, goalHint.ix, goalHint.iz)

    let points: VeinWaypoint[] | null = null
    if (startCell && goalCell) {
      const found = astar(g, startCell, goalCell)
      if (found && found.length >= 2) {
        points = resamplePath(smoothPath(g, [startW, ...found, goalW]), 1.15)
        const avoid: Disc[] = [
          ...treeDiscs,
          ...pools
            .filter((p) => p !== pool)
            .map((p) => ({ x: p.x, z: p.z, r: p.radius + POOL_CLEAR_M }))
        ]
        pushOffDiscs(points, avoid, RIBBON_HALF_M)
      }
    }
    if (!points || points.length < 2) points = radialFallback(startW, goalW)

    stampCircle(g, pool.x, pool.z, pool.radius + POOL_CLEAR_M)
    paths.push({ live: pool.live, destX: pool.x, destZ: pool.z, points, kind: 'pool' })
  }

  for (const tree of trees) {
    const destR = Math.hypot(tree.x, tree.z)
    if (destR < FOREST_LANDING_RADIUS_M + 2.2) continue
    const trunk = Math.max(0.45, tree.width * 0.35)
    const startW = rimPoint(tree.x, tree.z, FOREST_LANDING_RADIUS_M + 0.15)
    const goalW = rimPoint(tree.x, tree.z, Math.max(FOREST_LANDING_RADIUS_M + 1.2, destR - trunk))

    clearCircle(g, goalW.x, goalW.z, g.cell * 1.2)
    const startHint = worldToCell(g, startW.x, startW.z)
    const goalHint = worldToCell(g, goalW.x, goalW.z)
    const startCell = nearestOpen(g, startHint.ix, startHint.iz)
    const goalCell = nearestOpen(g, goalHint.ix, goalHint.iz)

    let points: VeinWaypoint[] | null = null
    if (startCell && goalCell) {
      const found = astar(g, startCell, goalCell)
      if (found && found.length >= 2) {
        points = resamplePath(smoothPath(g, [startW, ...found, goalW]), 1.25)
        pushOffDiscs(
          points,
          treeDiscs.filter((d) => Math.hypot(d.x - tree.x, d.z - tree.z) > 0.4),
          RIBBON_HALF_M * 0.7
        )
      }
    }
    stampCircle(g, tree.x, tree.z, tree.width * 0.5 + TREE_CLEAR_M)
    if (!points || points.length < 2) points = radialFallback(startW, goalW)
    paths.push({
      live: false,
      destX: tree.x,
      destZ: tree.z,
      points: wiggleTreePath(points, tree.x, tree.z),
      kind: 'tree'
    })
  }
  return paths
}
