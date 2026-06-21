import type { LoginResult } from '../../auth/AuthClient'
import { loginWithMetaMask, refreshWalletIdentity, resumeStoredLogin } from '../../auth/AuthClient'
import { clearStoredIdentity } from '../../auth/identityStore'
import {
  formatIdentityExpiry,
  getStoredIdentityExpiresAtMs,
  identityNeedsRefreshSoon
} from '../../auth/identityManager'
import { identityFromAvatarProfile } from '../../avatar/displayName'
import { fetchProfileCached } from '../../avatar/peerApi'
import { APP_VERSION_LABEL } from '../appVersion'
import { SplashAvatarPreview } from './SplashAvatarPreview'

export type SplashChoice = LoginResult | null

type SplashHandlers = {
  onComplete: (choice: SplashChoice) => void
}

type AuthProvider = {
  id: string
  label: string
  icon: string
  enabled: boolean
  wide?: boolean
  variant?: string
}

function getAuthProviders(): AuthProvider[] {
  return [
    { id: 'metamask', label: 'MetaMask', icon: ICON_METAMASK, enabled: true, wide: true, variant: 'metamask' },
    { id: 'google', label: 'Google', icon: ICON_GOOGLE, enabled: false },
    { id: 'discord', label: 'Discord', icon: ICON_DISCORD, enabled: false },
    { id: 'apple', label: 'Apple', icon: ICON_APPLE, enabled: false },
    { id: 'x', label: 'X', icon: ICON_X, enabled: false },
    { id: 'fortmatic', label: 'Fortmatic', icon: ICON_FORTMATIC, enabled: false },
    { id: 'opera', label: 'Opera', icon: ICON_OPERA, enabled: false },
    { id: 'walletconnect', label: 'WalletConnect', icon: ICON_WALLETCONNECT, enabled: false }
  ]
}

/** Pre-world login gate — DCL launcher layout with multi-provider auth. */
export class SplashScreen {
  private readonly root: HTMLElement
  private readonly titleEl: HTMLElement
  private readonly subtitleEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly actionsEl: HTMLElement
  private readonly stageEl: HTMLElement
  private avatarPreview: SplashAvatarPreview | null = null
  private busy = false

  constructor(private readonly handlers: SplashHandlers) {
    this.root = document.createElement('div')
    this.root.className = 'splash-screen'
    this.root.innerHTML = `
      <div class="splash-screen__layout">
        <div class="splash-screen__copy">
          <div class="splash-screen__logo" aria-hidden="true">
            <svg viewBox="0 0 44 44" width="44" height="44" role="img" aria-label="Decentraland">
              <circle cx="22" cy="22" r="22" fill="#FF2D55"/>
              <path fill="#fff" d="M10 28l6-14h2.2l3.4 8.2L25 14h2.1l6 14h-2.4l-1.2-3H13.6l-1.2 3H10zm5.8-5.2h6.8L19.8 17l-4 5.8z"/>
            </svg>
          </div>
          <h1 class="splash-screen__title"></h1>
          <p class="splash-screen__subtitle"></p>
          <div class="splash-screen__status"></div>
          <div class="splash-screen__actions"></div>
        </div>
        <div class="splash-screen__stage" aria-hidden="true"></div>
      </div>
      <div class="splash-screen__version">${APP_VERSION_LABEL} — launcher</div>
    `
    this.titleEl = this.root.querySelector('.splash-screen__title')!
    this.subtitleEl = this.root.querySelector('.splash-screen__subtitle')!
    this.statusEl = this.root.querySelector('.splash-screen__status')!
    this.actionsEl = this.root.querySelector('.splash-screen__actions')!
    this.stageEl = this.root.querySelector('.splash-screen__stage')!
  }

  mount(): void {
    document.body.appendChild(this.root)
    this.refresh()
  }

  dispose(): void {
    this.avatarPreview?.dispose()
    this.avatarPreview = null
    this.root.remove()
  }

  private refresh(): void {
    const stored = resumeStoredLogin()
    this.root.classList.toggle('splash-screen--signed-in', Boolean(stored && stored.kind !== 'guest'))

    if (stored && stored.kind !== 'guest') {
      void this.showReturningUser(stored)
      return
    }

    this.avatarPreview?.dispose()
    this.avatarPreview = null
    this.stageEl.innerHTML = ''
    this.titleEl.textContent = 'Welcome to Decentraland'
    this.subtitleEl.textContent = 'Choose how you want to sign in.'
    this.setStatus('')
    this.renderAuthProviders()
  }

