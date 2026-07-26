/**
 * Grab bag claim announcements over the private-messages LiveKit room.
 *
 * Same pattern as Community Follow/Tour:
 * - non-chat reliable data
 * - room broadcast topic (not SFU community chat)
 * - reaches peers in the PM room across any scene
 *
 * Topic: `d3js-gacha:claims`
 * Magic: ASCII "D3G1"
 */

/** LiveKit data topic for pool claim toasts (PM room). */
export const POOL_CLAIM_TOPIC = 'd3js-gacha:claims'

/** Binary payload magic: ASCII "D3G1" */
export const POOL_CLAIM_DATA_MAGIC = new Uint8Array([0x44, 0x33, 0x47, 0x31])

export type PoolClaimWireMsg = {
  t: 'claim'
  /** Claimer wallet (lowercase). */
  a: string
  /** Optional display name. */
  n?: string
  /** Position id. */
  p: number
  /** Short label e.g. "Token #12" / "MANA Pack". */
  l: string
  /** Unix ms. */
  at: number
  /** Demo / fake claim (no chain). */
  demo?: boolean
}

export function encodePoolClaimDataPacket(msg: PoolClaimWireMsg): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg))
  const out = new Uint8Array(POOL_CLAIM_DATA_MAGIC.length + json.length)
  out.set(POOL_CLAIM_DATA_MAGIC, 0)
  out.set(json, POOL_CLAIM_DATA_MAGIC.length)
  return out
}

export function tryParsePoolClaimDataPacket(data: Uint8Array): PoolClaimWireMsg | null {
  if (data.length < POOL_CLAIM_DATA_MAGIC.length + 2) return null
  for (let i = 0; i < POOL_CLAIM_DATA_MAGIC.length; i++) {
    if (data[i] !== POOL_CLAIM_DATA_MAGIC[i]) return null
  }
  try {
    const json = new TextDecoder().decode(data.subarray(POOL_CLAIM_DATA_MAGIC.length))
    return parsePoolClaimObject(JSON.parse(json) as Record<string, unknown>)
  } catch {
    return null
  }
}

export function isPoolClaimTopic(topic: string | undefined | null): boolean {
  return (topic?.trim().toLowerCase() ?? '') === POOL_CLAIM_TOPIC
}

function parsePoolClaimObject(o: Record<string, unknown>): PoolClaimWireMsg | null {
  if (o.t !== 'claim') return null
  const a = typeof o.a === 'string' ? o.a.trim().toLowerCase() : ''
  if (!/^0x[a-f0-9]{40}$/.test(a)) return null
  const p = typeof o.p === 'number' && Number.isFinite(o.p) ? Math.floor(o.p) : NaN
  if (!Number.isFinite(p) || p < 1) return null
  const l = typeof o.l === 'string' && o.l.trim() ? o.l.trim().slice(0, 80) : `pos ${p}`
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : Date.now()
  const n = typeof o.n === 'string' && o.n.trim() ? o.n.trim().slice(0, 48) : undefined
  const demo = o.demo === true
  return { t: 'claim', a, p, l, at, n, demo }
}
