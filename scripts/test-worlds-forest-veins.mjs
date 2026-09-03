#!/usr/bin/env node
/**
 * Veins must walk around tree discs, not cut through them.
 * Mirrors src/map/worldsForestVeinPaths.ts — run: node scripts/test-worlds-forest-veins.mjs
 */
const LANDING = 10
const RADIUS = 118
const CELL = 1.35
const TREE_CLEAR = 1.15
const POOL_CLEAR = 0.28
const MAX_EXPAND = 12_000
const N8 = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, 1.414],
  [1, -1, 1.414],
  [-1, 1, 1.414],
  [-1, -1, 1.414]
]

function makeGrid() {
  const origin = -RADIUS
  const w = Math.ceil((RADIUS * 2) / CELL) + 2
  return { cell: CELL, origin, w, blocked: new Uint8Array(w * w) }
}
function idx(g, ix, iz) {
  return iz * g.w + ix
}
function inGrid(g, ix, iz) {
  return ix >= 0 && iz >= 0 && ix < g.w && iz < g.w
}
function worldToCell(g, x, z) {
  return {
    ix: Math.max(0, Math.min(g.w - 1, Math.floor((x - g.origin) / g.cell))),
    iz: Math.max(0, Math.min(g.w - 1, Math.floor((z - g.origin) / g.cell)))
  }
}
function cellToWorld(g, ix, iz) {
  return { x: g.origin + (ix + 0.5) * g.cell, z: g.origin + (iz + 0.5) * g.cell }
}
function stampCircle(g, x, z, radius) {
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
function clearCircle(g, x, z, radius) {
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
function nearestOpen(g, ix, iz) {
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
function heapSiftUp(heap, fOf, i) {
  while (i > 0) {
    const p = (i - 1) >> 1
    if (fOf[heap[p]] <= fOf[heap[i]]) break
    const tmp = heap[p]
    heap[p] = heap[i]
    heap[i] = tmp
    i = p
  }
}
function heapSiftDown(heap, fOf, i) {
  const n = heap.length
  while (true) {
    let best = i
    const l = i * 2 + 1
    const r = l + 1
    if (l < n && fOf[heap[l]] < fOf[heap[best]]) best = l
    if (r < n && fOf[heap[r]] < fOf[heap[best]]) best = r
    if (best === i) break
    const tmp = heap[i]
    heap[i] = heap[best]
    heap[best] = tmp
    i = best
  }
}
function astar(g, start, goal) {
  const n = g.w * g.w
  const gScore = new Float32Array(n)
  gScore.fill(1e9)
  const parent = new Int32Array(n)
  parent.fill(-1)
  const closed = new Uint8Array(n)
  const fOf = new Float32Array(n)
  fOf.fill(1e9)
  const heap = []
  const s = idx(g, start.ix, start.iz)
  const t = idx(g, goal.ix, goal.iz)
  gScore[s] = 0
  fOf[s] = Math.hypot(goal.ix - start.ix, goal.iz - start.iz)
  heap.push(s)
  let expands = 0
  while (heap.length && expands < MAX_EXPAND) {
    expands++
    const cur = heap[0]
    const last = heap.pop()
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
      const ng = gScore[cur] + cost
      if (ng >= gScore[ni]) continue
      parent[ni] = cur
      gScore[ni] = ng
      fOf[ni] = ng + Math.hypot(goal.ix - nx, goal.iz - nz)
      heap.push(ni)
      heapSiftUp(heap, fOf, heap.length - 1)
    }
  }
  if (parent[t] < 0 && s !== t) return null
  const cells = []
  let c = t
  let guard = 0
  while (c >= 0 && guard++ < n) {
    cells.push(c)
    if (c === s) break
    c = parent[c]
  }
  cells.reverse()
  if (cells[0] !== s) return null
  return cells.map((id) => cellToWorld(g, id % g.w, (id / g.w) | 0))
}
function distPointToSeg(px, pz, ax, az, bx, bz) {
  const abx = bx - ax
  const abz = bz - az
  const apx = px - ax
  const apz = pz - az
  const ab2 = abx * abx + abz * abz
  const t = ab2 > 1e-8 ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / ab2)) : 0
  return Math.hypot(ax + abx * t - px, az + abz * t - pz)
}
function polylineHitsDisc(points, x, z, radius) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (distPointToSeg(x, z, a.x, a.z, b.x, b.z) < radius) return true
  }
  return false
}
function rimPoint(x, z, radius) {
  const d = Math.hypot(x, z) || 1
  return { x: (x / d) * radius, z: (z / d) * radius }
}

function pathToPool(pool, trees) {
  const g = makeGrid()
  for (const t of trees) stampCircle(g, t.x, t.z, t.width * 0.5 + TREE_CLEAR)
  stampCircle(g, pool.x, pool.z, pool.radius + POOL_CLEAR)
  const destR = Math.hypot(pool.x, pool.z)
  const startW = rimPoint(pool.x, pool.z, LANDING + 0.15)
  const shoreR = Math.max(LANDING + 1.1, destR - pool.radius - 0.32)
  const goalW = rimPoint(pool.x, pool.z, shoreR)
  clearCircle(g, goalW.x, goalW.z, g.cell * 1.1)
  const startHint = worldToCell(g, startW.x, startW.z)
  const goalHint = worldToCell(g, goalW.x, goalW.z)
  const startCell = nearestOpen(g, startHint.ix, startHint.iz)
  const goalCell = nearestOpen(g, goalHint.ix, goalHint.iz)
  if (!startCell || !goalCell) return null
  const found = astar(g, startCell, goalCell)
  if (!found || found.length < 2) return null
  return [startW, ...found, goalW]
}

let failed = 0
function assert(label, cond) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failed++
    console.error(` FAIL ${label}`)
  }
}

const pool = { x: 70, z: 0, radius: 3 }
const tree = { x: 30, z: 0, width: 1.4 }
const treeR = tree.width * 0.5 + TREE_CLEAR
const straight = [rimPoint(70, 0, LANDING + 0.15), rimPoint(70, 0, 70 - 3 - 0.32)]
assert('straight radial would hit the tree', polylineHitsDisc(straight, tree.x, tree.z, treeR))

const around = pathToPool(pool, [tree])
assert('A* found a path around the tree', !!(around && around.length >= 2))
if (around) {
  assert('detour does not enter the tree disc', !polylineHitsDisc(around, tree.x, tree.z, treeR))
  const maxAbsZ = around.reduce((m, p) => Math.max(m, Math.abs(p.z)), 0)
  assert('detour leaves the radial line', maxAbsZ > treeR * 0.85)
}

const open = pathToPool(pool, [])
assert('open path exists', !!(open && open.length >= 2))
if (open) {
  const maxAbsZ = open.reduce((m, p) => Math.max(m, Math.abs(p.z)), 0)
  assert('open path stays near the radial', maxAbsZ < 3)
}

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('worlds forest veins ok')
