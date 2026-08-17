/**
 * Name + path first, then call that name:
 *   // tjs.shader(ice, assets/shaders/IceAbility.js)
 *   // tjs.shader(cinder, assets/shaders/MeteorAbility.js)
 *   // tjs.ice(at: 54, 0, 38)
 */

export type ShaderDecl = { name: string; src: string }

export type ShaderTrigger = {
  name: string
  fn: string
  params: Record<string, string>
}

export type ShaderPointerBinding = {
  hover: string
  triggers: ShaderTrigger[]
}

const RESERVED = new Set(['shader', 'vfx'])
const PARAM_KEYS = new Set(['origin', 'direction', 'distance', 'range'])

const LEGACY_DECL = /^tjs\.shader:([a-zA-Z][\w-]*)=(.+)$/
const LEGACY_TRIGGER = /^tjs\.([a-zA-Z][\w-]*):([a-zA-Z][\w-]*)$/
const LEGACY_PARAM = /^tjs\.([a-zA-Z][\w-]*)\.([a-zA-Z][\w-]*):(.+)$/
const CALL = /^tjs\.([a-zA-Z][\w-]*)\.([a-zA-Z][\w-]*)\s*\((.*)\)\s*$/
const BARE_CALL = /^tjs\.([a-zA-Z][\w-]*)\s*\((.*)\)\s*$/
const BARE_NAME = /^tjs\.([a-zA-Z][\w-]*)$/

function splitUrn(tag: string): string[] {
  return tag.trim().split(':').filter((p, i, a) => !(p === '' && i > 0 && i < a.length - 1))
}

function isIdent(s: string): boolean {
  return /^[a-zA-Z][\w-]*$/.test(s)
}

function looksLikePath(s: string): boolean {
  return s.includes('/') || /\.(js|mjs|ts)$/i.test(s)
}

export function aliasFromShaderPath(src: string): string {
  const leaf = src.split('/').pop() ?? src
  return leaf.replace(/\.(js|mjs|ts)$/i, '').toLowerCase()
}

/** Scene name or vfx class (`IceAbility`) → AbilityManager id (`ice`). */
export function shaderToVfxId(raw: string): string {
  let key = raw.trim().toLowerCase().replace(/ability$/, '')
  if (key === 'cinder' || key === 'cinder-fall' || key === 'cinderfall') return 'meteor'
  if (key === 'hailwraith') return 'hail'
  return key
}

function putParamPairs(
  put: (name: string, key: string, value: string) => void,
  name: string,
  parts: string[],
  start: number
): void {
  let i = start
  while (i < parts.length) {
    const key = parts[i] ?? ''
    if (!isIdent(key)) break
    i += 1
    const values: string[] = []
    while (i < parts.length && !PARAM_KEYS.has((parts[i] ?? '').toLowerCase())) {
      values.push(parts[i]!)
      i += 1
    }
    if (values.length > 0) put(name, key, values.join(':'))
  }
}

/** sdk-commands strips `//` from `bin/index.js` but preview embeds src in the inline map. */
export function expandScriptSource(source: string): string {
  const marker = '//# sourceMappingURL=data:application/json;base64,'
  const idx = source.lastIndexOf(marker)
  if (idx < 0) return source
  try {
    const b64 = source.slice(idx + marker.length).trim().split(/\s/)[0] ?? ''
    const json = JSON.parse(decodeBase64(b64)) as { sourcesContent?: unknown }
    const extra = (Array.isArray(json.sourcesContent) ? json.sourcesContent : [])
      .filter((row): row is string => typeof row === 'string')
      .join('\n')
    return extra ? `${source}\n${extra}` : source
  } catch {
    return source
  }
}

function decodeBase64(b64: string): string {
  if (typeof atob === 'function') return atob(b64)
  return Buffer.from(b64, 'base64').toString('utf8')
}

