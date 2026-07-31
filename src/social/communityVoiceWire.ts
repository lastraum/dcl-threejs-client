/**
 * Community voice started/ended over the private-messages LiveKit room.
 *
 * Social Service WS (SubscribeToCommunityVoiceChatUpdates) is the Explorer path
 * but often drops guests / flaps transport. PM room already has every signed-in
 * peer (wallet + guest) — room-broadcast like pool claims for instant discovery.
 *
 * Topic: `d3js-community-voice`
 * Magic: ASCII "D3V1"
 */

export const COMMUNITY_VOICE_SIGNAL_TOPIC = 'd3js-community-voice'

/** Binary payload magic: ASCII "D3V1" */
export const COMMUNITY_VOICE_SIGNAL_MAGIC = new Uint8Array([0x44, 0x33, 0x56, 0x31])

export type CommunityVoiceSignalMsg = {
  t: 'voice'
  /** started | ended */
  s: 'started' | 'ended'
  /** Community id */
  c: string
  /** Community display name */
  n?: string
  /** Thumbnail URL */
  img?: string
  /** Starter wallet */
  a?: string
  /** Unix ms */
  at: number
}

export function encodeCommunityVoiceSignalPacket(msg: CommunityVoiceSignalMsg): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg))
  const out = new Uint8Array(COMMUNITY_VOICE_SIGNAL_MAGIC.length + json.length)
  out.set(COMMUNITY_VOICE_SIGNAL_MAGIC, 0)
  out.set(json, COMMUNITY_VOICE_SIGNAL_MAGIC.length)
  return out
}

export function tryParseCommunityVoiceSignalPacket(data: Uint8Array): CommunityVoiceSignalMsg | null {
  if (data.length < COMMUNITY_VOICE_SIGNAL_MAGIC.length + 2) return null
  for (let i = 0; i < COMMUNITY_VOICE_SIGNAL_MAGIC.length; i++) {
    if (data[i] !== COMMUNITY_VOICE_SIGNAL_MAGIC[i]) return null
  }
  try {
    const json = new TextDecoder().decode(data.subarray(COMMUNITY_VOICE_SIGNAL_MAGIC.length))
    return parseVoiceSignalObject(JSON.parse(json) as Record<string, unknown>)
  } catch {
    return null
  }
}

export function isCommunityVoiceSignalTopic(topic: string | undefined | null): boolean {
  return (topic?.trim().toLowerCase() ?? '') === COMMUNITY_VOICE_SIGNAL_TOPIC
}

function parseVoiceSignalObject(o: Record<string, unknown>): CommunityVoiceSignalMsg | null {
  if (o.t !== 'voice') return null
  const s = o.s === 'started' || o.s === 'ended' ? o.s : null
  const c = typeof o.c === 'string' ? o.c.trim() : ''
  if (!s || !c) return null
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : Date.now()
  return {
    t: 'voice',
    s,
    c,
    n: typeof o.n === 'string' ? o.n.trim() : undefined,
    img: typeof o.img === 'string' ? o.img.trim() : undefined,
    a: typeof o.a === 'string' ? o.a.trim().toLowerCase() : undefined,
    at
  }
}
