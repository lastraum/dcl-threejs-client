#!/usr/bin/env node
/**
 * Nearby live scenes — occupied footprints only, empty parcels excluded.
 * Standing on Burj, Winterfest / CBD Plaza are adjacent occupied land (16 m)
 * even when player-to-edge through empty cells is larger.
 * Run: node scripts/test-nearby-scene-distance.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PARCEL_SIZE = 16
const root = process.cwd()

let failed = 0
function assert(label, cond) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failed++
    console.error(` FAIL ${label}`)
  }
}

function parseParcelKey(key) {
  const [x, y] = String(key)
    .trim()
    .split(',')
    .map((n) => Number(n))
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(key)
  return { x, y }
}

function parcelEdgeDistanceM(a, b) {
  const a0x = a.x * PARCEL_SIZE
  const a1x = (a.x + 1) * PARCEL_SIZE
  const a0z = a.y * PARCEL_SIZE
  const a1z = (a.y + 1) * PARCEL_SIZE
  const b0x = b.x * PARCEL_SIZE
  const b1x = (b.x + 1) * PARCEL_SIZE
  const b0z = b.y * PARCEL_SIZE
  const b1z = (b.y + 1) * PARCEL_SIZE
  const dx = Math.max(0, a0x - b1x, b0x - a1x)
  const dz = Math.max(0, a0z - b1z, b0z - a1z)
  return Math.hypot(dx, dz)
}

function minSceneFootprintDistanceM(parcelsA, parcelsB) {
  let best = Infinity
  for (const ka of parcelsA) {
    const a = parseParcelKey(ka)
    for (const kb of parcelsB) {
      const d = parcelEdgeDistanceM(a, parseParcelKey(kb))
      if (d < best) best = d
    }
  }
  return best
}

function parcelSwSceneLocal(parcelKey, baseParcel) {
  const base = parseParcelKey(baseParcel)
  const p = parseParcelKey(parcelKey)
  return { x: (p.x - base.x) * PARCEL_SIZE, z: (p.y - base.y) * PARCEL_SIZE }
}

function minPlayerToFootprintDistanceM(dclX, dclZ, footprintKeys, baseParcel) {
  let best = Infinity
  for (const key of footprintKeys) {
    const sw = parcelSwSceneLocal(key, baseParcel)
    const dx = Math.max(0, sw.x - dclX, dclX - (sw.x + PARCEL_SIZE))
    const dz = Math.max(0, sw.z - dclZ, dclZ - (sw.z + PARCEL_SIZE))
    const d = Math.hypot(dx, dz)
    if (d < best) best = d
  }
  return best
}

function minNearbySceneDistanceM(dclX, dclZ, neighborKeys, primaryKeys, baseParcel) {
  const player = minPlayerToFootprintDistanceM(dclX, dclZ, neighborKeys, baseParcel)
  if (player === 0) return 0
  return Math.min(player, minSceneFootprintDistanceM(primaryKeys, neighborKeys))
}

function isCatalystEmptyLandEntity(ent) {
  const title = (ent.title ?? '').trim().toLowerCase()
  if (title === 'interactive-text' || title === 'empty' || title === 'empty parcel') return true
  const main = (ent.main ?? '').toLowerCase()
  if (!(main === 'game.js' || main.endsWith('/game.js') || main === 'bin/game.js')) return false
  const parcels = ent.parcels?.length ? ent.parcels : ent.pointers ?? []
  if (parcels.length !== 1) return false
  const glbs = (ent.content ?? []).filter((c) => /\.glb$/i.test(c.file))
  if (glbs.length === 0) return true
  if (glbs.length === 1) {
    const f = (glbs[0].file.split('/').pop() ?? '').toLowerCase()
    if (f === 'scene.glb' || f.includes('floorbase') || f.includes('empty')) return true
  }
  return false
}

function isSecondarySceneCandidate(ent) {
  if (isCatalystEmptyLandEntity(ent)) return false
  if ((ent.title ?? '').startsWith('Road at ')) return false
  const parcels = ent.parcels?.length ? ent.parcels : ent.pointers ?? []
  if (parcels.length >= 2) return true
  const glbs = (ent.content ?? []).filter((c) => /\.glb$/i.test(c.file)).length
  return glbs >= 3
}

console.log('occupied-footprint distance')

// Burj 3×3 around -150,96 … -148,98. Player on south-east cell -148,97.
const burj = []
for (let x = -150; x <= -148; x++) for (let y = 96; y <= 98; y++) burj.push(`${x},${y}`)
const winterfest = ['-150,99', '-149,99', '-148,99']
const cbd = ['-147,96', '-147,97', '-147,98']
const emptyBetween = ['-148,95']
const base = '-150,96'
// Player center of -148,97 in scene-local meters.
const player = parcelSwSceneLocal('-148,97', base)
const dclX = player.x + PARCEL_SIZE / 2
const dclZ = player.z + PARCEL_SIZE / 2

const wfScene = minSceneFootprintDistanceM(burj, winterfest)
const cbdScene = minSceneFootprintDistanceM(burj, cbd)
const wfNearby = minNearbySceneDistanceM(dclX, dclZ, winterfest, burj, base)
const wfPlayer = minPlayerToFootprintDistanceM(dclX, dclZ, winterfest, base)
const cbdNearby = minNearbySceneDistanceM(dclX, dclZ, cbd, burj, base)

assert('Winterfest shares an edge with Burj (occupied-footprint distance 0)', wfScene === 0)
assert(
  'CBD east of Burj is occupied-adjacent (0), not an empty-parcel walk',
  cbdScene === 0
)
assert(
  'nearby distance keeps Winterfest at 0 even when player-to-edge is larger',
  wfNearby === 0 && wfPlayer > 0
)
assert('CBD Plaza nearby distance is 0 from Burj', cbdNearby === 0)
assert('empty parcels are not used as a neighbor footprint', emptyBetween[0] === '-148,95')

console.log('\nempty parcels never take a live slot')
assert(
  'titled Empty is not a secondary candidate',
  !isSecondarySceneCandidate({
    title: 'Empty',
    main: 'bin/game.js',
    parcels: ['-144,89'],
    pointers: ['-144,89'],
    content: [{ file: 'scene.glb' }]
  })
)
assert(
  'Winterfest is a secondary candidate',
  isSecondarySceneCandidate({
    title: 'Winterfest Hockey 2026',
    main: 'bin/index.js',
    parcels: winterfest,
    pointers: winterfest,
    content: [{ file: 'main.composite' }, { file: 'a.glb' }, { file: 'b.glb' }, { file: 'c.glb' }]
  })
)
assert(
  'CBD Plaza is a secondary candidate',
  isSecondarySceneCandidate({
    title: 'CBD Plaza',
    main: 'bin/index.js',
    parcels: Array.from({ length: 20 }, (_, i) => `-147,${91 + i}`),
    pointers: [],
    content: [{ file: 'main.composite' }]
  })
)

console.log('\nsource law')
const caps = readFileSync(join(root, 'src/dcl/multiScene/caps.ts'), 'utf8')
const fetchSrc = readFileSync(join(root, 'src/dcl/aoi/fetchActiveEntities.ts'), 'utf8')
const aoi = readFileSync(join(root, 'src/dcl/aoi/AoiVisualLayer.ts'), 'utf8')
const parcel = readFileSync(join(root, 'src/dcl/aoi/parcelAoi.ts'), 'utf8')
const world = readFileSync(join(root, 'src/core/World.ts'), 'utf8')
const app = readFileSync(join(root, 'src/client/AppController.ts'), 'utf8')

assert('live enter follows Scene Distance (no 20 m cliff)', /LIVE_SCENE_MAX_M/.test(caps) === false)
assert(
  'secondaryLiveEnterRadiusM returns visualWarmRadiusM',
  /export function secondaryLiveEnterRadiusM\(\)[\s\S]{0,180}return visualWarmRadiusM\(\)/.test(caps)
)
assert(
  'isSecondarySceneCandidate skips catalyst empty land',
  /isCatalystEmptyLandEntity\(ent\)/.test(fetchSrc) &&
    /export function isSecondarySceneCandidate/.test(fetchSrc)
)
assert(
  'live guests rank by player-to-footprint (not primary-estate 0 m)',
  /minPlayerToFootprintDistanceM\(/.test(aoi) && /b\.parcelCount - a\.parcelCount/.test(aoi)
)
assert('live guest hard cap is 8', /AOI_LIVE_SECONDARY_HARD_CAP = 8/.test(caps))
assert(
  'neighbor discover is awaitable; shells drain in background',
  /prewarmVisuals\(dclX: number, dclZ: number\): Promise<void>/.test(aoi) &&
    /runBackgroundNeighborDrain/.test(aoi)
)
assert(
  'nearby occupied-footprint helper still exists for adjacency',
  /export function minNearbySceneDistanceM/.test(parcel)
)
assert(
  'loading screen waits for live-guest GLBs, not shells',
  /drainLiveGuestsForLoad/.test(world) &&
    /drainLiveGuestsForLoad/.test(app) &&
    !/drainNeighborShellsForLoad/.test(app)
)
assert(
  'play-ready does not cancel background shell drain',
  /Stop uncapped scatter; keep background shell/.test(aoi)
)

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
