/**
 * Scene-bundle scan for client ability VFX (`tjs.vfx:*`).
 * Only ids the running script actually names — never a global warm list.
 */

const KIND_PREFIX = 'tjs.vfx:'

const KNOWN: Record<string, string> = {
  ice: 'ice',
  hail: 'hail',
  hailwraith: 'hail',
  meteor: 'meteor',
  cinder: 'meteor',
  cinderfall: 'meteor',
  'cinder-fall': 'meteor'
}

export function normalizeAbilityVfxId(raw: string): string | null {
  const key = raw.trim().toLowerCase()
  return KNOWN[key] ?? null
}

/** True when this bundle talks to the client tag VFX host. */
export function sceneBundleMentionsAbilityVfx(source: string): boolean {
  return source.includes(KIND_PREFIX)
}

/**
 * Ids to warm for this bundle. Empty → do not boot AbilityManager.
 * Handles both `tjs.vfx:ice` literals and `tjs.vfx:${kind}` + `'ice'` splits.
 */
export function discoverAbilityVfxIds(source: string): string[] {
  if (!source || !sceneBundleMentionsAbilityVfx(source)) return []

  const found = new Set<string>()
  const tagged = source.matchAll(/tjs\.vfx:([a-z0-9_-]+)/gi)
  for (const m of tagged) {
    const id = normalizeAbilityVfxId(m[1] ?? '')
    if (id) found.add(id)
  }

  if (found.size === 0) {
    for (const raw of Object.keys(KNOWN)) {
      if (new RegExp(`['"\`]${raw}['"\`]`, 'i').test(source)) {
        const id = normalizeAbilityVfxId(raw)
        if (id) found.add(id)
      }
    }
  }

  return [...found]
}
