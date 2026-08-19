import type { AuthDappLoginMethod, AuthProgress, LoginResult } from '../../../auth/AuthClient'
import { loginWithMetaMask, loginWithProvider, openAuthWindow } from '../../../auth/AuthClient'
import { getGuestPrivateKeyHex } from '../../../auth/guestIdentity'
import { ensureGuestSession } from '../../auth/resolveInitialLogin'
import { identityFromAvatarProfile } from '../../../avatar/displayName'
import {
  deployDisplayName,
  resolveClaimedName,
  type DisplayNameChoice
} from '../../../avatar/displayNameDeploy'
import { createFallbackGuestAvatarProfile } from '../../../avatar/guestProfile'
import { fetchProfileCached, fetchProfileFaceUrl } from '../../../avatar/peerApi'
import { DisplayNameEditor } from '../profile/DisplayNameEditor'
import { notificationPrefs } from '../../../social/notificationPrefs'
import {
  ICON_APPLE,
  ICON_DISCORD,
  ICON_GOOGLE,
  ICON_METAMASK,
  ICON_WALLET_CONNECT,
  ICON_X
} from './explorerAuthIcons'
import { backpackCategoryIcon } from '../settings/backpackCategoryIcons'

export type SocialProfileMenuOptions = {
  login: LoginResult
  onLoginChange?: (login: LoginResult) => void
  onSignOut?: () => void
  onOpenSettings?: () => void
  onOpenBackpack?: () => void
  onOpenProfile?: () => void
  onOpenWhatsNew?: () => void
}

