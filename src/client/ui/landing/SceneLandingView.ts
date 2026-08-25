import type { SceneLoadErrorMessage } from '../../formatSceneLoadError'
import type { LoginResult } from '../../../auth/AuthClient'
import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import type { RouteTarget, SceneLandingRoute } from '../../../dcl/content/route'
import { progressFromStatus } from '../loadingProgress'
import {
  formatEventCardTimeShort,
  isEventLiveNow,
  type DclEvent
} from '../../../social/dclEvents'
import {
  fetchSceneLandingMeta,
  fetchSceneRelatedEvents,
  sceneLandingKindLabel,
  type SceneLandingMeta
} from '../../../social/sceneLanding'
import {
  fetchSceneCompositeVideos,
  isPlayableLandingMediaUrl,
  sceneCompositeVideoLabel,
  type SceneCompositeVideo
} from '../../../social/sceneCompositeVideos'
import {
  isHttpsM3u8,
  listJoinLiveOptions,
  sceneStreamTargetFromRoute,
  type JoinLiveOption
} from '../../../social/sceneStreams'
import { EventModal } from '../events/EventModal'
import { SocialShellTopNav, type SocialShellChromeHandlers, type SocialShellTab } from '../explore/SocialShellTopNav'
import { isMobilePhone } from '../touchPlayLayout'
import { SceneStreamSettingsModal } from './SceneStreamSettingsModal'
import { SceneUsersModal } from './SceneUsersModal'
import { ScenePlaceStatsModal } from './ScenePlaceStatsModal'
import { dclMobileAppSchemeHref, openDclMobileApp } from './dclMobileAppJump'
import { isAnalyticsEnabled } from '../../../analytics/track'
import Hls from 'hls.js'
import { createBrowserHls, probeHttpsHlsPlaylist } from '../../../media/hlsFactory'

