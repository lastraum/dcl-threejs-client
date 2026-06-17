import { ClientUiLayout } from '../ClientUiLayout'
import type { EnvironmentSystem } from '../../../environment/EnvironmentSystem'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import { getActiveProfileAddress } from '../../../avatar/LocalAvatar'
import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import { SidebarButton, type SidebarButtonConfig } from './SidebarButton'
import { ProfileSidebarButton, createSidebarDivider } from './ProfileSidebarButton'
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

export type ClientShellOptions = {
  environment: EnvironmentSystem
  session: SessionIdentity
  debugPanel: DebugPanel
  devProgressPanel?: DevProgressPanel | null
  chatPanel?: ChatPanel | null
  settingsOverlay?: SettingsOverlay | null
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
  private session: SessionIdentity
  private onEmoteSelected: ((emoteId: string) => void) | null = null
  private unreadChat = 0
  private unsubChatUnread: (() => void) | null = null

  constructor({ environment, session, debugPanel, devProgressPanel = null, chatPanel = null, settingsOverlay = null, onEmoteSelected, onSignOut, onExit }: ClientShellOptions) {
    this.session = session
    this.onEmoteSelected = onEmoteSelected ?? null
    this.root = document.createElement('aside')
    this.root.id = 'client-shell'
    this.root.className = 'client-shell'
    this.root.innerHTML = `
      <div class="client-shell__top" aria-label="Main menu"></div>
      <div class="client-shell__bottom" aria-label="Quick actions"></div>
    `

    this.debugPanel = debugPanel
    this.devProgressPanel = devProgressPanel
    this.chatPanel = chatPanel
    this.settingsOverlay = settingsOverlay
    if (this.chatPanel) this.wireChatPanel(this.chatPanel)

    this.emoteWheel = new EmoteWheelPanel()
    this.emoteWheel.setCallbacks({
      onEmoteSelected: (emoteId) => this.onEmoteSelected?.(emoteId),
      onVisibilityChange: (visible) => {
        this.buttons.get('emotes')?.setActive(visible)
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

    this.skyboxPanel = new SkyboxPanel({
      environment,
      anchor: () => this.buttons.get('skybox')?.element,
      onClose: () => this.buttons.get('skybox')?.setActive(false)
    })

    this.profileButton = new ProfileSidebarButton('Profile', () => this.profilePopup.toggle())
    top.appendChild(this.profileButton.element)

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
      bottom.appendChild(btn.element)
    }

    document.body.appendChild(this.root)
    this.root.hidden = true
    this.uiLayout.attach(this.root)
  }

  show(): void {
    this.root.hidden = false
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

  private wireChatPanel(panel: ChatPanel): void {
    panel.setOnVisibilityChange((visible) => {
      this.buttons.get('chat')?.setActive(visible)
      if (visible) {
        this.unreadChat = 0
        this.updateChatBadge()
      }
    })
  }

  private updateChatBadge(): void {
    this.buttons.get('chat')?.setBadge(this.unreadChat > 0 ? this.unreadChat : null)
  }

  async refreshProfile(): Promise<void> {
    const address = getActiveProfileAddress()
    if (!address) return
    const faceUrl = await fetchProfileFaceUrl(address)
    this.profileButton.setFaceUrl(faceUrl)
  }

  dispose(): void {
    this.unsubChatUnread?.()
    this.unsubChatUnread = null
    this.profilePopup.dispose()
    this.skyboxPanel.hide()
    this.emoteWheel.dispose()
    this.devProgressPanel?.hide()
    this.chatPanel?.dispose()
    this.root.remove()
  }

  private actionHandler(id: string): (ev: MouseEvent) => void {
    if (id === 'skybox') {
      return (ev) => {
        ev.stopPropagation()
        this.skyboxPanel.toggle()
        this.buttons.get('skybox')?.setActive(this.skyboxPanel.isVisible())
      }
    }
    if (id === 'help') {
      return (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
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
        if (!this.chatPanel) return
        const open = this.chatPanel.toggle()
        this.buttons.get('chat')?.setActive(open)
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
        this.emoteWheel.toggle()
      }
    }

    const overlayTabs: Record<string, SettingsTab> = {
      events: 'events',
      map: 'map',
      communities: 'communities',
      backpack: 'backpack',
      pictures: 'gallery',
      settings: 'settings'
    }
    if (overlayTabs[id]) {
      return (ev) => {
        ev.stopPropagation()
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
      this.stub(labels[id] ?? id)
    }
  }

  private stub(feature: string): void {
    console.info(`[client-ui] ${feature} — not implemented yet`)
  }

  getButton(id: string): SidebarButton | undefined {
    return this.buttons.get(id)
  }
}
