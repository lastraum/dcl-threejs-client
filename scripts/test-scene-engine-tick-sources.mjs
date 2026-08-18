/**
 * Clock-law inventory — after first play-frame, only named sources
 * `play-frame` | `pointer-edge` may start engine.update(dt>0).
 * tickSync / nudge must never start tickPlayFrame.
 *
 * Run: node scripts/test-scene-engine-tick-sources.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const srcRoot = join(root, 'src')

const ALLOWED_TICK_PLAY_FRAME = new Set([
  // SceneLoop.send adapters.
  'src/core/sceneLoop/SceneScriptGuest.ts',
  'src/core/sceneLoop/PeSlotGuest.ts',
  // Isolated throwaway host after present — not a guest clock.
  'src/dcl/aoi/SecondaryFirstFrameSampler.ts'
])

const NAMED_SOURCE = /source:\s*['"](?:play-frame|pointer-edge|hydrate)['"]/

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(p)
  }
  return out
}

function rel(p) {
  return relative(root, p).replaceAll('\\', '/')
}

function fail(msg) {
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
}

const files = walk(srcRoot)
let requestHits = 0
let playHits = 0

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const path = rel(file)
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const n = i + 1

    if (line.includes('requestSceneEngineTick(')) {
      requestHits++
      const isDef = /export\s+function\s+requestSceneEngineTick\s*\(/.test(line)
      if (isDef) continue
      const window = lines.slice(i, Math.min(lines.length, i + 4)).join('\n')
      if (!NAMED_SOURCE.test(window)) {
        fail(`${path}:${n} unscoped requestSceneEngineTick( — source required`)
      }
    }

    if (/\.tickPlayFrame\s*\(/.test(line) || /this\.tickPlayFrame\s*\(/.test(line)) {
      playHits++
      if (!ALLOWED_TICK_PLAY_FRAME.has(path)) {
        fail(`${path}:${n} production tickPlayFrame( — only SceneLoop.send (or isolated sampler)`)
      }
    }
  }
}

const caps = readFileSync(join(srcRoot, 'dcl/multiScene/caps.ts'), 'utf8')
const peFn = caps.match(/export function peTickIntervalMs[\s\S]*?return\s+(\d+)/)
if (!peFn || peFn[1] !== '50') {
  fail(`caps.ts peTickIntervalMs must return 50, got ${peFn?.[1] ?? 'missing'}`)
}
const boot = caps.match(/export const SECONDARY_LIVE_BOOT_CONCURRENCY\s*=\s*(\d+)/)
if (!boot || boot[1] !== '4') {
  fail(
    `SECONDARY_LIVE_BOOT_CONCURRENCY stays 4 until a pasted stacked-neighbor p5<30 log; got ${boot?.[1] ?? 'missing'}`
  )
}

const slot = readFileSync(join(srcRoot, 'dcl/multiScene/SceneWorkerSlot.ts'), 'utf8')
if (/this\.system\.tickPlayFrame\s*\(/.test(slot)) {
  fail('SceneWorkerSlot.tickSync must never call tickPlayFrame')
}
if (!/void skipPlayFrame/.test(slot)) {
  fail('SceneWorkerSlot.tickSync must hard-skip play-frame (void skipPlayFrame)')
}

const secondary = readFileSync(join(srcRoot, 'dcl/multiScene/SecondaryLiveManager.ts'), 'utf8')
if (/tickSync\([^)]*this\.playFrameOwnedExternally/.test(secondary)) {
  fail('SecondaryLiveManager tickSync/tickStickySync must hard-code skipPlayFrame=true')
}
const skipTrue = secondary.match(/slot\.tickSync\([^)]*,\s*true\s*\)/g) ?? []
if (skipTrue.length < 2) {
  fail(
    `SecondaryLiveManager tickSync + tickStickySync must both pass skipPlayFrame=true, found ${skipTrue.length}`
  )
}
const sticky = secondary.match(/tickStickySync\s*\([^)]*\)[\s\S]*?\n  [a-zA-Z_*]/)
if (!sticky || !/tickSync\([^)]*,\s*true\s*\)/.test(sticky[0])) {
  fail('tickStickySync must pass skipPlayFrame=true')
}

const pe = readFileSync(join(srcRoot, 'dcl/multiScene/PortableExperienceManager.ts'), 'utf8')
if (/tickSync\([^)]*\)\s*$/m.test(pe) && !/tickSync\([^)]*,\s*true\s*\)/.test(pe)) {
  fail('PortableExperienceManager fallback must pass skipPlayFrame=true')
}
if (/worker\.tickSync\([^)]*\)/.test(pe) && !/worker\.tickSync\([^)]*,\s*true\s*\)/.test(pe)) {
  fail('PE fallback tickSync must pass skipPlayFrame=true')
}

const world = readFileSync(join(srcRoot, 'core/World.ts'), 'utf8')
const presentFeet = world.match(
  /if \(startFrame >= World\.PLAY_PRESENT_GRACE_FRAMES\) \{[\s\S]*?this\.aoiVisual\.update/
)
if (!presentFeet) {
  fail('present must still run aoiVisual.update with feet-on-parcel jobs (no flip without p5<30 log)')
}
if (!/this\.scenePromote\.tick/.test(presentFeet[0])) {
  fail('scenePromote.tick (soft-route URL/minimap) must stay on present')
}
if (!/this\.syncCurrentSceneGuestAt/.test(presentFeet[0])) {
  fail('syncCurrentSceneGuestAt (Focus) must stay on present')
}

const nudge = readFileSync(join(srcRoot, 'core/systems/SceneScriptSystem.ts'), 'utf8')
const nudgeBlock = nudge.match(/nudgePlayAfterSceneTeleport\(\)[\s\S]*?\n  [a-zA-Z]/)
if (nudgeBlock && /tickPlayFrame\s*\(/.test(nudgeBlock[0])) {
  fail('nudgePlayAfterSceneTeleport must not call tickPlayFrame')
}

if (requestHits < 8) fail(`expected requestSceneEngineTick call sites, found ${requestHits}`)
if (playHits < 2) fail(`expected SceneLoop tickPlayFrame call sites, found ${playHits}`)

if (process.exitCode) {
  console.error('test-scene-engine-tick-sources: FAILED')
  process.exit(1)
}
console.log(
  `test-scene-engine-tick-sources: ok (${requestHits} named requestSceneEngineTick, ${playHits} allowed tickPlayFrame)`
)
