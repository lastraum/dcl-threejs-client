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
import {
  chatMediaBlob,
  createDcmMessageId,
  DcmInboundAssembler,
  encodeDcmImageEnvelopes
} from './dcmChatMedia'
import { prepareChatImageFile } from './prepareChatImage'
import { isSceneChatEmoteWireText } from './dclRfc4Chat'
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

type SocialShellInitOptions = {
  address: string
  identity: AuthIdentity
  contentUrl?: string
}

type SocialSceneAttachOptions = {
  comms: CommsService | null
  sceneTab: SceneChatTab
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
  private sceneTabs: SceneChatTab[] = []
  /** Live comms room — incoming scene chat routes here. */
  private connectedSceneKey: string | null = null
  private communities: CommunityListRow[] = []
  private channel: ChatChannelChoice = { kind: 'messages' }
  private readonly messages = new Map<string, ChatLine[]>()
  private readonly listeners = new Set<(event: SocialChatEvent) => void>()
  private readonly channelListeners = new Set<() => void>()
  private readonly friendshipListeners = new Set<() => void>()
  private readonly peerProfiles = new ChatPeerProfiles()
  private authIdentity: AuthIdentity | null = null
  private friendshipSnapshot: FriendshipSnapshot | null = null
  private friendshipRelationByAddress = new Map<string, FriendshipRelation>()
  private friendshipLoad: Promise<void> | null = null
  private ready = false
  private readonly seenChatKeys = new Map<string, number>()
  private readonly seenMediaKeys = new Map<string, number>()
  private readonly unreadCounts = new Map<string, number>()
  /** True while the active channel thread is open — suppresses unread on that channel. */
  private channelThreadOpen = false
  private readonly mediaAssembler = new DcmInboundAssembler()
  private readonly mediaObjectUrls = new Set<string>()

  /** 2D shell bootstrap — communities + profile without scene comms. */
  async initShell(options: SocialShellInitOptions): Promise<void> {
    this.authIdentity = options.identity
    this.localAddress = options.address.toLowerCase()
    this.displayName = 'You'
    this.sceneTabs = []
    this.connectedSceneKey = null
    this.comms = null
    this.channel = { kind: 'messages' }
    this.peerProfiles.setPeerUrl(options.contentUrl ?? 'https://peer.decentraland.org')
    await this.loadMemberCommunities(options.identity)
    void this.ensureFriendshipSnapshot()
    this.ready = true
    this.notifyChannelChange()
  }

  /** Wire scene comms after shell init or refresh scene tab when the landing changes. */
  async attachSceneComms(options: SocialSceneAttachOptions): Promise<void> {
    this.comms = options.comms
    this.upsertSceneTab(options.sceneTab)
    this.peerProfiles.setPeerUrl(options.contentUrl)
    if (options.comms && options.sceneTab.browserChatEnabled) {
      this.wireCommsHandlers()
    }
    if (this.channel.kind === 'messages') {
      this.channel = {
        kind: 'scene',
        sceneKey: options.sceneTab.key,
        label: options.sceneTab.label
      }
    }
    if (!this.ready) {
      this.ready = true
    }
    this.notifyChannelChange()
  }

  async init(options: SocialInitOptions): Promise<void> {
    this.comms = options.comms
    this.authIdentity = options.isGuest ? null : options.identity
    this.localAddress = options.address?.toLowerCase() ?? null
    this.displayName = options.address ? 'You' : 'Guest'
    this.friendshipSnapshot = null
    this.friendshipRelationByAddress.clear()
    this.friendshipLoad = null
    this.upsertSceneTab(options.sceneTab)
    this.channel = { kind: 'scene', sceneKey: options.sceneTab.key, label: options.sceneTab.label }
    this.peerProfiles.setPeerUrl(options.contentUrl)
    this.wireCommsHandlers()

    if (!options.isGuest && options.identity) {
      await this.loadMemberCommunities(options.identity)
    }

    this.ready = true
    this.notifyChannelChange()
  }

  isReady(): boolean {
    return this.ready
  }

  getSceneTabs(): SceneChatTab[] {
    return [...this.sceneTabs]
  }

  /** Most recently visited / comms-connected scene tab. */
  getSceneTab(): SceneChatTab | null {
    if (this.connectedSceneKey) {
      return this.findSceneTab(this.connectedSceneKey) ?? null
    }
    return this.sceneTabs[0] ?? null
  }

  isSceneBrowserChatEnabled(): boolean {
    if (this.channel.kind !== 'scene') return true
    const tab = this.findSceneTab(this.channel.sceneKey)
    return tab?.browserChatEnabled !== false
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
    if (this.channel.kind === 'scene') {
      return this.isSceneBrowserChatEnabled() ? 'Scene chat' : 'Chat disabled by creator'
    }
    if (this.channel.kind === 'community') return 'Community chat'
    return 'Coming soon'
  }

  selectChannel(channel: ChatChannelChoice): void {
    this.channel = channel
    this.unreadCounts.delete(channelKey(channel))
    this.notifyChannelChange()
  }

  setChannelThreadOpen(open: boolean): void {
    if (this.channelThreadOpen === open) return
    this.channelThreadOpen = open
    if (open) {
      this.unreadCounts.delete(channelKey(this.channel))
      this.notifyChannelChange()
    }
  }

  getUnreadCount(channel: ChatChannelChoice): number {
    return this.unreadCounts.get(channelKey(channel)) ?? 0
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

  getIncomingFriendAddresses(): string[] {
    if (!this.friendshipSnapshot) return []
    return [...this.friendshipSnapshot.incoming].sort((a, b) => a.localeCompare(b))
  }

  getTotalUnreadCount(): number {
    let total = 0
    for (const count of this.unreadCounts.values()) total += count
    return total
  }

  onFriendshipChange(listener: () => void): () => void {
    this.friendshipListeners.add(listener)
    return () => this.friendshipListeners.delete(listener)
  }

  async refreshFriendshipSnapshot(): Promise<void> {
    if (!this.authIdentity || !this.localAddress) return
    this.friendshipSnapshot = null
    this.friendshipLoad = null
    await this.ensureFriendshipSnapshot()
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
        clientDebugLog.log('social', `Friendships unavailable: ${msg}`, { level: 'warn' })
        this.applyFriendshipSnapshot({ friends: new Set(), incoming: new Set(), outgoing: new Set() })
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

  async sendImageFile(file: File): Promise<boolean> {
    if (!this.comms || this.channel.kind !== 'scene') return false

    const prepared = await prepareChatImageFile(file)
    const messageId = createDcmMessageId()
    const time = Date.now() / 1000
    const envelopes = encodeDcmImageEnvelopes(prepared, messageId, time)
    const sent = await this.comms.sendSceneChatMedia(envelopes)
    if (!sent) return false

    const objectUrl = this.registerMediaObjectUrl(
      URL.createObjectURL(chatMediaBlob(prepared.bytes, prepared.mime))
    )
    this.appendLine(channelKey(this.channel), {
      kind: 'image',
      id: `local-${++lineCounter}`,
      messageId,
      objectUrl,
      mime: prepared.mime,
      width: prepared.width,
      height: prepared.height,
      time,
      self: true,
      senderAddress: this.localAddress ?? undefined
    })
    clientDebugLog.log(
      'social',
      `DCM image sent — ${prepared.mime} ${prepared.width}×${prepared.height} ${prepared.bytes.length}B`,
      { level: 'success' }
    )
    return true
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

  private wireCommsHandlers(): void {
    if (!this.comms) return
    this.comms.setChatHandler((payload) => {
      const sceneChannel = this.sceneChannelChoice()
      if (!sceneChannel) return
      if (isSceneChatEmoteWireText(payload.text)) return
      if (this.isDuplicateChat(payload.senderAddress, payload.text, payload.time)) return
      void this.ensurePeerProfile(payload.senderAddress)
      this.appendLine(channelKey(sceneChannel), {
        id: `in-${++lineCounter}`,
        text: payload.text,
        time: payload.time,
        senderAddress: payload.senderAddress
      })
    })

    this.comms.setChatMediaHandler((payload) => {
      const sceneChannel = this.sceneChannelChoice()
      if (!sceneChannel) return
      const decoded = this.mediaAssembler.ingest(payload.senderAddress, payload.data)
      if (!decoded) return
      if (this.isDuplicateMedia(payload.senderAddress, decoded.messageId)) return
      void this.ensurePeerProfile(payload.senderAddress)
      const objectUrl = this.registerMediaObjectUrl(
        URL.createObjectURL(chatMediaBlob(decoded.bytes, decoded.mime))
      )
      this.appendLine(channelKey(sceneChannel), {
        kind: 'image',
        id: `in-${++lineCounter}`,
        messageId: decoded.messageId,
        objectUrl,
        mime: decoded.mime,
        width: decoded.width,
        height: decoded.height,
        time: decoded.time,
        senderAddress: payload.senderAddress
      })
    })
  }

  private sceneChannelChoice(): ChatChannelChoice | null {
    if (!this.connectedSceneKey) return null
    const tab = this.findSceneTab(this.connectedSceneKey)
    if (!tab) return null
    return { kind: 'scene', sceneKey: tab.key, label: tab.label }
  }

  private findSceneTab(key: string): SceneChatTab | undefined {
    return this.sceneTabs.find((tab) => tab.key === key)
  }

  /** Newest scene first; revisiting moves an existing entry to the front. */
  private upsertSceneTab(tab: SceneChatTab): void {
    const idx = this.sceneTabs.findIndex((row) => row.key === tab.key)
    if (idx >= 0) {
      const merged = { ...this.sceneTabs[idx]!, ...tab }
      this.sceneTabs.splice(idx, 1)
      this.sceneTabs.unshift(merged)
    } else {
      this.sceneTabs.unshift(tab)
    }
    this.connectedSceneKey = tab.key
  }

  private async loadMemberCommunities(identity: AuthIdentity): Promise<void> {
    try {
      const { communities } = await fetchMemberCommunitiesSigned(identity)
      this.communities = communities
      clientDebugLog.log('social', `Loaded ${communities.length} member communities`, { level: 'success' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('social', `Member communities failed: ${msg}`, { level: 'warn' })
    }
    void this.ensureFriendshipSnapshot()
  }

  dispose(): void {
    this.comms?.setChatHandler(null)
    this.comms?.setChatMediaHandler(null)
    for (const url of this.mediaObjectUrls) URL.revokeObjectURL(url)
    this.mediaObjectUrls.clear()
    this.comms = null
    this.listeners.clear()
    this.channelListeners.clear()
    this.messages.clear()
    this.unreadCounts.clear()
    this.channelThreadOpen = false
    this.sceneTabs = []
    this.connectedSceneKey = null
    this.peerProfiles.clear()
    this.authIdentity = null
    this.friendshipSnapshot = null
    this.friendshipRelationByAddress.clear()
    this.friendshipLoad = null
    this.friendshipListeners.clear()
    this.ready = false
  }

  private applyFriendshipSnapshot(snapshot: FriendshipSnapshot): void {
    this.friendshipSnapshot = snapshot
    this.friendshipRelationByAddress = buildFriendshipRelationMap(snapshot)
    this.notifyFriendshipChange()
  }

  private notifyFriendshipChange(): void {
    for (const listener of this.friendshipListeners) listener()
  }

  static formatLineTime(line: ChatLine): string {
    return formatTime(line.time)
  }

  private appendLine(key: string, line: ChatLine): void {
    const bucket = this.messages.get(key) ?? []
    bucket.push(line)
    if (bucket.length > 200) bucket.splice(0, bucket.length - 200)
    this.messages.set(key, bucket)
    const isIncoming = !line.self
    const isActiveChannel = key === channelKey(this.channel)
    const countsAsUnread = isIncoming && (!isActiveChannel || !this.channelThreadOpen)
    if (countsAsUnread) {
      this.unreadCounts.set(key, (this.unreadCounts.get(key) ?? 0) + 1)
      this.notifyChannelChange()
    }
    for (const listener of this.listeners) listener({ channelKey: key, line })
  }

  private notifyChannelChange(): void {
    for (const listener of this.channelListeners) listener()
  }

  private registerMediaObjectUrl(url: string): string {
    this.mediaObjectUrls.add(url)
    return url
  }

  private isDuplicateMedia(senderAddress: string, messageId: string): boolean {
    const key = `${senderAddress.toLowerCase()}\0${messageId}`
    const now = performance.now()
    const prev = this.seenMediaKeys.get(key)
    if (prev !== undefined && now - prev < 30_000) return true
    this.seenMediaKeys.set(key, now)
    if (this.seenMediaKeys.size > 64) {
      for (const [seenKey, seenAt] of this.seenMediaKeys) {
        if (now - seenAt > 120_000) this.seenMediaKeys.delete(seenKey)
      }
    }
    return false
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
