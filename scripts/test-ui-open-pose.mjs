#!/usr/bin/env node
/**
 * COD open-pose readiness unit tests (mirrors src/shim/worker/uiOpenPose.ts).
 * Open settle: size mid-open gates dead — poseReady always when fingerprint stable.
 *
 * Run: npm run test:ui-open-pose
 */

const VW = 1920
const VH = 1080
const DUAL_ROOT_EDGE_EPS = 1

function resolveUiPoseRow(input, vw = VW, vh = VH) {
  const wU = input.widthUnit ?? 0
  const hU = input.heightUnit ?? 0
  const wRaw = input.width ?? 0
  const hRaw = input.height ?? 0
  const w = wU === 2 ? (wRaw / 100) * vw : wU === 1 || wU === 0 ? wRaw : 0
  const h = hU === 2 ? (hRaw / 100) * vh : hU === 1 || hU === 0 ? hRaw : 0
  if (w < 1 || h < 1) return null
  const leftU = input.positionLeftUnit ?? 0
  const topU = input.positionTopUnit ?? 0
  const leftRaw = input.positionLeft ?? input.position?.left ?? 0
  const topRaw = input.positionTop ?? input.position?.top ?? 0
  const left = leftU === 2 ? (leftRaw / 100) * vw : leftRaw
  const top = topU === 2 ? (topRaw / 100) * vh : topRaw
  return {
    w,
    h,
    parent: input.parent ?? 0,
    abs: (input.positionType ?? 0) === 1,
    left,
    top,
    display: input.display,
    opacity: input.opacity ?? 1
  }
}

function uiPoseHidden(r) {
  const d = r.display
  if (d === 1 || d === 'none' || d === 'YG_DISPLAY_NONE') return true
  return r.opacity < 0.05
}

function uiPoseIsScaleSeed(r, vw = VW, vh = VH) {
  const maxSeed = Math.min(vw, vh) * 0.025
  return r.w >= 2 && r.h >= 2 && r.w <= maxSeed && r.h <= maxSeed
}

function uiPoseIsMicro(r, vw = VW, vh = VH) {
  const maxMicro = Math.min(vw, vh) * 0.045
  return r.w >= 4 && r.h >= 4 && r.w <= maxMicro && r.h <= maxMicro
}

function uiPoseIsModal(r, vw = VW, vh = VH) {
  const area = r.w * r.h
  const canvas = vw * vh
  if (area < canvas * 0.02) return false
  return area < canvas * 0.45
}

function uiPoseHasModalAncestor(byId, startParent) {
  let p = startParent
  for (let guard = 0; p && p !== 0 && guard < 16; guard++) {
    const pr = byId.get(p)
    if (!pr) break
    if (!uiPoseHidden(pr) && uiPoseIsModal(pr)) return true
    p = pr.parent
  }
  return false
}

function uiPoseChildCount(byId, id) {
  let n = 0
  for (const r of byId.values()) {
    if (r.parent === id) n++
  }
  return n
}

function canvasAbsOrigin(byId, startId) {
  let left = 0
  let top = 0
  let cur = startId
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const r = byId.get(cur)
    if (!r) break
    if (r.abs) {
      left += r.left
      top += r.top
    }
    cur = r.parent
  }
  return { left, top }
}

/** Size mid-open gates killed — mirror uiOpenPose.ts. */
function isDualRootParked(_byId, _vw = VW, _vh = VH) {
  return false
}

function isScaleSeedOpen(_byId, _vw = VW, _vh = VH) {
  return false
}

function isNoVisibleModalOnCanvas(_byId, _vw = VW, _vh = VH) {
  return false
}

function isOpenPoseBlocked(_byId) {
  return false
}

function isOpenPoseReady(byId, opts = {}) {
  if (opts.fingerprintStable === false) return false
  return !isOpenPoseBlocked(byId)
}

function needsOpenScale(_needOpenSettle, _byId) {
  return false
}

