/**
 * LiveKit scene chat — RFC4 Chat packet encode/decode.
 *
 * Godot Explorer `send_chat` uses OLE Automation dates for `Chat.timestamp`
 * (`unix_seconds / 86400 + 25569`) — not unix seconds. Unix values look like
 * invalid OLE days and Explorer drops the message (publish still "succeeds").
 *
 * @see https://github.com/decentraland/godot-explorer/blob/main/lib/src/comms/communication_manager.rs
 *      `ole_timestamp_now` / `send_chat`
 */
import { Packet } from '@dcl/protocol/out-ts/decentraland/kernel/comms/rfc4/comms.gen'
import { RFC4_PROTOCOL_VERSION } from '../network/comms/dclRfc4Comms'

const COMPANION_RFC4_PACKET_PROTOCOL_VERSION = 100

/** Days from 1899-12-30 to 1970-01-01 (Excel / OLE Automation epoch). */
const OLE_UNIX_EPOCH_DAYS = 25569

/** Session-relative values are well below OLE dates (~46k) and unix (~1e9). */
const SESSION_ELAPSED_MAX_SEC = 604_800

/** OLE Automation date (Godot Explorer chat timestamp). */
export function oleTimestampNow(): number {
  return Date.now() / 1000 / 86400 + OLE_UNIX_EPOCH_DAYS
}

export function oleTimestampToUnixSeconds(ole: number): number {
  return (ole - OLE_UNIX_EPOCH_DAYS) * 86400
}

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

/**
 * Outbound chat for Explorer interop.
 * @param timestamp — OLE date (default `oleTimestampNow()`). Pass session-elapsed only for legacy tests.
 */
export function encodeRfc4ChatPacket(text: string, timestamp?: number): Uint8Array {
  const ts =
    timestamp != null && Number.isFinite(timestamp) && timestamp > 0
      ? timestamp
      : oleTimestampNow()
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

/** Legacy companion encode — session elapsed + trailing protocol field. */
export function encodeRfc4ChatPacketCompanion(
  text: string,
  sessionElapsedSeconds: number
): Uint8Array {
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

/**
 * Interpret inbound `Chat.timestamp` → unix seconds for UI.
 * Handles OLE (Godot), unix sec/ms, and session-elapsed (companion).
 */
export function rfc4ChatTimestampToDisplaySeconds(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return Date.now() / 1000
  // Unix milliseconds
  if (ts > 1e11) return ts / 1000
  // Unix seconds
  if (ts >= 1_000_000_000) return ts
  // OLE Automation (~20k–100k for years 1950–2100)
  if (ts >= 20_000 && ts < 100_000) return oleTimestampToUnixSeconds(ts)
  // Session elapsed (companion / movement-style clocks)
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
