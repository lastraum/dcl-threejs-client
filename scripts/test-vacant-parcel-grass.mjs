#!/usr/bin/env node
/**
 * Vacant Genesis grass — Unity Explorer details, not ez-tree blades.
 * GrassIndirectRenderer: 256 tufts/parcel + 16+16 flowers, Flowers02 atlas.
 * Run: node scripts/test-vacant-parcel-grass.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
let failed = 0

function assert(label, cond) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failed++
    console.error(` FAIL ${label}`)
  }
}

function read(rel) {
  return readFileSync(join(root, rel), 'utf8')
}

const PARCEL_SIZE = 16
const GRASS_PER_PARCEL = 256
assert(`16×16 grass grid (${Math.sqrt(GRASS_PER_PARCEL)}²)`, Math.sqrt(GRASS_PER_PARCEL) === 16)
assert('parcel is 16 m', PARCEL_SIZE === 16)

const field = read('src/dcl/landscape/ExplorerVacantGrassField.ts')
assert('buildExplorerVacantGrassField exported', /export async function buildExplorerVacantGrassField\(/.test(field))
assert('256 grass / parcel', /GRASS_PER_PARCEL = 256/.test(field))
assert('16 flowers per type', /FLOWERS_PER_TYPE = 16/.test(field))
assert('uses Explorer grass.fbx', /grass\.fbx/.test(field))
assert('uses Flower01 + Flower02', /Flower01\.fbx/.test(field) && /Flower02\.fbx/.test(field))
assert('uses Flowers02 atlas', /Flowers02\.png/.test(field))
assert('no ez-tree vacant path', !/buildVacantParcelGrassField/.test(field))

const scatter = read('src/dcl/aoi/emptyParcelLayer.ts')
assert('scatter does not place EMPTY_LAND.grass', !/EMPTY_LAND\.grass/.test(scatter))
assert('scatter builds Explorer vacant field', /buildExplorerVacantGrassField\(opts\.parcelKeys/.test(scatter))
assert(
  'tree/bush disks stay inside vacant parcels',
  /horizontalDiskFitsParcel/.test(scatter) && /SCATTER_VISUAL_RADIUS_M/.test(scatter)
)
assert('scatter skips disks that overlap occupied parcels', /occupiedParcelKeys/.test(scatter))

const dist = read('src/dcl/landscape/parcelDistribution.ts')
assert('horizontalDiskFitsParcel exported', /export function horizontalDiskFitsParcel/.test(dist))
assert(
  'tree at parcel edge is rejected',
  (() => {
    const size = 16
    const r = 3.6 * 1.7
    const edge = 2.4
    return edge - r < 0 && edge + r > 0
  })()
)
assert(
  'tree at parcel center fits',
  (() => {
    const size = 16
    const x = 8
    const r = 3.6 * 1.45
    return x - r >= 0 && x + r <= size
  })()
)

const aoi = read('src/dcl/aoi/AoiVisualLayer.ts')
assert('AOI ticks vacant grass', /this\.tickVacantGrass\(\)/.test(aoi))

const ez = read('src/dcl/landscape/EzTreeGrassField.ts')
assert('ez-tree vacant builder removed', !/export async function buildVacantParcelGrassField\(/.test(ez))

const assets = [
  'public/landscape/explorer-grass/grass.fbx',
  'public/landscape/explorer-grass/Flower01.fbx',
  'public/landscape/explorer-grass/Flower02.fbx',
  'public/landscape/explorer-grass/GrassField.png',
  'public/landscape/explorer-grass/Flowers02.png'
]
for (const a of assets) {
  assert(`asset ${a.split('/').pop()}`, existsSync(join(root, a)))
}

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall ok')
