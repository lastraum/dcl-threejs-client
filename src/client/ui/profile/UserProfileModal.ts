import { shortenAddress } from '../../../avatar/displayName'
import { fetchProfileFaceUrl, resolveRemotePeerProfile } from '../../../avatar/peerApi'
import type { AvatarProfile } from '../../../avatar/types'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import type { SocialService } from '../../../social/SocialService'
import { AvatarPreviewMini } from './AvatarPreviewMini'
import {
  filterEquippedWearables,
  guessWearableRarity,
  wearableShortLabel,
  wearableThumbnailUrl
} from './wearableThumb'

export type UserProfileModalTarget =
  | { kind: 'local' }
  | { kind: 'remote'; address: string }

type TabId = 'overview' | 'badges' | 'photos'

/** Full profile card — opens from context menu, chat, or sidebar. */
export class UserProfileModal {
  private readonly root: HTMLElement
  private readonly backdrop: HTMLElement
  private visible = false
  private target: UserProfileModalTarget | null = null
  private activeTab: TabId = 'overview'
  private preview: AvatarPreviewMini | null = null

  constructor(
    private readonly session: SessionIdentity,
    private readonly social: SocialService,
    private readonly getPeerUrl: () => string
  ) {
    this.backdrop = document.createElement('div')
    this.backdrop.className = 'user-profile-modal-backdrop'
    this.backdrop.hidden = true
    this.backdrop.addEventListener('click', () => this.hide())

    this.root = document.createElement('div')
    this.root.className = 'user-profile-modal'
    this.root.hidden = true
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', 'User profile')

    document.body.appendChild(this.backdrop)
    document.body.appendChild(this.root)

    window.addEventListener('keydown', this.onKeyDown)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    this.preview?.dispose()
    this.preview = null
    this.root.remove()
    this.backdrop.remove()
  }

  isOpen(): boolean {
    return this.visible
  }

  async show(target: UserProfileModalTarget): Promise<void> {
    if (document.pointerLockElement) document.exitPointerLock()
    this.target = target
    this.activeTab = 'overview'
    await this.render()
    this.visible = true
    this.root.hidden = false
    this.backdrop.hidden = false
  }

