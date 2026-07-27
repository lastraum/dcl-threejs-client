import type { LoginResult } from '../../../auth/AuthClient'
import { SocialShellTopNav, type SocialShellChromeHandlers, type SocialShellTab } from './SocialShellTopNav'
import { LootBagView } from './LootBagView'

export type LootBagPageViewOptions = SocialShellChromeHandlers & {
  login: LoginResult
  onNavigate: (tab: SocialShellTab) => void
}

/** Full-page Loot Bag at `/lootbag` — 2D site only (not the in-world HUD panel). */
export class LootBagPageView {
  readonly root: HTMLElement

  private readonly topNav: SocialShellTopNav
  private readonly lootBag: LootBagView

  constructor(opts: LootBagPageViewOptions) {
    this.root = document.createElement('div')
    this.root.className = 'lootbag-page-view'

    this.topNav = new SocialShellTopNav({
      activeTab: 'lootbag',
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

    this.lootBag = new LootBagView({ login: opts.login })

    const mainEl = document.createElement('main')
    mainEl.className = 'lootbag-page-view__main'
    mainEl.appendChild(this.lootBag.root)

    this.root.appendChild(this.topNav.el)
    this.root.appendChild(mainEl)
  }

  mount(container: HTMLElement): void {
    document.body.classList.add('lootbag-route')
    container.innerHTML = ''
    container.appendChild(this.root)
    this.topNav.mount()
    this.lootBag.mount()
  }

  setLogin(login: LoginResult): void {
    this.topNav.setLogin(login)
    this.lootBag.setLogin(login)
  }

  dispose(): void {
    document.body.classList.remove('lootbag-route')
    this.lootBag.dispose()
    this.topNav.dispose()
    this.root.remove()
  }
}
