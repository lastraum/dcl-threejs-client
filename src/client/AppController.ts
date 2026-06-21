import type { LoginResult } from '../auth/AuthClient'
import { clearStoredIdentity } from '../auth/identityStore'
import {
  applyRouteToHistory,
  resolveRouteTarget,
  routeEquals,
  type RouteTarget
} from '../dcl/content/route'
import { resolveSceneFromRoute, summarizeSceneContent } from '../dcl/content/resolveScene'
import { World } from '../core/World'
import { disconnectAll } from '../network/SessionConnections'
import { ClientShell } from './ui/shell/ClientShell'
import { clientDebugLog } from './debug/ClientDebugLog'
import { DebugPanel } from './ui/DebugPanel'
import { DevProgressPanel } from './ui/DevProgressPanel'
import { LoadingScreen, POST_SPAWN_SETTLE_FAST_MS, POST_SPAWN_SETTLE_MS } from './ui/LoadingScreen'
import { Minimap } from './ui/Minimap'
import { WorldLocationCard } from './ui/WorldLocationCard'
import { showSplashScreen } from './ui/SplashScreen'
import { ChatPanel } from './ui/chat/ChatPanel'
import { PreferencesPanel } from './ui/settings/PreferencesPanel'
import { SettingsOverlay } from './ui/settings/SettingsOverlay'
import type { MapPlayerState } from './ui/settings/MapView'
import { genesisMetersToParcel } from '../map/genesisMapViewport'
import { fetchProfileFaceUrl } from '../avatar/peerApi'
import { hydrateEmoteWheelSlots } from '../avatar/profileEmotes'
import { disposeSessionAssetCache, getSessionAssetCache, prefetchSceneManifestGlbs } from '../rendering/AssetCache'
import { DEFAULT_TIMEOUT_MS, FAST_TIMEOUT_MS, type SceneHydrationStats } from '../rendering/sceneHydration'
import { applyMobileGraphics, initMobilePortraitLayout, isMobilePortrait } from './mobilePortrait'

/** Owns world lifecycle — splash → load → play, navigation, and sign-out. */
export class AppController {
  private container: HTMLElement | null = null
  private world: World | null = null
  private shell: ClientShell | null = null
  private debugPanel: DebugPanel | null = null
  private devProgressPanel: DevProgressPanel | null = null
  private minimap: Minimap | null = null
  private worldLocationCard: WorldLocationCard | null = null
  private chatPanel: ChatPanel | null = null
  private settingsOverlay: SettingsOverlay | null = null
  private preferencesPanel: PreferencesPanel | null = null
  private login: LoginResult | null = null
  private currentRoute: RouteTarget | null = null
  private running = false
  private navigating = false

