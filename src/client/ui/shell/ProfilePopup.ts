import { shortenAddress } from '../../../avatar/displayName'
import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import type { AvatarProfile } from '../../../avatar/types'

export type ProfilePopupData = {
  address?: string
  profile: AvatarProfile | null
  isGuest: boolean
}

export type ProfilePopupHandlers = {
  onSignOut: () => void | Promise<void>
  onExit: () => void | Promise<void>
}

/** Explorer-style profile card anchored to the sidebar avatar button. */
export class ProfilePopup {
  private readonly root: HTMLElement
  private readonly backdrop: HTMLElement
  private open = false

  constructor(
    private readonly anchor: () => HTMLElement | undefined,
    private readonly getData: () => ProfilePopupData,
    private readonly handlers: ProfilePopupHandlers
  ) {
    this.backdrop = document.createElement('div')
    this.backdrop.className = 'profile-popup-backdrop'
    this.backdrop.hidden = true
    this.backdrop.addEventListener('click', () => this.hide())

    this.root = document.createElement('div')
    this.root.className = 'profile-popup'
    this.root.hidden = true
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', 'Profile menu')

    document.body.appendChild(this.backdrop)
    document.body.appendChild(this.root)

    window.addEventListener('keydown', this.onKeyDown)
  }

  toggle(): void {
    if (this.open) this.hide()
    else void this.show()
  }

  hide(): void {
    this.open = false
    this.root.hidden = true
    this.backdrop.hidden = true
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    this.root.remove()
    this.backdrop.remove()
  }

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') this.hide()
  }

  private async show(): Promise<void> {
    const anchor = this.anchor()
    if (!anchor) return

    const data = this.getData()
    await this.render(data)

    const rect = anchor.getBoundingClientRect()
    const panelWidth = 300
    const left = rect.right + 12
    const top = Math.max(12, rect.top - 8)

    this.root.style.left = `${Math.min(left, window.innerWidth - panelWidth - 12)}px`
    this.root.style.top = `${top}px`

    this.open = true
    this.root.hidden = false
    this.backdrop.hidden = false
  }

  private async render(data: ProfilePopupData): Promise<void> {
    const address = data.address?.toLowerCase()
    const displayName =
      data.profile?.displayName?.trim() ||
      (address ? shortenAddress(address) : 'Guest')
    const claimed = data.profile?.hasClaimedName ?? false
    const nameColor = data.profile?.nameColor ?? '#57e389'

    let faceUrl: string | null = null
    if (address) faceUrl = await fetchProfileFaceUrl(address)

    const profileUrl = address
      ? `https://decentraland.org/profile/accounts/${address}`
      : 'https://decentraland.org/profile'

    this.root.innerHTML = `
      <div class="profile-popup__hero">
        <div class="profile-popup__avatar-ring">
          ${
            faceUrl
              ? `<img class="profile-popup__avatar" src="${faceUrl}" alt="" decoding="async" />`
              : `<div class="profile-popup__avatar profile-popup__avatar--fallback">${displayName.charAt(0).toUpperCase()}</div>`
          }
        </div>
        <div class="profile-popup__name-row">
          <span class="profile-popup__name" style="color:${nameColor}">${escapeHtml(displayName)}</span>
          ${claimed ? '<span class="profile-popup__verified" title="Verified name">✓</span>' : ''}
        </div>
        ${
          address
            ? `<div class="profile-popup__wallet">
                <div class="profile-popup__wallet-label">Wallet address</div>
                <div class="profile-popup__wallet-row">
                  <code class="profile-popup__wallet-value">${shortenAddress(address)}</code>
                  <button type="button" class="profile-popup__copy" data-copy="${address}" aria-label="Copy wallet address">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/>
                      <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.6"/>
                    </svg>
                  </button>
                </div>
              </div>`
            : `<p class="profile-popup__guest-note">Guest session — sign in to save your avatar and join voice.</p>`
        }
      </div>
      <button type="button" class="profile-popup__view-btn">View profile</button>
      <div class="profile-popup__divider"></div>
      <button type="button" class="profile-popup__action profile-popup__action--signout">
        <span class="profile-popup__action-icon" aria-hidden="true">⏻</span>
        Sign out
      </button>
      <button type="button" class="profile-popup__action profile-popup__action--exit">
        <span class="profile-popup__action-icon" aria-hidden="true">↗</span>
        Exit
      </button>
      <div class="profile-popup__footer">
        <a href="https://decentraland.org/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a>
        <a href="https://decentraland.org/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
      </div>
    `

    this.root.querySelector('.profile-popup__view-btn')?.addEventListener('click', () => {
      window.open(profileUrl, '_blank', 'noopener,noreferrer')
    })

    this.root.querySelector('.profile-popup__copy')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement
      const value = btn.dataset.copy
      if (!value) return
      try {
        await navigator.clipboard.writeText(value)
        btn.classList.add('is-copied')
        setTimeout(() => btn.classList.remove('is-copied'), 1200)
      } catch {
        console.warn('[profile] clipboard copy failed')
      }
    })

    this.root.querySelector('.profile-popup__action--signout')?.addEventListener('click', () => {
      this.hide()
      void Promise.resolve(this.handlers.onSignOut())
    })

    this.root.querySelector('.profile-popup__action--exit')?.addEventListener('click', () => {
      this.hide()
      void Promise.resolve(this.handlers.onExit())
    })
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
