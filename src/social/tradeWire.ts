/**
 * P2P trade session wire — private-messages LiveKit room.
 *
 * Topic: `d3js-trade`
 * Magic: ASCII "D3TR"
 *
 * Directed to the counterparty when possible (destinationIdentities).
 * Message always includes recipient `to` so broadcast fallbacks are filterable.
 */

export const TRADE_TOPIC = 'd3js-trade'

/** Binary payload magic: ASCII "D3TR" */
export const TRADE_DATA_MAGIC = new Uint8Array([0x44, 0x33, 0x54, 0x52])

/**
 * Invite TTL — long enough for production “did you get it?” chat + accept.
 * (Was 20s; mutual invites + slow UI made that too short.)
 */
export const TRADE_INVITE_TTL_MS = 60_000

export type TradeItemWire = {
  /** Wearable / emote asset URN (or contract+token key). */
  urn: string
  /** Display name. */
  name?: string
  /** Thumbnail URL. */
  img?: string
  /** Rarity label. */
  r?: string
  /** Collection contract (optional, for on-chain later). */
  c?: string
  /** Token id (optional). */
  tid?: string
  /** Mint / issue number (display). */
  issue?: string
  /** Rarity max supply (display). */
  max?: string
}

export type TradeOfferSnapshot = {
  items: TradeItemWire[]
  /** MANA amount in whole tokens (not wei) for UI; on-chain later. */
  mana: number
  locked: boolean
  /** Both-sides ready for settle. */
  accepted: boolean
}

export type TradeWireMsg =
  | {
      t: 'invite'
      /** Session id (uuid). */
      id: string
      /** Inviter wallet. */
      from: string
      /** Invitee wallet. */
      to: string
      /** Display name of inviter. */
      n?: string
      /** Expiry unix ms. */
      exp: number
      at: number
    }
  | {
      t: 'invite_accept' | 'invite_decline' | 'invite_cancel' | 'trade_cancel'
      id: string
      from: string
      to: string
      at: number
    }
  | {
      t: 'offer'
      id: string
      from: string
      to: string
      offer: TradeOfferSnapshot
      at: number
    }
  | {
      t: 'trade_complete'
      id: string
      from: string
      to: string
      at: number
      /** Settle tx hash when on-chain. */
      tx?: string
    }
  | {
      /** Inviter signed EIP-712 Trade — invitee must call accept(). */
      t: 'settle_sign'
      id: string
      from: string
      to: string
      at: number
      /** JSON SettleSignPayload */
      payload: unknown
    }
  | {
      t: 'settle_fail'
      id: string
      from: string
      to: string
      at: number
      /** Error message for peer toast. */
      err: string
    }

export function encodeTradeDataPacket(msg: TradeWireMsg): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg))
  const out = new Uint8Array(TRADE_DATA_MAGIC.length + json.length)
  out.set(TRADE_DATA_MAGIC, 0)
  out.set(json, TRADE_DATA_MAGIC.length)
  return out
}

export function tryParseTradeDataPacket(data: Uint8Array): TradeWireMsg | null {
  if (data.length < TRADE_DATA_MAGIC.length + 2) return null
  for (let i = 0; i < TRADE_DATA_MAGIC.length; i++) {
    if (data[i] !== TRADE_DATA_MAGIC[i]) return null
  }
  try {
    const json = new TextDecoder().decode(data.subarray(TRADE_DATA_MAGIC.length))
    return parseTradeObject(JSON.parse(json) as Record<string, unknown>)
  } catch {
    return null
  }
}

export function isTradeTopic(topic: string | undefined | null): boolean {
  return (topic?.trim().toLowerCase() ?? '') === TRADE_TOPIC
}

function isAddr(v: unknown): v is string {
  return typeof v === 'string' && /^0x[a-f0-9]{40}$/.test(v.trim().toLowerCase())
}

function parseItem(raw: unknown): TradeItemWire | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const urn = typeof o.urn === 'string' ? o.urn.trim() : ''
  if (!urn) return null
  return {
    urn: urn.slice(0, 256),
    name: typeof o.name === 'string' ? o.name.trim().slice(0, 80) : undefined,
    img: typeof o.img === 'string' ? o.img.trim().slice(0, 512) : undefined,
    r: typeof o.r === 'string' ? o.r.trim().toLowerCase().slice(0, 24) : undefined,
    c: typeof o.c === 'string' ? o.c.trim().toLowerCase().slice(0, 66) : undefined,
    // uint256 decimal max length is 78; keep headroom for whitespace-trimmed ids.
    tid: typeof o.tid === 'string' ? o.tid.trim().slice(0, 80) : undefined,
    issue:
      typeof o.issue === 'string'
        ? o.issue.trim().slice(0, 32)
        : typeof o.i === 'string'
          ? o.i.trim().slice(0, 32)
          : undefined,
    max:
      typeof o.max === 'string'
        ? o.max.trim().slice(0, 16)
        : typeof o.m === 'string'
          ? o.m.trim().slice(0, 16)
          : undefined
  }
}

function parseOffer(raw: unknown): TradeOfferSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const itemsRaw = Array.isArray(o.items) ? o.items : []
  const items: TradeItemWire[] = []
  for (const it of itemsRaw.slice(0, 24)) {
    const p = parseItem(it)
    if (p) items.push(p)
  }
  const mana =
    typeof o.mana === 'number' && Number.isFinite(o.mana) && o.mana >= 0
      ? Math.min(1_000_000_000, Math.floor(o.mana))
      : 0
  return {
    items,
    mana,
    locked: o.locked === true,
    accepted: o.accepted === true
  }
}

function parseTradeObject(o: Record<string, unknown>): TradeWireMsg | null {
  const t = o.t
  const id = typeof o.id === 'string' ? o.id.trim().slice(0, 64) : ''
  const from = typeof o.from === 'string' ? o.from.trim().toLowerCase() : ''
  const to = typeof o.to === 'string' ? o.to.trim().toLowerCase() : ''
  if (!id || !isAddr(from) || !isAddr(to)) return null
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : Date.now()

  if (t === 'invite') {
    const exp =
      typeof o.exp === 'number' && Number.isFinite(o.exp) ? o.exp : at + TRADE_INVITE_TTL_MS
    const n = typeof o.n === 'string' && o.n.trim() ? o.n.trim().slice(0, 48) : undefined
    return { t: 'invite', id, from, to, exp, at, n }
  }

  if (
    t === 'invite_accept' ||
    t === 'invite_decline' ||
    t === 'invite_cancel' ||
    t === 'trade_cancel'
  ) {
    return { t, id, from, to, at }
  }

  if (t === 'offer') {
    const offer = parseOffer(o.offer)
    if (!offer) return null
    return { t: 'offer', id, from, to, offer, at }
  }

  if (t === 'trade_complete') {
    const tx = typeof o.tx === 'string' && o.tx.trim() ? o.tx.trim().slice(0, 80) : undefined
    return { t: 'trade_complete', id, from, to, at, tx }
  }

  if (t === 'settle_sign') {
    if (o.payload == null || typeof o.payload !== 'object') return null
    return { t: 'settle_sign', id, from, to, at, payload: o.payload }
  }

  if (t === 'settle_fail') {
    const err =
      typeof o.err === 'string' && o.err.trim()
        ? o.err.trim().slice(0, 240)
        : 'Settlement failed'
    return { t: 'settle_fail', id, from, to, at, err }
  }

  return null
}

export function newTradeSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function emptyOffer(): TradeOfferSnapshot {
  return { items: [], mana: 0, locked: false, accepted: false }
}
