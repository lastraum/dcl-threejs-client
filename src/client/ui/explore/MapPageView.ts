import type { LoginResult } from '../../../auth/AuthClient'
import { MapView, type MapPlayerState } from '../settings/MapView'
import { SocialShellTopNav, type SocialShellChromeHandlers, type SocialShellTab } from './SocialShellTopNav'

export type MapPageViewOptions = SocialShellChromeHandlers & {
  login: LoginResult
  onNavigate: (tab: SocialShellTab) => void
  onParcelVisit: (px: number, py: number) => void
  getPlayerState?: () => MapPlayerState | null
}

/** Full-page Genesis City Live map at `/map` — map.lastslice.co parity. */
export class MapPageView {
  readonly root: HTMLElement

  private readonly topNav: SocialShellTopNav
  private readonly mapView: MapView

  constructor(opts: MapPageViewOptions) {
    this.root = document.createElement('div')
    this.root.className = 'map-page-view'

    this.topNav = new SocialShellTopNav({
      activeTab: 'map',
      login: opts.login,
      onNavigate: opts.onNavigate,
      onLoginChange: opts.onLoginChange,
      onSignOut: opts.onSignOut,
      onOpenSettings: opts.onOpenSettings,
      onOpenBackpack: opts.onOpenBackpack,
      onOpenProfile: opts.onOpenProfile
    })

    this.mapView = new MapView({
      getPlayerState: opts.getPlayerState ?? (() => null),
      onJumpIn: opts.onParcelVisit
    })

    const mainEl = document.createElement('main')
    mainEl.className = 'map-page-view__main'
    mainEl.appendChild(this.mapView.root)

    this.root.appendChild(this.topNav.el)
    this.root.appendChild(mainEl)
  }

  mount(container: HTMLElement): void {
    document.body.classList.add('map-route')
    container.innerHTML = ''
    container.appendChild(this.root)
    this.topNav.mount()
    this.mapView.mount()
  }

  setLogin(login: LoginResult): void {
    this.topNav.setLogin(login)
  }

  dispose(): void {
    document.body.classList.remove('map-route')
    this.mapView.dispose()
    this.topNav.dispose()
    this.root.remove()
  }
}