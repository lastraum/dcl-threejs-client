import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { Packet } from '@dcl/protocol/out-ts/decentraland/kernel/comms/rfc4/comms.gen'
import { RoomEvent, type Participant } from 'livekit-client'
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
import {
  communityFollowTopic,
  encodeFollowDataPacket,
  parseCommunityFollowTopic,
  tryParseFollowDataPacket,
  type FollowWireMsg
} from './communityFollowWire'
import {
  encodePoolClaimDataPacket,
  isPoolClaimTopic,
  POOL_CLAIM_TOPIC,
  tryParsePoolClaimDataPacket,
  type PoolClaimWireMsg
} from './poolClaimWire'
import { tryDecodeRfc4ChatPacket } from './dclRfc4Chat'

const ETH_ADDRESS_RE = /^0x[a-f0-9]{40}$/

/** Legacy LiveKit topic for 1:1 DMs — `private:{recipientAddress}`. */
export function privateMessageTopic(peerAddress: string): string {
  return `private:${peerAddress.trim().toLowerCase()}`
}

/**
 * Parse 1:1 DM topic → recipient wallet.
 * Explorer / ADR-208 clients use the raw recipient address as the LiveKit topic.
 * Older builds used `private:{address}`.
 */
export function parsePrivateMessageTopic(topic: string): string | null {
  const t = topic.trim().toLowerCase()
  if (!t) return null
  if (ETH_ADDRESS_RE.test(t)) return t
  if (t.startsWith('private:')) {
    const addr = t.slice('private:'.length)
    return ETH_ADDRESS_RE.test(addr) ? addr : null
  }
  return null
}

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

export type CommunityFollowDataEvent = {
  communityId: string
  fromAddress: string
  msg: FollowWireMsg
}

export type PoolClaimDataEvent = {
  fromAddress: string
  msg: PoolClaimWireMsg
}

/**
 * ADR-208 private chat room — one persistent LiveKit connection for:
 * - 1:1 DMs: RFC4 Chat + `destinationIdentities` + topic = recipient wallet (Explorer wire)
 * - Community group text via **comms-message-sfu**:
 *   dest = message-router-*, topic = `community:{id}`
 * - Community Follow/Tour control (non-chat data, topic `d3js-follow:{id}`)
 * - Loot Bag claims (non-chat data, topic `d3js-lootbag:claims`)
 *
 * Inbound 1:1 accepts: topic=`0x…` (to me), topic=`private:{me}`, or bare directed Chat.
 *
 * Module singleton: World.social and 2D SocialChatController both use this so the same
 * wallet does not open two private-messages LiveKit sessions that kick each other.
 */
class PrivateMessagesServiceImpl {
  private session: LiveKitCommsSession | null = null
  private connected = false
  private connecting: Promise<boolean> | null = null
  private lastError: string | null = null
  private identity: AuthIdentity | null = null
  private localAddress: string | null = null
  /** How many SocialService instances currently want the shared room. */
  private holders = 0
  /**
   * AppController play-session hold — keeps PM LiveKit across World rebuilds
   * (teleport / /goto). Released only when leaving 3D play entirely.
   */
  private playSessionHeld = false
  private readonly inbound = new Set<(ev: PrivateMessageEvent) => void>()
  private readonly communityInbound = new Set<(ev: CommunityMessageEvent) => void>()
  private readonly followInbound = new Set<(ev: CommunityFollowDataEvent) => void>()
  private readonly poolClaimInbound = new Set<(ev: PoolClaimDataEvent) => void>()
  /** Dedupe dual-send (directed + topic) and retransmits: key → last unix sec. */
  private readonly recentDmKeys = new Map<string, number>()
  /** Dedupe pool claim rebroadcasts: claimer|pos|at-bucket */
  private readonly recentPoolClaimKeys = new Map<string, number>()

  /** Call when a SocialService wants the shared PM room (init / open DM). */
  retain(): void {
    this.holders++
  }

