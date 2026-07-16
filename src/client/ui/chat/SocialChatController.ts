import type { LoginResult } from '../../../auth/AuthClient'
import { identityFromAvatarProfile } from '../../../avatar/displayName'
import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import type { RouteTarget } from '../../../dcl/content/route'
import { parseRouteTarget } from '../../../dcl/content/route'
import { resolveSceneFromRoute } from '../../../dcl/content/resolveScene'
import { fetchPublicSceneTitle } from '../../../social/sceneDisplayTitle'
import type { ResolvedScene } from '../../../dcl/content/types'
import { clientDebugLog } from '../../debug/ClientDebugLog'
import { CommsService, type SceneCommsTarget } from '../../../network/CommsService'
import { blacklistFromMetadata } from '../../../network/sceneAccess/sceneAccessCommon'
import { SessionIdentity } from '../../../network/SessionIdentity'
import { SceneChatRoomPool } from '../../../social/SceneChatRoomPool'
import { resolveSceneChatAdapter } from '../../../social/resolveSceneChatAdapter'
import { SocialService } from '../../../social/SocialService'
import type { SceneLoadErrorMessage } from '../../formatSceneLoadError'
import { UserProfileModal } from '../profile/UserProfileModal'

export type SocialChatStatus =
  | { kind: 'idle' }
  | { kind: 'guest' }
  | { kind: 'connecting' }
  | { kind: 'connected'; sceneLabel: string }
  | { kind: 'browser_chat_disabled'; sceneLabel: string }
  | { kind: 'duplicate_wallet' }
  | { kind: 'scene_ban'; title: string; detail: string }
  | { kind: 'failed'; message: string }

export type SocialChatControllerOptions = {
  onStatusChange?: () => void
}

function buildCommsTarget(scene: ResolvedScene): SceneCommsTarget {
  const isWorld = scene.source.kind === 'world'
  // Worlds: use lowercased commsPointer for gatekeeper (matches scene-stream-access + companion).
  // about.realmName can be mixed-case (RickRoll.dcl.eth) and would join a different LiveKit room.
  const realmName = isWorld
    ? scene.commsPointer.trim().toLowerCase()
    : scene.realm.realmName?.trim() || 'main'
  return {
    pointer: scene.commsPointer,
    baseParcel: scene.baseParcel,
    sceneId: scene.entityId ?? '',
    realmName,
    contentUrl: scene.realm.contentUrl,
    parcels: scene.parcels,
    isWorld,
    sceneTitle: scene.title,
    metadataBlacklist: blacklistFromMetadata(scene.metadata)
  }
}

function normalizeSceneKey(pointer: string): string {
  return pointer.trim().toLowerCase()
}

/**
 * Owns 2D-shell multi-room chat + landing cast/video.
 * Chat rooms stay joined in SceneChatRoomPool when navigating; CommsService is only the
 * current landing room (cast + presence handoff) — never steals background pool rooms.
 */
export class SocialChatController {
  /** Primary landing LiveKit — transferred to World on Jump In (no disconnect). */
  private comms: CommsService = new CommsService()
  private social = new SocialService()
  private readonly session = new SessionIdentity()
  private readonly chatPool = new SceneChatRoomPool({
    onChat: (msg) => {
      this.social.ingestRemoteSceneChat(msg)
    }
  })
  private profileModal: UserProfileModal | null = null
  private login: LoginResult | null = null
  private status: SocialChatStatus = { kind: 'idle' }
  /** Primary CommsService landing pointer (cast / handoff). */
  private connectedPointer: string | null = null
  private disposed = false
  private shellInitPromise: Promise<void> | null = null
  /** Single-flight primary connect (landing). */
  private connectPromise: Promise<boolean> | null = null
  private connectPromiseKey: string | null = null
  private readonly onStatusChange?: () => void

  constructor(opts: SocialChatControllerOptions = {}) {
    this.onStatusChange = opts.onStatusChange
    this.wireSocialTransport()
  }

  getSocial(): SocialService {
    return this.social
  }

  getStatus(): SocialChatStatus {
    return this.status
  }

  getContentUrl(): string {
    return this.session.getLambdasUrl().replace(/\/lambdas$/, '')
  }

  /** Active scene-room LiveKit Cast/OBS video presence. */
  hasRemoteVideoLive(): boolean {
    return this.comms.hasRemoteVideoLive()
  }

