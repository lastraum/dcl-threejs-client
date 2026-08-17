/**
 * Scene-bundle scan for client ability VFX (`tjs.vfx:*`).
 * Only ids the running script actually names — never a global warm list.
 */
import { expandScriptSource, shaderToVfxId } from './shaderTags'

const KIND_PREFIX = 'tjs.vfx:'

export function normalizeAbilityVfxId(raw: string): string | null {
  const key = raw.trim().toLowerCase()
  if (!key) return null
  return shaderToVfxId(key)
}

/** True when this bundle talks to the client tag VFX host. */
export function sceneBundleMentionsAbilityVfx(source: string): boolean {
  return (
    source.includes(KIND_PREFIX) ||
    source.includes('tjs:shader:') ||
    source.includes('tjs.shader:') ||
    source.includes('tjs.shader(') ||
    /\/\/[^\n]*\btjs\.[a-zA-Z]/.test(source)
  )
}

/**
 * Ids to warm for this bundle. Empty → do not boot AbilityManager.
 * Handles both `tjs.vfx:ice` literals and `tjs.vfx:${kind}` + `'ice'` splits.
 */
export function discoverAbilityVfxIds(source: string): string[] {
  source = expandScriptSource(source)
  if (!source || !sceneBundleMentionsAbilityVfx(source)) return []

  const found = new Set<string>()
  const tagged = source.matchAll(/tjs\.vfx:([a-z0-9_-]+)/gi)
  for (const m of tagged) {
    const id = normalizeAbilityVfxId(m[1] ?? '')
    if (id) found.add(id)
  }
  const builtins = source.matchAll(/builtin:([a-z0-9_-]+)/gi)
  for (const m of builtins) {
    const id = normalizeAbilityVfxId(m[1] ?? '')
    if (id) found.add(id)
  }
  const decls = source.matchAll(/tjs\.shader\s*\(\s*([a-zA-Z][\w-]*)\s*(?:,|\))/g)
  for (const m of decls) {
    const id = normalizeAbilityVfxId(m[1] ?? '')
    if (id) found.add(id)
  }
  const calls = source.matchAll(/\/\/[^\n]*\btjs\.([a-zA-Z][\w-]*)\s*\(/g)
  for (const m of calls) {
    const fn = (m[1] ?? '').toLowerCase()
    if (fn === 'shader') continue
    const id = normalizeAbilityVfxId(fn)
    if (id) found.add(id)
  }

  return [...found]
}