export type SceneLandingViewOptions = SocialShellChromeHandlers & {
  route: SceneLandingRoute
  login: LoginResult
  /**
   * Live session from AppController — preferred over a stale constructor copy so the
   * owner settings gear re-evaluates after wallet resume / profile sign-in.
   */
  getLogin?: () => LoginResult
  /** When false, CTA shows "Sign in" and must complete Guest/wallet before Jump in. */
  playSessionReady?: boolean
  onJumpIn: () => void
  onNavigate: (tab: SocialShellTab) => void
  onEventJumpIn?: (target: RouteTarget, event: DclEvent) => void
  onEventViewScene?: (target: RouteTarget, event: DclEvent) => void
  onOpenUserProfile?: (address: string) => void
  /**
   * Companion-style Cast 2.0: connect watcher room + attach video into host.
   * Returns cleanup. Required for “Join live → Cast”.
   */
  startCastWatch?: (
    host: HTMLElement,
    onUpdate?: (attached: boolean) => void,
    opts?: { muted?: boolean; volume?: number }
  ) => Promise<() => void>
  /**
   * Live tools (poll / Q&A / trivia) — same menu as in-world location card ⋯.
   * Anchor is the options button for menu positioning.
   */
  onLiveToolsMenu?: (anchor: HTMLElement) => void
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const JUMP_IN_PROGRESS_LERP = 0.12

/** Scene landing at `/<segment>` — companion `PublicSceneStreamPage` card layout (Phase 2). */
export class SceneLandingView {
  readonly root: HTMLElement

  private readonly route: SceneLandingViewOptions['route']
  private readonly onJumpIn: () => void
  private readonly onNavigate: (tab: SocialShellTab) => void
  private readonly getLoginLive: (() => LoginResult) | null
  private readonly onLiveToolsMenu: ((anchor: HTMLElement) => void) | null
  private readonly topNav: SocialShellTopNav
  private readonly mainEl: HTMLElement
  private readonly eventModal: EventModal
  private readonly sceneUsersModal: SceneUsersModal
  private readonly placeStatsModal: ScenePlaceStatsModal
  private meta: SceneLandingMeta | null = null
  private relatedEvents: DclEvent[] = []
  private disposed = false
  private jumpInLoading = false
  private playSessionReady = false
  private login: LoginResult
  private joinLiveOptions: JoinLiveOption[] = []
  /** VideoPlayers scraped from main.composite (custom m3u8/mp4, not LiveKit). */
  private sceneVideos: SceneCompositeVideo[] = []
  private joinLiveMenuOpen = false
  private targetProgress = 0
  private displayedProgress = 0
  private progressAnimFrame = 0
  private progressFillEl: HTMLElement | null = null
  private progressPctEl: HTMLElement | null = null
  private progressStatusEl: HTMLElement | null = null
  private pendingBan: SceneLoadErrorMessage | null = null
  private hlsPlayer: Hls | null = null
  private hlsLiveProbeTimer = 0
  private liveKitVideoCleanup: (() => void) | null = null
  private streamDocClickBound = false
  private settingsModal: SceneStreamSettingsModal | null = null
  /** Remote LiveKit video present (Cast/OBS stream keys) — from social chat scene room. */
  private castLive = false
  /** Companion streamPlaybackStarted — destination card swaps to full cast stage. */
  private streamWatchActive = false
  /**
   * What the cast stage is playing.
   * - `http` = composite/user m3u8·mp4 (must ignore LiveKit castLive=false)
   * - `cast` = LiveKit remote video (end watch only when cast actually drops)
   */
  private streamWatchKind: 'none' | 'cast' | 'http' = 'none'
  private castMuted = false
  private castVolume = 1
  /**
   * Jump in / Sign in hidden until LiveKit connects or scene.json disables browser chat
   * (or guest / terminal connect failure so the user is not stuck).
   */
  private jumpInUnlocked = false
  private readonly startCastWatch: SceneLandingViewOptions['startCastWatch']
  private readonly onDocClick = (ev: MouseEvent): void => {
    if (!this.joinLiveMenuOpen) return
    const t = ev.target
    if (!(t instanceof Node)) return
    if (this.root.querySelector('[data-join-live-root]')?.contains(t)) return
    this.setJoinLiveMenuOpen(false)
  }

  constructor(opts: SceneLandingViewOptions) {
    this.route = opts.route
    this.onJumpIn = opts.onJumpIn
    this.onNavigate = opts.onNavigate
    this.getLoginLive = opts.getLogin ?? null
    this.onLiveToolsMenu = opts.onLiveToolsMenu ?? null
    this.startCastWatch = opts.startCastWatch
    this.playSessionReady = opts.playSessionReady === true
    this.login = opts.getLogin?.() ?? opts.login

    this.topNav = new SocialShellTopNav({
      activeTab: null,
      login: this.login,
      onNavigate: opts.onNavigate,
      onLoginChange: opts.onLoginChange,
      onSignOut: opts.onSignOut,
      onOpenSettings: opts.onOpenSettings,
      onOpenBackpack: opts.onOpenBackpack,
      onEnter3D: opts.onEnter3D,
      onOpenProfile: opts.onOpenProfile,
      onOpenWhatsNew: opts.onOpenWhatsNew
    })

    this.eventModal = new EventModal({
      onJumpIn: opts.onEventJumpIn,
      onViewScene: opts.onEventViewScene
    })

    this.sceneUsersModal = new SceneUsersModal({
      onOpenProfile: opts.onOpenUserProfile
    })
    this.placeStatsModal = new ScenePlaceStatsModal()

    this.root = document.createElement('div')
    this.root.className = 'scene-landing-view'

    this.mainEl = document.createElement('main')
    this.mainEl.className = 'scene-landing-view__main'
    this.mainEl.dataset.main = ''
    this.mainEl.innerHTML = `
      <div class="scene-landing-view__loading" data-loading>
        <div class="scene-landing-view__spinner" aria-hidden></div>
        <p>Loading scene…</p>
      </div>
    `

    this.root.appendChild(this.topNav.el)
    this.root.appendChild(this.mainEl)
  }

  mount(container: HTMLElement): void {
    document.body.classList.add('scene-landing-route')
    container.innerHTML = ''
    container.appendChild(this.root)
    this.topNav.mount()
    this.eventModal.mount()
    this.sceneUsersModal.mount()
    this.placeStatsModal.mount()
    void this.load()
  }

  setLogin(login: LoginResult): void {
    this.login = login
    this.topNav.setLogin(login)
    // Companion: gear = session wallet ∈ ownerAddresses (re-check after sign-in).
    this.refreshStreamChrome()
  }

  /** Pull latest session from AppController (avoids stale guest copy after resume/sign-in). */
  syncLoginFromHost(): void {
    if (!this.getLoginLive) {
      this.refreshStreamChrome()
      return
    }
    const live = this.getLoginLive()
    this.login = live
    this.topNav.setLogin(live)
    this.refreshStreamChrome()
  }

  /** Update Jump in / Sign in CTA after auth panel or profile login. */
  setPlaySessionReady(ready: boolean): void {
    this.playSessionReady = ready
    this.syncJumpInLabel()
    this.syncJumpInVisibility()
    this.syncLoginFromHost()
  }

  /**
   * Unlock Jump in / Sign in after landing LiveKit is up, or scene.json blocks chat,
   * or connect finished as guest / non-recoverable without trapping the user.
   */
  setJumpInUnlocked(unlocked: boolean): void {
    this.jumpInUnlocked = unlocked
    this.syncJumpInVisibility()
  }

  /**
   * Cast/OBS live flag from LiveKit remote video tracks (wallet scene-room connection).
   * Updates LIVE badge + Join live menu.
   * Only tears down the watch stage for LiveKit cast sessions that lose video —
   * composite HLS / user m3u8 must not be killed by castLive=false polls.
   */
  setCastLive(live: boolean): void {
    const wasLive = this.castLive
    if (wasLive === live) {
      // Still refresh chrome — layout may have remounted while state was already true.
      this.syncLiveBadge()
      this.refreshJoinLiveOptions()
      return
    }
    this.castLive = live
    this.syncLiveBadge()
    this.refreshJoinLiveOptions()
    // true → false while watching LiveKit cast: stream ended.
    // Never apply to `http` scene-video watches (CBD Plaza custom m3u8, etc.).
    if (!live && wasLive && this.streamWatchActive && this.streamWatchKind === 'cast') {
      this.returnToSceneDetailsAfterStreamEnd()
    }
  }

  /** Stream ended — leave blank cast stage, show landing scene card again. */
  private returnToSceneDetailsAfterStreamEnd(): void {
    if (this.disposed) return
    this.forceExitStreamWatchMode()
    this.showStreamNotice('Live stream ended.')
  }

  /**
   * LiveKit room connected (chat pipeline). Kept for AppController call sites —
   * does **not** surface Join live (that requires castLive / remote video pubs).
   */
  setCastRoomReady(_ready: boolean): void {
    /* no-op: room-ready alone must not show Join live */
  }

  dispose(): void {
    this.disposed = true
    this.stopHlsLiveProbe()
    this.exitStreamWatchMode()
    this.teardownStreamPlayer()
    this.settingsModal?.dispose()
    this.settingsModal = null
    this.stopProgressAnimation()
    if (this.streamDocClickBound) {
      document.removeEventListener('click', this.onDocClick, true)
      this.streamDocClickBound = false
    }
    document.body.classList.remove(
      'scene-landing-route',
      'scene-landing-jump-in-loading',
      'scene-landing-stream-watch'
    )
    this.eventModal.dispose()
    this.sceneUsersModal.dispose()
    this.placeStatsModal.dispose()
    this.topNav.dispose()
    this.root.remove()
  }

  /** Reparent above #app so world canvas can mount while this overlay stays visible. */
  preserveDuringWorldLoad(): void {
    if (this.root.parentElement !== document.body) {
      document.body.appendChild(this.root)
    }
  }

  /** Jump in clicked — hide CTA, show top bar + percent (stay on scene card, no slideshow). */
  beginJumpInLoading(): void {
    if (this.disposed || this.jumpInLoading) return
    this.jumpInLoading = true
    document.body.classList.add('scene-landing-jump-in-loading')

    if (!this.root.querySelector('[data-load-progress]')) {
      const bar = document.createElement('div')
      bar.className = 'scene-landing-view__load-progress'
      bar.dataset.loadProgress = ''
      bar.setAttribute('aria-hidden', 'true')
      bar.innerHTML = `
        <div class="scene-landing-view__load-progress-track">
          <div class="scene-landing-view__load-progress-fill" data-load-progress-fill></div>
        </div>
      `
      this.root.prepend(bar)
    }

    const ctaRow = this.root.querySelector('.scene-watch-dest-scene-card-cta-row')
    if (ctaRow) {
      ctaRow.innerHTML = `
        <div class="scene-watch-dest-jump-in-loading" data-jump-in-loading>
          <span class="scene-watch-dest-jump-in-loading-pct" data-load-pct>0%</span>
          <span class="scene-watch-dest-jump-in-loading-status" data-load-status>Preparing your experience…</span>
        </div>
      `
    }

    this.progressFillEl = this.root.querySelector('[data-load-progress-fill]')
    this.progressPctEl = this.root.querySelector('[data-load-pct]')
    this.progressStatusEl = this.root.querySelector('[data-load-status]')

    this.targetProgress = 0.02
    this.displayedProgress = 0
    this.updateProgressUi()
    this.startProgressAnimation()
  }

  updateJumpInProgress(fraction: number | undefined, status?: string): void {
    if (this.disposed || !this.jumpInLoading) return
    if (typeof status === 'string' && status.trim()) {
      this.targetProgress = progressFromStatus(status, this.targetProgress)
      if (this.progressStatusEl) this.progressStatusEl.textContent = status
    }
    if (typeof fraction === 'number' && Number.isFinite(fraction)) {
      this.targetProgress = Math.max(this.targetProgress, Math.min(1, fraction))
    }
  }

  async completeJumpInLoading(): Promise<void> {
    if (this.disposed || !this.jumpInLoading) return
    this.targetProgress = 1
    await new Promise<void>((resolve) => {
      const wait = (): void => {
        if (this.disposed) {
          resolve()
          return
        }
        if (Math.abs(this.targetProgress - this.displayedProgress) < 0.008) {
          this.displayedProgress = 1
          this.updateProgressUi()
          resolve()
          return
        }
        requestAnimationFrame(wait)
      }
      wait()
    })
    await new Promise((r) => setTimeout(r, 280))
  }

  showJumpInError(title: string, detail: string): void {
    if (this.disposed) return
    this.stopProgressAnimation()
    const loadingPanel = this.root.querySelector('[data-jump-in-loading]') as HTMLElement | null
    if (loadingPanel) {
      loadingPanel.classList.add('scene-watch-dest-jump-in-loading--error')
      loadingPanel.innerHTML = `
        <span class="scene-watch-dest-jump-in-loading-pct scene-watch-dest-jump-in-loading-pct--error">${escapeHtml(title)}</span>
        <span class="scene-watch-dest-jump-in-loading-status">${escapeHtml(detail)}</span>
      `
    }
    this.root.querySelector('[data-load-progress]')?.classList.add('scene-landing-view__load-progress--error')
    document.body.classList.remove('scene-landing-jump-in-loading')
    this.jumpInLoading = false
  }

  /** Wallet banned or blacklisted — stop load and show scene-card ban panel. */
  showSceneBan(message: SceneLoadErrorMessage): void {
    if (this.disposed) return
    this.stopProgressAnimation()
    document.body.classList.remove('scene-landing-jump-in-loading')
    this.jumpInLoading = false
    this.root.querySelector('[data-load-progress]')?.remove()

    const ctaRow = this.root.querySelector('.scene-watch-dest-scene-card-cta-row')
    if (!ctaRow) {
      this.showJumpInError(message.title, message.detail)
      return
    }

    ctaRow.innerHTML = `
      <div class="scene-watch-dest-scene-ban" data-scene-ban role="alert" aria-live="assertive">
        <div class="scene-watch-dest-scene-ban-icon" aria-hidden>
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.75"/>
            <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
          </svg>
        </div>
        <p class="scene-watch-dest-scene-ban-title">${escapeHtml(message.title)}</p>
        <p class="scene-watch-dest-scene-ban-detail">${escapeHtml(message.detail)}</p>
      </div>
    `
  }

  /** Apply ban UI once the scene card layout is ready (e.g. mid-session boot from 3D). */
  setPendingBan(message: SceneLoadErrorMessage): void {
    if (this.disposed) return
    this.pendingBan = message
    if (this.root.querySelector('.scene-watch-dest-scene-card-cta-row')) {
      this.showSceneBan(message)
      this.pendingBan = null
    }
  }

  private startProgressAnimation(): void {
    this.stopProgressAnimation()
    const tick = (): void => {
      if (this.disposed || !this.jumpInLoading) return
      const delta = this.targetProgress - this.displayedProgress
      if (Math.abs(delta) > 0.001) {
        this.displayedProgress += delta * JUMP_IN_PROGRESS_LERP
      } else if (this.displayedProgress !== this.targetProgress) {
        this.displayedProgress = this.targetProgress
      }
      this.updateProgressUi()
      this.progressAnimFrame = requestAnimationFrame(tick)
    }
    this.progressAnimFrame = requestAnimationFrame(tick)
  }

  private stopProgressAnimation(): void {
    if (this.progressAnimFrame) {
      cancelAnimationFrame(this.progressAnimFrame)
      this.progressAnimFrame = 0
    }
  }

  private updateProgressUi(): void {
    const pct = Math.round(this.displayedProgress * 1000) / 10
    if (this.progressFillEl) this.progressFillEl.style.width = `${pct}%`
    if (this.progressPctEl) this.progressPctEl.textContent = `${Math.round(pct)}%`
    this.root.style.setProperty('--scene-landing-load-progress', String(this.displayedProgress))
  }

  private async load(): Promise<void> {
    const loadingEl = this.root.querySelector('[data-loading]') as HTMLElement
    loadingEl.hidden = false

    try {
      // Meta + composite VideoPlayers in parallel (composite is independent of Places API).
      const [meta, sceneVideos] = await Promise.all([
        fetchSceneLandingMeta(this.route),
        fetchSceneCompositeVideos(this.route)
      ])
      if (this.disposed) return
      this.meta = meta
      this.sceneVideos = sceneVideos
      // Seed options before first paint so JOIN LIVE is visible without a flash.
      this.refreshJoinLiveOptions()
      void this.probeSceneHlsLiveness()
      this.startHlsLiveProbe()
      loadingEl.remove()
      this.mainEl.innerHTML = this.renderLayout(this.meta)
      this.refreshJoinLiveOptions()
      if (this.pendingBan) {
        const ban = this.pendingBan
        this.pendingBan = null
        this.showSceneBan(ban)
      } else {
        this.bindJumpIn()
      }
      this.bindCrowdBadge()
      this.bindStreamChrome()
      // Meta + host session may both have arrived while we were loading.
      this.syncLoginFromHost()
      void this.hydrateOwnerAvatar()
      void this.loadRelatedEvents()
    } catch {
      if (this.disposed) return
      loadingEl.innerHTML =
        '<p class="scene-landing-view__error">Could not load this place. Try again from Explore.</p>'
    }
  }

  private streamTarget(): { pointer: string; kind: 'world' | 'parcel' } {
    if (this.route.kind === 'localpreview') {
      return { pointer: this.route.origin, kind: 'world' }
    }
    return sceneStreamTargetFromRoute(this.route)
  }

  private currentLogin(): LoginResult {
    if (this.getLoginLive) {
      try {
        return this.getLoginLive()
      } catch {
        /* fall through */
      }
    }
    return this.login
  }

  private sessionWallet(): string | null {
    const login = this.currentLogin()
    if (login.kind !== 'wallet') return null
    const a = login.address.trim().toLowerCase()
    return /^0x[a-f0-9]{40}$/.test(a) ? a : null
  }

  /**
   * Companion `canEditSceneCustomStream`:
   * wallet session && sessionAddress ∈ sceneProfile.ownerAddresses
   * (ownerAddresses filled at meta load from Places + marketplace NAME subgraph).
   */
  private isSceneOwner(): boolean {
    const wallet = this.sessionWallet()
    if (!wallet || !this.meta) return false
    const owners = this.meta.ownerAddresses?.length
      ? this.meta.ownerAddresses
      : this.meta.ownerAddress
        ? [this.meta.ownerAddress]
        : []
    return owners.some((o) => o.trim().toLowerCase() === wallet)
  }

  private refreshJoinLiveOptions(): void {
    const { pointer, kind } = this.streamTarget()
    const userOpts = listJoinLiveOptions(pointer, kind)
    const sceneOpts: JoinLiveOption[] = this.sceneVideos
      .filter((v) => this.sceneVideoIsJoinable(v))
      .map((v) => ({
        id: `scene-video:${v.entityId}`,
        label: sceneCompositeVideoLabel(v),
        kind: 'scene-video' as const,
        mediaUrl: v.mediaUrl,
        isHls: v.isHls,
        playing: v.playing,
        loop: v.loop,
        entityId: v.entityId
      }))
    // Order: LiveKit cast (if live) → composite scene screens → user listings.
    this.joinLiveOptions = []
    if (this.castLive) {
      this.joinLiveOptions.push({
        id: 'cast-livekit',
        label: 'LIVE · Cast',
        kind: 'cast-live'
      })
    }
    this.joinLiveOptions.push(...sceneOpts, ...userOpts)
    this.renderJoinLiveMenu()
    this.syncJoinLiveVisibility()
    this.syncLiveBadge()
  }

  /** HLS JOIN LIVE / LIVE badge only while the playlist is actually up. */
  private sceneVideoIsJoinable(v: SceneCompositeVideo): boolean {
    if (!v.isHls) return true
    return v.hlsLive === true
  }

  private startHlsLiveProbe(): void {
    this.stopHlsLiveProbe()
    if (this.sceneVideos.every((v) => !v.isHls)) return
    this.hlsLiveProbeTimer = window.setInterval(() => {
      void this.probeSceneHlsLiveness()
    }, 15_000)
  }

  private stopHlsLiveProbe(): void {
    if (this.hlsLiveProbeTimer) {
      window.clearInterval(this.hlsLiveProbeTimer)
      this.hlsLiveProbeTimer = 0
    }
  }

  private async probeSceneHlsLiveness(): Promise<void> {
    const hlsVideos = this.sceneVideos.filter((v) => v.isHls)
    if (hlsVideos.length === 0) return
    const results = await Promise.all(
      hlsVideos.map(async (v) => ({
        entityId: v.entityId,
        live: await probeHttpsHlsPlaylist(v.mediaUrl)
      }))
    )
    if (this.disposed) return
    let changed = false
    let watchingDied = false
    for (const row of results) {
      const v = this.sceneVideos.find((s) => s.entityId === row.entityId)
      if (!v || v.hlsLive === row.live) continue
      v.hlsLive = row.live
      changed = true
      if (
        !row.live &&
        this.streamWatchActive &&
        this.streamWatchKind === 'http' &&
        this.joinLiveOptions.some(
          (o) => o.kind === 'scene-video' && o.entityId === row.entityId
        )
      ) {
        watchingDied = true
      }
    }
    if (changed) this.refreshJoinLiveOptions()
    if (watchingDied) this.returnToSceneDetailsAfterStreamEnd()
  }

  /** True when LiveKit has remote video, or a composite HLS playlist is actually up. */
  private showLiveBadge(): boolean {
    if (this.castLive) return true
    return this.sceneVideos.some((v) => v.isHls && v.playing && v.hlsLive === true)
  }

  private syncLiveBadge(): void {
    const live = this.showLiveBadge()
    const visual = this.root.querySelector('.scene-watch-dest-scene-card-visual')
    if (visual) {
      let host = visual.querySelector('.scene-watch-dest-scene-card-visual-badges') as HTMLElement | null
      let badge = host?.querySelector('[data-cast-live-badge]') as HTMLElement | null
      if (live) {
        if (!host) {
          host = document.createElement('div')
          host.className = 'scene-watch-dest-scene-card-visual-badges'
          visual.appendChild(host)
        }
        if (!badge) {
          badge = document.createElement('span')
          badge.className = 'scene-watch-cast-live-badge'
          badge.dataset.castLiveBadge = ''
          badge.setAttribute('role', 'status')
          badge.textContent = 'LIVE'
          host.prepend(badge)
        }
        badge.hidden = false
      } else if (badge) {
        badge.remove()
        if (host && host.childElementCount === 0) host.remove()
      }
    }

    // Watch-mode scene pill Live badge
    const pillLive = this.root.querySelector(
      '[data-cast-stage] .scene-watch-dest-scene-pill-live'
    ) as HTMLElement | null
    const pillTitleRow = this.root.querySelector(
      '[data-cast-stage] .scene-watch-dest-scene-pill-title-row'
    )
    if (live) {
      if (!pillLive && pillTitleRow) {
        const el = document.createElement('span')
        el.className = 'scene-watch-dest-scene-pill-live'
        el.setAttribute('aria-label', 'Live now')
        el.textContent = 'Live'
        const title = pillTitleRow.querySelector('.scene-watch-dest-scene-pill-title')
        if (title?.nextSibling) pillTitleRow.insertBefore(el, title.nextSibling)
        else pillTitleRow.appendChild(el)
      } else if (pillLive) {
        pillLive.hidden = false
      }
    } else if (pillLive) {
      pillLive.remove()
    }
  }

  /** Companion scene-watch-dest-scene-pill above the cast video card. */
  private buildStreamWatchPillHtml(): string {
    const meta = this.meta
    const title = meta?.title?.trim() || 'Scene'
    const kindLabel = meta ? sceneLandingKindLabel(meta) : 'Place'
    const pointer = meta?.pointerLabel?.trim() || ''
    const userCount = meta?.userCount ?? 0
    const inWorldLabel = meta?.kind === 'world' ? 'in-world' : 'here'
    const live =
      this.showLiveBadge()
        ? `<span class="scene-watch-dest-scene-pill-live" aria-label="Live now">Live</span>`
        : ''
    const crowd =
      userCount > 0
        ? `<button type="button" class="scene-watch-dest-scene-pill-in-world" data-scene-crowd aria-label="${userCount} ${userCount === 1 ? 'user' : 'users'} ${inWorldLabel} — view list">${userCount} ${inWorldLabel}</button>`
        : ''
    const media = meta?.imageUrl
      ? `<img src="${escapeHtml(meta.imageUrl)}" alt="" loading="lazy" decoding="async" />`
      : `<div class="scene-watch-dest-scene-pill-media-fallback" aria-hidden></div>`
    return `
      <article class="scene-watch-dest-scene-pill" data-stream-watch-pill aria-label="Scene info">
        <div class="scene-watch-dest-scene-pill-inner">
          <div class="scene-watch-dest-scene-pill-media" aria-hidden>
            ${media}
          </div>
          <div class="scene-watch-dest-scene-pill-copy">
            <div class="scene-watch-dest-scene-pill-title-row">
              <h2 class="scene-watch-dest-scene-pill-title">${escapeHtml(title)}</h2>
              ${live}
              ${crowd}
            </div>
            <p class="scene-watch-dest-scene-pill-kicker">
              ${escapeHtml(kindLabel)}${pointer ? ` · <span>${escapeHtml(pointer)}</span>` : ''}
            </p>
          </div>
        </div>
      </article>
    `
  }

  /**
   * Apply Join live / owner settings visibility from current login + meta.
   * Safe to call before layout exists or before meta loads (no-ops missing nodes).
   */
  private refreshStreamChrome(): void {
    // Keep cached login aligned with host session before any membership test.
    if (this.getLoginLive) {
      try {
        this.login = this.getLoginLive()
      } catch {
        /* keep previous */
      }
    }
    this.syncOwnerSettingsVisibility()
    if (!this.meta) return
    this.refreshJoinLiveOptions()
  }

  private bindStreamChrome(): void {
    if (!this.streamDocClickBound) {
      document.addEventListener('click', this.onDocClick, true)
      this.streamDocClickBound = true
    }
    this.root.querySelector('[data-join-live-toggle]')?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.onJoinLiveToggleClick()
    })
    this.root.querySelector('[data-scene-settings]')?.addEventListener('click', () => {
      this.openSceneSettingsModal()
    })
    this.root.querySelector('[data-scene-stats]')?.addEventListener('click', () => {
      this.openPlaceStatsModal()
    })
    this.root.querySelector('[data-live-tools]')?.addEventListener('click', (e) => {
      e.stopPropagation()
      const btn = e.currentTarget as HTMLElement
      this.onLiveToolsMenu?.(btn)
    })
    this.syncOwnerSettingsVisibility()
    this.renderJoinLiveMenu()
    this.syncJoinLiveVisibility()
  }

  private openPlaceStatsModal(): void {
    if (this.route.kind === 'localpreview') return
    const title = this.meta?.title?.trim() || 'This place'
    const pointer = this.meta?.pointerLabel?.trim() || ''
    this.placeStatsModal.open(this.route, title, pointer)
  }

  /** One stream → play immediately; several → open dropdown. */
  private onJoinLiveToggleClick(): void {
    if (this.joinLiveOptions.length === 0) return
    if (this.joinLiveOptions.length === 1) {
      this.setJoinLiveMenuOpen(false)
      void this.startJoinLive(this.joinLiveOptions[0]!.id)
      return
    }
    this.setJoinLiveMenuOpen(!this.joinLiveMenuOpen)
  }

  private setJoinLiveMenuOpen(open: boolean): void {
    this.joinLiveMenuOpen = open
    const menu = this.root.querySelector('[data-join-live-menu]') as HTMLElement | null
    const btn = this.root.querySelector('[data-join-live-toggle]') as HTMLButtonElement | null
    const root = this.root.querySelector('[data-join-live-root]') as HTMLElement | null
    if (menu) {
      if (open && this.joinLiveOptions.length > 1) {
        menu.hidden = false
        menu.removeAttribute('hidden')
      } else {
        menu.hidden = true
        menu.setAttribute('hidden', '')
      }
    }
    if (btn) btn.setAttribute('aria-expanded', open && this.joinLiveOptions.length > 1 ? 'true' : 'false')
    root?.classList.toggle('scene-watch-join-live-split--open', open && this.joinLiveOptions.length > 1)
  }

  private syncJoinLiveVisibility(): void {
    const root = this.root.querySelector('[data-join-live-root]') as HTMLElement | null
    // Use same force-show path as owner gear (removeAttribute) — `hidden` prop alone can stick in some layouts.
    this.setControlVisible(root, this.joinLiveOptions.length > 0)
  }

  private setControlVisible(el: HTMLElement | null, show: boolean): void {
    if (!el) return
    if (show) {
      el.hidden = false
      el.removeAttribute('hidden')
      el.setAttribute('aria-hidden', 'false')
    } else {
      el.hidden = true
      el.setAttribute('hidden', '')
      el.setAttribute('aria-hidden', 'true')
    }
  }

  private syncOwnerSettingsVisibility(): void {
    const btn = this.root.querySelector('[data-scene-settings]') as HTMLButtonElement | null
    this.setControlVisible(btn, this.isSceneOwner())
  }

  private renderJoinLiveMenu(): void {
    const menu = this.root.querySelector('[data-join-live-menu]') as HTMLElement | null
    const btn = this.root.querySelector('[data-join-live-toggle]') as HTMLButtonElement | null
    const caret = this.root.querySelector('[data-join-live-caret]') as HTMLElement | null
    const multi = this.joinLiveOptions.length > 1
    const sole = this.joinLiveOptions.length === 1 ? this.joinLiveOptions[0] : null

    if (btn) {
      const labelEl = btn.querySelector('[data-join-live-label]')
      const labelText = sole
        ? sole.kind === 'cast-live'
          ? 'LIVE · CAST'
          : sole.kind === 'scene-video'
            ? sole.isHls
              ? 'JOIN LIVE'
              : 'WATCH'
            : sole.label.replace(/^Live:\s*/i, '').toUpperCase().slice(0, 18)
        : 'JOIN LIVE'
      if (labelEl) labelEl.textContent = labelText
      else {
        // Fallback if template missing label span
        const caretHtml = caret?.outerHTML ?? ''
        btn.innerHTML = `<span data-join-live-label>${escapeHtml(labelText)}</span>${multi ? caretHtml || '<span class="scene-watch-join-live-caret-glyph" data-join-live-caret aria-hidden>▾</span>' : ''}`
      }
      btn.classList.toggle('scene-watch-join-live-caret-in-btn--single', !multi)
      btn.setAttribute('aria-haspopup', multi ? 'menu' : 'false')
      btn.title = sole
        ? sole.kind === 'cast-live'
          ? 'Watch Cast / LiveKit stream'
          : sole.kind === 'scene-video'
            ? sole.isHls
              ? 'Watch scene HLS stream'
              : 'Watch scene video'
            : sole.label
        : 'Choose a live stream'
    }
    if (caret) caret.hidden = !multi

    if (!menu) return
    // Keep menu closed unless multi-select and user opened it
    if (!multi || !this.joinLiveMenuOpen) {
      menu.hidden = true
      menu.setAttribute('hidden', '')
      menu.innerHTML = ''
      return
    }
    menu.hidden = false
    menu.removeAttribute('hidden')
    menu.innerHTML = this.joinLiveOptions
      .map((opt) => {
        const cast =
          opt.kind === 'user' && opt.stream.source === 'cast'
            ? ' data-cast="1"'
            : opt.kind === 'cast-live'
              ? ' data-cast="1"'
              : ''
        return `<button type="button" role="menuitem" class="scene-watch-join-live-split-menu-item" data-join-live-id="${escapeHtml(opt.id)}"${cast}>${escapeHtml(opt.label)}</button>`
      })
      .join('')
    menu.querySelectorAll<HTMLButtonElement>('[data-join-live-id]').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation()
        const id = item.dataset.joinLiveId
        if (!id) return
        this.setJoinLiveMenuOpen(false)
        void this.startJoinLive(id)
      })
    })
  }

  private async startJoinLive(optionId: string): Promise<void> {
    const opt = this.joinLiveOptions.find((o) => o.id === optionId)
    if (!opt) return
    if (opt.kind === 'cast-live') {
      if (!this.castLive) {
        this.showStreamNotice('No live stream right now — wait for OBS / stream keys to go live.')
        this.refreshJoinLiveOptions()
        return
      }
      this.openLiveKitCastPlayer(opt.label)
      return
    }
    if (opt.kind === 'user' && opt.stream.source === 'cast') {
      if (this.castLive) {
        this.openLiveKitCastPlayer(`Live: ${opt.stream.displayName}`)
        return
      }
      this.showStreamNotice(
        `Cast listing “${opt.stream.displayName}” — no LiveKit video yet. Wait for the stream, or Jump in to the world.`
      )
      return
    }
    if (opt.kind === 'scene-video') {
      if (!isPlayableLandingMediaUrl(opt.mediaUrl)) {
        this.showStreamNotice('Scene video URL is not playable in the browser.')
        return
      }
      this.openStreamPlayer(opt.mediaUrl, opt.label, { loop: opt.loop })
      return
    }
    const url =
      opt.kind === 'custom'
        ? opt.m3u8Url
        : opt.kind === 'user'
          ? opt.stream.m3u8Url
          : null
    if (!url || !isHttpsM3u8(url)) {
      this.showStreamNotice('This listing has no playable HTTPS .m3u8 URL.')
      return
    }
    this.openStreamPlayer(url, opt.label)
  }

  private showStreamNotice(message: string): void {
    const existing = this.root.querySelector('[data-stream-notice]')
    existing?.remove()
    const el = document.createElement('div')
    el.className = 'scene-watch-stream-notice'
    el.dataset.streamNotice = ''
    el.setAttribute('role', 'status')
    el.textContent = message
    this.root.querySelector('.scene-watch-dest-scene-card-body')?.appendChild(el)
    window.setTimeout(() => el.remove(), 6000)
  }

  private stopCastMediaElements(root: ParentNode | null = this.root): void {
    root?.querySelectorAll('video, audio').forEach((node) => {
      const media = node as HTMLMediaElement
      try {
        media.pause()
        media.muted = true
        media.volume = 0
        media.removeAttribute('src')
        media.srcObject = null
        media.load()
      } catch {
        /* ignore */
      }
    })
  }

  private teardownStreamPlayer(): void {
    // Stop playback before unmount so audio cannot keep running after leave.
    this.stopCastMediaElements(this.root.querySelector('[data-cast-stage]'))
    this.stopCastMediaElements(this.root.querySelector('[data-stream-player]'))
    if (this.hlsPlayer) {
      this.hlsPlayer.destroy()
      this.hlsPlayer = null
    }
    this.liveKitVideoCleanup?.()
    this.liveKitVideoCleanup = null
    this.root.querySelector('[data-stream-player]')?.remove()
    this.root.querySelector('[data-cast-stage]')?.remove()
  }

  /** Full leave of video mode (stop media). Close-button uses handleCastCloseClick instead. */
  private exitStreamWatchMode(): void {
    this.forceExitStreamWatchMode()
  }

  private isCastFullscreen(): boolean {
    const doc = document as Document & { webkitFullscreenElement?: Element | null }
    const active = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null
    if (!active) return false
    const card = this.root.querySelector('.scene-watch-cast-stage__card')
    return Boolean(card && (active === card || card.contains(active) || active.contains(card)))
  }

  private async exitCastFullscreenOnly(): Promise<void> {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null
      webkitExitFullscreen?: () => Promise<void>
    }
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else if (doc.webkitFullscreenElement) await doc.webkitExitFullscreen?.()
    } catch (e) {
      console.warn('[cast] exit fullscreen failed', e)
    }
    this.syncCastFullscreenButton()
  }

  private syncCastFullscreenButton(): void {
    const fsBtn = this.root.querySelector('[data-cast-fs]') as HTMLButtonElement | null
    const closeBtn = this.root.querySelector('[data-cast-close]') as HTMLButtonElement | null
    const isFs = this.isCastFullscreen()
    if (fsBtn) {
      fsBtn.setAttribute('aria-label', isFs ? 'Exit fullscreen' : 'Fullscreen')
      fsBtn.title = isFs ? 'Exit fullscreen' : 'Fullscreen'
    }
    // While fullscreen, X exits FS only (stays in video mode). Outside FS, X stops watch.
    if (closeBtn) {
      closeBtn.setAttribute(
        'aria-label',
        isFs ? 'Exit fullscreen' : 'Close video'
      )
      closeBtn.title = isFs ? 'Exit fullscreen' : 'Close video'
    }
  }

  private readonly onCastFullscreenChange = (): void => {
    if (!this.streamWatchActive) return
    this.syncCastFullscreenButton()
  }

  /**
   * Companion streamPlaybackStarted layout: replace destination card chrome with Cast stage.
   * Scene info pill sits above the video card (companion scene-watch-dest-scene-pill).
   * @param kind `http` = m3u8/mp4 player; `cast` = LiveKit remote video
   */
  private enterStreamWatchMode(title: string, kind: 'cast' | 'http'): HTMLElement | null {
    this.teardownStreamPlayer()
    this.streamWatchActive = true
    this.streamWatchKind = kind
    document.body.classList.add('scene-landing-stream-watch')
    this.root.classList.add('scene-landing-view--stream-watch')
    document.removeEventListener('fullscreenchange', this.onCastFullscreenChange)
    document.removeEventListener('webkitfullscreenchange', this.onCastFullscreenChange as EventListener)
    document.addEventListener('fullscreenchange', this.onCastFullscreenChange)
    document.addEventListener('webkitfullscreenchange', this.onCastFullscreenChange as EventListener)

    const dest = this.root.querySelector('[data-dest-chrome]') as HTMLElement | null
    if (dest) dest.hidden = true

    const shell = this.root.querySelector('.scene-watch-dest-v2-shell') ?? this.mainEl
    const stage = document.createElement('div')
    stage.className = 'scene-watch-cast-stage'
    stage.dataset.castStage = ''
    stage.innerHTML = `
      ${this.buildStreamWatchPillHtml()}
      <div class="scene-watch-cast-stage__card">
        <div class="scene-watch-cast-stage__toolbar">
          <div class="scene-watch-cast-stage__toolbar-left">
            <button type="button" class="scene-watch-cast-stage__icon-btn" data-cast-mute aria-label="Mute" title="Mute" aria-pressed="false">
              <span data-cast-mute-icon aria-hidden></span>
            </button>
            <label class="scene-watch-cast-stage__vol">
              <span>Vol</span>
              <input type="range" min="0" max="100" value="100" data-cast-volume aria-label="Volume" />
            </label>
            <span class="scene-watch-cast-stage__title">${escapeHtml(title)}</span>
          </div>
          <div class="scene-watch-cast-stage__toolbar-right">
            <button type="button" class="scene-watch-cast-stage__icon-btn" data-cast-fs aria-label="Fullscreen" title="Fullscreen">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
                <path d="M8 3H5a2 2 0 0 0-2 2v3"/>
                <path d="M21 8V5a2 2 0 0 0-2-2h-3"/>
                <path d="M3 16v3a2 2 0 0 0 2 2h3"/>
                <path d="M16 21h3a2 2 0 0 0 2-2v-3"/>
              </svg>
            </button>
            <button type="button" class="scene-watch-cast-stage__icon-btn scene-watch-cast-stage__close" data-cast-close aria-label="Close video" title="Close video">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden>
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="scene-watch-cast-stage__player" data-cast-video-host>
          <div class="scene-watch-cast-stage__waiting" data-cast-waiting>Connecting to Cast…</div>
        </div>
        <p class="scene-watch-cast-stage__hint" data-cast-hint hidden></p>
      </div>
    `
    shell.appendChild(stage)

    const pill = stage.querySelector('[data-stream-watch-pill]') as HTMLElement | null
    if (pill && this.meta?.imageUrl) {
      const url = this.meta.imageUrl
      pill.style.backgroundImage =
        `linear-gradient(90deg, rgba(12, 8, 20, 0.92) 0%, rgba(12, 8, 20, 0.78) 55%, rgba(12, 8, 20, 0.55) 100%), url(${JSON.stringify(url)})`
    }
    pill?.querySelector('[data-scene-crowd]')?.addEventListener('click', () => {
      if (!this.meta || this.meta.userCount <= 0) return
      if (this.route.kind === 'localpreview') return
      this.sceneUsersModal.open(this.route, this.meta.title, this.meta.userCount)
    })

    const card = stage.querySelector('.scene-watch-cast-stage__card') as HTMLElement
    stage.querySelector('[data-cast-close]')?.addEventListener('click', () => {
      // Fullscreen: leave FS only → stay in video mode.
      // Inline video: leave watch mode and hard-stop media.
      void this.handleCastCloseClick()
    })
    stage.querySelector('[data-cast-fs]')?.addEventListener('click', () => {
      void this.toggleCastFullscreen(card)
    })
    stage.querySelector('[data-cast-mute]')?.addEventListener('click', () => {
      this.toggleCastMute()
    })
    stage.querySelector('[data-cast-volume]')?.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement
      this.castVolume = Math.min(1, Math.max(0, Number(t.value) / 100))
      if (this.castVolume > 0) this.castMuted = false
      else this.castMuted = true
      this.applyCastAudioToHost()
      this.syncCastMuteUi()
    })

    this.syncCastMuteUi()
    this.syncCastFullscreenButton()
    return stage.querySelector('[data-cast-video-host]') as HTMLElement
  }

  /** Volume / speaker button — toggle mute on the cast video (mobile + desktop). */
  private toggleCastMute(): void {
    this.castMuted = !this.castMuted
    if (!this.castMuted && this.castVolume <= 0) this.castVolume = 1
    this.applyCastAudioToHost()
    this.syncCastMuteUi()
  }

  private syncCastMuteUi(): void {
    const stage = this.root.querySelector('[data-cast-stage]')
    if (!stage) return
    const btn = stage.querySelector('[data-cast-mute]') as HTMLButtonElement | null
    const icon = stage.querySelector('[data-cast-mute-icon]') as HTMLElement | null
    const slider = stage.querySelector('[data-cast-volume]') as HTMLInputElement | null
    if (btn) {
      btn.setAttribute('aria-label', this.castMuted ? 'Unmute' : 'Mute')
      btn.title = this.castMuted ? 'Unmute' : 'Mute'
      btn.setAttribute('aria-pressed', this.castMuted ? 'true' : 'false')
      btn.classList.toggle('is-muted', this.castMuted)
    }
    if (icon) {
      icon.innerHTML = this.castMuted
        ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
          </svg>`
        : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
          </svg>`
    }
    if (slider) {
      slider.value = String(Math.round((this.castMuted ? 0 : this.castVolume) * 100))
    }
  }

  private async handleCastCloseClick(): Promise<void> {
    if (this.isCastFullscreen()) {
      await this.exitCastFullscreenOnly()
      return
    }
    this.forceExitStreamWatchMode()
  }

  /** Leave watch mode and stop video/audio (used by close when not fullscreen). */
  private forceExitStreamWatchMode(): void {
    this.streamWatchActive = false
    this.streamWatchKind = 'none'
    document.body.classList.remove('scene-landing-stream-watch')
    this.root.classList.remove('scene-landing-view--stream-watch')
    document.removeEventListener('fullscreenchange', this.onCastFullscreenChange)
    document.removeEventListener('webkitfullscreenchange', this.onCastFullscreenChange as EventListener)
    // Drop FS if still active so we don't leave a bare fullscreen shell.
    if (this.isCastFullscreen()) {
      void this.exitCastFullscreenOnly()
    }
    this.teardownStreamPlayer()
    const dest = this.root.querySelector('[data-dest-chrome]') as HTMLElement | null
    if (dest) dest.hidden = false
  }

  private async toggleCastFullscreen(card: HTMLElement): Promise<void> {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null
      webkitExitFullscreen?: () => Promise<void>
    }
    const el = card as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }
    const active = document.fullscreenElement ?? doc.webkitFullscreenElement
    try {
      if (active) {
        if (document.exitFullscreen) await document.exitFullscreen()
        else await doc.webkitExitFullscreen?.()
      } else if (el.requestFullscreen) {
        await el.requestFullscreen()
      } else {
        await el.webkitRequestFullscreen?.()
      }
    } catch (e) {
      console.warn('[cast] fullscreen failed', e)
    }
    this.syncCastFullscreenButton()
  }

  private applyCastAudioToHost(): void {
    const host = this.root.querySelector('[data-cast-video-host]')
    host?.querySelectorAll('video, audio').forEach((node) => {
      const media = node as HTMLMediaElement
      media.muted = this.castMuted
      media.volume = this.castMuted ? 0 : this.castVolume
      // User gesture (mute / volume) unlocks audio after autoplay policies or late LiveKit attach.
      if (!this.castMuted) {
        void media.play().catch(() => {})
      }
    })
  }

  private openLiveKitCastPlayer(title: string): void {
    if (!this.startCastWatch) {
      this.showStreamNotice('Cast watch is not available on this session.')
      return
    }
    const host = this.enterStreamWatchMode(title, 'cast')
    if (!host) return
    const waiting = this.root.querySelector('[data-cast-waiting]') as HTMLElement | null
    const hint = this.root.querySelector('[data-cast-hint]') as HTMLElement | null
    if (waiting) {
      waiting.hidden = false
      waiting.textContent = 'Joining scene LiveKit (stream keys)…'
    }

    /** True after we successfully showed video once — detach → end stream, not pre-join noise. */
    let hadVideo = false
    let endGuardTimer = 0

    void this.startCastWatch(
      host,
      (attached) => {
        if (!this.streamWatchActive || this.disposed) return
        if (attached) {
          hadVideo = true
          if (endGuardTimer) {
            window.clearTimeout(endGuardTimer)
            endGuardTimer = 0
          }
          if (waiting) waiting.hidden = true
          if (hint) hint.hidden = true
          // Re-apply UI mute after LiveKit attach (initial attach may use snapshot opts).
          this.applyCastAudioToHost()
          this.syncCastMuteUi()
          this.setCastLive(true)
          return
        }
        if (waiting) waiting.hidden = false
        // Lost video after it was live — debounce brief track swaps, then back to details.
        if (hadVideo && this.streamWatchActive) {
          if (endGuardTimer) window.clearTimeout(endGuardTimer)
          endGuardTimer = window.setTimeout(() => {
            endGuardTimer = 0
            if (this.disposed || !this.streamWatchActive || !hadVideo) return
            if (host.querySelector('video')) return
            // setCastLive(false) restores scene details when streamWatchActive.
            this.setCastLive(false)
          }, 1200)
        }
      },
      { muted: this.castMuted, volume: this.castVolume }
    ).then((cleanup) => {
      if (this.disposed || !this.streamWatchActive) {
        cleanup()
        return
      }
      this.liveKitVideoCleanup = () => {
        if (endGuardTimer) {
          window.clearTimeout(endGuardTimer)
          endGuardTimer = 0
        }
        cleanup()
      }
    }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e)
      if (waiting) waiting.hidden = true
      if (hint) {
        hint.hidden = false
        hint.textContent = msg
      }
      console.warn('[cast] startCastWatch failed', msg)
    })

    let waitTicks = 0
    const waitTimer = window.setInterval(() => {
      if (this.disposed || !this.streamWatchActive) {
        window.clearInterval(waitTimer)
        return
      }
      if (host.querySelector('video')) {
        window.clearInterval(waitTimer)
        hadVideo = true
        if (waiting) waiting.hidden = true
        if (hint) hint.hidden = true
        return
      }
      waitTicks += 1
      if (waiting) {
        waiting.textContent =
          waitTicks < 4
            ? 'Waiting for OBS video in scene room…'
            : 'No remote publisher yet — re-mint stream key & restart OBS'
      }
      if (waitTicks >= 5 && hint) {
        hint.hidden = false
        hint.textContent =
          'Stream keys go to the scene LiveKit room (not Cast 2.0). If console shows remotes=0, OBS is not in this room — Get stream access again on this world, paste into OBS, go live, then Join live.'
      }
    }, 1500)
  }

  private openStreamPlayer(
    mediaUrl: string,
    title: string,
    options?: { loop?: boolean }
  ): void {
    const host = this.enterStreamWatchMode(title, 'http')
    if (!host) return
    const waiting = this.root.querySelector('[data-cast-waiting]') as HTMLElement | null
    const hint = this.root.querySelector('[data-cast-hint]') as HTMLElement | null
    const video = document.createElement('video')
    video.className = 'scene-watch-cast-stage__video'
    video.controls = false
    video.playsInline = true
    video.autoplay = true
    // Parity with WebVideoPlayer / ECS VideoPlayer.loop (e.g. gather.dcl.eth theatre).
    video.loop = options?.loop === true
    video.muted = this.castMuted
    video.volume = this.castMuted ? 0 : this.castVolume
    host.replaceChildren(video)
    if (waiting) waiting.hidden = true
    this.syncCastMuteUi()

    const isHls = isHttpsM3u8(mediaUrl)
    if (isHls && Hls.isSupported()) {
      const hls = createBrowserHls()
      this.hlsPlayer = hls
      hls.loadSource(mediaUrl)
      hls.attachMedia(video)
      let mediaErrorRecoveries = 0
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaErrorRecoveries < 3) {
          mediaErrorRecoveries += 1
          try {
            hls.recoverMediaError()
            void video.play().catch(() => {})
            return
          } catch {
            /* fall through */
          }
        }
        const httpCode = data.response?.code
        if (
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          httpCode !== 404 &&
          httpCode !== 410
        ) {
          try {
            hls.startLoad(-1)
            return
          } catch {
            /* fall through */
          }
        }
        const watching = this.sceneVideos.find(
          (v) => v.isHls && v.mediaUrl === mediaUrl
        )
        if (watching) watching.hlsLive = false
        this.refreshJoinLiveOptions()
        if (this.castLive) {
          this.openLiveKitCastPlayer('LIVE · Cast')
          return
        }
        this.returnToSceneDetailsAfterStreamEnd()
      })
      // HLS VOD may still fire `ended` even with loop=true; restart for ECS parity.
      if (options?.loop === true) {
        video.addEventListener('ended', () => {
          if (!video.loop || this.disposed || !this.streamWatchActive) return
          try {
            video.currentTime = 0
          } catch {
            /* ignore seek failures on non-seekable media */
          }
          void video.play().catch(() => {})
        })
      }
    } else if (isHls && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = mediaUrl
    } else if (isHls) {
      if (hint) {
        hint.hidden = false
        hint.textContent = 'HLS playback is not supported in this browser.'
      }
    } else {
      // Progressive scene media (mp4/webm) from composite VideoPlayer.src
      video.src = mediaUrl
      video.addEventListener(
        'error',
        () => {
          if (hint) {
            hint.hidden = false
            hint.textContent = 'Could not play this scene video (network or codec error).'
          }
        },
        { once: true }
      )
    }
    void video.play().catch(() => {})
    this.applyCastAudioToHost()
  }

  private openSceneSettingsModal(): void {
    if (!this.isSceneOwner()) return
    const login = this.currentLogin()
    if (login.kind !== 'wallet') {
      this.showStreamNotice('Sign in with a wallet to manage this place.')
      return
    }
    const wallet = this.sessionWallet()
    if (!wallet) return
    this.teardownStreamPlayer()
    this.settingsModal?.dispose()
    if (this.route.kind === 'localpreview') return
    const { pointer, kind } = this.streamTarget()
    this.settingsModal = new SceneStreamSettingsModal({
      route: this.route,
      pointer,
      kind,
      wallet,
      identity: login.identity,
      onChanged: () => this.refreshStreamChrome(),
      onClose: () => {
        this.settingsModal = null
      }
    })
    this.settingsModal.mount(this.root)
  }

  private bindJumpIn(): void {
    this.syncJumpInLabel()
    this.syncJumpInVisibility()
    this.syncMobileAppCta()
    this.root.querySelector('[data-jump-in]')?.addEventListener('click', () => {
      if (this.jumpInLoading || !this.jumpInUnlocked) return
      this.onJumpIn()
    })
    this.root.querySelector('[data-mobile-app]')?.addEventListener('click', (ev) => {
      if (this.jumpInLoading) return
      ev.preventDefault()
      openDclMobileApp(this.route)
    })
  }

  private syncMobileAppCta(): void {
    const btn = this.root.querySelector('[data-mobile-app]') as HTMLAnchorElement | null
    const href = dclMobileAppSchemeHref(this.route)
    const show = Boolean(href) && isMobilePhone()
    if (btn && href) btn.href = href
    this.setControlVisible(btn, show)
  }

  private syncJumpInLabel(): void {
    const label = this.root.querySelector('.scene-watch-dest-jump-in-bar-label')
    if (label) label.textContent = this.playSessionReady ? 'Jump in' : 'Sign in'
    const btn = this.root.querySelector('[data-jump-in]') as HTMLButtonElement | null
    if (btn) {
      btn.setAttribute('aria-label', this.playSessionReady ? 'Jump in' : 'Sign in to jump in')
      btn.title = this.playSessionReady
        ? 'Enter the scene'
        : 'Sign in with wallet or continue as guest to enter'
    }
  }

  private syncJumpInVisibility(): void {
    const btn = this.root.querySelector('[data-jump-in]') as HTMLButtonElement | null
    this.setControlVisible(btn, this.jumpInUnlocked)
  }

  private bindCrowdBadge(): void {
    this.root.querySelector('[data-scene-crowd]')?.addEventListener('click', () => {
      if (!this.meta || this.meta.userCount <= 0) return
      if (this.route.kind === 'localpreview') return
      this.sceneUsersModal.open(this.route, this.meta.title, this.meta.userCount)
    })
  }

  private async loadRelatedEvents(): Promise<void> {
    const bannerEl = this.root.querySelector('[data-events-banner]') as HTMLElement | null
    if (!bannerEl || !this.meta) return
    if (this.route.kind === 'localpreview') {
      bannerEl.innerHTML = this.renderEventsBannerInner([], false)
      return
    }

    try {
      const events = await fetchSceneRelatedEvents(this.route)
      if (this.disposed) return
      this.relatedEvents = events
      bannerEl.innerHTML = this.renderEventsBannerInner(events, false)
      this.bindEventsBanner()
    } catch {
      if (this.disposed) return
      bannerEl.innerHTML = this.renderEventsBannerInner([], false)
    }
  }

  private bindEventsBanner(): void {
    this.root.querySelector('[data-see-more-events]')?.addEventListener('click', () => this.onNavigate('events'))

    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-event-link]')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.eventId?.trim()
        const ev = this.relatedEvents.find((e) => e.id === id)
        if (ev) this.eventModal.open(ev)
      })
    }
  }

  private eventsBannerStyleAttr(meta: SceneLandingMeta): string {
    if (!meta.imageUrl) return ''
    const bg = `linear-gradient(105deg, rgba(6, 4, 14, 0.92) 0%, rgba(6, 4, 14, 0.78) 42%, rgba(6, 4, 14, 0.55) 100%), url(${meta.imageUrl})`
    return ` style="background-image: ${escapeHtml(bg)}"`
  }

  private renderEventsBannerInner(events: DclEvent[], loading: boolean): string {
    let copy = ''
    if (loading) {
      copy = `
        <p class="scene-watch-dest-events-banner-loading" aria-busy="true">
          <span class="scene-watch-dest-events-banner-spinner" aria-hidden></span>
          Loading events for this place…
        </p>
      `
    } else if (events.length === 0) {
      copy =
        '<p class="scene-watch-dest-events-banner-text">No events scheduled yet… Be the first to host something epic!</p>'
    } else {
      const list = events
        .slice(0, 5)
        .map((ev) => {
          const name = escapeHtml(ev.name?.trim() || 'Untitled event')
          const nameCell = ev.id.trim()
            ? `<button type="button" class="scene-watch-dest-events-banner-li-action" data-event-link data-event-id="${escapeHtml(ev.id)}">${name}</button>`
            : `<span>${name}</span>`
          const startAt = ev.next_start_at?.trim() || ev.start_at?.trim() || ''
          const metaLabel = isEventLiveNow(ev)
            ? '<span class="scene-watch-dest-events-banner-li-meta"> · Live</span>'
            : startAt
              ? `<span class="scene-watch-dest-events-banner-li-meta"> · ${escapeHtml(formatEventCardTimeShort(startAt))}</span>`
              : ''
          return `<li>${nameCell}${metaLabel}</li>`
        })
        .join('')
      copy = `
        <p class="scene-watch-dest-events-banner-text scene-watch-dest-events-banner-text--compact">
          ${events.length} event${events.length === 1 ? '' : 's'} linked to this place.
        </p>
        <ul class="scene-watch-dest-events-banner-list">${list}</ul>
      `
    }

    return `
      <div class="scene-watch-dest-events-banner-inner">
        <div class="scene-watch-dest-events-banner-copy">
          <h3 class="scene-watch-dest-events-banner-title">Upcoming events</h3>
          ${copy}
        </div>
        <button type="button" class="scene-watch-dest-events-banner-cta" data-see-more-events>
          See more events
        </button>
      </div>
    `
  }

  private async hydrateOwnerAvatar(): Promise<void> {
    const owner = this.meta?.ownerAddress
    if (!owner) return
    const avatar = this.root.querySelector<HTMLElement>('[data-owner-avatar]')
    if (!avatar) return
    const faceUrl = await fetchProfileFaceUrl(owner)
    if (this.disposed) return
    if (faceUrl) {
      avatar.innerHTML = `<img src="${escapeHtml(faceUrl)}" alt="" loading="lazy" />`
    }
  }

  private renderLayout(meta: SceneLandingMeta): string {
    const kindLabel = sceneLandingKindLabel(meta)
    const creatorLabel =
      meta.kind === 'localpreview'
        ? 'Preview server'
        : meta.kind === 'world'
          ? meta.customServer?.trim()
            ? 'Custom realm'
            : 'World owner'
          : 'Creator'
    const inWorldLabel = meta.kind === 'world' ? 'in world' : 'here'
    const liveBadge = this.showLiveBadge()
      ? `<span class="scene-watch-cast-live-badge" data-cast-live-badge role="status">LIVE</span>`
      : ''
    const crowdBadge =
      meta.userCount > 0
        ? `<button type="button" class="scene-watch-dest-scene-card-in-world" data-scene-crowd aria-label="${meta.userCount} people ${inWorldLabel} — view list">${meta.userCount} ${inWorldLabel}</button>`
        : ''
    const categories = meta.categories
      .slice(0, 4)
      .map(
        (c) =>
          `<span class="scene-watch-dest-scene-card-badge">${escapeHtml(c.replace(/_/g, ' '))}</span>`
      )
      .join('')
    const desc =
      meta.description.trim().length > 0
        ? `<p class="scene-watch-dest-scene-card-desc">${escapeHtml(meta.description)}</p>`
        : ''
    const ownerInitial = meta.ownerDisplayName.trim().charAt(0).toUpperCase() || '?'

    return `
      <div class="scene-watch-root scene-watch-root--gradient scene-watch-root--social scene-watch-root--embedded-app">
        <div class="scene-watch-embedded-in-companion">
          <div class="scene-watch-main-with-companion-dock__primary">
            <div class="scene-watch-dest-v2-vert">
              <div class="scene-watch-dest-v2">
                <div class="scene-watch-dest-v2-center-track">
                  <div class="scene-watch-dest-v2-shell">
                    <div class="scene-watch-dest-v2-main">
                      <div data-dest-chrome>
                      <article class="scene-watch-dest-scene-card">
                        <div class="scene-watch-dest-scene-card-visual">
                          ${
                            meta.imageUrl
                              ? `<img src="${escapeHtml(meta.imageUrl)}" alt="" loading="lazy" decoding="async" />`
                              : '<div class="scene-watch-dest-scene-card-visual-fallback" aria-hidden></div>'
                          }
                          ${
                            liveBadge || crowdBadge
                              ? `<div class="scene-watch-dest-scene-card-visual-badges">${liveBadge}${crowdBadge}</div>`
                              : ''
                          }
                        </div>
                        <div class="scene-watch-dest-scene-card-body">
                          <div class="scene-watch-dest-scene-card-head">
                            <h1 class="scene-watch-dest-scene-card-title">${escapeHtml(meta.title)}</h1>
                            <div class="scene-watch-dest-scene-card-head-actions">
                              ${
                                isAnalyticsEnabled()
                                  ? `<button
                                type="button"
                                class="scene-watch-scene-stats-btn"
                                data-scene-stats
                                aria-label="View place stats"
                                title="Place stats"
                              >
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
                                  <path
                                    d="M5 19V10M12 19V5M19 19v-8"
                                    stroke="currentColor"
                                    stroke-width="1.8"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                  />
                                </svg>
                              </button>`
                                  : ''
                              }
                              ${
                                this.onLiveToolsMenu
                                  ? `<button
                                type="button"
                                class="scene-watch-live-tools-btn"
                                data-live-tools
                                aria-label="Live tools — poll, Q&A, trivia"
                                title="Live tools"
                              >
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
                                  <circle cx="12" cy="6.5" r="1.5" fill="currentColor"/>
                                  <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                                  <circle cx="12" cy="17.5" r="1.5" fill="currentColor"/>
                                </svg>
                              </button>`
                                  : ''
                              }
                              <button
                                type="button"
                                class="scene-watch-scene-settings-btn"
                                data-scene-settings
                                hidden
                                aria-label="Open scene stream settings"
                                title="Scene stream settings"
                              >
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
                                  <path
                                    d="M10.4 2h3.2l.52 2.27c.47.15.93.34 1.36.56l2.03-1.14 2.26 2.26-1.14 2.03c.22.43.41.89.56 1.36L22 10.4v3.2l-2.27.52a8.13 8.13 0 0 1-.56 1.36l1.14 2.03-2.26 2.26-2.03-1.14c-.43.22-.89.41-1.36.56L13.6 22h-3.2l-.52-2.27a8.13 8.13 0 0 1-1.36-.56l-2.03 1.14-2.26-2.26 1.14-2.03a8.13 8.13 0 0 1-.56-1.36L2 13.6v-3.2l2.27-.52c.15-.47.34-.93.56-1.36L3.69 6.5l2.26-2.26 2.03 1.14c.43-.22.89-.41 1.36-.56L10.4 2Z"
                                    stroke="currentColor"
                                    stroke-width="1.6"
                                    stroke-linejoin="round"
                                  />
                                  <circle cx="12" cy="12" r="3.15" stroke="currentColor" stroke-width="1.6" />
                                </svg>
                              </button>
                            </div>
                          </div>
                          <p class="scene-watch-dest-scene-card-kicker">
                            ${kindLabel} · <span>${escapeHtml(meta.pointerLabel)}</span>
                          </p>
                          ${desc}
                          <div class="scene-watch-dest-scene-card-creator">
                            <span class="scene-watch-dest-scene-card-avatar" data-owner-avatar aria-hidden>${escapeHtml(ownerInitial)}</span>
                            <div>
                              <span class="scene-watch-dest-scene-card-creator-label">${creatorLabel}</span>
                              <span class="scene-watch-dest-scene-card-creator-name">${escapeHtml(meta.ownerDisplayName)}</span>
                            </div>
                          </div>
                          ${categories ? `<div class="scene-watch-dest-scene-card-badges" aria-label="Categories">${categories}</div>` : ''}
                          <div class="scene-watch-dest-scene-card-actions">
                            <div class="scene-watch-dest-scene-card-cta-row">
                              <div class="scene-watch-join-live-split" data-join-live-root ${this.joinLiveOptions.length > 0 ? '' : 'hidden'}>
                                <button
                                  type="button"
                                  class="scene-watch-dest-btn scene-watch-dest-btn--secondary scene-watch-dest-btn--watch-live-cta scene-watch-join-live-caret-in-btn scene-watch-join-live-caret-in-btn--single"
                                  data-join-live-toggle
                                  aria-haspopup="false"
                                  aria-expanded="false"
                                  title="Watch live stream"
                                >
                                  <span data-join-live-label>JOIN LIVE</span>
                                  <span class="scene-watch-join-live-caret-glyph" data-join-live-caret aria-hidden hidden>▾</span>
                                </button>
                                <div class="scene-watch-join-live-split-menu" data-join-live-menu role="menu" hidden></div>
                              </div>
                              <div class="scene-watch-dest-jump-in-pair">
                                <button type="button" class="scene-watch-dest-jump-in-bar" data-jump-in ${this.jumpInUnlocked ? '' : 'hidden'} aria-busy="${this.jumpInUnlocked ? 'false' : 'true'}">
                                  <span class="scene-watch-dest-jump-in-bar-label">${this.playSessionReady ? 'Jump in' : 'Sign in'}</span>
                                  <span class="scene-watch-dest-jump-in-arrow-box" aria-hidden>
                                    <svg class="scene-watch-dest-jump-in-arrow-svg" viewBox="0 0 24 24" width="14" height="14" fill="none">
                                      <path d="M5 12h12M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                  </span>
                                </button>
                                <a
                                  class="scene-watch-dest-mobile-app-bar"
                                  data-mobile-app
                                  hidden
                                  href="${escapeHtml(dclMobileAppSchemeHref(this.route) ?? 'decentraland://')}"
                                  rel="noopener"
                                  aria-label="Open this place in the Decentraland mobile app"
                                  title="Open in the Decentraland mobile app"
                                >
                                  <span class="scene-watch-dest-jump-in-bar-label">Mobile App</span>
                                  <span class="scene-watch-dest-jump-in-arrow-box" aria-hidden>
                                    <svg class="scene-watch-dest-jump-in-arrow-svg" viewBox="0 0 24 24" width="14" height="14" fill="none">
                                      <rect x="7" y="2.5" width="10" height="19" rx="2" stroke="currentColor" stroke-width="2"/>
                                      <circle cx="12" cy="17.75" r="1" fill="currentColor"/>
                                    </svg>
                                  </span>
                                </a>
                              </div>
                            </div>
                          </div>
                        </div>
                      </article>
                      <article
                        class="scene-watch-dest-events-banner"
                        data-events-banner
                        aria-label="Upcoming events"
                        ${this.eventsBannerStyleAttr(meta)}
                      >
                        ${this.renderEventsBannerInner([], true)}
                      </article>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `
  }
}