  /** True when world/scene LiveKit is up (Join live can be offered). */
  isLiveKitConnected(): boolean {
    return this.comms.isLiveKitConnected()
  }

  /**
   * Watch for remote LiveKit video (Cast / stream keys). Returns unsubscribe.
   * Dynamically tracks world + scene rooms and keeps polling after OBS goes live.
   */
  watchRemoteVideoLive(onChange: (live: boolean) => void): () => void {
    return this.comms.watchRemoteVideoLive(onChange)
  }

  /** Bind landing/player element to current Cast video track. */
  bindLiveKitVideoSource(video: HTMLVideoElement, onUpdate?: () => void): () => void {
    return this.comms.bindLiveKitVideoSource(video, onUpdate)
  }

  /** Companion-style Cast: attach best remote video into a host div. */
  bindRemoteCastVideoToHost(
    host: HTMLElement,
    onUpdate?: (attached: boolean) => void,
    opts?: { muted?: boolean; volume?: number }
  ): () => void {
    return this.comms.bindRemoteCastVideoToHost(host, onUpdate, opts)
  }

  applyLogin(login: LoginResult | null): void {
    this.login = login
    this.session.applyLogin(login)
    if (login && (login.kind === 'wallet' || login.kind === 'guest')) {
      this.comms.setIdentity(login.address, login.identity)
      this.chatPool.setIdentity(login.address, login.identity)
      if (this.status.kind === 'guest') this.setStatus({ kind: 'idle' })
      void this.ensureShellInit()
      return
    }
    this.chatPool.leaveAll()
    this.comms.disconnect()
    this.connectedPointer = null
    this.comms.setIdentity(undefined, null)
    this.chatPool.setIdentity(undefined, null)
    this.profileModal?.hide()
    this.setStatus({ kind: 'guest' })
  }

  /** Wallet sign-out from 2D shell — tear down comms, social state, and profile UI. */
  signOut(): void {
    if (this.disposed) return
    this.chatPool.leaveAll()
    this.comms.disconnect()
    this.connectedPointer = null
    this.comms.setIdentity(undefined, null)
    this.chatPool.setIdentity(undefined, null)
    this.profileModal?.dispose()
    this.profileModal = null
    this.social.dispose()
    this.social = new SocialService()
    this.wireSocialTransport()
    this.login = null
    this.session.applyLogin(null)
    this.setStatus({ kind: 'guest' })
  }

  async ensureShellInit(): Promise<void> {
    if (this.disposed) return
    if (!this.login || (this.login.kind !== 'wallet' && this.login.kind !== 'guest')) return
    if (this.social.isReady()) return
    if (this.shellInitPromise) {
      await this.shellInitPromise
      return
    }
    this.shellInitPromise = this.runShellInit().finally(() => {
      this.shellInitPromise = null
    })
    await this.shellInitPromise
  }

  /**
   * Join (or keep) LiveKit chat for a scene tab without dropping other multi-room joins.
   * Does not switch the primary CommsService landing room.
   */
  async ensureSceneChannelLive(sceneKey: string): Promise<boolean> {
    if (this.disposed) return false
    const key = normalizeSceneKey(sceneKey)
    const tab = this.social.getSceneTabs().find((row) => normalizeSceneKey(row.key) === key)
    if (!tab) return false
    if (tab.browserChatEnabled === false) return false

    // Already live via primary landing room or pool.
    if (
      this.connectedPointer &&
      normalizeSceneKey(this.connectedPointer) === key &&
      this.comms.isLiveKitConnected()
    ) {
      this.syncLiveKeys()
      return true
    }
    if (this.chatPool.isJoined(key)) {
      this.syncLiveKeys()
      return true
    }

    return this.joinPoolForTab(tab.key)
  }

  /** Leave LiveKit for a tab and remove it from the channel list. */
  closeSceneChannel(sceneKey: string): boolean {
    if (this.disposed) return false
    const key = normalizeSceneKey(sceneKey)
    this.chatPool.leave(key)
    if (this.connectedPointer && normalizeSceneKey(this.connectedPointer) === key) {
      // Keep cast/landing optional: user closed chat — drop primary room too so identity frees.
      this.comms.disconnect()
      this.connectedPointer = null
      if (this.status.kind === 'connected' || this.status.kind === 'browser_chat_disabled') {
        this.setStatus({ kind: 'idle' })
      }
    }
    const closed = this.social.closeSceneTab(sceneKey)
    this.syncLiveKeys()
    return closed
  }

