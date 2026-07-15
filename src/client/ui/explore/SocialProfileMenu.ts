import type { AuthDappLoginMethod, AuthProgress, LoginResult } from '../../../auth/AuthClient'
import { loginWithMetaMask, loginWithProvider } from '../../../auth/AuthClient'
import { ensureGuestSession } from '../../auth/resolveInitialLogin'
import { identityFromAvatarProfile } from '../../../avatar/displayName'
import { fetchProfileCached, fetchProfileFaceUrl } from '../../../avatar/peerApi'
import { notificationPrefs } from '../../../social/notificationPrefs'
import {
  ICON_APPLE,
  ICON_DISCORD,
  ICON_GOOGLE,
  ICON_METAMASK,
  ICON_WALLET_CONNECT,
  ICON_X
} from './explorerAuthIcons'

export type SocialProfileMenuOptions = {
  login: LoginResult
  onLoginChange?: (login: LoginResult) => void
  onSignOut?: () => void
  onOpenSettings?: () => void
  onOpenBackpack?: () => void
  onOpenProfile?: () => void
}

const ICON_GUEST_HEAD = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5Z" fill="currentColor" fill-opacity="0.9"/></svg>`
const ICON_SIGN_OUT = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const ICON_BACKPACK = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M8 8V6.5A4 4 0 0 1 12 2.5 4 4 0 0 1 16 6.5V8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><rect x="6" y="8" width="12" height="12.5" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M12 12v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
const ICON_SETTINGS = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`

function walletShort(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Companion ExploreProfileMenu — avatar circle + account dropdown. */
export class SocialProfileMenu {
  readonly wrap: HTMLElement

  private readonly profileBtn: HTMLButtonElement
  private readonly avatarSlot: HTMLElement
  private readonly menuEl: HTMLElement
  private readonly menuBody: HTMLElement
  private login: LoginResult
  private open = false
  private busy = false
  private displayName: string | null = null
  private readonly onLoginChange?: (login: LoginResult) => void
  private readonly onSignOut?: () => void
  private readonly onOpenSettings?: () => void
  private readonly onOpenBackpack?: () => void
  private readonly onOpenProfile?: () => void
  private unsubPrefs: (() => void) | null = null
  private readonly onDocMouseDown: (ev: MouseEvent) => void
  private readonly onKeyDown: (ev: KeyboardEvent) => void
  private readonly onViewportChange = (): void => {
    if (this.open) this.syncDropdownPosition()
  }

  constructor(opts: SocialProfileMenuOptions) {
    this.login = opts.login
    this.onLoginChange = opts.onLoginChange
    this.onSignOut = opts.onSignOut
    this.onOpenSettings = opts.onOpenSettings
    this.onOpenBackpack = opts.onOpenBackpack
    this.onOpenProfile = opts.onOpenProfile

    this.wrap = document.createElement('div')
    this.wrap.className = 'social-profile-menu'
    this.wrap.innerHTML = `
      <button type="button" class="social-profile-menu__avatar-btn" data-profile-btn aria-haspopup="menu" aria-expanded="false">
        <span class="social-profile-menu__avatar-slot" data-avatar-slot></span>
      </button>
      <div class="social-profile-menu__dropdown" data-menu hidden role="region" aria-label="Account and settings"></div>
    `

    this.profileBtn = this.wrap.querySelector('[data-profile-btn]') as HTMLButtonElement
    this.avatarSlot = this.wrap.querySelector('[data-avatar-slot]') as HTMLElement
    this.menuEl = this.wrap.querySelector('[data-menu]') as HTMLElement
    this.menuBody = document.createElement('div')
    this.menuBody.className = 'social-profile-menu__body'
    this.menuEl.appendChild(this.menuBody)

    this.profileBtn.addEventListener('click', () => this.toggle())

    this.onDocMouseDown = (ev: MouseEvent) => {
      if (!this.open) return
      const target = ev.target as Node
      if (!this.wrap.contains(target) && !this.menuEl.contains(target)) this.close()
    }
    this.onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') this.close()
    }
  }

  mount(): void {
    document.addEventListener('mousedown', this.onDocMouseDown)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('resize', this.onViewportChange)
    window.addEventListener('scroll', this.onViewportChange, true)
    this.unsubPrefs = notificationPrefs.subscribe(() => {
      if (this.open) this.renderMenu()
    })
    this.refreshAvatar()
    this.renderMenu()
  }

  setLogin(login: LoginResult): void {
    this.login = login
    // Sign-out / guest must not keep buttons disabled from a prior login attempt.
    if (login.kind !== 'wallet') this.busy = false
    this.refreshAvatar()
    if (this.open) this.renderMenu()
  }

  dispose(): void {
    document.removeEventListener('mousedown', this.onDocMouseDown)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('resize', this.onViewportChange)
    window.removeEventListener('scroll', this.onViewportChange, true)
    this.unsubPrefs?.()
    this.unsubPrefs = null
    this.restoreDropdownParent()
    this.wrap.remove()
  }

  private isWallet(): boolean {
    return this.login.kind === 'wallet'
  }

  private isGuestAccount(): boolean {
    return this.login.kind === 'guest'
  }

  private hasSession(): boolean {
    return this.login.kind === 'wallet' || this.login.kind === 'guest'
  }

  private toggle(): void {
    if (this.open) this.close()
    else this.openMenu()
  }

  private openMenu(): void {
    this.open = true
    this.menuEl.hidden = false
    this.menuEl.classList.add('social-profile-menu__dropdown--portaled')
    if (this.menuEl.parentElement !== document.body) {
      document.body.appendChild(this.menuEl)
    }
    this.syncDropdownPosition()
    this.profileBtn.classList.add('social-profile-menu__avatar-btn--open')
    this.profileBtn.setAttribute('aria-expanded', 'true')
    this.renderMenu()
  }

  private close(): void {
    this.open = false
    this.menuEl.hidden = true
    this.menuEl.classList.remove('social-profile-menu__dropdown--portaled')
    this.restoreDropdownParent()
    this.profileBtn.classList.remove('social-profile-menu__avatar-btn--open')
    this.profileBtn.setAttribute('aria-expanded', 'false')
  }

  private restoreDropdownParent(): void {
    this.menuEl.style.top = ''
    this.menuEl.style.right = ''
    if (this.menuEl.parentElement !== this.wrap) {
      this.wrap.appendChild(this.menuEl)
    }
  }

  private syncDropdownPosition(): void {
    const rect = this.profileBtn.getBoundingClientRect()
    this.menuEl.style.top = `${Math.round(rect.bottom + 10)}px`
    this.menuEl.style.right = `${Math.round(window.innerWidth - rect.right)}px`
  }

  private refreshAvatar(): void {
    if (!this.hasSession()) {
      this.profileBtn.classList.add('social-profile-menu__avatar-btn--signed-out')
      this.displayName = null
      this.avatarSlot.innerHTML = `<span class="social-profile-menu__guest-icon">${ICON_GUEST_HEAD}</span>`
      this.profileBtn.setAttribute('aria-label', 'Account and sign in')
      return
    }

    this.profileBtn.classList.toggle(
      'social-profile-menu__avatar-btn--signed-out',
      this.isGuestAccount()
    )

    const address = this.login.address
    const letter = address.slice(2, 3).toUpperCase()
    this.avatarSlot.innerHTML = `<span class="social-profile-menu__avatar-fallback" data-fallback>${escapeHtml(letter)}</span>`

    if (this.login.kind === 'guest') {
      this.displayName = this.login.displayName
      this.profileBtn.setAttribute('aria-label', `Guest account — ${this.displayName}`)
    } else {
      this.profileBtn.setAttribute('aria-label', 'Account and settings')
    }

    void fetchProfileFaceUrl(address).then((url) => {
      if (!url || this.login.address !== address) return
      this.avatarSlot.innerHTML = `<img class="social-profile-menu__avatar-img" src="${escapeHtml(url)}" alt="" width="44" height="44" decoding="async" />`
      const img = this.avatarSlot.querySelector('img')
      img?.addEventListener(
        'error',
        () => {
          this.avatarSlot.innerHTML = `<span class="social-profile-menu__avatar-fallback">${escapeHtml(letter)}</span>`
        },
        { once: true }
      )
    })

    void fetchProfileCached(address).then((profile) => {
      if (!profile || this.login.address !== address) return
      if (this.login.kind === 'guest') {
        this.displayName =
          this.login.displayName || identityFromAvatarProfile(profile, address).displayName
      } else {
        this.displayName = identityFromAvatarProfile(profile, address).displayName
      }
      if (this.open) this.renderMenu()
      this.profileBtn.setAttribute(
        'aria-label',
        this.isGuestAccount()
          ? `Guest account — ${this.displayName}`
          : `Account and settings — ${this.displayName}`
      )
    })
  }

  private renderMenu(): void {
    if (this.isWallet()) {
      this.menuBody.innerHTML = this.renderSignedInMenu()
      this.wireSignedInMenu()
      return
    }
    if (this.isGuestAccount()) {
      this.menuBody.innerHTML = this.renderGuestMenu()
      this.wireGuestMenu()
      return
    }
    this.menuBody.innerHTML = this.renderSignInMenu()
    this.wireSignInMenu()
  }

  private renderGuestMenu(): string {
    const address = this.login.kind === 'guest' ? this.login.address : ''
    const name =
      this.displayName ||
      (this.login.kind === 'guest' ? this.login.displayName : 'Guest')
    return `
      <div class="social-profile-menu__identity">
        <div class="social-profile-menu__name">${escapeHtml(name)}</div>
        <div class="social-profile-menu__sub">Guest on this device · ${escapeHtml(walletShort(address))}</div>
      </div>
      <p class="social-profile-menu__hint">Stable guest wallet for chat &amp; LiveKit. Connect a wallet to claim wearables &amp; ownership tools.</p>
      <div class="social-profile-menu__actions">
        <button type="button" class="social-profile-menu__item" data-login-method="metamask">
          <span class="social-profile-menu__item-icon" aria-hidden="true">${ICON_METAMASK}</span>
          <span>Connect MetaMask</span>
        </button>
        <button type="button" class="social-profile-menu__item" data-login-method="google">
          <span class="social-profile-menu__item-icon" aria-hidden="true">${ICON_GOOGLE}</span>
          <span>Connect Google</span>
        </button>
      </div>
    `
  }

  private wireGuestMenu(): void {
    for (const btn of this.menuBody.querySelectorAll<HTMLButtonElement>('[data-login-method]')) {
      btn.addEventListener('click', () => {
        const method = btn.dataset.loginMethod as AuthDappLoginMethod | undefined
        if (method) void this.runLoginMethod(method)
      })
    }
  }

  private renderSignInMenu(): string {
    const disabled = this.busy ? 'disabled' : ''
    return `
      <div class="social-profile-menu__section">
        <p class="social-profile-menu__hint">Log in with Google, Discord, Apple, X, or a wallet — same as Explorer.</p>
        <p class="social-profile-menu__status" data-signin-status hidden></p>
        <div class="explorer-auth-verify social-profile-menu__verify" data-verify hidden>
          <p class="explorer-auth-verify__label">Verify Sign In</p>
          <p class="explorer-auth-verify__hint">Does this number match the one in the login tab?</p>
          <p class="explorer-auth-verify__code" data-verify-code aria-live="polite">—</p>
          <p class="explorer-auth-verify__wait">Waiting for confirmation…</p>
        </div>
        <button type="button" class="social-profile-menu__wallet-btn" data-login-method="google" ${disabled}>
          <span class="social-profile-menu__wallet-btn-icon" aria-hidden="true">${ICON_GOOGLE}</span>
          <span>Continue with Google</span>
        </button>
        <button type="button" class="social-profile-menu__wallet-btn social-profile-menu__wallet-btn--secondary" data-login-method="metamask" ${disabled}>
          <span class="social-profile-menu__wallet-btn-icon" aria-hidden="true">${ICON_METAMASK}</span>
          <span>Continue with MetaMask</span>
        </button>
        <p class="social-profile-menu__or">or continue with</p>
        <div class="social-profile-menu__provider-row" role="group" aria-label="More sign-in options">
          <button type="button" class="social-profile-menu__provider-btn" data-login-method="discord" title="Discord" aria-label="Discord" ${disabled}>${ICON_DISCORD}</button>
          <button type="button" class="social-profile-menu__provider-btn" data-login-method="apple" title="Apple" aria-label="Apple" ${disabled}>${ICON_APPLE}</button>
          <button type="button" class="social-profile-menu__provider-btn" data-login-method="x" title="X" aria-label="X" ${disabled}>${ICON_X}</button>
          <button type="button" class="social-profile-menu__provider-btn" data-login-method="wallet-connect" title="WalletConnect" aria-label="WalletConnect" ${disabled}>${ICON_WALLET_CONNECT}</button>
        </div>
        <button type="button" class="social-profile-menu__ghost-btn" data-guest ${disabled}>
          Continue as Guest
        </button>
      </div>
    `
  }

  private renderSignedInMenu(): string {
    if (this.login.kind !== 'wallet') return ''
    const address = this.login.address
    const name = this.displayName?.trim() || walletShort(address)
    return `
      <div class="social-profile-menu__connection" role="group" aria-label="Connection">
        <div class="social-profile-menu__connection-label">Connection</div>
        <div class="social-profile-menu__pill">
          <span class="social-profile-menu__pill-dot" aria-hidden="true"></span>
          Wallet
        </div>
        <p class="social-profile-menu__connection-primary">${escapeHtml(name)}</p>
        <button
          type="button"
          class="social-profile-menu__connection-meta social-profile-menu__wallet-copy"
          data-copy-wallet
          data-wallet="${escapeHtml(address)}"
          title="Click to copy full address"
          aria-label="Copy wallet address ${escapeHtml(address)}"
        >
          <code class="social-profile-menu__wallet-code">${escapeHtml(walletShort(address))}</code>
          <span class="social-profile-menu__wallet-copy-hint" data-copy-hint>Copy</span>
        </button>
      </div>
      <div class="social-profile-menu__items">
        <label class="social-profile-menu__toggle-row">
          <span class="social-profile-menu__toggle-label">Notifications</span>
          <span class="social-profile-menu__toggle">
            <input type="checkbox" data-notifications-toggle ${notificationPrefs.isEnabled() ? 'checked' : ''} />
            <span class="social-profile-menu__toggle-track" aria-hidden="true"></span>
          </span>
        </label>
        <button type="button" class="social-profile-menu__item" data-open-profile>
          <span class="social-profile-menu__item-icon" aria-hidden="true">${ICON_GUEST_HEAD}</span>
          <span>View profile</span>
        </button>
        <button type="button" class="social-profile-menu__item" data-open-settings>
          <span class="social-profile-menu__item-icon" aria-hidden="true">${ICON_SETTINGS}</span>
          <span>Settings</span>
        </button>
        <button type="button" class="social-profile-menu__item" data-open-backpack>
          <span class="social-profile-menu__item-icon" aria-hidden="true">${ICON_BACKPACK}</span>
          <span>Backpack</span>
        </button>
      </div>
      <div class="social-profile-menu__actions">
        <button type="button" class="social-profile-menu__item social-profile-menu__item--danger" data-sign-out>
          <span class="social-profile-menu__item-icon" aria-hidden="true">${ICON_SIGN_OUT}</span>
          <span>Sign out</span>
        </button>
      </div>
    `
  }

  private wireSignInMenu(): void {
    for (const btn of this.menuBody.querySelectorAll<HTMLButtonElement>('[data-login-method]')) {
      btn.addEventListener('click', () => {
        const method = btn.dataset.loginMethod as AuthDappLoginMethod | undefined
        if (method) void this.runLoginMethod(method)
      })
    }
    this.menuBody.querySelector('[data-guest]')?.addEventListener('click', () => {
      if (this.busy) return
      this.busy = true
      void ensureGuestSession()
        .then((login) => {
          this.onLoginChange?.(login)
          this.setLogin(login)
          this.close()
        })
        .finally(() => {
          this.busy = false
        })
    })
  }

  private wireSignedInMenu(): void {
    const notifToggle = this.menuBody.querySelector<HTMLInputElement>('[data-notifications-toggle]')
    notifToggle?.addEventListener('change', () => {
      notificationPrefs.setEnabled(notifToggle.checked)
    })

    this.menuBody.querySelector('[data-copy-wallet]')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement
      const value = btn.dataset.wallet?.trim()
      if (!value) return
      const hint = btn.querySelector('[data-copy-hint]') as HTMLElement | null
      try {
        await navigator.clipboard.writeText(value)
        btn.classList.add('is-copied')
        if (hint) hint.textContent = 'Copied!'
        window.setTimeout(() => {
          btn.classList.remove('is-copied')
          if (hint) hint.textContent = 'Copy'
        }, 1400)
      } catch {
        if (hint) hint.textContent = 'Failed'
        window.setTimeout(() => {
          if (hint) hint.textContent = 'Copy'
        }, 1400)
      }
    })

    this.menuBody.querySelector('[data-sign-out]')?.addEventListener('click', () => {
      this.close()
      this.onSignOut?.()
    })
    this.menuBody.querySelector('[data-open-profile]')?.addEventListener('click', () => {
      this.close()
      if (this.onOpenProfile) this.onOpenProfile()
    })
    this.menuBody.querySelector('[data-open-settings]')?.addEventListener('click', () => {
      this.close()
      if (this.onOpenSettings) this.onOpenSettings()
      else window.alert('Settings are available from the in-world menu after you jump in.')
    })
    this.menuBody.querySelector('[data-open-backpack]')?.addEventListener('click', () => {
      this.close()
      if (this.onOpenBackpack) this.onOpenBackpack()
      else window.alert('Open your backpack from the in-world sidebar after you jump into a scene.')
    })
  }

  private setSignInStatus(msg: string | null, isError = false): void {
    const el = this.menuBody.querySelector('[data-signin-status]') as HTMLElement | null
    if (!el) return
    if (!msg) {
      el.hidden = true
      el.textContent = ''
      el.className = 'social-profile-menu__status'
      return
    }
    el.hidden = false
    el.textContent = msg
    el.className = `social-profile-menu__status${isError ? ' social-profile-menu__status--error' : ''}`
  }

  private setVerifyCode(code: number | null | undefined): void {
    const box = this.menuBody.querySelector('[data-verify]') as HTMLElement | null
    const num = this.menuBody.querySelector('[data-verify-code]') as HTMLElement | null
    if (!box || !num) return
    if (code == null || !Number.isFinite(code)) {
      box.hidden = true
      num.textContent = '—'
      return
    }
    box.hidden = false
    num.textContent = String(Math.trunc(code)).padStart(2, '0')
  }

  private onAuthProgress = (p: AuthProgress): void => {
    this.setSignInStatus(p.message)
    if (p.verificationCode !== undefined) this.setVerifyCode(p.verificationCode)
  }

  private async runLoginMethod(method: AuthDappLoginMethod): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.setVerifyCode(null)
    this.setSignInStatus('Connecting…')
    for (const btn of this.menuBody.querySelectorAll('button')) {
      ;(btn as HTMLButtonElement).disabled = true
    }
    try {
      const result =
        method === 'metamask'
          ? await loginWithMetaMask((msg) => this.setSignInStatus(msg)).catch(async (err) => {
              const msg = err instanceof Error ? err.message : String(err)
              if (/not found|install/i.test(msg)) {
                this.setSignInStatus('Opening Decentraland login…')
                return loginWithProvider('metamask', this.onAuthProgress)
              }
              throw err
            })
          : await loginWithProvider(method, this.onAuthProgress)
      this.setVerifyCode(null)
      this.busy = false
      this.onLoginChange?.(result)
      this.setLogin(result)
      this.close()
    } catch (err) {
      // Keep verification code visible if we already have one — user may still
      // need it, or retry after a transient error.
      const msg = err instanceof Error ? err.message : String(err)
      this.setSignInStatus(msg, true)
      for (const btn of this.menuBody.querySelectorAll('button')) {
        ;(btn as HTMLButtonElement).disabled = false
      }
      this.busy = false
    }
  }
}