  private async showReturningUser(stored: LoginResult): Promise<void> {
    if (stored.kind === 'guest') return

    this.titleEl.textContent = 'Welcome back'
    this.subtitleEl.textContent = ''
    this.setStatus('')

    if (!this.avatarPreview) {
      this.avatarPreview = new SplashAvatarPreview(this.stageEl)
    }
    void this.avatarPreview.loadProfile(stored.address)

    void fetchProfileCached(stored.address).then((profile) => {
      if (!profile) return
      const { displayName } = identityFromAvatarProfile(profile, stored.address)
      this.titleEl.textContent = `Welcome back ${displayName}`
    })

    this.renderReturningActions(stored)
  }

  private renderReturningActions(stored: LoginResult): void {
    this.actionsEl.innerHTML = ''
    this.actionsEl.appendChild(
      this.button('Jump into Decentraland', 'primary', true, () => this.handlers.onComplete(stored))
    )

    const expiresAt = getStoredIdentityExpiresAtMs()
    const expired = expiresAt != null && expiresAt <= Date.now()
    const needsRefresh = identityNeedsRefreshSoon(expiresAt)

    if (stored.kind === 'wallet' && (expired || needsRefresh)) {
      this.actionsEl.appendChild(
        this.button(expired ? 'Sign in again' : 'Refresh session', 'secondary', false, () => {
          void this.runLogin((onStatus) => refreshWalletIdentity(stored.address, onStatus))
        })
      )
    }

    this.actionsEl.appendChild(
      this.button('Use a different account', 'secondary', false, () => {
        clearStoredIdentity()
        this.refresh()
      })
    )

    const hint = document.createElement('div')
    hint.className = needsRefresh || expired
      ? 'splash-session-hint splash-session-hint--warn'
      : 'splash-session-hint'
    hint.textContent = formatIdentityExpiry(expiresAt)
    this.actionsEl.appendChild(hint)
  }

  private renderAuthProviders(): void {
    this.actionsEl.innerHTML = ''

    const grid = document.createElement('div')
    grid.className = 'splash-auth-grid'

    for (const provider of getAuthProviders()) {
      const item = document.createElement('button')
      item.type = 'button'

      let classes = 'splash-auth-grid__item'
      if (provider.wide) classes += ' splash-auth-grid__item--wide'
      if (provider.variant) classes += ` splash-auth-grid__item--${provider.variant}`
      if (!provider.enabled) classes += ' splash-auth-grid__item--disabled'
      item.className = classes

      const iconSpan = document.createElement('span')
      iconSpan.className = 'splash-auth-grid__icon'
      iconSpan.innerHTML = provider.icon
      item.appendChild(iconSpan)

      const labelSpan = document.createElement('span')
      labelSpan.className = 'splash-auth-grid__label'
      labelSpan.textContent = provider.label
      item.appendChild(labelSpan)

      if (!provider.enabled) {
        const badge = document.createElement('span')
        badge.className = 'splash-auth-grid__badge'
        badge.textContent = 'Soon'
        item.appendChild(badge)
      }

      item.addEventListener('click', () => {
        if (this.busy) return
        if (!provider.enabled) {
          this.setStatus(`${provider.label} login coming soon.`)
          return
        }
        this.handleProviderClick(provider)
      })

      grid.appendChild(item)
    }

    this.actionsEl.appendChild(grid)

    const divider = document.createElement('div')
    divider.className = 'splash-auth-divider'
    divider.textContent = 'or'
    this.actionsEl.appendChild(divider)

    this.actionsEl.appendChild(
      this.button('Continue as Guest', 'ghost', false, () => {
        this.handlers.onComplete({ kind: 'guest' })
      })
    )
  }

  private handleProviderClick(provider: AuthProvider): void {
    switch (provider.id) {
      case 'metamask':
        void this.runLogin((onStatus) => loginWithMetaMask(onStatus))
        break
      default:
        this.setStatus(`${provider.label} login is not yet available.`)
    }
  }

