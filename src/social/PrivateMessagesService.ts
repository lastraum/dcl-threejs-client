import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { Packet } from '@dcl/protocol/out-ts/decentraland/kernel/comms/rfc4/comms.gen'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { LiveKitCommsSession } from '../network/comms/LiveKitCommsSession'
import { TransportType } from '../network/comms/Transport'
import { getPrivateMessagesToken } from '../network/gatekeeper/privateMessages'
import {
  communityChatTopic,
  isMessageRouterIdentity,
  MESSAGE_ROUTER_FALLBACK_IDENTITIES,
  parseCommunityChatTopic
} from './communityChatWire'
import { tryDecodeRfc4ChatPacket } from './dclRfc4Chat'

export type PrivateMessageEvent = {
  fromAddress: string
  text: string
  time: number
}

export type CommunityMessageEvent = {
  communityId: string
  fromAddress: string
  text: string
  time: number
}

/**
 * ADR-208 private chat room — one persistent LiveKit connection for:
 * - 1:1 DMs (RFC4 Chat + destinationIdentities, no topic)
 * - Community group text via **comms-message-sfu**:
 *   dest = message-router-*, topic = `community:{id}`
 */
export class PrivateMessagesService {
  private session: LiveKitCommsSession | null = null
  private connected = false
  private connecting: Promise<boolean> | null = null
  private lastError: string | null = null
  private identity: AuthIdentity | null = null
  private localAddress: string | null = null
  private readonly inbound = new Set<(ev: PrivateMessageEvent) => void>()
  private readonly communityInbound = new Set<(ev: CommunityMessageEvent) => void>()

  subscribe(listener: (ev: PrivateMessageEvent) => void): () => void {
    this.inbound.add(listener)
    return () => {
      this.inbound.delete(listener)
    }
  }

