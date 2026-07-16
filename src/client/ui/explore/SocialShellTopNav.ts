import type { LoginResult } from '../../../auth/AuthClient'
import type { SocialService } from '../../../social/SocialService'
import { SocialProfileMenu } from './SocialProfileMenu'

export type SocialShellTab = 'explore' | 'map' | 'communities' | 'events'

export type SocialShellChromeHandlers = {
  onLoginChange?: (login: LoginResult) => void
  onSignOut?: () => void
  onOpenSettings?: () => void
  onOpenBackpack?: () => void
  onOpenProfile?: () => void
  onOpenWhatsNew?: () => void
}

export type SocialShellTopNavOptions = SocialShellChromeHandlers & {
  activeTab: SocialShellTab | null
  login: LoginResult
  onNavigate: (tab: SocialShellTab) => void
  getSocial?: () => SocialService | null
  onEnsureSocial?: () => Promise<void>
  onOpenChat?: () => void
  onOpenUserProfile?: (address: string) => void
}

/** Shared 2D shell nav — Explore · Map · Communities · Events + account chrome. */
export class SocialShellTopNav {
  readonly el: HTMLElement

  private readonly profileMenu: SocialProfileMenu
  private readonly tabButtons: Partial<Record<SocialShellTab, HTMLButtonElement>> = {}
  private activeTab: SocialShellTab | null

  constructor(opts: SocialShellTopNavOptions) {
    this.activeTab = opts.activeTab

    this.el = document.createElement('header')
    this.el.className = 'social-shell-topnav'
    this.el.setAttribute('aria-label', 'Decentraland')
    this.el.innerHTML = `
      <nav class="social-shell-topnav__nav" aria-label="Main">
        <button type="button" class="social-shell-topnav__link" data-shell-tab="explore">Explore</button>
        <button type="button" class="social-shell-topnav__link" data-shell-tab="map">Map</button>
        <button type="button" class="social-shell-topnav__link" data-shell-tab="communities">Communities</button>
        <button type="button" class="social-shell-topnav__link" data-shell-tab="events">Events</button>
      </nav>
      <div class="social-shell-topnav__account" data-account></div>
    `

    const accountEl = this.el.querySelector('[data-account]') as HTMLElement

    this.profileMenu = new SocialProfileMenu({
      login: opts.login,
      onLoginChange: opts.onLoginChange,
      onSignOut: opts.onSignOut,
      onOpenSettings: opts.onOpenSettings,
      onOpenBackpack: opts.onOpenBackpack,
      onOpenProfile: opts.onOpenProfile,
      onOpenWhatsNew: opts.onOpenWhatsNew
    })
    accountEl.appendChild(this.profileMenu.wrap)

    for (const btn of this.el.querySelectorAll<HTMLButtonElement>('[data-shell-tab]')) {
      const tab = btn.dataset.shellTab as SocialShellTab | undefined
      if (tab === 'explore' || tab === 'map' || tab === 'communities' || tab === 'events') {
        this.tabButtons[tab] = btn
        btn.addEventListener('click', () => opts.onNavigate(tab))
      }
    }

    this.applyActiveTab()
  }

  mount(): void {
    this.profileMenu.mount()
  }

  setLogin(login: LoginResult): void {
    this.profileMenu.setLogin(login)
  }

  setActiveTab(tab: SocialShellTab | null): void {
    this.activeTab = tab
    this.applyActiveTab()
  }

  dispose(): void {
    this.profileMenu.dispose()
    this.el.remove()
  }

  private applyActiveTab(): void {
    for (const [tab, btn] of Object.entries(this.tabButtons) as [SocialShellTab, HTMLButtonElement][]) {
      btn.classList.toggle('social-shell-topnav__link--active', tab === this.activeTab)
    }
  }
}