  private routeConnectKey(route: RouteTarget): string {
    if (route.kind === 'world') return route.worldName.trim().toLowerCase()
    if (route.kind === 'coords') return `${route.x},${route.y}`
    return ''
  }

  async connectForRoute(route: RouteTarget): Promise<boolean> {
    if (this.disposed) return false
    if (route.kind !== 'coords' && route.kind !== 'world') return false

    const key = this.routeConnectKey(route)
    // Same target already connecting — await that join (don't no-op false).
    if (this.connectPromise && this.connectPromiseKey === key) {
      return this.connectPromise
    }
    // Different target in flight — wait, then start this one.
    if (this.connectPromise) {
      await this.connectPromise.catch(() => false)
    }
    if (this.disposed) return false

    this.connectPromiseKey = key
    this.connectPromise = this.connectForRouteExclusive(route).finally(() => {
      if (this.connectPromiseKey === key) {
        this.connectPromise = null
        this.connectPromiseKey = null
      }
    })
    return this.connectPromise
  }

  private async connectForRouteExclusive(
    route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
  ): Promise<boolean> {
    if (!this.login || (this.login.kind !== 'wallet' && this.login.kind !== 'guest')) {
      this.setStatus({ kind: 'guest' })
      return false
    }

    await this.ensureShellInit()
    if (this.disposed) return false

    this.setStatus({ kind: 'connecting' })
    try {
      const scene = await resolveSceneFromRoute(route)
      if (this.disposed) return false

      const sceneLabel = (await fetchPublicSceneTitle(route, scene.title)).trim() || scene.commsPointer
      const sceneTab = {
        key: scene.commsPointer,
        label: sceneLabel,
        pointer: scene.commsPointer,
        browserChatEnabled: scene.browserChatEnabled
      }
      const newKey = scene.commsPointer
      const prevKey = this.connectedPointer

      // Already primary-connected to this landing.
      if (
        prevKey === newKey &&
        this.comms.isLiveKitConnected() &&
        this.social.getSceneTabs().some((tab) => tab.key === newKey)
      ) {
        await this.social.attachSceneComms({
          comms: scene.browserChatEnabled ? this.comms : null,
          sceneTab,
          contentUrl: scene.realm.contentUrl
        })
        // Drop pool room for this key if any (primary owns it).
        if (this.chatPool.isJoined(newKey)) this.chatPool.leave(newKey)
        this.syncLiveKeys()
        this.setStatus(
          scene.browserChatEnabled
            ? { kind: 'connected', sceneLabel }
            : { kind: 'browser_chat_disabled', sceneLabel }
        )
        return true
      }

      // Prefetch previous landing adapter so we can re-join it on the pool after primary leaves.
      const migrateAdapterPromise =
        prevKey && normalizeSceneKey(prevKey) !== normalizeSceneKey(newKey)
          ? this.resolveAdapterForSceneKey(prevKey)
          : Promise.resolve(null)

      if (!scene.browserChatEnabled) {
        this.comms.disconnect()
        this.connectedPointer = null
        await this.joinPoolAfterPrimaryLeft(prevKey, newKey, await migrateAdapterPromise)
        await this.social.attachSceneComms({
          comms: null,
          sceneTab,
          contentUrl: scene.realm.contentUrl
        })
        this.connectedPointer = scene.commsPointer
        this.syncLiveKeys()
        this.setStatus({ kind: 'browser_chat_disabled', sceneLabel })
        clientDebugLog.log('social', '2D shell scene chat disabled by scene.json', { level: 'info' })
        return true
      }

      // Avoid double-identity on the same LiveKit room: pool must leave before primary joins.
      if (this.chatPool.isJoined(newKey)) {
        this.chatPool.leave(newKey)
      }

      this.session.setCatalystEndpoints(scene.realm.contentUrl, scene.realm.lambdasUrl)
      this.comms.setIdentity(this.login.address, this.login.identity)
      this.chatPool.setIdentity(this.login.address, this.login.identity)
      this.comms.applyRealmAbout(scene.realm, scene.commsPointer)
      if (!this.session.getProfile()) {
        await this.session.connect()
      }
      this.comms.setCommsProfile(this.session.getCommsProfileEntity())
      this.comms.setLambdasUrl(scene.realm.lambdasUrl)
      this.chatPool.setLambdasUrl(scene.realm.lambdasUrl)

      // connectSceneRoom disconnects previous primary — migrate that room into the pool after.
      const connectResult = await this.comms.connectSceneRoom(buildCommsTarget(scene))
      const migrate = await migrateAdapterPromise
      if (!connectResult.ok) {
        this.connectedPointer = null
        await this.joinPoolAfterPrimaryLeft(prevKey, newKey, migrate)
        if (connectResult.reason === 'duplicate_wallet') {
          this.setStatus({ kind: 'duplicate_wallet' })
        } else if (connectResult.reason === 'no_identity') {
          this.setStatus({ kind: 'guest' })
        } else if (connectResult.reason === 'scene_ban') {
          this.applySceneBan({
            title: "You're banned from this place",
            detail: 'Your wallet cannot join chat in this place.'
          })
        } else {
          this.setStatus({ kind: 'failed', message: 'Could not join scene chat' })
        }
        this.syncLiveKeys()
        return false
      }

      await this.social.attachSceneComms({
        comms: this.comms,
        sceneTab,
        contentUrl: scene.realm.contentUrl
      })

      this.connectedPointer = scene.commsPointer

      // Keep previous landing chat live in the multi-room pool (dcl-companion style).
      await this.joinPoolAfterPrimaryLeft(prevKey, newKey, migrate)

      this.syncLiveKeys()
      this.setStatus({ kind: 'connected', sceneLabel })
      void this.hydrateLocalProfile()
      clientDebugLog.log(
        'social',
        `2D shell multi-room · primary=${scene.commsPointer} · pool=[${this.chatPool.getJoinedKeys().join(', ')}]`,
        { level: 'success', alsoConsole: true }
      )
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('social', `2D shell chat connect failed: ${msg}`, {
        level: 'error',
        alsoConsole: true
      })
      this.setStatus({ kind: 'failed', message: msg })
      this.syncLiveKeys()
      return false
    }
  }

