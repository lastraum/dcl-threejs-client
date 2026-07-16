import type { LoginResult } from '../../../auth/AuthClient'
import type { RouteTarget } from '../../../dcl/content/route'
import type { DclEvent } from '../../../social/dclEvents'
import { EventsView } from '../settings/EventsView'
import { SocialShellTopNav, type SocialShellChromeHandlers, type SocialShellTab } from './SocialShellTopNav'

export type EventsPageViewOptions = SocialShellChromeHandlers & {
  login: LoginResult
  onNavigate: (tab: SocialShellTab) => void
  onEventJumpIn?: (target: RouteTarget, event: DclEvent) => void
  onEventViewScene?: (target: RouteTarget, event: DclEvent) => void
}

/** Full-page events calendar at `/events`. */
export class EventsPageView {
  readonly root: HTMLElement

  private readonly topNav: SocialShellTopNav
  private readonly eventsView: EventsView

  constructor(opts: EventsPageViewOptions) {

    this.root = document.createElement('div')
    this.root.className = 'events-page-view'

    this.topNav = new SocialShellTopNav({
      activeTab: 'events',
      login: opts.login,
      onNavigate: opts.onNavigate,
      onLoginChange: opts.onLoginChange,
      onSignOut: opts.onSignOut,
      onOpenSettings: opts.onOpenSettings,
      onOpenBackpack: opts.onOpenBackpack,
      onOpenProfile: opts.onOpenProfile,
      onOpenWhatsNew: opts.onOpenWhatsNew
    })

    this.eventsView = new EventsView({
      onJumpIn: opts.onEventJumpIn,
      onViewScene: opts.onEventViewScene
    })

    const mainEl = document.createElement('main')
    mainEl.className = 'events-page-view__main'
    mainEl.appendChild(this.eventsView.root)

    this.root.appendChild(this.topNav.el)
    this.root.appendChild(mainEl)
  }

  mount(container: HTMLElement): void {
    document.body.classList.add('events-route')
    container.innerHTML = ''
    container.appendChild(this.root)
    this.topNav.mount()
    this.eventsView.mount()
  }

  setLogin(login: LoginResult): void {
    this.topNav.setLogin(login)
  }

  dispose(): void {
    document.body.classList.remove('events-route')
    this.eventsView.dispose()
    this.topNav.dispose()
    this.root.remove()
  }
}