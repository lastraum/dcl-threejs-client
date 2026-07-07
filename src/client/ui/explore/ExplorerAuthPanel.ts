import type { LoginResult } from '../../../auth/AuthClient'
import { loginWithMetaMask } from '../../../auth/AuthClient'
import { ICON_METAMASK } from './explorerAuthIcons'

export type ExplorerAuthPanelOptions = {
  onComplete: (result: LoginResult) => void
  onClose?: () => void
}

/** Compact sign-in sheet — companion ExploreProfileMenu parity (wallet + guest). */
export class ExplorerAuthPanel {
  readonly root: HTMLElement

  private readonly statusEl: HTMLElement
  private busy = false

  constructor(private readonly opts: ExplorerAuthPanelOptions) {
    this.root = document.createElement('div')
    this.root.className = 'explorer-auth-panel'
    this.root.setAttribute('hidden', '')
    this.root.innerHTML = `
      <div class="explorer-auth-panel__backdrop" data-close></div>
      <div class="explorer-auth-panel__sheet" role="dialog" aria-label="Sign in" aria-modal="true">
        <button type="button" class="explorer-auth-panel__close" data-close aria-label="Close">&times;</button>
        <h2 class="explorer-auth-panel__title">Sign in to Decentraland</h2>
        <p class="explorer-auth-panel__subtitle">Connect your wallet for favorites, chat, and voice.</p>
        <p class="explorer-auth-panel__status" data-status hidden></p>
        <div class="explorer-auth-panel__actions">
          <button type="button" class="explorer-auth-panel__btn explorer-auth-panel__btn--primary" data-metamask>
            <span class="explorer-auth-panel__btn-icon" aria-hidden="true">${ICON_METAMASK}</span>
            Continue with MetaMask
          </button>
          <button type="button" class="explorer-auth-panel__btn explorer-auth-panel__btn--ghost" data-guest>
            Continue as Guest
          </button>
        </div>
      </div>
    `

    this.statusEl = this.root.querySelector('[data-status]')!

    for (const el of this.root.querySelectorAll('[data-close]')) {
      el.addEventListener('click', () => this.close())
    }

    this.root.querySelector('[data-metamask]')!.addEventListener('click', () => void this.runMetaMask())
    this.root.querySelector('[data-guest]')!.addEventListener('click', () => {
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
    this.opts.onClose?.()
  }

  dispose(): void {
    this.root.remove()
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

  private async runMetaMask(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.setStatus('Connecting…')
    for (const btn of this.root.querySelectorAll('button')) {
      ;(btn as HTMLButtonElement).disabled = true
    }
    try {
      const result = await loginWithMetaMask((msg) => this.setStatus(msg))
      this.opts.onComplete(result)
      this.close()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.setStatus(msg, true)
      for (const btn of this.root.querySelectorAll('button')) {
        ;(btn as HTMLButtonElement).disabled = false
      }
      this.busy = false
    }
  }
}

