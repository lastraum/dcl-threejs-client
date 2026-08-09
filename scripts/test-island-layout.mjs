/**
 * Island geometry: parcel AABB centre + radius to corner.
 * Run: node scripts/test-island-layout.mjs
 */
import assert from 'node:assert/strict'

const PARCEL_SIZE = 16
const ISLAND_FLAT_MARGIN_M = 0.75
const ISLAND_SHORE_RING_M = 6

function sceneParcelBounds(parcels) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const key of parcels) {
    const [x, y] = key.split(',').map(Number)
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  return { minX, maxX, minY, maxY }
}

function islandParcelBoundsM(parcels, base) {
  const b = sceneParcelBounds(parcels)
  return {
    minX: (b.minX - base.x) * PARCEL_SIZE,
    maxX: (b.maxX - base.x + 1) * PARCEL_SIZE,
    minZ: (b.minY - base.y) * PARCEL_SIZE,
    maxZ: (b.maxY - base.y + 1) * PARCEL_SIZE
  }
}

function islandCenterDcl(parcels, base) {
  const box = islandParcelBoundsM(parcels, base)
  return { x: (box.minX + box.maxX) * 0.5, z: (box.minZ + box.maxZ) * 0.5 }
}

function islandFlatRadiusM(parcels, base) {
  const box = islandParcelBoundsM(parcels, base)
  const halfW = (box.maxX - box.minX) * 0.5
  const halfD = (box.maxZ - box.minZ) * 0.5
  return Math.hypot(halfW, halfD) + ISLAND_FLAT_MARGIN_M
}

// 1×1 parcel at 0,0 — centre mid-parcel, R = half-diagonal of 16×16
{
  const parcels = ['0,0']
  const base = { x: 0, y: 0 }
  const c = islandCenterDcl(parcels, base)
  assert.equal(c.x, 8)
  assert.equal(c.z, 8)
  const r = islandFlatRadiusM(parcels, base)
  const expected = Math.hypot(8, 8) + ISLAND_FLAT_MARGIN_M
  assert.ok(Math.abs(r - expected) < 1e-9, `1x1 R=${r} want ${expected}`)
  assert.ok(r < 13, '1x1 island should be tight (~12m), not a huge halo')
}

// 2×2 parcels — 32×32 box, half-diagonal = 16√2
{
  const parcels = ['0,0', '1,0', '0,1', '1,1']
  const base = { x: 0, y: 0 }
  const c = islandCenterDcl(parcels, base)
  assert.equal(c.x, 16)
  assert.equal(c.z, 16)
  const r = islandFlatRadiusM(parcels, base)
  const expected = Math.hypot(16, 16) + ISLAND_FLAT_MARGIN_M
  assert.ok(Math.abs(r - expected) < 1e-9)
  const outer = r + ISLAND_SHORE_RING_M
  assert.ok(outer - r === ISLAND_SHORE_RING_M)
}

// 3×1 strip — centre mid-strip, R covers ends
{
  const parcels = ['0,0', '1,0', '2,0']
  const base = { x: 0, y: 0 }
  const c = islandCenterDcl(parcels, base)
  assert.equal(c.x, 24) // 0..48 / 2
  assert.equal(c.z, 8)
  const r = islandFlatRadiusM(parcels, base)
  const expected = Math.hypot(24, 8) + ISLAND_FLAT_MARGIN_M
  assert.ok(Math.abs(r - expected) < 1e-9)
}

console.log('test-island-layout: ok')
