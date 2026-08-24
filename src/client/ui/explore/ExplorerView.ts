import type { LoginResult } from '../../../auth/AuthClient'
import type { RouteTarget } from '../../../dcl/content/route'
import { PlacesView } from '../settings/PlacesView'
import { SocialShellTopNav, type SocialShellChromeHandlers, type SocialShellTab } from './SocialShellTopNav'
import {
  isTabletPlayLayout,
  isTouchPlayLayout,
  subscribeTouchPlayLayout
} from '../touchPlayLayout'

export type ExplorerViewOptions = SocialShellChromeHandlers & {
  login: LoginResult
  onOpenScene: (target: RouteTarget) => void
  onJumpIn?: (target: RouteTarget) => void
  onNavigate: (tab: SocialShellTab) => void
}

/** Full-page Explorer at `/` — Bevy-style layout, purple theme. */
export class ExplorerView {
  readonly root: HTMLElement

  private readonly scrollEl: HTMLElement
  private readonly topNav: SocialShellTopNav
  private readonly placesView: PlacesView
  private readonly unsubLayout: () => void
  private login: LoginResult

  constructor(opts: ExplorerViewOptions) {
    this.login = opts.login

    this.root = document.createElement('div')
    this.root.className = 'explorer-view'

    this.topNav = new SocialShellTopNav({
      activeTab: 'explore',
      login: opts.login,
      onNavigate: opts.onNavigate,
      onLoginChange: opts.onLoginChange,
      onSignOut: opts.onSignOut,
      onOpenSettings: opts.onOpenSettings,
      onOpenBackpack: opts.onOpenBackpack,
      onEnter3D: opts.onEnter3D,
      onOpenProfile: opts.onOpenProfile,
      onOpenWhatsNew: opts.onOpenWhatsNew
    })

    this.scrollEl = document.createElement('main')
    this.scrollEl.className = 'explorer-view__main'
    this.scrollEl.dataset.scroll = ''

    this.root.appendChild(this.topNav.el)
    this.root.appendChild(this.scrollEl)

    this.placesView = new PlacesView({
      variant: 'explorer',
      scrollRoot: this.scrollEl,
      onOpenScene: opts.onOpenScene,
      onJumpIn: opts.onJumpIn,
      getAuthIdentity: () => (this.login.kind === 'wallet' ? this.login.identity : null)
    })
    this.scrollEl.appendChild(this.placesView.root)
    this.unsubLayout = subscribeTouchPlayLayout(() => this.syncTouchLayout())
    this.syncTouchLayout()
  }

  private syncTouchLayout(): void {
    this.root.classList.toggle('explorer-view--touch', isTouchPlayLayout())
    this.root.classList.toggle('explorer-view--tablet', isTabletPlayLayout())
  }

  mount(container: HTMLElement): void {
    document.body.classList.add('explorer-route')
    container.innerHTML = ''
    container.appendChild(this.root)
    this.topNav.mount()
    this.placesView.mount()
  }

  setLogin(login: LoginResult): void {
    this.login = login
    this.topNav.setLogin(login)
    void this.placesView.refreshAfterAuthChange()
  }

  dispose(): void {
    this.unsubLayout()
    document.body.classList.remove('explorer-route')
    this.topNav.dispose()
    this.placesView.dispose()
    this.root.remove()
  }
}