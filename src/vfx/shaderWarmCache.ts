/**
 * Successful shader / ability warm stamps.
 * Survives scene `/reload` and Vite HMR. Cleared only on full client dispose.
 *
 * Key is `id|path` (path empty for ability-only warm). Failed loads are never stamped.
 */

type HotData = { shaderWarm?: Set<string> }

function hot(): HotData | undefined {
  return (import.meta as ImportMeta & { hot?: { data: HotData } }).hot?.data
}

const warmed: Set<string> = hot()?.shaderWarm ?? new Set()
const slot = hot()
if (slot) slot.shaderWarm = warmed

function key(id: string, path = ''): string {
  return `${id.trim().toLowerCase()}|${path.trim()}`
}

export function isShaderWarmed(id: string, path = ''): boolean {
  const i = id.trim().toLowerCase()
  if (!i) return false
  const p = path.trim()
  if (warmed.has(key(i, p))) return true
  // Ability-only stamp still counts as loaded for that id.
  if (p && warmed.has(key(i, ''))) return true
  return false
}

/** Stamp a successful load. Failures must not call this — retry stays allowed. */
export function stampShaderWarmed(id: string, path = ''): void {
  const i = id.trim().toLowerCase()
  if (!i) return
  warmed.add(key(i, path.trim()))
  warmed.add(key(i, ''))
}

/** Full client teardown only — scene `/reload` must not call this. */
export function clearShaderWarmCache(): void {
  warmed.clear()
}
