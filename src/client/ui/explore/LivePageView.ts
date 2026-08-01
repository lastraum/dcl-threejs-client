import type { LoginResult } from '../../../auth/AuthClient'
import type { LiveDirectoryController } from '../../../social/LiveDirectoryController'
import type { LiveSession } from '../../../social/globalLiveWire'
import { LiveDirectoryView } from '../live/LiveDirectoryView'
import { SocialShellTopNav, type SocialShellChromeHandlers, type SocialShellTab } from './SocialShellTopNav'

export type LivePageViewOptions = SocialShellChromeHandlers & {
  login: LoginResult
  onNavigate: (tab: SocialShellTab) => void
  getDirectory: () => LiveDirectoryController | null
  getLogin?: () => LoginResult | null
  onWatch: (session: LiveSession) => void
}

/** Full-page Live directory at `/live`. */
export class LivePageView {
  readonly root: HTMLElement
  private readonly topNav: SocialShellTopNav
  private readonly view: LiveDirectoryView

  constructor(opts: LivePageViewOptions) {
    this.root = document.createElement('div')
    this.root.className = 'live-page-view'

    this.topNav = new SocialShellTopNav({
      activeTab: 'live',
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

    this.view = new LiveDirectoryView({
      getDirectory: opts.getDirectory,
      getLogin: opts.getLogin ?? (() => opts.login),
      onWatch: opts.onWatch,
      compact: false
    })

    const mainEl = document.createElement('main')
    mainEl.className = 'live-page-view__main'
    mainEl.appendChild(this.view.root)

    this.root.appendChild(this.topNav.el)
    this.root.appendChild(mainEl)
  }

  mount(container: HTMLElement): void {
    document.body.classList.add('live-route')
    container.innerHTML = ''
    container.appendChild(this.root)
    this.topNav.mount()
    this.view.mount()
  }

  setLogin(login: LoginResult): void {
    this.topNav.setLogin(login)
  }

  dispose(): void {
    document.body.classList.remove('live-route')
    this.view.dispose()
    this.topNav.dispose()
    this.root.remove()
  }
}
