#!/usr/bin/env node
/**
 * Vacant Genesis grass — occupancy field (not EMPTY_LAND glTF tufts).
 * Unity plants 256 blades / parcel on a 16×16 grid; WebGL samples 8×8 of that.
 * Run: node scripts/test-vacant-parcel-grass.mjs
 */
import { readFileSync } from 'node:fs'
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
const VACANT_GRASS_STEP = 2
const cells = Math.ceil(PARCEL_SIZE / VACANT_GRASS_STEP)
assert(`8×8 sample of Explorer 16×16 (${cells}×${cells}=${cells * cells})`, cells === 8 && cells * cells === 64)

const field = read('src/dcl/landscape/EzTreeGrassField.ts')
assert('VACANT_GRASS_STEP = 2', /export const VACANT_GRASS_STEP = 2/.test(field))
assert('buildVacantParcelGrassField exported', /export async function buildVacantParcelGrassField\(/.test(field))
assert(
  'vacant collect skips ez-tree patchiness',
  /function collectVacantParcelGrassInstances\(/.test(field) &&
    !/collectVacantParcelGrassInstances[\s\S]*grassPassesPatchiness/.test(
      field.slice(field.indexOf('function collectVacantParcelGrassInstances('))
    )
)
assert('vacant blades use EMPTY_LAND_GROUND_OFFSET.y', /y: EMPTY_LAND_GROUND_OFFSET\.y/.test(field))
assert('vacant mesh name aoi-vacant-grass', /grassMesh\.name = 'aoi-vacant-grass'/.test(field))

const scatter = read('src/dcl/aoi/emptyParcelLayer.ts')
assert('scatter does not place EMPTY_LAND.grass', !/EMPTY_LAND\.grass/.test(scatter))
assert('scatter builds vacant GPU field', /buildVacantParcelGrassField\(opts\.parcelKeys/.test(scatter))
assert('scatter returns grass handle', /grass: EzTreeGrassFieldHandle \| null/.test(scatter))

const aoi = read('src/dcl/aoi/AoiVisualLayer.ts')
assert('sticky layer stores grass handle', /grass: EzTreeGrassFieldHandle \| null/.test(aoi))
assert('AOI ticks vacant grass', /this\.tickVacantGrass\(\)/.test(aoi))
assert('purge/clear dispose grass', /disposeStickyScatterLayer\(layer\)/.test(aoi))
assert(
  'camera converted to cityFillRoot local',
  /cityFillRoot\.worldToLocal\(this\.scratchWorld\)/.test(aoi)
)

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall ok')
