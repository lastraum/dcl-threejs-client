#!/usr/bin/env node
/**
 * UiBackground law — crop UVs then textureMode. Same path for every scene and PE.
 * Run: node scripts/test-ui-background-uv.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(process.cwd(), 'src/ui/scene/uiBackgroundStyle.ts'), 'utf8')
const renderer = readFileSync(join(process.cwd(), 'src/ui/scene/SceneUiDomRenderer.ts'), 'utf8')

let failed = 0
function assert(label, cond) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failed++
    console.error(` FAIL ${label}`)
  }
}

const NINE_SLICES = 0
const CENTER = 1
const STRETCH = 2

function isDefaultThirdSlices(slices) {
  if (slices == null || typeof slices !== 'object') return true
  const t = Number(slices.top ?? 1 / 3)
  const r = Number(slices.right ?? 1 / 3)
  const b = Number(slices.bottom ?? 1 / 3)
  const l = Number(slices.left ?? 1 / 3)
  const near = (a, x) => Math.abs(a - x) < 0.02
  return near(t, 1 / 3) && near(r, 1 / 3) && near(b, 1 / 3) && near(l, 1 / 3)
}

function parseUiBackgroundUvRect(uvs) {
  if (!uvs || uvs.length < 8) return null
  const us = [uvs[0], uvs[2], uvs[4], uvs[6]]
  const vs = [uvs[1], uvs[3], uvs[5], uvs[7]]
  const u0 = Math.min(...us)
  const u1 = Math.max(...us)
  const v0 = Math.min(...vs)
  const v1 = Math.max(...vs)
  if (u1 - u0 < 1e-5 || v1 - v0 < 1e-5) return null
  if (u0 <= 1e-5 && v0 <= 1e-5 && u1 >= 1 - 1e-5 && v1 >= 1 - 1e-5) return null
  return { u0, v0, u1, v1 }
}

function isAuthoredNineSlice(mode, textureSlices) {
  if (typeof mode === 'string' && mode.toLowerCase().replace(/-/g, '_') === 'nine_slices') {
    return true
  }
  if (mode !== NINE_SLICES) return false
  return textureSlices != null && typeof textureSlices === 'object' && !isDefaultThirdSlices(textureSlices)
}

function normalizeBackgroundTextureMode(mode, _src, textureSlices, uvs) {
  if (isAuthoredNineSlice(mode, textureSlices)) return NINE_SLICES
  const uvRect = parseUiBackgroundUvRect(uvs)
  if (uvRect) {
    const uSpan = uvRect.u1 - uvRect.u0
    const vSpan = uvRect.v1 - uvRect.v0
    const nineMode =
      mode === NINE_SLICES ||
      (typeof mode === 'string' && mode.toLowerCase().replace(/-/g, '_') === 'nine_slices')
    if (nineMode && uSpan >= 0.55 && vSpan >= 0.55) return NINE_SLICES
    return STRETCH
  }
  if (typeof mode === 'string') {
    const key = mode.toLowerCase().replace(/-/g, '_')
    if (key === 'stretch') return STRETCH
    if (key === 'center') return CENTER
    if (key === 'nine_slices') return NINE_SLICES
  }
  if (mode === undefined || mode === null) return CENTER
  const numeric = typeof mode === 'number' ? mode : CENTER
  if (numeric === NINE_SLICES) {
    if (textureSlices != null && typeof textureSlices === 'object' && !isDefaultThirdSlices(textureSlices)) {
      return NINE_SLICES
    }
    return STRETCH
  }
  if (numeric === CENTER || numeric === STRETCH) return numeric
  return CENTER
}

function isUvFillOrScrollStrip(u0, v0, u1, v1) {
  const uSpan = u1 - u0
  const vSpan = v1 - v0
  if (uSpan < 0.55 && vSpan < 0.55) return false
  if (uSpan >= 0.85 && vSpan > 1e-5 && vSpan < 0.55) return true
  if (vSpan >= 0.85 && uSpan > 1e-5 && uSpan < 0.55) return true
  return false
}

function isBottomAlignedUvFill(u0, v0, u1, v1) {
  const vSpan = v1 - v0
  return u0 <= 1e-3 && u1 >= 1 - 1e-3 && v0 <= 1e-3 && v1 > 1e-5 && vSpan < 0.55
}

const atlasUvs = [0, 0.1, 0, 0.9, 1, 0.9, 1, 0.1]
const authored = { top: 0.12, right: 0.12, bottom: 0.12, left: 0.12 }
const defaultSlices = { top: 1 / 3, right: 1 / 3, bottom: 1 / 3, left: 1 / 3 }

console.log('mode')
assert(
  'UV + authored slices → NINE_SLICES',
  normalizeBackgroundTextureMode(0, null, authored, atlasUvs) === NINE_SLICES
)
assert(
  'panel UV + protobuf 1/3 + mode 0 → NINE_SLICES',
  normalizeBackgroundTextureMode(0, null, defaultSlices, atlasUvs) === NINE_SLICES
)
const shopUvs = [0.1, 0.1, 0.1, 0.4, 0.4, 0.4, 0.4, 0.1]
assert(
  'cell UV + protobuf 1/3 + mode 0 → STRETCH',
  normalizeBackgroundTextureMode(0, null, defaultSlices, shopUvs) === STRETCH
)
assert(
  'explicit nine_slices string + UVs → NINE_SLICES',
  normalizeBackgroundTextureMode('nine_slices', null, defaultSlices, atlasUvs) === NINE_SLICES
)
assert(
  'no UV + authored slices + mode 0 → NINE_SLICES',
  normalizeBackgroundTextureMode(0, null, authored, null) === NINE_SLICES
)

console.log('\nfill vs HUD window')
assert(
  'thin full-width reel is a fill strip',
  isUvFillOrScrollStrip(0, 0, 1, 0.3) && isBottomAlignedUvFill(0, 0, 1, 0.3)
)
assert(
  'large HUD atlas window is NOT a fill strip',
  !isUvFillOrScrollStrip(0, 0.1, 1, 0.9) && !isBottomAlignedUvFill(0, 0, 1, 0.8)
)
assert('shop cell stays atlas crop', !isUvFillOrScrollStrip(0.1, 0.1, 0.4, 0.4))

console.log('\nsource')
assert('crop-then-slice helper exists', /resolveUvCroppedImageUrl/.test(src))
assert('GL V=0 bottom crop', /\(1 - rect\.v1\) \* h/.test(src))
assert('fill-strip requires thin vSpan', /vSpan < 0\.55/.test(src))
assert(
  'DOM nine-slice no longer banned when UVs exist',
  /texMode === BackgroundTextureMode\.NINE_SLICES/.test(renderer) &&
    !/!parseUiBackgroundUvRect\(bg\?\.uvs\)/.test(renderer)
)

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nok ui background UV law')