  subscribeCommunity(listener: (ev: CommunityMessageEvent) => void): () => void {
    this.communityInbound.add(listener)
    return () => {
      this.communityInbound.delete(listener)
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  isConnecting(): boolean {
    return this.connecting != null
  }

  getLastError(): string | null {
    return this.lastError
  }

  async connect(identity: AuthIdentity, localAddress: string): Promise<boolean> {
    this.identity = identity
    this.localAddress = localAddress.toLowerCase()
    if (this.connected && this.session) return true
    if (this.connecting) return this.connecting

    this.connecting = this.doConnect()
    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  private async doConnect(): Promise<boolean> {
    if (!this.identity || !this.localAddress) return false
    this.lastError = null

    const token = await getPrivateMessagesToken(this.identity)
    if (!token.ok) {
      this.lastError = token.error
      clientDebugLog.log('social', `Private messages token failed: ${token.error}`, {
        level: 'warn',
        alsoConsole: true
      })
      return false
    }

    this.session?.disconnect()
    const session = new LiveKitCommsSession(TransportType.WebsocketRoom, false)
    session.setLocalAddress(this.localAddress)
    session.setPacketHandler((_transport, address, data) => {
      this.handleDmPacket(address, data)
    })
    session.setTopicHandler((topic, address, data) => {
      this.handleTopicPacket(topic, address, data)
    })

    const ok = await session.connect(token.adapter)
    if (!ok) {
      session.disconnect()
      this.lastError = 'LiveKit connect failed'
      clientDebugLog.log('social', 'Private messages LiveKit connect failed', {
        level: 'error',
        alsoConsole: true
      })
      return false
    }

    this.session = session
    this.connected = true
    this.lastError = null
    const remotes = session.getRemoteParticipantIdentities()
    const routers = remotes.filter(isMessageRouterIdentity)
    clientDebugLog.log(
      'social',
      `Private messages room connected · remotes=${remotes.length} routers=${routers.join(',') || 'none yet'}`,
      { level: 'success', alsoConsole: true }
    )
    return true
  }

  private handleDmPacket(address: string, data: Uint8Array): void {
    // SFU / community traffic always uses a topic — bare packets are 1:1 DMs.
    if (isMessageRouterIdentity(address)) return
    const chat = tryDecodeRfc4ChatPacket(data)
    if (chat.kind !== 'chat') return
    const from = address.trim().toLowerCase()
    if (!from || from === this.localAddress) return
    const text = chat.text.trim()
    if (!text) return
    const time = typeof chat.time === 'number' && Number.isFinite(chat.time) ? chat.time : Date.now() / 1000
    const ev: PrivateMessageEvent = { fromAddress: from, text, time }
    for (const listener of this.inbound) listener(ev)
  }

  private handleTopicPacket(topic: string, address: string, data: Uint8Array): void {
    const communityId = parseCommunityChatTopic(topic)
    if (!communityId) return
    const chat = tryDecodeRfc4ChatPacket(data)
    if (chat.kind !== 'chat') return
    // SFU re-publish: participant is often message-router-*; original wallet is forwardedFrom.
    const fromRaw =
      extractForwardedFrom(data) ??
      (isMessageRouterIdentity(address) ? null : address.trim().toLowerCase())
    let from = fromRaw?.trim().toLowerCase() ?? ''
    // Still surface the line if SFU omitted forwardedFrom (show as community member).
    if (!from && isMessageRouterIdentity(address)) from = 'community'
    if (!from || from === this.localAddress) return
    const text = chat.text.trim()
    if (!text) return
    const time = typeof chat.time === 'number' && Number.isFinite(chat.time) ? chat.time : Date.now() / 1000
    const ev: CommunityMessageEvent = { communityId, fromAddress: from, text, time }
    for (const listener of this.communityInbound) listener(ev)
  }

  async sendTo(peerAddress: string, text: string): Promise<boolean> {
    const dest = peerAddress.trim().toLowerCase()
    const trimmed = text.trim()
    if (!dest || !trimmed || !this.session || !this.connected) return false
    return this.session.publishChatTo(trimmed, [dest])
  }

  /**
   * Community group text — route through comms-message-sfu (Explorer parity).
   * Client does **not** fan-out to members; the SFU resolves recipients.
   */
  async sendToCommunity(communityId: string, text: string): Promise<boolean> {
    const id = communityId.trim().toLowerCase()
    const trimmed = text.trim()
    if (!id || !trimmed || !this.session || !this.connected) return false

    const routers = this.resolveMessageRouters()
    if (routers.length === 0) {
      this.lastError = 'message router SFU not in room'
      clientDebugLog.log(
        'social',
        'Community chat: no message-router participant — is the SFU in this LiveKit room?',
        { level: 'warn', alsoConsole: true }
      )
      return false
    }

    const topic = communityChatTopic(id)
    const ok = await this.session.publishChatTo(trimmed, routers, topic)
    if (ok) {
      clientDebugLog.log(
        'social',
        `Community chat → SFU ${routers.join(',')} topic=${topic}`,
        { level: 'success', alsoConsole: true }
      )
    }
    return ok
  }

  /** Prefer live SFU identities; fall back to default replica names. */
  private resolveMessageRouters(): string[] {
    if (!this.session) return []
    const live = this.session.getRemoteParticipantIdentities().filter(isMessageRouterIdentity)
    if (live.length > 0) return live
    // SFU may not appear in remotes until after join; still try well-known identities.
    return [...MESSAGE_ROUTER_FALLBACK_IDENTITIES]
  }

  disconnect(): void {
    this.connected = false
    this.lastError = null
    this.session?.disconnect()
    this.session = null
    this.identity = null
    this.localAddress = null
  }
}

/**
 * SFU sets Chat.forwardedFrom (field 3) — not in our published @dcl/protocol Chat type yet.
 * Walk the outer Packet manually for message case chat → field 3 string.
 */
function extractForwardedFrom(data: Uint8Array): string | null {
  try {
    // Prefer typed decode if the field appears on newer protocol packages.
    const p = Packet.decode(data)
    if (p.message?.$case === 'chat' && p.message.chat) {
      const chat = p.message.chat as { forwardedFrom?: unknown }
      if (typeof chat.forwardedFrom === 'string' && chat.forwardedFrom.trim()) {
        return chat.forwardedFrom.trim().toLowerCase()
      }
    }
  } catch {
    /* fall through to raw scan */
  }
  return extractForwardedFromRaw(data)
}

/** Minimal protobuf scan: Packet.message chat (field 10 oneof) → Chat.forwardedFrom field 3. */
function extractForwardedFromRaw(data: Uint8Array): string | null {
  try {
    let i = 0
    const len = data.length
    while (i < len) {
      const key = data[i++]
      if (key === undefined) break
      const field = key >>> 3
      const wire = key & 7
      if (wire === 2) {
        // length-delimited
        let l = 0
        let shift = 0
        for (;;) {
          const b = data[i++]
          if (b === undefined) return null
          l |= (b & 0x7f) << shift
          if ((b & 0x80) === 0) break
          shift += 7
        }
        const slice = data.subarray(i, i + l)
        i += l
        // Packet.message oneof field numbers vary; scan nested Chat for field 3 string.
        const nested = readStringField(slice, 3)
        if (nested) return nested.toLowerCase()
      } else if (wire === 0) {
        while (i < len && (data[i++]! & 0x80) !== 0) {
          /* skip varint */
        }
      } else if (wire === 1) {
        i += 8
      } else if (wire === 5) {
        i += 4
      } else {
        break
      }
      // Heuristic: if field looks like nested chat body, already tried above.
      void field
    }
  } catch {
    /* ignore */
  }
  return null
}

function readStringField(buf: Uint8Array, wantField: number): string | null {
  let i = 0
  while (i < buf.length) {
    const key = buf[i++]
    if (key === undefined) break
    const field = key >>> 3
    const wire = key & 7
    if (wire === 2) {
      let l = 0
      let shift = 0
      for (;;) {
        const b = buf[i++]
        if (b === undefined) return null
        l |= (b & 0x7f) << shift
        if ((b & 0x80) === 0) break
        shift += 7
      }
      const slice = buf.subarray(i, i + l)
      i += l
      if (field === wantField) {
        try {
          return new TextDecoder().decode(slice).trim() || null
        } catch {
          return null
        }
      }
    } else if (wire === 0) {
      while (i < buf.length && (buf[i++]! & 0x80) !== 0) {
        /* skip */
      }
    } else if (wire === 1) {
      i += 8
    } else if (wire === 5) {
      i += 4
    } else {
      break
    }
  }
  return null
}
