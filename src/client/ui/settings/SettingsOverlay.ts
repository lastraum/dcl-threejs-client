import type { SessionIdentity } from '../../../network/SessionIdentity'
import {
  deployAvatarProfile,
  profileDeployFingerprint
} from '../../../avatar/deployProfile'
import { CommunitiesBrowseView } from '../explore/CommunitiesBrowseView'
import { BackpackView } from './BackpackView'
import { EventsView, type EventsViewOptions } from './EventsView'
import { MapView, type MapPlayerState } from './MapView'
import { GalleryView } from './GalleryView'
import { PlacesView, type PlacesViewOptions } from './PlacesView'

export type SettingsTab = 'events' | 'places' | 'communities' | 'map' | 'backpack' | 'gallery'

type TabDef = {
  id: SettingsTab
  label: string
  shortcut: string
  icon: string
}

const TABS: TabDef[] = [
  { id: 'events', label: 'EVENTS', shortcut: 'X', icon: `<svg viewBox="0 0 24 24" fill="none"><rect x="5" y="6" width="14" height="13" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V7M16 4.5V7M5 10h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>` },
  { id: 'places', label: 'PLACES', shortcut: '?', icon: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="11" r="2" fill="currentColor"/></svg>` },
  { id: 'communities', label: 'COMMUNITIES', shortcut: 'O', icon: `<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 17c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="16.5" cy="9" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M13.5 17c.4-1.6 1.7-2.8 3.3-2.8 1 0 1.9.4 2.5 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>` },
  { id: 'map', label: 'MAP', shortcut: 'M', icon: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="11" r="2" fill="currentColor"/></svg>` },
  { id: 'backpack', label: 'BACKPACK', shortcut: 'I', icon: `<svg viewBox="0 0 24 24" fill="none"><path d="M8 8V6.5A4 4 0 0 1 12 2.5 4 4 0 0 1 16 6.5V8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><rect x="6" y="8" width="12" height="12.5" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M12 12v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>` },
  { id: 'gallery', label: 'GALLERY', shortcut: 'K', icon: `<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="6" width="16" height="12" rx="1.5" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="10.5" r="1.5" fill="currentColor"/><path d="m6 16 4-3 3 2.5 2-1.5 3 3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>` }
]

const SHORTCUT_KEY_MAP: Record<string, SettingsTab> = {
  KeyX: 'events',
  KeyO: 'communities',
  KeyM: 'map',
  KeyI: 'backpack',
  KeyK: 'gallery'
}

export type SettingsOverlayOptions = {
  session: SessionIdentity
  getMapPlayerState?: () => MapPlayerState | null
  onMapJumpIn?: (px: number, py: number) => void
  onEventJumpIn?: EventsViewOptions['onJumpIn']
  onEventViewScene?: EventsViewOptions['onViewScene']
  onPlaceJumpIn?: PlacesViewOptions['onJumpIn']
  getDefaultEventCoords?: () => { x: number; y: number } | null
  isWorldScene?: boolean
  worldName?: string | null
  onOpen?: () => void
  onClose?: () => void
  onVrmEquipChange?: () => void | Promise<void>
  /** Community modal 💬 → chat dock / in-world panel. */
  onOpenCommunityChat?: (community: { id: string; name: string }) => void
}

export class SettingsOverlay {
  readonly root: HTMLElement
  private readonly tabBar: HTMLElement
  private readonly contentArea: HTMLElement
  private readonly closeBtn: HTMLElement
  private activeTab: SettingsTab | null = null
  private backpackView: BackpackView | null = null
  private eventsView: EventsView | null = null
  private placesView: PlacesView | null = null
  private communitiesView: CommunitiesBrowseView | null = null
  private galleryView: GalleryView | null = null
  private mapView: MapView | null = null
  private session: SessionIdentity
  private getMapPlayerState?: () => MapPlayerState | null
  private onMapJumpIn?: (px: number, py: number) => void
  private onEventJumpIn?: EventsViewOptions['onJumpIn']
  private onEventViewScene?: EventsViewOptions['onViewScene']
  private onPlaceJumpIn?: PlacesViewOptions['onJumpIn']
  private getDefaultEventCoords?: () => { x: number; y: number } | null
  private isWorldScene?: boolean
  private worldName?: string | null
  private visible = false
  private closing = false
  /** Wearables fingerprint when the overlay opened (or last successful save). */
  private profileBaselineKey = ''
  private onOpen?: () => void
  private onClose?: () => void
  private onVrmEquipChange?: () => void | Promise<void>
  private onOpenCommunityChat?: SettingsOverlayOptions['onOpenCommunityChat']

