import type { SessionIdentity } from '../../../network/SessionIdentity'
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
  onPlaceJumpIn?: PlacesViewOptions['onJumpIn']
  getDefaultEventCoords?: () => { x: number; y: number } | null
  isWorldScene?: boolean
  worldName?: string | null
  onOpen?: () => void
  onClose?: () => void
  onVrmEquipChange?: () => void | Promise<void>
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
  private galleryView: GalleryView | null = null
  private mapView: MapView | null = null
  private session: SessionIdentity
  private getMapPlayerState?: () => MapPlayerState | null
  private onMapJumpIn?: (px: number, py: number) => void
  private onEventJumpIn?: EventsViewOptions['onJumpIn']
  private onPlaceJumpIn?: PlacesViewOptions['onJumpIn']
  private getDefaultEventCoords?: () => { x: number; y: number } | null
  private isWorldScene?: boolean
  private worldName?: string | null
  private visible = false
  private onOpen?: () => void
  private onClose?: () => void
  private onVrmEquipChange?: () => void | Promise<void>

  constructor(opts: SettingsOverlayOptions) {
    this.session = opts.session
    this.getMapPlayerState = opts.getMapPlayerState
    this.onMapJumpIn = opts.onMapJumpIn
    this.onEventJumpIn = opts.onEventJumpIn
    this.onPlaceJumpIn = opts.onPlaceJumpIn
    this.getDefaultEventCoords = opts.getDefaultEventCoords
    this.isWorldScene = opts.isWorldScene
    this.worldName = opts.worldName
    this.onOpen = opts.onOpen
    this.onClose = opts.onClose
    this.onVrmEquipChange = opts.onVrmEquipChange

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
    this.updateUserInfo()
    this.switchTab(tab)
    this.onOpen?.()
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.root.classList.remove('is-open')
    setTimeout(() => {
      if (!this.visible) this.root.setAttribute('hidden', '')
    }, 300)
    this.onClose?.()
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
    this.galleryView?.dispose()
    this.galleryView = null
    this.mapView?.dispose()
    this.mapView = null

    if (this.activeTab === 'events') {
      this.eventsView = new EventsView({
        onJumpIn: this.onEventJumpIn,
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
    } else if (this.activeTab === 'gallery') {
      this.galleryView = new GalleryView({
        getWalletAddress: () => this.session.getAddress(),
        getAuthIdentity: () => this.session.getAuthIdentity()
      })
      this.contentArea.appendChild(this.galleryView.root)
      this.galleryView.mount()
    } else if (this.activeTab === 'backpack') {
      this.backpackView = new BackpackView(this.session, {
        onVrmEquipChange: () => this.onVrmEquipChange?.()
      })
      this.contentArea.appendChild(this.backpackView.root)
    } else if (this.activeTab === 'map' && this.getMapPlayerState) {
      this.mapView = new MapView({
        getPlayerState: this.getMapPlayerState,
        onJumpIn: this.onMapJumpIn
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
    this.galleryView?.dispose()
    this.mapView?.dispose()
    this.root.remove()
  }
}
