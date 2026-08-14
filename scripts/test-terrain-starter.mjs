/**
 * Determinism smoke for generateTerrainStarter (no browser).
 * Run: node scripts/test-terrain-starter.mjs
 */
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// Use tsx or compile path — project is TS; for CI without tsx, skip.
// Prefer dynamic import of built-less via node --experimental-strip-types if available.
const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

async function loadGen() {
  try {
    // Node 22+ strip types
    return await import(
      pathToFileURL(join(root, 'src/editor/terrain/generateTerrainStarter.ts')).href
    )
  } catch {
    console.warn('skip: need Node with TS strip or prebuild for unit import')
    process.exit(0)
  }
}

const {
  generateTerrainStarter,
  seedFromString
} = await loadGen()

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const seed = seedFromString('pizza-island')
assert(seed > 0, 'seedFromString')

const a = generateTerrainStarter({
  templateId: 'rolling-hills',
  seed,
  resolution: 64,
  widthM: 32,
  depthM: 32
})
const b = generateTerrainStarter({
  templateId: 'rolling-hills',
  seed,
  resolution: 64,
  widthM: 32,
  depthM: 32
})

assert(a.heights.length === 64 * 64, 'heights len')
assert(a.heights.every((h, i) => h === b.heights[i]), 'deterministic heights')
assert(a.splat.every((v, i) => v === b.splat[i]), 'deterministic splat')

const c = generateTerrainStarter({
  templateId: 'rolling-hills',
  seed: seed ^ 1,
  resolution: 64,
  widthM: 32,
  depthM: 32
})
let diff = 0
for (let i = 0; i < a.heights.length; i++) {
  if (a.heights[i] !== c.heights[i]) diff++
}
assert(diff > 100, 'different seed changes shape')

const island = generateTerrainStarter({
  templateId: 'island',
  seed,
  resolution: 64,
  widthM: 48,
  depthM: 48
})
// Archipelago: solid land interior + open water (not a full plate).
let landCells = 0
let waterCells = 0
let islandMaxH = -Infinity
for (let i = 0; i < island.heights.length; i++) {
  const h = island.heights[i]
  if (h > islandMaxH) islandMaxH = h
  if (h > 0) landCells++
  else waterCells++
}
const landFrac = landCells / island.heights.length
assert(landFrac > 0.18 && landFrac < 0.88, `island land fraction ${landFrac} should be archipelago`)
assert(waterCells > 20, 'island keeps open water between masses')
assert(islandMaxH > 4, 'island has raised interior')

const mtn = generateTerrainStarter({
  templateId: 'mountain-range',
  seed,
  resolution: 64,
  widthM: 48,
  depthM: 48
})
let mtnMaxH = 0
let rock = 0
for (let i = 0; i < mtn.heights.length; i++) {
  mtnMaxH = Math.max(mtnMaxH, mtn.heights[i])
  if (mtn.splat[i * 4 + 2] > 120) rock++
}
assert(mtnMaxH > 35, 'mountain-range has large peaks')
assert(rock > 50, 'mountain-range has rock/cliff splat')

console.log('test-terrain-starter: ok')