  constructor(opts: SettingsOverlayOptions) {
    this.session = opts.session
    this.getMapPlayerState = opts.getMapPlayerState
    this.onMapJumpIn = opts.onMapJumpIn
    this.onEventJumpIn = opts.onEventJumpIn
    this.onEventViewScene = opts.onEventViewScene
    this.onPlaceJumpIn = opts.onPlaceJumpIn
    this.getDefaultEventCoords = opts.getDefaultEventCoords
    this.isWorldScene = opts.isWorldScene
    this.worldName = opts.worldName
    this.onOpen = opts.onOpen
    this.onClose = opts.onClose
    this.onVrmEquipChange = opts.onVrmEquipChange
    this.onOpenCommunityChat = opts.onOpenCommunityChat

    this.root = document.createElement('div')
    this.root.className = 'settings-overlay'
    this.root.setAttribute('hidden', '')

    this.root.innerHTML = `
      <aside class="settings-overlay__panel" role="dialog" aria-label="Options" aria-modal="true">
        <div class="settings-overlay__header">
          <div class="settings-overlay__heading">
            <svg viewBox="0 0 44 44" width="22" height="22" aria-hidden="true"><circle cx="22" cy="22" r="22" fill="#FF2D55"/><path fill="#fff" d="M10 28l6-14h2.2l3.4 8.2L25 14h2.1l6 14h-2.4l-1.2-3H13.6l-1.2 3H10zm5.8-5.2h6.8L19.8 17l-4 5.8z"/></svg>
            <span class="settings-overlay__title">SETTINGS</span>
          </div>
          <span class="settings-overlay__user-name"></span>
          <button class="settings-overlay__close" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="settings-overlay__body">
          <nav class="settings-overlay__tabs" role="tablist" aria-label="Settings sections"></nav>
          <div class="settings-overlay__content"></div>
        </div>
      </aside>
    `

    this.tabBar = this.root.querySelector('.settings-overlay__tabs')!
    this.contentArea = this.root.querySelector('.settings-overlay__content')!
    this.closeBtn = this.root.querySelector('.settings-overlay__close')!

    this.buildTabs()
    this.closeBtn.addEventListener('click', () => this.hide())
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.hide()
    })

    window.addEventListener('keydown', this.onKeyDown)
    document.body.appendChild(this.root)
  }

  private buildTabs(): void {
    for (const tab of TABS) {
      const btn = document.createElement('button')
      btn.className = 'settings-overlay__tab'
      btn.dataset.tab = tab.id
      btn.setAttribute('role', 'tab')
      btn.title = `${tab.label} [${tab.shortcut}]`
      btn.setAttribute('aria-label', `${tab.label} (${tab.shortcut})`)
      btn.innerHTML = `<span class="settings-overlay__tab-icon">${tab.icon}</span>`
      btn.addEventListener('click', () => this.switchTab(tab.id))
      this.tabBar.appendChild(btn)
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isTyping()) return

    const tab = SHORTCUT_KEY_MAP[e.code]
    if (tab) {
      e.preventDefault()
      if (this.visible && this.activeTab === tab) {
        this.hide()
      } else {
        this.show(tab)
      }
      return
    }

    if (e.code === 'Escape' && this.visible) {
      e.preventDefault()
      this.hide()
    }
  }

  private isTyping(): boolean {
    const el = document.activeElement
    if (!el) return false
    if (el instanceof HTMLInputElement) {
      const type = el.type.toLowerCase()
      return type !== 'checkbox' && type !== 'radio' && type !== 'button'
    }
    if (el instanceof HTMLTextAreaElement) return true
    if (el instanceof HTMLElement && el.isContentEditable) return true
    return false
  }

  show(tab: SettingsTab = 'backpack'): void {
    this.visible = true
    this.root.removeAttribute('hidden')
    requestAnimationFrame(() => this.root.classList.add('is-open'))
    this.profileBaselineKey = this.wearablesFingerprint()
    this.updateUserInfo()
    this.switchTab(tab)
    this.onOpen?.()
  }

  /** Open communities tab and a specific community modal (HUD toasts). */
  openCommunity(
    communityId: string,
    displayName?: string,
    opts: { autoJoinVoice?: boolean } = {}
  ): void {
    this.show('communities')
    // Browse view mounts in switchTab — open on next frame.
    requestAnimationFrame(() => {
      this.communitiesView?.openCommunityById(communityId, displayName ?? 'Community', opts)
    })
  }

  hide(): void {
    void this.hideAndSaveProfile()
  }

  private wearablesFingerprint(): string {
    const profile = this.session.getProfile()
    if (!profile?.fromWallet) return ''
    // bodyShape + skin/hair/eyes + wearables + emotes — same key as BackpackView.
    return profileDeployFingerprint(profile)
  }

  private hasPendingProfileChanges(): boolean {
    const current = this.wearablesFingerprint()
    return Boolean(current) && current !== this.profileBaselineKey
  }

  /**
   * Close settings. If avatar profile fields changed (wearables, emotes, body
   * shape, or skin/hair/eye colours), deploy first.
   * On successful save: stay on backpack with refreshed avatar (do not close).
   * On no pending changes: close the overlay.
   * @see https://docs.decentraland.org/contributor/content/entity-types/profiles#pointers
   */
  private async hideAndSaveProfile(): Promise<void> {
    if (!this.visible || this.closing) return
    this.closing = true

    try {
      if (this.hasPendingProfileChanges()) {
        this.hideSaveErrorModal()
        this.setCloseBusy(true)
        this.showSavingModal(true)
        try {
          await this.deployPendingProfile()
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn('[settings] profile deploy failed', err)
          this.showSavingModal(false)
          this.setCloseBusy(false)
          this.closing = false
          this.showSaveErrorModal(msg)
          return
        }
        this.showSavingModal(false)
        this.setCloseBusy(false)
        // Stay on backpack so the user sees the updated preview.
        this.switchTab('backpack')
        this.showSaveSuccessModal()
        return
      }

      this.visible = false
      this.root.classList.remove('is-open')
      setTimeout(() => {
        if (!this.visible) this.root.setAttribute('hidden', '')
      }, 300)
      this.onClose?.()
    } finally {
      this.showSavingModal(false)
      this.closing = false
    }
  }

  private async deployPendingProfile(): Promise<void> {
    const profile = this.session.getProfile()
    const address = this.session.getAddress()
    const identity = this.session.getAuthIdentity()
    if (!profile?.fromWallet || !address || !identity) {
      throw new Error('Wallet session required to save avatar')
    }

    const peerRoot = this.session.getLambdasUrl().replace(/\/lambdas\/?$/i, '') || undefined
    const result = await deployAvatarProfile({
      address,
      identity,
      profile,
      peerUrl: peerRoot
    })

    // Keep session wearables in sync with what Catalyst accepted (real tokenIds).
    const bodyShapeUrns = profile.wearables.filter((u) => {
      const n = u.toLowerCase()
      return n.includes('basemale') || n.includes('basefemale')
    })
    this.session.setProfile({
      ...profile,
      wearables: [...bodyShapeUrns, ...result.wearables]
    })
    this.profileBaselineKey = this.wearablesFingerprint()
    this.backpackView?.markProfileBaselineSynced()
    this.backpackView?.refreshAfterProfileSave()
    this.updateUserInfo()
    await this.onVrmEquipChange?.()
  }

  private setCloseBusy(busy: boolean): void {
    this.closeBtn.toggleAttribute('disabled', busy)
    this.closeBtn.setAttribute('aria-busy', busy ? 'true' : 'false')
    if (busy) {
      this.closeBtn.setAttribute('title', 'Saving wearables…')
    } else {
      this.closeBtn.removeAttribute('title')
    }
  }

  private showSavingModal(show: boolean): void {
    let el = this.root.querySelector('.settings-overlay__saving') as HTMLElement | null
    if (!el) {
      el = document.createElement('div')
      el.className = 'settings-overlay__saving'
      el.setAttribute('role', 'status')
      el.setAttribute('aria-live', 'polite')
      el.innerHTML = `
        <div class="settings-overlay__saving-card">
          <div class="settings-overlay__saving-spinner" aria-hidden="true"></div>
          <p class="settings-overlay__saving-title">Saving wearables…</p>
          <p class="settings-overlay__saving-sub">Updating your Decentraland profile</p>
        </div>
      `
      this.root.appendChild(el)
    }
    el.hidden = !show
    el.classList.toggle('is-visible', show)
  }

  private formatSaveError(raw: string): string {
    // Prefer human text from Catalyst JSON: {"errors":["The following items (…)"]}
    try {
      const jsonStart = raw.indexOf('{')
      if (jsonStart >= 0) {
        const parsed = JSON.parse(raw.slice(jsonStart)) as { errors?: unknown }
        if (Array.isArray(parsed.errors) && parsed.errors.length) {
          return parsed.errors.map((e) => String(e)).join('\n\n')
        }
      }
    } catch {
      /* keep raw */
    }
    return raw
      .replace(/^Profile deploy failed \(\d+\):\s*/i, '')
      .replace(/^Could not save avatar to Decentraland:\s*/i, '')
      .trim() || raw
  }

  private showSaveErrorModal(rawMessage: string): void {
    this.showSavingModal(false)
    let el = this.root.querySelector('.settings-overlay__save-error') as HTMLElement | null
    if (!el) {
      el = document.createElement('div')
      el.className = 'settings-overlay__save-error'
      el.setAttribute('role', 'alertdialog')
      el.setAttribute('aria-modal', 'true')
      el.setAttribute('aria-labelledby', 'settings-save-error-title')
      el.innerHTML = `
        <div class="settings-overlay__save-error-card">
          <div class="settings-overlay__save-error-icon" aria-hidden="true">!</div>
          <p class="settings-overlay__save-error-title" id="settings-save-error-title">Couldn’t save wearables</p>
          <p class="settings-overlay__save-error-body" data-error-body></p>
          <div class="settings-overlay__save-error-actions">
            <button type="button" class="settings-overlay__save-error-btn" data-error-dismiss>OK</button>
          </div>
        </div>
      `
      el.addEventListener('click', (ev) => {
        if (ev.target === el) this.hideSaveErrorModal()
      })
      el.querySelector('[data-error-dismiss]')?.addEventListener('click', () => this.hideSaveErrorModal())
      this.root.appendChild(el)
    }

    const body = el.querySelector('[data-error-body]') as HTMLElement | null
    if (body) body.textContent = this.formatSaveError(rawMessage)

    el.hidden = false
    el.classList.add('is-visible')
    const btn = el.querySelector('[data-error-dismiss]') as HTMLButtonElement | null
    btn?.focus()
  }

  private hideSaveErrorModal(): void {
    const el = this.root.querySelector('.settings-overlay__save-error') as HTMLElement | null
    if (!el) return
    el.hidden = true
    el.classList.remove('is-visible')
  }

  private showSaveSuccessModal(): void {
    let el = this.root.querySelector('.settings-overlay__save-success') as HTMLElement | null
    if (!el) {
      el = document.createElement('div')
      el.className = 'settings-overlay__save-success'
      el.setAttribute('role', 'status')
      el.setAttribute('aria-live', 'polite')
      el.innerHTML = `
        <div class="settings-overlay__save-success-card">
          <div class="settings-overlay__save-success-icon" aria-hidden="true">✓</div>
          <p class="settings-overlay__save-success-title">Wearables saved</p>
          <p class="settings-overlay__save-success-sub">Your Decentraland profile was updated</p>
          <button type="button" class="settings-overlay__save-success-btn" data-success-dismiss>Continue</button>
        </div>
      `
      el.addEventListener('click', (ev) => {
        if (ev.target === el) this.hideSaveSuccessModal()
      })
      el.querySelector('[data-success-dismiss]')?.addEventListener('click', () =>
        this.hideSaveSuccessModal()
      )
      this.root.appendChild(el)
    }
    el.hidden = false
    el.classList.add('is-visible')
    window.setTimeout(() => this.hideSaveSuccessModal(), 2800)
  }

  private hideSaveSuccessModal(): void {
    const el = this.root.querySelector('.settings-overlay__save-success') as HTMLElement | null
    if (!el) return
    el.hidden = true
    el.classList.remove('is-visible')
  }

  toggle(tab?: SettingsTab): void {
    if (this.visible) this.hide()
    else this.show(tab)
  }

  isVisible(): boolean {
    return this.visible
  }

  updateSession(session: SessionIdentity): void {
    this.session = session
    this.backpackView?.updateSession(session)
  }

  updateMapPlayerState(getter: () => MapPlayerState | null): void {
    this.getMapPlayerState = getter
  }

  updateMapJumpIn(handler: (px: number, py: number) => void): void {
    this.onMapJumpIn = handler
  }

  updateEventContext(isWorldScene: boolean, worldName: string | null): void {
    this.isWorldScene = isWorldScene
    this.worldName = worldName
  }

  private switchTab(id: SettingsTab): void {
    this.activeTab = id
    let activeBtn: HTMLElement | null = null
    for (const btn of this.tabBar.querySelectorAll('.settings-overlay__tab')) {
      const el = btn as HTMLElement
      const isActive = el.dataset.tab === id
      el.classList.toggle('is-active', isActive)
      if (isActive) activeBtn = el
    }
    const titleEl = this.root.querySelector('.settings-overlay__title')
    const tabDef = TABS.find((tab) => tab.id === id)
    if (titleEl) titleEl.textContent = tabDef?.label ?? 'SETTINGS'
    if (activeBtn && window.matchMedia('(max-width: 767px)').matches) {
      activeBtn.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
    }
    this.renderContent()
  }

  private renderContent(): void {
    this.contentArea.innerHTML = ''
    this.backpackView?.dispose()
    this.backpackView = null
    this.eventsView?.dispose()
    this.eventsView = null
    this.placesView?.dispose()
    this.placesView = null
    this.communitiesView?.dispose()
    this.communitiesView = null
    this.galleryView?.dispose()
    this.galleryView = null
    this.mapView?.dispose()
    this.mapView = null

    if (this.activeTab === 'events') {
      this.eventsView = new EventsView({
        onJumpIn: this.onEventJumpIn,
        onViewScene: this.onEventViewScene,
        getAuthIdentity: () => this.session.getAuthIdentity(),
        getDefaultCoords: this.getDefaultEventCoords,
        isWorldScene: this.isWorldScene,
        worldName: this.worldName
      })
      this.contentArea.appendChild(this.eventsView.root)
      this.eventsView.mount()
    } else if (this.activeTab === 'places') {
      this.placesView = new PlacesView({
        onJumpIn: this.onPlaceJumpIn,
        getAuthIdentity: () => this.session.getAuthIdentity()
      })
      this.contentArea.appendChild(this.placesView.root)
      this.placesView.mount()
    } else if (this.activeTab === 'communities') {
      this.communitiesView = new CommunitiesBrowseView({
        getAuthIdentity: () => this.session.getAuthIdentity(),
        getUserAddress: () => this.session.getAddress() ?? null,
        onOpenChat: (community) => {
          this.onOpenCommunityChat?.({ id: community.id, name: community.name })
        }
      })
      this.communitiesView.root.classList.add('communities-browse-view--embedded')
      this.contentArea.appendChild(this.communitiesView.root)
      this.communitiesView.mount()
    } else if (this.activeTab === 'gallery') {
      this.galleryView = new GalleryView({
        getWalletAddress: () => this.session.getAddress(),
        getAuthIdentity: () => this.session.getAuthIdentity(),
        peerUrl: this.session.getContentUrl() || undefined
      })
      this.contentArea.appendChild(this.galleryView.root)
      this.galleryView.mount()
    } else if (this.activeTab === 'backpack') {
      this.backpackView = new BackpackView(this.session, {
        onVrmEquipChange: () => this.onVrmEquipChange?.()
      })
      this.contentArea.appendChild(this.backpackView.root)
    } else if (this.activeTab === 'map' && this.getMapPlayerState) {
      // In-world / settings panel — no Explore/Map social shell or Genesis Plaza HUD.
      const player = this.getMapPlayerState()
      const m = player?.parcelKey ? /^(-?\d+),(-?\d+)$/.exec(player.parcelKey.trim()) : null
      this.mapView = new MapView({
        getPlayerState: this.getMapPlayerState,
        onJumpIn: this.onMapJumpIn,
        embedded: true,
        initialCenter: m
          ? { px: parseInt(m[1]!, 10), py: parseInt(m[2]!, 10) }
          : null
      })
      this.contentArea.appendChild(this.mapView.root)
      this.mapView.mount()
    } else {
      const placeholder = document.createElement('div')
      placeholder.className = 'settings-overlay__placeholder'
      placeholder.textContent = `${this.activeTab?.toUpperCase()} — Coming soon`
      this.contentArea.appendChild(placeholder)
    }
  }

  private updateUserInfo(): void {
    const nameEl = this.root.querySelector('.settings-overlay__user-name')!
    const profile = this.session.getProfile()
    nameEl.textContent = profile?.displayName ?? 'Guest'
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    this.backpackView?.dispose()
    this.eventsView?.dispose()
    this.placesView?.dispose()
    this.communitiesView?.dispose()
    this.galleryView?.dispose()
    this.mapView?.dispose()
    this.root.remove()
  }
}