/** `tjs.shader(cinder, path)` / `tjs.shader(path)` / colon URN, in comments or strings. */
export function parseShaderDeclsFromSource(source: string): ShaderDecl[] {
  source = expandScriptSource(source)
  const found: string[] = []
  const named = /tjs\.shader\s*\(\s*([a-zA-Z][\w-]*)\s*,\s*([^)\s'"`]+)\s*\)/g
  let m: RegExpExecArray | null
  while ((m = named.exec(source))) {
    found.push(`tjs:shader:${m[1]}:${m[2]}`)
  }
  const pathOnly = /tjs\.shader\s*\(\s*([^)\s'"`]+)\s*\)/g
  while ((m = pathOnly.exec(source))) {
    const src = m[1] ?? ''
    found.push(`tjs.shader(${src})`)
  }
  const urn = /tjs:shader:([a-zA-Z][\w-]*):([^\s'"`]+)/g
  while ((m = urn.exec(source))) {
    found.push(`tjs:shader:${m[1]}:${m[2]}`)
  }
  return parseShaderDecls(found)
}

/**
 * `pointerEventsSystem.onPointerDown({ hoverText }, () => { // tjs.ice(...) })`
 * Click that hover → those comments.
 */
export function parseShaderPointerBindings(source: string): ShaderPointerBinding[] {
  source = expandScriptSource(source)
  const chunks = source.split(/onPointerDown\s*\(/)
  const out: ShaderPointerBinding[] = []
  for (const chunk of chunks.slice(1)) {
    const hover = chunk.match(/hoverText:\s*['"]([^'"]+)['"]/)
    if (!hover?.[1]) continue
    const body = chunk.slice(0, chunk.search(/\n\s*(?:const |function |export |pointerEventsSystem)/) || chunk.length)
    const found: string[] = []
    const dotted = /tjs\.([a-zA-Z][\w-]*)\.([a-zA-Z][\w-]*)\s*\(([^)]*)\)/g
    const bare = /tjs\.([a-zA-Z][\w-]*)\s*\(([^)]*)\)/g
    let m: RegExpExecArray | null
    while ((m = dotted.exec(body))) {
      if (m[1]!.toLowerCase() === 'shader') continue
      found.push(`tjs.${m[1]}.${m[2]}(${m[3]})`)
    }
    while ((m = bare.exec(body))) {
      if (m[1]!.toLowerCase() === 'shader') continue
      found.push(`tjs.${m[1]}(${m[2]})`)
    }
    const triggers = parseShaderTriggers(found)
    if (triggers.length) out.push({ hover: hover[1], triggers })
  }
  return out
}

/** Line comments: `// tjs.ice(at: 54, 0, 38)` / `// tjs.cinder.cast(...)`. */
export function parseShaderTriggersFromSource(source: string): ShaderTrigger[] {
  source = expandScriptSource(source)
  const found: string[] = []
  const dotted = /\/\/[^\n]*\btjs\.([a-zA-Z][\w-]*)\.([a-zA-Z][\w-]*)\s*\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = dotted.exec(source))) {
    const name = m[1] ?? ''
    if (name.toLowerCase() === 'shader' || RESERVED.has(name.toLowerCase())) continue
    found.push(`tjs.${name}.${m[2]}(${m[3]})`)
  }
  const bare = /\/\/[^\n]*\btjs\.([a-zA-Z][\w-]*)\s*\(([^)]*)\)/g
  while ((m = bare.exec(source))) {
    const fn = m[1] ?? ''
    if (fn.toLowerCase() === 'shader' || RESERVED.has(fn.toLowerCase())) continue
    found.push(`tjs.${fn}(${m[2]})`)
  }
  const urn = /\/\/[^\n]*\btjs:(?!shader:)([a-zA-Z][\w-]*):([^\s'"`]+)/g
  while ((m = urn.exec(source))) {
    found.push(`tjs:${m[1]}:${m[2]}`)
  }
  return parseShaderTriggers(found)
}

/** `at: 54, 0, 38` / `54, 0, 38` / `from: 30, 0, 50, range: 12` → param bag. */
export function parseCallArgs(raw: string): Record<string, string> {
  const s = raw.trim()
  if (!s) return {}
  const keys: Array<{ key: string; valueStart: number; index: number }> = []
  const named = /(?:^|,)\s*([a-zA-Z][\w-]*)\s*:/g
  let m: RegExpExecArray | null
  while ((m = named.exec(s))) {
    keys.push({ key: m[1]!, index: m.index, valueStart: m.index + m[0].length })
  }
  if (keys.length === 0) {
    const nums = s.split(',').map((x) => x.trim()).filter(Boolean)
    // IceAbility.spawn(origin, direction, distance) — 7 numbers.
    if (nums.length >= 7) {
      return {
        origin: nums.slice(0, 3).join(':'),
        direction: nums.slice(3, 6).join(':'),
        distance: nums[6]!
      }
    }
    if (nums.length >= 3) return { origin: nums.slice(0, 3).join(':') }
    if (nums.length === 1) {
      const n = Number(nums[0])
      if (Number.isFinite(n)) return { distance: nums[0]! }
      return { target: nums[0]! }
    }
    return {}
  }
  const params: Record<string, string> = {}
  for (let i = 0; i < keys.length; i++) {
    const row = keys[i]!
    const end = i + 1 < keys.length ? keys[i + 1]!.index : s.length
    const value = s.slice(row.valueStart, end).replace(/,\s*$/, '').trim()
    const joined = value.split(',').map((x) => x.trim()).filter(Boolean).join(':')
    if (joined) params[row.key.toLowerCase()] = joined
  }
  return params
}

export function parseShaderDecls(tags: readonly string[]): ShaderDecl[] {
  const out: ShaderDecl[] = []
  const seen = new Set<string>()
  const add = (name: string, src: string): void => {
    const n = name.toLowerCase()
    const s = src.trim()
    if (!n || !s || seen.has(n)) return
    seen.add(n)
    out.push({ name: n, src: s })
  }
  const CALL_DECL = /^tjs\.shader\s*\(\s*([a-zA-Z][\w-]*)\s*,\s*([^)]+?)\s*\)\s*$/
  const PATH_DECL = /^tjs\.shader\s*\(\s*([^)]+?)\s*\)\s*$/
  for (const raw of tags) {
    const tag = raw.trim()
    const call = tag.match(CALL_DECL)
    if (call) {
      add(call[1]!, call[2]!.replace(/^['"]|['"]$/g, ''))
      continue
    }
    const pathOnly = tag.match(PATH_DECL)
    if (pathOnly) {
      const src = pathOnly[1]!.replace(/^['"]|['"]$/g, '').trim()
      if (looksLikePath(src)) add(aliasFromShaderPath(src), src)
      else if (isIdent(src)) add(src, src)
      continue
    }
    const parts = splitUrn(tag)
    if (parts[0] === 'tjs' && parts[1] === 'shader' && parts.length >= 4) {
      add(parts[2]!, parts.slice(3).join(':'))
      continue
    }
    const m = tag.match(LEGACY_DECL)
    if (m) add(m[1]!, m[2]!)
  }
  return out
}

export function parseShaderTriggers(tags: readonly string[]): ShaderTrigger[] {
  const paramsByName = new Map<string, Record<string, string>>()
  const fns: Array<{ name: string; fn: string; params?: Record<string, string> }> = []
  const putParam = (name: string, key: string, value: string): void => {
    const n = name.toLowerCase()
    if (RESERVED.has(n)) return
    const bag = paramsByName.get(n) ?? {}
    bag[key.toLowerCase()] = value.trim()
    paramsByName.set(n, bag)
  }
  for (const raw of tags) {
    const tag = raw.trim()
    const call = tag.match(CALL)
    if (call) {
      const name = call[1]!.toLowerCase()
      if (name === 'shader' || RESERVED.has(name)) continue
      fns.push({ name, fn: call[2]!, params: parseCallArgs(call[3] ?? '') })
      continue
    }
    const bare = tag.match(BARE_CALL)
    if (bare) {
      const fn = bare[1]!.toLowerCase()
      if (fn === 'shader' || RESERVED.has(fn)) continue
      fns.push({ name: '', fn: bare[1]!, params: parseCallArgs(bare[2] ?? '') })
      continue
    }
    const just = tag.match(BARE_NAME)
    if (just) {
      const fn = just[1]!.toLowerCase()
      if (fn === 'shader' || RESERVED.has(fn)) continue
      fns.push({ name: '', fn: just[1]!, params: {} })
      continue
    }
    const parts = splitUrn(tag)
    if (parts[0] === 'tjs' && parts[1] !== 'shader' && !RESERVED.has((parts[1] ?? '').toLowerCase())) {
      const name = parts[1]!.toLowerCase()
      const third = parts[2] ?? ''
      if (parts.length === 3 && isIdent(third)) {
        fns.push({ name, fn: third })
        continue
      }
      if (parts.length >= 4 && isIdent(third)) {
        // tjs:cinder:cast:at:54:0:38  → fn + params
        // tjs:cinder:at:54:0:38       → params only
        if (PARAM_KEYS.has(third.toLowerCase())) {
          putParamPairs(putParam, name, parts, 2)
        } else {
          fns.push({ name, fn: third })
          putParamPairs(putParam, name, parts, 3)
        }
        continue
      }
    }
    const p = tag.match(LEGACY_PARAM)
    if (p) {
      putParam(p[1]!, p[2]!, p[3]!)
      continue
    }
    const t = tag.match(LEGACY_TRIGGER)
    if (t) {
      const name = t[1]!.toLowerCase()
      if (RESERVED.has(name) || name.startsWith('shader')) continue
      fns.push({ name, fn: t[2]! })
    }
  }
  return fns.map((row) => ({
    name: row.name,
    fn: row.fn,
    params: row.params ?? paramsByName.get(row.name) ?? {}
  }))
}

export function parseVec3(raw: string): { x: number; y: number; z: number } | null {
  const sep = raw.includes(',') ? ',' : ':'
  const parts = raw.split(sep).map((s) => Number(s.trim()))
  if (parts.length < 3) return null
  const [x, y, z] = parts
  if (![x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return { x: x!, y: y!, z: z! }
}

export function parseNumber(raw: string): number | null {
  const n = Number(raw.trim())
  return Number.isFinite(n) ? n : null
}
