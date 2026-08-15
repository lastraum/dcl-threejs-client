/**
 * Host-only VFX tag contract (`tjs.vfx:*`).
 * Scenes author stock SDK7 Tags; this client plays the pack. Official Explorer ignores these.
 */

export const VFX_TAG_PREFIX = 'tjs.vfx'
export const VFX_ID_TAG = 'tjs.vfx:'
export const VFX_CAST_SHORTHAND = 'tjs.vfx.cast:'
export const VFX_OFF_TAG = 'tjs.vfx.off'

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
const KV_RE = /^tjs\.vfx\.(mode|range|speed|intensity|cooldown):(.+)$/

export type VfxMode = 'loop' | 'cast'

export type VfxSpec = {
  id: string
  mode: VfxMode
  range?: number
  speed?: number
  intensity?: number
  cooldown?: number
}

function clampFinite(n: number, min: number, max: number): number | undefined {
  if (!Number.isFinite(n)) return undefined
  return Math.min(max, Math.max(min, n))
}

function normalizeId(raw: string): string | undefined {
  const id = raw.trim().toLowerCase()
  return ID_RE.test(id) ? id : undefined
}

/** Closed allowlist parser. Unknown keys are ignored. `tjs.vfx.off` wins. */
export function parseVfxTags(tags: readonly string[]): VfxSpec | null {
  if (!tags.length) return null
  if (tags.includes(VFX_OFF_TAG)) return null

  let id: string | undefined
  let mode: VfxMode = 'loop'
  let range: number | undefined
  let speed: number | undefined
  let intensity: number | undefined
  let cooldown: number | undefined

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
    // Bare id `tjs.vfx:ice` — not `tjs.vfx.range:18`.
    if (raw.startsWith(VFX_ID_TAG) && !raw.startsWith('tjs.vfx.')) {
      const parsed = normalizeId(raw.slice(VFX_ID_TAG.length))
      if (parsed) id = parsed
      continue
    }
    const kv = KV_RE.exec(raw)
    if (!kv) continue
    const key = kv[1]!
    const val = kv[2]!
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
  const out: VfxSpec = { id, mode }
  if (range !== undefined) out.range = range
  if (speed !== undefined) out.speed = speed
  if (intensity !== undefined) out.intensity = intensity
  if (cooldown !== undefined) out.cooldown = cooldown
  return out
}

export function vfxSpecSignature(spec: VfxSpec): string {
  return [
    spec.id,
    spec.mode,
    spec.range ?? '',
    spec.speed ?? '',
    spec.intensity ?? '',
    spec.cooldown ?? ''
  ].join('|')
}

export function tagsHaveVfxPrefix(tags: readonly string[]): boolean {
  for (const raw of tags) {
    if (typeof raw === 'string' && raw.startsWith(VFX_TAG_PREFIX)) return true
  }
  return false
}
