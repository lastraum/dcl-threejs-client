#!/usr/bin/env node
/**
 * Explore coord search — Places `positions=` covering-scene lookup, not `search=`.
 * Run: node scripts/test-place-coord-search.mjs
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

function parsePlaceCoordQuery(raw) {
  const q = String(raw ?? '').trim()
  const m = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(q)
  if (!m) return null
  const x = Number(m[1])
  const y = Number(m[2])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function matchesPlaceSearch(place, queryLower, compactQuery) {
  if (!queryLower) return true
  const title = place.title.toLowerCase()
  const owner = (place.owner ?? '').toLowerCase()
  const coords = `${place.baseX},${place.baseY}`.replace(/\s/g, '')
  if (title.includes(queryLower) || owner.includes(queryLower) || coords.includes(compactQuery)) {
    return true
  }
  const compact = compactQuery.replace(/\s/g, '')
  return (place.positions ?? []).some((p) => p.replace(/\s/g, '').toLowerCase() === compact)
}

console.log('parsePlaceCoordQuery')
assert('125,104', parsePlaceCoordQuery('125,104')?.x === 125 && parsePlaceCoordQuery('125,104')?.y === 104)
assert('spaces 125, 104', parsePlaceCoordQuery('125, 104')?.y === 104)
assert('negative', parsePlaceCoordQuery('-9,10')?.x === -9)
assert('title is not coords', parsePlaceCoordQuery('Itchy Chill') === null)
assert('embedded coords stay text', parsePlaceCoordQuery('road 125,104') === null)

console.log('\nmatchesPlaceSearch covering parcel')
const itchy = {
  title: 'The OG Itchy Chill',
  owner: '',
  baseX: 125,
  baseY: 103,
  positions: ['125,103', '125,104']
}
assert(
  '125,104 matches non-base parcel',
  matchesPlaceSearch(itchy, '125,104', '125,104')
)
assert(
  '125,103 matches base',
  matchesPlaceSearch(itchy, '125,103', '125,103')
)
assert('unrelated coords miss', matchesPlaceSearch(itchy, '1,1', '1,1') === false)

console.log('\nsource law')
const places = readFileSync(join(root, 'src/social/dclPlaces.ts'), 'utf8')
const view = readFileSync(join(root, 'src/client/ui/settings/PlacesView.ts'), 'utf8')
assert('parsePlaceCoordQuery is exported', /export function parsePlaceCoordQuery/.test(places))
assert('fetchDclGenesisPlaces sends positions=', /qs\.append\('positions'/.test(places))
assert('PlacesView uses parsePlaceCoordQuery', /parsePlaceCoordQuery\(q\)/.test(view))
assert(
  'coord search does not use Places search=',
  /search: coord \? undefined/.test(view)
)
assert(
  'jump lands on typed coords',
  /genesisPlaceJumpRoute\(item\.place, landing/.test(view)
)

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
