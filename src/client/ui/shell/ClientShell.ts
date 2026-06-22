import { ClientUiLayout } from '../ClientUiLayout'
import type { EnvironmentSystem } from '../../../environment/EnvironmentSystem'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import { getActiveProfileAddress } from '../../../avatar/LocalAvatar'
import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import { SidebarButton, type SidebarButtonConfig } from './SidebarButton'
import { ProfileSidebarButton, createSidebarDivider, SIDEBAR_ICONS } from './ProfileSidebarButton'
import type { AvatarProfile } from '../../../avatar/types'
import { ProfilePopup } from './ProfilePopup'
import { SkyboxPanel } from './SkyboxPanel'
import type { DebugPanel } from '../DebugPanel'
import type { DevProgressPanel } from '../DevProgressPanel'
import { ChatPanel } from '../chat/ChatPanel'
import type { SocialService } from '../../../social/SocialService'
import { EmoteWheelPanel } from '../EmoteWheelPanel'
import type { EmoteWheelSlot } from '../../../avatar/profileEmotes'
import type { SettingsOverlay, SettingsTab } from '../settings/SettingsOverlay'
import type { PreferencesPanel } from '../settings/PreferencesPanel'

export type ClientShellOptions = {
  environment: EnvironmentSystem
  session: SessionIdentity
  debugPanel: DebugPanel
  devProgressPanel?: DevProgressPanel | null
  chatPanel?: ChatPanel | null
  settingsOverlay?: SettingsOverlay | null
  preferencesPanel?: PreferencesPanel | null
  onEmoteSelected?: (emoteId: string) => void
  onSignOut: () => void | Promise<void>
  onExit: () => void | Promise<void>
}

type TopButtonConfig = SidebarButtonConfig & { dividerAfter?: boolean }

