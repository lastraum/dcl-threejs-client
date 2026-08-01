import { loginHasCommsIdentity, type LoginResult } from '../auth/AuthClient'
import { clearStoredIdentity } from '../auth/identityStore'
import {
  applyRouteToHistory,
  resolveRouteTarget,
  routeEquals,
  routePathForTarget,
  type RouteTarget
} from '../dcl/content/route'
import { resolveSceneFromRoute, summarizeSceneContent } from '../dcl/content/resolveScene'
import { EditorApp } from '../editor/EditorApp'
import { World } from '../core/World'
import { MultiSceneRuntime } from '../dcl/multiScene/MultiSceneRuntime'
import { PortableExperienceManager } from '../dcl/multiScene/PortableExperienceManager'
import { resolvePortableExperiencesPolicy } from '../dcl/multiScene/resolvePortableExperiences'
import { readSceneDevQueryKey } from '../environment/fftOcean/readFftOceanOverride'
import { disconnectAll } from '../network/SessionConnections'
import { clearVrmRamCache } from '../avatar/vrm/vrmRamCache'
import { SessionIdentity } from '../network/SessionIdentity'
import { ClientShell } from './ui/shell/ClientShell'
import { isTextInputFocused } from './ui/textInputFocus'
import { isNameTagsSceneLocked, toggleUserNameTagsVisible } from './ui/nameTagVisibility'
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
import { getPrivateMessagesService } from '../social/PrivateMessagesService'
import { CommunityFollowController } from '../social/CommunityFollowController'
import { LivePip } from './ui/live/LivePip'
import type { LiveSession } from '../social/globalLiveWire'
import { FollowFlagManager } from '../social/FollowFlagManager'
import { TourFocusController } from '../social/TourFocusController'
import {
  followTargetLabel,
  followTargetToRoute,
  routeToFollowTarget,
  type FollowTarget
} from '../social/communityFollowWire'
import { clientSettings } from '../rendering/ClientSettings'
import { TourOptionsPopup } from './ui/tour/TourOptionsPopup'
import { TourEndModal } from './ui/tour/TourEndModal'
import { TourFlagImageModal } from './ui/tour/TourFlagImageModal'
import { TourRejoinPanel } from './ui/tour/TourRejoinPanel'
import {
  deleteTourSessionPhotos,
  getTourLocationPhoto,
  listTourLocationPhotos,
  putTourLocationPhoto
} from '../social/tourLocationPhotoStore'
import { downloadTourCsvOnly, downloadTourZip } from '../social/tourExport'
import { PreferencesPanel } from './ui/settings/PreferencesPanel'
import { SettingsOverlay, type SettingsTab } from './ui/settings/SettingsOverlay'
import { warmBackpackProvenance } from './ui/settings/backpackProvenance'
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
import { LivePageView } from './ui/explore/LivePageView'
import { LootBagPageView } from './ui/explore/LootBagPageView'
import { MapPageView } from './ui/explore/MapPageView'
import { ProfilePageView } from './ui/explore/ProfilePageView'
import type { SocialShellTab } from './ui/explore/SocialShellTopNav'
import { SocialMobileNotifications } from './ui/explore/SocialMobileNotifications'
import { CommunityVoiceFloatingBar } from './ui/communities/CommunityVoiceFloatingBar'
import { getCommunityVoiceSession } from '../social/CommunityVoiceSession'
import { SceneLandingView } from './ui/landing/SceneLandingView'
import type { DclEvent } from '../social/dclEvents'
import {
  enrichResolvedScenePublicTitle,
  fetchPublicSceneTitle
} from '../social/sceneDisplayTitle'
import { fetchSceneLandingMeta } from '../social/sceneLanding'
import { LiveToolsSession } from '../social/LiveToolsSession'
import { placeKeyFromScene } from '../social/liveToolsWire'
import { LiveToolsUi } from './ui/liveTools/LiveToolsUi'
import { recordLoginEvent } from '../analytics/recordLogin'
import {
  startDwellTracking,
  startLandingDwell,
  stopDwellTracking,
  stopLandingDwell
} from '../analytics/dwell'
import { placeFieldsFromRoute } from '../analytics/placeKey'
import {
  beginPlaySession,
  setAnalyticsLogin,
  track,
  type AnalyticsSource
} from '../analytics/track'

/** Owns world lifecycle — explorer / landing / play, navigation, and sign-out. */
export class AppController {
  private container: HTMLElement | null = null
  private world: World | null = null
  private shell: ClientShell | null = null
  /**
   * Session-scoped PE manager — survives World rebuild on /goto so enabled PEs
   * restore without re-prompt (workers rebind to the new host).
   */
  private readonly peManager = new PortableExperienceManager()
  private readonly multiSceneRuntime = new MultiSceneRuntime({
    peManager: this.peManager
  })
  /** Serialize promote — concurrent dwells were spamming seamless jumps. */
  private promoteInFlight: Promise<void> | null = null
  private promoteInFlightKey = ''
  private debugPanel: DebugPanel | null = null
  private devProgressPanel: DevProgressPanel | null = null
  private worldLocationCard: WorldLocationCard | null = null
  private minimap: Minimap | null = null
  /** Shared translucent frame: location pill + circular minimap (Explorer-style). */
  private locationMapStack: HTMLDivElement | null = null
  private minimapLayoutObserver: ResizeObserver | null = null
  /** Parcel key → resolved display title (soft-route HUD). */
  private readonly locationTitleCache = new Map<string, string>()
  /** Race guard for async title fetches while walking. */
  private locationTitleGen = 0
  /** Last parcel key applied to the location pill title. */
  private lastLocationTitleKey = ''
  /**
   * Script-warm queue — CBD can enqueue many neighbors; never run resolve+IDB
   * prefetch unbounded in parallel (starves primary rAF → 2fps thrash).
   */
  private readonly scriptWarmQueue: Array<{ x: number; y: number }> = []
  private readonly scriptWarmQueuedKeys = new Set<string>()
  private scriptWarmInFlight = 0
  private static readonly SCRIPT_WARM_MAX_CONCURRENT = 1
  /** Parcel to center the full map on after leave-play (minimap click). */
  private mapFocusParcel: { px: number; py: number } | null = null
  /**
   * Last live map pose while World was up — full /map tears down the scene, so
   * getMapPlayerState() would go null without this.
   */
  private lastMapPlayerState: MapPlayerState | null = null
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
  private livePageView: LivePageView | null = null
  private livePip: LivePip | null = null
  private unsubLiveSessionEnded: (() => void) | null = null
  private lootBagPageView: LootBagPageView | null = null
  private communitiesPageView: CommunitiesPageView | null = null
  private profilePageView: ProfilePageView | null = null
  private sceneLandingView: SceneLandingView | null = null
  private socialChat: SocialChatController | null = null
  private socialChatDock: SocialChatDock | null = null
  private socialMobileNotifications: SocialMobileNotifications | null = null
  /**
   * 2D companion-style community voice bar — session is module-singleton;
   * bar only shows outside 3D play and must not leave voice on nav.
   */
  private communityVoiceBar: CommunityVoiceFloatingBar | null = null
  /**
   * Community Follow/Tour — survives World rebuild on /goto so follow opt-in
   * and lead session stay alive across teleports.
   */
  private communityFollow: CommunityFollowController | null = null
  private unsubCommunityFollow: (() => void) | null = null
  /**
   * PM LiveKit play-session hold — AppController retains so World.dispose on
   * teleport does not drop holders to 0 (same pattern as communityFollow).
   */
  private pmPlaySessionHeld = false
  /** Tour leader flag (circular badge above nametag) — session-scoped across World rebuilds. */
  private followFlagManager: FollowFlagManager | null = null
  /** Tour Focus — follower lens takeover; session-scoped across World rebuilds. */
  private tourFocus: TourFocusController | null = null
  private tourFocusHost: import('../rendering/SceneHost').SceneHost | null = null
  /** In-scene live polls + Q&A (scene LiveKit topic — not chat). */
  private liveToolsSession: LiveToolsSession | null = null
  private liveToolsUi: LiveToolsUi | null = null
  private unsubLiveToolsTopic: (() => void) | null = null
  /**
   * Follower Esc during Focus: stay on tour, dismiss only this Focus period.
   * Cleared when leader turns Focus off (or tour ends) so the next Focus ON re-enters.
   */
  private tourFocusOptOut = false
  private tourOptionsPopup: TourOptionsPopup | null = null
  private tourEndModal: TourEndModal | null = null
  private tourFlagImageModal: TourFlagImageModal | null = null
  /** Leader reconnect after disconnect — Rejoin / Cancel next to Tour Options icon. */
  private tourRejoinPanel: TourRejoinPanel | null = null
  /** Locations tab: next Camera Reel shot binds to this location id. */
  private tourPhotoBindLocationId: string | null = null
  /** Re-open this community thread on ChatPanel after a follow jump World rebuild. */
  private pendingFollowCommunityOpen: { id: string; name: string } | null = null
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
  /**
   * Explorer U — client chrome (sidebar, minimap, chat, mobile HUD).
   * Independent of scene UI; reset when leaving play.
   */
  private clientHudVisible = true

