import type { SceneLoadErrorMessage } from '../../formatSceneLoadError'
import type { LoginResult } from '../../../auth/AuthClient'
import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import type { RouteTarget } from '../../../dcl/content/route'
import { progressFromStatus } from '../loadingProgress'
import {
  formatEventCardTimeShort,
  isEventLiveNow,
  type DclEvent
} from '../../../social/dclEvents'
import { fetchSceneLandingMeta, fetchSceneRelatedEvents, type SceneLandingMeta } from '../../../social/sceneLanding'
import {
  getCustomHlsUrl,
  isHttpsM3u8,
  listJoinLiveOptions,
  registerUserM3u8Stream,
  removeUserStream,
  sceneStreamTargetFromRoute,
  setCustomHlsUrl,
  type JoinLiveOption
} from '../../../social/sceneStreams'
import { EventModal } from '../events/EventModal'
import { SocialShellTopNav, type SocialShellChromeHandlers, type SocialShellTab } from '../explore/SocialShellTopNav'
import { SceneUsersModal } from './SceneUsersModal'
import Hls from 'hls.js'

export type SceneLandingViewOptions = SocialShellChromeHandlers & {
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
  login: LoginResult
  /** When false, CTA shows "Sign in" and must complete Guest/wallet before Jump in. */
  playSessionReady?: boolean
  onJumpIn: () => void
  onNavigate: (tab: SocialShellTab) => void
  onEventJumpIn?: (target: RouteTarget, event: DclEvent) => void
  onEventViewScene?: (target: RouteTarget, event: DclEvent) => void
  onOpenUserProfile?: (address: string) => void
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
  private readonly topNav: SocialShellTopNav
  private readonly mainEl: HTMLElement
  private readonly eventModal: EventModal
  private readonly sceneUsersModal: SceneUsersModal
  private meta: SceneLandingMeta | null = null
  private relatedEvents: DclEvent[] = []
  private disposed = false
  private jumpInLoading = false
  private playSessionReady = false
  private login: LoginResult
  private joinLiveOptions: JoinLiveOption[] = []
  private joinLiveMenuOpen = false
  private targetProgress = 0
  private displayedProgress = 0
  private progressAnimFrame = 0
  private progressFillEl: HTMLElement | null = null
  private progressPctEl: HTMLElement | null = null
  private progressStatusEl: HTMLElement | null = null
  private pendingBan: SceneLoadErrorMessage | null = null
  private hlsPlayer: Hls | null = null
  private streamDocClickBound = false
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
    this.playSessionReady = opts.playSessionReady === true
    this.login = opts.login

    this.topNav = new SocialShellTopNav({
      activeTab: null,
      login: opts.login,
      onNavigate: opts.onNavigate,
      onLoginChange: opts.onLoginChange,
      onSignOut: opts.onSignOut,
      onOpenSettings: opts.onOpenSettings,
      onOpenBackpack: opts.onOpenBackpack,
      onOpenProfile: opts.onOpenProfile
    })

    this.eventModal = new EventModal({
      onJumpIn: opts.onEventJumpIn,
      onViewScene: opts.onEventViewScene
    })

    this.sceneUsersModal = new SceneUsersModal({
      onOpenProfile: opts.onOpenUserProfile
    })

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
    void this.load()
  }

  setLogin(login: LoginResult): void {
    this.login = login
    this.topNav.setLogin(login)
    this.refreshStreamChrome()
  }

  /** Update Jump in / Sign in CTA after auth panel or profile login. */
  setPlaySessionReady(ready: boolean): void {
    this.playSessionReady = ready
    this.syncJumpInLabel()
  }

  dispose(): void {
    this.disposed = true
    this.teardownStreamPlayer()
    this.stopProgressAnimation()
    if (this.streamDocClickBound) {
      document.removeEventListener('click', this.onDocClick, true)
      this.streamDocClickBound = false
    }
    document.body.classList.remove('scene-landing-route', 'scene-landing-jump-in-loading')
    this.eventModal.dispose()
    this.sceneUsersModal.dispose()
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
      this.meta = await fetchSceneLandingMeta(this.route)
      if (this.disposed) return
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
      void this.hydrateOwnerAvatar()
      void this.loadRelatedEvents()
    } catch {
      if (this.disposed) return
      loadingEl.innerHTML =
        '<p class="scene-landing-view__error">Could not load this place. Try again from Explore.</p>'
    }
  }

  private streamTarget(): { pointer: string; kind: 'world' | 'parcel' } {
    return sceneStreamTargetFromRoute(this.route)
  }

  private sessionWallet(): string | null {
    if (this.login.kind !== 'wallet') return null
    return this.login.address.trim().toLowerCase()
  }

  private isSceneOwner(): boolean {
    const wallet = this.sessionWallet()
    const owner = this.meta?.ownerAddress?.trim().toLowerCase()
    return Boolean(wallet && owner && wallet === owner)
  }

  private refreshJoinLiveOptions(): void {
    const { pointer, kind } = this.streamTarget()
    this.joinLiveOptions = listJoinLiveOptions(pointer, kind)
    this.renderJoinLiveMenu()
    this.syncJoinLiveVisibility()
  }

  private refreshStreamChrome(): void {
    if (!this.meta) return
    this.syncOwnerSettingsVisibility()
    this.syncGoLiveVisibility()
    this.refreshJoinLiveOptions()
  }

  private bindStreamChrome(): void {
    if (!this.streamDocClickBound) {
      document.addEventListener('click', this.onDocClick, true)
      this.streamDocClickBound = true
    }
    this.root.querySelector('[data-join-live-toggle]')?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.setJoinLiveMenuOpen(!this.joinLiveMenuOpen)
    })
    this.root.querySelector('[data-scene-settings]')?.addEventListener('click', () => {
      this.openSceneSettingsModal()
    })
    this.root.querySelector('[data-go-live]')?.addEventListener('click', () => {
      this.openGoLiveModal()
    })
    this.syncOwnerSettingsVisibility()
    this.syncGoLiveVisibility()
    this.renderJoinLiveMenu()
    this.syncJoinLiveVisibility()
  }

  private setJoinLiveMenuOpen(open: boolean): void {
    this.joinLiveMenuOpen = open
    const menu = this.root.querySelector('[data-join-live-menu]') as HTMLElement | null
    const btn = this.root.querySelector('[data-join-live-toggle]') as HTMLButtonElement | null
    if (menu) menu.hidden = !open
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false')
  }

  private syncJoinLiveVisibility(): void {
    const root = this.root.querySelector('[data-join-live-root]') as HTMLElement | null
    if (!root) return
    root.hidden = this.joinLiveOptions.length === 0
  }

  private syncOwnerSettingsVisibility(): void {
    const btn = this.root.querySelector('[data-scene-settings]') as HTMLElement | null
    if (btn) btn.hidden = !this.isSceneOwner()
  }

  private syncGoLiveVisibility(): void {
    const btn = this.root.querySelector('[data-go-live]') as HTMLElement | null
    if (!btn) return
    // Wallet users can list an HLS stream for this place (companion “I'm live”).
    btn.hidden = this.sessionWallet() == null
  }

  private renderJoinLiveMenu(): void {
    const menu = this.root.querySelector('[data-join-live-menu]')
    if (!menu) return
    if (this.joinLiveOptions.length === 0) {
      menu.innerHTML =
        '<p class="scene-watch-join-live-empty">No live streams listed for this place yet.</p>'
      return
    }
    menu.innerHTML = this.joinLiveOptions
      .map((opt) => {
        const cast =
          opt.kind === 'user' && opt.stream.source === 'cast'
            ? ' data-cast="1"'
            : ''
        return `<button type="button" role="menuitem" class="scene-watch-join-live-split-menu-item" data-join-live-id="${escapeHtml(opt.id)}"${cast}>${escapeHtml(opt.label)}</button>`
      })
      .join('')
    menu.querySelectorAll<HTMLButtonElement>('[data-join-live-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.joinLiveId
        if (!id) return
        this.setJoinLiveMenuOpen(false)
        void this.startJoinLive(id)
      })
    })
  }

  private async startJoinLive(optionId: string): Promise<void> {
    const opt = this.joinLiveOptions.find((o) => o.id === optionId)
    if (!opt) return
    if (opt.kind === 'user' && opt.stream.source === 'cast') {
      this.showStreamNotice(
        `Cast listing “${opt.stream.displayName}” uses LiveKit in-world video. Jump in to watch Cast, or open a saved HLS stream.`
      )
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

  private teardownStreamPlayer(): void {
    if (this.hlsPlayer) {
      this.hlsPlayer.destroy()
      this.hlsPlayer = null
    }
    this.root.querySelector('[data-stream-player]')?.remove()
  }

  private openStreamPlayer(m3u8Url: string, title: string): void {
    this.teardownStreamPlayer()
    const wrap = document.createElement('div')
    wrap.className = 'scene-watch-stream-player'
    wrap.dataset.streamPlayer = ''
    wrap.innerHTML = `
      <div class="scene-watch-stream-player__bar">
        <span class="scene-watch-stream-player__title">${escapeHtml(title)}</span>
        <button type="button" class="scene-watch-stream-player__close" data-stream-close aria-label="Close stream">Close</button>
      </div>
      <video class="scene-watch-stream-player__video" controls playsinline autoplay></video>
      <p class="scene-watch-stream-player__hint" data-stream-hint hidden></p>
    `
    const card = this.root.querySelector('.scene-watch-dest-scene-card')
    if (card) card.appendChild(wrap)
    else this.mainEl.appendChild(wrap)

    wrap.querySelector('[data-stream-close]')?.addEventListener('click', () => this.teardownStreamPlayer())
    const video = wrap.querySelector('video')
    const hint = wrap.querySelector('[data-stream-hint]') as HTMLElement | null
    if (!(video instanceof HTMLVideoElement)) return

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true })
      this.hlsPlayer = hls
      hls.loadSource(m3u8Url)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal && hint) {
          hint.hidden = false
          hint.textContent = 'Could not play this stream (network or codec error).'
        }
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = m3u8Url
    } else if (hint) {
      hint.hidden = false
      hint.textContent = 'HLS playback is not supported in this browser.'
    }
    void video.play().catch(() => {
      /* autoplay may be blocked until gesture — controls remain */
    })
  }

  private openSceneSettingsModal(): void {
    if (!this.isSceneOwner()) return
    const { pointer, kind } = this.streamTarget()
    const current = getCustomHlsUrl(pointer, kind) ?? ''
    this.teardownStreamPlayer()
    const existing = this.root.querySelector('[data-scene-settings-modal]')
    existing?.remove()
    const backdrop = document.createElement('div')
    backdrop.className = 'scene-watch-settings-modal-backdrop'
    backdrop.dataset.sceneSettingsModal = ''
    backdrop.innerHTML = `
      <div class="scene-watch-settings-modal" role="dialog" aria-modal="true" aria-label="Scene and stream settings">
        <h3 class="scene-watch-settings-modal-title">Scene &amp; stream settings</h3>
        <p class="scene-watch-settings-modal-text">
          Owner-only: set a custom HTTPS HLS (.m3u8) URL for visitors on this landing page (Join live menu).
        </p>
        <label class="scene-watch-settings-modal-label" for="scene-custom-hls-input">Custom playback (HLS)</label>
        <input id="scene-custom-hls-input" class="scene-watch-settings-modal-input" type="url"
          placeholder="https://…/stream.m3u8" value="${escapeHtml(current)}" autocomplete="off" />
        <p class="scene-watch-settings-modal-error" data-settings-error hidden></p>
        <div class="scene-watch-settings-modal-actions">
          <button type="button" class="scene-watch-dest-btn scene-watch-dest-btn--secondary" data-settings-clear>Clear</button>
          <button type="button" class="scene-watch-dest-btn scene-watch-dest-btn--secondary" data-settings-close>Close</button>
          <button type="button" class="scene-watch-dest-btn" data-settings-save>Save</button>
        </div>
      </div>
    `
    this.root.appendChild(backdrop)
    const input = backdrop.querySelector('#scene-custom-hls-input') as HTMLInputElement
    const errEl = backdrop.querySelector('[data-settings-error]') as HTMLElement
    const close = (): void => backdrop.remove()
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close()
    })
    backdrop.querySelector('[data-settings-close]')?.addEventListener('click', close)
    backdrop.querySelector('[data-settings-clear]')?.addEventListener('click', () => {
      setCustomHlsUrl(pointer, kind, '')
      this.refreshJoinLiveOptions()
      close()
    })
    backdrop.querySelector('[data-settings-save]')?.addEventListener('click', () => {
      const url = input.value.trim()
      if (url && !isHttpsM3u8(url)) {
        errEl.hidden = false
        errEl.textContent = 'Enter a full HTTPS .m3u8 URL, or clear the field.'
        return
      }
      setCustomHlsUrl(pointer, kind, url)
      this.refreshJoinLiveOptions()
      close()
    })
  }

  private openGoLiveModal(): void {
    const wallet = this.sessionWallet()
    if (!wallet) {
      this.showStreamNotice('Sign in with a wallet to list a live stream for this place.')
      return
    }
    const { pointer, kind } = this.streamTarget()
    const existing = this.root.querySelector('[data-go-live-modal]')
    existing?.remove()
    const backdrop = document.createElement('div')
    backdrop.className = 'scene-watch-settings-modal-backdrop'
    backdrop.dataset.goLiveModal = ''
    backdrop.innerHTML = `
      <div class="scene-watch-settings-modal" role="dialog" aria-modal="true" aria-label="I'm live">
        <h3 class="scene-watch-settings-modal-title">I&apos;m live</h3>
        <p class="scene-watch-settings-modal-text">
          List an HTTPS .m3u8 stream for visitors on this place. They pick it from <strong>Join live</strong>.
        </p>
        <label class="scene-watch-settings-modal-label" for="go-live-m3u8-input">Stream URL</label>
        <input id="go-live-m3u8-input" class="scene-watch-settings-modal-input" type="url"
          placeholder="https://…/stream.m3u8" autocomplete="off" />
        <p class="scene-watch-settings-modal-error" data-go-live-error hidden></p>
        <div class="scene-watch-settings-modal-actions">
          <button type="button" class="scene-watch-dest-btn scene-watch-dest-btn--secondary" data-go-live-remove>Remove mine</button>
          <button type="button" class="scene-watch-dest-btn scene-watch-dest-btn--secondary" data-go-live-close>Close</button>
          <button type="button" class="scene-watch-dest-btn" data-go-live-save>Go live</button>
        </div>
      </div>
    `
    this.root.appendChild(backdrop)
    const input = backdrop.querySelector('#go-live-m3u8-input') as HTMLInputElement
    const errEl = backdrop.querySelector('[data-go-live-error]') as HTMLElement
    const close = (): void => backdrop.remove()
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close()
    })
    backdrop.querySelector('[data-go-live-close]')?.addEventListener('click', close)
    backdrop.querySelector('[data-go-live-remove]')?.addEventListener('click', () => {
      for (const opt of this.joinLiveOptions) {
        if (opt.kind === 'user' && opt.stream.wallet === wallet) {
          removeUserStream(opt.stream.id)
        }
      }
      this.refreshJoinLiveOptions()
      close()
    })
    backdrop.querySelector('[data-go-live-save]')?.addEventListener('click', () => {
      try {
        registerUserM3u8Stream({
          pointer,
          kind,
          wallet,
          m3u8Url: input.value
        })
        this.refreshJoinLiveOptions()
        close()
      } catch (e) {
        errEl.hidden = false
        errEl.textContent = e instanceof Error ? e.message : 'Could not register stream.'
      }
    })
  }

  private bindJumpIn(): void {
    this.syncJumpInLabel()
    this.root.querySelector('[data-jump-in]')?.addEventListener('click', () => {
      if (this.jumpInLoading) return
      this.onJumpIn()
    })
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

  private bindCrowdBadge(): void {
    this.root.querySelector('[data-scene-crowd]')?.addEventListener('click', () => {
      if (!this.meta || this.meta.userCount <= 0) return
      this.sceneUsersModal.open(this.route, this.meta.title, this.meta.userCount)
    })
  }

  private async loadRelatedEvents(): Promise<void> {
    const bannerEl = this.root.querySelector('[data-events-banner]') as HTMLElement | null
    if (!bannerEl || !this.meta) return

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
    const kindLabel = meta.kind === 'world' ? 'World' : 'Parcel'
    const creatorLabel = meta.kind === 'world' ? 'World owner' : 'Creator'
    const inWorldLabel = meta.kind === 'world' ? 'in world' : 'here'
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
                      <article class="scene-watch-dest-scene-card">
                        <div class="scene-watch-dest-scene-card-visual">
                          ${
                            meta.imageUrl
                              ? `<img src="${escapeHtml(meta.imageUrl)}" alt="" loading="lazy" decoding="async" />`
                              : '<div class="scene-watch-dest-scene-card-visual-fallback" aria-hidden></div>'
                          }
                          ${
                            crowdBadge
                              ? `<div class="scene-watch-dest-scene-card-visual-badges">${crowdBadge}</div>`
                              : ''
                          }
                        </div>
                        <div class="scene-watch-dest-scene-card-body">
                          <div class="scene-watch-dest-scene-card-head">
                            <h1 class="scene-watch-dest-scene-card-title">${escapeHtml(meta.title)}</h1>
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
                              <div class="scene-watch-join-live-split" data-join-live-root hidden>
                                <button
                                  type="button"
                                  class="scene-watch-dest-btn scene-watch-dest-btn--secondary scene-watch-dest-btn--watch-live-cta scene-watch-join-live-caret-in-btn"
                                  data-join-live-toggle
                                  aria-haspopup="menu"
                                  aria-expanded="false"
                                >
                                  Join live
                                  <span class="scene-watch-join-live-caret-glyph" aria-hidden>▾</span>
                                </button>
                                <div class="scene-watch-join-live-split-menu" data-join-live-menu role="menu" hidden></div>
                              </div>
                              <button type="button" class="scene-watch-dest-jump-in-bar" data-jump-in>
                                <span class="scene-watch-dest-jump-in-bar-label">${this.playSessionReady ? 'Jump in' : 'Sign in'}</span>
                                <span class="scene-watch-dest-jump-in-arrow-box" aria-hidden>
                                  <svg class="scene-watch-dest-jump-in-arrow-svg" viewBox="0 0 24 24" width="14" height="14" fill="none">
                                    <path d="M5 12h12M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                  </svg>
                                </span>
                              </button>
                              <button
                                type="button"
                                class="scene-watch-dest-btn scene-watch-dest-btn--secondary"
                                data-go-live
                                hidden
                              >
                                I&apos;m live
                              </button>
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
    `
  }
}