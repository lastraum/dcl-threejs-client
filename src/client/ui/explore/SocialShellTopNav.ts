import type { LoginResult } from '../../../auth/AuthClient'
import type { SocialService } from '../../../social/SocialService'
import { SocialProfileMenu } from './SocialProfileMenu'

export type SocialShellTab = 'explore' | 'map' | 'communities' | 'events' | 'gacha' | 'editor'

export type SocialShellChromeHandlers = {
  onLoginChange?: (login: LoginResult) => void
  onSignOut?: () => void
  onOpenSettings?: () => void
  onOpenBackpack?: () => void
  onOpenProfile?: () => void
  onOpenWhatsNew?: () => void
  /** Enter the 3D overlay (the top-left "3D" dot). */
  onEnter3D?: () => void
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

/** Simplified Decentraland mark (two pyramids + two suns) for the 3D-section dot. */
const DCL_DOT_MARK = `<svg viewBox="0 0 44 44" width="22" height="22" aria-hidden="true"><circle cx="22" cy="22" r="22" fill="#FF2D55"/><circle cx="13.6" cy="11.4" r="2.5" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="28.2" cy="14.2" r="4.7" fill="none" stroke="#fff" stroke-width="1.8"/><polygon points="15.6,14.6 7,30 22.6,30" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/><polygon points="29.4,21 21,30 38,30" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>`

const SHELL_TABS: readonly SocialShellTab[] = [
  'explore',
  'map',
  'communities',
  'events',
  'gacha',
  'editor'
]

/** Shared 2D shell nav — Explore · Map · Communities · Events · Gacha · Terrain + account chrome. */
export class SocialShellTopNav {
  readonly el: HTMLElement

  private readonly profileMenu: SocialProfileMenu
  private readonly enter3dBtn: HTMLButtonElement
  private readonly tabButtons: Partial<Record<SocialShellTab, HTMLButtonElement>> = {}
  private activeTab: SocialShellTab | null
  private login: LoginResult

  constructor(opts: SocialShellTopNavOptions) {
    this.activeTab = opts.activeTab
    this.login = opts.login

    this.el = document.createElement('header')
    this.el.className = 'social-shell-topnav'
    this.el.setAttribute('aria-label', 'Decentraland')
    this.el.innerHTML = `
      <button type="button" class="social-shell-topnav__section-dot" data-enter-3d title="Go to the 3D client" aria-label="Go to the 3D client">
        <span class="social-shell-topnav__section-dot-mark" aria-hidden="true">${DCL_DOT_MARK}</span>
        <span class="social-shell-topnav__section-dot-3d" aria-hidden="true">3D</span>
      </button>
      <nav class="social-shell-topnav__nav" aria-label="Main">
        <button type="button" class="social-shell-topnav__link" data-shell-tab="explore">Explore</button>
        <button type="button" class="social-shell-topnav__link" data-shell-tab="map">Map</button>
        <button type="button" class="social-shell-topnav__link" data-shell-tab="communities">Communities</button>
        <button type="button" class="social-shell-topnav__link" data-shell-tab="events">Events</button>
        <button type="button" class="social-shell-topnav__link social-shell-topnav__link--gacha" data-shell-tab="gacha">Pool</button>
        <button type="button" class="social-shell-topnav__link" data-shell-tab="editor" aria-label="Terrain editor">Terrain</button>
      </nav>
      <div class="social-shell-topnav__account" data-account></div>
    `

    const accountEl = this.el.querySelector('[data-account]') as HTMLElement
    this.enter3dBtn = this.el.querySelector('[data-enter-3d]') as HTMLButtonElement

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
      if (tab && (SHELL_TABS as readonly string[]).includes(tab)) {
        this.tabButtons[tab] = btn
        btn.addEventListener('click', () => opts.onNavigate(tab))
      }
    }

    this.enter3dBtn.addEventListener('click', () => {
      if (this.login.kind !== 'wallet') return
      opts.onEnter3D?.()
    })

    this.applyEnter3dVisibility()
    this.applyActiveTab()
  }

  mount(): void {
    this.profileMenu.mount()
  }

  setLogin(login: LoginResult): void {
    this.login = login
    this.profileMenu.setLogin(login)
    this.applyEnter3dVisibility()
  }

  /** Jump into 3D — guests with catalyst wallet identity have the same rights as wallets. */
  private applyEnter3dVisibility(): void {
    const canEnter = this.login.kind === 'wallet' || this.login.kind === 'guest'
    this.enter3dBtn.hidden = !canEnter
    this.enter3dBtn.disabled = !canEnter
    this.enter3dBtn.setAttribute('aria-hidden', canEnter ? 'false' : 'true')
    if (!canEnter) this.enter3dBtn.tabIndex = -1
    else this.enter3dBtn.removeAttribute('tabindex')
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