const ICON_GUEST_HEAD = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5Z" fill="currentColor" fill-opacity="0.9"/></svg>`
const ICON_SIGN_OUT = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
// Shared "accepted" backpack mark — same glyph as the backpack categories "All" row.
const ICON_BACKPACK = backpackCategoryIcon('all')
const ICON_SETTINGS = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
const ICON_WHATS_NEW = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M7 4h10a2 2 0 0 1 2 2v14l-3.5-2.2L12 20l-3.5-2.2L5 20V6a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 9h6M9 12h6M9 15h3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`

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
  private nameEditor: DisplayNameEditor | null = null
  private readonly onLoginChange?: (login: LoginResult) => void
  private readonly onSignOut?: () => void
  private readonly onOpenSettings?: () => void
  private readonly onOpenBackpack?: () => void
  private readonly onOpenProfile?: () => void
  private readonly onOpenWhatsNew?: () => void
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
    this.onOpenWhatsNew = opts.onOpenWhatsNew

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
    this.disposeNameEditor()
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
    this.disposeNameEditor()
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
      // Never rebuild the menu while a login is in flight — that wiped status UI and
      // left `busy` true so further clicks silently no-op'd.
      if (this.open && !this.busy) this.renderMenu()
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
    const profileUrl = address
      ? `https://peer.decentraland.org/lambdas/profiles/${encodeURIComponent(address)}`
      : ''
    const hasKey = Boolean(getGuestPrivateKeyHex())
    return `
      <div class="social-profile-menu__identity">
        <div class="social-profile-menu__name">${escapeHtml(name)}</div>
        <div class="social-profile-menu__sub">Guest on this device</div>
        <button type="button" class="social-profile-menu__wallet-copy social-profile-menu__guest-addr" data-copy-guest-wallet data-wallet="${escapeHtml(address)}" title="Click to copy full address">
          <code class="social-profile-menu__wallet-code">${escapeHtml(address)}</code>
          <span class="social-profile-menu__wallet-copy-hint" data-copy-hint>Copy</span>
        </button>
        ${
          hasKey
            ? `<div class="social-profile-menu__guest-key" data-guest-key-block>
          <button type="button" class="social-profile-menu__guest-key-toggle" data-reveal-guest-key aria-expanded="false">
            Reveal guest private key
          </button>
          <div class="social-profile-menu__guest-key-panel" data-guest-key-panel hidden>
            <code class="social-profile-menu__guest-key-value" data-guest-key-value></code>
            <button type="button" class="social-profile-menu__guest-key-copy" data-copy-guest-key>
              Copy private key
            </button>
          </div>
        </div>`
            : ''
        }
        ${
          profileUrl
            ? `<a class="social-profile-menu__catalyst-link" href="${escapeHtml(profileUrl)}" target="_blank" rel="noopener noreferrer">View on Catalyst ↗</a>`
            : ''
        }
      </div>
      <div class="social-profile-menu__guest-warning" role="note">
        <strong>Browser-only guest wallet.</strong>
        This key lives only on this device and origin. Clearing site data, private mode, or another browser creates a <em>new</em> guest — wearables or tokens sent here cannot be recovered without this private key. Do not send valuables unless you have exported and stored the key.
      </div>
      <p class="social-profile-menu__hint">
        Stable guest for chat &amp; LiveKit. Sign in to claim wearables &amp; ownership tools — same accounts as Explorer.
      </p>
      <div class="social-profile-menu__items">
        <button type="button" class="social-profile-menu__item" data-open-whats-new>
          <span class="social-profile-menu__item-icon" aria-hidden="true">${ICON_WHATS_NEW}</span>
          <span>What's new</span>
        </button>
      </div>
      <div class="social-profile-menu__actions social-profile-menu__actions--signin">
        <p class="social-profile-menu__status" data-signin-status hidden></p>
        <div class="explorer-auth-verify social-profile-menu__verify" data-verify hidden>
          <p class="explorer-auth-verify__label">Verify Sign In</p>
          <p class="explorer-auth-verify__hint">Does this number match the one in the login tab?</p>
          <p class="explorer-auth-verify__code" data-verify-code aria-live="polite">—</p>
          <p class="explorer-auth-verify__wait">Waiting for confirmation…</p>
        </div>
        <button type="button" class="social-profile-menu__wallet-btn" data-login-method="google">
          <span class="social-profile-menu__wallet-btn-icon" aria-hidden="true">${ICON_GOOGLE}</span>
          <span>Continue with Google</span>
        </button>
        <button type="button" class="social-profile-menu__wallet-btn social-profile-menu__wallet-btn--secondary" data-login-method="metamask">
          <span class="social-profile-menu__wallet-btn-icon" aria-hidden="true">${ICON_METAMASK}</span>
          <span>Continue with MetaMask</span>
        </button>
        <p class="social-profile-menu__or">or continue with</p>
        <div class="social-profile-menu__provider-row" role="group" aria-label="More sign-in options">
          <button type="button" class="social-profile-menu__provider-btn" data-login-method="discord" title="Discord" aria-label="Discord">${ICON_DISCORD}</button>
          <button type="button" class="social-profile-menu__provider-btn" data-login-method="apple" title="Apple" aria-label="Apple">${ICON_APPLE}</button>
          <button type="button" class="social-profile-menu__provider-btn" data-login-method="x" title="X" aria-label="X">${ICON_X}</button>
          <button type="button" class="social-profile-menu__provider-btn" data-login-method="wallet-connect" title="WalletConnect" aria-label="WalletConnect">${ICON_WALLET_CONNECT}</button>
        </div>
      </div>
    `
  }

  private wireGuestMenu(): void {
    this.wireWhatsNewItem()
    // Full provider set (same as signed-out sign-in sheet).
    for (const btn of this.menuBody.querySelectorAll<HTMLButtonElement>('[data-login-method]')) {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        const method = btn.dataset.loginMethod as AuthDappLoginMethod | undefined
        if (method) this.runLoginMethod(method)
      })
    }
    this.menuBody.querySelector('[data-copy-guest-wallet]')?.addEventListener('click', async (ev) => {
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
      }
    })

    const revealBtn = this.menuBody.querySelector<HTMLButtonElement>('[data-reveal-guest-key]')
    const panel = this.menuBody.querySelector<HTMLElement>('[data-guest-key-panel]')
    const keyValue = this.menuBody.querySelector<HTMLElement>('[data-guest-key-value]')
    const copyKeyBtn = this.menuBody.querySelector<HTMLButtonElement>('[data-copy-guest-key]')

    revealBtn?.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      if (!panel || !keyValue || !revealBtn) return
      const open = panel.hidden
      if (open) {
        const pk = getGuestPrivateKeyHex()
        if (!pk) {
          keyValue.textContent = 'Key not available on this device.'
          panel.hidden = false
          revealBtn.textContent = 'Hide guest private key'
          revealBtn.setAttribute('aria-expanded', 'true')
          return
        }
        keyValue.textContent = pk
        panel.hidden = false
        revealBtn.textContent = 'Hide guest private key'
        revealBtn.setAttribute('aria-expanded', 'true')
      } else {
        keyValue.textContent = ''
        panel.hidden = true
        revealBtn.textContent = 'Reveal guest private key'
        revealBtn.setAttribute('aria-expanded', 'false')
      }
    })

    copyKeyBtn?.addEventListener('click', async (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      const pk = getGuestPrivateKeyHex()
      if (!pk || !copyKeyBtn) return
      try {
        await navigator.clipboard.writeText(pk)
        const prev = copyKeyBtn.textContent
        copyKeyBtn.textContent = 'Copied!'
        copyKeyBtn.classList.add('is-copied')
        window.setTimeout(() => {
          copyKeyBtn.textContent = prev || 'Copy private key'
          copyKeyBtn.classList.remove('is-copied')
        }, 1400)
      } catch {
        copyKeyBtn.textContent = 'Copy failed'
      }
    })
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
        <div class="social-profile-menu__name-row">
          <p class="social-profile-menu__connection-primary">${escapeHtml(name)}</p>
          <button type="button" class="social-profile-menu__edit-name" data-edit-name aria-label="Edit display name">✎</button>
        </div>
        <div class="social-profile-menu__name-edit" data-name-edit hidden></div>
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
        <button type="button" class="social-profile-menu__item" data-open-whats-new>
          <span class="social-profile-menu__item-icon" aria-hidden="true">${ICON_WHATS_NEW}</span>
          <span>What's new</span>
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
      btn.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        const method = btn.dataset.loginMethod as AuthDappLoginMethod | undefined
        if (method) this.runLoginMethod(method)
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

  private disposeNameEditor(): void {
    this.nameEditor?.dispose()
    this.nameEditor = null
  }

  private wireNameEditor(): void {
    this.menuBody.querySelector('[data-edit-name]')?.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      void this.toggleNameEditor()
    })
  }

  private async toggleNameEditor(): Promise<void> {
    const host = this.menuBody.querySelector('[data-name-edit]') as HTMLElement | null
    if (!host) return
    if (this.nameEditor) {
      this.disposeNameEditor()
      host.hidden = true
      host.innerHTML = ''
      return
    }
    const address = this.login.address
    const current =
      this.displayName ||
      (this.login.kind === 'guest' ? this.login.displayName : address.slice(0, 8))
    const claimedName = await resolveClaimedName(address)
    const editor = new DisplayNameEditor({
      currentName: current,
      claimedName,
      hasClaimedName: !!claimedName && claimedName === current,
      onSave: (choice) => this.saveDisplayName(choice)
    })
    this.nameEditor = editor
    host.hidden = false
    host.appendChild(editor.root)
  }

  private async saveDisplayName(choice: DisplayNameChoice): Promise<void> {
    if (this.login.kind !== 'wallet') {
      throw new Error('Sign in with a wallet to change your name')
    }
    const address = this.login.address
    const identity = this.login.identity
    const profile =
      (await fetchProfileCached(address)) ??
      createFallbackGuestAvatarProfile(address, address.slice(0, 8))
    const result = await deployDisplayName({
      address,
      identity,
      profile,
      choice
    })
    const displayName =
      (result.entry.hasClaimedName
        ? result.entry.name?.trim()
        : result.entry.unclaimedName?.trim() || result.entry.name?.trim()) || this.displayName || 'Guest'
    this.displayName = displayName
    this.renderMenu()
  }

  private wireWhatsNewItem(): void {
    this.menuBody.querySelector('[data-open-whats-new]')?.addEventListener('click', () => {
      this.close()
      this.onOpenWhatsNew?.()
    })
  }

  private wireSignedInMenu(): void {
    this.wireNameEditor()
    this.wireWhatsNewItem()
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

  private setLoginButtonsDisabled(disabled: boolean): void {
    for (const btn of this.menuBody.querySelectorAll<HTMLButtonElement>('[data-login-method], [data-guest]')) {
      btn.disabled = disabled
    }
  }

  /**
   * Must stay synchronous until window.open — browsers only allow popups on a direct gesture.
   * Do not mark this `async`; open the auth tab first, then continue in a promise.
   */
  private runLoginMethod(method: AuthDappLoginMethod): void {
    if (this.busy) return
    this.busy = true
    this.setVerifyCode(null)
    this.setLoginButtonsDisabled(true)

    // Open auth window NOW (same call stack as the click). MetaMask uses extension; still open
    // a placeholder only for auth-dapp methods so await cannot lose the gesture.
    const useAuthDapp = method !== 'metamask'
    let authWindow: Window | null = null
    if (useAuthDapp) {
      this.setSignInStatus('Opening Decentraland login…')
      authWindow = openAuthWindow('about:blank')
      if (!authWindow) {
        this.busy = false
        this.setLoginButtonsDisabled(false)
        this.setSignInStatus(
          'Tab blocked — allow popups for this site, then try again.',
          true
        )
        return
      }
    } else {
      this.setSignInStatus('Connecting to MetaMask…')
    }

    void this.finishLoginMethod(method, authWindow)
  }

  private async finishLoginMethod(
    method: AuthDappLoginMethod,
    authWindow: Window | null
  ): Promise<void> {
    try {
      const result =
        method === 'metamask'
          ? await loginWithMetaMask((msg) => this.setSignInStatus(msg)).catch(async (err) => {
              const msg = err instanceof Error ? err.message : String(err)
              if (/not found|install|rejected|denied/i.test(msg)) {
                this.setSignInStatus('Opening Decentraland login…')
                const w = authWindow && !authWindow.closed ? authWindow : openAuthWindow('about:blank')
                if (!w) {
                  throw new Error('Tab blocked — allow popups for this site and try again')
                }
                return loginWithProvider('metamask', this.onAuthProgress, { authWindow: w })
              }
              throw err
            })
          : await loginWithProvider(method, this.onAuthProgress, { authWindow })
      this.setVerifyCode(null)
      this.onLoginChange?.(result)
      this.setLogin(result)
      this.close()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.setSignInStatus(msg, true)
    } finally {
      this.busy = false
      this.setLoginButtonsDisabled(false)
    }
  }
}