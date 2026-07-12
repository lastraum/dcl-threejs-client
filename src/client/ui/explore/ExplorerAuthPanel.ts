import type { AuthDappLoginMethod, LoginResult } from '../../../auth/AuthClient'
import { loginWithMetaMask, loginWithProvider } from '../../../auth/AuthClient'
import {
  ICON_APPLE,
  ICON_DISCORD,
  ICON_GOOGLE,
  ICON_METAMASK,
  ICON_WALLET_CONNECT,
  ICON_X
} from './explorerAuthIcons'

export type ExplorerAuthPanelOptions = {
  onComplete: (result: LoginResult) => void
  onClose?: () => void
}

type SocialDef = {
  method: AuthDappLoginMethod
  label: string
  icon: string
  primary?: boolean
}

const SOCIAL_PRIMARY: SocialDef[] = [
  { method: 'google', label: 'Google', icon: ICON_GOOGLE, primary: true },
  { method: 'metamask', label: 'MetaMask', icon: ICON_METAMASK, primary: true }
]

const SOCIAL_MORE: SocialDef[] = [
  { method: 'discord', label: 'Discord', icon: ICON_DISCORD },
  { method: 'apple', label: 'Apple', icon: ICON_APPLE },
  { method: 'x', label: 'X', icon: ICON_X },
  { method: 'wallet-connect', label: 'WalletConnect', icon: ICON_WALLET_CONNECT }
]

/**
 * Sign-in sheet — DCL auth dapp methods (Google/Discord/Apple/X/WalletConnect)
 * open https://decentraland.org/auth/login?loginMethod=… ; MetaMask uses local provider.
 */
export class ExplorerAuthPanel {
  readonly root: HTMLElement

  private readonly statusEl: HTMLElement
  private readonly moreEl: HTMLElement
  private readonly moreToggle: HTMLButtonElement
  private moreOpen = true
  private busy = false

  constructor(private readonly opts: ExplorerAuthPanelOptions) {
    this.root = document.createElement('div')
    this.root.className = 'explorer-auth-panel'
    this.root.setAttribute('hidden', '')
    this.root.innerHTML = `
      <div class="explorer-auth-panel__backdrop" data-close></div>
      <div class="explorer-auth-panel__sheet" role="dialog" aria-label="Log in or Sign up" aria-modal="true">
        <button type="button" class="explorer-auth-panel__close" data-close aria-label="Close">&times;</button>
        <h2 class="explorer-auth-panel__title">Log in or Sign up</h2>
        <p class="explorer-auth-panel__subtitle">
          Use Google, Discord, Apple, X, or a wallet via Decentraland’s auth — same accounts as Explorer.
        </p>
        <p class="explorer-auth-panel__status" data-status hidden></p>
        <div class="explorer-auth-panel__actions" data-primary></div>
        <div class="explorer-auth-panel__divider" role="separator">
          <span>or continue with</span>
        </div>
        <button type="button" class="explorer-auth-panel__more-toggle is-open" data-more-toggle aria-expanded="true">
          More options
          <span class="explorer-auth-panel__chevron" aria-hidden="true">▾</span>
        </button>
        <div class="explorer-auth-panel__more" data-more>
          <div class="explorer-auth-panel__icon-row" data-more-icons></div>
        </div>
        <button type="button" class="explorer-auth-panel__btn explorer-auth-panel__btn--ghost" data-guest>
          Continue as Guest
        </button>
      </div>
    `

    this.statusEl = this.root.querySelector('[data-status]')!
    this.moreEl = this.root.querySelector('[data-more]')!
    this.moreToggle = this.root.querySelector('[data-more-toggle]')!

    const primary = this.root.querySelector('[data-primary]')!
    for (const def of SOCIAL_PRIMARY) {
      primary.appendChild(this.makeSocialButton(def, true))
    }

    const moreIcons = this.root.querySelector('[data-more-icons]')!
    for (const def of SOCIAL_MORE) {
      moreIcons.appendChild(this.makeIconButton(def))
    }

    for (const el of this.root.querySelectorAll('[data-close]')) {
      el.addEventListener('click', () => this.close())
    }

    this.moreToggle.addEventListener('click', () => this.toggleMore())
    this.root.querySelector('[data-guest]')!.addEventListener('click', () => {
      if (this.busy) return
      this.opts.onComplete({ kind: 'guest' })
      this.close()
    })
  }

  mount(): void {
    document.body.appendChild(this.root)
  }

  open(): void {
    this.root.removeAttribute('hidden')
  }

  close(): void {
    this.root.setAttribute('hidden', '')
    this.setStatus(null)
    this.setBusy(false)
    this.opts.onClose?.()
  }

  dispose(): void {
    this.root.remove()
  }

  private toggleMore(): void {
    this.moreOpen = !this.moreOpen
    this.moreEl.hidden = !this.moreOpen
    this.moreToggle.setAttribute('aria-expanded', this.moreOpen ? 'true' : 'false')
    this.moreToggle.classList.toggle('is-open', this.moreOpen)
  }

  private makeSocialButton(def: SocialDef, fullWidth: boolean): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = fullWidth
      ? `explorer-auth-panel__btn ${def.primary ? 'explorer-auth-panel__btn--social' : 'explorer-auth-panel__btn--ghost'}`
      : 'explorer-auth-panel__icon-btn'
    btn.dataset.method = def.method
    if (fullWidth) {
      btn.innerHTML = `<span class="explorer-auth-panel__btn-icon" aria-hidden="true">${def.icon}</span><span>${def.label}</span>`
    } else {
      btn.innerHTML = def.icon
      btn.title = def.label
      btn.setAttribute('aria-label', def.label)
    }
    btn.addEventListener('click', () => void this.runMethod(def.method))
    return btn
  }

  private makeIconButton(def: SocialDef): HTMLButtonElement {
    return this.makeSocialButton(def, false)
  }

  private setStatus(msg: string | null, isError = false): void {
    if (!msg) {
      this.statusEl.hidden = true
      this.statusEl.textContent = ''
      this.statusEl.className = 'explorer-auth-panel__status'
      return
    }
    this.statusEl.hidden = false
    this.statusEl.textContent = msg
    this.statusEl.className = `explorer-auth-panel__status${isError ? ' is-error' : ''}`
  }

  private setBusy(busy: boolean): void {
    this.busy = busy
    for (const btn of this.root.querySelectorAll('button')) {
      if ((btn as HTMLElement).hasAttribute('data-close')) continue
      ;(btn as HTMLButtonElement).disabled = busy
    }
  }

  private async runMethod(method: AuthDappLoginMethod): Promise<void> {
    if (this.busy) return
    this.setBusy(true)
    this.setStatus('Connecting…')
    try {
      // Local MetaMask when extension/SDK available — skip auth dapp hop.
      const result =
        method === 'metamask'
          ? await loginWithMetaMask((msg) => this.setStatus(msg)).catch(async (err) => {
              // Fall back to auth dapp if local MetaMask fails (e.g. not installed).
              const msg = err instanceof Error ? err.message : String(err)
              if (/not found|install/i.test(msg)) {
                this.setStatus('Opening Decentraland login…')
                return loginWithProvider('metamask', (m) => this.setStatus(m))
              }
              throw err
            })
          : await loginWithProvider(method, (msg) => this.setStatus(msg))

      this.opts.onComplete(result)
      this.close()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.setStatus(msg, true)
      this.setBusy(false)
    }
  }
}
