#!/usr/bin/env node
/**
 * Contract checks for tjs.vfx tag parsing (mirrors src/bridge/vfx/parseTags.ts).
 * Run: npm run test:vfx-tags
 */

const VFX_ID_TAG = 'tjs.vfx:'
const VFX_CAST_SHORTHAND = 'tjs.vfx.cast:'
const VFX_OFF_TAG = 'tjs.vfx.off'
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
const KV_RE = /^tjs\.vfx\.(mode|range|speed|intensity|cooldown):(.+)$/

function clampFinite(n, min, max) {
  if (!Number.isFinite(n)) return undefined
  return Math.min(max, Math.max(min, n))
}

function normalizeId(raw) {
  const id = raw.trim().toLowerCase()
  return ID_RE.test(id) ? id : undefined
}

function parseVfxTags(tags) {
  if (!tags.length) return null
  if (tags.includes(VFX_OFF_TAG)) return null

  let id
  let mode = 'loop'
  let range
  let speed
  let intensity
  let cooldown

  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    if (raw.startsWith(VFX_CAST_SHORTHAND)) {
      const parsed = normalizeId(raw.slice(VFX_CAST_SHORTHAND.length))
      if (parsed) {
        id = parsed
        mode = 'cast'
      }
      continue
    }
    if (raw.startsWith(VFX_ID_TAG) && !raw.startsWith('tjs.vfx.')) {
      const parsed = normalizeId(raw.slice(VFX_ID_TAG.length))
      if (parsed) id = parsed
      continue
    }
    const kv = KV_RE.exec(raw)
    if (!kv) continue
    const key = kv[1]
    const val = kv[2]
    if (key === 'mode') {
      if (val === 'loop' || val === 'cast') mode = val
      continue
    }
    const n = Number(val)
    if (key === 'range') range = clampFinite(n, 0.1, 128)
    else if (key === 'speed') speed = clampFinite(n, 0.1, 80)
    else if (key === 'intensity') intensity = clampFinite(n, 0, 1)
    else if (key === 'cooldown') cooldown = clampFinite(n, 0, 60)
  }

  if (!id) return null
  const out = { id, mode }
  if (range !== undefined) out.range = range
  if (speed !== undefined) out.speed = speed
  if (intensity !== undefined) out.intensity = intensity
  if (cooldown !== undefined) out.cooldown = cooldown
  return out
}

let passed = 0
let failed = 0

function assert(label, condition) {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(` FAIL ${label}`)
  }
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

console.log('parseVfxTags')

assert('empty → null', parseVfxTags([]) === null)
assert('no vfx tags → null', parseVfxTags(['Tag Group 1', 'game']) === null)
assert(
  'bare ice defaults loop',
  same(parseVfxTags(['tjs.vfx:ice']), { id: 'ice', mode: 'loop' })
)
assert(
  'mode cast',
  same(parseVfxTags(['tjs.vfx:meteor', 'tjs.vfx.mode:cast']), { id: 'meteor', mode: 'cast' })
)
assert(
  'shorthand cast:snare',
  same(parseVfxTags(['tjs.vfx.cast:snare']), { id: 'snare', mode: 'cast' })
)
assert(
  'numeric tags',
  same(parseVfxTags(['tjs.vfx:ice', 'tjs.vfx.range:18', 'tjs.vfx.speed:24', 'tjs.vfx.intensity:0.8', 'tjs.vfx.cooldown:1.5']), {
    id: 'ice',
    mode: 'loop',
    range: 18,
    speed: 24,
    intensity: 0.8,
    cooldown: 1.5
  })
)
assert('off wins', parseVfxTags(['tjs.vfx:ice', 'tjs.vfx.off']) === null)
assert('range tag is not an id', parseVfxTags(['tjs.vfx.range:18']) === null)
assert('non-finite ignored', same(parseVfxTags(['tjs.vfx:ice', 'tjs.vfx.range:nope']), { id: 'ice', mode: 'loop' }))
assert('intensity clamped', parseVfxTags(['tjs.vfx:ice', 'tjs.vfx.intensity:4']).intensity === 1)
assert('range clamped min', parseVfxTags(['tjs.vfx:ice', 'tjs.vfx.range:0']).range === 0.1)
assert('unknown id charset → null', parseVfxTags(['tjs.vfx:ICE!!!']) === null)
assert('id lowercased', parseVfxTags(['tjs.vfx:Ice']).id === 'ice')
assert('hub group ignored', same(parseVfxTags(['Tag Group 1', 'tjs.vfx:thunder']), { id: 'thunder', mode: 'loop' }))

console.log('')
if (failed) {
  console.error(`${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`${passed} passed`)