  private button(
    label: string,
    variant: string,
    withArrow: boolean,
    onClick: () => void
  ): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `splash-screen__btn splash-screen__btn--${variant}`
    btn.innerHTML = withArrow
      ? `<span>${label}</span><span class="splash-screen__btn-arrow" aria-hidden="true">→</span>`
      : label
    btn.addEventListener('click', () => {
      if (this.busy) return
      void onClick()
    })
    return btn
  }

  private setStatus(html: string, isError = false): void {
    this.statusEl.className = isError ? 'splash-screen__status is-error' : 'splash-screen__status'
    this.statusEl.innerHTML = html
  }

  private async runLogin(
    login: (onStatus?: (msg: string) => void) => Promise<LoginResult>
  ): Promise<void> {
    this.busy = true
    this.toggleButtons(true)
    this.setStatus('Connecting…')
    try {
      const result = await login((msg) => this.setStatus(msg))
      this.handlers.onComplete(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.setStatus(msg, true)
      this.busy = false
      this.toggleButtons(false)
    }
  }

  private toggleButtons(disabled: boolean): void {
    for (const btn of this.actionsEl.querySelectorAll('button')) {
      ;(btn as HTMLButtonElement).disabled = disabled
    }
  }
}

export function showSplashScreen(): Promise<SplashChoice> {
  return new Promise((resolve) => {
    const skip =
      typeof window !== 'undefined' &&
      (new URLSearchParams(window.location.search).has('guest') ||
        new URLSearchParams(window.location.search).has('skipLogin'))

    if (skip) {
      resolve(resumeStoredLogin() ?? { kind: 'guest' })
      return
    }

    const splash = new SplashScreen({
      onComplete: (choice) => {
        splash.dispose()
        resolve(choice)
      }
    })
    splash.mount()
  })
}

// ── Provider icon SVGs (inline, 24×24 viewBox) ──────────────────────

const ICON_METAMASK = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M20.5 3L13.1 8.5l1.4-3.3L20.5 3z" fill="#E2761B" stroke="#E2761B" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M3.5 3l7.3 5.6-1.3-3.4L3.5 3zM17.8 16.5l-2 3 4.2 1.2 1.2-4.1-3.4-.1zM2.8 16.6L4 20.7l4.2-1.2-2-3-3.4.1z" fill="#E4761B" stroke="#E4761B" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M8 10.8l-1.2 1.8 4.2.2-.1-4.5L8 10.8zM16 10.8l-3-2.6-.1 4.6 4.2-.2L16 10.8zM8.2 19.5l2.5-1.2-2.2-1.7-.3 2.9zM13.3 18.3l2.5 1.2-.3-2.9-2.2 1.7z" fill="#E4761B" stroke="#E4761B" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M15.8 19.5l-2.5-1.2.2 1.6v.7l2.3-1.1zM8.2 19.5l2.3 1.1v-.7l.2-1.6-2.5 1.2z" fill="#D7C1B3" stroke="#D7C1B3" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M10.6 15.5l-2.1-.6 1.5-.7.6 1.3zM13.4 15.5l.6-1.3 1.5.7-2.1.6z" fill="#233447" stroke="#233447" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M8.2 19.5l.3-3-2.3.1 2 2.9zM15.5 16.5l.3 3 2-2.9-2.3-.1zM17.1 12.6l-4.2.2.4 2.7.6-1.3 1.5.7 1.7-2.3zM8.5 14.9l1.5-.7.6 1.3.4-2.7-4.2-.2 1.7 2.3z" fill="#CD6116" stroke="#CD6116" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M6.8 12.6l1.8 3.5-.1-1.2-1.7-2.3zM15.4 14.9l-.1 1.2 1.8-3.5-1.7 2.3zM11 12.8l-.4 2.7.5 2.5.1-3.3L11 12.8zM13 12.8l-.2 1.8.1 3.4.5-2.5-.4-2.7z" fill="#E4751F" stroke="#E4751F" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M13.4 15.5l-.5 2.5.4.3 2.2-1.7.1-1.2-2.2.1zM8.5 14.9l.1 1.2 2.2 1.7.3-.3-.5-2.5-2.1-.1z" fill="#F6851B" stroke="#F6851B" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M13.5 20.6v-.7l-.2-.2h-2.6l-.2.2v.7l-2.3-1.1.8.7 1.6 1.1h2.7l1.6-1.1.8-.7-2.2 1.1z" fill="#C0AD9E" stroke="#C0AD9E" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M13.3 18.3l-.4-.3h-1.8l-.3.3-.2 1.6.2-.2h2.6l.2.2-.3-1.6z" fill="#161616" stroke="#161616" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M20.8 8.9l.6-3L20.5 3l-7.2 5.4 2.8 2.4 3.9 1.1.9-1-.4-.3.6-.5-.4-.4.6-.4-.4-.4zM2.6 5.9l.6 3-.4.4.6.4-.4.4.6.5-.4.3.9 1 3.9-1.1L10.7 8.4 3.5 3l-.9 2.9z" fill="#763D16" stroke="#763D16" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M20 10.9l-3.9-1.1 1.2 1.8-1.8 3.5 2.3-.1h3.4l-1.2-4.1zM7.9 9.8L4 10.9l-1.2 4.1h3.4l2.3.1-1.8-3.5L7.9 9.8zM13 12.8l.3-4.4 1.2-3.2H9.5l1.2 3.2.3 4.4.1 1.9v3.3h1.8v-3.3l.1-1.9z" fill="#F6851B" stroke="#F6851B" stroke-width=".15" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const ICON_GOOGLE = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
  <path d="M5.84 14.09A6.97 6.97 0 015.47 12c0-.72.12-1.43.34-2.09V7.07H2.18A11 11 0 001 12c0 1.77.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
