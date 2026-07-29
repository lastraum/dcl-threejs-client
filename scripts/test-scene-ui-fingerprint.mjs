#!/usr/bin/env node
/**
 * Tier A unit checks for scene-ui layout/visual fingerprints + UV parse (SCENE_UI_COD).
 * Mirrors pure logic from src/ui/scene/uiLayoutCache.ts + uiBackgroundStyle.ts.
 * Run: npm run test:scene-ui
 */

function extractUiTextureSrc(texture) {
  if (!texture) return null
  if (typeof texture === 'string') return texture.trim() || null
  const t = texture
  const tex = t.tex
  if (tex?.$case === 'texture' && typeof tex.texture?.src === 'string') {
    return tex.texture.src.trim() || null
  }
  if (tex && typeof tex.texture?.src === 'string') return tex.texture.src.trim() || null
  if (typeof t.src === 'string') return t.src.trim() || null
  const nested = t.texture
  if (typeof nested?.src === 'string') return nested.src.trim() || null
  if (nested?.tex?.$case === 'texture' && typeof nested.tex.texture?.src === 'string') {
    return nested.tex.texture.src.trim() || null
  }
  return null
}

function parseUiBackgroundUvRect(uvs) {
  if (!uvs) return null
  const readAt = (i) => {
    if (Array.isArray(uvs) || ArrayBuffer.isView(uvs)) return Number(uvs[i])
    return Number(uvs[String(i)])
  }
  let len = uvs.length
  if (len == null || !Number.isFinite(len)) {
    let n = 0
    while (Object.prototype.hasOwnProperty.call(uvs, String(n))) n++
    len = n
  }
  if (len < 8) return null
  const nums = []
  for (let i = 0; i < 8; i++) {
    const n = readAt(i)
    if (!Number.isFinite(n)) return null
    nums.push(n)
  }
  const us = [nums[0], nums[2], nums[4], nums[6]]
  const vs = [nums[1], nums[3], nums[5], nums[7]]
  const u0 = Math.min(...us)
  const u1 = Math.max(...us)
  const v0 = Math.min(...vs)
  const v1 = Math.max(...vs)
  if (u1 - u0 < 1e-5 || v1 - v0 < 1e-5) return null
  if (u0 <= 1e-5 && v0 <= 1e-5 && u1 >= 1 - 1e-5 && v1 >= 1 - 1e-5) return null
  return { u0, v0, u1, v1 }
}

function entityUiVisualPaintKey(entity, transform, text, bg, pointerKey) {
  const o = transform.opacity ?? 1
  const z = transform.zIndex ?? 0
  const pf = transform.pointerFilter ?? 0
  const d = transform.display ?? 0
  let t = ''
  if (text?.value != null) {
    t = `t${text.value.length}:${text.value.slice(0, 48)}:${text.fontSize ?? 10}`
  }
  let b = ''
  if (bg) {
    const c = bg.color
    b = c ? `bg${c.r ?? 0},${c.g ?? 0},${c.b ?? 0},${c.a ?? 1}` : 'bg'
    const texSrc = extractUiTextureSrc(bg.texture)
    if (texSrc) b += `:tex${texSrc}`
    else if (bg.texture) b += ':tex'
    if (bg.uvs != null) {
      const u = bg.uvs
      let n = u.length ?? 0
      if (!n && typeof u === 'object' && !Array.isArray(u) && !ArrayBuffer.isView(u)) {
        while (Object.prototype.hasOwnProperty.call(u, String(n))) n++
      }
      if (n >= 8) {
        const parts = []
        for (let i = 0; i < 8; i++) {
          const v =
            Array.isArray(u) || ArrayBuffer.isView(u) ? Number(u[i]) : Number(u[String(i)])
          parts.push(v.toFixed(4))
        }
        b += `:uv${parts.join(',')}`
      }
    }
  }
  return `${entity}|d${d}|o${o}|z${z}|pf${pf}|${t}|${b}|pe${pointerKey}`
}

