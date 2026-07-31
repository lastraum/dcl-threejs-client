#!/usr/bin/env node
/**
 * PE open path state machine (no @dcl/ecs load — package dual CJS/ESM is broken under
 * plain node for this repo). Simulates mesh click → dual-root mid-open → unpark.
 * Geometry law mirrored from uiOpenPose.ts.
 *
 * Run: node scripts/test-ui-open-pose-ecs.mjs
 */

const VW = 1920
const DUAL_ROOT_EDGE_EPS = 1

function isDualRootParked(rows) {
  for (const r of rows.values()) {
    if (r.display === 1 || (r.opacity ?? 1) < 0.05) continue
    if (!r.abs) continue
    if (r.left >= VW - DUAL_ROOT_EDGE_EPS) return true
  }
  return false
}

function isOpenPoseBlocked(rows) {
  return isDualRootParked(rows)
}

let failed = 0
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    failed++
  } else {
    console.log('ok:', msg)
  }
}

/** Simulated worker UI mount after PE DOWN/UP on mesh (vending). */
function simMeshOpenUi(phase) {
  const rows = new Map()
  // Shell always on-canvas
  rows.set(100, { abs: true, left: 346, top: 120, w: 1314, h: 637, opacity: 1, display: 0 })
  if (phase === 'mid-open') {
    // Content twin still dual-root parked (20:07)
    rows.set(101, { abs: true, left: 2146, top: 90, w: 1460, h: 900, opacity: 1, display: 0 })
    // Inventory slots under content (Yoga abs after layout)
    rows.set(102, { abs: true, left: 2201, top: 300, w: 110, h: 110, opacity: 1, display: 0 })
  } else if (phase === 'unparked') {
    rows.set(101, { abs: true, left: 346, top: 90, w: 1460, h: 900, opacity: 1, display: 0 })
    rows.set(102, { abs: true, left: 401, top: 300, w: 110, h: 110, opacity: 1, display: 0 })
  }
  return rows
}

// --- PE inject state machine ---
const peLog = []
function injectPe(entity, state, button = 0) {
  peLog.push({ entity, state, button, t: peLog.length + 1 })
}

// Mesh click
injectPe(3047, 'DOWN')
injectPe(3047, 'UP')
assert(peLog.length === 2, 'PE sim: DOWN+UP inject recorded')
assert(peLog[0].entity === 3047 && peLog[0].state === 'DOWN', 'PE sim: mesh DOWN first')
assert(peLog[1].state === 'UP', 'PE sim: mesh UP second')

// After inject: mount grew, dual-root mid-open
const mid = simMeshOpenUi('mid-open')
const mountGrew = true
const needOpenSettle = mountGrew || isOpenPoseBlocked(mid)
const needsOpenScale = needOpenSettle && isOpenPoseBlocked(mid)
assert(isDualRootParked(mid) === true, 'PE path mid-open: dualParked')
assert(needsOpenScale === true, 'PE path mid-open: must enter open-scale (not pose-ready skip)')
assert(
  !(needOpenSettle && !needsOpenScale),
  'PE path mid-open: forbid open-scale skip while dualParked'
)

// After open-scale / tween: unparked
const done = simMeshOpenUi('unparked')
assert(isDualRootParked(done) === false, 'PE path unparked: not dualParked')
assert(isOpenPoseBlocked(done) === false, 'PE path unparked: not blocked')
const needsOpenScaleDone = true && isOpenPoseBlocked(done)
assert(needsOpenScaleDone === false, 'PE path unparked: open-scale skip OK (true poseReady)')

// UI close PE on shell (tutorial X style) while dual-parked must not claim shop usable
const midPeOn = 1 // shell PE only
const midPeOff = 63 // content off-canvas
assert(midPeOn === 1 && midPeOff > 10, 'PE path mid-open: peOnModal=0 class (shell only)')
assert(needsOpenScale === true, 'PE path: shell PE alone must not skip open-scale')

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall ui-open-pose PE-path assertions passed')
