import type { LoginResult } from '../../../auth/AuthClient'
import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import type { RouteTarget } from '../../../dcl/content/route'
import {
  formatEventCardTimeShort,
  isEventLiveNow,
  type DclEvent
} from '../../../social/dclEvents'
import { fetchSceneLandingMeta, fetchSceneRelatedEvents, type SceneLandingMeta } from '../../../social/sceneLanding'
import { EventModal } from '../events/EventModal'
import { SocialShellTopNav, type SocialShellTab } from '../explore/SocialShellTopNav'

export type SceneLandingViewOptions = {
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
  login: LoginResult
  onJumpIn: () => void
  onNavigate: (tab: SocialShellTab) => void
  onEventJumpIn?: (target: RouteTarget, event: DclEvent) => void
  onEventViewScene?: (target: RouteTarget, event: DclEvent) => void
  onLoginChange?: (login: LoginResult) => void
  onSignOut?: () => void
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Scene landing at `/<segment>` — companion `PublicSceneStreamPage` card layout (Phase 2). */
export class SceneLandingView {
  readonly root: HTMLElement

  private readonly route: SceneLandingViewOptions['route']
  private readonly onJumpIn: () => void
  private readonly onNavigate: (tab: SocialShellTab) => void
  private readonly topNav: SocialShellTopNav
  private readonly mainEl: HTMLElement
  private readonly eventModal: EventModal
  private meta: SceneLandingMeta | null = null
  private relatedEvents: DclEvent[] = []
  private disposed = false

  constructor(opts: SceneLandingViewOptions) {
    this.route = opts.route
    this.onJumpIn = opts.onJumpIn
    this.onNavigate = opts.onNavigate

    this.topNav = new SocialShellTopNav({
      activeTab: null,
      login: opts.login,
      onNavigate: opts.onNavigate,
      onLoginChange: opts.onLoginChange,
      onSignOut: opts.onSignOut
    })

    this.eventModal = new EventModal({
      onJumpIn: opts.onEventJumpIn,
      onViewScene: opts.onEventViewScene
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
    void this.load()
  }

  setLogin(login: LoginResult): void {
    this.topNav.setLogin(login)
  }

  dispose(): void {
    this.disposed = true
    document.body.classList.remove('scene-landing-route')
    this.eventModal.dispose()
    this.topNav.dispose()
    this.root.remove()
  }

  private async load(): Promise<void> {
    const loadingEl = this.root.querySelector('[data-loading]') as HTMLElement
    loadingEl.hidden = false

    try {
      this.meta = await fetchSceneLandingMeta(this.route)
      if (this.disposed) return
      loadingEl.remove()
      this.mainEl.innerHTML = this.renderLayout(this.meta)
      this.bindJumpIn()
      void this.hydrateOwnerAvatar()
      void this.loadRelatedEvents()
    } catch {
      if (this.disposed) return
      loadingEl.innerHTML =
        '<p class="scene-landing-view__error">Could not load this place. Try again from Explore.</p>'
    }
  }

  private bindJumpIn(): void {
    this.root.querySelector('[data-jump-in]')?.addEventListener('click', () => this.onJumpIn())
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
    const crowdBadge =
      meta.userCount > 0
        ? `<span class="scene-watch-dest-scene-card-in-world" aria-label="${meta.userCount} people here">${meta.userCount} in world</span>`
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
                                <span class="scene-watch-dest-jump-in-bar-label">Jump in</span>
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
                <aside class="scene-watch-dest-v2-chat-dock" aria-label="Scene chat">
                  <div class="scene-landing-chat-placeholder">
                    <p class="scene-landing-chat-placeholder__title">Scene chat</p>
                    <p class="scene-landing-chat-placeholder__muted">Voice &amp; text chat on landing — Phase 3</p>
                  </div>
                </aside>
              </div>
            </div>
          </div>
        </div>
      </div>
    `
  }
}