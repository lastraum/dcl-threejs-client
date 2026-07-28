/**
 * Loot Bag claim announcements over the private-messages LiveKit room.
 *
 * Same pattern as Community Follow/Tour:
 * - non-chat reliable data
 * - room broadcast topic (not SFU community chat)
 * - reaches peers in the PM room across any scene
 *
 * Topic: `d3js-lootbag:claims`
 * Magic: ASCII "D3G1"
 */

/** LiveKit data topic for pool claim toasts (PM room). */
export const POOL_CLAIM_TOPIC = 'd3js-lootbag:claims'

/** Binary payload magic: ASCII "D3G1" */
export const POOL_CLAIM_DATA_MAGIC = new Uint8Array([0x44, 0x33, 0x47, 0x31])

export type PoolClaimWireMsg = {
  t: 'claim'
  /** Claimer wallet (lowercase). */
  a: string
  /** Optional claimer display name. */
  n?: string
  /** Position id. */
  p: number
  /** Short label e.g. "Token #12" / "MANA Pack". */
  l: string
  /** Unix ms. */
  at: number
  /** Demo / fake claim (no chain). */
  demo?: boolean
  /** Prize thumbnail URL. */
  img?: string
  /** Wearable rarity (common…mythic) or pack. */
  r?: string
  /** Issue # when known. */
  issue?: string
  /** Item display name. */
  name?: string
  /** Prize kind. */
  k?: 'nft' | 'pack'
  /**
   * Formatted mMANA amount:
   * - pack keep → prize in the pack
   * - take tokens → backing / net MANA received
   */
  mana?: string
  /** Settle outcome. */
  out?: 'keep' | 'take'
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
  const img = typeof o.img === 'string' && o.img.trim() ? o.img.trim().slice(0, 512) : undefined
  const r = typeof o.r === 'string' && o.r.trim() ? o.r.trim().toLowerCase().slice(0, 24) : undefined
  const issue =
    typeof o.issue === 'string' && o.issue.trim()
      ? o.issue.trim().slice(0, 24)
      : typeof o.i === 'string' && o.i.trim()
        ? o.i.trim().slice(0, 24)
        : undefined
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : undefined
  const k = o.k === 'pack' || o.k === 'nft' ? o.k : undefined
  const mana =
    typeof o.mana === 'string' && o.mana.trim()
      ? o.mana.trim().slice(0, 32)
      : typeof o.m === 'string' && o.m.trim()
        ? o.m.trim().slice(0, 32)
        : undefined
  const out = o.out === 'keep' || o.out === 'take' ? o.out : undefined
  return { t: 'claim', a, p, l, at, n, demo, img, r, issue, name, k, mana, out }
}