  /** Call on SocialService.dispose — only tears down LiveKit when last holder leaves. */
  release(): void {
    this.holders = Math.max(0, this.holders - 1)
    if (this.holders === 0) {
      this.forceDisconnect()
    }
  }

  /**
   * Keep the shared PM room alive for the whole 3D play session.
   * Survives World.dispose on teleports; pair with {@link releasePlaySession}.
   */
  retainPlaySession(): void {
    if (this.playSessionHeld) return
    this.playSessionHeld = true
    this.holders++
  }

  /** Leave 3D play / sign-out — allow PM LiveKit to drop when no SocialService holds it. */
  releasePlaySession(): void {
    if (!this.playSessionHeld) return
    this.playSessionHeld = false
    this.release()
  }

  /** True when AppController is holding PM across teleports. */
  isPlaySessionHeld(): boolean {
    return this.playSessionHeld
  }

  /** Debug — active retain count (SocialServices + optional play-session hold). */
  getHolderCount(): number {
    return this.holders
  }

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

  subscribeCommunityFollow(listener: (ev: CommunityFollowDataEvent) => void): () => void {
    this.followInbound.add(listener)
    return () => {
      this.followInbound.delete(listener)
    }
  }

  subscribePoolClaim(listener: (ev: PoolClaimDataEvent) => void): () => void {
    this.poolClaimInbound.add(listener)
    return () => {
      this.poolClaimInbound.delete(listener)
    }
  }

  isConnected(): boolean {
    // LiveKit session can drop while our flag stays true — trust the room state.
    return this.connected && !!this.session?.isConnected()
  }

  isConnecting(): boolean {
    return this.connecting != null
  }

  getLastError(): string | null {
    return this.lastError
  }

  /** Exact LiveKit identities currently in the private-messages room. */
  getRemoteIdentities(): string[] {
    return this.session?.getRemoteParticipantIdentities() ?? []
  }

  /** Case-insensitive: is this wallet currently in the private-messages room? */
  hasPeerInRoom(peerAddress: string): boolean {
    return this.session?.hasRemoteIdentity(peerAddress) ?? false
  }

  async connect(identity: AuthIdentity, localAddress: string): Promise<boolean> {
    this.identity = identity
    this.localAddress = localAddress.toLowerCase()
    if (this.isConnected()) return true
    // Stale flag after room drop — tear down before reconnect.
    if (this.connected || this.session) {
      this.session?.disconnect()
      this.session = null
      this.connected = false
    }
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
    // Bare (no topic) — Explorer directed DMs when destinationIdentities works.
    // If SFU ever mis-broadcasts bare chat, we still surface it (Explorer interop);
    // our outbound path never room-broadcasts private chat.
    session.setPacketHandler((_transport, address, data) => {
      this.handleDmPacket(address, data, 'bare')
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
    // Prefer LiveKit token identity for recipient matching (must match private:{me} topics).
    const roomIdentity = session.getLocalIdentity()
    if (roomIdentity) {
      this.localAddress = roomIdentity
      session.setLocalAddress(roomIdentity)
    }
    this.attachPmReceiveProbe(session)
    const remotes = session.getRemoteParticipantIdentities()
    const routers = remotes.filter(isMessageRouterIdentity)
    clientDebugLog.log(
      'social',
      `Private messages room connected · me=${(this.localAddress ?? '').slice(0, 12)}… remotes=${remotes.length} routers=${routers.join(',') || 'none yet'}`,
      { level: 'success', alsoConsole: true }
    )
    return true
  }

  /**
   * Diagnostics: log inbound chat / private: / bare packets on the private-messages room
   * so we can tell “packet never arrived” vs “filtered after receive”.
   */
  private attachPmReceiveProbe(session: LiveKitCommsSession): void {
    const room = session.getRoom()
    if (!room) return
    room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: Participant, _kind?: unknown, topic?: string) => {
        if (participant?.isLocal) return
        const from = (participant?.identity ?? '').trim().toLowerCase()
        const topicTrim = topic?.trim() ?? ''
        const chat = tryDecodeRfc4ChatPacket(payload)
        const isChat = chat.kind === 'chat'
        // Always log chat / private: / bare / pool claims; skip noisy non-chat SFU topics.
        const interesting =
          isChat ||
          topicTrim.startsWith('private:') ||
          !topicTrim ||
          isPoolClaimTopic(topicTrim) ||
          topicTrim.startsWith('d3js-')
        if (!interesting) return
        clientDebugLog.log(
          'social',
          `PM DataReceived from=${from ? from.slice(0, 12) + '…' : '∅'} topic=${topicTrim ? topicTrim.slice(0, 36) : '∅'} chat=${isChat} len=${payload.byteLength}`,
          {
            level: 'info',
            alsoConsole: true,
            throttleMs: isChat || topicTrim.startsWith('private:') ? 0 : 2000,
            throttleKey: `pm-rx:${from}:${topicTrim.slice(0, 20)}`
          }
        )
      }
    )
  }

