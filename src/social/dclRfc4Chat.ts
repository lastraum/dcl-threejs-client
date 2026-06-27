/**
 * LiveKit scene chat — RFC4 Chat packet encode/decode.
 * Unity Explorer expects unix `Chat.timestamp` + `protocol_version` on the Packet (Bevy RFC4).
 * dcl-companion historically used session-elapsed + trailing protocol suffix; we still decode both.
 */
import { Packet } from '@dcl/protocol/out-ts/decentraland/kernel/comms/rfc4/comms.gen'
import { RFC4_PROTOCOL_VERSION } from '../network/comms/dclRfc4Comms'

const COMPANION_RFC4_PACKET_PROTOCOL_VERSION = 100

function encodeVarint32(n: number): Uint8Array {
  const out: number[] = []
  let x = n >>> 0
  while (x > 0x7f) {
    out.push((x & 0x7f) | 0x80)
    x >>>= 7
  }
  out.push(x)
  return Uint8Array.from(out)
}

/** Trailing `protocol_version = 11` suffix — legacy dcl-companion LiveKit chat. */
function appendCompanionRfc4ProtocolVersion(encodedPacket: Uint8Array): Uint8Array {
  const tag = new Uint8Array([(11 << 3) | 0])
  const vi = encodeVarint32(COMPANION_RFC4_PACKET_PROTOCOL_VERSION)
  const out = new Uint8Array(encodedPacket.length + tag.length + vi.length)
  out.set(encodedPacket, 0)
  out.set(tag, encodedPacket.length)
  out.set(vi, encodedPacket.length + tag.length)
  return out
}

/** Outbound chat — unix seconds (Explorer/Unity RFC4). */
export function encodeRfc4ChatPacket(text: string, timestampUnixSec: number): Uint8Array {
  const ts = Number.isFinite(timestampUnixSec) && timestampUnixSec > 0 ? timestampUnixSec : Date.now() / 1000
  return Packet.encode({
    protocolVersion: RFC4_PROTOCOL_VERSION,
    message: {
      $case: 'chat',
      chat: {
        message: text,
        timestamp: ts
      }
    }
  }).finish()
}

/** Legacy companion encode — session elapsed + trailing protocol field (decode-only peers). */
export function encodeRfc4ChatPacketCompanion(text: string, sessionElapsedSeconds: number): Uint8Array {
  const inner = Packet.encode({
    protocolVersion: 0,
    message: {
      $case: 'chat',
      chat: {
        message: text,
        timestamp: sessionElapsedSeconds
      }
    }
  }).finish()
  return appendCompanionRfc4ProtocolVersion(inner)
}

/** Session-relative values are well below unix epoch seconds (~1e9). */
const SESSION_ELAPSED_MAX_SEC = 604_800

/** Interpret inbound `Chat.timestamp` (session elapsed, unix sec, or unix ms). */
export function rfc4ChatTimestampToDisplaySeconds(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return Date.now() / 1000
  if (ts > 1e11) return ts / 1000
  if (ts >= 1_000_000_000) return ts
  if (ts < SESSION_ELAPSED_MAX_SEC) return Date.now() / 1000
  return Date.now() / 1000
}

export type DecodedRfc4Chat =
  | { kind: 'chat'; text: string; time: number }
  | { kind: 'unknown' }

/**
 * Legacy chat emote wire text — Unity/Explorer prefix with ASCII DLE (`\x10`), literal `DLE`,
 * or Unicode control-picture U+2410 (some clients render/store DLE as ␐).
 */
const CHAT_EMOTE_COMMAND_RE = /^(?:DLE|\x10|\u2410)(.+)\s+([\d.]+)\s*$/

/** Loose guard — NFT/profile emote lines that slipped past strict parse. */
const CHAT_EMOTE_LOOSE_RE = /^(?:DLE|\x10|\u2410).+urn:decentraland:/i

export type ParsedChatEmoteCommand = {
  emoteRef: string
  /** Monotonic counter for remote emote deduplication. */
  incrementalId: number
}

/** Some clients broadcast bundled/profile emotes as chat text instead of RFC4 PlayerEmote. */
export function tryParseChatEmoteCommand(text: string): ParsedChatEmoteCommand | null {
  const trimmed = text.trim()
  const match = trimmed.match(CHAT_EMOTE_COMMAND_RE)
  if (!match) return null

  const emoteRef = match[1]?.trim()
  if (!emoteRef) return null

  const timestamp = Number(match[2])
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null

  const incrementalId =
    timestamp > 1e11 ? Math.floor(timestamp) : Math.floor(timestamp * 1000)
  return { emoteRef, incrementalId }
}

/** True when inbound chat text is an emote command — must not appear in the chat panel. */
export function isSceneChatEmoteWireText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (tryParseChatEmoteCommand(trimmed)) return true
  return CHAT_EMOTE_LOOSE_RE.test(trimmed)
}

export function tryDecodeRfc4ChatPacket(buf: Uint8Array): DecodedRfc4Chat {
  try {
    const p = Packet.decode(buf)
    if (p.message?.$case === 'chat') {
      const body = (p.message.chat.message ?? '').trim()
      if (body) {
        return {
          kind: 'chat',
          text: p.message.chat.message,
          time: rfc4ChatTimestampToDisplaySeconds(p.message.chat.timestamp)
        }
      }
    }
  } catch {
    /* not RFC4 Packet */
  }
  return { kind: 'unknown' }
}