  openProfileForAddress(address: string): void {
    const modal = this.ensureProfileModal()
    const local =
      this.login?.kind === 'wallet' || this.login?.kind === 'guest'
        ? this.login.address.toLowerCase()
        : null
    if (local && address.toLowerCase() === local) {
      void modal.show({ kind: 'local' })
      return
    }
    void modal.show({ kind: 'remote', address: address.toLowerCase() })
  }

  /** Mid-session or pre-connect ban — tear down comms and block scene chat. */
  applySceneBan(message: SceneLoadErrorMessage): void {
    if (this.disposed) return
    const key = this.connectedPointer
    if (key) this.chatPool.leave(key)
    this.comms.disconnect()
    this.connectedPointer = null
    const sceneTab = this.social.getSceneTabs()[0]
    if (sceneTab) {
      void this.social.attachSceneComms({
        comms: null,
        sceneTab,
        contentUrl: this.getContentUrl()
      })
    }
    this.syncLiveKeys()
    this.setStatus({ kind: 'scene_ban', title: message.title, detail: message.detail })
  }

  /**
   * Landing → play for `targetPointer`:
   * - Tear down every multi-room LiveKit that is **not** the jump target
   * - If primary is already that scene, transfer it (no disconnect)
   * - If primary is a different scene, disconnect it so World can join clean
   */
  detachCommsForWorldHandoff(targetPointer: string): CommsService | null {
    if (this.disposed) return null

    const target = normalizeSceneKey(targetPointer)
    // Drop background chat rooms for every other place.
    this.chatPool.leaveExcept(target)
    // Primary must not also sit in the pool under the same identity.
    if (this.chatPool.isJoined(target)) {
      this.chatPool.leave(target)
    }

    const primary = this.connectedPointer ? normalizeSceneKey(this.connectedPointer) : null
    const primaryLive = this.comms.isLiveKitConnected()

    // Wrong scene still connected — must not hand off foreign rooms.
    if (primaryLive && primary && primary !== target) {
      clientDebugLog.log(
        'social',
        `Jump-in target ${target} ≠ primary ${primary} — disconnecting foreign LiveKit`,
        { level: 'warn', alsoConsole: true }
      )
      this.comms.disconnect()
      this.connectedPointer = null
      this.syncLiveKeys()
      if (this.status.kind === 'connected' || this.status.kind === 'browser_chat_disabled') {
        this.setStatus({ kind: 'connecting' })
      }
      return null
    }

    if (!primaryLive) {
      this.connectedPointer = null
      this.syncLiveKeys()
      clientDebugLog.log('social', 'No live primary comms to transfer — World will connect', {
        level: 'info',
        alsoConsole: true
      })
      return null
    }

    // Clear shell chat handlers; World installs avatar/movement handlers on the same service.
    this.comms.setChatHandler(null)
    this.comms.setChatMediaHandler(null)
    this.comms.setHandlers(null)

    const transferred = this.comms
    // Shell gets a blank CommsService — must NOT dispose `transferred` (World owns it now).
    this.comms = new CommsService()
    if (this.login && (this.login.kind === 'wallet' || this.login.kind === 'guest')) {
      this.comms.setIdentity(this.login.address, this.login.identity)
      this.chatPool.setIdentity(this.login.address, this.login.identity)
    }
    this.connectedPointer = null
    this.syncLiveKeys()
    if (this.status.kind === 'connected' || this.status.kind === 'browser_chat_disabled') {
      this.setStatus({ kind: 'connecting' })
    }
    console.log(
      '[comms] Transferred LiveKit for',
      target,
      'to World (no disconnect) ·',
      transferred.describeLiveKitRooms()
    )
    clientDebugLog.log(
      'social',
      `Transferred LiveKit for ${target} to World (no disconnect) · pool cleared of others`,
      { level: 'success', alsoConsole: true }
    )
    return transferred
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.chatPool.leaveAll()
    this.social.dispose()
    this.comms.dispose()
    this.profileModal?.dispose()
    this.profileModal = null
    this.connectedPointer = null
    this.setStatus({ kind: 'idle' })
  }