  private selfAddress(): string {
    const fromRoom = this.session?.getLocalIdentity()?.toLowerCase()
    return (fromRoom || this.localAddress || '').toLowerCase()
  }

  /**
   * Ingest a 1:1 DM body. Caller must have already enforced that this packet is
   * for us (topic === me, or bare directed delivery from Explorer).
   */
  private handleDmPacket(address: string, data: Uint8Array, source: 'topic' | 'bare'): void {
    // SFU / community traffic always uses a topic — bare packets are 1:1 DMs.
    if (isMessageRouterIdentity(address)) return
    const chat = tryDecodeRfc4ChatPacket(data)
    if (chat.kind !== 'chat') return
    const from = address.trim().toLowerCase()
    const me = this.selfAddress()
    if (!from || (me && from === me)) return
    const text = chat.text.trim()
    if (!text) return
    const time = typeof chat.time === 'number' && Number.isFinite(chat.time) ? chat.time : Date.now() / 1000
    // Drop duplicates (retransmit / older dual-send builds) within 3s.
    const dedupeKey = `${from}|${text}`
    const now = Date.now() / 1000
    const prev = this.recentDmKeys.get(dedupeKey)
    if (prev != null && now - prev < 3) return
    this.recentDmKeys.set(dedupeKey, now)
    if (this.recentDmKeys.size > 200) {
      for (const [k, t] of this.recentDmKeys) {
        if (now - t > 30) this.recentDmKeys.delete(k)
      }
    }
    clientDebugLog.log(
      'social',
      `DM received ← ${from.slice(0, 12)}… via=${source} “${text.slice(0, 40)}${text.length > 40 ? '…' : ''}”`,
      { level: 'success', alsoConsole: true }
    )
    const ev: PrivateMessageEvent = { fromAddress: from, text, time }
    for (const listener of this.inbound) listener(ev)
  }

