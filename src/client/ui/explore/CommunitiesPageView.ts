import type { LoginResult } from '../../../auth/AuthClient'
import { CommunitiesBrowseView } from './CommunitiesBrowseView'
import { SocialShellTopNav, type SocialShellChromeHandlers, type SocialShellTab } from './SocialShellTopNav'

export type CommunitiesPageViewOptions = SocialShellChromeHandlers & {
  login: LoginResult
  onNavigate: (tab: SocialShellTab) => void
}

/** Full-page communities browse at `/communities`. */
export class CommunitiesPageView {
  readonly root: HTMLElement

  private readonly topNav: SocialShellTopNav
  private readonly browseView: CommunitiesBrowseView
  private login: LoginResult

  constructor(opts: CommunitiesPageViewOptions) {
    this.login = opts.login

    this.root = document.createElement('div')
    this.root.className = 'communities-page-view'

    this.topNav = new SocialShellTopNav({
      activeTab: 'communities',
      login: opts.login,
      onNavigate: opts.onNavigate,
      onLoginChange: opts.onLoginChange,
      onSignOut: opts.onSignOut,
      onOpenSettings: opts.onOpenSettings,
      onOpenBackpack: opts.onOpenBackpack,
      onOpenProfile: opts.onOpenProfile,
      onOpenWhatsNew: opts.onOpenWhatsNew
    })

    this.browseView = new CommunitiesBrowseView({
      getAuthIdentity: () => (this.login.kind === 'wallet' ? this.login.identity : null)
    })

    this.root.appendChild(this.topNav.el)
    const main = document.createElement('main')
    main.className = 'communities-page-view__main'
    main.appendChild(this.browseView.root)
    this.root.appendChild(main)
  }

  mount(container: HTMLElement): void {
    document.body.classList.add('communities-route')
    container.innerHTML = ''
    container.appendChild(this.root)
    this.topNav.mount()
    this.browseView.mount()
  }

  setLogin(login: LoginResult): void {
    this.login = login
    this.topNav.setLogin(login)
  }

  dispose(): void {
    document.body.classList.remove('communities-route')
    this.browseView.dispose()
    this.topNav.dispose()
    this.root.remove()
  }
}