import type { LoginResult } from '../auth/AuthClient'
import { clearStoredIdentity } from '../auth/identityStore'
import {
  applyRouteToHistory,
  resolveRouteTarget,
  routeEquals,
  type RouteTarget
} from '../dcl/content/route'
import { resolveSceneFromRoute, summarizeSceneContent } from '../dcl/content/resolveScene'
import { EditorApp } from '../editor/EditorApp'
import { World } from '../core/World'
import { readSceneDevQueryKey } from '../environment/fftOcean/readFftOceanOverride'
import { disconnectAll } from '../network/SessionConnections'
import { SessionIdentity } from '../network/SessionIdentity'
import { ClientShell } from './ui/shell/ClientShell'
import { clientDebugLog } from './debug/ClientDebugLog'
import { DebugPanel } from './ui/DebugPanel'
import { DevProgressPanel } from './ui/DevProgressPanel'
import { LoadingScreen, POST_SPAWN_SETTLE_FAST_MS, POST_SPAWN_SETTLE_MS } from './ui/LoadingScreen'
import { WorldLocationCard } from './ui/WorldLocationCard'
import { hasResumedWalletSession, resolveInitialLogin } from './auth/resolveInitialLogin'
import { ExplorerAuthPanel } from './ui/explore/ExplorerAuthPanel'

import { ChatPanel } from './ui/chat/ChatPanel'
import { SocialChatController } from './ui/chat/SocialChatController'
import { SocialChatDock } from './ui/chat/SocialChatDock'
import { PreferencesPanel } from './ui/settings/PreferencesPanel'
import { SettingsOverlay } from './ui/settings/SettingsOverlay'
import type { MapPlayerState } from './ui/settings/MapView'
import { genesisMetersToParcel } from '../map/genesisMapViewport'
import type { ResolvedScene } from '../dcl/content/types'
import { fetchProfileFaceUrl } from '../avatar/peerApi'
import { hydrateEmoteWheelSlots } from '../avatar/profileEmotes'
import { InputAction } from '../input/pointerConstants'
import { MobileGameHud } from './ui/MobileGameHud'
import { disposeSessionAssetCache, getSessionAssetCache, prefetchSceneManifestAssets } from '../rendering/AssetCache'
import type { SceneHydrationStats } from '../rendering/sceneHydration'
import { resolveSceneLoadWarm } from '../rendering/sceneLoadWarm'
import { formatSceneBanMessage } from './formatSceneBanMessage'
import { formatSceneLoadError, type SceneLoadErrorMessage } from './formatSceneLoadError'
import { assertSceneAccess } from '../network/sceneAccess/assertSceneAccess'
import { sceneBanDebug } from '../network/sceneAccess/sceneBanDebug'
import { SceneBanMonitor } from '../network/sceneAccess/SceneBanMonitor'
import { SceneAccessDeniedError } from '../network/sceneAccess/SceneAccessDeniedError'
import { ProfileUiController } from './ui/profile/ProfileUiController'
import type { AppMode } from './appMode'
import { CommunitiesPageView } from './ui/explore/CommunitiesPageView'
import { EventsPageView } from './ui/explore/EventsPageView'
import { ExplorerView } from './ui/explore/ExplorerView'
import { MapPageView } from './ui/explore/MapPageView'
import { ProfilePageView } from './ui/explore/ProfilePageView'
import type { SocialShellTab } from './ui/explore/SocialShellTopNav'
import { SocialMobileNotifications } from './ui/explore/SocialMobileNotifications'
import { SceneLandingView } from './ui/landing/SceneLandingView'
import type { DclEvent } from '../social/dclEvents'
import { enrichResolvedScenePublicTitle } from '../social/sceneDisplayTitle'
import { recordLoginEvent } from '../analytics/recordLogin'

/** Owns world lifecycle — explorer / landing / play, navigation, and sign-out. */
export class AppController {
  private container: HTMLElement | null = null
  private world: World | null = null
  private shell: ClientShell | null = null
  private debugPanel: DebugPanel | null = null
  private devProgressPanel: DevProgressPanel | null = null
  private worldLocationCard: WorldLocationCard | null = null
  private chatPanel: ChatPanel | null = null
  private settingsOverlay: SettingsOverlay | null = null
  /** Session used by Settings/Backpack when no World is loaded (2D shell). */
  private shellSession: SessionIdentity | null = null
  private preferencesPanel: PreferencesPanel | null = null
  private login: LoginResult | null = null
  /**
   * Explicit Guest/wallet confirm for 3D entry.
   * Silent auto-guest alone is not enough — Jump In shows Sign in until true.
   */
  private playSessionReady = false
  private jumpInAuthPanel: ExplorerAuthPanel | null = null
  private currentRoute: RouteTarget | null = null
  private lastSceneDevQueryKey = ''
  private running = false
  private navigating = false
  private mobileHud: MobileGameHud | null = null
  private profileUi: ProfileUiController | null = null
  private sceneContentUrl = 'https://peer.decentraland.org'
  private editorApp: EditorApp | null = null
  private explorerView: ExplorerView | null = null
  private mapPageView: MapPageView | null = null
  private eventsPageView: EventsPageView | null = null
  private communitiesPageView: CommunitiesPageView | null = null
  private profilePageView: ProfilePageView | null = null
  private sceneLandingView: SceneLandingView | null = null
  private socialChat: SocialChatController | null = null
  private socialChatDock: SocialChatDock | null = null
  private socialMobileNotifications: SocialMobileNotifications | null = null
  private appMode: AppMode = 'explorer'
  private monitoredScene: ResolvedScene | null = null
  private sceneBanMonitor: SceneBanMonitor | null = null
  private sceneBanActive = false
  private handlingSceneBan = false
  private sceneBanDebugUnsub: (() => void) | null = null

