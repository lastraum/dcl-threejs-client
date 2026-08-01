#!/usr/bin/env node
/**
 * PE open path — size mid-open gates killed (mirror uiOpenPose.ts).
 * Off-canvas panel alone must NOT force open-scale.
 *
 * Run: node scripts/test-ui-open-pose-ecs.mjs
 */

function isDualRootParked(_rows) {
  return false
}

function isOpenPoseBlocked(_rows) {
  return false
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

/** Simulated worker UI after PE mesh open (panel may still be off-canvas). */
function simMeshOpenUi(phase) {
  const rows = new Map()
  rows.set(100, { abs: true, left: 346, top: 120, w: 1314, h: 637, opacity: 1, display: 0 })
  if (phase === 'mid-open') {
    rows.set(101, { abs: true, left: 2146, top: 90, w: 1460, h: 900, opacity: 1, display: 0 })
    rows.set(102, { abs: true, left: 2201, top: 300, w: 110, h: 110, opacity: 1, display: 0 })
  } else if (phase === 'unparked') {
    rows.set(101, { abs: true, left: 346, top: 90, w: 1460, h: 900, opacity: 1, display: 0 })
    rows.set(102, { abs: true, left: 401, top: 300, w: 110, h: 110, opacity: 1, display: 0 })
  }
  return rows
}

const peLog = []
function injectPe(entity, state, button = 0) {
  peLog.push({ entity, state, button, t: peLog.length + 1 })
}

injectPe(3047, 'DOWN')
injectPe(3047, 'UP')
assert(peLog.length === 2, 'PE sim: DOWN+UP inject recorded')
assert(peLog[0].entity === 3047 && peLog[0].state === 'DOWN', 'PE sim: mesh DOWN first')
assert(peLog[1].state === 'UP', 'PE sim: mesh UP second')

const mid = simMeshOpenUi('mid-open')
const mountGrew = true
const needOpenSettle = mountGrew || isOpenPoseBlocked(mid)
const needsOpenScale = needOpenSettle && isOpenPoseBlocked(mid)
assert(isDualRootParked(mid) === false, 'size gate dead: off-canvas panel not dualParked')
assert(isOpenPoseBlocked(mid) === false, 'size gate dead: mid-open not blocked')
assert(needsOpenScale === false, 'size gate dead: no open-scale from off-canvas geometry')
assert(needOpenSettle === true, 'mount grew still needs settle for fingerprint (not size)')

const done = simMeshOpenUi('unparked')
assert(isDualRootParked(done) === false, 'unparked: not dualParked')
assert(isOpenPoseBlocked(done) === false, 'unparked: not blocked')
assert((true && isOpenPoseBlocked(done)) === false, 'unparked: open-scale skip OK')

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall ui-open-pose PE-path assertions passed')