  hide(): void {
    this.visible = false
    this.target = null
    this.preview?.dispose()
    this.preview = null
    this.root.hidden = true
    this.backdrop.hidden = true
  }

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') this.hide()
  }

  private async render(): Promise<void> {
    if (!this.target) return

    const peerUrl = this.getPeerUrl()
    let address: string | undefined
    let profile: AvatarProfile | null = null
    let isSelf = false

    if (this.target.kind === 'local') {
      address = this.session.getAddress() ?? undefined
      profile = this.session.getProfile()
      isSelf = true
    } else {
      address = this.target.address.toLowerCase()
      isSelf = address === this.session.getAddress()?.toLowerCase()
      await this.social.ensurePeerProfile(address)
      profile = await resolveRemotePeerProfile(address, peerUrl)
    }

    const peer = address ? this.social.getPeerDisplay(address) : this.social.getLocalDisplay()
    const displayName = profile?.displayName?.trim() || peer.displayName
    const nameColor = profile?.nameColor ?? peer.nameColor
    const claimed = profile?.hasClaimedName ?? false
    const faceUrl = address ? await fetchProfileFaceUrl(address, peerUrl) : null
    const profileUrl = address
      ? `https://decentraland.org/profile/accounts/${address}`
      : 'https://decentraland.org/profile'

    const wearables = profile ? filterEquippedWearables(profile.wearables) : []
    const equippedHtml = wearables.length
      ? wearables
          .slice(0, 12)
          .map((urn) => {
            const rarity = guessWearableRarity(urn)
            return `
              <article class="user-profile-modal__wearable">
                <div class="user-profile-modal__wearable-thumb">
                  <img src="${wearableThumbnailUrl(urn, peerUrl)}" alt="" loading="lazy" />
                </div>
                <div class="user-profile-modal__wearable-name">${escapeHtml(wearableShortLabel(urn))}</div>
                <div class="user-profile-modal__wearable-rarity">${rarity}</div>
              </article>
            `
          })
          .join('')
      : `<p class="user-profile-modal__empty">No equipped wearables loaded.</p>`

    this.root.innerHTML = `
      <header class="user-profile-modal__header">
        <div class="user-profile-modal__header-main">
          <div class="user-profile-modal__title-row">
            <h2 class="user-profile-modal__title" style="color:${nameColor}">${escapeHtml(displayName)}</h2>
            ${claimed ? '<span class="user-profile-modal__verified" title="Verified name">✓</span>' : ''}
          </div>
          ${
            address
              ? `<div class="user-profile-modal__wallet-row">
                  <code class="user-profile-modal__wallet">${shortenAddress(address)}</code>
                  <button type="button" class="user-profile-modal__copy" data-copy="${address}" aria-label="Copy wallet address">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/>
                      <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.6"/>
                    </svg>
                  </button>
                </div>`
              : ''
          }
          <div class="user-profile-modal__mutual">Scene player</div>
        </div>
        <div class="user-profile-modal__header-actions">
          ${isSelf ? '' : `<button type="button" class="user-profile-modal__add-friend">+ Add Friend</button>`}
          <button type="button" class="user-profile-modal__icon-btn" data-action="external" aria-label="Open on decentraland.org">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 5h5v5M10 14 19 5M19 14v5H5V5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="user-profile-modal__close" aria-label="Close profile">×</button>
        </div>
      </header>
      <nav class="user-profile-modal__tabs" aria-label="Profile sections">
        <button type="button" class="user-profile-modal__tab${this.activeTab === 'overview' ? ' is-active' : ''}" data-tab="overview">Overview</button>
        <button type="button" class="user-profile-modal__tab${this.activeTab === 'badges' ? ' is-active' : ''}" data-tab="badges">Badges</button>
        <button type="button" class="user-profile-modal__tab${this.activeTab === 'photos' ? ' is-active' : ''}" data-tab="photos">Photos</button>
      </nav>
      <div class="user-profile-modal__body">
        <div class="user-profile-modal__avatar-stage"></div>
        <div class="user-profile-modal__content">
          ${this.renderTabBody(equippedHtml)}
        </div>
      </div>
    `

    this.root.querySelector('.user-profile-modal__close')?.addEventListener('click', () => this.hide())
    this.root.querySelector('[data-action="external"]')?.addEventListener('click', () => {
      window.open(profileUrl, '_blank', 'noopener,noreferrer')
    })
    this.root.querySelector('.user-profile-modal__copy')?.addEventListener('click', async (ev) => {
      if (!address) return
      const btn = ev.currentTarget as HTMLButtonElement
      try {
        await navigator.clipboard.writeText(address)
        btn.classList.add('is-copied')
        setTimeout(() => btn.classList.remove('is-copied'), 1200)
      } catch {
        console.warn('[profile] clipboard copy failed')
      }
    })
    this.root.querySelector('.user-profile-modal__add-friend')?.addEventListener('click', () => {
      console.info('[profile] Add friend — coming soon')
    })

    for (const tab of this.root.querySelectorAll<HTMLButtonElement>('.user-profile-modal__tab')) {
      tab.addEventListener('click', () => {
        const next = tab.dataset.tab as TabId | undefined
        if (!next || next === this.activeTab) return
        this.activeTab = next
        void this.render()
      })
    }

    const stage = this.root.querySelector('.user-profile-modal__avatar-stage') as HTMLElement | null
    if (stage && profile) {
      this.preview?.dispose()
      this.preview = new AvatarPreviewMini(stage)
      await this.preview.showProfile(profile, peerUrl)
    } else if (stage && faceUrl) {
      stage.innerHTML = `<img class="user-profile-modal__face-fallback" src="${faceUrl}" alt="" />`
    }
  }

  private renderTabBody(equippedHtml: string): string {
    if (this.activeTab === 'badges') {
      return `<section class="user-profile-modal__section"><h3>Badges</h3><p class="user-profile-modal__empty">Badges coming soon.</p></section>`
    }
    if (this.activeTab === 'photos') {
      return `<section class="user-profile-modal__section"><h3>Photos</h3><p class="user-profile-modal__empty">Photos coming soon.</p></section>`
    }
    return `
      <section class="user-profile-modal__section">
        <h3>About Me</h3>
        <p class="user-profile-modal__about">—</p>
      </section>
      <section class="user-profile-modal__section">
        <h3>Links</h3>
        <p class="user-profile-modal__empty">No links.</p>
      </section>
      <section class="user-profile-modal__section">
        <h3>Equipped Items</h3>
        <div class="user-profile-modal__wearables">${equippedHtml}</div>
      </section>
    `
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}