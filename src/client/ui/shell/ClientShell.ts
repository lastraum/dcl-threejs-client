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
import { NearbyVoicePanel } from './NearbyVoicePanel'
import { MarketplaceCreditsPanel } from './MarketplaceCreditsPanel'
import { NotificationsPanel } from './NotificationsPanel'
import { PortableExperiencePanel } from './PortableExperiencePanel'
import type { PortableExperienceManager } from '../../../dcl/multiScene/PortableExperienceManager'
import type { VoiceChatService } from '../../../network/voice/VoiceChatService'
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
  /** Explorer In-World Camera (photo mode) — C / sidebar camera. */
  onTogglePhotoCamera?: () => void
  /** Sidebar Tour Options (flag under Communities). */
  onTourOptions?: () => void
  onSignOut: () => void | Promise<void>
  onExit: () => void | Promise<void>
}

type TopButtonConfig = SidebarButtonConfig & { dividerAfter?: boolean }

const TOP_BUTTONS: TopButtonConfig[] = [
  { id: 'notifications', icon: 'notifications', label: 'Notifications' },
  { id: 'marketplace-credits', icon: 'marketplaceCredits', label: 'Marketplace credits', dividerAfter: true },
  { id: 'events', icon: 'events', label: 'Events', shortcut: 'X' },
  { id: 'map', icon: 'map', label: 'Map', shortcut: 'M' },
  { id: 'communities', icon: 'communities', label: 'Communities', shortcut: 'O' },
  { id: 'tour-options', icon: 'tourOptions', label: 'Tour Options' },
  { id: 'backpack', icon: 'backpack', label: 'Backpack', shortcut: 'I' },
  { id: 'marketplace', icon: 'marketplace', label: 'Marketplace' },
  { id: 'pictures', icon: 'pictures', label: 'Pictures', shortcut: 'K' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
  { id: 'help', icon: 'help', label: 'Help' },
  { id: 'dev', icon: 'dev', label: 'Dev progress' }
]

const BOTTOM_BUTTONS: SidebarButtonConfig[] = [
  {
    id: 'nearby-voice',
    icon: 'nearbyVoice',
    label: 'Nearby voice',
    statusDot: 'off'
  },
  { id: 'smart-wearable', icon: 'smartWearable', label: 'Smart wearables' },
  { id: 'skybox', icon: 'skybox', label: 'Skybox overrides' },
  { id: 'camera', icon: 'camera', label: 'Camera mode', shortcut: 'C' },
  { id: 'emotes', icon: 'emotes', label: 'Emotes', shortcut: 'B' },
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
  private readonly nearbyVoicePanel: NearbyVoicePanel
  private readonly pePanel: PortableExperiencePanel
  private readonly notificationsPanel: NotificationsPanel
  private readonly marketplaceCreditsPanel: MarketplaceCreditsPanel
  private readonly emoteWheel: EmoteWheelPanel
  private readonly buttons = new Map<string, SidebarButton>()
  private unreadPollTimer: ReturnType<typeof setInterval> | null = null
  private readonly debugPanel: DebugPanel
  private readonly devProgressPanel: DevProgressPanel | null
  private chatPanel: ChatPanel | null
  private settingsOverlay: SettingsOverlay | null
  private preferencesPanel: PreferencesPanel | null
  private session: SessionIdentity
  private onEmoteSelected: ((emoteId: string) => void) | null = null
  private onTogglePhotoCamera: (() => void) | null = null
  private onTourOptions: (() => void) | null = null
  private emoteWheelEnabled = true
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

  constructor({
    environment,
    session,
    debugPanel,
    devProgressPanel = null,
    chatPanel = null,
    settingsOverlay = null,
    preferencesPanel = null,
    onEmoteSelected,
    onTogglePhotoCamera,
    onTourOptions,
    onSignOut,
    onExit
  }: ClientShellOptions) {
    this.session = session
    this.onEmoteSelected = onEmoteSelected ?? null
    this.onTogglePhotoCamera = onTogglePhotoCamera ?? null
    this.onTourOptions = onTourOptions ?? null
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
      canOpen: () => this.emoteWheelEnabled,
      onEmoteSelected: (emoteId) => this.onEmoteSelected?.(emoteId),
      onCustomize: () => this.openEmoteCustomize(),
      onVisibilityChange: (visible) => {
        this.buttons.get('emotes')?.setActive(visible)
        this.onEmoteWheelVisibility?.(visible)
        if (visible) {
          this.debugPanel.hide()
          this.devProgressPanel?.hide()
          this.skyboxPanel.hide()
          this.nearbyVoicePanel.hide()
          this.pePanel.hide()
          this.chatPanel?.hide()
          this.buttons.get('help')?.setActive(false)
          this.buttons.get('dev')?.setActive(false)
          this.buttons.get('skybox')?.setActive(false)
          this.buttons.get('nearby-voice')?.setActive(false)
          this.buttons.get('smart-wearable')?.setActive(false)
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

    this.nearbyVoicePanel = new NearbyVoicePanel({
      anchor: () => this.buttons.get('nearby-voice')?.element,
      onClose: () => this.buttons.get('nearby-voice')?.setActive(false)
    })

    this.pePanel = new PortableExperiencePanel({
      anchor: () => this.buttons.get('smart-wearable')?.element,
      onClose: () => this.buttons.get('smart-wearable')?.setActive(false)
    })

    this.notificationsPanel = new NotificationsPanel({
      getSession: () => this.session,
      onUnreadChange: (count) => this.buttons.get('notifications')?.setBadge(count > 0 ? count : null),
      onClose: () => this.buttons.get('notifications')?.setActive(false)
    })

    this.marketplaceCreditsPanel = new MarketplaceCreditsPanel({
      getSession: () => this.session,
      onClose: () => this.buttons.get('marketplace-credits')?.setActive(false)
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

    // Unread badge poll (wallet only; guests get 0).
    void this.notificationsPanel.refreshUnreadBadge()
    this.unreadPollTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void this.notificationsPanel.refreshUnreadBadge()
    }, 90_000)

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

    // 3D mobile only — desktop uses left sidebar chat. 2D social shell has its own FAB.
    this.mobileChatFab = document.createElement('button')
    this.mobileChatFab.type = 'button'
    this.mobileChatFab.className = 'scene-chat-fab'
    this.mobileChatFab.setAttribute('aria-label', 'Open chat')
    this.mobileChatFab.setAttribute('aria-expanded', 'false')
    this.mobileChatFab.setAttribute('title', 'Chat')
    this.mobileChatFab.innerHTML = `<span class="scene-chat-fab__icon" aria-hidden="true">${SIDEBAR_ICONS.chat}</span>`
    this.mobileChatFabBadge = document.createElement('span')
    this.mobileChatFabBadge.className = 'scene-chat-fab__badge'
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

  hide(): void {
    this.root.hidden = true
    this.setMobileDrawerOpen(false)
    this.dismissFloatingPanels()
    this.applyMobileLayout()
  }

  /** Close flyouts (chat, skybox, voice, emote, help) — used when hiding client HUD (U). */
  dismissFloatingPanels(): void {
    this.skyboxPanel.hide()
    this.buttons.get('skybox')?.setActive(false)
    this.nearbyVoicePanel.hide()
    this.buttons.get('nearby-voice')?.setActive(false)
    this.emoteWheel.hide()
    this.buttons.get('emotes')?.setActive(false)
    this.profilePopup.hide()
    this.debugPanel.hide()
    this.buttons.get('help')?.setActive(false)
    this.devProgressPanel?.hide()
    this.buttons.get('dev')?.setActive(false)
    this.chatPanel?.hide()
    this.buttons.get('chat')?.setActive(false)
  }

  attachChatPanel(panel: ChatPanel, social: SocialService): void {
    this.unsubChatUnread?.()
    this.chatPanel = panel
    this.unreadChat = 0
    this.updateChatBadge()
    this.wireChatPanel(panel)
    // Badge when chat is closed OR faded scene-mode (still "mounted" but not reading).
    this.unsubChatUnread = social.onChat((event) => {
      if (this.chatPanel?.isActivelyReading()) return
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

  setPhotoCameraHandler(handler: (() => void) | null): void {
    this.onTogglePhotoCamera = handler
  }

  setTourOptionsHandler(handler: (() => void) | null): void {
    this.onTourOptions = handler
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

  setEmoteWheelEnabled(enabled: boolean): void {
    if (this.emoteWheelEnabled === enabled) return
    this.emoteWheelEnabled = enabled
    this.buttons.get('emotes')?.setDisabled(!enabled)
    if (!enabled) this.emoteWheel.hide()
  }

  private wireChatPanel(panel: ChatPanel): void {
    panel.setOnVisibilityChange((visible) => {
      this.syncChatFabState(visible)
    })
    panel.setOnReadingChange((reading) => {
      if (reading) {
        this.unreadChat = 0
        this.updateChatBadge()
      }
    })
  }

  private syncChatFabState(visible: boolean): void {
    this.buttons.get('chat')?.setActive(visible)
    this.mobileChatFab.classList.toggle('is-active', visible)
    this.mobileChatFab.setAttribute('aria-expanded', visible ? 'true' : 'false')
    this.mobileChatFab.setAttribute('aria-label', visible ? 'Close chat' : 'Open chat')
    this.mobileChatFab.setAttribute('title', visible ? 'Close chat' : 'Chat')
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
    // Bottom-left chat FAB only on mobile 3D; desktop opens chat from the left rail.
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
    if (this.unreadPollTimer) {
      clearInterval(this.unreadPollTimer)
      this.unreadPollTimer = null
    }
    this.mobileQuery.removeEventListener('change', this.onMobileQueryChange)
    this.unsubChatUnread?.()
    this.unsubChatUnread = null
    this.unsubPe?.()
    this.unsubPe = null
    this.profilePopup.dispose()
    this.skyboxPanel.hide()
    this.nearbyVoicePanel.hide()
    this.notificationsPanel.dispose()
    this.marketplaceCreditsPanel.dispose()
    this.pePanel.dispose()
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
        this.syncChatFabState(open)
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
        if (!this.emoteWheelEnabled) return
        this.closeMobileDrawerForOverlay()
        this.emoteWheel.toggle()
      }
    }

    if (id === 'nearby-voice') {
      return (ev) => {
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        this.nearbyVoicePanel.toggle()
        this.buttons.get('nearby-voice')?.setActive(this.nearbyVoicePanel.isVisible())
        if (this.nearbyVoicePanel.isVisible()) {
          this.skyboxPanel.hide()
          this.pePanel.hide()
          this.chatPanel?.hide()
          this.emoteWheel.hide()
          this.debugPanel.hide()
          this.devProgressPanel?.hide()
          this.buttons.get('skybox')?.setActive(false)
          this.buttons.get('smart-wearable')?.setActive(false)
          this.buttons.get('chat')?.setActive(false)
          this.buttons.get('help')?.setActive(false)
          this.buttons.get('dev')?.setActive(false)
        }
      }
    }

    if (id === 'smart-wearable') {
      return (ev) => {
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        this.pePanel.toggle()
        this.buttons.get('smart-wearable')?.setActive(this.pePanel.isVisible())
        if (this.pePanel.isVisible()) {
          this.skyboxPanel.hide()
          this.nearbyVoicePanel.hide()
          this.chatPanel?.hide()
          this.emoteWheel.hide()
          this.debugPanel.hide()
          this.devProgressPanel?.hide()
          this.buttons.get('skybox')?.setActive(false)
          this.buttons.get('nearby-voice')?.setActive(false)
          this.buttons.get('chat')?.setActive(false)
          this.buttons.get('help')?.setActive(false)
          this.buttons.get('dev')?.setActive(false)
        }
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

    if (id === 'camera') {
      return (ev) => {
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        this.onTogglePhotoCamera?.()
      }
    }

    if (id === 'tour-options') {
      return (ev) => {
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        this.onTourOptions?.()
      }
    }

    if (id === 'notifications') {
      return (ev) => {
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        this.marketplaceCreditsPanel.hide()
        this.buttons.get('marketplace-credits')?.setActive(false)
        this.notificationsPanel.toggle()
        this.buttons.get('notifications')?.setActive(this.notificationsPanel.isVisible())
      }
    }

    if (id === 'marketplace-credits') {
      return (ev) => {
        ev.stopPropagation()
        this.closeMobileDrawerForOverlay()
        this.notificationsPanel.hide()
        this.buttons.get('notifications')?.setActive(false)
        this.marketplaceCreditsPanel.toggle()
        this.buttons
          .get('marketplace-credits')
          ?.setActive(this.marketplaceCreditsPanel.isVisible())
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
      marketplace: 'Marketplace',
      help: 'Help',
      dev: 'Dev progress',
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
    if (!this.emoteWheelEnabled) return
    this.emoteWheel.toggle()
  }

  /** Emote wheel Customize [E] — close wheel + open backpack Emotes. */
  openEmoteCustomize(): void {
    this.emoteWheel.hide()
    this.closeMobileDrawerForOverlay()
    this.preferencesPanel?.hide()
    this.buttons.get('settings')?.setActive(false)
    if (this.settingsOverlay) {
      this.settingsOverlay.showBackpackEmotes()
      return
    }
    console.warn('[client-ui] emote customize — settings overlay not attached')
  }

  setEmoteHudActive(active: boolean): void {
    this.buttons.get('emotes')?.setActive(active)
  }

  setOnViewLocalProfile(handler: (() => void) | null): void {
    this.profilePopup.setOnViewProfile(handler)
  }

  openChatPanel(): void {
    this.chatPanel?.show()
    this.syncChatFabState(true)
  }

  openCommunityChat(communityId: string, displayName: string): void {
    this.chatPanel?.openCommunityChannel(communityId, displayName)
  }

  bindNearbyVoice(voice: VoiceChatService | null): void {
    this.nearbyVoicePanel.bindVoice(voice)
  }

  private unsubPe: (() => void) | null = null

  bindPortableExperiences(manager: PortableExperienceManager | null): void {
    this.unsubPe?.()
    this.unsubPe = null
    this.pePanel.bindManager(manager)
    const btn = this.buttons.get('smart-wearable')
    if (!manager) {
      btn?.setBadge(null)
      this.pePanel.hide()
      return
    }
    this.unsubPe = manager.subscribe((slots) => {
      const n = slots.filter((s) => s.status === 'running').length
      const available = slots.length
      btn?.setBadge(n > 0 ? n : available > 0 ? available : null)
      if (!this.pePanel.isVisible()) {
        btn?.setActive(n > 0)
      }
    })
  }

  /** Sidebar status from voice service. */
  setNearbyVoiceUi(state: {
    hearing: boolean
    speaking: boolean
    micLive: boolean
    pttHeld?: boolean
    backgroundMuted: boolean
    remoteCount: number
    roomReady: boolean
  }): void {
    const btn = this.buttons.get('nearby-voice')
    if (!btn) return
    const talking = state.micLive || !!state.pttHeld || state.speaking
    if (!this.nearbyVoicePanel.isVisible()) {
      btn.setActive(state.speaking || state.micLive)
    }
    // Green border while transmitting (Speak or hold T).
    btn.setTalking(talking)
    if (state.micLive || state.pttHeld) {
      btn.setStatusDot('speaking')
    } else if (state.backgroundMuted) {
      btn.setStatusDot('muted')
    } else if (state.hearing && state.roomReady) {
      btn.setStatusDot('online')
    } else {
      btn.setStatusDot('off')
    }
    const peers =
      state.remoteCount > 0 ? ` · ${state.remoteCount} hearing` : ''
    btn.setTitle(
      state.micLive || state.pttHeld
        ? `Nearby voice — talking${peers}`
        : state.hearing
          ? `Nearby voice — hearing others${peers}`
          : 'Nearby voice'
    )
  }
}
