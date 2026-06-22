import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import type { CommsService } from '../network/CommsService'
import { ChatPeerProfiles, type PeerChatProfile } from './ChatPeerProfiles'
import {
  buildFriendshipRelationMap,
  fetchFriendshipSnapshotSigned,
  resolveFriendshipRelation,
  type FriendshipRelation,
  type FriendshipSnapshot
} from './friendshipsApi'
import { fetchMemberCommunitiesSigned } from './socialApi'
import { CHAT_MAX_LENGTH, type MentionCandidate } from './chatMentions'
import { isEvmAddress } from './walletLabel'
import type { ChatChannelChoice, ChatLine, CommunityListRow, SceneChatTab } from './types'

export { CHAT_MAX_LENGTH }

export type SocialChatEvent = {
  channelKey: string
  line: ChatLine
}

type SocialInitOptions = {
  address: string | null
  identity: AuthIdentity | null
  isGuest: boolean
  sceneTab: SceneChatTab
  comms: CommsService
  contentUrl: string
}

let lineCounter = 0

function channelKey(channel: ChatChannelChoice): string {
  if (channel.kind === 'scene') return `scene:${channel.sceneKey}`
  if (channel.kind === 'community') return `community:${channel.communityId.toLowerCase()}`
  return 'messages'
}