  async start(container: HTMLElement): Promise<void> {
    if (this.running) return
    this.running = true
    this.container = container

    const initialRoute = resolveRouteTarget()
    if (initialRoute.kind === 'editor') {
      const hudEl = document.getElementById('hud')
      if (hudEl) hudEl.hidden = true
      this.currentRoute = initialRoute
      this.editorApp = new EditorApp()
      window.addEventListener('popstate', this.onPopState)
      await this.editorApp.start(container)
      return
    }

    window.addEventListener('popstate', this.onPopState)
    this.wireSceneBanDebug()

    const postLoginRoute = resolveRouteTarget()
    this.login = resolveInitialLogin()
    // Wallet resume → ready for Jump In. Silent guest needs explicit "Continue as Guest".
    this.playSessionReady = hasResumedWalletSession()
    recordLoginEvent(this.login)

    if (postLoginRoute.kind === 'blank') {
      await this.showExplorer({ replace: true })
      return
    }

    if (postLoginRoute.kind === 'events') {
      await this.showEventsPage({ replace: true })
      return
    }

    if (postLoginRoute.kind === 'map') {
      await this.showMapPage({ replace: true })
      return
    }

    if (postLoginRoute.kind === 'communities') {
      await this.showCommunitiesPage({ replace: true })
      return
    }

    if (postLoginRoute.kind === 'profile') {
      await this.showProfilePage({ replace: true })
      return
    }

    if (postLoginRoute.kind === 'editor') {
      await this.jumpInToScene(postLoginRoute, { replace: true })
      return
    }

    if (postLoginRoute.kind === 'coords' || postLoginRoute.kind === 'world') {
      await this.showSceneLanding(postLoginRoute, { replace: true })
    }
  }

  private onPopState = (): void => {
    void this.navigateTo(resolveRouteTarget(), { fromHistory: true })
  }

  private async navigateTo(
    target: RouteTarget,
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (this.navigating) return

    if (target.kind === 'blank') {
      this.navigating = true
      try {
        await this.showExplorer({ fromHistory: opts.fromHistory, replace: opts.replace })
      } finally {
        this.navigating = false
      }
      return
    }

    if (target.kind === 'events') {
      this.navigating = true
      try {
        await this.showEventsPage({ fromHistory: opts.fromHistory, replace: opts.replace })
      } finally {
        this.navigating = false
      }
      return
    }

    if (target.kind === 'map') {
      this.navigating = true
      try {
        await this.showMapPage({ fromHistory: opts.fromHistory, replace: opts.replace })
      } finally {
        this.navigating = false
      }
      return
    }

    if (target.kind === 'communities') {
      this.navigating = true
      try {
        await this.showCommunitiesPage({ fromHistory: opts.fromHistory, replace: opts.replace })
      } finally {
        this.navigating = false
      }
      return
    }

    if (target.kind === 'profile') {
      this.navigating = true
      try {
        await this.showProfilePage({ fromHistory: opts.fromHistory, replace: opts.replace })
      } finally {
        this.navigating = false
      }
      return
    }

    if (target.kind === 'editor') {
      await this.jumpInToScene(target, opts)
      return
    }

    if (target.kind === 'coords' || target.kind === 'world') {
      this.navigating = true
      try {
        await this.showSceneLanding(target, {
          fromHistory: opts.fromHistory,
          replace: opts.replace
        })
      } finally {
        this.navigating = false
      }
    }
  }

  private navigateSocialShell(tab: SocialShellTab): void {
    if (tab === 'explore') void this.navigateTo({ kind: 'blank' })
    else if (tab === 'map') void this.navigateTo({ kind: 'map' })
    else if (tab === 'communities') void this.navigateTo({ kind: 'communities' })
    else void this.navigateTo({ kind: 'events' })
  }

  private socialShellSocialHandlers(): {
    getSocial: () => ReturnType<SocialChatController['getSocial']> | null
    onEnsureSocial: () => Promise<void>
    onOpenChat: () => void
    onOpenUserProfile: (address: string) => void
  } {
    return {
      getSocial: () => this.socialChat?.getSocial() ?? null,
      onEnsureSocial: async () => {
        this.ensureSocialChatShell()
        this.socialChat?.applyLogin(this.login)
        await this.socialChat?.ensureShellInit()
      },
      onOpenChat: () => {
        this.ensureSocialChatShell()
        this.socialChatDock?.openFromNotification()
      },
      onOpenUserProfile: (address) => this.socialChat?.openProfileForAddress(address)
    }
  }

  private socialShellLoginHandlers(): {
    onLoginChange: (login: LoginResult) => void
    onSignOut: () => void
    onOpenSettings: () => void
    onOpenBackpack: () => void
    onOpenProfile: () => void
  } {
    return {
      onLoginChange: (login) => {
        this.login = login
        this.playSessionReady = true
        recordLoginEvent(login)
        this.socialMobileNotifications?.setLogin(login)
        this.applyLoginToSocialShellViews(login)
        this.sceneLandingView?.setPlaySessionReady(true)
        if (login.kind === 'wallet') {
          if (
            this.appMode === 'landing' &&
            this.currentRoute &&
            (this.currentRoute.kind === 'coords' || this.currentRoute.kind === 'world')
          ) {
            this.ensureSocialChatShell()
            this.socialChat?.applyLogin(login)
            void this.connectSceneLandingChat(this.currentRoute)
          }
        }
      },
      onSignOut: () => void this.signOutFrom2dShell(),
      onOpenSettings: () => {
        this.preferencesPanel?.show('graphics')
      },
      onOpenBackpack: () => {
        void this.openBackpackFromShell()
      },
      onOpenProfile: () => this.openLocalProfileFromShell(),
      ...this.socialShellSocialHandlers()
    }
  }

  /** Open backpack from 2D profile menu — SettingsOverlay is play-only unless we create it here. */
  private async openBackpackFromShell(): Promise<void> {
    if (this.login?.kind !== 'wallet') return
    try {
      const overlay = await this.ensureSettingsOverlay()
      overlay.show('backpack')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('client', `Backpack open failed: ${msg}`, { level: 'error' })
    }
  }

