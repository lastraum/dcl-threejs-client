#!/usr/bin/env node
/**
 * COD open-pose readiness unit tests (mirrors src/shim/worker/uiOpenPose.ts).
 * Pure geometry law — dual-root park, scale seed, poseReady / needsOpenScale.
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

function isDualRootParked(byId, vw = VW, vh = VH) {
  for (const [id, r] of byId) {
    if (uiPoseHidden(r)) continue
    if (r.w >= vw - 20) continue
    if (r.w < 48 || r.h < 48) continue
    const origin = canvasAbsOrigin(byId, id)
    const coversCanvas =
      origin.left < vw * 0.15 &&
      origin.top < vh * 0.15 &&
      origin.left + r.w > vw * 0.85 &&
      origin.top + r.h > vh * 0.85
    if (coversCanvas) continue
    if (origin.left >= vw - DUAL_ROOT_EDGE_EPS) return true
    if (origin.top >= vh - DUAL_ROOT_EDGE_EPS) return true
    if (origin.left + r.w <= DUAL_ROOT_EDGE_EPS) return true
    if (origin.top + r.h <= DUAL_ROOT_EDGE_EPS) return true
  }
  return false
}

function isScaleSeedOpen(byId, vw = VW, vh = VH) {
  let scaleMicro = 0
  let microAbsLoose = 0
  let fullAbs = 0
  for (const [id, r] of byId) {
    if (uiPoseHidden(r)) continue
    const kids = uiPoseChildCount(byId, id)
    const aspect = Math.max(r.w, r.h) / Math.max(1, Math.min(r.w, r.h))
    if (
      !r.abs &&
      kids >= 2 &&
      !uiPoseIsModal(r, vw, vh) &&
      aspect < 4 &&
      r.w >= 2 &&
      r.h >= 2 &&
      uiPoseHasModalAncestor(byId, r.parent)
    ) {
      let p = r.parent
      let parentRow
      for (let g = 0; p && g < 16; g++) {
        parentRow = byId.get(p)
        if (!parentRow) break
        if (!uiPoseHidden(parentRow) && uiPoseIsModal(parentRow, vw, vh)) break
        p = parentRow.parent
        parentRow = undefined
      }
      if (parentRow) {
        const fracW = r.w / Math.max(1, parentRow.w)
        const fracH = r.h / Math.max(1, parentRow.h)
        if (fracW < 0.08 && fracH < 0.08) {
          scaleMicro++
          continue
        }
      }
    }
    if (uiPoseIsScaleSeed(r, vw, vh) && r.abs) {
      const cx = r.left + r.w / 2
      const cy = r.top + r.h / 2
      if (Math.abs(cx - vw / 2) < vw * 0.25 && Math.abs(cy - vh / 2) < vh * 0.33 && kids >= 1) {
        scaleMicro++
        continue
      }
    }
    if (r.abs && uiPoseIsMicro(r, vw, vh) && !uiPoseIsScaleSeed(r, vw, vh)) {
      microAbsLoose++
    } else if (r.abs && uiPoseIsModal(r, vw, vh)) {
      fullAbs++
    }
  }
  if (scaleMicro > 0) return true
  return microAbsLoose > 0 && fullAbs === 0
}

function hasOnCanvasModalBody(byId, vw = VW, vh = VH) {
  for (const r of byId.values()) {
    if (uiPoseHidden(r)) continue
    if (!uiPoseIsModal(r, vw, vh)) continue
    if (r.abs) {
      if (r.left < vw - 8 && r.top < vh - 8 && r.left + r.w > 8 && r.top + r.h > 8) return true
    } else {
      return true
    }
  }
  return false
}

function isNoVisibleModalOnCanvas(byId, vw = VW, vh = VH) {
  let modalish = 0
  let shown = 0
  for (const r of byId.values()) {
    if (!uiPoseIsModal(r, vw, vh)) continue
    modalish++
    if (uiPoseHidden(r)) continue
    shown++
  }
  if (modalish === 0) return false
  if (shown === 0) return true
  return !hasOnCanvasModalBody(byId, vw, vh)
}

function isOpenPoseBlocked(byId) {
  return isDualRootParked(byId) || isScaleSeedOpen(byId) || isNoVisibleModalOnCanvas(byId)
}

function isOpenPoseReady(byId, opts = {}) {
  if (opts.fingerprintStable === false) return false
  return !isOpenPoseBlocked(byId)
}

function needsOpenScale(needOpenSettle, byId) {
  return needOpenSettle && isOpenPoseBlocked(byId)
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
  assert(isDualRootParked(rows) === true, '20:07 dual-root content@2146 is dualParked')
  assert(isOpenPoseBlocked(rows) === true, '20:07 open pose blocked while dual-parked')
  assert(isOpenPoseReady(rows, { fingerprintStable: true }) === false, '20:07 NOT poseReady')
  assert(
    isOpenPoseReady(rows, { fingerprintStable: true, mountJustGrew: true }) === false,
    '20:07 mount grew still not poseReady (must open-scale)'
  )
  // needsOpenScale simulation: needOpenSettle && blocked
  assert(needsOpenScale(true, rows) === true, '20:07 needsOpenScale must be true (refuse skip)')
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
  assert(isDualRootParked(rows) === true, 'percent-size twin at left=2146 still dualParked')
  assert(isOpenPoseBlocked(rows) === true, 'percent twin blocks open')
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
  assert(isScaleSeedOpen(rows) === true, 'tutorial relative 7×7 under modal is scale seed')
  assert(isOpenPoseBlocked(rows) === true, 'tutorial seed blocks open')
  assert(isOpenPoseReady(rows, { fingerprintStable: true }) === false, 'tutorial seed not poseReady')
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
  assert(isDualRootParked(rows) === true, '21:25 nested slots canvas y=1227 dualParked')
  assert(isOpenPoseBlocked(rows) === true, '21:25 open blocked while nested below fold')
  assert(isOpenPoseReady(rows) === false, '21:25 NOT poseReady — refuse open-scale skip')
  assert(needsOpenScale(true, rows) === true, '21:25 needsOpenScale (not flags=ready)')
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
  assert(needsOpenScale(needOpenSettle, afterMeshOpen) === true, 'PE sim: needs open-scale (not pose-ready skip)')
  assert(isOpenPoseReady(afterMeshOpen) === false, 'PE sim: refuse poseReady while slots@left≥1920')
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
