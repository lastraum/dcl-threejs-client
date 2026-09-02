/** Scene shader / ability name → AbilityManager id (`ice`, `meteor`, `hail`). */
export function shaderToVfxId(raw: string): string {
  let key = raw.trim().toLowerCase().replace(/ability$/, '')
  if (key === 'cinder' || key === 'cinder-fall' || key === 'cinderfall') return 'meteor'
  if (key === 'hailwraith') return 'hail'
  return key
}

export function normalizeAbilityVfxId(raw: string): string | null {
  const key = raw.trim().toLowerCase()
  if (!key) return null
  const id = shaderToVfxId(key)
  return id === 'shader' || id === 'texture' || id === 'sync' || id === 'vfx' ? null : id
}

export function isShaderSyncParam(raw: string | undefined): boolean {
  if (!raw) return false
  const s = raw.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'sync'
}

export function parseVec3(raw: string): { x: number; y: number; z: number } | null {
  const parts = raw.split(',').map((s) => Number(s.trim()))
  if (parts.length < 3) return null
  const [x, y, z] = parts
  if (![x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return { x, y, z }
}

export function parseNumber(raw: string): number | null {
  const n = Number(raw.trim())
  return Number.isFinite(n) ? n : null
}
