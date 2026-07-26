import type { LoginResult } from '../../../auth/AuthClient'
import { SocialShellTopNav, type SocialShellChromeHandlers, type SocialShellTab } from './SocialShellTopNav'
import { GachaCasinoView } from './GachaCasinoView'

export type GachaPageViewOptions = SocialShellChromeHandlers & {
  login: LoginResult
  onNavigate: (tab: SocialShellTab) => void
}

/** Full-page casino gacha at `/gacha` — 2D site only (not the in-world HUD panel). */
export class GachaPageView {
  readonly root: HTMLElement

  private readonly topNav: SocialShellTopNav
  private readonly casino: GachaCasinoView

  constructor(opts: GachaPageViewOptions) {
    this.root = document.createElement('div')
    this.root.className = 'gacha-page-view'

    this.topNav = new SocialShellTopNav({
      activeTab: 'gacha',
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

    this.casino = new GachaCasinoView({ login: opts.login })

    const mainEl = document.createElement('main')
    mainEl.className = 'gacha-page-view__main'
    mainEl.appendChild(this.casino.root)

    this.root.appendChild(this.topNav.el)
    this.root.appendChild(mainEl)
  }

  mount(container: HTMLElement): void {
    document.body.classList.add('gacha-route')
    container.innerHTML = ''
    container.appendChild(this.root)
    this.topNav.mount()
    this.casino.mount()
  }

  setLogin(login: LoginResult): void {
    this.topNav.setLogin(login)
    this.casino.setLogin(login)
  }

  dispose(): void {
    document.body.classList.remove('gacha-route')
    this.casino.dispose()
    this.topNav.dispose()
    this.root.remove()
  }
}
