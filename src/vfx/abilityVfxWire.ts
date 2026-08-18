/**
 * Ephemeral ability VFX — comms topic, not CRDT / not syncEntity.
 * CRDT is lasting ECS state; a cast is a one-shot event.
 * Opt in from the scene with a sibling `tjs.sync` Tag. Default is local-only.
 * Preview mini-comms (RFC-5) carries the same topic as LiveKit rooms.
 */
export const ABILITY_VFX_TOPIC = 'd3js-ability-vfx'

export type AbilityVfxCastMsg = {
  id: string
  /** DCL world metres (start). */
  ox: number
  oy: number
  oz: number
  dx: number
  dy: number
  dz: number
  range: number
}

export function encodeAbilityVfxCast(msg: AbilityVfxCastMsg): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg))
}

export function decodeAbilityVfxCast(data: Uint8Array): AbilityVfxCastMsg | null {
  try {
    const raw = JSON.parse(new TextDecoder().decode(data)) as Partial<AbilityVfxCastMsg>
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) return null
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return {
      id: raw.id.trim(),
      ox: n(raw.ox),
      oy: n(raw.oy),
      oz: n(raw.oz),
      dx: n(raw.dx),
      dy: n(raw.dy),
      dz: n(raw.dz),
      range: n(raw.range) || 16
    }
  } catch {
    return null
  }
}
