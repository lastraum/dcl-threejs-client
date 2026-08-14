/**
 * Global Live directory over the private-messages LiveKit room.
 *
 * Same control-plane class as Community Follow/Tour and Loot Bag claims:
 * - non-chat reliable data
 * - room broadcast on a fixed topic (not per-community, not scene LiveKit)
 * - always-on once PM is warmed (SocialService init / initShell)
 *
 * Topic: `d3js-live`
 * Magic: ASCII "D3L1"
 *
 * Payload is discovery only — no publish stream keys, no keyframe/pose, no tokens.
 */

/** LiveKit data topic for global live directory (PM room). */
export const GLOBAL_LIVE_TOPIC = 'd3js-live'

/** Binary payload magic: ASCII "D3L1" */
export const GLOBAL_LIVE_DATA_MAGIC = new Uint8Array([0x44, 0x33, 0x4c, 0x31])

/** Heartbeat interval while broadcasting (ms). */
export const GLOBAL_LIVE_HEARTBEAT_MS = 8_000
/** Drop session if no hb for this long (~2.5 intervals). */
export const GLOBAL_LIVE_TTL_MS = 22_000
/** Sweep stale rows. */
export const GLOBAL_LIVE_SWEEP_MS = 4_000

/**
 * Viewer-facing media pointer.
 * - `hls` / `http`: absolute https URL (playable in DOM video)
 * - `dcl-cast`: DCL world/parcel OBS ingress — viewers join scene LiveKit for that place
 * - Publish RTMP keys stay local to the broadcaster — never on the wire.
 */
export type GlobalLiveMedia =
  | { type: 'hls'; url: string }
  | { type: 'http'; url: string }
  | { type: 'dcl-cast'; worldName: string }

export type GlobalLiveWireMsg =
  | {
      t: 'start' | 'hb'
      /** Session id (uuid). */
      s: string
      /** Host wallet (lowercase). */
      a: string
      /** Display name. */
      n: string
      /** Unix ms. */
      at: number
      /** Playable media. */
      m: GlobalLiveMedia
      /** Optional stream title. */
      title?: string
    }
  | {
      t: 'stop'
      s: string
      a: string
      at: number
    }

export type LiveSession = {
  sessionId: string
  hostAddress: string
  displayName: string
  title: string
  media: GlobalLiveMedia
  /** Last hb / start time. */
  lastSeenAt: number
  /** True when this client is the broadcaster. */
  isSelf: boolean
}

export function encodeGlobalLiveDataPacket(msg: GlobalLiveWireMsg): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg))
  const out = new Uint8Array(GLOBAL_LIVE_DATA_MAGIC.length + json.length)
  out.set(GLOBAL_LIVE_DATA_MAGIC, 0)
  out.set(json, GLOBAL_LIVE_DATA_MAGIC.length)
  return out
}

export function tryParseGlobalLiveDataPacket(data: Uint8Array): GlobalLiveWireMsg | null {
  if (data.length < GLOBAL_LIVE_DATA_MAGIC.length + 2) return null
  for (let i = 0; i < GLOBAL_LIVE_DATA_MAGIC.length; i++) {
    if (data[i] !== GLOBAL_LIVE_DATA_MAGIC[i]) return null
  }
  try {
    const json = new TextDecoder().decode(data.subarray(GLOBAL_LIVE_DATA_MAGIC.length))
    return parseGlobalLiveObject(JSON.parse(json) as Record<string, unknown>)
  } catch {
    return null
  }
}

export function isGlobalLiveTopic(topic: string | undefined | null): boolean {
  return (topic?.trim().toLowerCase() ?? '') === GLOBAL_LIVE_TOPIC
}

export function parseMediaFromPlayUrl(raw: string): GlobalLiveMedia | null {
  const url = raw.trim()
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  // Prefer https in product; allow http for local/dev.
  const path = parsed.pathname.toLowerCase()
  const q = parsed.search.toLowerCase()
  if (path.endsWith('.m3u8') || q.includes('m3u8') || q.includes('format=m3u8')) {
    return { type: 'hls', url: parsed.toString() }
  }
  return { type: 'http', url: parsed.toString() }
}

function parseGlobalLiveObject(o: Record<string, unknown>): GlobalLiveWireMsg | null {
  const t = o.t
  if (t !== 'start' && t !== 'hb' && t !== 'stop') return null
  const s = typeof o.s === 'string' && o.s.trim() ? o.s.trim().slice(0, 64) : ''
  const a = typeof o.a === 'string' ? o.a.trim().toLowerCase() : ''
  if (!s || !/^0x[a-f0-9]{40}$/.test(a)) return null
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : Date.now()
  if (t === 'stop') return { t: 'stop', s, a, at }

  const n =
    typeof o.n === 'string' && o.n.trim() ? o.n.trim().slice(0, 48) : shortWallet(a)
  const title =
    typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 80) : undefined
  const m = parseMediaField(o.m)
  if (!m) return null
  return { t, s, a, n, at, m, title }
}

function parseMediaField(raw: unknown): GlobalLiveMedia | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const type = m.type
  if (type === 'dcl-cast') {
    const worldName =
      typeof m.worldName === 'string'
        ? m.worldName.trim()
        : typeof m.w === 'string'
          ? m.w.trim()
          : ''
    if (!worldName || worldName.length > 128) return null
    // Normalize bare labels to .dcl.eth (parcels like "0,0" stay as-is).
    if (/^-?\d+\s*,\s*-?\d+$/.test(worldName)) {
      return { type: 'dcl-cast', worldName: worldName.replace(/\s+/g, '') }
    }
    const name = worldName.includes('.') ? worldName : `${worldName}.dcl.eth`
    return { type: 'dcl-cast', worldName: name.toLowerCase() }
  }
  const url = typeof m.url === 'string' ? m.url.trim() : ''
  if (!url || url.length > 1024) return null
  if (type === 'hls' || type === 'http') {
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
      return { type, url: u.toString() }
    } catch {
      return null
    }
  }
  return null
}

function shortWallet(a: string): string {
  if (a.length < 10) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