</svg>`

const ICON_DISCORD = `<svg viewBox="0 0 24 24" fill="#5865F2" xmlns="http://www.w3.org/2000/svg">
  <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 00-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 00-4.8 0c-.14-.34-.36-.76-.54-1.09-.01-.02-.04-.04-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.15 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.03.01.06.02.09.01 1.72-.53 3.45-1.33 5.24-2.65.02-.01.03-.03.03-.05.44-4.53-.73-8.46-3.1-11.95-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z"/>
</svg>`

const ICON_APPLE = `<svg viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
  <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.51-3.23 0-1.44.64-2.2.46-3.06-.4C3.79 16.17 4.36 9.02 8.93 8.76c1.27.07 2.15.72 2.91.77.97-.2 1.9-.77 2.94-.7 1.24.1 2.17.57 2.79 1.45-2.56 1.53-1.95 4.89.56 5.83-.46 1.21-.67 1.74-1.25 2.82-1.04 1.34-1.9 1.35-1.83 1.35zm-4.18-12c-.18-2.13 1.58-3.93 3.61-4.12.33 2.42-2.17 4.23-3.61 4.12z"/>
</svg>`

const ICON_X = `<svg viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
</svg>`

const ICON_FORTMATIC = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="3" width="18" height="18" rx="4" fill="#6851FF"/>
  <path d="M8 8h8v2.5h-5.5V13H14v2.5h-3.5V18H8V8z" fill="#fff"/>
</svg>`

const ICON_OPERA = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="#FF1B2D"/>
  <path d="M9.1 7.3C8.3 8.4 7.8 10.1 7.8 12s.5 3.6 1.3 4.7c1 1.3 2.5 2 4 1.3 2-1 3.3-3.3 3.3-6s-1.3-5-3.3-6c-1.5-.7-3 0-4 1.3z" fill="#fff" fill-opacity=".9"/>
</svg>`

const ICON_WALLETCONNECT = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M6.09 8.76c3.26-3.19 8.56-3.19 11.82 0l.39.38a.4.4 0 010 .58l-1.34 1.31a.22.22 0 01-.3 0l-.54-.53c-2.28-2.22-5.97-2.22-8.25 0l-.58.56a.22.22 0 01-.3 0L5.66 9.75a.4.4 0 010-.58l.43-.41zm14.6 2.72l1.19 1.17a.4.4 0 010 .58l-5.38 5.27a.43.43 0 01-.59 0l-3.82-3.74a.11.11 0 00-.15 0l-3.82 3.74a.43.43 0 01-.59 0L2.12 13.23a.4.4 0 010-.58l1.2-1.17a.43.43 0 01.59 0l3.82 3.74a.11.11 0 00.15 0l3.82-3.74a.43.43 0 01.59 0l3.82 3.74a.11.11 0 00.15 0l3.82-3.74a.43.43 0 01.59 0z" fill="#3B99FC"/>
</svg>`