  async start(container: HTMLElement): Promise<void> {
    if (this.running) return
    this.running = true
    this.container = container
    initMobilePortraitLayout()

    this.login = await showSplashScreen()
    window.addEventListener('popstate', this.onPopState)

    const loading = new LoadingScreen('Preparing your experience…')
    loading.mount()
    loading.startLoadingTimer()
    try {
      const hydrationTimedOut = await this.loadRoute(resolveRouteTarget(), {
        replace: true,
        onProgress: (msg, fraction, stats) => {
          loading.setStatus(msg)
          if (fraction !== undefined) loading.setProgress(fraction)
          if (stats) loading.setHydrationStats(stats)
        },
        onHydrationStart: (timeoutMs) => loading.setHydrationTimeoutMs(timeoutMs),
        onHydrationFinish: (result) => loading.noteHydrationComplete(result)
      })
      await loading.finish(Promise.resolve(), { skipHold: !hydrationTimedOut })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      loading.setStatus(msg, true)
      clientDebugLog.log('client', `Failed to load scene: ${msg}`, { level: 'error' })
      await loading.finish(Promise.resolve())
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
    if (this.currentRoute && routeEquals(this.currentRoute, target) && this.world) return

    this.navigating = true
    const loading = new LoadingScreen('Teleporting…', { fast: true })
    loading.mount()
    loading.startLoadingTimer()
    try {
      const hydrationTimedOut = await this.loadRoute(target, {
        ...opts,
        fastAssets: true,
        onProgress: (msg, fraction, stats) => {
          loading.setStatus(msg)
          if (fraction !== undefined) loading.setProgress(fraction)
          if (stats) loading.setHydrationStats(stats)
        },
        onHydrationStart: (timeoutMs) => loading.setHydrationTimeoutMs(timeoutMs),
        onHydrationFinish: (result) => loading.noteHydrationComplete(result)
      })
      await loading.finish(Promise.resolve(), { skipHold: !hydrationTimedOut })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      loading.setStatus(msg, true)
      clientDebugLog.log('client', `Teleport failed: ${msg}`, { level: 'error' })
      await loading.finish(Promise.resolve())
    } finally {
      this.navigating = false
    }
  }

  private async loadRoute(
    route: RouteTarget,
    opts: {
      fromHistory?: boolean
      replace?: boolean
      fastAssets?: boolean
      onProgress?: (msg: string, fraction?: number, stats?: SceneHydrationStats) => void
      onHydrationStart?: (timeoutMs: number) => void
      onHydrationFinish?: (result: { timedOut: boolean; elapsedMs: number }) => void
    } = {}
  ): Promise<boolean> {
    if (!opts.fromHistory) {
      applyRouteToHistory(route, opts.replace ?? false)
    }
    this.currentRoute = route

    await this.teardownScene()

    opts.onProgress?.('Resolving destination…')
    const sceneConfig = await resolveSceneFromRoute(route)
    prefetchSceneManifestGlbs(getSessionAssetCache(), sceneConfig)
    opts.onProgress?.('Building world…')
    if (!this.container) throw new Error('App container missing')

    const world = new World(this.container)
    this.world = world
    if (isMobilePortrait()) {
      applyMobileGraphics(world.host.renderer)
    }
    world.applyLogin(this.login)

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
      this.devProgressPanel = new DevProgressPanel()
    }

    if (!this.shell) {
      this.shell = new ClientShell({
        environment: world.environment,
        session: world.session,
        debugPanel: this.debugPanel,
        devProgressPanel: this.devProgressPanel,
        onEmoteSelected: (emoteId) => world.playLocalEmote(emoteId, { loop: false }),
        onSignOut: () => this.signOut(),
        onExit: () => this.signOut()
      })
    } else {
      this.shell.updateWorldBindings(world.session, world.environment)
      this.shell.setEmoteHandler((emoteId) => world.playLocalEmote(emoteId, { loop: false }))
    }

    if (!this.settingsOverlay) {
      this.settingsOverlay = new SettingsOverlay({
        session: world.session,
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
        onOpen: () => {
          if (document.pointerLockElement) document.exitPointerLock()
          this.preferencesPanel?.hide()
          this.shell?.getButton('settings')?.setActive(false)
        },
        onClose: () => {}
      })
    } else {
      this.settingsOverlay.updateSession(world.session)
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
          this.shell?.onPreferencesVisibilityChange(visible)
        },
        onOpen: () => {
          this.settingsOverlay?.hide()
        }
      })
    }

    let hydrationTimedOut = false

    const loadPromise = (async () => {
      await world.loadScene(sceneConfig, opts.onProgress)
      const earlyCommsPromise = world.connectSceneCommsEarly(sceneConfig, opts.onProgress)

      this.minimap?.dispose()
      this.minimap = null
      this.worldLocationCard?.dispose()
      this.worldLocationCard = null

      if (sceneConfig.source.kind === 'world') {
        this.worldLocationCard = new WorldLocationCard({
          scene: sceneConfig,
          getPlayerPosition: () => world.getPlayerPosition(),
          onJumpToGenesis: () => {
            if (document.pointerLockElement) document.exitPointerLock()
            void this.navigateTo({
              kind: 'coords',
              x: 0,
              y: 0,
              segment: '0,0'
            })
          }
        })
      } else {
        this.minimap = new Minimap({
          scene: sceneConfig,
          getPlayerPosition: () => world.getPlayerPosition(),
          onClick: () => {
            if (document.pointerLockElement) document.exitPointerLock()
            this.settingsOverlay?.show('map')
          }
        })
      }

      const hydrationTimeoutMs = opts.fastAssets ? FAST_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
      opts.onHydrationStart?.(hydrationTimeoutMs)
      const hydrationResult = await world.waitForSceneAssets(sceneConfig, opts.onProgress, {
        timeoutMs: opts.fastAssets ? FAST_TIMEOUT_MS : undefined
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

      const settleMs = opts.fastAssets ? POST_SPAWN_SETTLE_FAST_MS : POST_SPAWN_SETTLE_MS
      if (settleMs > 0) {
        opts.onProgress?.('Settling world…', 0.985)
        await new Promise<void>((resolve) => window.setTimeout(resolve, settleMs))
      }

      opts.onProgress?.('Starting experience…', 0.99)

      const footer = 'Click to lock cursor · WASD move · /goto name or x,y in chat'

      this.debugPanel?.setStatusHtml(`${summarizeSceneContent(sceneConfig)}<br>${footer}`)
      clientDebugLog.log('client', 'Scene loaded — open Help (?) for network debug log')
      const profile = world.session.getProfile()
      const peerUrl = sceneConfig.realm.contentUrl
      void hydrateEmoteWheelSlots(profile, peerUrl).then((slots) => {
        this.shell?.setEmoteWheelSlots(slots)
      })
    })()

    await loadPromise

    this.chatPanel?.dispose()
    this.chatPanel = new ChatPanel({
      social: world.social,
      onGoto: (target) => this.navigateTo(target)
    })
    this.shell.attachChatPanel(this.chatPanel, world.social)
    if (this.settingsOverlay) this.shell.attachSettingsOverlay(this.settingsOverlay)
    if (this.preferencesPanel) this.shell.attachPreferencesPanel(this.preferencesPanel)
    opts.onProgress?.('Almost ready…')
    this.shell.show()
    void this.shell.refreshProfile()

    const address = world.session.getAddress()
    const profile = world.session.getProfile()
    if (address && profile) {
      void fetchProfileFaceUrl(address, world.session.getLambdasUrl()).then((faceUrl) => {
        world.social.setLocalFaceUrl(faceUrl)
      })
    }

    return hydrationTimedOut
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
    this.minimap?.dispose()
    this.minimap = null
    this.worldLocationCard?.dispose()
    this.worldLocationCard = null
    this.chatPanel?.hide()
    await disconnectAll(this.world)
    this.world = null
    if (this.container) this.container.innerHTML = ''
  }

  async signOut(): Promise<void> {
    window.removeEventListener('popstate', this.onPopState)
    this.chatPanel?.dispose()
    this.chatPanel = null
    this.settingsOverlay?.dispose()
    this.settingsOverlay = null
    this.preferencesPanel?.dispose()
    this.preferencesPanel = null
    this.debugPanel?.dispose()
    this.debugPanel = null
    this.devProgressPanel?.dispose()
    this.devProgressPanel = null
    this.shell?.dispose()
    this.shell = null
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