  /**
   * Settings overlay for play chrome and 2D shell backpack.
   * Play mode uses World.session; 2D builds a shell SessionIdentity from wallet login.
   */
  private async ensureSettingsOverlay(sceneConfig?: {
    source: { kind: string; worldName?: string }
  }): Promise<SettingsOverlay> {
    const world = this.world
    if (world) {
      if (!this.settingsOverlay) {
        this.settingsOverlay = this.createSettingsOverlay(world.session, sceneConfig)
      } else {
        this.settingsOverlay.updateSession(world.session)
        if (sceneConfig) {
          this.settingsOverlay.updateEventContext(
            sceneConfig.source.kind === 'world',
            sceneConfig.source.kind === 'world' ? sceneConfig.source.worldName ?? null : null
          )
        }
      }
      return this.settingsOverlay
    }

    if (this.login?.kind !== 'wallet') {
      throw new Error('Sign in with a wallet to open your backpack')
    }

    if (!this.shellSession) this.shellSession = new SessionIdentity()
    this.shellSession.applyLogin(this.login)
    await this.shellSession.connect()

    if (!this.settingsOverlay) {
      this.settingsOverlay = this.createSettingsOverlay(this.shellSession)
    } else {
      this.settingsOverlay.updateSession(this.shellSession)
    }
    return this.settingsOverlay
  }

  private createSettingsOverlay(
    session: SessionIdentity,
    sceneConfig?: { source: { kind: string; worldName?: string } }
  ): SettingsOverlay {
    return new SettingsOverlay({
      session,
      getMapPlayerState: () => this.getMapPlayerState(),
      onMapJumpIn: (px, py) => {
        this.settingsOverlay?.hide()
        void this.navigateTo({
          kind: 'coords',
          x: px,
          y: py,
          segment: `${px},${py}`
        })
      },
      onEventJumpIn: (target, _event: DclEvent) => {
        this.settingsOverlay?.hide()
        void this.jumpInToScene(target, { fastAssets: true })
      },
      onEventViewScene: (target, _event: DclEvent) => {
        this.settingsOverlay?.hide()
        if (target.kind === 'coords' || target.kind === 'world') {
          void this.showSceneLanding(target)
        }
      },
      onPlaceJumpIn: (target) => {
        this.settingsOverlay?.hide()
        void this.navigateTo(target)
      },
      getDefaultEventCoords: () => {
        const state = this.getMapPlayerState()
        if (!state?.parcelKey) return null
        const parts = state.parcelKey.split(',').map((n) => Number(n.trim()))
        if (parts.length !== 2 || !parts.every(Number.isFinite)) return null
        return { x: parts[0]!, y: parts[1]! }
      },
      isWorldScene: sceneConfig?.source.kind === 'world',
      worldName:
        sceneConfig?.source.kind === 'world' ? sceneConfig.source.worldName ?? null : null,
      onOpen: () => {
        if (document.pointerLockElement) document.exitPointerLock()
        this.preferencesPanel?.hide()
        this.shell?.getButton('settings')?.setActive(false)
      },
      onClose: () => {},
      onVrmEquipChange: () => {
        void this.world?.reloadLocalAvatar()
      }
    })
  }

  private openLocalProfileFromShell(): void {
    if (this.profileUi) {
      this.profileUi.openProfile({ kind: 'local' })
      return
    }
    void this.navigateTo({ kind: 'profile' })
  }

  private async showExplorer(
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'blank' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'blank' }
    this.appMode = 'explorer'
    this.clearSceneBanWatch()

    await this.teardownScene()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownCommunitiesPage()
    this.teardownProfilePage()

    if (!this.container || !this.login) return

    const hudEl = document.getElementById('hud')
    if (hudEl) hudEl.hidden = true