  private handleTopicPacket(topic: string, address: string, data: Uint8Array): void {
    // 1:1 DM — topic MUST be recipient wallet (or private:{me}). Drop everything else.
    const pmTo = parsePrivateMessageTopic(topic)
    if (pmTo) {
      const me = this.selfAddress()
      // Only the intended recipient surfaces this as a DM — never show others' private: topics.
      if (!me || pmTo !== me) {
        if (!me) {
          clientDebugLog.log(
            'social',
            `DM topic ignored — local identity not ready (topic=${topic.slice(0, 28)}…)`,
            { level: 'warn', alsoConsole: true }
          )
        }
        // Not for us (another peer's DM, possibly mis-broadcast) — discard.
        return
      }
      this.handleDmPacket(address, data, 'topic')
      return
    }

    // Follow/Tour control — raw data on d3js-follow:{id}, not RFC4 chat / not SFU.
    const followCommunityId = parseCommunityFollowTopic(topic)
    if (followCommunityId) {
      this.handleFollowDataPacket(followCommunityId, address, data)
      return
    }

    // Loot Bag claims — room broadcast, peer toasts (not self).
    if (isPoolClaimTopic(topic)) {
      this.handlePoolClaimDataPacket(address, data)
      return
    }

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

  private handleFollowDataPacket(communityId: string, address: string, data: Uint8Array): void {
    if (isMessageRouterIdentity(address)) return
    const from = address.trim().toLowerCase()
    if (!from || from === this.localAddress) return
    const msg = tryParseFollowDataPacket(data)
    if (!msg) return
    const ev: CommunityFollowDataEvent = { communityId, fromAddress: from, msg }
    for (const listener of this.followInbound) listener(ev)
  }

  private handlePoolClaimDataPacket(address: string, data: Uint8Array): void {
    if (isMessageRouterIdentity(address)) return
    const from = address.trim().toLowerCase()
    const me = this.selfAddress()
    if (!from) return
    if (me && from === me) {
      clientDebugLog.log('social', 'Pool claim rx ignored (self LiveKit identity)', {
        level: 'info',
        alsoConsole: true,
        throttleMs: 3000,
        throttleKey: 'pool-claim-self-lk'
      })
      return
    }
    const msg = tryParsePoolClaimDataPacket(data)
    if (!msg) {
      clientDebugLog.log('social', 'Pool claim rx ignored (bad packet)', {
        level: 'warn',
        alsoConsole: true
      })
      return
    }
    // Prefer wire address; fall back to LiveKit identity
    const claimer = (msg.a || from).toLowerCase()
    if (me && claimer === me) {
      clientDebugLog.log('social', 'Pool claim rx ignored (self claimer — no local toast)', {
        level: 'info',
        alsoConsole: true,
        throttleMs: 3000,
        throttleKey: 'pool-claim-self-wire'
      })
      return
    }
    const bucket = Math.floor(msg.at / 5000)
    const dedupeKey = `${claimer}|${msg.p}|${bucket}`
    const now = Date.now()
    const prev = this.recentPoolClaimKeys.get(dedupeKey)
    if (prev != null && now - prev < 8000) return
    this.recentPoolClaimKeys.set(dedupeKey, now)
    if (this.recentPoolClaimKeys.size > 100) {
      for (const [k, t] of this.recentPoolClaimKeys) {
        if (now - t > 60_000) this.recentPoolClaimKeys.delete(k)
      }
    }
    const n = this.poolClaimInbound.size
    clientDebugLog.log(
      'social',
      `Pool claim ← ${claimer.slice(0, 10)}… pos=${msg.p} “${msg.l}” listeners=${n}`,
      { level: n === 0 ? 'warn' : 'success', alsoConsole: true }
    )
    if (n === 0) {
      clientDebugLog.log(
        'social',
        'Pool claim dropped — toast host not subscribed (Jump In disposed notifications?)',
        { level: 'warn', alsoConsole: true }
      )
      return
    }
    const ev: PoolClaimDataEvent = {
      fromAddress: claimer,
      msg: { ...msg, a: claimer }
    }
    for (const listener of this.poolClaimInbound) listener(ev)
  }

  /**
   * Loot Bag claim — room-broadcast non-chat data on topic `d3js-lootbag:claims`.
   * Peers show a toast; local client should not toast self (filtered on receive).
   */
  async sendPoolClaim(msg: PoolClaimWireMsg): Promise<boolean> {
    if (!this.session || !this.isConnected()) {
      this.lastError = 'private messages room not connected'
      clientDebugLog.log('social', 'Pool claim publish skipped — PM room not connected', {
        level: 'warn',
        alsoConsole: true
      })
      return false
    }
    const packet = encodePoolClaimDataPacket(msg)
    const remotes = this.session.getRemoteParticipantIdentities().filter((id) => !isMessageRouterIdentity(id))
    try {
      const published = await this.session.publishTopicData(POOL_CLAIM_TOPIC, packet, true)
      if (!published) {
        this.lastError = 'LiveKit publishTopicData returned false'
        clientDebugLog.log('social', 'Pool claim publish failed — room not ready or publish rejected', {
          level: 'warn',
          alsoConsole: true
        })
        return false
      }
      const peerHint =
        remotes.length === 0
          ? ' · remotes=0 (no peer will toast — other client must be signed in + PM-connected)'
          : ` · remotes=${remotes.length}`
      clientDebugLog.log(
        'social',
        `Pool claim → PM room topic=${POOL_CLAIM_TOPIC} pos=${msg.p} demo=${!!msg.demo}${peerHint}`,
        { level: remotes.length === 0 ? 'warn' : 'success', alsoConsole: true }
      )
      return true
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.lastError = detail
      clientDebugLog.log('social', `Pool claim publish failed: ${detail}`, {
        level: 'warn',
        alsoConsole: true
      })
      return false
    }
  }

  async sendTo(peerAddress: string, text: string): Promise<boolean> {
    const dest = peerAddress.trim().toLowerCase()
    const trimmed = text.trim()
    if (!dest || !trimmed) return false
    // Reconnect if room dropped mid-session.
    if (!this.isConnected() && this.identity && this.localAddress) {
      const ok = await this.connect(this.identity, this.localAddress)
      if (!ok) return false
    }
    if (!this.session || !this.isConnected()) {
      this.lastError = 'private messages room not connected'
      return false
    }

    const remotes = this.session.getRemoteParticipantIdentities()
    // Exact LiveKit identity only — never invent/lowercase-guess; wrong dest can mis-route.
    const destIdentity = this.session.getExactRemoteIdentity(dest)
    const inRoom = destIdentity != null

    if (!inRoom || !destIdentity) {
      // HARD FAIL — do not room-broadcast private chat (privacy). Recipient must be in PM room.
      this.lastError = 'recipient not in private-messages room'
      clientDebugLog.log(
        'social',
        `DM blocked — target not in private-messages room (${dest.slice(0, 10)}…) remotes=${remotes.length}. Not broadcasting.`,
        { level: 'error', alsoConsole: true }
      )
      return false
    }

    /**
     * ADR-208 privacy — single directed packet ONLY:
     * - destinationIdentities = [exact LiveKit identity] (SFU top-level routing)
     * - topic = recipient wallet (client filter / Explorer convention)
     *
     * Never room-broadcast. Never dual-send. Never omit destinations.
     */
    const sent = await this.session.publishChatTo(trimmed, [destIdentity], dest)

    if (!sent) {
      this.lastError = 'DM publish failed'
      clientDebugLog.log(
        'social',
        `DM publish failed → ${dest.slice(0, 12)}… dest=${destIdentity.slice(0, 12)}…`,
        { level: 'warn', alsoConsole: true }
      )
      return false
    }

    clientDebugLog.log(
      'social',
      `DM sent → ${dest.slice(0, 12)}… directed-only=${destIdentity.slice(0, 12)}… topic=${dest.slice(0, 12)}… remotes=${remotes.length}`,
      { level: 'success', alsoConsole: true }
    )
    return true
  }

  /**
   * Community group text — route through comms-message-sfu (Explorer parity).
   * Client does **not** fan-out to members; the SFU resolves recipients.
   */
  async sendToCommunity(communityId: string, text: string): Promise<boolean> {
    const id = communityId.trim().toLowerCase()
    const trimmed = text.trim()
    if (!id || !trimmed) return false
    if (!this.isConnected() && this.identity && this.localAddress) {
      await this.connect(this.identity, this.localAddress)
    }
    if (!this.session || !this.isConnected()) return false

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

  /**
   * Follow/Tour control — room-broadcast non-chat data on topic `d3js-follow:{id}`.
   * Does **not** go through message-router / community chat UI path.
   * Reaches peers currently in the private-messages LiveKit room (our clients + anyone else
   * who ignores unknown topics).
   */
  async sendCommunityFollow(communityId: string, msg: FollowWireMsg): Promise<boolean> {
    const id = communityId.trim().toLowerCase()
    if (!id || !this.session || !this.isConnected()) return false
    const topic = communityFollowTopic(id)
    const packet = encodeFollowDataPacket(msg)
    try {
      await this.session.publishTopicData(topic, packet, true)
      clientDebugLog.log('social', `Follow control → PM room topic=${topic} t=${msg.t}`, {
        level: 'success',
        alsoConsole: true
      })
      return true
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.lastError = detail
      clientDebugLog.log('social', `Follow control publish failed: ${detail}`, {
        level: 'warn',
        alsoConsole: true
      })
      return false
    }
  }

  /** Prefer live SFU identities; fall back to default replica names. */
  private resolveMessageRouters(): string[] {
    if (!this.session) return []
    const live = this.session.getRemoteParticipantIdentities().filter(isMessageRouterIdentity)
    if (live.length > 0) return live
    // SFU may not appear in remotes until after join; still try well-known identities.
    return [...MESSAGE_ROUTER_FALLBACK_IDENTITIES]
  }

  /** Hard disconnect (sign-out / last holder released). */
  forceDisconnect(): void {
    this.connected = false
    this.lastError = null
    this.session?.disconnect()
    this.session = null
    this.identity = null
    this.localAddress = null
    this.holders = 0
  }

  /**
   * @deprecated Prefer release() — disconnect only when no SocialService holds the room.
   * Kept for sign-out paths that fully tear down social.
   */
  disconnect(): void {
    this.forceDisconnect()
  }
}

/** Process-wide private-messages LiveKit room (one per browser tab). */
const sharedPrivateMessages = new PrivateMessagesServiceImpl()

export type PrivateMessagesService = PrivateMessagesServiceImpl

export function getPrivateMessagesService(): PrivateMessagesService {
  return sharedPrivateMessages
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
          if (shift > 28) return null
        }
        const start = i
        const end = i + l
        if (end > len) return null
        i = end
        // Packet field 10 = message oneof (chat is nested)
        if (field === 10) {
          const nested = data.subarray(start, end)
          // Scan nested for Chat.forwardedFrom (field 3 string)
          let j = 0
          while (j < nested.length) {
            const nk = nested[j++]
            if (nk === undefined) break
            const nf = nk >>> 3
            const nw = nk & 7
            if (nw === 2) {
              let nl = 0
              let ns = 0
              for (;;) {
                const b = nested[j++]
                if (b === undefined) return null
                nl |= (b & 0x7f) << ns
                if ((b & 0x80) === 0) break
                ns += 7
                if (ns > 28) return null
              }
              const nStart = j
              const nEnd = j + nl
              if (nEnd > nested.length) return null
              j = nEnd
              // field 1 = message text, field 3 = forwardedFrom (string)
              if (nf === 3) {
                try {
                  const s = new TextDecoder().decode(nested.subarray(nStart, nEnd)).trim().toLowerCase()
                  if (s) return s
                } catch {
                  /* ignore */
                }
              }
            } else if (nw === 0) {
              while (j < nested.length && (nested[j]! & 0x80) !== 0) j++
              j++
            } else if (nw === 5) {
              j += 4
            } else if (nw === 1) {
              j += 8
            } else {
              break
            }
          }
        }
      } else if (wire === 0) {
        while (i < len && (data[i]! & 0x80) !== 0) i++
        i++
      } else if (wire === 5) {
        i += 4
      } else if (wire === 1) {
        i += 8
      } else {
        break
      }
    }
  } catch {
    /* ignore */
  }
  return null
}
