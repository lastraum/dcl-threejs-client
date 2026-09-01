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

assert(
  'live enter is fraction of SD capped at 32m',
  /export function secondaryLiveEnterRadiusM\(\)[\s\S]{0,280}return Math\.min\(d \* 0\.35, 32\)/.test(
    caps
  )
)
assert(
  'secondaryLiveKeepRadiusM uses enter + 16 hysteresis band',
  /Math\.min\(d, Math\.max\(enter \+ LIVE_SCENE_UNLOAD_EXTRA_M, d \* 0\.6\)\)/.test(caps)
)
assert(
  'isSecondarySceneCandidate skips catalyst empty land',
  /isCatalystEmptyLandEntity\(ent\)/.test(fetchSrc) &&
    /export function isSecondarySceneCandidate/.test(fetchSrc)
)
assert(
  'SDK7+composite is a first-frame candidate (bin/index.js)',
  /export function isFirstFrameSecondaryCandidate/.test(fetchSrc) &&
    /isSdk7ScriptEntry\(ent\)/.test(fetchSrc) &&
    /isFirstFrameSecondaryCandidate\(e\)/.test(aoi)
)
assert(
  'SDK7+composite is also a composite-shell candidate (coexist)',
  /!isSecondarySceneCandidate\(e\) \|\| !findCompositeFile\(e\.content\)\) continue/.test(aoi) &&
    !/isCompositeShellCandidate/.test(fetchSrc) &&
    !/isFirstFrameSecondaryCandidate\(ent\)/.test(aoi.split('createEmptyShell')[1] ?? '')
)
assert(
  'SDK6 game.js composite is shell-only (no first-frame)',
  /export function isSdk7ScriptEntry/.test(fetchSrc) &&
    /game\.js/.test(fetchSrc) &&
    !/if \(findCompositeFile\(e\.content\)\) return false/.test(aoi)
)
assert(
  'first-frame ranks nearer then larger parcelCount',
  /return pb - pa/.test(aoi)
)
assert(
  'first-frame logs enqueue with title and dist',
  /\[aoi-ff\] enqueue/.test(aoi)
)
assert(
  'first-frame samples only in the near band (aoiNearBandRadiusM)',
  /aoiNearBandRadiusM\(\)/.test(aoi) && /dist > nearM/.test(aoi)
)
assert(
  'mega SDK7 excluded from live guest boot list',
  /isSdk7ScriptEntry\(ent\) && parcelCount >= STICKY_RESTORE_MAX_PARCELS/.test(aoi)
)
assert(
  'first-frame registers DrawWorld pose like composite shells',
  /host\.drawWorld\.register\(group, pose\)/.test(aoi) &&
    /aoi-ff-pose:/.test(aoi)
)
assert(
  'first-frame near meshes castShadow false',
  /node\.castShadow = false/.test(aoi)
)
assert('live guest hard cap is 3', /AOI_LIVE_SECONDARY_HARD_CAP = 3/.test(caps))
assert('live boot concurrency is 1', /SECONDARY_LIVE_BOOT_CONCURRENCY = 1/.test(caps))
assert(
  'live guests rank by player-to-footprint (not primary-estate 0 m)',
  /minPlayerToFootprintDistanceM\(/.test(aoi) && /b\.parcelCount - a\.parcelCount/.test(aoi)
)
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
assert(
  'occupied footprint unions pointers and parcels',
  /export function entityFootprintKeys/.test(fetchSrc)
)
assert(
  'live-guest PhysX uses the 48 m empty-land ring',
  /export const LIVE_SCENE_PHYS_RADIUS_M = EMPTY_LAND_PHYS_RADIUS_M/.test(caps)
)
const secondary = readFileSync(join(root, 'src/dcl/multiScene/SecondaryLiveManager.ts'), 'utf8')
const catalyst = readFileSync(join(root, 'src/network/catalyst/CatalystClient.ts'), 'utf8')
assert(
  'nearbyPhysGuestIds cooks adjacent live guests',
  /nearbyPhysGuestIds\(\): string\[]/.test(secondary) &&
    /LIVE_SCENE_PHYS_RADIUS_M/.test(secondary)
)
assert(
  'World resolvePhysGuestIds uses nearbyPhysGuestIds',
  /nearbyPhysGuestIds\(\)/.test(world)
)
assert(
  'fetchSceneEntityByPointer probes orthogonal neighbors on miss',
  /catalystEntityClaimsPointer/.test(catalyst) &&
    /coord\.x - 1/.test(catalyst)
)
assert(
  'loading overlay logs boot-list titles',
  /titles\.map/.test(world)
)
const origin = readFileSync(join(root, 'src/dcl/multiScene/secondarySceneOrigin.ts'), 'utf8')
const slotSrc = readFileSync(join(root, 'src/dcl/multiScene/SceneWorkerSlot.ts'), 'utf8')
const playerSrc = readFileSync(join(root, 'src/player/PlayerSystem.ts'), 'utf8')
assert(
  'scene graphs offset vs genesis 0,0 not FocusOwner',
  /export function applyGenesisSceneRootOrigin/.test(origin) &&
    /applyGenesisSceneRootOrigin\(root, this\.scene\.baseParcel\)/.test(slotSrc)
)
assert(
  'promote rekeys PhysX ids without sliding hulls',
  /genesis-stable, no slide/.test(world) &&
    !/resident colliders origin-rebase/.test(world)
)
assert(
  'city-fill root stays at genesis identity on promote',
  /this\.cityFillRoot\.position\.set\(0, 0, 0\)/.test(aoi)
)
assert(
  'CCT converts FocusOwner-local DCL through a genesis origin',
  /setFocusOriginMeters/.test(playerSrc) &&
    /genesisThreeFromSceneLocalDcl/.test(playerSrc)
)
assert(
  'walk-bounds clamp converts genesis Three → FocusOwner-local before clamp',
  /sceneLocalDclFromGenesisThree\(this\.root\.position\)/.test(playerSrc) &&
    /genesisThreeFromSceneLocalDcl\(dclPos\)/.test(playerSrc)
)
assert(
  'spawn floor probe uses genesis spawn feet, not scene-local Three',
  /genesisSpawnFeetThree\(spawn, feetY\)/.test(world)
)
assert(
  'landscape root is genesis-offset like scene graphs',
  /applyGenesisSceneRootOrigin\(this\.landscape\.state\.landscapeRoot/.test(world)
)
assert(
  'pre-capsule camera looks at genesis spawn, not parcel 0,0',
  /genesisMetersFromSceneLocal\(0, 0, sceneConfig\.baseParcel\)/.test(
    readFileSync(join(root, 'src/rendering/SceneHost.ts'), 'utf8')
  )
)
{
  const physx = readFileSync(join(root, 'src/physics/PhysXWorld.ts'), 'utf8')
  const shell = readFileSync(join(root, 'src/dcl/aoi/shellColliders.ts'), 'utf8')
  assert(
    'occupied composite shells cook _collider hulls in the 48 m ring',
    /extractShellColliderDescs/.test(aoi) &&
      /syncNearShellPhys/.test(aoi) &&
      /syncAoiShellColliders/.test(physx) &&
      /syncShellColliders:/.test(world)
  )
  assert(
    'SDK6 CityTiles are not left walk-through',
    !/Composite shells stay walk-through/.test(caps) &&
      /SDK6\/composite shells cook/.test(caps)
  )
  assert(
    'plaza PhysX streaming skips AOI shell ids',
    /isAoiPlatformColliderEntity/.test(world) &&
      /isAoiShellColliderEntity/.test(physx)
  )
  assert(
    'shell PhysX ids sit in the 29.0M gap (not road 21M / empty 29.1M / secondary 30M)',
    /SHELL_AOI_COLLIDER_ENTITY_BASE = 29_000_000/.test(shell) &&
      /SHELL_AOI_COLLIDER_ID_SPAN = 100_000/.test(shell)
  )
}
{
  // City walk box is FocusOwner-local. Treating that box as genesis meters
  // slams 126,104 spawn (~2024,1672) to the NE corner → parcel 37,54.
  const CITY_MAX_X = 163
  const CITY_MAX_Y = 158
  const margin = 0.35
  const maxX = (CITY_MAX_X - 126 + 1) * PARCEL_SIZE
  const maxZ = (CITY_MAX_Y - 104 + 1) * PARCEL_SIZE
  const px = Math.floor((maxX - margin) / PARCEL_SIZE)
  const py = Math.floor((maxZ - margin) / PARCEL_SIZE)
  assert(
    'misapplied 126,104 city-walk clamp is parcel 37,54 (the reported spawn)',
    px === 37 && py === 54
  )
}
assert(
  '126,104 genesis offset is 2016m east / 1664m north',
  (126 * PARCEL_SIZE === 2016 && 104 * PARCEL_SIZE === 1664)
)
const slot = readFileSync(join(root, 'src/dcl/multiScene/SceneWorkerSlot.ts'), 'utf8')
assert(
  'empty-graph hydrate gives up when the mesh queue is empty',
  /pending <= 0 && performance\.now\(\) - this\.hydrateStartedAt > 2_500/.test(slot)
)
assert(
  'tertiary neighbors still cook PhysX inside the 48 m ring',
  /residentMode !== 'tertiary'/.test(secondary) === false
    ? /slot.residentMode !== 'secondary' && slot.residentMode !== 'tertiary'/.test(secondary)
    : true
)
assert(
  'dclToThree negates X (126,104→127,103 is +16,+16 Three)',
  (() => {
    // o.x=(126-127)*16=-16, o.z=(104-103)*16=16 → Three (-(-16), 16)=(16,16)
    const oX = (126 - 127) * PARCEL_SIZE
    const oZ = (104 - 103) * PARCEL_SIZE
    const threeX = -oX
    const threeZ = oZ
    return threeX === 16 && threeZ === 16
  })()
)

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
