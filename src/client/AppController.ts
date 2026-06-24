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
import { ClientShell } from './ui/shell/ClientShell'
import { clientDebugLog } from './debug/ClientDebugLog'
import { DebugPanel } from './ui/DebugPanel'
import { DevProgressPanel } from './ui/DevProgressPanel'
import { LoadingScreen, POST_SPAWN_SETTLE_FAST_MS, POST_SPAWN_SETTLE_MS } from './ui/LoadingScreen'
import { WorldLocationCard } from './ui/WorldLocationCard'
import { showSplashScreen } from './ui/SplashScreen'
import { ChatPanel } from './ui/chat/ChatPanel'
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
import { DEFAULT_TIMEOUT_MS, FAST_TIMEOUT_MS, type SceneHydrationStats } from '../rendering/sceneHydration'
import { resolveSceneLoadWarm } from '../rendering/sceneLoadWarm'
import { formatSceneLoadError } from './formatSceneLoadError'
import { ProfileUiController } from './ui/profile/ProfileUiController'
import { recordLoginEvent } from '../analytics/recordLogin'

/** Owns world lifecycle — splash → load → play, navigation, and sign-out. */
export class AppController {
  private container: HTMLElement | null = null
  private world: World | null = null
  private shell: ClientShell | null = null
  private debugPanel: DebugPanel | null = null
  private devProgressPanel: DevProgressPanel | null = null
  private worldLocationCard: WorldLocationCard | null = null
  private chatPanel: ChatPanel | null = null
  private settingsOverlay: SettingsOverlay | null = null
  private preferencesPanel: PreferencesPanel | null = null
  private login: LoginResult | null = null
  private currentRoute: RouteTarget | null = null
  private lastSceneDevQueryKey = ''
  private running = false
  private navigating = false
  private mobileHud: MobileGameHud | null = null
  private profileUi: ProfileUiController | null = null
  private sceneContentUrl = 'https://peer.decentraland.org'
  private editorApp: EditorApp | null = null

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

    this.login = await showSplashScreen()
    recordLoginEvent(this.login)
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
      const ui = formatSceneLoadError(msg)
      loading.showFatalError(ui.title, ui.detail)
      clientDebugLog.log('client', `Failed to load scene: ${msg}`, { level: 'error' })
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
    const devQueryKey = readSceneDevQueryKey()
    if (
      this.currentRoute &&
      routeEquals(this.currentRoute, target) &&
      this.world &&
      devQueryKey === this.lastSceneDevQueryKey
    ) {
      return
    }

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
      const ui = formatSceneLoadError(msg)
      loading.showFatalError(ui.title, ui.detail)
      clientDebugLog.log('client', `Teleport failed: ${msg}`, { level: 'error' })
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

    if (!opts.fromHistory) {
      applyRouteToHistory(route, opts.replace ?? false)
    }
    this.currentRoute = route
    this.lastSceneDevQueryKey = readSceneDevQueryKey()

    await this.teardownScene()

    opts.onProgress?.('Resolving destination…')
    const sceneConfig = await resolveSceneFromRoute(route)
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
        onEventJumpIn: (target) => {
          this.settingsOverlay?.hide()
          void this.navigateTo(target)
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
        isWorldScene: sceneConfig.source.kind === 'world',
        worldName: sceneConfig.source.kind === 'world' ? sceneConfig.source.worldName : null,
        onOpen: () => {
          if (document.pointerLockElement) document.exitPointerLock()
          this.preferencesPanel?.hide()
          this.shell?.getButton('settings')?.setActive(false)
        },
        onClose: () => {}
      })
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

      const warmScene = await resolveSceneLoadWarm(getSessionAssetCache(), sceneConfig)
      const useFastBoot = opts.fastAssets ?? warmScene
      if (warmScene && !opts.fastAssets) {
        console.info('[client] warm scene cache — using fast boot timings')
      }
      const hydrationTimeoutMs = useFastBoot ? FAST_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
      opts.onHydrationStart?.(hydrationTimeoutMs)
      const hydrationResult = await world.waitForSceneAssets(sceneConfig, opts.onProgress, {
        timeoutMs: useFastBoot ? FAST_TIMEOUT_MS : undefined
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
      onGoto: (target) => this.navigateTo(target),
      onOpenProfile: (address) => this.profileUi?.openProfileForAddress(address)
    })
    this.shell.attachChatPanel(this.chatPanel, world.social)
    if (this.settingsOverlay) this.shell.attachSettingsOverlay(this.settingsOverlay)
    if (this.preferencesPanel) this.shell.attachPreferencesPanel(this.preferencesPanel)
    opts.onProgress?.('Almost ready…')
    this.shell.show()
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
    this.mobileHud.setShellVisible(true)
    this.shell.setOnEmoteWheelVisibility((visible) => this.mobileHud?.setEmoteActive(visible))

    const address = world.session.getAddress()
    const profile = world.session.getProfile()
    if (address && profile) {
      void fetchProfileFaceUrl(address, world.session.getLambdasUrl()).then((faceUrl) => {
        world.social.setLocalFaceUrl(faceUrl)
      })
    }

    return hydrationTimedOut
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
    this.editorApp?.dispose()
    this.editorApp = null
    this.profileUi?.dispose()
    this.profileUi = null
    this.mobileHud?.dispose()
    this.mobileHud = null
    this.worldLocationCard?.dispose()
    this.worldLocationCard = null
    this.chatPanel?.hide()
    await disconnectAll(this.world)
    this.world = null
    if (this.container) this.container.innerHTML = ''
  }

  async signOut(): Promise<void> {
    window.removeEventListener('popstate', this.onPopState)
    this.profileUi?.dispose()
    this.profileUi = null
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
    this.mobileHud?.dispose()
    this.mobileHud = null
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

function sceneDisplayTitle(scene: ResolvedScene): string {
  if (scene.source.kind === 'world') {
    const title = scene.title.trim()
    return title || scene.source.worldName
  }
  const title = scene.title.trim()
  return title || scene.baseParcel
}
