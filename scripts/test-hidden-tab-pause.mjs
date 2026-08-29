#!/usr/bin/env node
/**
 * Hidden tabs must not run world/AOI/SceneLoop ticks (catch-up hitch on resume).
 * Run: node scripts/test-hidden-tab-pause.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const vis = readFileSync(join(process.cwd(), 'src/util/documentVisibility.ts'), 'utf8')
const host = readFileSync(join(process.cwd(), 'src/rendering/SceneHost.ts'), 'utf8')
const world = readFileSync(join(process.cwd(), 'src/core/World.ts'), 'utf8')
const app = readFileSync(join(process.cwd(), 'src/client/AppController.ts'), 'utf8')

let failed = 0
function assert(label, cond) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failed++
    console.error(` FAIL ${label}`)
  }
}

assert('whenDocumentVisible helper exists', /export function whenDocumentVisible/.test(vis))
assert('SceneHost skips ticks while hidden', /isDocumentHidden\(\)/.test(host) && /clock\.getDelta\(\)/.test(host))
assert('SceneHost does not SharedWorker-tick while hidden', !/subscribeBackgroundTicks/.test(host))
assert('warmPlayGpu waits for visible', /await whenDocumentVisible\(\)/.test(world))
assert('play loop does not start while hidden', /await whenDocumentVisible\(\)[\s\S]{0,80}world\.start\(\)/.test(app))

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nok hidden tab pause')