const TOP_BUTTONS: TopButtonConfig[] = [
  { id: 'notifications', icon: 'notifications', label: 'Notifications' },
  { id: 'marketplace-credits', icon: 'marketplaceCredits', label: 'Marketplace credits', dividerAfter: true },
  { id: 'events', icon: 'events', label: 'Events' },
  { id: 'map', icon: 'map', label: 'Map' },
  { id: 'communities', icon: 'communities', label: 'Communities' },
  { id: 'backpack', icon: 'backpack', label: 'Backpack' },
  { id: 'marketplace', icon: 'marketplace', label: 'Marketplace' },
  { id: 'pictures', icon: 'pictures', label: 'Pictures' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
  { id: 'help', icon: 'help', label: 'Help' },
  { id: 'dev', icon: 'dev', label: 'Dev progress' }
]

const BOTTOM_BUTTONS: SidebarButtonConfig[] = [
  { id: 'nearby-voice', icon: 'nearbyVoice', label: 'Nearby voice chat', statusDot: 'online' },
  { id: 'smart-wearable', icon: 'smartWearable', label: 'Smart wearables' },
  { id: 'skybox', icon: 'skybox', label: 'Skybox overrides' },
  { id: 'camera', icon: 'camera', label: 'Camera mode' },
  { id: 'emotes', icon: 'emotes', label: 'Emotes' },
  { id: 'friend-requests', icon: 'friendRequests', label: 'Friend requests' },
  { id: 'chat', icon: 'chat', label: 'Chat' }
]

const MOBILE_LAYOUT_QUERY = '(max-width: 767px)'

/**
 * Client chrome — left sidebar; layout tokens in index.html + ClientUiLayout.
 */
export class ClientShell {
  readonly root: HTMLElement
  private readonly uiLayout = new ClientUiLayout()
  private readonly profileButton: ProfileSidebarButton
  private readonly profilePopup: ProfilePopup
  private readonly skyboxPanel: SkyboxPanel
  private readonly emoteWheel: EmoteWheelPanel
  private readonly buttons = new Map<string, SidebarButton>()
  private readonly debugPanel: DebugPanel
  private readonly devProgressPanel: DevProgressPanel | null
  private chatPanel: ChatPanel | null
  private settingsOverlay: SettingsOverlay | null
  private preferencesPanel: PreferencesPanel | null
  private session: SessionIdentity
  private onEmoteSelected: ((emoteId: string) => void) | null = null
  private unreadChat = 0
  private unsubChatUnread: (() => void) | null = null
  private onEmoteWheelVisibility: ((visible: boolean) => void) | null = null
  private readonly mobileQuery = window.matchMedia(MOBILE_LAYOUT_QUERY)
  private readonly onMobileQueryChange = (): void => this.applyMobileLayout()
  private mobileDrawerOpen = false
  private readonly mobileProfileFab: HTMLButtonElement
  private readonly mobileProfileFabImg: HTMLImageElement
  private readonly mobileChatFab: HTMLButtonElement
  private readonly mobileChatFabBadge: HTMLSpanElement
  private readonly drawerBackdrop: HTMLDivElement
  private readonly drawerCloseBtn: HTMLButtonElement
  private readonly drawerProfileSlot: HTMLDivElement
  private readonly shellTop: HTMLDivElement
  private readonly mobileLocationPill: HTMLDivElement
  private readonly mobileLocationTitle: HTMLSpanElement
  private readonly mobileLocationCoords: HTMLSpanElement
  private getLocationCoordsLabel: (() => string) | null = null
  private locationCoordsRaf = 0

  constructor({ environment, session, debugPanel, devProgressPanel = null, chatPanel = null, settingsOverlay = null, preferencesPanel = null, onEmoteSelected, onSignOut, onExit }: ClientShellOptions) {
    this.session = session
    this.onEmoteSelected = onEmoteSelected ?? null
    this.root = document.createElement('aside')
    this.root.id = 'client-shell'
    this.root.className = 'client-shell'
    this.root.innerHTML = `
      <div class="client-shell__drawer-inner">
        <header class="client-shell__drawer-head">
          <div class="client-shell__drawer-profile" aria-hidden="false"></div>
          <span class="client-shell__drawer-title">Menu</span>
          <button type="button" class="client-shell__drawer-close" aria-label="Close menu">×</button>
        </header>
        <div class="client-shell__drawer-scroll">
          <div class="client-shell__top" aria-label="Main menu"></div>
          <div class="client-shell__bottom" aria-label="Quick actions"></div>
        </div>
      </div>
    `

    this.debugPanel = debugPanel
    this.devProgressPanel = devProgressPanel
    this.chatPanel = chatPanel
    this.settingsOverlay = settingsOverlay
    this.preferencesPanel = preferencesPanel
    if (this.chatPanel) this.wireChatPanel(this.chatPanel)

    this.emoteWheel = new EmoteWheelPanel()
    this.emoteWheel.setCallbacks({
      onEmoteSelected: (emoteId) => this.onEmoteSelected?.(emoteId),
      onVisibilityChange: (visible) => {
        this.buttons.get('emotes')?.setActive(visible)
        this.onEmoteWheelVisibility?.(visible)
        if (visible) {
          this.debugPanel.hide()
          this.devProgressPanel?.hide()
          this.skyboxPanel.hide()
          this.chatPanel?.hide()
          this.buttons.get('help')?.setActive(false)
          this.buttons.get('dev')?.setActive(false)
          this.buttons.get('skybox')?.setActive(false)
          this.buttons.get('chat')?.setActive(false)
        }
      }
    })

    const top = this.root.querySelector('.client-shell__top') as HTMLDivElement
    const bottom = this.root.querySelector('.client-shell__bottom') as HTMLDivElement
    this.shellTop = top
    this.drawerProfileSlot = this.root.querySelector('.client-shell__drawer-profile') as HTMLDivElement

    this.skyboxPanel = new SkyboxPanel({
      environment,
      anchor: () => this.buttons.get('skybox')?.element,
      onClose: () => this.buttons.get('skybox')?.setActive(false)
    })

    this.profileButton = new ProfileSidebarButton('Profile', () => this.profilePopup.toggle())
    this.drawerProfileSlot.appendChild(this.profileButton.element)

    this.profilePopup = new ProfilePopup(
      () => this.profileButton.element,
      () => ({
        address: this.session.getAddress(),
        profile: this.session.getProfile(),
        isGuest: !this.session.getAddress()
      }),
      { onSignOut, onExit }
    )

    for (const cfg of TOP_BUTTONS) {
      const btn = new SidebarButton({ ...cfg, onClick: (ev) => this.actionHandler(cfg.id)(ev) })
      this.buttons.set(cfg.id, btn)
      top.appendChild(btn.element)
      if (cfg.dividerAfter) top.appendChild(createSidebarDivider())
    }

    for (const cfg of BOTTOM_BUTTONS) {
      const btn = new SidebarButton({ ...cfg, onClick: (ev) => this.actionHandler(cfg.id)(ev) })
      this.buttons.set(cfg.id, btn)
      btn.element.dataset.shellId = cfg.id
      bottom.appendChild(btn.element)
    }

    this.drawerCloseBtn = this.root.querySelector('.client-shell__drawer-close') as HTMLButtonElement
    this.mobileLocationPill = document.createElement('div')
    this.mobileLocationPill.className = 'mobile-scene-location-pill'
    this.mobileLocationPill.hidden = true
    this.mobileLocationPill.innerHTML = `
      <span class="mobile-scene-location-pill__pin" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10z" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="12" cy="11" r="2" fill="currentColor"/>
        </svg>
      </span>
      <span class="mobile-scene-location-pill__title"></span>
      <span class="mobile-scene-location-pill__sep" aria-hidden="true">·</span>
      <span class="mobile-scene-location-pill__coords"></span>
    `
    this.mobileLocationTitle = this.mobileLocationPill.querySelector('.mobile-scene-location-pill__title')!
    this.mobileLocationCoords = this.mobileLocationPill.querySelector('.mobile-scene-location-pill__coords')!

    this.drawerBackdrop = document.createElement('div')
    this.drawerBackdrop.className = 'client-mobile-drawer-backdrop'
    this.drawerBackdrop.hidden = true
    this.drawerBackdrop.addEventListener('click', () => this.setMobileDrawerOpen(false))

    this.mobileProfileFab = document.createElement('button')
    this.mobileProfileFab.type = 'button'
    this.mobileProfileFab.className = 'mobile-profile-fab'
    this.mobileProfileFab.setAttribute('aria-label', 'Open menu')
    this.mobileProfileFabImg = document.createElement('img')
    this.mobileProfileFabImg.className = 'mobile-profile-fab__avatar'
    this.mobileProfileFabImg.alt = ''
    this.mobileProfileFab.appendChild(this.mobileProfileFabImg)
    const profileSeed = this.profileButton.element.querySelector('img')
    if (profileSeed instanceof HTMLImageElement) {
      this.mobileProfileFabImg.src = profileSeed.src
    }
    this.mobileProfileFab.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.setMobileDrawerOpen(!this.mobileDrawerOpen)
    })

    this.mobileChatFab = document.createElement('button')
    this.mobileChatFab.type = 'button'
    this.mobileChatFab.className = 'mobile-chat-fab'
    this.mobileChatFab.setAttribute('aria-label', 'Chat')
    this.mobileChatFab.innerHTML = `<span class="mobile-chat-fab__icon" aria-hidden="true">${SIDEBAR_ICONS.chat}</span>`
    this.mobileChatFabBadge = document.createElement('span')
    this.mobileChatFabBadge.className = 'mobile-chat-fab__badge'
    this.mobileChatFabBadge.hidden = true
    this.mobileChatFab.appendChild(this.mobileChatFabBadge)
    this.mobileChatFab.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.actionHandler('chat')(ev)
    })

    this.drawerCloseBtn.addEventListener('click', () => this.setMobileDrawerOpen(false))

    document.body.appendChild(this.drawerBackdrop)
    document.body.appendChild(this.mobileLocationPill)
    document.body.appendChild(this.mobileProfileFab)
    document.body.appendChild(this.mobileChatFab)
    document.body.appendChild(this.root)
    this.root.hidden = true
    this.mobileProfileFab.hidden = true
    this.mobileChatFab.hidden = true
    this.uiLayout.attach(this.root)
    this.mobileQuery.addEventListener('change', this.onMobileQueryChange)
    this.applyMobileLayout()
  }

  show(): void {
    this.root.hidden = false
    this.applyMobileLayout()
  }

  attachChatPanel(panel: ChatPanel, social: SocialService): void {
    this.unsubChatUnread?.()
    this.chatPanel = panel
    this.unreadChat = 0
    this.updateChatBadge()
    this.wireChatPanel(panel)
    this.unsubChatUnread = social.onChat((event) => {
      if (this.chatPanel?.isVisible()) return
      if (social.isOwnLine(event.line)) return
      this.unreadChat++
      this.updateChatBadge()
    })
  }

  attachSettingsOverlay(overlay: SettingsOverlay): void {
    this.settingsOverlay = overlay
  }

  attachPreferencesPanel(panel: PreferencesPanel): void {
    this.preferencesPanel = panel
  }

  updateWorldBindings(session: SessionIdentity, environment: EnvironmentSystem): void {
    this.session = session
    this.skyboxPanel.setEnvironment(environment)
  }

  setEmoteHandler(handler: ((emoteId: string) => void) | null): void {
    this.onEmoteSelected = handler
  }

  setEmoteWheelProfile(profile: AvatarProfile | null | undefined): void {
    this.emoteWheel.setProfile(profile)
  }

  setEmoteWheelSlots(slots: EmoteWheelSlot[]): void {
    this.emoteWheel.setSlots(slots)
  }

  setOnEmoteWheelVisibility(handler: ((visible: boolean) => void) | null): void {
    this.onEmoteWheelVisibility = handler
  }

  private wireChatPanel(panel: ChatPanel): void {
    panel.setOnVisibilityChange((visible) => {
      this.buttons.get('chat')?.setActive(visible)
      this.mobileChatFab.classList.toggle('is-active', visible)
      if (visible) {
        this.unreadChat = 0
        this.updateChatBadge()
      }
    })
  }

  private updateChatBadge(): void {
    const count = this.unreadChat > 0 ? this.unreadChat : null
    this.buttons.get('chat')?.setBadge(count)
    if (count) {
      this.mobileChatFabBadge.hidden = false
      this.mobileChatFabBadge.textContent = count > 99 ? '99+' : String(count)
    } else {
      this.mobileChatFabBadge.hidden = true
      this.mobileChatFabBadge.textContent = ''
    }
  }

  async refreshProfile(): Promise<void> {
    const address = getActiveProfileAddress()
    if (!address) return
    const faceUrl = await fetchProfileFaceUrl(address)
    this.profileButton.setFaceUrl(faceUrl)
    const avatarImg = this.profileButton.element.querySelector('img')
    if (avatarImg instanceof HTMLImageElement) {
      this.mobileProfileFabImg.src = avatarImg.src
    }
  }

  private isMobileLayout(): boolean {
    return this.mobileQuery.matches
  }

  setSceneLocation(title: string, getCoordsLabel: () => string): void {
    this.mobileLocationTitle.textContent = title
    this.getLocationCoordsLabel = getCoordsLabel
    this.tickLocationCoords()
  }

  private tickLocationCoords(): void {
    if (this.getLocationCoordsLabel) {
      this.mobileLocationCoords.textContent = this.getLocationCoordsLabel()
    }
    this.locationCoordsRaf = requestAnimationFrame(() => this.tickLocationCoords())
  }

  private applyMobileLayout(): void {
    const mobile = this.isMobileLayout()
    document.documentElement.classList.toggle('client-mobile', mobile)
    this.root.classList.toggle('client-shell--drawer', mobile)
    this.repositionProfileButton(mobile)
    this.mobileProfileFab.hidden = !mobile || this.root.hidden
    this.mobileChatFab.hidden = !mobile || this.root.hidden
    if (!mobile) {
      this.setMobileDrawerOpen(false)
      this.mobileLocationPill.hidden = true
    }
    this.uiLayout.attach(this.root)
  }

  private repositionProfileButton(mobile: boolean): void {
    const parent = mobile ? this.drawerProfileSlot : this.shellTop
    if (this.profileButton.element.parentElement !== parent) {
      parent.insertBefore(this.profileButton.element, parent.firstChild)
    }
  }

  private setMobileDrawerOpen(open: boolean): void {
    if (!this.isMobileLayout()) {
      this.mobileDrawerOpen = false
      return
    }
    this.mobileDrawerOpen = open
    this.root.classList.toggle('is-drawer-open', open)
    this.drawerBackdrop.hidden = !open
    document.documentElement.classList.toggle('client-drawer-open', open)
    this.mobileLocationPill.hidden = !open
    this.mobileProfileFab.setAttribute('aria-expanded', open ? 'true' : 'false')
    if (!open) this.profilePopup.hide()
  }

  dispose(): void {
    cancelAnimationFrame(this.locationCoordsRaf)
    this.getLocationCoordsLabel = null
    this.mobileQuery.removeEventListener('change', this.onMobileQueryChange)
    this.unsubChatUnread?.()
    this.unsubChatUnread = null
    this.profilePopup.dispose()
    this.skyboxPanel.hide()
    this.emoteWheel.dispose()
    this.devProgressPanel?.hide()
    this.chatPanel?.dispose()
    this.drawerBackdrop.remove()
    this.mobileLocationPill.remove()
    this.mobileProfileFab.remove()
    this.mobileChatFab.remove()
    this.root.remove()
    document.documentElement.classList.remove('client-mobile', 'client-drawer-open')
  }

  private actionHandler(id: string): (ev: MouseEvent) => void {
    if (id === 'skybox') {
      return (ev) => {
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        this.skyboxPanel.toggle()
        this.buttons.get('skybox')?.setActive(this.skyboxPanel.isVisible())
      }
    }
    if (id === 'help') {
      return (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        const open = this.debugPanel.toggle()
        this.buttons.get('help')?.setActive(open)
        if (open) {
          this.devProgressPanel?.hide()
          this.buttons.get('dev')?.setActive(false)
          this.skyboxPanel.hide()
          this.chatPanel?.hide()
          this.emoteWheel.hide()
          this.buttons.get('skybox')?.setActive(false)
          this.buttons.get('chat')?.setActive(false)
        }
      }
    }
    if (id === 'dev') {
      return (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        if (!this.devProgressPanel) return
        const open = this.devProgressPanel.toggle()
        this.buttons.get('dev')?.setActive(open)
        if (open) {
          this.debugPanel.hide()
          this.buttons.get('help')?.setActive(false)
          this.skyboxPanel.hide()
          this.chatPanel?.hide()
          this.emoteWheel.hide()
          this.buttons.get('skybox')?.setActive(false)
          this.buttons.get('chat')?.setActive(false)
        }
      }
    }
    if (id === 'chat') {
      return (ev) => {
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        if (!this.chatPanel) return
        const open = this.chatPanel.toggle()
        this.buttons.get('chat')?.setActive(open)
        this.mobileChatFab.classList.toggle('is-active', open)
        if (open) {
          this.debugPanel.hide()
          this.devProgressPanel?.hide()
          this.skyboxPanel.hide()
          this.emoteWheel.hide()
          this.buttons.get('help')?.setActive(false)
          this.buttons.get('dev')?.setActive(false)
          this.buttons.get('skybox')?.setActive(false)
        }
      }
    }
    if (id === 'emotes') {
      return (ev) => {
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        this.emoteWheel.toggle()
      }
    }

    if (id === 'settings') {
      return (ev) => {
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        this.preferencesPanel?.toggle('graphics')
        this.buttons.get('settings')?.setActive(this.preferencesPanel?.isVisible() ?? false)
      }
    }

    const overlayTabs: Record<string, SettingsTab> = {
      events: 'events',
      map: 'map',
      communities: 'communities',
      backpack: 'backpack',
      pictures: 'gallery'
    }
    if (overlayTabs[id]) {
      return (ev) => {
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        this.preferencesPanel?.hide()
        this.buttons.get('settings')?.setActive(false)
        this.settingsOverlay?.show(overlayTabs[id])
      }
    }

    const labels: Record<string, string> = {
      notifications: 'Notifications',
      'marketplace-credits': 'Marketplace credits',
      marketplace: 'Marketplace',
      help: 'Help',
      dev: 'Dev progress',
      'nearby-voice': 'Nearby voice chat',
      'smart-wearable': 'Smart wearables',
      camera: 'Camera mode',
      'friend-requests': 'Friend requests',
      chat: 'Chat'
    }
    return (ev) => {
      ev.stopPropagation()
      if (this.isMobileLayout()) this.setMobileDrawerOpen(false)
      this.stub(labels[id] ?? id)
    }
  }

  private closeMobileDrawerForOverlay(): void {
    if (this.isMobileLayout()) this.setMobileDrawerOpen(false)
  }

  private stub(feature: string): void {
    console.info(`[client-ui] ${feature} — not implemented yet`)
  }

  getButton(id: string): SidebarButton | undefined {
    return this.buttons.get(id)
  }

  toggleEmotes(): void {
    this.emoteWheel.toggle()
  }

  setEmoteHudActive(active: boolean): void {
    this.buttons.get('emotes')?.setActive(active)
  }

  setOnViewLocalProfile(handler: (() => void) | null): void {
    this.profilePopup.setOnViewProfile(handler)
  }

  openChatPanel(): void {
    this.chatPanel?.show()
  }
}