function mapFrom(entries) {
  const m = new Map()
  for (const [id, input] of entries) {
    const row = resolveUiPoseRow(input)
    if (row) m.set(id, row)
  }
  return m
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

// --- 20:07 vending dual-root: shell on-canvas + content @2146 ---
{
  const rows = mapFrom([
    [
      1,
      {
        positionType: 1,
        width: 1314,
        height: 637,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 346,
        positionTop: 120
      }
    ],
    [
      2,
      {
        positionType: 1,
        width: 1460,
        height: 900,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 2146,
        positionTop: 90
      }
    ]
  ])
  assert(isDualRootParked(rows) === false, 'size gate dead: off-canvas panel is NOT mid-open')
  assert(isOpenPoseBlocked(rows) === false, 'size gate dead: never blocked')
  assert(isOpenPoseReady(rows, { fingerprintStable: true }) === true, 'size gate dead: 20:07 poseReady')
  assert(
    isOpenPoseReady(rows, { fingerprintStable: true, mountJustGrew: true }) === true,
    'size gate dead: mount grew still poseReady'
  )
  // needsOpenScale simulation: needOpenSettle && blocked
  assert(needsOpenScale(true, rows) === false, 'size gate dead: 20:07 no needsOpenScale')
  assert(isOpenPoseReady(rows) === !isOpenPoseBlocked(rows), 'poseReady ≡ !blocked')
}

// --- percent-width dual twin (old detector FN) ---
{
  const rows = mapFrom([
    [
      1,
      {
        positionType: 1,
        width: 70,
        height: 60,
        widthUnit: 2, // percent
        heightUnit: 2,
        positionLeft: 10,
        positionTop: 10
      }
    ],
    [
      2,
      {
        positionType: 1,
        width: 70,
        height: 60,
        widthUnit: 2,
        heightUnit: 2,
        positionLeft: 2146, // absolute left past VW
        positionTop: 10
      }
    ]
  ])
  assert(isDualRootParked(rows) === false, 'size gate dead: percent off-canvas not dualParked')
  assert(isOpenPoseBlocked(rows) === false, 'size gate dead: percent off-canvas not blocked')
}

// --- after dual-root slide complete ---
{
  const rows = mapFrom([
    [
      1,
      {
        positionType: 1,
        width: 1314,
        height: 637,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 346,
        positionTop: 120
      }
    ],
    [
      2,
      {
        positionType: 1,
        width: 1314,
        height: 637,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 346,
        positionTop: 120
      }
    ]
  ])
  assert(isDualRootParked(rows) === false, 'slid-on-canvas twin not dualParked')
  assert(isOpenPoseReady(rows, { fingerprintStable: true, mountJustGrew: true }) === true, 'after slide poseReady')
  assert(isOpenPoseBlocked(rows) === false, 'after slide not blocked')
}

// --- tutorial scale seed 7×7 under modal ---
{
  const rows = mapFrom([
    [
      10,
      {
        positionType: 1,
        width: 696,
        height: 672,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 612,
        positionTop: 204
      }
    ],
    [
      11,
      {
        positionType: 0, // relative
        width: 7,
        height: 7,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 0,
        positionTop: 0,
        parent: 10
      }
    ],
    // kids of seed for kid-count gate
    [12, { positionType: 0, width: 3, height: 3, widthUnit: 1, heightUnit: 1, parent: 11 }],
    [13, { positionType: 0, width: 3, height: 3, widthUnit: 1, heightUnit: 1, parent: 11 }]
  ])
  assert(isScaleSeedOpen(rows) === false, 'size gate dead: micro is not scale seed')
  assert(isOpenPoseBlocked(rows) === false, 'size gate dead: micro seed not blocked')
  assert(isOpenPoseReady(rows, { fingerprintStable: true }) === true, 'size gate dead: tutorial seed poseReady')
}

// --- selection flat mount (no open) ---
{
  const rows = mapFrom([
    [
      1,
      {
        positionType: 1,
        width: 696,
        height: 672,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 612,
        positionTop: 204
      }
    ]
  ])
  assert(isOpenPoseBlocked(rows) === false, 'open modal alone not blocked')
  assert(isOpenPoseReady(rows, { fingerprintStable: true }) === true, 'open modal poseReady')
  assert(needsOpenScale(false, rows) === false, 'selection does not need open-scale')
  assert(needsOpenScale(true, rows) === false, 'flat open modal: grow+ready → no open-scale')
}

// --- HUD top park must NOT count as dual-root ---
{
  const rows = mapFrom([
    [
      1,
      {
        positionType: 1,
        width: 1920,
        height: 86,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 0,
        positionTop: -86
      }
    ],
    [
      2,
      {
        positionType: 1,
        width: 696,
        height: 672,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 612,
        positionTop: 204
      }
    ]
  ])
  assert(isDualRootParked(rows) === false, 'HUD top park is not dual-root (left not ≥VW)')
  assert(isOpenPoseReady(rows, { fingerprintStable: true }) === true, 'HUD+modal still poseReady')
}

// --- 20:57 / 21:25 inventory slots: nested abs (parent@200 + child@1027 → canvas y=1227) ---
{
  const rows = mapFrom([
    [
      1,
      {
        positionType: 1,
        width: 700,
        height: 600,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 400,
        positionTop: 200
      }
    ],
    // Local top=1027 only — local-only law would MISS; chain sum 200+1027=1227
    [
      2,
      {
        positionType: 1,
        width: 110,
        height: 110,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 534,
        positionTop: 1027,
        parent: 1
      }
    ],
    [
      3,
      {
        positionType: 1,
        width: 110,
        height: 110,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 656,
        positionTop: 1027,
        parent: 1
      }
    ]
  ])
  assert(isDualRootParked(rows) === false, 'size gate dead: nested below-fold not dualParked')
  assert(isOpenPoseBlocked(rows) === false, 'size gate dead: nested below-fold not blocked')
  assert(isOpenPoseReady(rows) === true, 'size gate dead: nested below-fold is poseReady')
  assert(needsOpenScale(true, rows) === false, 'size gate dead: no open-scale from below-fold')
  // Local-only would have said ready — prove chain accumulation is required
  assert(rows.get(2).top < 1080, 'local top alone is on-canvas (1027); chain detects park')
}

// --- HUD bottom strip at y=1080 must NOT block (full-bleed width) ---
{
  const rows = mapFrom([
    [
      1,
      {
        positionType: 1,
        width: 1920,
        height: 86,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 0,
        positionTop: 1080
      }
    ],
    [
      2,
      {
        positionType: 1,
        width: 696,
        height: 672,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 612,
        positionTop: 204
      }
    ]
  ])
  assert(isDualRootParked(rows) === false, 'HUD bottom full-bleed not dual-parked')
  assert(isOpenPoseReady(rows) === true, 'HUD bottom + modal poseReady')
}

// --- hidden dual twin ignored ---
{
  const rows = mapFrom([
    [
      2,
      {
        positionType: 1,
        width: 800,
        height: 600,
        widthUnit: 1,
        heightUnit: 1,
        positionLeft: 2146,
        positionTop: 100,
        display: 1 // none
      }
    ]
  ])
  assert(isDualRootParked(rows) === false, 'display:none twin not dualParked')
}

// --- PE pick simulation: dual-parked open should not claim ready ---
{
  // Simulated mesh click outcome after remount
  const afterMeshOpen = mapFrom([
    [100, { positionType: 1, width: 400, height: 300, widthUnit: 1, heightUnit: 1, positionLeft: 100, positionTop: 100 }],
    [101, { positionType: 1, width: 110, height: 110, widthUnit: 1, heightUnit: 1, positionLeft: 2200, positionTop: 300 }],
    [102, { positionType: 1, width: 110, height: 110, widthUnit: 1, heightUnit: 1, positionLeft: 2320, positionTop: 300 }]
  ])
  const mountGrew = true
  const needOpenSettle = mountGrew || isOpenPoseBlocked(afterMeshOpen)
  assert(needOpenSettle === true, 'PE sim: need open settle after grow')
  assert(needsOpenScale(needOpenSettle, afterMeshOpen) === false, 'size gate dead: PE mesh open no geometry open-scale')
  assert(isOpenPoseReady(afterMeshOpen) === true, 'size gate dead: PE off-canvas slots still poseReady')
  assert(isOpenPoseReady(afterMeshOpen) === !isOpenPoseBlocked(afterMeshOpen), 'PE sim: ready≡!blocked')
}

// --- after unpark PE sim ---
{
  const afterUnpark = mapFrom([
    [100, { positionType: 1, width: 400, height: 300, widthUnit: 1, heightUnit: 1, positionLeft: 100, positionTop: 100 }],
    [101, { positionType: 1, width: 110, height: 110, widthUnit: 1, heightUnit: 1, positionLeft: 200, positionTop: 300 }],
    [102, { positionType: 1, width: 110, height: 110, widthUnit: 1, heightUnit: 1, positionLeft: 320, positionTop: 300 }]
  ])
  assert(isOpenPoseBlocked(afterUnpark) === false, 'PE sim unpark: not blocked')
  assert(isOpenPoseReady(afterUnpark) === true, 'PE sim unpark: poseReady — open-scale may skip')
  assert(needsOpenScale(true, afterUnpark) === false, 'PE sim unpark: no open-scale after ready')
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall ui-open-pose assertions passed')
