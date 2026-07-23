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
import { PrivateMessagesService } from './PrivateMessagesService'
import {
  isChatImageLine,
  type ChatChannelChoice,
  type ChatLine,
  type CommunityListRow,
  type SceneChatTab
} from './types'
import { chatTranslationService } from './translation'

export { CHAT_MAX_LENGTH }

export type SocialChatEvent = {
  channelKey: string
  line: ChatLine
}

export type DmPeerRow = {
  address: string
  displayName: string
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
  /** Local guest wallet — skip friendships / communities signed APIs. */
  isGuest?: boolean
  displayName?: string
}

type SocialSceneAttachOptions = {
  comms: CommsService | null
  sceneTab: SceneChatTab
  contentUrl: string
}

let lineCounter = 0

export function socialChannelKey(channel: ChatChannelChoice): string {
  if (channel.kind === 'scene') return `scene:${channel.sceneKey}`
  if (channel.kind === 'community') return `community:${channel.communityId.toLowerCase()}`
  if (channel.kind === 'dm') return `dm:${channel.peerAddress.toLowerCase()}`
  return 'messages'
}

/** @deprecated use socialChannelKey */
function channelKey(channel: ChatChannelChoice): string {
  return socialChannelKey(channel)
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
  /**
   * Landing/current scene (CommsService primary room for cast + handoff).
   * Background multi-room chat may also be live via `liveSceneKeys`.
   */
  private connectedSceneKey: string | null = null
  /** Scene keys with an active LiveKit chat room (primary and/or multi-room pool). */
  private readonly liveSceneKeys = new Set<string>()
  /** Optional multi-room send — when set, scene chat publishes per sceneKey. */
  private sceneChatSend:
    | ((sceneKey: string, text: string) => Promise<boolean>)
    | null = null
  private sceneChatMediaSend:
    | ((sceneKey: string, envelopes: Uint8Array[]) => Promise<boolean>)
    | null = null
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
  private readonly privateMessages = new PrivateMessagesService()
  private unsubPrivateMessages: (() => void) | null = null
  private unsubCommunityMessages: (() => void) | null = null

  /** Wire multi-room publish (pool / controller). Falls back to primary CommsService. */
  setSceneChatTransport(options: {
    send?: ((sceneKey: string, text: string) => Promise<boolean>) | null
    sendMedia?: ((sceneKey: string, envelopes: Uint8Array[]) => Promise<boolean>) | null
  }): void {
    this.sceneChatSend = options.send ?? null
    this.sceneChatMediaSend = options.sendMedia ?? null
  }

  /** Mark a scene chat room live or offline (multi-room pool + primary). */
  setSceneChatLive(sceneKey: string, live: boolean): void {
    const key = sceneKey.trim()
    if (!key) return
    if (live) this.liveSceneKeys.add(key)
    else this.liveSceneKeys.delete(key)
    this.notifyChannelChange()
  }

  /** Replace the full live set (e.g. after connect / leave). */
  syncLiveSceneKeys(keys: Iterable<string>): void {
    this.liveSceneKeys.clear()
    for (const k of keys) {
      const key = k.trim()
      if (key) this.liveSceneKeys.add(key)
    }
    this.notifyChannelChange()
  }

  getLiveSceneKeys(): string[] {
    return [...this.liveSceneKeys]
  }

  /** 2D shell bootstrap — communities + profile without scene comms. */
  async initShell(options: SocialShellInitOptions): Promise<void> {
    this.authIdentity = options.identity
    this.localAddress = options.address.toLowerCase()
    this.displayName = options.displayName?.trim() || 'You'
    this.sceneTabs = []
    this.connectedSceneKey = null
    this.liveSceneKeys.clear()
    this.comms = null
    this.channel = { kind: 'messages' }
    this.peerProfiles.setPeerUrl(options.contentUrl ?? 'https://peer.decentraland.org')
    // Guests can use LiveKit scene chat; skip social APIs that need a real DCL account.
    if (!options.isGuest) {
      await this.loadMemberCommunities(options.identity)
      void this.ensureFriendshipSnapshot()
      void this.ensurePrivateMessagesConnected()
    } else {
      this.communities = []
      this.friendshipSnapshot = null
      this.friendshipRelationByAddress.clear()
      this.teardownPrivateMessages()
    }
    this.ready = true
    this.notifyChannelChange()
  }

  /** Wire scene comms after shell init or refresh scene tab when the landing changes. */
  async attachSceneComms(options: SocialSceneAttachOptions): Promise<void> {
    this.comms = options.comms
    this.upsertSceneTab(options.sceneTab)
    this.peerProfiles.setPeerUrl(options.contentUrl)
    if (options.comms && options.sceneTab.browserChatEnabled !== false) {
      this.wireCommsHandlers()
      this.liveSceneKeys.add(options.sceneTab.key)
    } else if (!options.comms) {
      this.liveSceneKeys.delete(options.sceneTab.key)
    }
    // Always focus the live room so UI + inbound lines share the same channel key.
    // Prior scene tabs keep their message history in `messages` for later open.
    this.channel = {
      kind: 'scene',
      sceneKey: options.sceneTab.key,
      label: options.sceneTab.label
    }
    if (this.channelThreadOpen) {
      this.unreadCounts.delete(channelKey(this.channel))
    }
    if (!this.ready) {
      this.ready = true
    }
    this.notifyChannelChange()
  }

  /** Messages for a specific channel (scene tab history after switching rooms). */
  getMessagesForChannel(channel: ChatChannelChoice): ChatLine[] {
    return [...(this.messages.get(channelKey(channel)) ?? [])]
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
    // World.spawnLocalPlayer uses init() — without this, isLiveSceneChannel is always false
    // and Enter/submit silently fails with "scene room not live".
    if (options.comms && options.sceneTab.browserChatEnabled !== false) {
      this.liveSceneKeys.add(options.sceneTab.key)
    }

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
    if (this.channel.kind === 'dm') return this.channel.displayName
    return 'Direct messages'
  }

  getChannelSubtitle(): string {
    if (this.channel.kind === 'scene') {
      return this.isSceneBrowserChatEnabled() ? 'Scene chat' : 'Chat disabled by creator'
    }
    if (this.channel.kind === 'community') {
      if (this.privateMessages.isConnecting()) return 'Joining…'
      if (this.privateMessages.getLastError() && !this.privateMessages.isConnected()) {
        return 'Community chat offline'
      }
      return 'Community chat'
    }
    if (this.channel.kind === 'dm') {
      if (this.privateMessages.isConnected()) return 'Private message'
      if (this.privateMessages.isConnecting()) return 'Joining private chat…'
      if (this.privateMessages.getLastError()) return 'Private chat offline'
      return 'Direct message'
    }
    return 'Pick a friend to message'
  }

  /** Friends available for 1:1 DMs (ADR-208). */
  getDmPeers(): DmPeerRow[] {
    const out: DmPeerRow[] = []
    for (const [address, relation] of this.friendshipRelationByAddress) {
      if (relation !== 'friends') continue
      if (this.localAddress && address === this.localAddress) continue
      const profile = this.peerProfiles.get(address)
      out.push({
        address,
        displayName: profile?.displayName?.trim() || `${address.slice(0, 6)}…${address.slice(-4)}`
      })
      void this.peerProfiles.ensurePeer(address)
    }
    out.sort((a, b) => a.displayName.localeCompare(b.displayName))
    return out
  }

  isPrivateMessagesReady(): boolean {
    return this.privateMessages.isConnected()
  }

  isPrivateMessagesConnecting(): boolean {
    return this.privateMessages.isConnecting()
  }

  getPrivateMessagesError(): string | null {
    return this.privateMessages.getLastError()
  }

  selectChannel(channel: ChatChannelChoice): void {
    this.channel = channel
    this.unreadCounts.delete(channelKey(channel))
    this.notifyChannelChange()
    // Warm private-messages LiveKit room (shared highway for DMs + community SFU).
    if (channel.kind === 'community' || channel.kind === 'dm') {
      void this.ensurePrivateMessagesConnected()
    }
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

  /** Clear local history for a channel (or the active one). Frees translation memory for those lines. */
  clearChannelHistory(channel: ChatChannelChoice = this.channel): void {
    const key = channelKey(channel)
    const lines = this.messages.get(key) ?? []
    for (const line of lines) {
      chatTranslationService.clearMessage(line.id)
    }
    this.messages.set(key, [])
    this.unreadCounts.delete(key)
    this.notifyChannelChange()
  }

  /** True when this scene channel has a live LiveKit chat room (primary or multi-room). */
  isLiveSceneChannel(channel: ChatChannelChoice): boolean {
    if (channel.kind !== 'scene') return false
    return this.liveSceneKeys.has(channel.sceneKey)
  }

  getConnectedSceneKey(): string | null {
    return this.connectedSceneKey
  }

  /** Human label for notification banners / UI from a `socialChannelKey`. */
  labelForChannelKey(key: string): string {
    if (key.startsWith('scene:')) {
      const sceneKey = key.slice('scene:'.length)
      const tab = this.findSceneTab(sceneKey)
      return tab?.label?.trim() || sceneKey
    }
    if (key.startsWith('community:')) {
      const id = key.slice('community:'.length)
      const row = this.communities.find((c) => c.id.toLowerCase() === id)
      return row?.name?.trim() || 'Community'
    }
    if (key.startsWith('dm:')) {
      const addr = key.slice('dm:'.length)
      const profile = this.peerProfiles.get(addr)
      return profile?.displayName?.trim() || `${addr.slice(0, 6)}…${addr.slice(-4)}`
    }
    if (key === 'messages') return 'Direct messages'
    return 'Chat'
  }

  /**
   * Dismiss a scene chat tab (history + leave LiveKit via controller).
   * Any open multi-room tab can be closed, including the landing room.
   * Only removes the matching tab — never clears the rest of the list.
   */
  closeSceneTab(sceneKey: string): boolean {
    const want = sceneKey.trim().toLowerCase()
    if (!want) return false
    const idx = this.sceneTabs.findIndex((t) => t.key.trim().toLowerCase() === want)
    if (idx < 0) return false
    const tab = this.sceneTabs[idx]!
    const actualKey = tab.key
    this.sceneTabs.splice(idx, 1)
    // liveSceneKeys may store either raw or normalized pointer — clear both forms.
    this.liveSceneKeys.delete(actualKey)
    this.liveSceneKeys.delete(want)
    if (
      this.connectedSceneKey &&
      this.connectedSceneKey.trim().toLowerCase() === want
    ) {
      this.connectedSceneKey = null
    }
    const key = `scene:${actualKey}`
    const keyNorm = `scene:${want}`
    this.messages.delete(key)
    this.messages.delete(keyNorm)
    this.unreadCounts.delete(key)
    this.unreadCounts.delete(keyNorm)
    if (
      this.channel.kind === 'scene' &&
      this.channel.sceneKey.trim().toLowerCase() === want
    ) {
      const nextLive =
        [...this.liveSceneKeys]
          .map((k) => this.findSceneTab(k))
          .find((t): t is SceneChatTab => Boolean(t)) ?? null
      if (nextLive) {
        this.channel = { kind: 'scene', sceneKey: nextLive.key, label: nextLive.label }
      } else if (this.sceneTabs[0]) {
        const t = this.sceneTabs[0]
        this.channel = { kind: 'scene', sceneKey: t.key, label: t.label }
      } else {
        this.channel = { kind: 'messages' }
      }
    }
    this.notifyChannelChange()
    return true
  }

  /** Inbound chat from multi-room pool (sceneKey is the joined room). */
  ingestRemoteSceneChat(payload: {
    sceneKey: string
    senderAddress: string
    text: string
    time: number
  }): void {
    if (isSceneChatEmoteWireText(payload.text)) return
    if (this.isDuplicateChat(payload.senderAddress, payload.text, payload.time)) return
    const tab = this.findSceneTab(payload.sceneKey)
    const channel: ChatChannelChoice = {
      kind: 'scene',
      sceneKey: payload.sceneKey,
      label: tab?.label ?? payload.sceneKey
    }
    void this.ensurePeerProfile(payload.senderAddress)
    this.appendLine(channelKey(channel), {
      id: `in-${++lineCounter}`,
      text: payload.text,
      time: payload.time,
      senderAddress: payload.senderAddress
    })
  }

  /**
   * Re-run auto-translate policy for existing remote text lines in a channel
   * (e.g. after the user enables auto-translate mid-conversation).
   */
  backfillAutoTranslate(channel: ChatChannelChoice = this.channel): void {
    const key = channelKey(channel)
    const lines = this.messages.get(key) ?? []
    for (const line of lines) {
      if (isChatImageLine(line) || line.self) continue
      chatTranslationService.processIncoming({
        messageId: line.id,
        text: line.text,
        channelKey: key,
        isSelf: false,
        isImage: false
      })
    }
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
    const self = this.localAddress?.toLowerCase() ?? null
    const addrs = new Set<string>()
    // Live scene/world roster (same source as people list — includes gatekeeper seed)
    for (const addr of this.comms?.getSceneChatMentionAddresses() ?? []) {
      const low = addr.toLowerCase()
      if (self && low === self) continue
      if (isEvmAddress(low)) addrs.add(low)
    }
    // Anyone who already chatted (covers late joiners / roster lag)
    for (const line of this.getMessages()) {
      if (line.self || !line.senderAddress) continue
      const low = line.senderAddress.toLowerCase()
      if (self && low === self) continue
      if (isEvmAddress(low)) addrs.add(low)
    }
    return [...addrs]
      .map((address) => {
        const peer = this.getPeerDisplay(address)
        void this.peerProfiles.ensurePeer(address)
        return { address, displayName: peer.displayName, faceUrl: peer.faceUrl }
      })
      .sort((a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
      )
      .slice(0, 32)
  }

  /**
   * Live scene room roster for chat header / people list.
   * Local player + LiveKit/gatekeeper scene-room peers (same set as @-mentions).
   */
  getScenePresenceRows(): Array<{
    address: string
    displayName: string
    faceUrl: string | null
    isSelf: boolean
  }> {
    const rows: Array<{
      address: string
      displayName: string
      faceUrl: string | null
      isSelf: boolean
    }> = []
    const seen = new Set<string>()

    if (this.localAddress) {
      const local = this.getLocalDisplay()
      rows.push({
        address: this.localAddress,
        displayName: local.displayName,
        faceUrl: local.faceUrl,
        isSelf: true
      })
      seen.add(this.localAddress)
    }

    for (const addr of this.comms?.getSceneChatMentionAddresses() ?? []) {
      const key = addr.toLowerCase()
      if (seen.has(key) || !isEvmAddress(key)) continue
      seen.add(key)
      const peer = this.getPeerDisplay(key)
      rows.push({
        address: key,
        displayName: peer.displayName,
        faceUrl: peer.faceUrl,
        isSelf: false
      })
      void this.peerProfiles.ensurePeer(key)
    }

    rows.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
      return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    })
    return rows
  }

  getScenePresenceCount(): number {
    const remotes = this.comms?.getSceneChatMentionAddresses().length ?? 0
    const self = this.localAddress ? 1 : 0
    return remotes + self
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
    if (this.channel.kind !== 'scene') return false
    if (!this.isLiveSceneChannel(this.channel)) return false

    const prepared = await prepareChatImageFile(file)
    const messageId = createDcmMessageId()
    const time = Date.now() / 1000
    const envelopes = encodeDcmImageEnvelopes(prepared, messageId, time)
    const sceneKey = this.channel.sceneKey
    const sent = this.sceneChatMediaSend
      ? await this.sceneChatMediaSend(sceneKey, envelopes)
      : this.comms
        ? await this.comms.sendSceneChatMedia(envelopes)
        : false
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
    if (!trimmed) return false

    if (this.channel.kind === 'messages') {
      // Hub only — open a friend DM channel to send.
      return false
    }

    if (this.channel.kind === 'dm') {
      await this.ensurePrivateMessagesConnected()
      const peer = this.channel.peerAddress.toLowerCase()
      const sent = await this.privateMessages.sendTo(peer, trimmed)
      if (!sent) {
        clientDebugLog.log('social', 'DM send failed — private messages room not ready', {
          level: 'warn'
        })
        return false
      }
      this.appendLine(channelKey(this.channel), {
        id: `local-${++lineCounter}`,
        text: trimmed,
        time: Date.now() / 1000,
        self: true,
        senderAddress: this.localAddress ?? undefined
      })
      return true
    }

    if (this.channel.kind === 'community') {
      await this.ensurePrivateMessagesConnected()
      if (!this.privateMessages.isConnected()) {
        clientDebugLog.log('social', 'Community chat send failed — private-messages room not ready', {
          level: 'warn',
          alsoConsole: true
        })
        return false
      }
      const communityId = this.channel.communityId
      // Explorer parity: publish to message-router SFU with topic community:{id}.
      // Always show local line when publish succeeds (SFU does not echo to sender).
      const sent = await this.privateMessages.sendToCommunity(communityId, trimmed)
      if (!sent) {
        clientDebugLog.log('social', 'Community chat send failed — SFU route rejected', {
          level: 'warn',
          alsoConsole: true
        })
        return false
      }
      this.appendLine(channelKey(this.channel), {
        id: `local-${++lineCounter}`,
        text: trimmed,
        time: Date.now() / 1000,
        self: true,
        senderAddress: this.localAddress ?? undefined
      })
      return true
    }

    if (!this.isLiveSceneChannel(this.channel)) {
      console.warn('[chat] sendMessage failed — scene room not live', this.channel.sceneKey)
      return false
    }

    const sceneKey = this.channel.sceneKey
    const sent = this.sceneChatSend
      ? await this.sceneChatSend(sceneKey, trimmed)
      : this.comms
        ? await this.comms.sendSceneChat(trimmed)
        : false
    if (!sent) {
      console.warn('[chat] sendMessage failed — LiveKit publish returned false')
      return false
    }

    this.appendLine(channelKey(this.channel), {
      id: `local-${++lineCounter}`,
      text: trimmed,
      time: Date.now() / 1000,
      self: true,
      senderAddress: this.localAddress ?? undefined
    })
    return true
  }

  private async ensurePrivateMessagesConnected(): Promise<void> {
    if (!this.authIdentity || !this.localAddress) return
    if (this.privateMessages.isConnected()) return
    if (!this.unsubPrivateMessages) {
      this.unsubPrivateMessages = this.privateMessages.subscribe((ev) => {
        this.ingestPrivateMessage(ev.fromAddress, ev.text, ev.time)
      })
    }
    if (!this.unsubCommunityMessages) {
      this.unsubCommunityMessages = this.privateMessages.subscribeCommunity((ev) => {
        this.ingestCommunityMessage(ev.communityId, ev.fromAddress, ev.text, ev.time)
      })
    }
    await this.privateMessages.connect(this.authIdentity, this.localAddress)
    this.notifyChannelChange()
  }

  private teardownPrivateMessages(): void {
    this.unsubPrivateMessages?.()
    this.unsubPrivateMessages = null
    this.unsubCommunityMessages?.()
    this.unsubCommunityMessages = null
    this.privateMessages.disconnect()
  }

  private ingestPrivateMessage(fromAddress: string, text: string, time: number): void {
    const peer = fromAddress.toLowerCase()
    const key = `dm:${peer}`
    const profile = this.peerProfiles.get(peer)
    this.appendLine(key, {
      id: `remote-${++lineCounter}`,
      text,
      time,
      self: false,
      senderAddress: peer,
      senderName: profile?.displayName
    })
    // Unread when not actively reading this DM thread.
    if (!(this.channel.kind === 'dm' && this.channel.peerAddress.toLowerCase() === peer && this.channelThreadOpen)) {
      const prev = this.unreadCounts.get(key) ?? 0
      this.unreadCounts.set(key, prev + 1)
      this.notifyChannelChange()
    }
    void this.peerProfiles.ensurePeer(peer)
  }

  private ingestCommunityMessage(
    communityId: string,
    fromAddress: string,
    text: string,
    time: number
  ): void {
    const id = communityId.toLowerCase()
    // Only surface messages for communities we belong to (rail membership list).
    const known = this.communities.some((c) => c.id.toLowerCase() === id)
    if (!known) return

    const key = `community:${id}`
    const peer = fromAddress.toLowerCase()
    const profile = this.peerProfiles.get(peer)
    this.appendLine(key, {
      id: `remote-${++lineCounter}`,
      text,
      time,
      self: false,
      senderAddress: peer,
      senderName: profile?.displayName
    })
    const viewing =
      this.channel.kind === 'community' &&
      this.channel.communityId.toLowerCase() === id &&
      this.channelThreadOpen
    if (!viewing) {
      const prev = this.unreadCounts.get(key) ?? 0
      this.unreadCounts.set(key, prev + 1)
      this.notifyChannelChange()
    }
    void this.peerProfiles.ensurePeer(peer)
  }

  /**
   * Re-bind chat/media handlers after LiveKit handoff (landing → World).
   * Handoff clears shell handlers; without this, 3D ChatPanel stays silent while 2D
   * still had pool/landing handlers.
   */
  rewireComms(comms: CommsService | null): void {
    this.comms = comms
    if (comms) this.wireCommsHandlers()
  }

  /**
   * Landing → play handoff: drop the shell's CommsService **reference** without
   * calling setChatHandler(null). World now owns that service and will rewire chat;
   * dispose() must not wipe World's handlers later.
   */
  releaseCommsOwnership(): void {
    this.comms = null
    this.sceneChatSend = null
    this.sceneChatMediaSend = null
  }

  private wireCommsHandlers(): void {
    if (!this.comms) return
    // Primary CommsService room only — multi-room pool uses ingestRemoteSceneChat.
    this.comms.setChatHandler((payload) => {
      const sceneChannel = this.primarySceneChannelChoice()
      if (!sceneChannel) {
        console.warn(
          '[chat] inbound dropped — no scene channel (connectedSceneKey missing). text=',
          payload.text.slice(0, 40)
        )
        return
      }
      if (isSceneChatEmoteWireText(payload.text)) return
      if (this.isDuplicateChat(payload.senderAddress, payload.text, payload.time)) return
      void this.ensurePeerProfile(payload.senderAddress)
      this.appendLine(channelKey(sceneChannel), {
        id: `in-${++lineCounter}`,
        text: payload.text,
        time: payload.time,
        senderAddress: payload.senderAddress
      })
      console.log(
        `[chat] 3d inbound ← ${payload.senderAddress.slice(0, 10)}… ${payload.text.slice(0, 48)}`
      )
    })

    this.comms.setChatMediaHandler((payload) => {
      const sceneChannel = this.primarySceneChannelChoice()
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

  private primarySceneChannelChoice(): ChatChannelChoice | null {
    if (this.channel.kind === 'scene') {
      return {
        kind: 'scene',
        sceneKey: this.channel.sceneKey,
        label: this.channel.label
      }
    }
    if (this.connectedSceneKey) {
      const tab = this.findSceneTab(this.connectedSceneKey)
      if (tab) return { kind: 'scene', sceneKey: tab.key, label: tab.label }
    }
    const tab = this.sceneTabs[0]
    if (tab) return { kind: 'scene', sceneKey: tab.key, label: tab.label }
    return null
  }

  private findSceneTab(key: string): SceneChatTab | undefined {
    const want = key.trim().toLowerCase()
    if (!want) return undefined
    return (
      this.sceneTabs.find((tab) => tab.key === key) ??
      this.sceneTabs.find((tab) => tab.key.trim().toLowerCase() === want)
    )
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
    // Landing pointer for primary CommsService routing (cast / handoff).
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
    // Only clear handlers when we still own the service. After handoff, shell
    // social.releaseCommsOwnership() leaves this.comms null so World's rewire survives.
    if (this.comms) {
      this.comms.setChatHandler(null)
      this.comms.setChatMediaHandler(null)
    }
    this.teardownPrivateMessages()
    for (const url of this.mediaObjectUrls) URL.revokeObjectURL(url)
    this.mediaObjectUrls.clear()
    this.comms = null
    this.sceneChatSend = null
    this.sceneChatMediaSend = null
    this.listeners.clear()
    this.channelListeners.clear()
    this.messages.clear()
    this.unreadCounts.clear()
    this.channelThreadOpen = false
    this.sceneTabs = []
    this.connectedSceneKey = null
    this.liveSceneKeys.clear()
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
    if (bucket.length > 200) {
      for (const dropped of bucket.splice(0, bucket.length - 200)) {
        chatTranslationService.clearMessage(dropped.id)
      }
    }
    this.messages.set(key, bucket)
    const isIncoming = !line.self
    const isActiveChannel = key === channelKey(this.channel)
    const countsAsUnread = isIncoming && (!isActiveChannel || !this.channelThreadOpen)
    if (countsAsUnread) {
      this.unreadCounts.set(key, (this.unreadCounts.get(key) ?? 0) + 1)
      this.notifyChannelChange()
    }
    for (const listener of this.listeners) listener({ channelKey: key, line })

    // Unity Explorer ChatHistoryService → ProcessIncomingMessage (remote text only).
    if (!isChatImageLine(line) && !line.self) {
      chatTranslationService.processIncoming({
        messageId: line.id,
        text: line.text,
        channelKey: key,
        isSelf: false,
        isImage: false
      })
    }
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