  private wireSocialTransport(): void {
    this.social.setSceneChatTransport({
      send: (sceneKey, text) => this.sendSceneChat(sceneKey, text),
      sendMedia: (sceneKey, envelopes) => this.sendSceneChatMedia(sceneKey, envelopes)
    })
  }

  private async sendSceneChat(sceneKey: string, text: string): Promise<boolean> {
    const key = normalizeSceneKey(sceneKey)
    if (this.chatPool.isJoined(key)) {
      return this.chatPool.sendChat(key, text)
    }
    if (
      this.connectedPointer &&
      normalizeSceneKey(this.connectedPointer) === key &&
      this.comms.isLiveKitConnected()
    ) {
      return this.comms.sendSceneChat(text)
    }
    console.warn(`[chat] send skip — no live room for ${sceneKey}`)
    return false
  }

  private async sendSceneChatMedia(sceneKey: string, envelopes: Uint8Array[]): Promise<boolean> {
    const key = normalizeSceneKey(sceneKey)
    if (this.chatPool.isJoined(key)) {
      return this.chatPool.sendChatMedia(key, envelopes)
    }
    if (
      this.connectedPointer &&
      normalizeSceneKey(this.connectedPointer) === key &&
      this.comms.isLiveKitConnected()
    ) {
      return this.comms.sendSceneChatMedia(envelopes)
    }
    return false
  }

  private syncLiveKeys(): void {
    const keys = new Set<string>(this.chatPool.getJoinedKeys())
    if (this.connectedPointer && this.comms.isLiveKitConnected()) {
      keys.add(this.connectedPointer)
    }
    // Also keep browser-disabled landing marked non-live (not added).
    this.social.syncLiveSceneKeys(keys)
  }

  private async joinPoolForTab(sceneKey: string): Promise<boolean> {
    if (this.disposed) return false
    if (!this.login || (this.login.kind !== 'wallet' && this.login.kind !== 'guest')) return false

    const resolved = await this.resolveAdapterForSceneKey(sceneKey)
    if (!resolved) return false

    // Never pool-join the primary room (same LiveKit identity would conflict).
    if (
      this.connectedPointer &&
      normalizeSceneKey(this.connectedPointer) === normalizeSceneKey(sceneKey) &&
      this.comms.isLiveKitConnected()
    ) {
      this.syncLiveKeys()
      return true
    }

    this.chatPool.setIdentity(this.login.address, this.login.identity)
    const ok = await this.chatPool.join({
      sceneKey,
      label: resolved.label,
      adapter: resolved.adapter,
      isWorldChat: resolved.isWorldChat
    })
    this.syncLiveKeys()
    return ok
  }

