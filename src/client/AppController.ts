import { loginHasCommsIdentity, type LoginResult } from '../auth/AuthClient'
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
import { Minimap } from './ui/Minimap'
import { WorldLocationCard } from './ui/WorldLocationCard'
import {
  ensureGuestSession,
  hasResumedWalletSession,
  resolveInitialLogin
} from './auth/resolveInitialLogin'
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
import { bindWhatsNewShippedOpener, openWhatsNewFromMenu } from './whatsNew/WhatsNewToast'
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
  private minimap: Minimap | null = null
  private minimapLayoutObserver: ResizeObserver | null = null
  /** Parcel to center the full map on after leave-play (minimap click). */
  private mapFocusParcel: { px: number; py: number } | null = null
  private chatPanel: ChatPanel | null = null
  private settingsOverlay: SettingsOverlay | null = null
  private unsubVoiceUi: (() => void) | null = null
  private unsubVoiceSpeaking: (() => void) | null = null
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
  /** Unsubscribe scene-room Cast presence poller for the open landing. */
  private castLiveUnsub: (() => void) | null = null
  /** Dedicated Cast 2.0 watcher LiveKit room (separate from scene chat). */
  private castWatchRoom: import('../network/comms/CastLiveKitRoom').CastLiveKitRoom | null = null
  private castProbeTimer = 0
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

    window.addEventListener('popstate', this.onPopState)
    this.wireSceneBanDebug()
    // Toast + profile "What's new" open the same Dev Progress → Shipped view.
    this.ensureDevProgressPanel()
    bindWhatsNewShippedOpener(() => this.openShippedChangelog())

    const postLoginRoute = resolveRouteTarget()
    this.login = await resolveInitialLogin()
    // Wallet resume or stable guest both get AuthIdentity — Jump In / LiveKit ready.
    this.playSessionReady = hasResumedWalletSession() || this.login.kind === 'guest'
    recordLoginEvent(this.login)

    if (postLoginRoute.kind === 'editor') {
      const hudEl = document.getElementById('hud')
      if (hudEl) hudEl.hidden = true
      this.currentRoute = postLoginRoute
      this.appMode = 'explorer'
      await this.startEditorApp({ replace: true })
      return
    }

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
    else if (tab === 'editor') void this.navigateTo({ kind: 'editor' })
    else void this.navigateTo({ kind: 'events' })
  }

  private async startEditorApp(
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'editor' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'editor' }
    this.appMode = 'explorer'
    this.clearSceneBanWatch()

    await this.teardownScene()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownCommunitiesPage()
    this.teardownProfilePage()
    this.teardownExplorer()

    if (!this.container || !this.login) return

    const hudEl = document.getElementById('hud')
    if (hudEl) hudEl.hidden = true

    this.editorApp?.dispose()
    this.editorApp = new EditorApp()
    // Terrain hub: shell nav only — no scene chat dock / FAB.
    this.teardownSocialChatShell(false)
    await this.editorApp.start(this.container, {
      login: this.login,
      onNavigate: (tab) => this.navigateSocialShell(tab),
      ...this.socialShellLoginHandlers()
    })
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
    onOpenWhatsNew: () => void
  } {
    return {
      onLoginChange: (login) => {
        this.login = login
        this.playSessionReady = true
        recordLoginEvent(login)
        this.socialMobileNotifications?.setLogin(login)
        this.applyLoginToSocialShellViews(login)
        this.editorApp?.setLogin(login)
        // setLogin already refreshes owner gear; keep Jump-in CTA in sync for guests→wallet.
        this.sceneLandingView?.setPlaySessionReady(true)
        this.sceneLandingView?.setLogin(login)
        if (login.kind === 'wallet' || login.kind === 'guest') {
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
      onOpenWhatsNew: () => openWhatsNewFromMenu(),
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
    // Leave scene-thread "reading" mode so inbound scene chat can toast + badge.
    this.collapseSocialChatThread()
  }

  private async showMapPage(
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    // Capture focus before scene teardown clears live player state.
    let initialCenter = this.mapFocusParcel
    this.mapFocusParcel = null
    if (!initialCenter && this.appMode === 'play') {
      initialCenter = this.parcelFromPlayerState(this.getMapPlayerState())
    }

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
      initialCenter,
      ...this.socialShellLoginHandlers()
    })
    this.mapPageView.mount(this.container)
    this.ensureSocialChatShell()
    this.collapseSocialChatThread()
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
    this.collapseSocialChatThread()
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
    this.collapseSocialChatThread()
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
    this.collapseSocialChatThread()
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
    this.castLiveUnsub?.()
    this.castLiveUnsub = null
    if (this.castProbeTimer) {
      window.clearInterval(this.castProbeTimer)
      this.castProbeTimer = 0
    }
    this.castWatchRoom?.disconnect()
    this.castWatchRoom = null
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

    this.castLiveUnsub?.()
    this.castLiveUnsub = null
    this.sceneLandingView = new SceneLandingView({
      route: target,
      login: this.login,
      getLogin: () => this.login!,
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
      startCastWatch: (host, onUpdate, castOpts) => this.startLandingCastWatch(target, host, onUpdate, castOpts),
      ...this.socialShellLoginHandlers()
    })
    this.sceneLandingView.mount(this.container)
    this.ensureSocialChatShell()
    // Chat shell may re-apply wallet identity — re-sync owner gear with live session.
    this.sceneLandingView.syncLoginFromHost()
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
    // Jump in stays hidden until LiveKit is up or scene.json blocks browser chat.
    this.sceneLandingView?.setJumpInUnlocked(false)

    if (this.login) this.socialChat?.applyLogin(this.login)
    const connected = await this.socialChat?.connectForRoute(target)
    if (connected) this.socialChatDock?.openSceneChatThread()
    // After wallet chat is up, force owner gear re-check (stale guest copy was hiding it).
    this.sceneLandingView?.syncLoginFromHost()

    const status = this.socialChat?.getStatus()
    const lkReady = this.socialChat?.isLiveKitConnected() === true
    const chatBlockedByScene = status?.kind === 'browser_chat_disabled'
    const guestSession = status?.kind === 'guest' || this.login?.kind === 'guest'
    // Unlock Jump in: LiveKit ready, or scene.json blocks chat, or guest (no LiveKit expected).
    // Also unlock on terminal failures so users are not stuck without a CTA.
    const jumpInReady =
      lkReady ||
      chatBlockedByScene ||
      guestSession ||
      status?.kind === 'failed' ||
      status?.kind === 'duplicate_wallet' ||
      status?.kind === 'scene_ban'
    this.sceneLandingView?.setJumpInUnlocked(jumpInReady)

    // Scene LiveKit = chat + scene-stream-access RTMP (OBS stream keys) video.
    // Not DCL Cast 2.0 (/cast/watcher-token) — that is a separate product.
    this.castLiveUnsub?.()
    this.castLiveUnsub = null
    if (this.castProbeTimer) {
      window.clearInterval(this.castProbeTimer)
      this.castProbeTimer = 0
    }

    if (connected && this.socialChat) {
      this.sceneLandingView?.setCastRoomReady(true)
      console.log(
        `[cast] landing chat connected=${connected} liveKit=${lkReady} jumpIn=${jumpInReady} status=${status?.kind ?? 'none'}`
      )
      // Continuous presence: room may connect late, and OBS may go live after landing opens.
      this.castLiveUnsub = this.socialChat.watchRemoteVideoLive((live) => {
        console.log(`[cast] scene-room video live=${live}`)
        this.sceneLandingView?.setCastLive(live)
      })
      this.sceneLandingView?.setCastLive(this.socialChat.hasRemoteVideoLive())
      // Jump-in unlock retries (separate from cast presence poll inside the watcher).
      for (const ms of [800, 2000, 5000]) {
        window.setTimeout(() => {
          if (!this.sceneLandingView || !this.socialChat) return
          if (this.socialChat.isLiveKitConnected()) {
            this.sceneLandingView.setJumpInUnlocked(true)
            this.sceneLandingView.setCastRoomReady(true)
          }
          this.sceneLandingView.setCastLive(this.socialChat.hasRemoteVideoLive())
        }, ms)
      }
    } else {
      console.log(
        `[cast] landing chat connected=${connected} jumpIn=${jumpInReady} status=${status?.kind ?? 'none'}`
      )
      if (chatBlockedByScene || guestSession || jumpInReady) {
        this.sceneLandingView?.setCastRoomReady(true)
      }
    }
  }

  /**
   * Watch OBS stream-key video (scene-stream-access RTMP → scene LiveKit room).
   * Fresh get-scene-adapter join so we attach to the same room as in-world livekit-video://current-stream.
   * Wallet **or guest** identity can watch (signed gatekeeper + LiveKit).
   */
  private async startLandingCastWatch(
    target: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>,
    host: HTMLElement,
    onUpdate?: (attached: boolean) => void,
    opts?: { muted?: boolean; volume?: number }
  ): Promise<() => void> {
    if (!loginHasCommsIdentity(this.login)) {
      // Edge case: no session yet — mint browser guest so Cast works without a wallet.
      try {
        const guest = await ensureGuestSession()
        this.login = guest
        this.playSessionReady = true
        this.applyLoginToSocialShellViews(guest)
        this.sceneLandingView?.setPlaySessionReady(true)
        this.sceneLandingView?.setLogin(guest)
        this.ensureSocialChatShell()
        this.socialChat?.applyLogin(guest)
      } catch {
        /* fall through */
      }
    }
    if (!loginHasCommsIdentity(this.login)) {
      throw new Error('Could not start a guest session to watch the live stream. Try signing in.')
    }
    const identity = this.login.identity

    const { resolveSceneFromRoute } = await import('../dcl/content/resolveScene')
    const { getSceneAdapter } = await import('../network/gatekeeper/GatekeeperClient')
    const { CastLiveKitRoom } = await import('../network/comms/CastLiveKitRoom')
    const { parseLiveKitConnectionString } = await import('../network/comms/livekitAdapter')
    const { isParcelPointer, normalizePointer } = await import('../network/catalyst/pointer')

    const scene = await resolveSceneFromRoute(target)
    const sceneId = scene.entityId?.trim()
    if (!sceneId) {
      throw new Error('Could not resolve scene deployment id for this place.')
    }

    const isWorld = scene.source.kind === 'world'
    const pointer = normalizePointer(scene.commsPointer)
    const parcel = isWorld ? '0,0' : isParcelPointer(pointer) ? pointer : scene.baseParcel
    // Must match buildCommsTarget / scene-stream-access realm (lowercase world id).
    const realmName = isWorld
      ? pointer.toLowerCase()
      : scene.realm.realmName?.trim() || 'main'

    console.log(
      `[cast] stream-key watch: sceneId=${sceneId.slice(0, 18)}… parcel=${parcel} realm=${realmName} isWorld=${isWorld} as=${this.login.kind}`
    )

    // Prefer existing scene-room session first (already joined for chat).
    if (this.socialChat?.isLiveKitConnected()) {
      const unbindExisting = this.socialChat.bindRemoteCastVideoToHost(host, onUpdate, opts)
      // Give existing room a moment; if video attaches, keep it.
      await new Promise((r) => setTimeout(r, 600))
      if (host.querySelector('video')) {
        console.log('[cast] stream-key video attached via existing scene LiveKit session')
        return unbindExisting
      }
      unbindExisting()
      console.log('[cast] existing scene room has no video yet — fresh adapter join')
    }

    const adapterResult = await getSceneAdapter(identity, {
      sceneId,
      parcel,
      realmName,
      isWorld
    })
    if (!adapterResult.ok) {
      throw new Error(
        `Could not join scene LiveKit for stream keys: ${adapterResult.error} (HTTP ${adapterResult.status})`
      )
    }

    let url: string
    let token: string
    try {
      ;({ url, token } = parseLiveKitConnectionString(adapterResult.adapter))
    } catch {
      throw new Error('Gatekeeper returned an invalid LiveKit adapter for this scene.')
    }

    this.castWatchRoom?.disconnect()
    const room = new CastLiveKitRoom()
    this.castWatchRoom = room
    const ok = await room.connect(url, token)
    if (!ok) {
      this.castWatchRoom = null
      throw new Error('Could not connect to scene LiveKit room for stream-key video.')
    }

    const lkRoom = room.getRoom()
    console.log(
      `[cast] stream-key room=${lkRoom?.name ?? '?'} remotes=${lkRoom?.remoteParticipants.size ?? 0}`
    )
    if (lkRoom) {
      for (const p of lkRoom.remoteParticipants.values()) {
        const pubs = [...p.trackPublications.values()].map(
          (pub) => `${pub.kind}/${pub.source}/${pub.isSubscribed ? 'sub' : 'unsub'}`
        )
        console.log(`[cast] remote ${p.identity?.slice(0, 12)}… pubs=[${pubs.join(', ') || 'none'}]`)
      }
    }

    const unbind = room.bindVideoToHost(host, (attached) => {
      if (attached) this.sceneLandingView?.setCastLive(true)
      onUpdate?.(attached)
    }, opts)

    return () => {
      unbind()
      room.disconnect()
      if (this.castWatchRoom === room) this.castWatchRoom = null
    }
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
      login: this.login!,
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
      isChatNotificationSuppressed: (channelKey) =>
        this.socialChatDock?.isChatNotificationSuppressed(channelKey) ?? false
    })
    this.socialMobileNotifications.mount()
  }

  /** Off a scene landing → stop treating the dock as "reading" so scene chat can toast. */
  private collapseSocialChatThread(): void {
    this.socialChatDock?.collapseToChannelList()
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
   * Gate 3D entry: wallet or stable guest with AuthIdentity.
   * Guest is auto-minted on bootstrap; panel still used if session missing.
   */
  private ensurePlaySession(): Promise<boolean> {
    if (this.playSessionReady && this.login) return Promise.resolve(true)

    return new Promise((resolve) => {
      this.jumpInAuthPanel?.dispose()
      this.jumpInAuthPanel = new ExplorerAuthPanel({
        onComplete: (result) => {
          void (async () => {
            const login = result.kind === 'guest' ? await ensureGuestSession() : result
            this.login = login
            this.playSessionReady = true
            recordLoginEvent(login)
            this.applyLoginToSocialShellViews(login)
            this.sceneLandingView?.setPlaySessionReady(true)
            this.socialChat?.applyLogin(login)
            this.socialMobileNotifications?.setLogin(login)
            this.jumpInAuthPanel?.dispose()
            this.jumpInAuthPanel = null
            resolve(true)
          })()
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
      await this.startEditorApp({
        fromHistory: opts.fromHistory,
        replace: opts.replace
      })
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

    // Landing → Jump In: keep shell LiveKit alive so handoff can transfer the same room.
    // disconnectLiveKit() was killing the landing scene room (global session registry),
    // forcing a reconnect with a new participant id — voice/presence looked "different".
    await this.teardownScene({ keepLiveKit: opts.handoffShellComms === true })

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
      onPrepareOverlay: () => this.world?.cancelCameraPointer(),
      isPassportDisabled: (address) => world.sceneScript.isPassportDisabled(address)
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

    this.ensureDevProgressPanel()

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
        // Stop landing cast UI watchers only — do NOT disconnect the jump-target LiveKit.
        this.castLiveUnsub?.()
        this.castLiveUnsub = null
        if (this.castProbeTimer) {
          window.clearInterval(this.castProbeTimer)
          this.castProbeTimer = 0
        }
        // Separate Cast 2.0 watcher room (not primary world/scene) — always drop.
        this.castWatchRoom?.disconnect()
        this.castWatchRoom = null
        // Tear down pool LiveKits for every other place; transfer only jump-target rooms.
        const jumpKey = sceneConfig.commsPointer
        const transferred = this.socialChat?.detachCommsForWorldHandoff(jumpKey) ?? null
        if (transferred) {
          console.log(
            '[comms] handoff OK · transferring landing LiveKit to World ·',
            transferred.describeLiveKitRooms()
          )
          world.adoptComms(transferred, { isWorld: sceneConfig.source.kind === 'world' })
        } else {
          console.warn(
            '[comms] handoff FAILED · World will reconnect LiveKit (new participant id) · jumpKey=',
            jumpKey
          )
        }
      }
      const earlyCommsPromise = world.connectSceneCommsEarly(sceneConfig, opts.onProgress)

      this.worldLocationCard?.dispose()
      this.worldLocationCard = null
      this.minimap?.dispose()
      this.minimap = null

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
      // Genesis satellite minimap — parcel scenes only (worlds have no city basemap).
      if (sceneConfig.source.kind !== 'world') {
        this.minimap = new Minimap({
          getPlayerState: () => this.getMapPlayerState(),
          getPeers: () => this.world?.listMinimapPeers() ?? [],
          onClick: () => {
            // Stay in play — open the in-world map panel (not the 2D /map social shell).
            if (document.pointerLockElement) document.exitPointerLock()
            const overlay = this.settingsOverlay ?? this.createSettingsOverlay(
              this.world!.session,
              sceneConfig
            )
            this.settingsOverlay = overlay
            this.shell?.attachSettingsOverlay(overlay)
            overlay.show('map')
          }
        })
        this.worldLocationCard.root.classList.add('is-above-minimap')
        this.bindMinimapBelowLocationCard()
      }
      if (opts.deferPlayChromeReveal) {
        this.worldLocationCard.setVisible(false)
        this.minimap?.setVisible(false)
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
      // Keep nearby voice muted for the whole load (landing + hydrate + spawn).
      world.voice.setInPlay(false)
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
    this.bindNearbyVoice(world)
    // Only now — player is in-world and chrome is about to show (not during loading).
    world.unlockVoiceInPlay()
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
    this.minimap?.setVisible(false)
    this.mobileHud?.setShellVisible(false)
    this.world?.setSceneUiVisible(false)
  }

  private revealPlayChrome(): void {
    this.shell?.show()
    this.worldLocationCard?.setVisible(true)
    this.minimap?.setVisible(true)
    this.mobileHud?.setShellVisible(true)
    this.world?.setSceneUiVisible(true)
    // Pill may have been hidden at mount (height 0) — place circle under it now.
    this.layoutMinimapBelowPill()
    requestAnimationFrame(() => this.layoutMinimapBelowPill())
  }

  /** Keep circular minimap flush under the location pill (no overlap). */
  private layoutMinimapBelowPill(): void {
    if (!this.minimap || !this.worldLocationCard) return
    this.minimap.placeBelow(this.worldLocationCard.root, 8)
  }

  private bindMinimapBelowLocationCard(): void {
    this.minimapLayoutObserver?.disconnect()
    this.minimapLayoutObserver = null
    if (!this.minimap || !this.worldLocationCard) return
    this.layoutMinimapBelowPill()
    requestAnimationFrame(() => this.layoutMinimapBelowPill())
    this.minimapLayoutObserver = new ResizeObserver(() => this.layoutMinimapBelowPill())
    this.minimapLayoutObserver.observe(this.worldLocationCard.root)
  }

  private unbindMinimapLayout(): void {
    this.minimapLayoutObserver?.disconnect()
    this.minimapLayoutObserver = null
  }

  private getLocationCoordsLabel(): string {
    const state = this.getMapPlayerState()
    if (state?.parcelKey) return state.parcelKey
    const pos = this.world?.getPlayerPosition()
    if (pos) return `${Math.floor(pos.x)}, ${Math.floor(pos.z)}`
    return '—'
  }

  private parcelFromPlayerState(
    state: MapPlayerState | null
  ): { px: number; py: number } | null {
    if (!state?.parcelKey) return null
    const m = /^(-?\d+),(-?\d+)$/.exec(state.parcelKey.trim())
    if (!m) return null
    return { px: parseInt(m[1]!, 10), py: parseInt(m[2]!, 10) }
  }

  private ensureDevProgressPanel(): DevProgressPanel {
    if (!this.devProgressPanel) {
      this.devProgressPanel = new DevProgressPanel({
        getSession: () => this.world?.session ?? this.shellSession ?? null
      })
    }
    return this.devProgressPanel
  }

  /** What's new toast + profile menu → same panel as </> → Shipped. */
  private openShippedChangelog(): void {
    this.ensureDevProgressPanel().showTab('progress')
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
      faceUrl: world.social.getLocalDisplay().faceUrl,
      // Visual body facing → canvas angle (tracks avatar while moving).
      facingYaw: world.getPlayerMinimapAngle() ?? undefined
    }
  }

  private bindNearbyVoice(world: World): void {
    this.unsubVoiceUi?.()
    this.unsubVoiceUi = null
    this.unsubVoiceSpeaking?.()
    this.unsubVoiceSpeaking = null
    world.syncVoiceRoom()
    this.shell?.bindNearbyVoice(world.voice)
    console.log('[voice] panel bound ·', world.comms.describeLiveKitRooms())
    this.unsubVoiceUi = world.voice.subscribe((snap) => {
      this.shell?.setNearbyVoiceUi({
        hearing: snap.hearing,
        speaking: snap.speaking,
        micLive: snap.micLive,
        pttHeld: snap.pttHeld,
        backgroundMuted: snap.backgroundMuted,
        remoteCount: snap.remoteCount,
        roomReady: snap.roomReady
      })
    })
    // 3 green bars over name tags while LiveKit marks speakers active.
    this.unsubVoiceSpeaking = world.voice.subscribeSpeaking((levels) => {
      world.applyVoiceLevelsToNameTags(levels)
    })
  }

  private async teardownScene(opts?: { keepLiveKit?: boolean }): Promise<void> {
    this.unsubVoiceUi?.()
    this.unsubVoiceUi = null
    this.unsubVoiceSpeaking?.()
    this.unsubVoiceSpeaking = null
    this.shell?.bindNearbyVoice(null)
    this.world?.setVoluntaryEmoteAllowedHandler(null)
    this.teardownExplorer()
    this.editorApp?.dispose()
    this.editorApp = null
    this.profileUi?.dispose()
    this.profileUi = null
    this.mobileHud?.dispose()
    this.mobileHud = null
    this.unbindMinimapLayout()
    this.worldLocationCard?.dispose()
    this.worldLocationCard = null
    this.minimap?.dispose()
    this.minimap = null
    this.chatPanel?.hide()
    this.hidePlayChrome()
    await disconnectAll(this.world, { keepLiveKit: opts?.keepLiveKit === true })
    this.world = null
    if (this.container) this.container.innerHTML = ''
  }

  /** Sign out wallet → fall back to stable browser guest (same machine keeps guest key). */
  private async signOutFrom2dShell(): Promise<void> {
    clearStoredIdentity()
    this.socialChat?.signOut()
    this.teardownSocialChatShell(true)
    this.shellSession = null
    if (!this.world) {
      this.settingsOverlay?.dispose()
      this.settingsOverlay = null
    } else {
      this.settingsOverlay?.hide()
    }
    const guest = await ensureGuestSession()
    this.login = guest
    this.playSessionReady = true
    this.applyLoginToSocialShellViews(this.login)
    this.sceneLandingView?.setPlaySessionReady(true)
    this.sceneLandingView?.setLogin(this.login)
    this.ensureSocialChatShell()
    this.socialChat?.applyLogin(guest)
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
    bindWhatsNewShippedOpener(null)
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