function layoutTransformFingerprint(transform) {
  const strip = new Set(['opacity', 'zIndex', 'pointerFilter'])
  const out = {}
  for (const [key, value] of Object.entries(transform)) {
    if (strip.has(key)) continue
    if (value === undefined) continue
    out[key] = value
  }
  return JSON.stringify(out)
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

// --- texture src in visual key (COD: no bare :tex early-out) ---
{
  const baseT = { opacity: 1, zIndex: 0, display: 0, pointerFilter: 0 }
  const noSrc = entityUiVisualPaintKey(1, baseT, null, { texture: { tex: { $case: 'texture', texture: {} } } }, '')
  const withSrcA = entityUiVisualPaintKey(
    1,
    baseT,
    null,
    { texture: { tex: { $case: 'texture', texture: { src: 'a.png' } } } },
    ''
  )
  const withSrcB = entityUiVisualPaintKey(
    1,
    baseT,
    null,
    { texture: { tex: { $case: 'texture', texture: { src: 'b.png' } } } },
    ''
  )
  assert(withSrcA.includes(':texa.png'), 'visual key embeds texture src')
  assert(withSrcA !== withSrcB, 'different texture src → different visual key')
  assert(noSrc !== withSrcA, 'empty nested texture ≠ resolved src key')
}

// --- UV in visual key ---
{
  const baseT = { opacity: 1, zIndex: 0, display: 0, pointerFilter: 0 }
  const uvsA = [0, 0, 0, 0.25, 0.25, 0.25, 0.25, 0]
  const uvsB = [0.25, 0, 0.25, 0.25, 0.5, 0.25, 0.5, 0]
  const kA = entityUiVisualPaintKey(2, baseT, null, { texture: { src: 'sheet.png' }, uvs: uvsA }, '')
  const kB = entityUiVisualPaintKey(2, baseT, null, { texture: { src: 'sheet.png' }, uvs: uvsB }, '')
  assert(kA.includes(':uv'), 'visual key includes UV fingerprint')
  assert(kA !== kB, 'different UV rects → different visual key')
  // Object-form uvs (post-JSON TypedArray destroy)
  const obj = Object.fromEntries(uvsA.map((v, i) => [String(i), v]))
  const kObj = entityUiVisualPaintKey(2, baseT, null, { texture: { src: 'sheet.png' }, uvs: obj }, '')
  assert(kObj.includes(':uv'), 'object-form uvs still fingerprint')
}

// --- PE in visual key ---
{
  const baseT = { opacity: 1, zIndex: 0, display: 0, pointerFilter: 0 }
  const pe0 = entityUiVisualPaintKey(3, baseT, null, null, '')
  const pe1 = entityUiVisualPaintKey(3, baseT, null, null, '1')
  assert(pe0 !== pe1, 'PE key change invalidates visual paint key')
}

// --- layout fingerprint strips paint-only fields ---
{
  const a = layoutTransformFingerprint({ width: 10, height: 20, opacity: 0.5, zIndex: 9 })
  const b = layoutTransformFingerprint({ width: 10, height: 20, opacity: 1, zIndex: 0 })
  const c = layoutTransformFingerprint({ width: 11, height: 20, opacity: 0.5, zIndex: 9 })
  assert(a === b, 'opacity/zIndex do not affect layout fingerprint')
  assert(a !== c, 'width change affects layout fingerprint')
}

// --- UV rect parse ---
{
  const full = parseUiBackgroundUvRect([0, 0, 0, 1, 1, 1, 1, 0])
  assert(full === null, 'full-texture UV rect treated as no crop')
  const cell = parseUiBackgroundUvRect([0.1, 0.2, 0.1, 0.4, 0.3, 0.4, 0.3, 0.2])
  assert(cell && Math.abs(cell.u0 - 0.1) < 1e-6 && Math.abs(cell.u1 - 0.3) < 1e-6, 'atlas cell UV bounds')
  const short = parseUiBackgroundUvRect([0, 0, 1, 1])
  assert(short === null, 'short UV array rejected')
  const objForm = parseUiBackgroundUvRect({
    0: 0.1,
    1: 0.2,
    2: 0.1,
    3: 0.4,
    4: 0.3,
    5: 0.4,
    6: 0.3,
    7: 0.2
  })
  assert(objForm && Math.abs(objForm.v0 - 0.2) < 1e-6, 'object-form UV parse')
}

// --- extract texture src shapes ---
{
  assert(extractUiTextureSrc({ src: 'x.png' }) === 'x.png', 'loose {src}')
  assert(
    extractUiTextureSrc({ tex: { $case: 'texture', texture: { src: 'y.png' } } }) === 'y.png',
    'SDK tex.$case shape'
  )
  assert(extractUiTextureSrc(null) === null, 'null texture')
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll scene-ui fingerprint checks passed')