    this.explorerView = new ExplorerView({
      login: this.login,
      onOpenScene: (target) => void this.openSceneLanding(target),
      onNavigate: (tab) => this.navigateSocialShell(tab),
      ...this.socialShellLoginHandlers()
    })
    this.explorerView.mount(this.container)
    this.ensureSocialChatShell()
  }

  private async showMapPage(
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (this.appMode === 'play') {
      await this.teardownScene()
    }

    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'map' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'map' }
    this.appMode = 'map'
    this.clearSceneBanWatch()

    this.teardownExplorer()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownCommunitiesPage()
    this.teardownProfilePage()

    if (!this.container || !this.login) return

    const hudEl = document.getElementById('hud')
    if (hudEl) hudEl.hidden = true

    this.mapPageView = new MapPageView({
      login: this.login,
      onNavigate: (tab) => this.navigateSocialShell(tab),
      onParcelVisit: (px, py) => {
        void this.showSceneLanding({
          kind: 'coords',
          x: px,
          y: py,
          segment: `${px},${py}`
        })
      },
      getPlayerState: () => this.getMapPlayerState(),
      ...this.socialShellLoginHandlers()
    })
    this.mapPageView.mount(this.container)
    this.ensureSocialChatShell()
  }

  private async showEventsPage(
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (this.appMode === 'play') {
      await this.teardownScene()
    }

    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'events' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'events' }
    this.appMode = 'events'
    this.clearSceneBanWatch()

    this.teardownExplorer()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownCommunitiesPage()
    this.teardownProfilePage()

    if (!this.container || !this.login) return

    const hudEl = document.getElementById('hud')
    if (hudEl) hudEl.hidden = true

    this.eventsPageView = new EventsPageView({
      login: this.login,
      onNavigate: (tab) => this.navigateSocialShell(tab),
      onEventJumpIn: (target, _event) => void this.jumpInToScene(target),
      onEventViewScene: (target, _event) => {
        if (target.kind === 'coords' || target.kind === 'world') {
          void this.showSceneLanding(target)
        }
      },
      ...this.socialShellLoginHandlers()
    })
    this.eventsPageView.mount(this.container)
    this.ensureSocialChatShell()
  }

  private async showCommunitiesPage(
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (this.appMode === 'play') {
      await this.teardownScene()
    }

    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'communities' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'communities' }
    this.appMode = 'communities'
    this.clearSceneBanWatch()

    this.teardownExplorer()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownCommunitiesPage()
    this.teardownProfilePage()

    if (!this.container || !this.login) return

    const hudEl = document.getElementById('hud')
    if (hudEl) hudEl.hidden = true

    this.communitiesPageView = new CommunitiesPageView({
      login: this.login,
      onNavigate: (tab) => this.navigateSocialShell(tab),
      ...this.socialShellLoginHandlers()
    })
    this.communitiesPageView.mount(this.container)
    this.ensureSocialChatShell()
  }

  private async showProfilePage(
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (this.appMode === 'play') {
      await this.teardownScene()
    }

    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'profile' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'profile' }
    this.appMode = 'profile'
    this.clearSceneBanWatch()

    this.teardownExplorer()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownCommunitiesPage()
    this.teardownProfilePage()

    if (!this.container || !this.login) return

    const hudEl = document.getElementById('hud')
    if (hudEl) hudEl.hidden = true

    this.profilePageView = new ProfilePageView({
      login: this.login,
      catalystUrl: this.sceneContentUrl,
      onNavigate: (tab) => this.navigateSocialShell(tab),
      ...this.socialShellLoginHandlers()
    })
    this.profilePageView.mount(this.container)
    this.ensureSocialChatShell()
  }

  private teardownExplorer(): void {
    this.explorerView?.dispose()
    this.explorerView = null
  }

  private teardownMapPage(): void {
    this.mapPageView?.dispose()
    this.mapPageView = null
  }

  private teardownEventsPage(): void {
    this.eventsPageView?.dispose()
    this.eventsPageView = null
  }

  private teardownCommunitiesPage(): void {
    this.communitiesPageView?.dispose()
    this.communitiesPageView = null
  }

  private teardownProfilePage(): void {
    this.profilePageView?.dispose()
    this.profilePageView = null
  }

  private teardownLanding(): void {
    this.sceneLandingView?.dispose()
    this.sceneLandingView = null
  }

  private openSceneLanding(target: RouteTarget): void {
    if (target.kind !== 'coords' && target.kind !== 'world') return
    void this.showSceneLanding(target)
  }

  private async showSceneLanding(
    target: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>,
    opts: { fromHistory?: boolean; replace?: boolean; sceneBan?: SceneLoadErrorMessage } = {}
  ): Promise<void> {
    if (this.appMode === 'play') {
      await this.teardownScene()
    }

    if (!opts.fromHistory) {
      applyRouteToHistory(target, opts.replace ?? false)
    }
    this.currentRoute = target
    this.appMode = 'landing'

    this.teardownExplorer()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownCommunitiesPage()
    this.teardownProfilePage()

    if (!this.container || !this.login) return

    const hudEl = document.getElementById('hud')
    if (hudEl) hudEl.hidden = true
    this.hidePlayChrome()

    this.sceneLandingView = new SceneLandingView({
      route: target,
      login: this.login,
      playSessionReady: this.playSessionReady,
      onJumpIn: () => void this.jumpInToScene(target),
      onNavigate: (tab) => this.navigateSocialShell(tab),
      onEventJumpIn: (jumpTarget) => void this.jumpInToScene(jumpTarget),
      onEventViewScene: (jumpTarget) => {
        if (jumpTarget.kind === 'coords' || jumpTarget.kind === 'world') {
          void this.showSceneLanding(jumpTarget)
        }
      },
      onOpenUserProfile: (address) => this.socialChat?.openProfileForAddress(address),
      ...this.socialShellLoginHandlers()
    })
    this.sceneLandingView.mount(this.container)
    this.ensureSocialChatShell()
    void this.refreshMonitoredScene(target)
    if (opts.sceneBan) {
      this.sceneBanActive = true
      this.stopSceneBanMonitor()
      this.socialChat?.applySceneBan(opts.sceneBan)
      this.sceneLandingView.setPendingBan(opts.sceneBan)
    } else {
      this.sceneBanActive = false
      void this.connectSceneLandingChat(target)
      this.ensureSceneBanMonitor()
    }
  }

  private async connectSceneLandingChat(
    target: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
  ): Promise<void> {
    const connected = await this.socialChat?.connectForRoute(target)
    if (connected) this.socialChatDock?.openSceneChatThread()
  }

  private ensureSocialChatShell(): void {
    if (!this.socialChat) {
      this.socialChat = new SocialChatController({
        onStatusChange: () => this.socialChatDock?.refresh()
      })
      this.socialChat.applyLogin(this.login)
    }
    if (!this.socialChatDock) {
      this.socialChatDock = new SocialChatDock({
        controller: this.socialChat,
        onGoto: (gotoTarget) => {
          if (gotoTarget.kind === 'coords' || gotoTarget.kind === 'world') {
            void this.showSceneLanding(gotoTarget)
          }
        },
        onOpenProfile: (address) => this.socialChat?.openProfileForAddress(address)
      })
    }
    this.ensureSocialMobileNotifications()
    this.socialChatDock.show()
    document.body.classList.add('social-shell-with-chat')
    void this.socialChat.ensureShellInit()
  }

  private ensureSocialMobileNotifications(): void {
    if (this.socialMobileNotifications) return
    this.socialMobileNotifications = new SocialMobileNotifications({
      login: this.login ?? { kind: 'guest' },
      getSocial: () => this.socialChat?.getSocial() ?? null,
      onEnsureSocial: async () => {
        this.ensureSocialChatShell()
        this.socialChat?.applyLogin(this.login)
        await this.socialChat?.ensureShellInit()
      },
      onOpenChat: () => {
        this.ensureSocialChatShell()
        this.socialChatDock?.openFromNotification()
      },
      onOpenUserProfile: (address) => this.socialChat?.openProfileForAddress(address),
      isChatNotificationSuppressed: () =>
        this.socialChatDock?.isChatNotificationSuppressed() ?? false
    })
    this.socialMobileNotifications.mount()
  }

  private teardownSocialChatShell(disposeComms = false): void {
    this.socialChatDock?.hide()
    document.body.classList.remove('social-shell-with-chat')
    if (disposeComms) {
      this.socialMobileNotifications?.dispose()
      this.socialMobileNotifications = null
      this.socialChat?.dispose()
      this.socialChat = null
      this.socialChatDock?.dispose()
      this.socialChatDock = null
    }
  }

  /**
   * Gate 3D entry: wallet resume or explicit Guest / MetaMask.
   * Silent auto-guest on bootstrap is for 2D shell only.
   */
  private ensurePlaySession(): Promise<boolean> {
    if (this.playSessionReady && this.login) return Promise.resolve(true)

    return new Promise((resolve) => {
      this.jumpInAuthPanel?.dispose()
      this.jumpInAuthPanel = new ExplorerAuthPanel({
        onComplete: (result) => {
          this.login = result
          this.playSessionReady = true
          recordLoginEvent(result)
          this.applyLoginToSocialShellViews(result)
          this.sceneLandingView?.setPlaySessionReady(true)
          this.socialChat?.applyLogin(result)
          this.socialMobileNotifications?.setLogin(result)
          this.jumpInAuthPanel?.dispose()
          this.jumpInAuthPanel = null
          resolve(true)
        },
        onClose: () => {
          this.jumpInAuthPanel?.dispose()
          this.jumpInAuthPanel = null
          resolve(false)
        }
      })
      this.jumpInAuthPanel.mount()
      this.jumpInAuthPanel.open()
    })
  }

  private async jumpInToScene(
    target: RouteTarget,
    opts: { fromHistory?: boolean; replace?: boolean; fastAssets?: boolean } = {}
  ): Promise<void> {
    if (target.kind !== 'coords' && target.kind !== 'world' && target.kind !== 'editor') return

    // Editor / already-in-play teleports skip re-auth; first entry from 2D needs session.
    if (target.kind !== 'editor' && this.appMode !== 'play') {
      const ok = await this.ensurePlaySession()
      if (!ok) return
    }

    const devQueryKey = readSceneDevQueryKey()
    if (
      this.appMode === 'play' &&
      this.currentRoute &&
      routeEquals(this.currentRoute, target) &&
      this.world &&
      devQueryKey === this.lastSceneDevQueryKey
    ) {
      return
    }

    const fromSceneLanding =
      this.appMode === 'landing' &&
      this.sceneLandingView !== null &&
      this.currentRoute !== null &&
      routeEquals(this.currentRoute, target)

    if (!fromSceneLanding) {
      this.teardownSocialChatShell(true)
    }

    this.navigating = true
    let loading: LoadingScreen | null = null
    if (fromSceneLanding) {
      this.hidePlayChrome()
      this.sceneLandingView!.preserveDuringWorldLoad()
      this.sceneLandingView!.beginJumpInLoading()
    } else {
      loading = new LoadingScreen(
        this.appMode === 'play' ? 'Teleporting…' : 'Preparing your experience…',
        { fast: this.appMode === 'play' }
      )
      loading.mount()
      loading.startLoadingTimer()
    }

    try {
      if (!fromSceneLanding) {
        this.teardownLanding()
      }
      this.teardownExplorer()
      this.teardownMapPage()
      const hydrationTimedOut = await this.loadRoute(target, {
        ...opts,
        fastAssets: opts.fastAssets ?? this.appMode === 'play',
        handoffShellComms: fromSceneLanding,
        deferPlayChromeReveal: fromSceneLanding,
        onProgress: (msg, fraction, stats) => {
          if (fromSceneLanding) {
            this.sceneLandingView?.updateJumpInProgress(fraction, msg)
          } else if (loading) {
            loading.setStatus(msg)
            if (fraction !== undefined) loading.setProgress(fraction)
            if (stats) loading.setHydrationStats(stats)
          }
        },
        onHydrationStart: (timeoutMs) => loading?.setHydrationTimeoutMs(timeoutMs),
        onHydrationFinish: (result) => loading?.noteHydrationComplete(result)
      })
      this.appMode = 'play'
      if (fromSceneLanding) {
        await this.sceneLandingView?.completeJumpInLoading()
        this.teardownLanding()
        this.teardownSocialChatShell(true)
        this.revealPlayChrome()
      } else {
        await loading!.finish(Promise.resolve(), { skipHold: !hydrationTimedOut })
      }
    } catch (err) {
      if (err instanceof SceneAccessDeniedError) {
        const ui = formatSceneBanMessage(err)
        if (fromSceneLanding) {
          this.sceneLandingView?.showSceneBan(ui)
        } else {
          loading?.showFatalError(ui.title, ui.detail)
        }
        clientDebugLog.log('client', `Scene access denied: ${err.source}`, { level: 'warn' })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        const ui = formatSceneLoadError(msg)
        if (fromSceneLanding) {
          this.sceneLandingView?.showJumpInError(ui.title, ui.detail)
        } else {
          loading?.showFatalError(ui.title, ui.detail)
        }
        clientDebugLog.log('client', `Failed to load scene: ${msg}`, { level: 'error' })
      }
    } finally {
      this.navigating = false
    }
  }

  private async leavePlayMode(): Promise<void> {
    if (this.appMode !== 'play' || !this.currentRoute) return
    if (this.currentRoute.kind !== 'coords' && this.currentRoute.kind !== 'world') return
    await this.showSceneLanding(this.currentRoute, { replace: true })
  }

  private async loadRoute(
    route: RouteTarget,
    opts: {
      fromHistory?: boolean
      replace?: boolean
      fastAssets?: boolean
      handoffShellComms?: boolean
      deferPlayChromeReveal?: boolean
      onProgress?: (msg: string, fraction?: number, stats?: SceneHydrationStats) => void
      onHydrationStart?: (timeoutMs: number) => void
      onHydrationFinish?: (result: { timedOut: boolean; elapsedMs: number }) => void
    } = {}
  ): Promise<boolean> {
    if (route.kind === 'editor') {
      if (!opts.fromHistory) {
        applyRouteToHistory(route, opts.replace ?? false)
      }
      this.currentRoute = route
      await this.teardownScene()
      this.editorApp?.dispose()
      this.editorApp = new EditorApp()
      if (!this.container) throw new Error('App container missing')
      await this.editorApp.start(this.container)
      return false
    }

    if (this.editorApp) {
      this.editorApp.dispose()
      this.editorApp = null
    }

    this.teardownExplorer()

    if (!opts.fromHistory) {
      applyRouteToHistory(route, opts.replace ?? false)
    }
    this.currentRoute = route
    this.lastSceneDevQueryKey = readSceneDevQueryKey()

    await this.teardownScene()

    opts.onProgress?.('Resolving destination…')
    let sceneConfig = await resolveSceneFromRoute(route)
    if (route.kind === 'coords' || route.kind === 'world') {
      sceneConfig = await enrichResolvedScenePublicTitle(sceneConfig, route)
    }
    opts.onProgress?.('Checking access…', 0.08)
    await assertSceneAccess(sceneConfig, this.login)
    this.monitoredScene = sceneConfig
    this.sceneContentUrl = sceneConfig.realm.contentUrl
    prefetchSceneManifestAssets(getSessionAssetCache(), sceneConfig)
    opts.onProgress?.('Building world…')
    if (!this.container) throw new Error('App container missing')

    const world = new World(this.container)
    this.world = world
    world.applyLogin(this.login)

    this.profileUi?.dispose()
    this.profileUi = new ProfileUiController({
      session: world.session,
      social: world.social,
      getPeerUrl: () => this.sceneContentUrl,
      getRemoteAvatars: () => world.getRemoteAvatarManager(),
      getCamera: () => world.host.camera,
      onOpenChat: () => this.shell?.openChatPanel(),
      onPrepareOverlay: () => this.world?.cancelCameraPointer()
    })

    if (!this.debugPanel) {
      this.debugPanel = new DebugPanel({
        anchor: () => this.shell?.getButton('help')?.element,
        renderStats: world.host.renderStats,
        onVisibilityChange: (visible) => this.shell?.getButton('help')?.setActive(visible),
        getPlayerPosition: () => this.world?.getPlayerPosition() ?? null,
        getSceneOrigin: () => this.world?.comms.getSceneOrigin() ?? { x: 0, z: 0 },
        onRecookColliders: () => this.world?.recookPhysicsColliders({ force: true })
      })
    } else {
      this.debugPanel.replaceRenderStats(world.host.renderStats)
      this.debugPanel.setRecookCollidersHandler(() => this.world?.recookPhysicsColliders({ force: true }))
    }

    if (!this.devProgressPanel) {
      this.devProgressPanel = new DevProgressPanel({
        getSession: () => this.world?.session ?? null
      })
    }

    if (!this.shell) {
      this.shell = new ClientShell({
        environment: world.environment,
        session: world.session,
        debugPanel: this.debugPanel,
        devProgressPanel: this.devProgressPanel,
        onEmoteSelected: (emoteId) => world.playLocalEmote(emoteId, { loop: false }),
        onSignOut: () => this.signOut(),
        onExit: () => this.leavePlayMode()
      })
    } else {
      this.shell.updateWorldBindings(world.session, world.environment)
      this.shell.setEmoteHandler((emoteId) => world.playLocalEmote(emoteId, { loop: false }))
    }
    if (opts.deferPlayChromeReveal) {
      this.hidePlayChrome()
    }

    if (!this.settingsOverlay) {
      this.settingsOverlay = this.createSettingsOverlay(world.session, sceneConfig)
    } else {
      this.settingsOverlay.updateSession(world.session)
      this.settingsOverlay.updateEventContext(
        sceneConfig.source.kind === 'world',
        sceneConfig.source.kind === 'world' ? sceneConfig.source.worldName : null
      )
      this.settingsOverlay.updateMapPlayerState(() => this.getMapPlayerState())
      this.settingsOverlay.updateMapJumpIn((px, py) => {
        this.settingsOverlay?.hide()
        void this.navigateTo({
          kind: 'coords',
          x: px,
          y: py,
          segment: `${px},${py}`
        })
      })
    }

    if (!this.preferencesPanel) {
      this.preferencesPanel = new PreferencesPanel({
        onVisibilityChange: (visible) => {
          this.shell?.getButton('settings')?.setActive(visible)
        },
        onOpen: () => {
          this.settingsOverlay?.hide()
        }
      })
    }

    let hydrationTimedOut = false

    const loadPromise = (async () => {
      await world.loadScene(sceneConfig, opts.onProgress)
      if (opts.handoffShellComms) {
        this.socialChat?.releaseCommsForWorldHandoff()
      }
      const earlyCommsPromise = world.connectSceneCommsEarly(sceneConfig, opts.onProgress)

      this.worldLocationCard?.dispose()
      this.worldLocationCard = null

      this.worldLocationCard = new WorldLocationCard({
        scene: sceneConfig,
        title: sceneDisplayTitle(sceneConfig),
        getCoordsLabel: () => this.getLocationCoordsLabel(),
        onJumpToGenesis:
          sceneConfig.source.kind === 'world'
            ? () => {
                if (document.pointerLockElement) document.exitPointerLock()
                void this.navigateTo({
                  kind: 'coords',
                  x: 0,
                  y: 0,
                  segment: '0,0'
                })
              }
            : undefined
      })
      if (opts.deferPlayChromeReveal) {
        this.worldLocationCard.setVisible(false)
      }

      const warmScene = await resolveSceneLoadWarm(getSessionAssetCache(), sceneConfig)
      const useFastBoot = opts.fastAssets ?? warmScene
      if (useFastBoot && !opts.fastAssets) {
        console.info('[client] warm scene cache — wait until assets attached (no hard timeout)')
      } else if (!opts.fastAssets) {
        console.info('[client] cold scene load — wait until assets attached (no hard timeout)')
      }
      // No hydration ceiling — UI timer is count-up only (timeoutMs=0).
      opts.onHydrationStart?.(0)
      const hydrationResult = await world.waitForSceneAssets(sceneConfig, opts.onProgress, {
        // Never force-ready mid-attach (Genesis cold often exceeds 3+ minutes).
        timeoutMs: undefined
      })
      if (hydrationResult) {
        hydrationTimedOut = hydrationResult.timedOut
        opts.onHydrationFinish?.(hydrationResult)
      }

      await world.prewarmPhysicsColliders(sceneConfig, opts.onProgress, {
        assetsTimedOut: hydrationTimedOut
      })

      // Comms may finish while CRDT catches up — authoritative cook runs in spawnLocalPlayer after final sync.
      await earlyCommsPromise
      await world.spawnLocalPlayer(sceneConfig, opts.onProgress)

      world.start()

      const settleMs = useFastBoot ? POST_SPAWN_SETTLE_FAST_MS : POST_SPAWN_SETTLE_MS
      if (settleMs > 0) {
        opts.onProgress?.('Settling world…', 0.985)
        await new Promise<void>((resolve) => window.setTimeout(resolve, settleMs))
      }

      opts.onProgress?.('Starting experience…', 0.99)

      const footer = 'Click to lock cursor · WASD move · /goto name or x,y in chat'

      this.debugPanel?.setStatusHtml(`${summarizeSceneContent(sceneConfig)}<br>${footer}`)
      clientDebugLog.log(
        'client',
        'Scene loaded — Help (?) for debug log · moving platforms: ?platformdebug or Debug → Platform transfer log'
      )
      const profile = world.session.getProfile()
      const peerUrl = sceneConfig.realm.contentUrl
      void hydrateEmoteWheelSlots(profile, peerUrl).then((slots) => {
        this.shell?.setEmoteWheelSlots(slots)
      })
    })()

    await loadPromise

    this.shell.setOnViewLocalProfile(() => this.profileUi?.openProfile({ kind: 'local' }))

    this.chatPanel?.dispose()
    this.chatPanel = new ChatPanel({
      social: world.social,
      onGoto: (target) => void this.jumpInToScene(target, { fastAssets: true }),
      onOpenProfile: (address) => this.profileUi?.openProfileForAddress(address)
    })
    this.shell.attachChatPanel(this.chatPanel, world.social)
    if (this.settingsOverlay) this.shell.attachSettingsOverlay(this.settingsOverlay)
    if (this.preferencesPanel) this.shell.attachPreferencesPanel(this.preferencesPanel)
    opts.onProgress?.('Almost ready…')
    if (!opts.deferPlayChromeReveal) {
      this.revealPlayChrome()
    }
    void this.shell.refreshProfile()
    this.shell.setSceneLocation(sceneDisplayTitle(sceneConfig), () => this.getLocationCoordsLabel())

    this.mobileHud?.dispose()
    this.mobileHud = new MobileGameHud({
      onEmote: () => this.shell?.toggleEmotes(),
      onPrimaryDown: () => world.triggerPointerAction(InputAction.IA_PRIMARY, 'down'),
      onPrimaryUp: () => world.triggerPointerAction(InputAction.IA_PRIMARY, 'up'),
      onSecondaryDown: () => world.triggerPointerAction(InputAction.IA_SECONDARY, 'down'),
      onSecondaryUp: () => world.triggerPointerAction(InputAction.IA_SECONDARY, 'up'),
      onJumpDown: () => world.setJumpHeld(true),
      onJumpUp: () => world.setJumpHeld(false)
    })
    this.shell.setOnEmoteWheelVisibility((visible) => this.mobileHud?.setEmoteActive(visible))
    world.setVoluntaryEmoteAllowedHandler((allowed) => {
      this.shell?.setEmoteWheelEnabled(allowed)
      this.mobileHud?.setEmoteEnabled(allowed)
    })
    if (!opts.deferPlayChromeReveal) {
      this.mobileHud.setShellVisible(true)
    }

    const address = world.session.getAddress()
    const profile = world.session.getProfile()
    if (address && profile) {
      void fetchProfileFaceUrl(address, world.session.getLambdasUrl()).then((faceUrl) => {
        world.social.setLocalFaceUrl(faceUrl)
      })
    }

    this.ensureSceneBanMonitor()
    return hydrationTimedOut
  }

  private wireSceneBanDebug(): void {
    this.sceneBanDebugUnsub?.()
    this.sceneBanDebugUnsub = sceneBanDebug.onTrigger(() => {
      if (!sceneBanDebug.isSimulatingBan() || this.sceneBanActive || this.handlingSceneBan) return
      const scene = this.monitoredScene
      if (!scene) return
      void this.handleMidSessionSceneBan(sceneBanDebug.simulatedBanError(scene.title))
    })
  }

  private async refreshMonitoredScene(
    target: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
  ): Promise<void> {
    try {
      let scene = await resolveSceneFromRoute(target)
      scene = await enrichResolvedScenePublicTitle(scene, target)
      this.monitoredScene = scene
    } catch {
      this.monitoredScene = null
    }
  }

  private ensureSceneBanMonitor(): void {
    if (this.sceneBanActive) return
    if (!this.login || this.login.kind !== 'wallet') return
    if (this.appMode !== 'play' && this.appMode !== 'landing') return
    if (!this.monitoredScene) return
    if (!this.currentRoute || (this.currentRoute.kind !== 'coords' && this.currentRoute.kind !== 'world')) {
      return
    }

    if (!this.sceneBanMonitor) {
      this.sceneBanMonitor = new SceneBanMonitor({
        getScene: () => this.monitoredScene,
        getLogin: () => this.login,
        isEnabled: () =>
          !this.sceneBanActive &&
          !this.handlingSceneBan &&
          (this.appMode === 'play' || this.appMode === 'landing') &&
          this.login?.kind === 'wallet',
        onBanned: (denied) => this.handleMidSessionSceneBan(denied)
      })
    }
    this.sceneBanMonitor.start()
  }

  private stopSceneBanMonitor(): void {
    this.sceneBanMonitor?.stop()
  }

  private clearSceneBanWatch(): void {
    this.stopSceneBanMonitor()
    this.monitoredScene = null
    this.sceneBanActive = false
  }

  private async handleMidSessionSceneBan(err: SceneAccessDeniedError): Promise<void> {
    if (this.handlingSceneBan || this.sceneBanActive) return
    this.handlingSceneBan = true
    try {
      const ui = formatSceneBanMessage(err)
      this.stopSceneBanMonitor()
      this.sceneBanActive = true

      const route = this.currentRoute
      if (!route || (route.kind !== 'coords' && route.kind !== 'world')) return

      clientDebugLog.log('client', `Mid-session scene ban · ${err.source}`, { level: 'warn' })

      if (this.appMode === 'play') {
        this.hidePlayChrome()
        await this.showSceneLanding(route, { replace: true, sceneBan: ui })
        return
      }

      if (this.appMode === 'landing') {
        this.socialChat?.applySceneBan(ui)
        this.sceneLandingView?.showSceneBan(ui)
      }
    } finally {
      this.handlingSceneBan = false
    }
  }

  private hidePlayChrome(): void {
    this.shell?.hide()
    this.worldLocationCard?.setVisible(false)
    this.mobileHud?.setShellVisible(false)
    this.world?.setSceneUiVisible(false)
  }

  private revealPlayChrome(): void {
    this.shell?.show()
    this.worldLocationCard?.setVisible(true)
    this.mobileHud?.setShellVisible(true)
    this.world?.setSceneUiVisible(true)
  }

  private getLocationCoordsLabel(): string {
    const state = this.getMapPlayerState()
    if (state?.parcelKey) return state.parcelKey
    const pos = this.world?.getPlayerPosition()
    if (pos) return `${Math.floor(pos.x)}, ${Math.floor(pos.z)}`
    return '—'
  }

  private getMapPlayerState(): MapPlayerState | null {
    const world = this.world
    if (!world) return null
    const pos = world.getPlayerPosition()
    if (!pos) return null
    const origin = world.comms.getSceneOrigin()
    const genesisX = pos.x + origin.x
    const genesisZ = pos.z + origin.z
    const { parcelKey } = genesisMetersToParcel(genesisX, genesisZ)
    const profile = world.session.getProfile()
    const address = world.session.getAddress()
    return {
      position: { x: genesisX, y: pos.y, z: genesisZ },
      parcelKey,
      address: address ?? undefined,
      displayName: profile?.displayName,
      faceUrl: world.social.getLocalDisplay().faceUrl
    }
  }

  private async teardownScene(): Promise<void> {
    this.world?.setVoluntaryEmoteAllowedHandler(null)
    this.teardownExplorer()
    this.editorApp?.dispose()
    this.editorApp = null
    this.profileUi?.dispose()
    this.profileUi = null
    this.mobileHud?.dispose()
    this.mobileHud = null
    this.worldLocationCard?.dispose()
    this.worldLocationCard = null
    this.chatPanel?.hide()
    this.hidePlayChrome()
    await disconnectAll(this.world)
    this.world = null
    if (this.container) this.container.innerHTML = ''
  }

  /** Sign out from any 2D shell surface — close chat UI and disconnect all comms. */
  private signOutFrom2dShell(): void {
    clearStoredIdentity()
    this.login = { kind: 'guest' }
    this.playSessionReady = false
    this.shellSession = null
    // Drop shell-created settings (backpack) when not in play — session is gone.
    if (!this.world) {
      this.settingsOverlay?.dispose()
      this.settingsOverlay = null
    } else {
      this.settingsOverlay?.hide()
    }
    this.applyLoginToSocialShellViews(this.login)
    this.sceneLandingView?.setPlaySessionReady(false)
    this.socialChat?.signOut()
    this.teardownSocialChatShell(true)
  }

  private applyLoginToSocialShellViews(login: LoginResult): void {
    this.explorerView?.setLogin(login)
    this.mapPageView?.setLogin(login)
    this.eventsPageView?.setLogin(login)
    this.communitiesPageView?.setLogin(login)
    this.profilePageView?.setLogin(login)
    this.sceneLandingView?.setLogin(login)
  }

  async signOut(): Promise<void> {
    window.removeEventListener('popstate', this.onPopState)
    this.profileUi?.dispose()
    this.profileUi = null
    this.chatPanel?.dispose()
    this.chatPanel = null
    this.settingsOverlay?.dispose()
    this.settingsOverlay = null
    this.shellSession = null
    this.preferencesPanel?.dispose()
    this.preferencesPanel = null
    this.debugPanel?.dispose()
    this.debugPanel = null
    this.devProgressPanel?.dispose()
    this.devProgressPanel = null
    this.mobileHud?.dispose()
    this.mobileHud = null
    this.shell?.dispose()
    this.shell = null
    this.teardownSocialChatShell(true)
    this.teardownExplorer()
    this.teardownLanding()
    this.clearSceneBanWatch()
    await this.teardownScene()
    disposeSessionAssetCache()

    clearStoredIdentity()
    this.login = null
    this.currentRoute = null

    if (this.container) {
      this.container.innerHTML = ''
    }

    this.running = false
    if (this.container) {
      await this.start(this.container)
    }
  }

}

function sceneDisplayTitle(scene: ResolvedScene): string {
  if (scene.source.kind === 'world') {
    const title = scene.title.trim()
    return title || scene.source.worldName
  }
  const title = scene.title.trim()
  return title || scene.baseParcel
}
