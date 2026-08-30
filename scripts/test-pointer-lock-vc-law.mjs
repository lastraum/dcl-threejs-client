#!/usr/bin/env node
/**
 * PointerLock is a scene-readable CameraEntity API. VirtualCamera owns the lens
 * pose, not the lock bit. Play-frames host PointerLock + PPI.screenDelta.
 *
 * Run: node scripts/test-pointer-lock-vc-law.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const playerSystem = readFileSync(join(root, 'src/player/PlayerSystem.ts'), 'utf8')
const playerInput = readFileSync(join(root, 'src/player/PlayerInput.ts'), 'utf8')
const sceneScript = readFileSync(join(root, 'src/core/systems/SceneScriptSystem.ts'), 'utf8')
const worker = readFileSync(join(root, 'src/shim/worker/sceneWorker.ts'), 'utf8')
const types = readFileSync(join(root, 'src/shim/types.ts'), 'utf8')

let failed = 0
function assert(label, cond) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failed++
    console.error(` FAIL ${label}`)
  }
}

console.log('pointer lock vc law')

const releaseFn = playerSystem.match(
  /releaseFreecamLookForVirtualCamera\(\)[\s\S]*?\n  \}/
)?.[0] ?? ''
assert(
  'VC unbind does not exitPointerLock (lock is scene-readable)',
  /stopOrbitIfActive/.test(releaseFn) && !/exitPointerLock/.test(releaseFn)
)

assert(
  'Tab still toggles pointer lock while VC owns the lens',
  /e\.code === 'Tab'[\s\S]*?this\.togglePointerLock\(\)/.test(playerInput) &&
    !/if \(!this\.isLookBlocked\(\)\) this\.togglePointerLock\(\)/.test(playerInput)
)

assert(
  'RMB toggles pointer lock even when look is blocked',
  /Right-click toggles pointer lock[\s\S]*?this\.togglePointerLock\(\)/.test(playerInput) &&
    !/Scene VC owns the lens — do not enter freecam look[\s\S]*?if \(this\.isLookBlocked\(\)\) return[\s\S]*?togglePointerLock/.test(
      playerInput
    )
)

assert(
  'play-frame-tick carries pointerLock',
  /pointerLock\?: boolean/.test(types) && /pointerLock,/.test(sceneScript)
)

assert(
  'worker hosts PointerLock skip-identical on play-frame',
  /function applyPointerLockOnEngine/.test(worker) &&
    /cur\?\.isPointerLocked === locked/.test(worker) &&
    /msg\.pointerLock/.test(worker)
)

assert(
  'VC + held IA_POINTER reports lock bit (screenDelta orbit without browser lock)',
  /isLookOwnedByScene\(\) && pe\.isPointerActionHeld\(\)/.test(sceneScript)
)

if (failed) {
  console.error(`\n${failed} pointer-lock vc law check(s) failed`)
  process.exit(1)
}
console.log('\nall pointer-lock vc law checks passed')
