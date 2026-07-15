import type { LoginResult } from '../../../auth/AuthClient'
import { identityFromAvatarProfile } from '../../../avatar/displayName'
import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import type { RouteTarget } from '../../../dcl/content/route'
import { resolveSceneFromRoute } from '../../../dcl/content/resolveScene'
import { fetchPublicSceneTitle } from '../../../social/sceneDisplayTitle'
import type { ResolvedScene } from '../../../dcl/content/types'
import { clientDebugLog } from '../../debug/ClientDebugLog'
import { CommsService, type SceneCommsTarget } from '../../../network/CommsService'
import { blacklistFromMetadata } from '../../../network/sceneAccess/sceneAccessCommon'
import { SessionIdentity } from '../../../network/SessionIdentity'
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

/** Owns 2D-shell comms + social state — separate from in-world World chat. */
export class SocialChatController {
  private readonly comms = new CommsService()
  private social = new SocialService()
  private readonly session = new SessionIdentity()
  private profileModal: UserProfileModal | null = null
  private login: LoginResult | null = null
  private status: SocialChatStatus = { kind: 'idle' }
  private connectedPointer: string | null = null
  private connecting = false
  private disposed = false
  private shellInitPromise: Promise<void> | null = null
  private readonly onStatusChange?: () => void

  constructor(opts: SocialChatControllerOptions = {}) {
    this.onStatusChange = opts.onStatusChange
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
      if (this.status.kind === 'guest') this.setStatus({ kind: 'idle' })
      void this.ensureShellInit()
      return
    }
    this.comms.disconnect()
    this.connectedPointer = null
    this.comms.setIdentity(undefined, null)
    this.profileModal?.hide()
    this.setStatus({ kind: 'guest' })
  }

  /** Wallet sign-out from 2D shell — tear down comms, social state, and profile UI. */
  signOut(): void {
    if (this.disposed) return
    this.comms.disconnect()
    this.connectedPointer = null
    this.comms.setIdentity(undefined, null)
    this.profileModal?.dispose()
    this.profileModal = null
    this.social.dispose()
    this.social = new SocialService()
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

  async connectForRoute(route: RouteTarget): Promise<boolean> {
    if (this.disposed) return false
    if (route.kind !== 'coords' && route.kind !== 'world') return false
    if (this.connecting) return false

    if (!this.login || (this.login.kind !== 'wallet' && this.login.kind !== 'guest')) {
      this.setStatus({ kind: 'guest' })
      return false
    }

    await this.ensureShellInit()
    if (this.disposed) return false

    this.connecting = true
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

      if (
        this.connectedPointer === scene.commsPointer &&
        this.social.getSceneTabs().some((tab) => tab.key === scene.commsPointer)
      ) {
        await this.social.attachSceneComms({
          comms: scene.browserChatEnabled ? this.comms : null,
          sceneTab,
          contentUrl: scene.realm.contentUrl
        })
        this.setStatus(
          scene.browserChatEnabled
            ? { kind: 'connected', sceneLabel }
            : { kind: 'browser_chat_disabled', sceneLabel }
        )
        return true
      }

      if (!scene.browserChatEnabled) {
        this.comms.disconnect()
        await this.social.attachSceneComms({
          comms: null,
          sceneTab,
          contentUrl: scene.realm.contentUrl
        })
        this.connectedPointer = scene.commsPointer
        this.setStatus({ kind: 'browser_chat_disabled', sceneLabel })
        clientDebugLog.log('social', '2D shell scene chat disabled by scene.json', { level: 'info' })
        return true
      }

      this.session.setCatalystEndpoints(scene.realm.contentUrl, scene.realm.lambdasUrl)
      this.comms.setIdentity(this.login.address, this.login.identity)
      this.comms.applyRealmAbout(scene.realm, scene.commsPointer)
      if (!this.session.getProfile()) {
        await this.session.connect()
      }
      this.comms.setCommsProfile(this.session.getCommsProfileEntity())
      this.comms.setLambdasUrl(scene.realm.lambdasUrl)

      const connectResult = await this.comms.connectSceneRoom(buildCommsTarget(scene))
      if (!connectResult.ok) {
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
        return false
      }

      await this.social.attachSceneComms({
        comms: this.comms,
        sceneTab,
        contentUrl: scene.realm.contentUrl
      })

      this.connectedPointer = scene.commsPointer
      this.setStatus({ kind: 'connected', sceneLabel })
      void this.hydrateLocalProfile()
      clientDebugLog.log('social', '2D shell scene chat connected', { level: 'success' })
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('social', `2D shell chat connect failed: ${msg}`, { level: 'error' })
      this.setStatus({ kind: 'failed', message: msg })
      return false
    } finally {
      this.connecting = false
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
    this.setStatus({ kind: 'scene_ban', title: message.title, detail: message.detail })
  }

  /** Disconnect 2D-shell comms so World can join the same room (landing → play handoff). */
  releaseCommsForWorldHandoff(): void {
    if (this.disposed) return
    this.comms.disconnect()
    this.connectedPointer = null
    if (this.status.kind === 'connected' || this.status.kind === 'browser_chat_disabled') {
      this.setStatus({ kind: 'connecting' })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.social.dispose()
    this.comms.dispose()
    this.profileModal?.dispose()
    this.profileModal = null
    this.connectedPointer = null
    this.setStatus({ kind: 'idle' })
  }

  private async runShellInit(): Promise<void> {
    if (!this.login || (this.login.kind !== 'wallet' && this.login.kind !== 'guest')) return
    await this.session.connect()
    const login = this.login
    const isGuest = login.kind === 'guest'
    await this.social.initShell({
      address: login.address,
      identity: login.identity,
      contentUrl: this.getContentUrl(),
      isGuest,
      displayName: login.kind === 'guest' ? login.displayName : undefined
    })
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