  private async resolveAdapterForSceneKey(
    sceneKey: string
  ): Promise<{ adapter: string; isWorldChat: boolean; label: string } | null> {
    if (!this.login || (this.login.kind !== 'wallet' && this.login.kind !== 'guest')) return null
    const tab = this.social.getSceneTabs().find((t) => normalizeSceneKey(t.key) === normalizeSceneKey(sceneKey))
    const pointer = tab?.pointer ?? sceneKey
    const route = parseRouteTarget(pointer)
    if (route.kind !== 'coords' && route.kind !== 'world') return null
    try {
      const scene = await resolveSceneFromRoute(route)
      if (this.disposed) return null
      const result = await resolveSceneChatAdapter(scene, this.login.identity)
      if (!result.ok) {
        clientDebugLog.log('social', `Multi-room adapter failed · ${sceneKey}: ${result.reason}`, {
          level: 'warn',
          alsoConsole: true
        })
        return null
      }
      return {
        adapter: result.adapter,
        isWorldChat: result.isWorldChat,
        label: tab?.label ?? scene.title ?? sceneKey
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('social', `Multi-room resolve failed · ${sceneKey}: ${msg}`, {
        level: 'warn',
        alsoConsole: true
      })
      return null
    }
  }

  /**
   * After primary CommsService has left `prevKey`, re-join that room on the multi-room pool
   * so background tabs stay live (same pattern as dcl-companion multi-text-chats).
   */
  private async joinPoolAfterPrimaryLeft(
    prevKey: string | null,
    nextKey: string | null,
    resolved: { adapter: string; isWorldChat: boolean; label: string } | null
  ): Promise<void> {
    if (!prevKey || !resolved) return
    if (nextKey && normalizeSceneKey(prevKey) === normalizeSceneKey(nextKey)) return
    if (this.disposed) return
    const stillOpen = this.social
      .getSceneTabs()
      .some((t) => normalizeSceneKey(t.key) === normalizeSceneKey(prevKey))
    if (!stillOpen) return
    if (this.chatPool.isJoined(prevKey)) return
    if (this.login && (this.login.kind === 'wallet' || this.login.kind === 'guest')) {
      this.chatPool.setIdentity(this.login.address, this.login.identity)
    }
    const ok = await this.chatPool.join({
      sceneKey: prevKey,
      label: resolved.label,
      adapter: resolved.adapter,
      isWorldChat: resolved.isWorldChat
    })
    if (ok) {
      clientDebugLog.log(
        'social',
        `Multi-room keep-alive · ${resolved.label} (${prevKey}) · pool=${this.chatPool.getJoinedKeys().length}`,
        { level: 'success', alsoConsole: true }
      )
    }
  }

  private async runShellInit(): Promise<void> {
    if (!this.login || (this.login.kind !== 'wallet' && this.login.kind !== 'guest')) return
    await this.session.connect()
    const login = this.login
    const isGuest = login.kind === 'guest'
    this.chatPool.setIdentity(login.address, login.identity)
    this.chatPool.setLambdasUrl(this.session.getLambdasUrl())
    await this.social.initShell({
      address: login.address,
      identity: login.identity,
      contentUrl: this.getContentUrl(),
      isGuest,
      displayName: login.kind === 'guest' ? login.displayName : undefined
    })
    this.wireSocialTransport()
    void this.hydrateLocalProfile()
    this.onStatusChange?.()
  }

  private ensureProfileModal(): UserProfileModal {
    if (!this.profileModal) {
      this.profileModal = new UserProfileModal(
        this.session,
        this.social,
        () => this.getContentUrl()
      )
    }
    return this.profileModal
  }

  private async hydrateLocalProfile(): Promise<void> {
    if (this.disposed) return
    if (!this.login || (this.login.kind !== 'wallet' && this.login.kind !== 'guest')) return
    const address = this.login.address
    const guestName = this.login.kind === 'guest' ? this.login.displayName : undefined
    const profile = this.session.getProfile()
    if (profile) {
      const identity = identityFromAvatarProfile(profile, address)
      const faceUrl = await fetchProfileFaceUrl(address, this.session.getLambdasUrl())
      if (this.disposed) return
      this.social.setLocalProfile(
        address,
        guestName || identity.displayName,
        faceUrl,
        identity.nameColor
      )
      return
    }
    if (guestName) {
      this.social.setLocalProfile(address, guestName, null, '#ffffff')
    }
    const faceUrl = await fetchProfileFaceUrl(address, this.session.getLambdasUrl())
    if (this.disposed) return
    this.social.setLocalFaceUrl(faceUrl)
  }

  private setStatus(status: SocialChatStatus): void {
    this.status = status
    this.onStatusChange?.()
  }
}