function formatTime(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Scene + community chat state — mirrors companion ChatView channel model. */
export class SocialService {
  private comms: CommsService | null = null
  private localAddress: string | null = null
  private displayName = 'You'
  private localFaceUrl: string | null = null
  private localNameColor = '#b8ff66'
  private sceneTab: SceneChatTab | null = null
  private communities: CommunityListRow[] = []
  private channel: ChatChannelChoice = { kind: 'messages' }
  private readonly messages = new Map<string, ChatLine[]>()
  private readonly listeners = new Set<(event: SocialChatEvent) => void>()
  private readonly channelListeners = new Set<() => void>()
  private readonly peerProfiles = new ChatPeerProfiles()
  private authIdentity: AuthIdentity | null = null
  private friendshipSnapshot: FriendshipSnapshot | null = null
  private friendshipRelationByAddress = new Map<string, FriendshipRelation>()
  private friendshipLoad: Promise<void> | null = null
  private ready = false
  private readonly seenChatKeys = new Map<string, number>()

  async init(options: SocialInitOptions): Promise<void> {
    this.comms = options.comms
    this.authIdentity = options.isGuest ? null : options.identity
    this.localAddress = options.address?.toLowerCase() ?? null
    this.displayName = options.address ? 'You' : 'Guest'
    this.friendshipSnapshot = null
    this.friendshipRelationByAddress.clear()
    this.friendshipLoad = null
    this.sceneTab = options.sceneTab
    this.channel = { kind: 'scene', sceneKey: options.sceneTab.key, label: options.sceneTab.label }
    this.peerProfiles.setPeerUrl(options.contentUrl)

    this.comms.setChatHandler((payload) => {
      if (this.channel.kind !== 'scene') return
      if (this.isDuplicateChat(payload.senderAddress, payload.text, payload.time)) return
      const key = channelKey(this.channel)
      void this.ensurePeerProfile(payload.senderAddress)
      this.appendLine(key, {
        id: `in-${++lineCounter}`,
        text: payload.text,
        time: payload.time,
        senderAddress: payload.senderAddress
      })
    })

    if (!options.isGuest && options.identity) {
      try {
        const { communities } = await fetchMemberCommunitiesSigned(options.identity)
        this.communities = communities
        clientDebugLog.log('social', `Loaded ${communities.length} member communities`, { level: 'success' })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        clientDebugLog.log('social', `Member communities failed: ${msg}`, { level: 'warn' })
      }
      void this.ensureFriendshipSnapshot()
    }

    this.ready = true
    this.notifyChannelChange()
  }

  isReady(): boolean {
    return this.ready
  }

  getSceneTab(): SceneChatTab | null {
    return this.sceneTab
  }

  getCommunities(): CommunityListRow[] {
    return this.communities
  }

  getChannel(): ChatChannelChoice {
    return this.channel
  }

  getChannelTitle(): string {
    if (this.channel.kind === 'scene') return this.channel.label
    if (this.channel.kind === 'community') return this.channel.displayName
    return 'Direct messages'
  }

  getChannelSubtitle(): string {
    if (this.channel.kind === 'scene') return 'Scene chat'
    if (this.channel.kind === 'community') return 'Community chat'
    return 'Coming soon'
  }

  selectChannel(channel: ChatChannelChoice): void {
    this.channel = channel
    this.notifyChannelChange()
  }

  getMessages(): ChatLine[] {
    return [...(this.messages.get(channelKey(this.channel)) ?? [])]
  }

  onChat(listener: (event: SocialChatEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onChannelChange(listener: () => void): () => void {
    this.channelListeners.add(listener)
    return () => this.channelListeners.delete(listener)
  }

  onPeerProfilesChange(listener: () => void): () => void {
    return this.peerProfiles.onUpdate(listener)
  }

  setDisplayName(name: string): void {
    this.displayName = name.trim() || 'You'
  }

  setLocalProfile(address: string, displayName: string, faceUrl: string | null, nameColor?: string): void {
    this.localAddress = address.toLowerCase()
    this.displayName = displayName.trim() || 'You'
    this.localFaceUrl = faceUrl
    if (nameColor) this.localNameColor = nameColor
    this.peerProfiles.setLocal(this.localAddress, this.displayName, faceUrl, this.localNameColor)
  }

  setLocalFaceUrl(faceUrl: string | null): void {
    this.localFaceUrl = faceUrl
    if (!this.localAddress) return
    this.peerProfiles.setLocal(this.localAddress, this.displayName, faceUrl, this.localNameColor)
  }

  rememberPeerProfile(address: string, serializedProfile: string): void {
    this.peerProfiles.rememberSerialized(address, serializedProfile)
  }

  async ensurePeerProfile(address: string): Promise<void> {
    await this.peerProfiles.ensurePeer(address)
  }

  getLocalDisplay(): PeerChatProfile {
    return {
      displayName: this.displayName,
      nameColor: this.localNameColor,
      faceUrl: this.localFaceUrl
    }
  }

  getLocalAddress(): string | null {
    return this.localAddress
  }

  isOwnLine(line: ChatLine): boolean {
    if (line.self) return true
    if (!this.localAddress || !line.senderAddress) return false
    return line.senderAddress.toLowerCase() === this.localAddress
  }

  getMentionCandidates(): MentionCandidate[] {
    const self = this.localAddress
    const addrs = new Set<string>()
    for (const addr of this.comms?.getSceneChatMentionAddresses() ?? []) {
      if (self && addr === self) continue
      if (isEvmAddress(addr)) addrs.add(addr.toLowerCase())
    }
    for (const line of this.getMessages()) {
      if (line.self || !line.senderAddress) continue
      const low = line.senderAddress.toLowerCase()
      if (self && low === self) continue
      if (isEvmAddress(low)) addrs.add(low)
    }
    return [...addrs]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 32)
      .map((address) => {
        const peer = this.getPeerDisplay(address)
        return { address, displayName: peer.displayName, faceUrl: peer.faceUrl }
      })
  }

  async ensureFriendshipSnapshot(): Promise<void> {
    if (!this.authIdentity || !this.localAddress) return
    if (this.friendshipSnapshot) return
    if (this.friendshipLoad) {
      await this.friendshipLoad
      return
    }
    this.friendshipLoad = fetchFriendshipSnapshotSigned(this.authIdentity, this.localAddress)
      .then((snapshot) => {
        this.applyFriendshipSnapshot(snapshot)
        clientDebugLog.log('social', `Loaded ${snapshot.friends.size} friends`, { level: 'success' })
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        clientDebugLog.log('social', `Friendships failed: ${msg}`, { level: 'warn' })
      })
      .finally(() => {
        this.friendshipLoad = null
      })
    await this.friendshipLoad
  }

  /** Preload signed friendship data when a remote peer appears in-scene. */
  onRemotePeerJoined(address: string): void {
    void this.ensureFriendshipSnapshot()
    const key = address.toLowerCase()
    if (this.friendshipRelationByAddress.has(key)) return
    if (!this.friendshipSnapshot) return
    this.friendshipRelationByAddress.set(key, resolveFriendshipRelation(key, this.friendshipSnapshot))
  }

  getFriendshipRelation(address: string): FriendshipRelation {
    const key = address.toLowerCase()
    const cached = this.friendshipRelationByAddress.get(key)
    if (cached) return cached
    return resolveFriendshipRelation(key, this.friendshipSnapshot)
  }

  getPeerDisplay(address: string | undefined): PeerChatProfile {
    const hit = this.peerProfiles.get(address)
    if (hit) return hit
    if (address) {
      return {
        displayName: `${address.slice(0, 6)}…${address.slice(-4)}`,
        nameColor: '#ff6ad5',
        faceUrl: null
      }
    }
    return { displayName: 'Player', nameColor: '#ff6ad5', faceUrl: null }
  }

  async sendMessage(text: string): Promise<boolean> {
    const trimmed = text.trim().slice(0, CHAT_MAX_LENGTH)
    if (!trimmed || !this.comms) return false

    if (this.channel.kind === 'messages') return false
    if (this.channel.kind === 'community') {
      this.appendLine(channelKey(this.channel), {
        id: `local-${++lineCounter}`,
        text: trimmed,
        time: Date.now() / 1000,
        self: true,
        senderAddress: this.localAddress ?? undefined
      })
      clientDebugLog.log('social', 'Community text chat — PM router not wired yet', { level: 'warn' })
      return true
    }

    const sent = await this.comms.sendSceneChat(trimmed)
    if (!sent) return false

    this.appendLine(channelKey(this.channel), {
      id: `local-${++lineCounter}`,
      text: trimmed,
      time: Date.now() / 1000,
      self: true,
      senderAddress: this.localAddress ?? undefined
    })
    return true
  }

  dispose(): void {
    this.comms?.setChatHandler(null)
    this.comms = null
    this.listeners.clear()
    this.channelListeners.clear()
    this.messages.clear()
    this.peerProfiles.clear()
    this.authIdentity = null
    this.friendshipSnapshot = null
    this.friendshipRelationByAddress.clear()
    this.friendshipLoad = null
    this.ready = false
  }

  private applyFriendshipSnapshot(snapshot: FriendshipSnapshot): void {
    this.friendshipSnapshot = snapshot
    this.friendshipRelationByAddress = buildFriendshipRelationMap(snapshot)
  }

  static formatLineTime(line: ChatLine): string {
    return formatTime(line.time)
  }

  private appendLine(key: string, line: ChatLine): void {
    const bucket = this.messages.get(key) ?? []
    bucket.push(line)
    if (bucket.length > 200) bucket.splice(0, bucket.length - 200)
    this.messages.set(key, bucket)
    for (const listener of this.listeners) listener({ channelKey: key, line })
  }

  private notifyChannelChange(): void {
    for (const listener of this.channelListeners) listener()
  }

  private isDuplicateChat(senderAddress: string, text: string, time: number): boolean {
    const key = `${senderAddress.toLowerCase()}\0${text}\0${Math.floor(time)}`
    const now = performance.now()
    const prev = this.seenChatKeys.get(key)
    if (prev !== undefined && now - prev < 5000) return true
    this.seenChatKeys.set(key, now)
    if (this.seenChatKeys.size > 128) {
      for (const [seenKey, seenAt] of this.seenChatKeys) {
        if (now - seenAt > 15000) this.seenChatKeys.delete(seenKey)
      }
    }
    return false
  }
}