  async start(container: HTMLElement): Promise<void> {
    if (this.running) return
    this.running = true
    this.container = container

    window.addEventListener('popstate', this.onPopState)
    window.addEventListener('keydown', this.onPlayChromeHotkey, true)
    this.wireSceneBanDebug()
    this.wireProfileDebug()
    // Toast + profile "What's new" open the same Dev Progress → Shipped view.
    this.ensureDevProgressPanel()
    bindWhatsNewShippedOpener(() => this.openShippedChangelog())

    const postLoginRoute = resolveRouteTarget()
    this.login = await resolveInitialLogin()
    // Wallet resume or stable guest both get AuthIdentity — Jump In / LiveKit ready.
    this.playSessionReady = hasResumedWalletSession() || this.login.kind === 'guest'
    setAnalyticsLogin(this.login)
    recordLoginEvent(this.login)

    if (postLoginRoute.kind === 'editor') {
      const hudEl = document.getElementById('hud')
      if (hudEl) hudEl.hidden = true
      this.currentRoute = postLoginRoute
      this.appMode = 'explorer'
      this.syncCommunityVoiceBarVisibility()
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

    if (postLoginRoute.kind === 'live') {
      await this.showLivePage({ replace: true })
      return
    }

    if (postLoginRoute.kind === 'lootbag') {
      await this.showLootBagPage({ replace: true })
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

  private analyticsSourceForNav(opts: {
    fromHistory?: boolean
    source?: AnalyticsSource
  }): AnalyticsSource {
    if (opts.source) return opts.source
    if (opts.fromHistory) return 'history'
    return 'unknown'
  }

  private trackNavigate(
    from: RouteTarget | null,
    to: RouteTarget,
    method: string,
    source?: AnalyticsSource
  ): void {
    const fromFields = placeFieldsFromRoute(from)
    const toFields = placeFieldsFromRoute(to)
    if (!toFields && !fromFields) return
    const isGoto = method === 'goto'
    track(isGoto ? 'goto' : 'navigate', {
      place: toFields,
      route: to,
      source: source ?? (isGoto ? 'goto' : 'unknown'),
      from_place_key: fromFields?.place_key ?? null,
      to_place_key: toFields?.place_key ?? null,
      props: { method }
    })
  }

  private async navigateTo(
    target: RouteTarget,
    opts: { fromHistory?: boolean; replace?: boolean; source?: AnalyticsSource } = {}
  ): Promise<void> {
    if (this.navigating) return

    const from = this.currentRoute
    const source = this.analyticsSourceForNav(opts)
    if (from && !routeEquals(from, target)) {
      this.trackNavigate(from, target, opts.fromHistory ? 'history' : 'ui', source)
    }

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

    if (target.kind === 'live') {
      this.navigating = true
      try {
        await this.showLivePage({ fromHistory: opts.fromHistory, replace: opts.replace })
      } finally {
        this.navigating = false
      }
      return
    }

    if (target.kind === 'lootbag') {
      this.navigating = true
      try {
        await this.showLootBagPage({ fromHistory: opts.fromHistory, replace: opts.replace })
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
    else if (tab === 'live') void this.navigateTo({ kind: 'live' })
    else if (tab === 'lootbag') void this.navigateTo({ kind: 'lootbag' })
    else if (tab === 'editor') void this.navigateTo({ kind: 'editor' })
    else void this.navigateTo({ kind: 'events' })
    // Mode change is async via navigateTo — bar visibility refreshed when each show* sets appMode.
  }

  private async startEditorApp(
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'editor' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'editor' }
    this.appMode = 'explorer'
    this.syncCommunityVoiceBarVisibility()
    this.clearSceneBanWatch()

    await this.teardownScene({ clearVrmCache: true })
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownLivePage()
    this.teardownLootBagPage()
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
    onEnter3D: () => void
  } {
    return {
      onLoginChange: (login) => {
        this.login = login
        this.playSessionReady = true
        recordLoginEvent(login)
        // Pre-warm backpack provenance (mint numbers + collection directory) so
        // detail panes resolve instantly when the backpack first opens.
        if (login.kind === 'wallet') warmBackpackProvenance(login.address)
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
      onEnter3D: () => {
        void this.openOverlayFromShell('explore')
      },
      onOpenProfile: () => this.openLocalProfileFromShell(),
      onOpenWhatsNew: () => openWhatsNewFromMenu(),
      ...this.socialShellSocialHandlers()
    }
  }

  /** Open backpack from 2D profile menu — SettingsOverlay is play-only unless we create it here. */
  private async openBackpackFromShell(): Promise<void> {
    return this.openOverlayFromShell('backpack')
  }

  /** Open the 3D overlay (any tab) from the 2D shell; play-only unless created here. */
  private async openOverlayFromShell(tab: SettingsTab): Promise<void> {
    if (this.login?.kind !== 'wallet') return
    try {
      const overlay = await this.ensureSettingsOverlay()
      overlay.show(tab)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('client', `Overlay open failed: ${msg}`, { level: 'error' })
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
        // Always in-world /goto-style load — never drop back to 2D landing from map Jump In.
        void this.jumpInToScene(
          { kind: 'coords', x: px, y: py, segment: `${px},${py}` },
          {
            entry: this.appMode === 'play' ? 'teleport' : 'map',
            source: 'map',
            fastAssets: this.appMode === 'play'
          }
        )
      },
      onMapJumpInWorld: (worldName) => {
        this.settingsOverlay?.hide()
        const name = worldName.trim()
        if (!name) return
        void this.jumpInToScene(
          { kind: 'world', worldName: name, segment: name },
          {
            entry: this.appMode === 'play' ? 'teleport' : 'map',
            source: 'map',
            fastAssets: this.appMode === 'play'
          }
        )
      },
      onEventJumpIn: (target, _event: DclEvent) => {
        this.settingsOverlay?.hide()
        void this.jumpInToScene(target, {
          fastAssets: true,
          entry: this.appMode === 'play' ? 'teleport' : 'event_card',
          source: 'map'
        })
      },
      onEventViewScene: (target, _event: DclEvent) => {
        this.settingsOverlay?.hide()
        if (target.kind === 'coords' || target.kind === 'world') {
          // Already in 3D — Jump-to-scene-page is 2D only; teleport instead.
          if (this.appMode === 'play') {
            void this.jumpInToScene(target, { fastAssets: true, entry: 'teleport', source: 'map' })
          } else {
            void this.showSceneLanding(target)
          }
        }
      },
      onPlaceJumpIn: (target) => {
        this.settingsOverlay?.hide()
        // Jump In must load the scene (same as /goto), not open 2D landing.
        void this.jumpInToScene(target, {
          entry: this.appMode === 'play' ? 'teleport' : 'map',
          source: 'map',
          fastAssets: this.appMode === 'play'
        })
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
      },
      onOpenCommunityChat: (community) => {
        this.openCommunityChatChannel(community.id, community.name)
      },
      onJoinedCommunity: (community) => {
        this.socialChat?.getSocial()?.noteJoinedCommunity(community)
        this.world?.social.noteJoinedCommunity(community)
        void this.socialChat?.getSocial()?.refreshMemberCommunities()
        void this.world?.social.refreshMemberCommunities()
      },
      getFollow: () => this.communityFollow,
      getCurrentRoute: () => this.currentRoute,
      onExitTo2D: () => {
        this.settingsOverlay?.hide()
        void this.navigateTo({ kind: 'blank' })
      }
    })
  }

  /** Community modal 💬 → in-world ChatPanel or 2D SocialChatDock. */
  private openCommunityChatChannel(communityId: string, displayName: string): void {
    this.settingsOverlay?.hide()
    if (this.appMode === 'play') {
      if (this.chatPanel) {
        this.shell?.openCommunityChat(communityId, displayName)
      } else {
        // Mid World rebuild (follow jump) — open after ChatPanel is reattached.
        this.pendingFollowCommunityOpen = { id: communityId, name: displayName }
      }
      return
    }
    this.ensureSocialChatShell()
    this.socialChatDock?.openCommunityChat(communityId, displayName)
  }

  /**
   * Community Follow / Tour — toast on start; hard /goto only for followers
   * (soft parcel walk is label-only; auto-pilot is a future mode).
   * Controller is session-scoped (survives World rebuild); re-attached to each world.social.
   */
  private wireCommunityFollow(world: World): void {
    if (!this.communityFollow) {
      this.communityFollow = new CommunityFollowController({
        publish: (communityId, msg) => {
          const social = this.world?.social
          if (!social) return Promise.resolve(false)
          return social.publishCommunityControl(communityId, msg)
        },
        getLocalAddress: () => {
          const a = this.login?.kind === 'wallet' || this.login?.kind === 'guest' ? this.login.address : null
          return a?.toLowerCase() ?? this.world?.social.getLocalAddress() ?? null
        },
        getCommunities: () => this.world?.social.getCommunities() ?? []
      })
    }
    if (!this.followFlagManager) {
      this.followFlagManager = new FollowFlagManager()
    }
    this.ensureTourFocusController(world)

    world.social.setFollowController(this.communityFollow)
    world.setFollowFlagManager(this.followFlagManager)
    // Restore flag visual after World rebuild if tour still active.
    this.syncFollowFlagFromController()
    // Re-bind Tour Focus tick after World rebuild.
    this.bindTourFocusTick(world)
    // If we were following under Focus, re-enter after rebuild (goto).
    this.syncTourFocusFromController()

    this.unsubCommunityFollow?.()
    this.unsubCommunityFollow = this.communityFollow.subscribe((ev) => {
      if (ev.kind === 'changed') {
        this.syncTourUiFromController()
        return
      }
      if (ev.kind === 'flag_changed') {
        // Only tour participants render the leader flag (leader + followers).
        if (this.isTourParticipant(ev.communityId)) {
          this.applyFollowFlag(ev.leaderAddress, ev.flagDataUrl)
        } else if (!this.communityFollow?.isLeading() && !this.communityFollow?.isFollowing()) {
          this.followFlagManager?.clear()
        }
        this.syncTourOptionsSidebarVisibility()
        return
      }
      if (ev.kind === 'focus_changed') {
        this.applyTourFocusEvent(ev.leaderAddress, ev.focusActive, ev.communityId)
        this.tourOptionsPopup?.refresh()
        return
      }
      if (ev.kind === 'cam_update') {
        if (this.communityFollow?.isFollowing(ev.communityId) && !this.tourFocusOptOut) {
          this.tourFocus?.setCam(ev.cam)
          if (!this.tourFocus?.isActive()) {
            this.tourFocus?.enter(ev.leaderAddress, ev.cam)
          }
        }
        return
      }
      if (ev.kind === 'tour_ended') {
        this.tourFocusOptOut = false
        this.tourFocus?.exit()
        this.closeTourRejoinPanel()
        this.syncTourUiFromController()
        return
      }
      if (ev.kind === 'leader_away') {
        this.ensureSocialMobileNotifications()
        const name =
          this.world?.social.getCommunities().find((c) => c.id.toLowerCase() === ev.communityId)
            ?.name ?? 'Community'
        const mins = Math.max(1, Math.round(ev.forceEndInMs / 60_000))
        this.socialMobileNotifications?.pushSystemToast({
          id: `tour-away:${ev.sessionId}`,
          appName: 'COMMUNITY · TOUR',
          title: name,
          sub: `Leader disconnected — tour ends in ~${mins} min if they don't return`,
          dismissMs: 12_000
        })
        return
      }
      if (ev.kind === 'leader_back') {
        this.ensureSocialMobileNotifications()
        const name =
          this.world?.social.getCommunities().find((c) => c.id.toLowerCase() === ev.communityId)
            ?.name ?? 'Community'
        this.socialMobileNotifications?.pushSystemToast({
          id: `tour-back:${ev.sessionId}`,
          appName: 'COMMUNITY · TOUR',
          title: name,
          sub: 'Tour leader is back',
          dismissMs: 6_000
        })
        return
      }
      if (ev.kind === 'leader_resume_available') {
        this.openTourRejoinPanel(ev.snapshot.communityId, ev.snapshot.lastTarget)
        return
      }
      if (ev.kind === 'tour_started') {
        // Leader sees own flag immediately; followers apply when they Follow (or via flag_changed).
        if (ev.isLocalLeader && ev.session.flagDataUrl) {
          this.applyFollowFlag(ev.session.leaderAddress, ev.session.flagDataUrl)
        }
        if (ev.isLocalLeader) {
          this.closeTourRejoinPanel()
        }
        this.syncTourOptionsSidebarVisibility()
        if (!ev.isLocalLeader) {
          this.ensureSocialMobileNotifications()
          const name =
            this.world?.social.getCommunities().find((c) => c.id.toLowerCase() === ev.communityId)
              ?.name ?? 'Community'
          const sub = ev.lateJoin
            ? 'Tour in progress — open community chat to Follow'
            : 'Tour started — open community chat to Follow'
          this.socialMobileNotifications?.pushSystemToast({
            id: `tour:${ev.session.sessionId}`,
            appName: 'COMMUNITY · TOUR',
            title: name,
            sub,
            dismissMs: 10_000,
            onClick: () => this.openCommunityChatChannel(ev.communityId, name)
          })
        }
        return
      }
      if (ev.kind === 'follow_goto') {
        // Avoid re-entrancy while already navigating from a previous pulse.
        if (this.navigating) return
        // Ensure flag is on for this follower when jumping with the leader.
        this.syncFollowFlagFromController()
        const route = followTargetToRoute(ev.target)
        // Already with the leader (same primary / same feet parcel) — don't reload.
        // Leader /goto or map Jump In to a *new* place still teleports followers.
        if (this.isAlreadyAtFollowTarget(ev.target)) {
          clientDebugLog.log(
            'social',
            `Follow skip teleport — already at ${followTargetLabel(ev.target)}`,
            { level: 'info', alsoConsole: true }
          )
          return
        }
        // After World rebuild, re-open the community thread (Follow bar + tour context).
        const name =
          this.world?.social
            .getCommunities()
            .find((c) => c.id.toLowerCase() === ev.communityId.toLowerCase())?.name ?? 'Community'
        this.pendingFollowCommunityOpen = { id: ev.communityId, name }
        void this.jumpInToScene(route, { fastAssets: true, source: 'goto' })
      }
    })
    this.syncTourUiFromController()
    // Offer resume if this wallet was leading before a refresh/disconnect.
    queueMicrotask(() => this.communityFollow?.checkLeaderResumeOffer())
  }

  private openTourRejoinPanel(
    communityId: string,
    lastTarget: import('../social/communityFollowWire').FollowTarget | null
  ): void {
    this.closeTourRejoinPanel()
    const follow = this.communityFollow
    if (!follow) return
    // Show Tour Options (flag) icon first so the panel can dock next to it.
    this.shell?.setTourOptionsVisible(true)
    this.syncTourOptionsSidebarVisibility()
    const name =
      this.world?.social.getCommunities().find((c) => c.id.toLowerCase() === communityId.toLowerCase())
        ?.name ?? 'Community'
    const open = (): void => {
      if (this.tourRejoinPanel) return
      this.tourRejoinPanel = new TourRejoinPanel({
        getState: () => ({
          communityName: name,
          lastTarget: follow.getPendingLeaderResume()?.lastTarget ?? lastTarget
        }),
        anchor: () => this.shell?.getTourOptionsButtonElement?.() ?? undefined,
        onRejoin: async () => {
          const result = await follow.resumeLeadFromSnapshot()
          this.closeTourRejoinPanel()
          if (!result.ok) {
            clientDebugLog.log('social', 'Tour rejoin failed', { level: 'warn', alsoConsole: true })
            this.syncTourOptionsSidebarVisibility()
            return
          }
          this.syncTourUiFromController()
          if (result.target) {
            const route = followTargetToRoute(result.target)
            if (!this.isAlreadyAtFollowTarget(result.target)) {
              void this.jumpInToScene(route, { fastAssets: true, source: 'goto' })
            }
          }
        },
        onCancel: async () => {
          await follow.cancelLeaderResume()
          this.closeTourRejoinPanel()
          this.syncTourUiFromController()
        },
        onClose: () => {
          this.tourRejoinPanel = null
        }
      })
    }
    // Wait a frame so the flag button is laid out before anchoring.
    requestAnimationFrame(() => requestAnimationFrame(open))
  }

  private closeTourRejoinPanel(): void {
    this.tourRejoinPanel?.dispose()
    this.tourRejoinPanel = null
  }

  private ensureTourFocusController(world: World): void {
    if (this.tourFocus) {
      // World rebuilds create a new SceneHost — recreate controller against the live host.
      const prevHost = this.tourFocusHost
      if (prevHost === world.host) return
      const wasActive = this.tourFocus.isActive()
      const leader = this.tourFocus.getLeaderAddress()
      const cam = this.communityFollow?.getLastCam() ?? null
      this.tourFocus.dispose()
      this.tourFocus = null
      this.tourFocusHost = null
      const next = this.createTourFocusController(world)
      if (wasActive && leader && !this.tourFocusOptOut) next.enter(leader, cam)
      return
    }
    this.createTourFocusController(world)
  }

  private createTourFocusController(world: World): TourFocusController {
    this.tourFocusHost = world.host
    const controller = new TourFocusController({
      host: world.host,
      getLeaderFeet: () => {
        const addr = this.tourFocus?.getLeaderAddress()
        if (!addr) return null
        // Require a real posed peer (not provisional colocate-at-local).
        return this.world?.getRemoteAvatarManager()?.getPeerRootForTour(addr) ?? null
      },
      setPlayerTourFocusActive: (active) => {
        this.world?.setPlayerTourFocusActive(active)
      },
      isPhotoCameraActive: () => Boolean(this.world?.isPhotoCameraActive()),
      onLeave: () => {
        // Esc = dismiss this Focus period only (stay on tour). Next Focus ON re-enters.
        this.tourFocusOptOut = true
        this.tourFocus?.exit()
      }
    })
    this.tourFocus = controller
    return controller
  }

  private bindTourFocusTick(world: World): void {
    this.ensureTourFocusController(world)
    world.setTourFocusTick((delta) => {
      // Leader: stream freecam + FOV while Focus is on (every frame sample; publish ~10Hz).
      this.communityFollow?.tickLeaderCam(() => {
        const fc = this.world?.getPlayerFreecamState()
        if (!fc) return null
        return {
          fp: fc.firstPerson,
          yaw: fc.yaw,
          pitch: fc.pitch,
          dist: fc.dist,
          fov: clientSettings.getFov()
        }
      })
      // Follower lens — after remote pose so leader feet are current.
      this.tourFocus?.update(delta)
    })
  }

  private applyTourFocusEvent(
    leaderAddress: string,
    focusActive: boolean,
    communityId: string
  ): void {
    // Leaders don't take over their own camera.
    if (this.communityFollow?.isLeading(communityId)) {
      return
    }
    if (!this.communityFollow?.isFollowing(communityId)) {
      this.tourFocus?.exit()
      return
    }
    if (focusActive) {
      // New Focus period from leader — clear Esc opt-out so we re-enter.
      this.tourFocusOptOut = false
      // Prefer last cam sample; enter() falls back to a default 3P boom if none yet.
      const cam = this.communityFollow.getLastCam(communityId)
      this.tourFocus?.enter(leaderAddress, cam)
      clientDebugLog.log(
        'social',
        `Tour Focus enter · leader=${leaderAddress.slice(0, 10)}… cam=${cam ? 'yes' : 'default'}`,
        { level: 'info', alsoConsole: true }
      )
    } else {
      // Leader ended Focus — ready for the next ON.
      this.tourFocusOptOut = false
      this.tourFocus?.exit()
    }
  }

  private syncTourFocusFromController(): void {
    const follow = this.communityFollow
    if (!follow?.isFollowing()) {
      this.tourFocus?.exit()
      return
    }
    if (!follow.isFocusReceiving() || this.tourFocusOptOut) {
      // Keep opt-out while leader Focus is still on; exit lens only.
      if (!follow.isFocusReceiving()) this.tourFocusOptOut = false
      this.tourFocus?.exit()
      return
    }
    const session =
      follow.listSessions().find((s) => follow.isFollowing(s.communityId) && s.focusActive) ?? null
    if (session) {
      this.tourFocus?.enter(session.leaderAddress, session.lastCam)
    } else {
      this.tourFocus?.exit()
    }
  }

  /** Local user is leading or following this community tour. */
  private isTourParticipant(communityId: string): boolean {
    const follow = this.communityFollow
    if (!follow) return false
    const id = communityId.trim().toLowerCase()
    return follow.isLeading(id) || follow.isFollowing(id)
  }

  private applyFollowFlag(leaderAddress: string, flagDataUrl: string | null): void {
    if (!this.followFlagManager) {
      this.followFlagManager = new FollowFlagManager()
      this.world?.setFollowFlagManager(this.followFlagManager)
    }
    if (!flagDataUrl) {
      this.followFlagManager.clear()
      return
    }
    this.followFlagManager.setLeader(leaderAddress)
    this.followFlagManager.setImageDataUrl(flagDataUrl)
  }

  /**
   * Flag 3D prop only for tour participants; sidebar Tour Options only for leader.
   */
  private syncFollowFlagFromController(): void {
    const follow = this.communityFollow
    if (!follow?.isLeading() && !follow?.isFollowing()) {
      this.followFlagManager?.clear()
      return
    }
    const active = follow.getActiveFlag()
    if (active?.flagDataUrl) {
      this.applyFollowFlag(active.leaderAddress, active.flagDataUrl)
    } else {
      this.followFlagManager?.clear()
    }
  }

  private syncTourOptionsSidebarVisibility(): void {
    // Keep the flag icon visible while leading, rejoin panel open, or resume available.
    const show =
      Boolean(this.communityFollow?.isLeading()) ||
      Boolean(this.tourRejoinPanel) ||
      Boolean(this.communityFollow?.getPendingLeaderResume())
    this.shell?.setTourOptionsVisible(show)
  }

  private syncTourUiFromController(): void {
    this.syncFollowFlagFromController()
    this.syncTourOptionsSidebarVisibility()
    this.syncTourFocusFromController()
  }

  /** Sidebar 🚩 Tour Options — Users / Locations / Settings (leader). */
  private openTourOptionsPopup(): void {
    if (this.tourOptionsPopup) {
      this.tourOptionsPopup.dispose()
      this.tourOptionsPopup = null
    }
    const photoThumbs = new Map<string, string>()

    const refreshThumbs = async () => {
      const follow = this.communityFollow
      if (!follow?.isLeading()) return
      const session = follow.listSessions().find((s) => follow.isLeading(s.communityId))
      if (!session) return
      try {
        const photos = await listTourLocationPhotos(session.sessionId)
        photoThumbs.clear()
        for (const p of photos) photoThumbs.set(p.locationId, p.dataUrl)
        this.tourOptionsPopup?.refresh()
      } catch {
        /* ignore */
      }
    }
    void refreshThumbs()

    this.tourOptionsPopup = new TourOptionsPopup({
      getState: () => {
        const follow = this.communityFollow
        const active = follow?.getActiveFlag()
        const leading = Boolean(follow?.isLeading())
        const cid =
          active?.communityId ??
          follow?.listSessions().find((s) => follow.isLeading(s.communityId))?.communityId
        const communityName = cid
          ? this.world?.social.getCommunities().find((c) => c.id.toLowerCase() === cid)?.name ??
            null
          : null
        const roster = (follow?.getTourRoster() ?? []).map((entry) => {
          const peer = this.world?.social.getPeerDisplay(entry.address)
          return {
            address: entry.address,
            displayName:
              peer?.displayName?.trim() ||
              `${entry.address.slice(0, 6)}…${entry.address.slice(-4)}`,
            faceUrl: peer?.faceUrl ?? null,
            isLeader: entry.isLeader
          }
        })
        const locations = (follow?.getLocations() ?? []).map((loc) => ({
          ...loc,
          photoThumb: photoThumbs.get(loc.id) ?? null
        }))
        return {
          isLeading: leading,
          flagEnabled: Boolean(active?.flagDataUrl),
          focusActive: Boolean(follow?.isFocusActive()),
          communityName,
          roster,
          locations,
          photoBindLocationId: this.tourPhotoBindLocationId
        }
      },
      resolveFaceUrl: async (address) => {
        try {
          return await fetchProfileFaceUrl(address)
        } catch {
          return null
        }
      },
      onEnableFlag: () => {
        this.tourOptionsPopup?.dispose()
        this.tourOptionsPopup = null
        this.openTourFlagImageModal()
      },
      onDisableFlag: async () => {
        await this.communityFollow?.setFlagImage(null)
        this.tourOptionsPopup?.refresh()
      },
      onToggleFocus: async (on) => {
        await this.communityFollow?.setFocusActive(on)
        this.tourOptionsPopup?.refresh()
      },
      onRequestEndTour: () => {
        this.tourOptionsPopup?.dispose()
        this.tourOptionsPopup = null
        this.openTourEndModal()
      },
      onAddLocation: async () => {
        const follow = this.communityFollow
        if (!follow?.isLeading()) return
        const target = routeToFollowTarget(this.currentRoute)
        if (!target) {
          clientDebugLog.log('social', 'Add location: no coords/world route', {
            level: 'warn',
            alsoConsole: true
          })
          return
        }
        const sceneName = this.resolveTourLocationSceneName(target)
        await follow.addLocation({ target, sceneName })
        this.tourOptionsPopup?.refresh()
      },
      onRemoveLocation: async (locationId) => {
        await this.communityFollow?.removeLocation(locationId)
        this.tourOptionsPopup?.refresh()
      },
      onRenameLocation: async (locationId, name) => {
        await this.communityFollow?.renameLocation(locationId, name)
        this.tourOptionsPopup?.refresh()
      },
      onAddPhoto: async (locationId) => {
        this.tourPhotoBindLocationId = locationId
        const session = this.communityFollow
          ?.listSessions()
          .find((s) => this.communityFollow?.isLeading(s.communityId))
        if (!session || !this.world) return
        // Hide tour modal so Camera Reel has a full view.
        this.tourOptionsPopup?.dispose()
        this.tourOptionsPopup = null
        this.world.beginTourLocationPhotoCapture({
          onCapture: async (result) => {
            try {
              await putTourLocationPhoto(session.sessionId, locationId, result.blob)
              const photo = await getTourLocationPhoto(session.sessionId, locationId)
              if (photo) photoThumbs.set(locationId, photo.dataUrl)
              clientDebugLog.log('social', 'Tour location photo saved', {
                level: 'success',
                alsoConsole: true
              })
            } catch (err) {
              console.warn('[tour] photo bind failed', err)
              throw err
            }
          },
          onExit: (_captured) => {
            this.tourPhotoBindLocationId = null
            // Re-open Tour Options after shot or Esc cancel (modal was hidden for full view).
            if (this.communityFollow?.isLeading()) {
              this.openTourOptionsPopup()
            }
          }
        })
      },
      onClose: () => {
        this.tourOptionsPopup?.dispose()
        this.tourOptionsPopup = null
      }
    })
    const unsub = this.communityFollow?.subscribe((ev) => {
      if (
        ev.kind === 'changed' ||
        ev.kind === 'flag_changed' ||
        ev.kind === 'focus_changed' ||
        ev.kind === 'tour_ended'
      ) {
        this.tourOptionsPopup?.refresh()
      }
    })
    if (unsub && this.tourOptionsPopup) {
      const originalDispose = this.tourOptionsPopup.dispose.bind(this.tourOptionsPopup)
      this.tourOptionsPopup.dispose = () => {
        unsub()
        originalDispose()
      }
    }
  }

  private openTourEndModal(): void {
    if (this.tourEndModal) {
      this.tourEndModal.dispose()
      this.tourEndModal = null
    }
    const follow = this.communityFollow
    if (!follow?.isLeading()) return
    const session = follow.listSessions().find((s) => follow.isLeading(s.communityId))
    if (!session) return
    const communityName =
      this.world?.social.getCommunities().find((c) => c.id.toLowerCase() === session.communityId)
        ?.name ?? 'Tour'
    const startedAt = session.startedAt
    const locationsSnapshot = follow.finalizeTourDwell()
    let photoCount = 0
    void listTourLocationPhotos(session.sessionId).then((photos) => {
      photoCount = photos.length
    })

    this.tourEndModal = new TourEndModal({
      getStats: () => ({
        communityName,
        locationCount: locationsSnapshot.length,
        photoCount,
        rosterCount: follow.getTourRoster().length,
        durationSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      }),
      onDownloadCsv: async () => {
        await downloadTourCsvOnly(locationsSnapshot, {
          communityName,
          sessionId: session.sessionId,
          startedAt,
          endedAt: Date.now()
        })
      },
      onDownloadZip: async () => {
        await downloadTourZip(locationsSnapshot, {
          communityName,
          sessionId: session.sessionId,
          startedAt,
          endedAt: Date.now()
        })
      },
      onEndWithoutDownload: async () => {
        if (follow.isFocusBroadcasting()) {
          await follow.setFocusActive(false)
        }
        await follow.stopLead()
        try {
          await deleteTourSessionPhotos(session.sessionId)
        } catch {
          /* ignore */
        }
        this.tourPhotoBindLocationId = null
        this.tourEndModal?.dispose()
        this.tourEndModal = null
      },
      onCancel: () => {
        this.tourEndModal?.dispose()
        this.tourEndModal = null
        this.openTourOptionsPopup()
      }
    })
  }

  private openTourFlagImageModal(): void {
    if (!this.communityFollow?.isLeading()) {
      clientDebugLog.log(
        'social',
        'Enable flag requires an active tour — start one from Community → START TOUR',
        { level: 'warn', alsoConsole: true }
      )
      return
    }
    this.tourFlagImageModal?.dispose()
    this.tourFlagImageModal = new TourFlagImageModal({
      onPicked: async (dataUrl) => {
        const ok = await this.communityFollow?.setFlagImage(dataUrl)
        this.tourFlagImageModal?.dispose()
        this.tourFlagImageModal = null
        if (!ok) {
          clientDebugLog.log('social', 'Could not set tour flag', { level: 'warn' })
        }
      },
      onCancel: () => {
        this.tourFlagImageModal?.dispose()
        this.tourFlagImageModal = null
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
    if (this.appMode === 'play') stopDwellTracking('shell')
    if (this.appMode === 'landing') stopLandingDwell('shell')
    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'blank' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'blank' }
    this.appMode = 'explorer'
    this.syncCommunityVoiceBarVisibility()
    this.clearSceneBanWatch()
    this.disposeCommunityFollow()

    await this.teardownScene({ clearVrmCache: true })
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownLivePage()
    this.teardownLootBagPage()
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
    if (this.appMode === 'play') stopDwellTracking('shell')

    if (this.appMode === 'play') {
      this.disposeCommunityFollow()
      await this.teardownScene({ clearVrmCache: true })
    }

    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'map' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'map' }
    this.appMode = 'map'
    this.syncCommunityVoiceBarVisibility()
    this.clearSceneBanWatch()

    this.teardownExplorer()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownLivePage()
    this.teardownLootBagPage()
    this.teardownCommunitiesPage()
    this.teardownProfilePage()

    if (!this.container || !this.login) return

    const hudEl = document.getElementById('hud')
    if (hudEl) hudEl.hidden = true

    this.mapPageView = new MapPageView({
      login: this.login,
      onNavigate: (tab) => this.navigateSocialShell(tab),
      onParcelVisit: (px, py) => {
        // Direct jump with full LoadingScreen (not landing-only CTA progress).
        void this.jumpInToScene(
          { kind: 'coords', x: px, y: py, segment: `${px},${py}` },
          { entry: 'map', source: 'map' }
        )
      },
      onWorldVisit: (worldName) => {
        const name = worldName.trim()
        if (!name) return
        void this.jumpInToScene(
          { kind: 'world', worldName: name, segment: name },
          { entry: 'map', source: 'map' }
        )
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
      stopDwellTracking('shell')
      this.disposeCommunityFollow()
      await this.teardownScene({ clearVrmCache: true })
    }

    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'events' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'events' }
    this.appMode = 'events'
    this.syncCommunityVoiceBarVisibility()
    this.clearSceneBanWatch()

    this.teardownExplorer()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownLivePage()
    this.teardownLootBagPage()
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

  private async showLivePage(
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (this.appMode === 'play') {
      stopDwellTracking('shell')
      this.disposeCommunityFollow()
      await this.teardownScene({ clearVrmCache: true })
    }

    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'live' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'live' }
    this.appMode = 'live'
    this.syncCommunityVoiceBarVisibility()
    this.clearSceneBanWatch()

    this.teardownExplorer()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownLivePage()
    this.teardownLootBagPage()
    this.teardownCommunitiesPage()
    this.teardownProfilePage()

    if (!this.container || !this.login) return

    const hudEl = document.getElementById('hud')
    if (hudEl) hudEl.hidden = true

    await this.ensureSocialForLiveShell()
    this.livePageView = new LivePageView({
      login: this.login,
      onNavigate: (tab) => this.navigateSocialShell(tab),
      getDirectory: () => this.socialChat?.getSocial()?.getLiveDirectory() ?? null,
      getLogin: () => this.login,
      onWatch: (session) => this.openLivePip(session),
      onCastPreview: (host, worldName, onUpdate) =>
        this.startLiveDirectoryCastWatch(worldName, host, onUpdate, { muted: true }),
      ...this.socialShellLoginHandlers()
    })
    this.livePageView.mount(this.container)
    this.ensureSocialChatShell()
    this.collapseSocialChatThread()
  }

  private async showLootBagPage(
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (this.appMode === 'play') {
      stopDwellTracking('shell')
      this.disposeCommunityFollow()
      await this.teardownScene({ clearVrmCache: true })
    }

    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'lootbag' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'lootbag' }
    this.appMode = 'lootbag'
    this.syncCommunityVoiceBarVisibility()
    this.clearSceneBanWatch()

    this.teardownExplorer()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownLivePage()
    this.teardownLootBagPage()
    this.teardownCommunitiesPage()
    this.teardownProfilePage()

    if (!this.container || !this.login) return

    const hudEl = document.getElementById('hud')
    if (hudEl) hudEl.hidden = true

    this.lootBagPageView = new LootBagPageView({
      login: this.login,
      onNavigate: (tab) => this.navigateSocialShell(tab),
      ...this.socialShellLoginHandlers()
    })
    this.lootBagPageView.mount(this.container)
    this.ensureSocialChatShell()
    this.collapseSocialChatThread()
  }

  private async showCommunitiesPage(
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (this.appMode === 'play') {
      stopDwellTracking('shell')
      this.disposeCommunityFollow()
      await this.teardownScene({ clearVrmCache: true })
    }

    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'communities' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'communities' }
    this.appMode = 'communities'
    this.syncCommunityVoiceBarVisibility()
    this.clearSceneBanWatch()

    this.teardownExplorer()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownLivePage()
    this.teardownLootBagPage()
    this.teardownCommunitiesPage()
    this.teardownProfilePage()

    if (!this.container || !this.login) return

    const hudEl = document.getElementById('hud')
    if (hudEl) hudEl.hidden = true

    this.communitiesPageView = new CommunitiesPageView({
      login: this.login,
      onNavigate: (tab) => this.navigateSocialShell(tab),
      onOpenChat: (community) => this.openCommunityChatChannel(community.id, community.name),
      onJoinedCommunity: (community) => {
        this.socialChat?.getSocial()?.noteJoinedCommunity(community)
        this.world?.social.noteJoinedCommunity(community)
        void this.socialChat?.getSocial()?.refreshMemberCommunities()
        void this.world?.social.refreshMemberCommunities()
      },
      ...this.socialShellLoginHandlers()
    })
    this.communitiesPageView.mount(this.container)
    this.ensureSocialChatShell()
    this.collapseSocialChatThread()
    this.ensureCommunityVoiceBar()
  }

  private async showProfilePage(
    opts: { fromHistory?: boolean; replace?: boolean } = {}
  ): Promise<void> {
    if (this.appMode === 'play') {
      stopDwellTracking('shell')
      this.disposeCommunityFollow()
      await this.teardownScene({ clearVrmCache: true })
    }

    if (!opts.fromHistory) {
      applyRouteToHistory({ kind: 'profile' }, opts.replace ?? false)
    }
    this.currentRoute = { kind: 'profile' }
    this.appMode = 'profile'
    this.syncCommunityVoiceBarVisibility()
    this.clearSceneBanWatch()

    this.teardownExplorer()
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownLivePage()
    this.teardownLootBagPage()
    this.teardownCommunitiesPage()
    this.teardownProfilePage()

    if (!this.container || !this.login) return

    const hudEl = document.getElementById('hud')
    if (hudEl) hudEl.hidden = true

    this.profilePageView = new ProfilePageView({
      login: this.login,
      catalystUrl: this.sceneContentUrl,
      onNavigate: (tab) => this.navigateSocialShell(tab),
      onOpenCommunityChat: (community) => {
        this.openCommunityChatChannel(community.id, community.name)
      },
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

  private teardownLivePage(): void {
    this.livePageView?.dispose()
    this.livePageView = null
  }

  private teardownLootBagPage(): void {
    this.lootBagPageView?.dispose()
    this.lootBagPageView = null
  }

  /** Warm PM + Live directory for 2D Live tab (same rails as chat shell). */
  private async ensureSocialForLiveShell(): Promise<void> {
    this.ensureSocialChatShell()
    const social = this.socialChat?.getSocial()
    if (!social) return
    // Await PM + directory so LiveDirectoryView.subscribe is attached before GO LIVE.
    const dir = await social.ensureLiveReady()
    this.wireLiveSessionEnded(dir)
  }

  private openLivePip(session: LiveSession): void {
    if (!this.livePip) {
      this.livePip = new LivePip({
        onClose: () => {
          /* user closed */
        },
        onCastAttach: async (host, worldName, onUpdate, opts) => {
          return this.startLiveDirectoryCastWatch(worldName, host, onUpdate, {
            muted: opts.muted
          })
        }
      })
    }
    this.livePip.open(session)
    this.wireLiveSessionEnded(
      this.socialChat?.getSocial()?.getLiveDirectory() ??
        this.world?.social.getLiveDirectory() ??
        null
    )
  }

  /**
   * Live directory / PiP cast watch — always join the target world's scene LiveKit.
   * Do not reuse social-chat room (often Genesis / wrong place with no OBS ingress).
   */
  private async startLiveDirectoryCastWatch(
    worldName: string,
    host: HTMLElement,
    onUpdate?: (attached: boolean) => void,
    opts?: { muted?: boolean; volume?: number }
  ): Promise<() => void> {
    const target = {
      kind: 'world' as const,
      worldName,
      segment: worldName
    }
    return this.startLandingCastWatch(target, host, onUpdate, opts, {
      preferExistingSceneRoom: false
    })
  }

  private wireLiveSessionEnded(
    dir: import('../social/LiveDirectoryController').LiveDirectoryController | null
  ): void {
    this.unsubLiveSessionEnded?.()
    this.unsubLiveSessionEnded = null
    if (!dir) return
    this.unsubLiveSessionEnded = dir.onSessionEnded((sessionId) => {
      this.livePip?.endIfSession(sessionId)
    })
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
    // End 2D landing dwell (no-op if already stopped e.g. jump_in).
    stopLandingDwell('navigate')
    this.castLiveUnsub?.()
    this.castLiveUnsub = null
    if (this.castProbeTimer) {
      window.clearInterval(this.castProbeTimer)
      this.castProbeTimer = 0
    }
    this.castWatchRoom?.disconnect()
    this.castWatchRoom = null
    // Leave 2D live tools when leaving landing (play will re-bind on Jump In).
    if (this.appMode !== 'play') this.disposeLiveTools()
    this.sceneLandingView?.dispose()
    this.sceneLandingView = null
  }

  private openSceneLanding(target: RouteTarget): void {
    if (target.kind !== 'coords' && target.kind !== 'world') return
    void this.showSceneLanding(target)
  }

  private async showSceneLanding(
    target: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>,
    opts: {
      fromHistory?: boolean
      replace?: boolean
      sceneBan?: SceneLoadErrorMessage
      source?: AnalyticsSource
    } = {}
  ): Promise<void> {
    if (this.appMode === 'play') {
      stopDwellTracking('landing')
      this.disposeCommunityFollow()
      // clearVrmCache also releases PM play-session hold (see teardownScene).
      await this.teardownScene({ clearVrmCache: true })
    }

    if (!opts.fromHistory) {
      applyRouteToHistory(target, opts.replace ?? false)
    }
    this.currentRoute = target
    this.appMode = 'landing'
    this.syncCommunityVoiceBarVisibility()

    // Soft-refresh within 30s for same place: track() returns false — no extra landing_view.
    track('landing_view', {
      route: target,
      source: opts.fromHistory ? 'history' : opts.source ?? 'direct',
      props: {
        from_history: !!opts.fromHistory,
        had_ban: !!opts.sceneBan
      }
    })

    this.teardownExplorer()
    // Ends prior landing engaged-session (if any) before remount.
    this.teardownLanding()
    this.teardownMapPage()
    this.teardownEventsPage()
    this.teardownLivePage()
    this.teardownLootBagPage()
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
      onLiveToolsMenu: (anchor) => {
        if (!this.liveToolsUi) {
          // LiveKit may still be connecting — start session now and open menu.
          void this.setupLandingLiveTools(target).then(() => this.liveToolsUi?.openMenuAt(anchor))
          return
        }
        this.liveToolsUi.openMenuAt(anchor)
      },
      ...this.socialShellLoginHandlers()
    })
    this.sceneLandingView.mount(this.container)
    this.ensureSocialChatShell()
    // Chat shell may re-apply wallet identity — re-sync owner gear with live session.
    this.sceneLandingView.syncLoginFromHost()
    startLandingDwell(target)
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
      // Continuous presence: room may connect late, and OBS may go live after landing opens.
      this.castLiveUnsub = this.socialChat.watchRemoteVideoLive((live) => {
        this.sceneLandingView?.setCastLive(live)
      })
      this.sceneLandingView?.setCastLive(this.socialChat.hasRemoteVideoLive())
      // Live tools share the landing scene LiveKit room (same topic as 3D).
      void this.setupLandingLiveTools(target)
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
    } else if (chatBlockedByScene || guestSession || jumpInReady) {
      this.sceneLandingView?.setCastRoomReady(true)
      // Guests can still open UI; publish no-ops until LiveKit is up.
      void this.setupLandingLiveTools(target)
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
    opts?: { muted?: boolean; volume?: number },
    castOpts?: { preferExistingSceneRoom?: boolean }
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

    // Landing Join Live may reuse chat room. Live directory PiP must NOT — chat is often
    // a different place (Genesis) with no OBS ingress for the stream world.
    const preferExisting = castOpts?.preferExistingSceneRoom !== false
    if (preferExisting && this.socialChat?.isLiveKitConnected()) {
      const unbindExisting = this.socialChat.bindRemoteCastVideoToHost(host, onUpdate, opts)
      // Give existing room a moment; if video attaches, keep it.
      await new Promise((r) => setTimeout(r, 600))
      if (host.querySelector('video')) {
        return unbindExisting
      }
      unbindExisting()
    }

    const adapterResult = await getSceneAdapter(identity, {
      sceneId,
      parcel,
      realmName,
      isWorld
    })
    if (!adapterResult.ok) {
      clientDebugLog.log(
        'social',
        `Live cast watch adapter failed world=${realmName} ${adapterResult.error} (${adapterResult.status})`,
        { level: 'warn', alsoConsole: true }
      )
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
    clientDebugLog.log(
      'social',
      `Live cast watch connected realm=${realmName} — waiting for OBS/-streamer video`,
      { alsoConsole: true }
    )

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
    // Never revive 2D dock while in 3D play (follow jumps / notification seed used to do this).
    if (this.appMode === 'play') {
      this.socialChatDock?.hide()
      document.body.classList.remove('social-shell-with-chat')
      return
    }
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
      // Prefer in-world social while playing so shell is not required for toasts.
      getSocial: () => this.world?.social ?? this.socialChat?.getSocial() ?? null,
      getAuthIdentity: () =>
        this.login?.kind === 'wallet' || this.login?.kind === 'guest' ? this.login.identity : null,
      getUserAddress: () =>
        this.login?.kind === 'wallet' || this.login?.kind === 'guest' ? this.login.address : null,
      onEnsureSocial: async () => {
        if (this.appMode === 'play') {
          // World social is owned by World.spawnLocalPlayer — do not spin up 2D shell.
          return
        }
        this.ensureSocialChatShell()
        this.socialChat?.applyLogin(this.login)
        await this.socialChat?.ensureShellInit()
      },
      onOpenChat: () => {
        if (this.appMode === 'play') {
          this.shell?.openChatPanel()
          return
        }
        this.ensureSocialChatShell()
        this.socialChatDock?.openFromNotification()
      },
      onOpenUserProfile: (address) => {
        if (this.appMode === 'play') {
          this.profileUi?.openProfileForAddress(address)
          return
        }
        this.socialChat?.openProfileForAddress(address)
      },
      onOpenCommunity: (communityId, kind) => {
        if (this.appMode === 'play' && kind === 'announcement') {
          // Tour / community toast in 3D → in-world community chat, not Settings.
          const name =
            this.world?.social
              .getCommunities()
              .find((c) => c.id.toLowerCase() === communityId.toLowerCase())?.name ?? 'Community'
          this.openCommunityChatChannel(communityId, name)
          return
        }
        void this.openCommunityFromNotification(communityId, kind)
      },
      isChatNotificationSuppressed: (channelKey) => {
        // 3D play: never show center mobile-style chat banners (overhead + Chat panel only).
        // Hard /goto from a chat link was leaving Explore-style toasts over the world.
        if (this.appMode === 'play') {
          return true
        }
        return this.socialChatDock?.isChatNotificationSuppressed(channelKey) ?? false
      }
    })
    this.socialMobileNotifications.mount()
    this.ensureCommunityVoiceBar()
  }

  /**
   * Floating community voice controls for the 2D shell.
   * LiveKit session is a module singleton — survives tab/landing remounts;
   * this bar is the control surface when community details is closed.
   */
  private ensureCommunityVoiceBar(): void {
    if (this.communityVoiceBar) {
      this.communityVoiceBar.refreshVisibility()
      return
    }
    this.communityVoiceBar = new CommunityVoiceFloatingBar({
      // 2D shell only. In-play uses ChatPanel community-voice strip (Explorer-style).
      // Session is NOT left on Jump In — only the pill is hidden.
      shouldShow: () =>
        this.appMode !== 'play' && !document.body.classList.contains('client-loading')
    })
  }

  private disposeCommunityVoiceBar(): void {
    this.communityVoiceBar?.dispose()
    this.communityVoiceBar = null
  }

  /** Leave community voice LiveKit (sign-out / full teardown). */
  private leaveCommunityVoiceSession(): void {
    void getCommunityVoiceSession().leave()
  }

  private syncCommunityVoiceBarVisibility(): void {
    this.communityVoiceBar?.refreshVisibility()
  }

  /** HUD community toast click → Settings → Communities → modal (+ join voice when live). */
  private async openCommunityFromNotification(
    communityId: string,
    kind: 'announcement' | 'voice' = 'announcement'
  ): Promise<void> {
    const id = communityId.trim()
    if (!id) return
    try {
      const overlay = await this.ensureSettingsOverlay()
      const fromShell = this.socialChat?.getSocial()?.getCommunities() ?? []
      const fromWorld = this.world?.social?.getCommunities() ?? []
      const name =
        [...fromShell, ...fromWorld].find((c) => c.id.toLowerCase() === id.toLowerCase())?.name ??
        'Community'
      overlay.openCommunity(id, name, { autoJoinVoice: kind === 'voice' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('client', `Community toast open failed: ${msg}`, { level: 'warn' })
    }
  }

  /** Off a scene landing → stop treating the dock as "reading" so scene chat can toast. */
  private collapseSocialChatThread(): void {
    this.socialChatDock?.collapseToChannelList()
  }

  /**
   * Tear down 2D social chat chrome.
   * Peer toasts (pool claims, tours, friend requests) use SocialMobileNotifications in
   * both 2D and 3D — never dispose those here or Jump In drops listeners (listeners=0).
   */
  private teardownSocialChatShell(disposeComms = false): void {
    this.socialChatDock?.hide()
    document.body.classList.remove('social-shell-with-chat')
    if (disposeComms) {
      this.socialChat?.dispose()
      this.socialChat = null
      this.socialChatDock?.dispose()
      this.socialChatDock = null
    }
  }

  private disposeSocialMobileNotifications(): void {
    this.socialMobileNotifications?.dispose()
    this.socialMobileNotifications = null
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
    opts: {
      fromHistory?: boolean
      replace?: boolean
      fastAssets?: boolean
      /**
       * Multi-scene stand-on-parcel promote: keep HUD, restore Genesis feet after spawn.
       * Pair with `showSeamlessLoading` for large cold promotes (avoid blank 2fps thrash).
       */
      seamless?: boolean
      /** When seamless, still show a fast loading screen (CBD plaza cold promote). */
      showSeamlessLoading?: boolean
      entry?: 'landing_cta' | 'event_card' | 'deep_link' | 'map' | 'other' | 'teleport'
      source?: AnalyticsSource
    } = {}
  ): Promise<void> {
    if (target.kind !== 'coords' && target.kind !== 'world' && target.kind !== 'editor') return

    // Leader tour hard pulse — intentional Jump In / /goto while leading only.
    // Soft parcel walk uses noteLeaderLocation (label only; no follower reloads).
    if (
      this.appMode === 'play' &&
      (target.kind === 'coords' || target.kind === 'world') &&
      this.communityFollow?.isLeading()
    ) {
      this.communityFollow.noteLeaderGoto(target)
    }

    // Editor / already-in-play teleports skip re-auth; first entry from 2D needs session.
    if (target.kind !== 'editor' && this.appMode !== 'play') {
      const neededAuth = !this.playSessionReady
      if (neededAuth) {
        track('auth_gate_show', { route: target, props: { reason: 'need_session' } })
      }
      const ok = await this.ensurePlaySession()
      if (!ok) return
      if (neededAuth && this.playSessionReady) {
        track('auth_gate_complete', {
          route: target,
          props: { login_kind: this.login?.kind === 'wallet' ? 'wallet' : 'guest' }
        })
      }
    }

    // Hold PM LiveKit for the whole play session (before World teardown on teleport).
    // Without this, World.social.dispose() drops holders→0 and force-disconnects DMs.
    if (target.kind === 'coords' || target.kind === 'world') {
      this.retainPmPlaySession()
    }

    const devQueryKey = readSceneDevQueryKey()
    // Soft URL updates track feet parcel without loading — do NOT treat that as
    // "already on this primary". Seamless promote must always run the load.
    if (
      !opts.seamless &&
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

    const fromPlay = this.appMode === 'play'
    const seamless = !!(opts.seamless && fromPlay && target.kind === 'coords')

    // Preserve Genesis feet across primary swap (seamless multi-scene promote).
    let savedGenesis: { x: number; y: number; z: number } | null = null
    if (seamless && this.world) {
      const pos = this.world.getPlayerPosition()
      const origin = this.world.comms.getSceneOrigin()
      if (pos) {
        savedGenesis = {
          x: pos.x + origin.x,
          y: pos.y,
          z: pos.z + origin.z
        }
      }
    }

    if (fromPlay && !seamless) {
      stopDwellTracking('navigate')
    }
    // End 2D landing time when Jump In / teleport starts (before load).
    if (fromSceneLanding || this.appMode === 'landing') {
      stopLandingDwell('jump_in')
    }

    const entry =
      opts.entry ??
      (fromSceneLanding ? 'landing_cta' : fromPlay ? 'teleport' : 'other')
    const playId = beginPlaySession()
    const loadStarted = Date.now()

    track('jump_in_click', {
      route: target,
      source: opts.source,
      play_session_id: playId,
      props: { entry, seamless }
    })
    track('scene_load_start', {
      route: target,
      play_session_id: playId,
      props: {
        fast_assets: !!(opts.fastAssets ?? fromPlay),
        from_mode: this.appMode,
        seamless
      }
    })

    // Entering play from 2D: fully dispose shell chat. In-play teleports (follow / /goto):
    // only hide shell chrome — never remount 2D dock mid-jump.
    if (!fromSceneLanding && !seamless) {
      if (fromPlay) {
        this.teardownSocialChatShell(false)
        document.body.classList.remove('social-shell-with-chat')
      } else {
        this.teardownSocialChatShell(true)
      }
    }

    this.navigating = true
    let loading: LoadingScreen | null = null
    // Seamless promote: keep feet; optional loading chrome for cold large-scene jumps.
    // Everything else (landing Jump In, map Jump In, teleports) shows a loading affordance.
    if (seamless && opts.showSeamlessLoading) {
      console.info('[promote] seamless primary swap — with loading screen')
      loading = new LoadingScreen('Entering scene…', { fast: true })
      loading.mount()
      loading.startLoadingTimer()
    } else if (seamless) {
      console.info('[promote] seamless primary swap — no loading screen')
    } else if (fromSceneLanding) {
      this.hidePlayChrome()
      this.sceneLandingView!.preserveDuringWorldLoad()
      this.sceneLandingView!.beginJumpInLoading()
    } else {
      loading = new LoadingScreen(
        this.appMode === 'play' ? 'Teleporting…' : 'Preparing your experience…',
        { fast: this.appMode === 'play' || opts.entry === 'map' }
      )
      loading.mount()
      loading.startLoadingTimer()
    }

    try {
      if (!fromSceneLanding && !seamless) {
        this.teardownLanding()
      }
      if (!seamless) {
        this.teardownExplorer()
        this.teardownMapPage()
      }
      const hydrationTimedOut = await this.loadRoute(target, {
        ...opts,
        replace: opts.replace ?? seamless,
        fastAssets: opts.fastAssets ?? this.appMode === 'play',
        handoffShellComms: fromSceneLanding,
        deferPlayChromeReveal: fromSceneLanding,
        seamless,
        restoreGenesisFeet: savedGenesis,
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
      // Community voice LiveKit room is independent of World — keep session, hide 2D pill.
      // In-play controls live on ChatPanel voice strip (wired when shell chat mounts).
      this.ensureCommunityVoiceBar()
      this.syncCommunityVoiceBarVisibility()
      if (getCommunityVoiceSession().isActive()) {
        clientDebugLog.log(
          'social',
          `Community voice kept across Jump In · ${getCommunityVoiceSession().getCommunityId()?.slice(0, 12) ?? '?'}… · use chat panel voice strip`,
          { level: 'info', alsoConsole: true }
        )
      }
      track('scene_enter', {
        route: target,
        play_session_id: playId,
        props: { load_ms: Date.now() - loadStarted, seamless }
      })
      startDwellTracking(target)
      if (fromSceneLanding) {
        await this.sceneLandingView?.completeJumpInLoading()
        this.teardownLanding()
        // Dispose 2D chat dock only — keep SocialMobileNotifications for peer toasts.
        this.teardownSocialChatShell(true)
        this.revealPlayChrome()
      } else if (loading) {
        await loading.finish(Promise.resolve(), { skipHold: !hydrationTimedOut })
        // In-play / follow teleports: loading.finish does not call revealPlayChrome.
        this.revealPlayChrome()
      } else {
        // Seamless promote — chrome already visible.
        this.revealPlayChrome()
      }
      // Re-bind toast host after any shell teardown so pool-claim / tour listeners stay live.
      this.ensureSocialMobileNotifications()
      if (this.login) this.socialMobileNotifications?.setLogin(this.login)
      this.ensureInWorldChromeOnly()
    } catch (err) {
      if (err instanceof SceneAccessDeniedError) {
        const ui = formatSceneBanMessage(err)
        track('scene_ban', {
          route: target,
          play_session_id: playId,
          props: { source: err.source }
        })
        track('scene_load_fail', {
          route: target,
          play_session_id: playId,
          props: { error_code: 'scene_ban', message: ui.title }
        })
        stopDwellTracking('error')
        if (fromSceneLanding) {
          this.sceneLandingView?.showSceneBan(ui)
        } else if (loading) {
          loading.showFatalError(ui.title, ui.detail)
        } else {
          clientDebugLog.log('client', `Seamless promote denied: ${ui.title}`, {
            level: 'warn',
            alsoConsole: true
          })
        }
        clientDebugLog.log('client', `Scene access denied: ${err.source}`, { level: 'warn' })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        const ui = formatSceneLoadError(msg)
        track('scene_load_fail', {
          route: target,
          play_session_id: playId,
          props: { error_code: 'load_error', message: ui.title.slice(0, 120) }
        })
        stopDwellTracking('error')
        if (fromSceneLanding) {
          this.sceneLandingView?.showJumpInError(ui.title, ui.detail)
        } else if (loading) {
          loading.showFatalError(ui.title, ui.detail)
        } else {
          clientDebugLog.log('client', `Seamless promote failed: ${msg}`, {
            level: 'error',
            alsoConsole: true
          })
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
    this.disposeCommunityFollow()
    // Leaving 3D entirely — free multi‑MB peer VRM RAM (kept across in-play teleports).
    clearVrmRamCache()
    // Drop play-session PM hold after World teardown (inside showSceneLanding).
    await this.showSceneLanding(this.currentRoute, { replace: true })
  }

  /**
   * Keep private-messages LiveKit across World rebuilds (teleport / /goto).
   * Released only when leaving 3D play entirely.
   */
  private retainPmPlaySession(): void {
    if (this.pmPlaySessionHeld) return
    getPrivateMessagesService().retainPlaySession()
    this.pmPlaySessionHeld = true
    clientDebugLog.log(
      'social',
      `PM play-session retain · holders=${getPrivateMessagesService().getHolderCount()}`,
      { level: 'info', alsoConsole: true }
    )
  }

  private releasePmPlaySession(): void {
    if (!this.pmPlaySessionHeld) return
    getPrivateMessagesService().releasePlaySession()
    this.pmPlaySessionHeld = false
    clientDebugLog.log(
      'social',
      `PM play-session release · holders=${getPrivateMessagesService().getHolderCount()}`,
      { level: 'info', alsoConsole: true }
    )
  }

  private async loadRoute(
    route: RouteTarget,
    opts: {
      fromHistory?: boolean
      replace?: boolean
      fastAssets?: boolean
      handoffShellComms?: boolean
      deferPlayChromeReveal?: boolean
      /** Multi-scene promote — skip long post-spawn settle, restore feet. */
      seamless?: boolean
      restoreGenesisFeet?: { x: number; y: number; z: number } | null
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
    // clearVrmCache: false — keep peer VRM RAM + PM play-session hold across rebuild.
    await this.teardownScene({ keepLiveKit: opts.handoffShellComms === true, clearVrmCache: false })

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
    world.setNavigateHandler((target) => {
      const from = this.currentRoute
      // RestrictedActions teleport / goto (full loading UX when not seamless).
      if (from && (target.kind === 'coords' || target.kind === 'world')) {
        this.trackNavigate(from, target, 'goto', 'goto')
      }
      void this.jumpInToScene(target, {
        fastAssets: true,
        entry: 'teleport',
        source: 'goto'
      })
    })
    // Stand-on-parcel multi-scene promote — prefer live secondary handoff (no World rebuild).
    world.setPromoteHandlers({
      onPromote: (target, reason) => {
        const from = this.currentRoute
        if (from) this.trackNavigate(from, target, 'navigate', 'goto')
        this.softUpdatePlayRoute(target)
        void this.refreshLocationTitleForParcel(target.x, target.y)
        void this.promotePrimary(target, reason)
      },
      // Feet parcel only — replaceState, never reload (fixes empty-land thrash + URL lag).
      onSoftRoute: (x, y) => {
        this.softUpdatePlayRoute({ kind: 'coords', x, y, segment: `${x},${y}` })
        void this.refreshLocationTitleForParcel(x, y)
        // Pin under-feet for promote preference only.
        // NEVER force-boot a secondary worker on every parcel step — that was the
        // 1-step thrash (resolveScene + full SceneWorkerSlot.start mid-walk).
        // Dwell promote / live-candidate reconcile boots serially when needed.
        this.multiSceneRuntime.setSecondaryPriorityParcel(x, y)
      },
      onPrefetch: (x, y) => {
        this.enqueueScriptWarm(x, y)
      }
    })
    // Community-style toast when plaza has many remotes still composing.
    this.ensureSocialMobileNotifications()
    world.setRemoteAvatarProgressHandler((p) => {
      const notif = this.socialMobileNotifications
      if (!notif) return
      const TOAST_ID = 'remote-avatar-load'
      // Force 3D HUD placement (top-center) — not 2D shell top-right.
      notif.host.classList.add('social-mobile-notif-host--in-world-center')
      if (p.total > 5 && p.pending > 0) {
        notif.pushSystemToast({
          id: TOAST_ID,
          appName: 'DECENTRALAND · AVATARS',
          title: `Loading remote avatars ${p.loaded}/${p.total}`,
          sub: 'Please wait…',
          dismissMs: 0
        })
      } else {
        notif.dismissSystemToast(TOAST_ID)
      }
    })

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
        onRecookColliders: () => this.world?.recookPhysicsColliders({ force: true }),
        onCrowdDelta: (delta) => {
          this.world?.getOrCreateDebugAvatarCrowd().add(delta)
          this.debugPanel?.refreshCrowdStatus()
        },
        onCrowdClear: () => {
          this.world?.getDebugAvatarCrowd()?.clear()
          this.debugPanel?.refreshCrowdStatus()
        },
        getCrowdCount: () => {
          const c = this.world?.getDebugAvatarCrowd()
          if (!c) return { count: 0, target: 0, busy: false }
          return { count: c.count, target: c.target, busy: c.isBusy }
        }
      })
    } else {
      this.debugPanel.replaceRenderStats(world.host.renderStats)
      this.debugPanel.setRecookCollidersHandler(() => this.world?.recookPhysicsColliders({ force: true }))
      this.debugPanel.setCrowdHandlers({
        onCrowdDelta: (delta) => {
          this.world?.getOrCreateDebugAvatarCrowd().add(delta)
          this.debugPanel?.refreshCrowdStatus()
        },
        onCrowdClear: () => {
          this.world?.getDebugAvatarCrowd()?.clear()
          this.debugPanel?.refreshCrowdStatus()
        },
        getCrowdCount: () => {
          const c = this.world?.getDebugAvatarCrowd()
          if (!c) return { count: 0, target: 0, busy: false }
          return { count: c.count, target: c.target, busy: c.isBusy }
        }
      })
    }

    this.ensureDevProgressPanel()

    // Warm Pet Barn catalog early so Pets → Barn is ready (and picks up new deploys).
    void import('../pets/petBarn').then((m) => m.preloadPetBarnCatalog()).catch(() => {})

    if (!this.shell) {
      this.shell = new ClientShell({
        environment: world.environment,
        session: world.session,
        debugPanel: this.debugPanel,
        devProgressPanel: this.devProgressPanel,
        // `undefined` keeps the Catalyst loop flag; `false` would force every emote one-shot.
        onEmoteSelected: (emoteId) => world.playLocalEmote(emoteId, { loop: undefined }),
        onTogglePhotoCamera: () => world.togglePhotoCamera(),
        onTourOptions: () => this.openTourOptionsPopup(),
        onActivePetChange: () => world.onActivePetInventoryChange(),
        onPlayPetClipPreview: (hash, clip) => world.playPetClipPreview(hash, clip),
        onStopPetClipPreview: () => world.stopPetClipPreview(),
        onWatchLive: (session) => this.openLivePip(session),
        onLiveCastPreview: (host, worldName, onUpdate) =>
          this.startLiveDirectoryCastWatch(worldName, host, onUpdate, { muted: true }),
        getLogin: () => this.login,
        onSignOut: () => this.signOut(),
        onExit: () => this.leavePlayMode()
      })
      this.wireLiveSessionEnded(world.social.getLiveDirectory())
    } else {
      this.shell.updateWorldBindings(world.session, world.environment)
      this.wireLiveSessionEnded(world.social.getLiveDirectory())
      this.shell.setEmoteHandler((emoteId) => world.playLocalEmote(emoteId, { loop: undefined }))
      this.shell.setPhotoCameraHandler(() => world.togglePhotoCamera())
      this.shell.setTourOptionsHandler(() => this.openTourOptionsPopup())
      this.shell.setActivePetChangeHandler(() => world.onActivePetInventoryChange())
      this.shell.setPetClipPreviewHandlers(
        (hash, clip) => world.playPetClipPreview(hash, clip),
        () => world.stopPetClipPreview()
      )
    }
    if (opts.deferPlayChromeReveal) {
      this.hidePlayChrome()
    }

    world.setPhotoChromeHandler((visible) => {
      if (visible) {
        // Leaving photo mode — restore play chrome (respect prior U-hide by re-revealing fully).
        if (document.body.classList.contains('client-in-world')) {
          this.revealPlayChrome()
          this.clientHudVisible = true
          document.body.classList.remove('client-hud-hidden')
        }
      } else {
        // Entering photo mode — hide all client + scene UI (camera HUD is separate).
        this.shell?.hide()
        this.chatPanel?.hide()
        this.worldLocationCard?.setVisible(false)
        this.minimap?.setVisible(false)
        if (this.locationMapStack) this.locationMapStack.hidden = true
        this.mobileHud?.setShellVisible(false)
        this.settingsOverlay?.hide()
        this.preferencesPanel?.hide()
        this.world?.setSceneUiVisible(false)
      }
    })

    if (!this.settingsOverlay) {
      this.settingsOverlay = this.createSettingsOverlay(world.session, sceneConfig)
    } else {
      this.settingsOverlay.updateSession(world.session)
      this.settingsOverlay.updateEventContext(
        sceneConfig.source.kind === 'world',
        sceneConfig.source.kind === 'world' ? sceneConfig.source.worldName : null
      )
      this.settingsOverlay.updateMapPlayerState(() => this.getMapPlayerState())
      // Keep Jump In as in-world teleport (/goto path). Do NOT navigateTo → 2D landing.
      this.settingsOverlay.updateMapJumpIn((px, py) => {
        this.settingsOverlay?.hide()
        void this.jumpInToScene(
          { kind: 'coords', x: px, y: py, segment: `${px},${py}` },
          {
            entry: this.appMode === 'play' ? 'teleport' : 'map',
            source: 'map',
            fastAssets: this.appMode === 'play'
          }
        )
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
          // Immediate 3D chat wire — shell cleared chatHandler on transfer.
          world.bootstrapSocialChat(sceneConfig)
        } else {
          console.warn(
            '[comms] handoff FAILED · World will reconnect LiveKit (new participant id) · jumpKey=',
            jumpKey
          )
        }
      }
      const earlyCommsPromise = world.connectSceneCommsEarly(sceneConfig, opts.onProgress)

      this.unbindMinimapLayout()
      this.worldLocationCard?.dispose()
      this.worldLocationCard = null
      this.minimap?.dispose()
      this.minimap = null
      this.locationMapStack?.remove()
      this.locationMapStack = null

      // Genesis satellite minimap — parcel scenes only (worlds have no city basemap).
      const useMinimapStack = sceneConfig.source.kind !== 'world'
      if (useMinimapStack) {
        this.locationMapStack = document.createElement('div')
        this.locationMapStack.id = 'location-map-stack'
        this.locationMapStack.className = 'location-map-stack'
        this.locationMapStack.setAttribute('aria-label', 'Location and minimap')
        document.body.appendChild(this.locationMapStack)
      }

      const initialTitle = sceneDisplayTitle(sceneConfig)
      this.seedLocationTitleCache(sceneConfig, initialTitle)
      this.worldLocationCard = new WorldLocationCard({
        scene: sceneConfig,
        title: initialTitle,
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
            : undefined,
        mapToggle: this.locationMapStack
          ? {
              host: this.locationMapStack,
              onCollapsedChange: (collapsed) => {
                // Keep canvas idle cost low when the circle is hidden.
                this.minimap?.setVisible(!collapsed)
              }
            }
          : undefined,
        onSceneOptions: (anchor) => {
          if (document.pointerLockElement) document.exitPointerLock()
          this.liveToolsUi?.openMenuAt(anchor)
        }
      })
      // Live polls / Q&A — bind after card so ⋯ works as soon as owners resolve.
      void this.setupLiveTools(world, sceneConfig)
      this.lastLocationTitleKey =
        sceneConfig.source.kind === 'coords'
          ? sceneConfig.baseParcel
          : sceneConfig.commsPointer
      if (useMinimapStack && this.locationMapStack) {
        this.minimap = new Minimap({
          host: this.locationMapStack,
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

      // Seamless multi-scene: put feet back where the player was walking (Genesis meters).
      if (opts.restoreGenesisFeet) {
        const ok = world.restoreGenesisFeet(opts.restoreGenesisFeet)
        console.info(
          `[promote] restore genesis feet (${opts.restoreGenesisFeet.x.toFixed(1)}, ${opts.restoreGenesisFeet.y.toFixed(1)}, ${opts.restoreGenesisFeet.z.toFixed(1)}) ok=${ok}`
        )
      }

      world.start()

      // Multi-scene: bind PE + live secondaries (PE prefs survive this attach).
      world.attachMultiScene(this.multiSceneRuntime)
      this.shell?.bindPortableExperiences(this.peManager)

      const settleMs = opts.seamless
        ? 0
        : useFastBoot
          ? POST_SPAWN_SETTLE_FAST_MS
          : POST_SPAWN_SETTLE_MS
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

      // Discover smart-wearable PEs; consent popup once in-scene (never auto-start).
      void this.bootstrapPortableExperiences(world, sceneConfig)
    })()

    await loadPromise

    this.shell.setOnViewLocalProfile(() => this.profileUi?.openProfile({ kind: 'local' }))

    this.chatPanel?.dispose()
    // Re-assert 3D chat handlers after any shell teardown race (handoff → dispose).
    world.social.rewireComms(world.comms)
    this.chatPanel = new ChatPanel({
      social: world.social,
      onGoto: (target) => void this.jumpInToScene(target, { fastAssets: true }),
      onOpenProfile: (address) => this.profileUi?.openProfileForAddress(address),
      getCurrentRoute: () => this.currentRoute
    })
    this.wireCommunityFollow(world)
    this.shell.attachChatPanel(this.chatPanel, world.social)
    // Follow jump: restore community thread so Follow bar + tour context stay visible.
    const pendingCommunity = this.pendingFollowCommunityOpen
    if (pendingCommunity) {
      this.pendingFollowCommunityOpen = null
      this.chatPanel.openCommunityChannel(pendingCommunity.id, pendingCommunity.name)
    }
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

  /**
   * Dev-only console hook — open any wallet's profile modal without hunting for
   * a live player to click. `d3jsOpenProfile('0x…')` (no arg = own profile).
   * Routes exactly like the in-world / 2D shell profile entry points.
   */
  private wireProfileDebug(): void {
    if (!import.meta.env.DEV) return
    const g = window as typeof window & { d3jsOpenProfile?: (address?: string) => void }
    g.d3jsOpenProfile = (address?: string) => {
      const own =
        this.login?.kind === 'wallet' || this.login?.kind === 'guest'
          ? this.login.address.toLowerCase()
          : null
      const target = address?.trim().toLowerCase() || own
      if (!target) {
        console.warn('[dev] d3jsOpenProfile: no address given and no logged-in wallet')
        return
      }
      if (this.appMode === 'play') {
        this.profileUi?.openProfileForAddress(target)
        return
      }
      this.ensureSocialChatShell()
      this.socialChat?.openProfileForAddress(target)
    }
    console.info('[dev] d3jsOpenProfile(address) available — opens the profile modal for any wallet')
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
    document.body.classList.remove('client-in-world')
    this.resetClientHudVisible()
    this.shell?.hide()
    this.worldLocationCard?.setVisible(false)
    this.minimap?.setVisible(false)
    if (this.locationMapStack) this.locationMapStack.hidden = true
    this.mobileHud?.setShellVisible(false)
    this.world?.setSceneUiVisible(false)
  }

  private revealPlayChrome(): void {
    document.body.classList.add('client-in-world')
    // Fresh enter always shows chrome (U hide is session-in-play only).
    this.clientHudVisible = true
    document.body.classList.remove('client-hud-hidden')
    this.ensureInWorldChromeOnly()
    this.shell?.show()
    this.worldLocationCard?.setVisible(true)
    if (this.locationMapStack) this.locationMapStack.hidden = false
    // Respect chevron collapse — don't re-show a user-hidden circle.
    if (!this.worldLocationCard?.isMapCollapsed()) {
      this.minimap?.setVisible(true)
    }
    this.mobileHud?.setShellVisible(true)
    this.world?.setSceneUiVisible(true)
  }

  /** Drop 2D social-shell chrome that can leak onto the 3D HUD after teleports. */
  private ensureInWorldChromeOnly(): void {
    document.body.classList.remove('social-shell-with-chat')
    this.socialChatDock?.hide()
  }

  private resetClientHudVisible(): void {
    this.clientHudVisible = true
    document.body.classList.remove('client-hud-hidden')
  }

  /**
   * Explorer shortcuts while in 3D play:
   * - U — show/hide all UI (client chrome + scene UI)
   * - N — show/hide all name tags (local, remotes, AvatarShapes)
   */
  private readonly onPlayChromeHotkey = (e: KeyboardEvent): void => {
    if (!this.running) return
    if (!document.body.classList.contains('client-in-world')) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (isTextInputFocused()) return

    if (e.code === 'KeyU') {
      e.preventDefault()
      e.stopPropagation()
      this.toggleClientHud()
      return
    }
    if (e.code === 'KeyN') {
      e.preventDefault()
      e.stopPropagation()
      this.toggleNameTagsHotkey()
      return
    }
    if (e.code === 'KeyC') {
      // When already in photo mode, PhotoCameraController owns Esc/C to exit.
      if (this.world?.isPhotoCameraActive()) return
      // Explorer In-World Camera (photo fly mode) — not orbit freecam.
      e.preventDefault()
      e.stopPropagation()
      this.world?.togglePhotoCamera()
    }
  }

  /** Explorer [U] — toggle ALL UI: client chrome + scene UI + open overlays. */
  private toggleClientHud(): void {
    this.clientHudVisible = !this.clientHudVisible
    document.body.classList.toggle('client-hud-hidden', !this.clientHudVisible)

    if (!this.clientHudVisible) {
      this.shell?.hide()
      this.chatPanel?.hide()
      this.worldLocationCard?.setVisible(false)
      this.minimap?.setVisible(false)
      if (this.locationMapStack) this.locationMapStack.hidden = true
      this.mobileHud?.setShellVisible(false)
      this.settingsOverlay?.hide()
      this.preferencesPanel?.hide()
      this.world?.setSceneUiVisible(false)
      return
    }

    if (!document.body.classList.contains('client-in-world')) return
    this.shell?.show()
    this.worldLocationCard?.setVisible(true)
    if (this.locationMapStack) this.locationMapStack.hidden = false
    if (!this.worldLocationCard?.isMapCollapsed()) {
      this.minimap?.setVisible(true)
    }
    this.mobileHud?.setShellVisible(true)
    this.world?.setSceneUiVisible(true)
  }

  /**
   * Explorer [N] — toggle every overhead name tag: local, remotes, AvatarShape NPCs.
   * Scene policy (featureToggles.nameTags / ?nameTags=) locks like skybox fixedTime.
   */
  private toggleNameTagsHotkey(): void {
    if (isNameTagsSceneLocked()) {
      clientDebugLog.log('client', 'Name tags locked by scene.json / ?nameTags= — N ignored', {
        alsoConsole: true,
        throttleMs: 4_000
      })
      return
    }
    const visible = toggleUserNameTagsVisible()
    if (visible === null) return
    this.world?.applyNameTagsVisibility()
    clientDebugLog.log(
      'client',
      visible
        ? 'Name tags shown (N) — local + remotes + AvatarShapes'
        : 'Name tags hidden (N) — local + remotes + AvatarShapes',
      { alsoConsole: false, throttleMs: 500 }
    )
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

  /** Display name for a tour pin (scene title when known). */
  private resolveTourLocationSceneName(target: FollowTarget): string {
    if (this.monitoredScene) {
      const t = sceneDisplayTitle(this.monitoredScene)
      if (t?.trim()) return t.trim()
    }
    return followTargetLabel(target) || 'Scene'
  }

  private parcelFromPlayerState(
    state: MapPlayerState | null
  ): { px: number; py: number } | null {
    if (!state?.parcelKey) return null
    const m = /^(-?\d+),(-?\d+)$/.exec(state.parcelKey.trim())
    if (!m) return null
    return { px: parseInt(m[1]!, 10), py: parseInt(m[2]!, 10) }
  }

  /**
   * Follow teleport gate: skip Jump In when already co-located with the tour stop.
   * - Loaded primary matches target (same scene/world jump)
   * - Or feet parcel matches target coords (standing next to leader after soft walk)
   * - Or primary multi-parcel scene contains the target parcel
   */
  private isAlreadyAtFollowTarget(target: FollowTarget): boolean {
    if (this.appMode !== 'play' || !this.world) return false
    const route = followTargetToRoute(target)

    if (this.currentRoute && routeEquals(this.currentRoute, route)) return true

    if (target.kind === 'coords') {
      const feet = this.parcelFromPlayerState(this.getMapPlayerState())
      if (feet && feet.px === target.x && feet.py === target.y) return true

      const primary = this.world.getLoadedPrimaryScene?.()
      if (primary?.source.kind === 'coords' && primary.parcels?.length) {
        const key = `${target.x},${target.y}`
        if (primary.parcels.includes(key) || primary.baseParcel === key) return true
      }
    }

    if (target.kind === 'world' && this.currentRoute?.kind === 'world') {
      return (
        this.currentRoute.worldName.trim().toLowerCase() === target.worldName.trim().toLowerCase()
      )
    }

    return false
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

  /**
   * SPA address bar only — `history.replaceState`, no navigation, no reload.
   *
   * IMPORTANT: does **not** set `currentRoute`. That field is the **loaded primary**
   * scene. Soft feet tracking used to overwrite it, so promote to Angzaar at -9,-91
   * hit routeEquals and skipped the load (stuck on empty primary forever).
   */
  private softUpdatePlayRoute(
    target: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
  ): void {
    if (this.navigating) return
    const nextPath = routePathForTarget(target)
    let pathChanged = window.location.pathname !== nextPath
    if (pathChanged) {
      try {
        pathChanged = decodeURIComponent(window.location.pathname) !== decodeURIComponent(nextPath)
      } catch {
        /* keep pathChanged from pathname compare */
      }
    }
    if (pathChanged) {
      applyRouteToHistory(target, true)
    }
    // Tour leader walking parcels — label only (no follower /goto reloads).
    // Hard jumps go through jumpInToScene → noteLeaderGoto.
    if (this.appMode === 'play' && this.communityFollow?.isLeading()) {
      this.communityFollow.noteLeaderLocation(target)
    }
  }

  /** Push scene/world name into desktop location card + mobile pill. */
  private applyLocationTitle(title: string, parcelKey?: string): void {
    const t = title.trim() || 'Scene'
    this.worldLocationCard?.setTitle(t)
    this.shell?.setSceneLocation(t, () => this.getLocationCoordsLabel())
    if (parcelKey) this.lastLocationTitleKey = parcelKey
  }

  private seedLocationTitleCache(scene: ResolvedScene, title: string): void {
    const t = title.trim() || 'Scene'
    for (const p of scene.parcels) {
      if (p) this.locationTitleCache.set(p, t)
    }
    if (scene.baseParcel) this.locationTitleCache.set(scene.baseParcel, t)
  }

  /**
   * Soft-route / promote: keep the minimap top bar name on the parcel under feet
   * (was frozen at jump-in primary title — e.g. "Farcaster" after walking to empty land).
   */
  private async refreshLocationTitleForParcel(x: number, y: number): Promise<void> {
    const key = `${x},${y}`
    if (key === this.lastLocationTitleKey && this.locationTitleCache.has(key)) return

    const primary = this.world?.getLoadedPrimaryScene()
    if (primary?.source.kind === 'coords' && primary.parcels.includes(key)) {
      const title = sceneDisplayTitle(primary)
      this.seedLocationTitleCache(primary, title)
      this.applyLocationTitle(title, key)
      return
    }

    const cached = this.locationTitleCache.get(key)
    if (cached) {
      this.applyLocationTitle(cached, key)
      return
    }

    // Leave primary footprint — don't keep the old scene name while resolving.
    const provisional = `Parcel ${x},${y}`
    this.applyLocationTitle(provisional, key)

    const gen = ++this.locationTitleGen
    try {
      const title = await fetchPublicSceneTitle(
        { kind: 'coords', x, y, segment: key },
        null
      )
      const resolved = title.trim() || provisional
      if (this.locationTitleCache.size > 256) this.locationTitleCache.clear()
      this.locationTitleCache.set(key, resolved)
      // Only paint if feet are still here (stale fetches still warm the cache).
      if (gen === this.locationTitleGen && this.lastLocationTitleKey === key) {
        this.applyLocationTitle(resolved, key)
      }
    } catch {
      this.locationTitleCache.set(key, provisional)
    }
  }

  /**
   * Scene Distance warm band — prefetch real scene manifests/scripts so stand-on
   * promote is fast. Visual AOI uses the same radius (composites / first-frame).
   * (Script-built estates like Angzaar have no main.composite — warm is the only
   * pre-promote load path for their GLBs.)
   *
   * Serialized: one resolve+IDB warm at a time so CBD 30+ neighbors don't thrash.
   */
  private enqueueScriptWarm(x: number, y: number): void {
    const key = `${x},${y}`
    if (this.scriptWarmQueuedKeys.has(key)) return
    this.scriptWarmQueuedKeys.add(key)
    this.scriptWarmQueue.push({ x, y })
    this.drainScriptWarmQueue()
  }

  private drainScriptWarmQueue(): void {
    while (
      this.scriptWarmInFlight < AppController.SCRIPT_WARM_MAX_CONCURRENT &&
      this.scriptWarmQueue.length > 0
    ) {
      const next = this.scriptWarmQueue.shift()!
      this.scriptWarmInFlight++
      void this.prefetchPromoteTarget(next.x, next.y).finally(() => {
        this.scriptWarmInFlight--
        this.scriptWarmQueuedKeys.delete(`${next.x},${next.y}`)
        this.drainScriptWarmQueue()
      })
    }
  }

  private async prefetchPromoteTarget(x: number, y: number): Promise<void> {
    try {
      const target = { kind: 'coords' as const, x, y, segment: `${x},${y}` }
      const scene = await resolveSceneFromRoute(target)
      // Don't waste prefetch on empty synthetic 1×1 or scenes without content.
      if (!scene.entityId || !scene.mainEntry) {
        console.info(
          `[promote] script-warm skip ${x},${y} — ${!scene.entityId ? 'no entity' : 'no main'} (“${scene.title}”)`
        )
        return
      }
      const glbCount = scene.content.filter((f) => /\.glb$/i.test(f.file)).length
      console.info(
        `[promote] script-warm “${scene.title}” @ ${x},${y} entity=${scene.entityId.slice(0, 12)}… glbs=${glbCount} main=${scene.mainEntry}` +
          (this.scriptWarmQueue.length ? ` queue=${this.scriptWarmQueue.length}` : '')
      )
      prefetchSceneManifestAssets(getSessionAssetCache(), scene)
    } catch (err) {
      console.warn(`[promote] script-warm failed ${x},${y}`, err)
    }
  }

  private getMapPlayerState(): MapPlayerState | null {
    const world = this.world
    if (!world) return this.lastMapPlayerState
    const pos = world.getPlayerPosition()
    if (!pos) return this.lastMapPlayerState
    const origin = world.comms.getSceneOrigin()
    // Genesis City meters = scene-local DCL feet + base parcel origin (×16).
    const genesisX = pos.x + origin.x
    const genesisZ = pos.z + origin.z
    // Prefer continuous genesis → parcel (same path soft URL / promote use).
    const { parcelKey } = genesisMetersToParcel(genesisX, genesisZ)
    const profile = world.session.getProfile()
    const address = world.session.getAddress()
    const state: MapPlayerState = {
      position: { x: genesisX, y: pos.y, z: genesisZ },
      parcelKey,
      address: address ?? undefined,
      displayName: profile?.displayName,
      faceUrl: world.social.getLocalDisplay().faceUrl,
      // Visual body facing → canvas angle (tracks avatar while moving).
      facingYaw: world.getPlayerMinimapAngle() ?? undefined
    }
    this.lastMapPlayerState = state
    return state
  }

  private bindNearbyVoice(world: World): void {
    this.unsubVoiceUi?.()
    this.unsubVoiceUi = null
    this.unsubVoiceSpeaking?.()
    this.unsubVoiceSpeaking = null
    world.syncVoiceRoom()
    this.shell?.bindNearbyVoice(world.voice)
    clientDebugLog.log('voice', `panel bound · ${world.comms.describeLiveKitRooms()}`)
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

  /**
   * Continuity-first parcel promote (no World rebuild on walk):
   * 1) pin + force-boot under-feet as live secondary if needed
   * 2) handoff + sticky demote prior primary (meshes stay)
   * 3) if handoff fails — stay put (never disposeSecondaries + seamless jump)
   */
  private async promotePrimary(
    target: Extract<RouteTarget, { kind: 'coords' }>,
    reason: string
  ): Promise<void> {
    const key = `${target.x},${target.y}`
    // Collapse concurrent dwells (logs showed promote spam every 200ms → dual seamless jumps).
    if (this.promoteInFlight) {
      if (this.promoteInFlightKey === key) {
        await this.promoteInFlight
        return
      }
      // Different parcel — wait for current then re-evaluate if still under feet later.
      await this.promoteInFlight
    }
    const run = this.promotePrimaryBody(target, reason)
    this.promoteInFlight = run
    this.promoteInFlightKey = key
    try {
      await run
    } finally {
      if (this.promoteInFlight === run) {
        this.promoteInFlight = null
        this.promoteInFlightKey = ''
      }
    }
  }

  private async promotePrimaryBody(
    target: Extract<RouteTarget, { kind: 'coords' }>,
    reason: string
  ): Promise<void> {
    const world = this.world
    if (!world) {
      console.warn('[promote] no world — cannot handoff')
      return
    }

    // Pin under-feet parcel so live secondary boots first (handoff, no loading screen).
    this.multiSceneRuntime.setSecondaryPriorityParcel(target.x, target.y)
    try {
      let handed = await world.tryPromoteInWorld(target)
      if (!handed) {
        // Force-boot under-feet as secondary (any size if priority), wait for handoff.
        // Continuity: never fall through to disposeSecondaries + seamless jump.
        console.info(
          `[promote] wait for live secondary @ ${target.x},${target.y} (handoff only — no unload)…`
        )
        const bootPromise = this.multiSceneRuntime.ensureSecondaryForParcel(
          target.x,
          target.y,
          45_000
        )
        for (let i = 0; i < 60 && !handed; i++) {
          await new Promise<void>((r) => setTimeout(r, 400))
          if (this.world !== world) return
          handed = await world.tryPromoteInWorld(target)
          if (handed) break
          if (i > 3 && (await Promise.race([bootPromise.then(() => true), Promise.resolve(false)]))) {
            handed = await world.tryPromoteInWorld(target)
            if (!handed && i > 20) break
          }
        }
        await bootPromise.catch(() => false)
        if (!handed) handed = await world.tryPromoteInWorld(target)
      }
      if (handed) {
        console.info(
          `[promote] in-world handoff+demote ${target.x},${target.y} (${reason})`
        )
        this.multiSceneRuntime.setSecondaryPriorityParcel(target.x, null)
        this.currentRoute = target
        // Re-bind PE HUD so scene.json portableExperiences policy refreshes the icon.
        this.shell?.bindPortableExperiences(this.peManager)
        const next = world.getLoadedPrimaryScene()
        if (next) {
          const title = sceneDisplayTitle(next)
          this.seedLocationTitleCache(next, title)
          this.applyLocationTitle(title, `${target.x},${target.y}`)
        }
        return
      }
    } catch (err) {
      console.warn('[promote] in-world handoff failed — keeping current primary (no unload)', err)
    }

    // Continuity contract: never destroy the world on parcel walk.
    console.warn(
      `[promote] ABORT seamless jump @ ${target.x},${target.y} (${reason}) — ` +
        `no live secondary after wait; prior primary stays resident`
    )
    this.multiSceneRuntime.setSecondaryPriorityParcel(target.x, null)
  }

  /**
   * Detect equipped smart wearables → PE candidates; restore enabled; consent if new.
   * Profile wearables can lag spawn slightly — retry a few times before giving up.
   */
  private async bootstrapPortableExperiences(world: World, scene: ResolvedScene): Promise<void> {
    try {
      const peerUrl = scene.realm.contentUrl || this.sceneContentUrl
      let profile = world.session.getProfile()
      let wearables = profile?.wearables ?? []
      // session.connect may finish just after spawn on cold loads
      for (let i = 0; i < 12 && wearables.length === 0; i++) {
        await new Promise<void>((r) => window.setTimeout(r, 250))
        if (this.world !== world) return
        profile = world.session.getProfile()
        wearables = profile?.wearables ?? []
      }
      const bodyShape = profile?.bodyShape === 'female' ? 'female' : 'male'
      // Re-apply scene policy from resolved primary (promote / seamless can race attach).
      const pePolicy =
        scene.portableExperiencesPolicy ?? resolvePortableExperiencesPolicy(scene.metadata)
      this.peManager.applyScenePolicy(pePolicy)
      const ft = scene.metadata?.featureToggles
      console.info(
        `[pe] bootstrap wearables=${wearables.length} body=${bodyShape} peer=${peerUrl}` +
          ` policy=${this.peManager.getPePolicy().raw} allowed=${this.peManager.isPeAllowed()}` +
          ` featureToggles.pe=${JSON.stringify(ft?.portableExperiences ?? null)}`
      )
      await this.peManager.discoverFromWearables(wearables, peerUrl, { bodyShape })
      // Re-sync HUD restriction after discovery (scene may already block PE).
      this.shell?.bindPortableExperiences(this.peManager)
      // Give the frame loop a beat so HUD is up, then consent (no auto-start).
      await new Promise<void>((r) => window.setTimeout(r, 600))
      if (this.world !== world) return
      // Re-check after attach races — never show activate-PEX when scene disables PE.
      if (!this.peManager.isPeAllowed()) {
        console.info('[pe] consent skipped after re-check — scene disables portable experiences')
        this.shell?.bindPortableExperiences(this.peManager)
        return
      }
      await this.peManager.maybeShowConsentPrompt()
      // Consent path may emit; keep icon restriction in sync.
      this.shell?.bindPortableExperiences(this.peManager)
    } catch (err) {
      console.warn('[pe] bootstrap failed', err)
    }
  }

  private async teardownScene(opts?: { keepLiveKit?: boolean; clearVrmCache?: boolean }): Promise<void> {
    // Dwell is ended explicitly (leave play / teleport / error / pagehide) — not here.
    // teardownScene runs mid jump-in load and would kill a fresh play_session_id.
    this.unsubVoiceUi?.()
    this.unsubVoiceUi = null
    this.unsubVoiceSpeaking?.()
    this.unsubVoiceSpeaking = null
    this.shell?.bindNearbyVoice(null)
    this.shell?.bindPortableExperiences(null)
    this.world?.setVoluntaryEmoteAllowedHandler(null)
    this.teardownExplorer()
    this.editorApp?.dispose()
    this.editorApp = null
    this.profileUi?.dispose()
    this.profileUi = null
    this.mobileHud?.dispose()
    this.mobileHud = null
    this.unbindMinimapLayout()
    this.disposeLiveTools()
    this.worldLocationCard?.dispose()
    this.worldLocationCard = null
    this.minimap?.dispose()
    this.minimap = null
    this.locationMapStack?.remove()
    this.locationMapStack = null
    this.chatPanel?.hide()
    this.hidePlayChrome()
    // Keep communityFollow across in-play World rebuilds (/goto pulses).
    // Drop only when leaving play — see disposeCommunityFollow().
    this.unsubCommunityFollow?.()
    this.unsubCommunityFollow = null
    await disconnectAll(this.world, { keepLiveKit: opts?.keepLiveKit === true })
    this.world = null
    // Default: keep peer VRM RAM across tour teleports. Explicit clear when leaving 3D shell.
    // clearVrmCache also ends PM play-session hold (teleports pass clearVrmCache: false).
    if (opts?.clearVrmCache) {
      clearVrmRamCache()
      this.releasePmPlaySession()
    }
    if (this.container) this.container.innerHTML = ''
  }

  /**
   * Live polls + Q&A + trivia for the current place (3D play).
   * Transport: scene LiveKit topic `d3js-live-tools:{placeKey}` (never RFC4 Chat).
   */
  private async setupLiveTools(world: World, scene: ResolvedScene): Promise<void> {
    const placeKey = placeKeyFromScene(scene)
    if (!placeKey) return
    await this.bindLiveToolsSession({
      placeKey,
      publish: (topic, packet) => world.comms.publishRawTopicData(topic, packet, true),
      addTopicListener: (fn) => world.comms.addTopicListener(fn),
      getLocalWallet: () => {
        const fromSession = world.session.getAddress()?.trim().toLowerCase()
        if (fromSession && /^0x[a-f0-9]{40}$/.test(fromSession)) return fromSession
        return this.sessionParticipantAddress()
      },
      getDisplayName: () => {
        const profile = world.session.getProfile()
        const dn = profile?.displayName?.trim()
        if (dn) return dn
        return this.sessionDisplayName()
      },
      ownerRoute:
        scene.source.kind === 'world' || scene.source.kind === 'coords'
          ? scene.source.kind === 'world'
            ? {
                kind: 'world',
                worldName: scene.source.worldName,
                segment: scene.source.worldName,
                ...(scene.source.customServer
                  ? { customServer: scene.source.customServer }
                  : {})
              }
            : {
                kind: 'coords',
                x: scene.source.x,
                y: scene.source.y,
                segment: `${scene.source.x},${scene.source.y}`
              }
          : null
    })
  }

  /**
   * Live tools on 2D scene landing — same UI panels as 3D, same LiveKit topic.
   */
  private async setupLandingLiveTools(
    route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
  ): Promise<void> {
    const comms = this.socialChat?.getComms()
    if (!comms) return
    const placeKey =
      route.kind === 'world'
        ? route.worldName.trim().toLowerCase()
        : `${route.x},${route.y}`
    if (!placeKey) return
    await this.bindLiveToolsSession({
      placeKey,
      publish: (topic, packet) => comms.publishRawTopicData(topic, packet, true),
      addTopicListener: (fn) => comms.addTopicListener(fn),
      getLocalWallet: () => this.sessionParticipantAddress(),
      getDisplayName: () => this.sessionDisplayName(),
      ownerRoute: route
    })
  }

  private sessionParticipantAddress(): string | null {
    const login = this.login
    if (login?.kind === 'wallet' || login?.kind === 'guest') {
      const a = login.address.trim().toLowerCase()
      if (/^0x[a-f0-9]{40}$/.test(a)) return a
    }
    return null
  }

  private sessionDisplayName(): string | null {
    const login = this.login
    if (login?.kind === 'wallet') return login.address.slice(0, 8)
    if (login?.kind === 'guest') {
      return login.displayName?.trim() || `Guest-${login.address.slice(2, 6)}`
    }
    return null
  }

  private async bindLiveToolsSession(opts: {
    placeKey: string
    publish: (topic: string, packet: Uint8Array) => Promise<boolean>
    addTopicListener: (
      fn: (topic: string, sender: string, payload: Uint8Array) => void
    ) => () => void
    getLocalWallet: () => string | null
    getDisplayName: () => string | null
    ownerRoute: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }> | null
  }): Promise<void> {
    // Always rebuild so publish/listen hit the current LiveKit room (landing vs World).
    this.disposeLiveTools()
    const session = new LiveToolsSession({
      placeKey: opts.placeKey,
      ownerAddresses: [],
      getLocalWallet: opts.getLocalWallet,
      getDisplayName: opts.getDisplayName,
      publish: opts.publish,
      onChange: () => this.liveToolsUi?.refresh()
    })
    this.liveToolsSession = session
    this.liveToolsUi = new LiveToolsUi({
      session,
      onToast: (message) => {
        clientDebugLog.log('client', `[live-tools] ${message}`)
      }
    })
    this.unsubLiveToolsTopic = opts.addTopicListener((topic, sender, payload) => {
      session.handleInbound(topic, sender, payload)
    })

    if (opts.ownerRoute) {
      try {
        const meta = await fetchSceneLandingMeta(opts.ownerRoute)
        if (this.liveToolsSession !== session) return
        session.setOwnerAddresses(meta.ownerAddresses ?? [])
      } catch {
        /* host features stay disabled until owners known */
      }
    }

    window.setTimeout(() => {
      if (this.liveToolsSession === session) session.start()
    }, 800)
  }

  private disposeLiveTools(): void {
    this.unsubLiveToolsTopic?.()
    this.unsubLiveToolsTopic = null
    this.liveToolsUi?.dispose()
    this.liveToolsUi = null
    this.liveToolsSession?.dispose()
    this.liveToolsSession = null
  }

  /** End Follow/Tour session when leaving 3D play (session-only product rule). */
  private disposeCommunityFollow(): void {
    this.unsubCommunityFollow?.()
    this.unsubCommunityFollow = null
    this.tourFocus?.dispose()
    this.tourFocus = null
    this.tourFocusHost = null
    this.tourFocusOptOut = false
    this.closeTourRejoinPanel()
    this.communityFollow?.dispose()
    this.communityFollow = null
    this.followFlagManager?.dispose()
    this.followFlagManager = null
    this.tourOptionsPopup?.dispose()
    this.tourOptionsPopup = null
    this.tourFlagImageModal?.dispose()
    this.tourFlagImageModal = null
    this.shell?.setTourOptionsVisible(false)
  }

  /** Sign out wallet → fall back to stable browser guest (same machine keeps guest key). */
  private async signOutFrom2dShell(): Promise<void> {
    clearStoredIdentity()
    this.leaveCommunityVoiceSession()
    this.disposeCommunityVoiceBar()
    this.socialChat?.signOut()
    this.teardownSocialChatShell(true)
    this.disposeSocialMobileNotifications()
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
    this.ensureSocialMobileNotifications()
    this.socialMobileNotifications?.setLogin(guest)
  }

  private applyLoginToSocialShellViews(login: LoginResult): void {
    this.explorerView?.setLogin(login)
    this.mapPageView?.setLogin(login)
    this.eventsPageView?.setLogin(login)
    this.livePageView?.setLogin(login)
    this.lootBagPageView?.setLogin(login)
    this.communitiesPageView?.setLogin(login)
    this.profilePageView?.setLogin(login)
    this.sceneLandingView?.setLogin(login)
  }

  async signOut(): Promise<void> {
    window.removeEventListener('popstate', this.onPopState)
    this.leaveCommunityVoiceSession()
    this.disposeCommunityVoiceBar()
    this.disposeCommunityFollow()
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
    this.disposeSocialMobileNotifications()
    this.teardownExplorer()
    this.teardownLanding()
    this.clearSceneBanWatch()
    await this.teardownScene({ clearVrmCache: true })
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
