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
import { EventModal } from '../events/EventModal'
import { SocialShellTopNav, type SocialShellChromeHandlers, type SocialShellTab } from '../explore/SocialShellTopNav'
import { SceneUsersModal } from './SceneUsersModal'

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
  private targetProgress = 0
  private displayedProgress = 0
  private progressAnimFrame = 0
  private progressFillEl: HTMLElement | null = null
  private progressPctEl: HTMLElement | null = null
  private progressStatusEl: HTMLElement | null = null
  private pendingBan: SceneLoadErrorMessage | null = null

  constructor(opts: SceneLandingViewOptions) {
    this.route = opts.route
    this.onJumpIn = opts.onJumpIn
    this.onNavigate = opts.onNavigate
    this.playSessionReady = opts.playSessionReady === true

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
    this.topNav.setLogin(login)
  }

  /** Update Jump in / Sign in CTA after auth panel or profile login. */
  setPlaySessionReady(ready: boolean): void {
    this.playSessionReady = ready
    this.syncJumpInLabel()
  }

  dispose(): void {
    this.disposed = true
    this.stopProgressAnimation()
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
      if (this.pendingBan) {
        const ban = this.pendingBan
        this.pendingBan = null
        this.showSceneBan(ban)
      } else {
        this.bindJumpIn()
      }
      this.bindCrowdBadge()
      void this.hydrateOwnerAvatar()
      void this.loadRelatedEvents()
    } catch {
      if (this.disposed) return
      loadingEl.innerHTML =
        '<p class="scene-landing-view__error">Could not load this place. Try again from Explore.</p>'
    }
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
                              <button type="button" class="scene-watch-dest-jump-in-bar" data-jump-in>
                                <span class="scene-watch-dest-jump-in-bar-label">${this.playSessionReady ? 'Jump in' : 'Sign in'}</span>
                                <span class="scene-watch-dest-jump-in-arrow-box" aria-hidden>
                                  <svg class="scene-watch-dest-jump-in-arrow-svg" viewBox="0 0 24 24" width="14" height="14" fill="none">
                                    <path d="M5 12h12M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                  </svg>
                                </span>
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