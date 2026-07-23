import type { RouteTarget } from '../../../dcl/content/route'
import { parseGotoCommand } from '../../../dcl/content/route'
import {
  appendChatTextWithSelfMentions,
  selfMentionTokens,
  textChatMentionsSelf
} from '../../../social/chatMentionDetection'
import {
  CHAT_MAX_LENGTH,
  applyMentionToDraft,
  effectiveCaretForMention,
  filterMentionPopupRows,
  mentionInsertLabel,
  parseActiveMention,
  type MentionCandidate
} from '../../../social/chatMentions'
import { communityDisplayImageUrl } from '../../../social/communityThumbnails'
import { isAllowedChatImageFile } from '../../../social/prepareChatImage'
import { SocialService, socialChannelKey } from '../../../social/SocialService'
import {
  chatTranslationService,
  chatTranslationSettings
} from '../../../social/translation'
import { isChatImageLine, type ChatChannelChoice, type ChatLine } from '../../../social/types'
import { sceneChatRailIcon, SIDEBAR_ICONS } from '../shell/icons'
import type { SocialChatController, SocialChatStatus } from './SocialChatController'
import { wireChatImageExpand } from './chatImageLightbox'
import { ChatChannelMenu } from './ChatChannelMenu'
import { appendTranslateControls } from './chatTranslateUi'

const SOCIAL_CHAT_MOBILE_MQ = '(max-width: 767px)'

export type SocialChatDockOptions = {
  controller: SocialChatController
  onGoto?: (target: RouteTarget) => void | Promise<void>
  onOpenProfile?: (address: string) => void
}

/** Persistent right-dock chat for the 2D social shell — channel list + active thread. */
export class SocialChatDock {
  readonly root: HTMLElement

  private readonly controller: SocialChatController
  private readonly onGoto?: SocialChatDockOptions['onGoto']
  private readonly onOpenProfile?: SocialChatDockOptions['onOpenProfile']
  private readonly pillsEl: HTMLElement
  private readonly pillsScrollEl: HTMLElement
  private readonly guestCloseBtn: HTMLButtonElement
  private readonly threadEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly headerAvatarEl: HTMLElement
  private readonly headerTitle: HTMLElement
  private readonly headerSubtitle: HTMLElement
  private readonly messagesEl: HTMLElement
  private readonly composerEl: HTMLElement
  private readonly mentionDockEl: HTMLElement
  private readonly mentionListEl: HTMLUListElement
  private readonly inputEl: HTMLInputElement
  private readonly backBtn: HTMLButtonElement
  private readonly pillTipFloatEl: HTMLElement
  private readonly mobileFab: HTMLButtonElement
  private readonly mobileFabBadge: HTMLElement
  private readonly mobileBackdrop: HTMLElement
  private readonly mobileMq: MediaQueryList
  private readonly onMobileMqChange = (): void => {
    this.syncLayout()
  }
  private visible = false
  private mounted = false
  private threadOpen = false
  private listExpanded = false
  /** Desktop + mobile: dock expanded from the bottom-right chat FAB. */
  private panelOpen = false
  private unsubChat: (() => void) | null = null
  private unsubChannel: (() => void) | null = null
  private unsubProfiles: (() => void) | null = null
  private unsubTranslate: (() => void) | null = null
  private unsubTranslateSettings: (() => void) | null = null
  private autoIndicatorEl: HTMLElement | null = null
  private moreBtn: HTMLButtonElement | null = null
  private channelMenu: ChatChannelMenu | null = null
  private inputCaret = 0
  private mentionHighlight = 0
  private mentionPopupRows: MentionCandidate[] = []
  private lastMentionStart: number | null = null
  private imageSending = false
  private alignResizeObs: ResizeObserver | null = null
  private alignMutationObs: MutationObserver | null = null
  private alignRetryTimer: number | null = null
  private readonly onAlignViewportChange = (): void => {
    this.syncContentAlign()
  }

  constructor({ controller, onGoto, onOpenProfile }: SocialChatDockOptions) {
    this.controller = controller
    this.onGoto = onGoto
    this.onOpenProfile = onOpenProfile

    this.root = document.createElement('aside')
    this.root.className = 'social-chat-dock'
    this.root.setAttribute('aria-label', 'Chat')
    this.root.hidden = true

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'social-chat-dock__status'
    this.statusEl.hidden = true

    this.guestCloseBtn = document.createElement('button')
    this.guestCloseBtn.type = 'button'
    this.guestCloseBtn.className = 'social-chat-dock__guest-close'
    this.guestCloseBtn.setAttribute('aria-label', 'Close chat')
    this.guestCloseBtn.textContent = '›'
    this.guestCloseBtn.hidden = true
    this.guestCloseBtn.addEventListener('click', () => this.closeChatPanel())

    this.pillsEl = document.createElement('nav')
    this.pillsEl.className = 'social-chat-dock__pills chat-panel__rail'
    this.pillsEl.setAttribute('aria-label', 'Chat channels')

    this.pillsScrollEl = document.createElement('div')
    this.pillsScrollEl.className = 'chat-panel__rail-scroll'
    this.pillsEl.appendChild(this.pillsScrollEl)

    this.threadEl = document.createElement('section')
    this.threadEl.className = 'social-chat-dock__thread'
    this.threadEl.innerHTML = `
      <header class="social-chat-dock__thread-header">
        <button type="button" class="social-chat-dock__back" aria-label="Back to channels">←</button>
        <span class="social-chat-dock__thread-avatar" aria-hidden="true"></span>
        <div class="social-chat-dock__thread-head-text">
          <div class="social-chat-dock__thread-title"></div>
          <div class="chat-panel__auto-indicator social-chat-dock__auto-indicator" hidden>
            <svg class="chat-panel__auto-ind-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M4 5h7M7.5 5v1a8 8 0 0 0 8 8h.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M5 19h14M13 9l3.5 10M20.5 19 17 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="chat-panel__auto-indicator-text">Auto-Translate On</span>
          </div>
          <div class="social-chat-dock__thread-subtitle"></div>
        </div>
        <div class="chat-panel__header-actions social-chat-dock__header-actions">
          <button type="button" class="chat-panel__more-btn social-chat-dock__more-btn" aria-label="More channel options" aria-haspopup="menu" title="More">
            <svg class="chat-panel__more-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>
          </button>
        </div>
      </header>
      <div class="social-chat-dock__messages" role="log" aria-live="polite"></div>
      <form class="social-chat-dock__composer chat-panel__composer">
        <div class="chat-panel__mention-dock" hidden>
          <div class="chat-panel__mention-head">Mention suggestions</div>
          <ul class="chat-panel__mention-list" role="listbox" aria-label="Mention suggestions"></ul>
        </div>
        <input class="chat-panel__input social-chat-dock__input" type="text" maxlength="${CHAT_MAX_LENGTH}" placeholder="Press Enter to chat" autocomplete="off" />
        <button type="submit" class="chat-panel__send social-chat-dock__send" aria-label="Send">♥</button>
      </form>
    `

    const body = document.createElement('div')
    body.className = 'social-chat-dock__body'
    body.appendChild(this.pillsEl)
    body.appendChild(this.threadEl)

    this.root.appendChild(this.guestCloseBtn)
    this.root.appendChild(this.statusEl)
    this.root.appendChild(body)

    this.pillTipFloatEl = document.createElement('div')
    this.pillTipFloatEl.className = 'social-chat-dock__pill-tip-float'
    this.pillTipFloatEl.hidden = true
    this.pillTipFloatEl.setAttribute('role', 'tooltip')

    this.headerAvatarEl = this.threadEl.querySelector('.social-chat-dock__thread-avatar')!
    this.headerTitle = this.threadEl.querySelector('.social-chat-dock__thread-title')!
    this.headerSubtitle = this.threadEl.querySelector('.social-chat-dock__thread-subtitle')!
    this.autoIndicatorEl = this.threadEl.querySelector('.social-chat-dock__auto-indicator')
    this.moreBtn = this.threadEl.querySelector('.social-chat-dock__more-btn')
    this.messagesEl = this.threadEl.querySelector('.social-chat-dock__messages')!
    this.composerEl = this.threadEl.querySelector('.social-chat-dock__composer')!

    this.channelMenu = new ChatChannelMenu({
      getChannelKey: () => socialChannelKey(this.social().getChannel()),
      onAutoTranslateChange: (enabled) => {
        if (enabled) this.social().backfillAutoTranslate()
        this.syncAutoTranslateIndicator()
        if (this.threadOpen) this.renderMessages()
      },
      onDeleteHistory: () => {
        this.social().clearChannelHistory()
        this.renderMessages()
        this.renderPills()
      }
    })
    this.moreBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.moreBtn) this.channelMenu?.toggle(this.moreBtn)
    })
    this.mentionDockEl = this.threadEl.querySelector('.chat-panel__mention-dock')!
    this.mentionListEl = this.threadEl.querySelector('.chat-panel__mention-list')!
    this.inputEl = this.threadEl.querySelector('.social-chat-dock__input')!
    this.backBtn = this.threadEl.querySelector('.social-chat-dock__back')!

    this.backBtn.addEventListener('click', () => {
      this.threadOpen = false
      this.listExpanded = true
      this.syncLayout()
      this.renderPills()
    })

    this.inputEl.addEventListener('input', this.onInputChange)
    this.inputEl.addEventListener('select', this.onInputSelect)
    this.inputEl.addEventListener('keyup', this.onInputSelect)
    this.inputEl.addEventListener('keydown', this.onInputKeyDown)

    this.composerEl.addEventListener('submit', (ev) => {
      ev.preventDefault()
      void this.submitMessage()
    })

    this.composerEl.addEventListener('dragenter', this.onComposerDragEnter)
    this.composerEl.addEventListener('dragover', this.onComposerDragOver)
    this.composerEl.addEventListener('dragleave', this.onComposerDragLeave)
    this.composerEl.addEventListener('drop', this.onComposerDrop)

    this.mobileBackdrop = document.createElement('div')
    this.mobileBackdrop.className = 'social-chat-dock__mobile-backdrop'
    this.mobileBackdrop.hidden = true
    this.mobileBackdrop.addEventListener('click', () => this.closePanel())

    this.mobileFab = document.createElement('button')
    this.mobileFab.type = 'button'
    this.mobileFab.className = 'social-chat-dock__fab'
    this.mobileFab.setAttribute('aria-label', 'Open chat')
    this.mobileFab.setAttribute('aria-expanded', 'false')
    this.mobileFab.setAttribute('title', 'Chat')
    this.mobileFab.hidden = true
    this.mobileFab.innerHTML = `
      <span class="social-chat-dock__fab-icon" aria-hidden="true">${SIDEBAR_ICONS.chat}</span>
    `
    this.mobileFabBadge = document.createElement('span')
    this.mobileFabBadge.className = 'social-chat-dock__fab-badge'
    this.mobileFabBadge.hidden = true
    this.mobileFab.appendChild(this.mobileFabBadge)
    this.mobileFab.addEventListener('click', () => this.togglePanel())

    this.mobileMq = window.matchMedia(SOCIAL_CHAT_MOBILE_MQ)
    this.mobileMq.addEventListener('change', this.onMobileMqChange)
  }

  show(): void {
    this.ensureMounted()
    this.visible = true
    this.threadOpen = false
    this.panelOpen = false
    this.listExpanded = false
    this.bindSocial()
    this.renderAll()
    this.syncLayout()
    this.bindContentAlign()
    this.syncContentAlign()
  }

  hide(): void {
    this.visible = false
    this.threadOpen = false
    this.listExpanded = false
    this.panelOpen = false
    this.root.hidden = true
    this.mobileFab.hidden = true
    this.mobileBackdrop.hidden = true
    this.channelMenu?.hide()
    this.hidePillTip()
    this.unbindSocial()
    this.unbindContentAlign()
    this.clearContentAlign()
    document.body.classList.remove('social-chat-mobile-open')
  }

  refresh(): void {
    if (!this.visible) return
    this.renderAll()
    this.syncContentAlign()
  }

  /**
   * Suppress toast banners only for the channel the user is actively reading.
   * Other scene tabs (and explore with thread closed) still get banners + badges.
   */
  isChatNotificationSuppressed(incomingChannelKey?: string): boolean {
    if (!this.visible || !this.threadOpen || !this.panelOpen) return false
    if (!incomingChannelKey) return true
    const current = this.social().getChannel()
    if (current.kind === 'scene') return incomingChannelKey === `scene:${current.sceneKey}`
    if (current.kind === 'community') {
      return incomingChannelKey === `community:${current.communityId.toLowerCase()}`
    }
    if (current.kind === 'dm') {
      return incomingChannelKey === `dm:${current.peerAddress.toLowerCase()}`
    }
    return incomingChannelKey === 'messages'
  }

  /**
   * Leaving a scene landing — collapse to FAB only.
   * Keep thread/list selection so reopening the FAB restores the last view.
   */
  collapseToChannelList(): void {
    if (!this.visible) return
    this.panelOpen = false
    this.syncLayout()
    this.renderAll()
  }

  /** Notifications bell — open chat panel (channel list). */
  openFromNotification(): void {
    if (!this.visible) return
    this.threadOpen = false
    this.listExpanded = true
    this.openPanel()
    this.renderAll()
  }

  /**
   * Scene landing — select scene channel.
   * Desktop opens the thread panel; mobile leaves FAB closed so the sheet is opt-in.
   */
  openSceneChatThread(): void {
    if (!this.visible) return
    const scene = this.controller.getSocial().getSceneTab()
    if (!scene) return

    this.controller.getSocial().selectChannel({
      kind: 'scene',
      sceneKey: scene.key,
      label: scene.label
    })
    this.listExpanded = true
    this.threadOpen = true
    if (this.isMobileLayout()) {
      this.panelOpen = false
    } else {
      this.panelOpen = true
    }
    this.syncLayout()
    this.renderAll()
  }

  /** Community modal 💬 / toast — select community channel and open thread. */
  openCommunityChat(communityId: string, displayName: string): void {
    const id = communityId.trim()
    if (!id) return
    if (!this.visible) this.show()

    const name =
      displayName.trim() ||
      this.controller
        .getSocial()
        .getCommunities()
        .find((c) => c.id.toLowerCase() === id.toLowerCase())?.name ||
      'Community'

    this.controller.getSocial().selectChannel({
      kind: 'community',
      communityId: id,
      displayName: name
    })
    this.listExpanded = true
    this.threadOpen = true
    this.openPanel()
    this.renderAll()
  }

  dispose(): void {
    this.hide()
    this.channelMenu?.dispose()
    this.channelMenu = null
    this.mobileMq.removeEventListener('change', this.onMobileMqChange)
    if (this.mounted) {
      this.root.remove()
      this.pillTipFloatEl.remove()
      this.mobileFab.remove()
      this.mobileBackdrop.remove()
    }
    this.mounted = false
  }

  private ensureMounted(): void {
    if (this.mounted) return
    document.body.appendChild(this.root)
    document.body.appendChild(this.pillTipFloatEl)
    document.body.appendChild(this.mobileBackdrop)
    document.body.appendChild(this.mobileFab)
    this.mounted = true
  }

  private isMobileLayout(): boolean {
    return this.mobileMq.matches
  }

  private togglePanel(): void {
    if (this.panelOpen) this.closePanel()
    else this.openPanel()
  }

  private openPanel(): void {
    if (!this.visible) return
    this.panelOpen = true
    // Restore prior view (thread or list). Only default to expanded list when none selected.
    if (!this.threadOpen) this.listExpanded = true
    this.hidePillTip()
    this.syncLayout()
    this.renderAll()
  }

  private closePanel(): void {
    if (!this.panelOpen) return
    // Keep threadOpen / listExpanded so the next FAB open restores this view.
    this.panelOpen = false
    this.hidePillTip()
    this.syncLayout()
  }

  /** Mobile always uses full channel rows — never the narrow pill rail. */
  private useExpandedChannelList(): boolean {
    return this.listExpanded || this.isMobileLayout()
  }

  private bindSocial(): void {
    this.unbindSocial()
    const social = this.controller.getSocial()
    this.unsubChat = social.onChat(() => {
      this.renderMessages()
      this.renderPills()
      this.updateChatFab()
      this.updateComposerUi()
    })
    this.unsubChannel = social.onChannelChange(() => this.renderAll())
    this.unsubProfiles = social.onPeerProfilesChange(() => {
      this.renderMessages()
      this.updateComposerUi()
    })
    this.unsubTranslate = chatTranslationService.onUpdate(() => {
      if (this.threadOpen) this.renderMessages()
    })
    this.unsubTranslateSettings = chatTranslationSettings.subscribe(() => {
      this.syncAutoTranslateIndicator()
      if (this.threadOpen) this.renderMessages()
    })
  }

  private unbindSocial(): void {
    this.unsubChat?.()
    this.unsubChannel?.()
    this.unsubProfiles?.()
    this.unsubTranslate?.()
    this.unsubTranslateSettings?.()
    this.unsubChat = null
    this.unsubChannel = null
    this.unsubProfiles = null
    this.unsubTranslate = null
    this.unsubTranslateSettings = null
  }

  private social(): SocialService {
    return this.controller.getSocial()
  }

  private renderAll(): void {
    this.renderStatus(this.controller.getStatus())
    this.renderPills()
    this.renderThreadHeader()
    this.renderMessages()
    this.updateComposerUi()
    this.updateChatFab()
  }

  private totalUnreadCount(): number {
    const social = this.social()
    const current = social.getChannel()
    let total = 0

    for (const scene of social.getSceneTabs()) {
      const channel = { kind: 'scene' as const, sceneKey: scene.key, label: scene.label }
      const active = current.kind === 'scene' && current.sceneKey === scene.key
      // Count unread even for the selected channel unless the thread is open and being read.
      if (!(active && this.threadOpen)) total += social.getUnreadCount(channel)
    }

    for (const community of social.getCommunities()) {
      const channel = {
        kind: 'community' as const,
        communityId: community.id,
        displayName: community.name
      }
      const active = current.kind === 'community' && current.communityId === community.id
      if (!(active && this.threadOpen)) total += social.getUnreadCount(channel)
    }

    for (const peer of social.getDmPeers()) {
      const channel = {
        kind: 'dm' as const,
        peerAddress: peer.address,
        displayName: peer.displayName
      }
      const active = current.kind === 'dm' && current.peerAddress.toLowerCase() === peer.address
      if (!(active && this.threadOpen)) total += social.getUnreadCount(channel)
    }

    return total
  }

  private updateChatFab(): void {
    if (!this.mounted) return
    this.mobileFab.hidden = !this.visible
    this.mobileFab.classList.toggle('is-active', this.panelOpen)
    this.mobileFab.setAttribute('aria-expanded', String(this.panelOpen))
    this.mobileFab.setAttribute('aria-label', this.panelOpen ? 'Close chat' : 'Open chat')
    this.mobileFab.setAttribute('title', this.panelOpen ? 'Close chat' : 'Chat')

    const unread = this.panelOpen ? 0 : this.totalUnreadCount()
    if (unread > 0) {
      this.mobileFabBadge.hidden = false
      this.mobileFabBadge.textContent = unread > 99 ? '99+' : String(unread)
    } else {
      this.mobileFabBadge.hidden = true
      this.mobileFabBadge.textContent = ''
    }
  }

  /** FAB-expanded dock (desktop panel or mobile sheet). */
  private isChatPanelOpen(): boolean {
    return this.panelOpen
  }

  private renderStatus(status: SocialChatStatus): void {
    let message = ''
    let tone: 'info' | 'warn' | 'error' = 'info'

    switch (status.kind) {
      case 'guest':
        // Only prompt once the user opens chat — not on the collapsed pill rail.
        if (this.isChatPanelOpen()) {
          message = 'Sign in to chat'
          tone = 'warn'
        }
        break
      case 'connecting':
        message = 'Connecting to scene chat…'
        break
      case 'duplicate_wallet':
        message = 'This wallet is already connected in another session'
        tone = 'error'
        break
      case 'scene_ban':
        message = `${status.title}\n${status.detail}`
        tone = 'error'
        break
      case 'failed':
        message = status.message
        tone = 'error'
        break
      case 'idle': {
        // Only empty-prompt when nothing is left to list. Closing the primary
        // LiveKit room used to flip idle while other scene tabs remained — and
        // idle-empty CSS hid the whole channel list.
        const hasChannels =
          this.social().getSceneTabs().length > 0 ||
          this.social().getCommunities().length > 0 ||
          this.social().getDmPeers().length > 0
        message = hasChannels ? '' : 'Visit a scene for scene chat'
        break
      }
      case 'connected':
        message = ''
        break
      case 'browser_chat_disabled':
        message = 'Browser chat is disabled for this scene'
        tone = 'warn'
        break
    }

    const guestCentered = status.kind === 'guest' && Boolean(message)
    const idleEmpty =
      status.kind === 'idle' && Boolean(message) && this.isChatPanelOpen() && !this.threadOpen
    this.root.classList.toggle('social-chat-dock--guest-prompt', guestCentered)
    this.root.classList.toggle('social-chat-dock--idle-empty', idleEmpty)
    this.guestCloseBtn.hidden = !guestCentered

    if (!message) {
      this.statusEl.hidden = true
      this.statusEl.textContent = ''
      return
    }

    this.statusEl.hidden = false
    this.statusEl.className = `social-chat-dock__status social-chat-dock__status--${tone}${
      status.kind === 'scene_ban' ? ' social-chat-dock__status--scene-ban' : ''
    }${idleEmpty ? ' social-chat-dock__status--idle-empty' : ''}`
    this.statusEl.textContent = message
  }

  /** Collapse expanded list / thread, or dismiss the chat panel via FAB / guest close. */
  private closeChatPanel(): void {
    this.closePanel()
    this.renderStatus(this.controller.getStatus())
  }

  private renderThreadHeader(): void {
    const social = this.social()
    const channel = social.getChannel()
    this.headerTitle.textContent = social.getChannelTitle()
    const subtitle = social.getChannelSubtitle()
    this.headerSubtitle.textContent = subtitle
    this.headerSubtitle.hidden = !subtitle.trim()
    this.syncAutoTranslateIndicator()
    this.headerAvatarEl.className = 'social-chat-dock__thread-avatar'
    this.headerAvatarEl.innerHTML = ''

    if (channel.kind === 'scene') {
      this.headerAvatarEl.classList.add('social-chat-dock__thread-avatar--svg')
      this.headerAvatarEl.innerHTML = sceneChatRailIcon()
      return
    }

    if (channel.kind === 'community') {
      const community = this.social().getCommunities().find((c) => c.id === channel.communityId)
      const thumb = communityDisplayImageUrl(channel.communityId, community?.thumbnails)
      const fallback = channel.displayName.slice(0, 1).toUpperCase() || '?'
      if (thumb) {
        const img = document.createElement('img')
        img.src = thumb
        img.alt = ''
        img.addEventListener('error', () => {
          img.remove()
          this.headerAvatarEl.textContent = fallback
        })
        this.headerAvatarEl.appendChild(img)
      } else {
        this.headerAvatarEl.textContent = fallback
      }
      return
    }

    if (channel.kind === 'dm') {
      this.headerAvatarEl.textContent = channel.displayName.slice(0, 1).toUpperCase() || '✉'
      return
    }

    this.headerAvatarEl.textContent = '✉'
  }

  private renderPills(): void {
    this.hidePillTip()
    const social = this.social()
    const current = social.getChannel()
    this.pillsScrollEl.innerHTML = ''
    this.pillsScrollEl.classList.toggle('social-chat-dock__list-scroll', this.useExpandedChannelList())

    // Only hide × while actually on that scene's landing page. Explore / other 2D
    // pages keep connected multi-room tabs closable.
    const onSceneLanding = document.body.classList.contains('scene-landing-route')
    const landingKey = onSceneLanding
      ? social.getConnectedSceneKey()?.trim().toLowerCase() ?? null
      : null
    for (const scene of social.getSceneTabs()) {
      const channel = { kind: 'scene' as const, sceneKey: scene.key, label: scene.label }
      const active = current.kind === 'scene' && current.sceneKey === scene.key
      const viewingChannel = active && this.threadOpen
      const live = social.isLiveSceneChannel(channel)
      const isCurrentLandingScene =
        landingKey != null && scene.key.trim().toLowerCase() === landingKey
      this.pillsScrollEl.appendChild(
        this.createChannelEntry({
          channel,
          title: scene.label,
          subtitle: !scene.browserChatEnabled
            ? 'Chat disabled'
            : live
              ? 'Live · Scene chat'
              : 'Connecting…',
          iconSvg: sceneChatRailIcon(),
          active,
          unreadCount: viewingChannel ? 0 : social.getUnreadCount(channel),
          // No × only for the scene landing you're viewing. Everywhere else, close is allowed.
          closable: !isCurrentLandingScene
        })
      )
    }

    for (const community of social.getCommunities()) {
      const channel = {
        kind: 'community' as const,
        communityId: community.id,
        displayName: community.name
      }
      const active = current.kind === 'community' && current.communityId === community.id
      const viewingChannel = active && this.threadOpen
      this.pillsScrollEl.appendChild(
        this.createChannelEntry({
          channel,
          title: community.name,
          // Shared live highway — not a per-community room. Don't show "Connecting…" on every row.
          subtitle: 'Community chat',
          imageUrl: communityDisplayImageUrl(community.id, community.thumbnails),
          fallback: community.name.slice(0, 1).toUpperCase(),
          active,
          unreadCount: viewingChannel ? 0 : social.getUnreadCount(channel)
        })
      )
    }

    for (const peer of social.getDmPeers()) {
      const channel = {
        kind: 'dm' as const,
        peerAddress: peer.address,
        displayName: peer.displayName
      }
      const active = current.kind === 'dm' && current.peerAddress.toLowerCase() === peer.address
      const viewingChannel = active && this.threadOpen
      this.pillsScrollEl.appendChild(
        this.createChannelEntry({
          channel,
          title: peer.displayName,
          subtitle: 'Direct message',
          fallback: peer.displayName.slice(0, 1).toUpperCase() || '?',
          active,
          unreadCount: viewingChannel ? 0 : social.getUnreadCount(channel)
        })
      )
    }
  }

  private createChannelEntry(options: {
    channel: ChatChannelChoice
    title: string
    subtitle: string
    imageUrl?: string
    iconSvg?: string
    fallback?: string
    active: boolean
    disabled?: boolean
    unreadCount?: number
    closable?: boolean
  }): HTMLElement {
    if (this.useExpandedChannelList()) return this.createListRow(options)
    return this.createPillButton(options)
  }

  private openChannel(channel: ChatChannelChoice): void {
    this.social().selectChannel(channel)
    this.threadOpen = true
    this.panelOpen = true
    this.syncLayout()
    this.renderAll()
    // Multi-room: join this scene's LiveKit without leaving other open rooms.
    if (channel.kind === 'scene') {
      void this.controller.ensureSceneChannelLive(channel.sceneKey).then((ok) => {
        if (!this.visible) return
        if (ok) this.renderAll()
      })
    }
  }

  private closeSceneChannel(sceneKey: string, ev?: Event): void {
    ev?.stopPropagation()
    ev?.preventDefault()
    const social = this.social()
    const closed = this.controller.closeSceneChannel(sceneKey)
    if (!closed) return
    if (this.threadOpen && social.getChannel().kind === 'messages') {
      this.threadOpen = false
    }
    this.syncLayout()
    this.renderAll()
  }

  private createPillButton(options: {
    channel: ChatChannelChoice
    title: string
    subtitle: string
    imageUrl?: string
    iconSvg?: string
    fallback?: string
    active: boolean
    disabled?: boolean
    unreadCount?: number
  }): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `chat-panel__rail-btn${options.active ? ' is-active' : ''}`
    btn.title = options.title
    btn.setAttribute('aria-label', options.title)
    btn.setAttribute('aria-current', options.active ? 'true' : 'false')
    btn.disabled = options.disabled ?? false

    if (options.imageUrl) {
      const img = document.createElement('img')
      img.src = options.imageUrl
      img.alt = ''
      img.className = 'chat-panel__rail-img'
      img.addEventListener('error', () => {
        img.remove()
        btn.textContent = options.fallback ?? '?'
      })
      btn.appendChild(img)
    } else if (options.iconSvg) {
      btn.classList.add('chat-panel__rail-btn--svg')
      btn.innerHTML = options.iconSvg
    } else {
      btn.textContent = options.fallback ?? '?'
    }

    this.appendUnreadBadge(btn, options.unreadCount ?? 0)
    this.wirePillTip(btn, options.title)

    if (!options.disabled) {
      btn.addEventListener('click', () => this.openChannel(options.channel))
    }

    return btn
  }

  private wirePillTip(btn: HTMLButtonElement, label: string): void {
    const show = (): void => {
      if (this.listExpanded || this.threadOpen) return
      const rect = btn.getBoundingClientRect()
      this.pillTipFloatEl.textContent = label
      this.pillTipFloatEl.style.top = `${Math.round(rect.top + rect.height / 2)}px`
      this.pillTipFloatEl.style.left = `${Math.round(rect.left - 10)}px`
      this.pillTipFloatEl.hidden = false
    }
    const hide = (): void => this.hidePillTip()

    btn.addEventListener('mouseenter', show)
    btn.addEventListener('mouseleave', hide)
    btn.addEventListener('focus', show)
    btn.addEventListener('blur', hide)
  }

  private hidePillTip(): void {
    this.pillTipFloatEl.hidden = true
    this.pillTipFloatEl.textContent = ''
  }

  private createListRow(options: {
    channel: ChatChannelChoice
    title: string
    subtitle: string
    imageUrl?: string
    iconSvg?: string
    fallback?: string
    active: boolean
    disabled?: boolean
    unreadCount?: number
    closable?: boolean
  }): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = `social-chat-dock__list-row-wrap${options.closable ? ' is-closable' : ''}`

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `social-chat-dock__list-row${options.active ? ' is-active' : ''}`
    btn.setAttribute('aria-label', options.title)
    btn.setAttribute('aria-current', options.active ? 'true' : 'false')
    btn.disabled = options.disabled ?? false

    const avatar = document.createElement('span')
    avatar.className = 'social-chat-dock__list-avatar'
    if (options.imageUrl) {
      const img = document.createElement('img')
      img.src = options.imageUrl
      img.alt = ''
      img.addEventListener('error', () => {
        img.remove()
        avatar.textContent = options.fallback ?? '?'
      })
      avatar.appendChild(img)
    } else if (options.iconSvg) {
      avatar.classList.add('social-chat-dock__list-avatar--svg')
      avatar.innerHTML = options.iconSvg
    } else {
      avatar.textContent = options.fallback ?? '?'
    }

    const text = document.createElement('span')
    text.className = 'social-chat-dock__list-text'
    const title = document.createElement('span')
    title.className = 'social-chat-dock__list-title'
    title.textContent = options.title
    const subtitle = document.createElement('span')
    subtitle.className = 'social-chat-dock__list-subtitle'
    subtitle.textContent = options.subtitle
    text.appendChild(title)
    text.appendChild(subtitle)

    this.appendUnreadBadge(avatar, options.unreadCount ?? 0)

    btn.appendChild(avatar)
    btn.appendChild(text)

    if (!options.disabled) {
      btn.addEventListener('click', () => this.openChannel(options.channel))
    }

    wrap.appendChild(btn)

    if (options.closable && options.channel.kind === 'scene') {
      const sceneKey = options.channel.sceneKey
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'social-chat-dock__list-close'
      close.setAttribute('aria-label', `Close ${options.title}`)
      close.textContent = '×'
      close.addEventListener('click', (ev) => this.closeSceneChannel(sceneKey, ev))
      wrap.appendChild(close)
      this.wireListRowSwipe(wrap, sceneKey)
    }

    return wrap
  }

  /** Mobile: swipe left to reveal dismiss; desktop uses the ×. */
  private wireListRowSwipe(wrap: HTMLElement, sceneKey: string): void {
    let startX = 0
    let dx = 0
    let tracking = false
    const row = wrap.querySelector('.social-chat-dock__list-row') as HTMLElement | null
    if (!row) return

    const reset = (): void => {
      tracking = false
      dx = 0
      row.style.transition = 'transform 0.18s ease'
      row.style.transform = ''
      wrap.classList.remove('is-swiped')
    }

    row.addEventListener(
      'touchstart',
      (ev) => {
        if (ev.touches.length !== 1) return
        tracking = true
        startX = ev.touches[0]!.clientX
        dx = 0
        row.style.transition = 'none'
      },
      { passive: true }
    )
    row.addEventListener(
      'touchmove',
      (ev) => {
        if (!tracking || ev.touches.length !== 1) return
        dx = ev.touches[0]!.clientX - startX
        // Swipe left only
        const x = Math.min(0, Math.max(-72, dx))
        row.style.transform = `translateX(${x}px)`
        wrap.classList.toggle('is-swiped', x < -24)
      },
      { passive: true }
    )
    row.addEventListener('touchend', () => {
      if (!tracking) return
      if (dx < -48) {
        this.closeSceneChannel(sceneKey)
        return
      }
      reset()
    })
    row.addEventListener('touchcancel', reset)
  }

  private appendUnreadBadge(container: HTMLElement, count: number): void {
    if (count <= 0) return
    const badge = document.createElement('span')
    badge.className = 'social-chat-dock__unread'
    badge.textContent = count > 99 ? '99+' : String(count)
    badge.setAttribute('aria-label', `${count} unread message${count === 1 ? '' : 's'}`)
    container.appendChild(badge)
  }

  private renderMessages(): void {
    const social = this.social()
    const lines = social.getMessages()
    const el = this.messagesEl
    const stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    const prevTop = el.scrollTop
    el.innerHTML = ''

    if (
      social.getChannel().kind === 'scene' &&
      !social.isSceneBrowserChatEnabled()
    ) {
      const empty = document.createElement('div')
      empty.className = 'chat-panel__empty'
      empty.textContent =
        'The creator has disabled browser chat for this scene. Jump in to explore — in-world chat may still be available.'
      el.appendChild(empty)
      return
    }

    if (!lines.length) {
      const empty = document.createElement('div')
      empty.className = 'chat-panel__empty'
      empty.textContent = 'No messages yet — say hello!'
      el.appendChild(empty)
      return
    }

    for (const line of lines) {
      el.appendChild(this.renderLine(line))
    }
    el.scrollTop = stickBottom ? el.scrollHeight : prevTop
  }

  private syncAutoTranslateIndicator(): void {
    if (!this.autoIndicatorEl) return
    const on = chatTranslationSettings.getAutoTranslate(socialChannelKey(this.social().getChannel()))
    this.autoIndicatorEl.hidden = !on
  }

  private renderLine(line: ChatLine): HTMLElement {
    const social = this.social()
    const local = social.getLocalDisplay()
    const localAddress = social.getLocalAddress()
    const channelKey = socialChannelKey(social.getChannel())
    const displayText = isChatImageLine(line)
      ? ''
      : chatTranslationService.displayText(line.id, line.text)
    const mentionsSelf =
      !isChatImageLine(line) &&
      !line.self &&
      textChatMentionsSelf(line.text, localAddress, local.displayName)

    const row = document.createElement('div')
    row.className = `chat-panel__line${line.self ? ' is-self' : ''}${isChatImageLine(line) ? ' is-image' : ''}`
    row.dataset.messageId = line.id

    const avatar = document.createElement('div')
    avatar.className = 'chat-panel__avatar'

    const bubble = document.createElement('div')
    bubble.className = `chat-panel__bubble${isChatImageLine(line) ? ' is-image' : ''}${
      mentionsSelf ? ' is-mentioned' : ''
    }`

    const name = document.createElement('div')
    name.className = 'chat-panel__sender'

    const body = document.createElement('div')
    body.className = isChatImageLine(line) ? 'chat-panel__media' : 'chat-panel__text'

    if (isChatImageLine(line)) {
      const img = document.createElement('img')
      img.className = 'chat-panel__image'
      img.src = line.objectUrl
      img.alt = 'Chat image'
      img.loading = 'lazy'
      img.decoding = 'async'
      if (line.width > 0) img.width = Math.min(line.width, 280)
      wireChatImageExpand(img, line.objectUrl)
      body.appendChild(img)
    } else {
      const selfTargets = selfMentionTokens(localAddress, local.displayName)
      appendChatTextWithSelfMentions(
        body,
        displayText,
        selfTargets,
        { onNavigate: (target) => void this.onGoto?.(target) },
        localAddress
      )
    }

    const time = document.createElement('div')
    time.className = 'chat-panel__time'
    time.textContent = SocialService.formatLineTime(line)

    if (line.self) {
      name.textContent = local.displayName
      name.style.color = local.nameColor
      this.fillAvatar(avatar, local.faceUrl, local.displayName)
      if (localAddress) {
        this.wireProfileOpen(avatar, localAddress)
        this.wireProfileOpen(name, localAddress)
      }
    } else {
      const peer = social.getPeerDisplay(line.senderAddress)
      name.textContent = peer.displayName
      name.style.color = peer.nameColor
      this.fillAvatar(avatar, peer.faceUrl, peer.displayName)
      if (line.senderAddress) {
        this.wireProfileOpen(avatar, line.senderAddress)
        this.wireProfileOpen(name, line.senderAddress)
      }
    }

    bubble.appendChild(name)
    bubble.appendChild(body)
    bubble.appendChild(time)
    if (!isChatImageLine(line)) {
      appendTranslateControls({
        bubble,
        line,
        channelKey,
        isSelf: Boolean(line.self)
      })
    }

    if (line.self) {
      row.appendChild(bubble)
      row.appendChild(avatar)
    } else {
      row.appendChild(avatar)
      row.appendChild(bubble)
    }
    return row
  }

  private wireProfileOpen(el: HTMLElement, address: string): void {
    if (!this.onOpenProfile) return
    el.classList.add('chat-panel__profile-hit')
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')
    el.setAttribute('title', 'View profile')
    const open = (): void => this.onOpenProfile?.(address)
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      open()
    })
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      open()
    })
  }

  private async submitMessage(): Promise<void> {
    const social = this.social()
    const channel = social.getChannel()
    const status = this.controller.getStatus()
    if (
      (channel.kind === 'community' || channel.kind === 'dm') &&
      (status.kind === 'guest' || !social.isReady())
    ) {
      return
    }

    const text = this.inputEl.value.trim().slice(0, CHAT_MAX_LENGTH)
    if (!text) return

    const goto = parseGotoCommand(text)
    if (goto) {
      this.inputEl.value = ''
      this.updateComposerUi()
      await this.onGoto?.(goto)
      return
    }

    // Ensure multi-room join for this tab, then publish (never drops other rooms).
    if (channel.kind === 'scene' && !social.isLiveSceneChannel(channel)) {
      const ok = await this.controller.ensureSceneChannelLive(channel.sceneKey)
      if (!ok || !this.visible) return
    }

    if (channel.kind === 'scene' && status.kind === 'guest') return

    const sent = await social.sendMessage(text)
    if (sent) {
      this.inputEl.value = ''
      this.updateComposerUi()
      this.renderMessages()
    }
  }

  private updateComposerUi(): void {
    const status = this.controller.getStatus()
    const social = this.social()
    const channel = social.getChannel()
    const socialReady = social.isReady()
    const liveScene = channel.kind === 'scene' && social.isLiveSceneChannel(channel)
    const connectingScene =
      channel.kind === 'scene' &&
      !liveScene &&
      social.isSceneBrowserChatEnabled() &&
      status.kind !== 'guest' &&
      status.kind !== 'scene_ban'
    const canChat =
      channel.kind === 'community'
        ? socialReady && status.kind !== 'guest' && social.isPrivateMessagesReady()
        : channel.kind === 'dm'
          ? socialReady && status.kind !== 'guest' && social.isPrivateMessagesReady()
          : channel.kind === 'scene'
            ? liveScene && social.isSceneBrowserChatEnabled() && status.kind !== 'guest'
            : false
    this.inputEl.disabled = !canChat || this.imageSending || status.kind === 'connecting' || connectingScene
    this.composerEl.classList.toggle(
      'social-chat-dock__composer--disabled',
      !canChat || status.kind === 'connecting' || connectingScene
    )

    // Remove legacy rejoin CTA if present.
    const rejoinBtn = this.composerEl.querySelector<HTMLButtonElement>('.social-chat-dock__rejoin')
    if (rejoinBtn) {
      rejoinBtn.hidden = true
      rejoinBtn.onclick = null
    }

    if (!this.imageSending) {
      if (channel.kind === 'scene' && status.kind === 'scene_ban') {
        this.inputEl.placeholder = status.title
      } else if (channel.kind === 'scene' && !social.isSceneBrowserChatEnabled()) {
        this.inputEl.placeholder = 'Browser chat is disabled for this scene'
      } else if (channel.kind === 'scene' && (status.kind === 'connecting' || connectingScene)) {
        this.inputEl.placeholder = 'Connecting…'
      } else if (channel.kind === 'scene') {
        this.inputEl.placeholder = 'Press Enter to chat — drop an image'
      } else if (channel.kind === 'dm' && social.isPrivateMessagesConnecting()) {
        this.inputEl.placeholder = 'Joining private chat…'
      } else if (channel.kind === 'dm' && social.getPrivateMessagesError()) {
        this.inputEl.placeholder = 'Private chat offline — try again'
      } else if (channel.kind === 'dm' && !social.isPrivateMessagesReady()) {
        this.inputEl.placeholder = 'Private message…'
      } else if (channel.kind === 'dm') {
        this.inputEl.placeholder = 'Private message…'
      } else if (channel.kind === 'community' && social.isPrivateMessagesConnecting()) {
        this.inputEl.placeholder = 'Joining community chat…'
      } else if (channel.kind === 'community' && social.getPrivateMessagesError()) {
        this.inputEl.placeholder = 'Community chat offline — try again'
      } else if (channel.kind === 'community') {
        this.inputEl.placeholder = 'Message the community…'
      } else {
        this.inputEl.placeholder = 'Press Enter to chat'
      }
    }

    const value = this.inputEl.value
    this.inputEl.classList.toggle(
      'chat-panel__input--goto',
      /^\/(?:goto|changerealm|change-realm|realm)\b/i.test(value)
    )
    this.composerEl.classList.toggle('chat-panel__composer--mention', Boolean(this.activeMention()))

    const am = this.activeMention()
    if (!am || channel.kind !== 'scene') {
      this.mentionPopupRows = []
      this.mentionDockEl.hidden = true
      this.lastMentionStart = null
      return
    }

    if (this.lastMentionStart !== am.start) {
      this.mentionHighlight = 0
      this.lastMentionStart = am.start
    }

    this.mentionPopupRows = filterMentionPopupRows(this.social().getMentionCandidates(), am.query)
    if (this.mentionPopupRows.length === 0) {
      this.mentionDockEl.hidden = true
      return
    }

    this.mentionHighlight = Math.min(this.mentionHighlight, this.mentionPopupRows.length - 1)
    this.mentionDockEl.hidden = false
    this.renderMentionPopup()
  }

  private onComposerDragEnter = (e: DragEvent): void => {
    if (!this.canAcceptImageDrop()) return
    e.preventDefault()
    this.composerEl.classList.add('chat-panel__composer--drop')
  }

  private onComposerDragOver = (e: DragEvent): void => {
    if (!this.canAcceptImageDrop()) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    this.composerEl.classList.add('chat-panel__composer--drop')
  }

  private onComposerDragLeave = (e: DragEvent): void => {
    if (e.currentTarget !== this.composerEl) return
    this.composerEl.classList.remove('chat-panel__composer--drop')
  }

  private onComposerDrop = (e: DragEvent): void => {
    e.preventDefault()
    this.composerEl.classList.remove('chat-panel__composer--drop')
    if (!this.canAcceptImageDrop()) return
    const file = this.pickImageFileFromDataTransfer(e.dataTransfer)
    if (!file) return
    void this.sendImageFile(file)
  }

  private canAcceptImageDrop(): boolean {
    return (
      this.visible &&
      this.controller.getStatus().kind === 'connected' &&
      this.social().getChannel().kind === 'scene' &&
      !this.imageSending
    )
  }

  private pickImageFileFromDataTransfer(dt: DataTransfer | null): File | null {
    if (!dt) return null
    for (const file of [...dt.files]) {
      if (isAllowedChatImageFile(file)) return file
    }
    return null
  }

  private async sendImageFile(file: File): Promise<void> {
    if (this.imageSending || this.social().getChannel().kind !== 'scene') return
    this.imageSending = true
    this.updateComposerUi()
    try {
      const sent = await this.social().sendImageFile(file)
      if (sent) this.renderMessages()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.inputEl.placeholder = msg
      window.setTimeout(() => this.updateComposerUi(), 3000)
    } finally {
      this.imageSending = false
      this.updateComposerUi()
    }
  }

  private fillAvatar(el: HTMLElement, faceUrl: string | null, fallbackLabel: string): void {
    el.textContent = ''
    if (faceUrl) {
      const img = document.createElement('img')
      img.src = faceUrl
      img.alt = ''
      img.className = 'chat-panel__avatar-img'
      el.appendChild(img)
      return
    }
    el.textContent = fallbackLabel.slice(0, 1).toUpperCase()
  }

  private onInputChange = (): void => {
    const next = this.inputEl.value.slice(0, CHAT_MAX_LENGTH)
    if (next !== this.inputEl.value) this.inputEl.value = next
    this.inputCaret = effectiveCaretForMention(next, this.inputEl.selectionStart ?? next.length)
    this.updateComposerUi()
  }

  private onInputSelect = (): void => {
    this.inputCaret = effectiveCaretForMention(
      this.inputEl.value,
      this.inputEl.selectionStart ?? this.inputEl.selectionEnd ?? this.inputEl.value.length
    )
    this.updateComposerUi()
  }

  private onInputKeyDown = (e: KeyboardEvent): void => {
    if (this.mentionPopupRows.length > 0 && this.activeMention()) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        this.mentionHighlight = (this.mentionHighlight + 1) % this.mentionPopupRows.length
        this.renderMentionPopup()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        this.mentionHighlight =
          (this.mentionHighlight - 1 + this.mentionPopupRows.length) % this.mentionPopupRows.length
        this.renderMentionPopup()
        return
      }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        const pick = this.mentionPopupRows[this.mentionHighlight]
        if (pick) this.commitMentionPick(pick)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        const am = this.activeMention()
        if (am) {
          const caret = effectiveCaretForMention(this.inputEl.value, this.inputCaret)
          const next = this.inputEl.value.slice(0, am.start) + this.inputEl.value.slice(caret)
          this.inputEl.value = next
          this.inputEl.setSelectionRange(am.start, am.start)
          this.inputCaret = am.start
          this.updateComposerUi()
        }
        return
      }
      if (e.key === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault()
        const pick = this.mentionPopupRows[this.mentionHighlight]
        if (pick) this.commitMentionPick(pick)
        return
      }
    }
    // Explicit send — do not rely only on form submit (can be swallowed by other handlers).
    if (
      (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') &&
      !e.shiftKey &&
      !e.repeat &&
      !e.isComposing
    ) {
      e.preventDefault()
      e.stopPropagation()
      void this.submitMessage()
    }
  }

  private activeMention(): { start: number; query: string } | null {
    return parseActiveMention(
      this.inputEl.value,
      effectiveCaretForMention(this.inputEl.value, this.inputCaret)
    )
  }

  private renderMentionPopup(): void {
    this.mentionListEl.innerHTML = ''
    for (let i = 0; i < this.mentionPopupRows.length; i++) {
      const row = this.mentionPopupRows[i]!
      const item = document.createElement('li')
      item.className = `chat-panel__mention-item${i === this.mentionHighlight ? ' is-active' : ''}`
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', i === this.mentionHighlight ? 'true' : 'false')

      const avatar = document.createElement('div')
      avatar.className = 'chat-panel__mention-avatar'
      this.fillAvatar(avatar, row.faceUrl, row.displayName)

      const label = document.createElement('span')
      label.className = 'chat-panel__mention-label'
      label.textContent = row.displayName

      item.appendChild(avatar)
      item.appendChild(label)
      item.addEventListener('mouseenter', () => {
        this.mentionHighlight = i
        this.renderMentionPopup()
      })
      item.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        this.commitMentionPick(row)
      })
      this.mentionListEl.appendChild(item)
    }
  }

  private commitMentionPick(row: MentionCandidate): void {
    const caret = effectiveCaretForMention(this.inputEl.value, this.inputCaret)
    const am = parseActiveMention(this.inputEl.value, caret)
    if (!am) return
    const label = mentionInsertLabel(row.displayName, row.address)
    const { next, caretPos } = applyMentionToDraft(this.inputEl.value, am.start, caret, label)
    this.inputEl.value = next.slice(0, CHAT_MAX_LENGTH)
    this.inputEl.focus()
    this.inputEl.setSelectionRange(caretPos, caretPos)
    this.inputCaret = caretPos
    this.mentionHighlight = 0
    this.updateComposerUi()
  }

  private isMobilePeek(): boolean {
    return (
      this.isMobileLayout() &&
      this.visible &&
      !this.panelOpen &&
      this.threadOpen
    )
  }

  private syncLayout(): void {
    const mobile = this.isMobileLayout()
    const mobilePeek = this.isMobilePeek()

    if (mobile) {
      this.listExpanded = true
      this.clearContentAlign()
    }

    this.root.classList.toggle('social-chat-dock--thread-open', this.threadOpen)
    // Expanded list only when browsing channels — hide list while a thread is open (mobile + desktop).
    this.root.classList.toggle(
      'social-chat-dock--list-expanded',
      this.useExpandedChannelList() && !this.threadOpen
    )
    this.root.classList.toggle('social-chat-dock--panel-open', this.panelOpen)
    this.root.classList.toggle('social-chat-dock--mobile', mobile)
    this.root.classList.toggle('social-chat-dock--mobile-open', mobile && this.panelOpen)
    this.root.classList.toggle('social-chat-dock--mobile-peek', mobilePeek)

    this.social().setChannelThreadOpen(this.threadOpen && this.panelOpen)

    this.threadEl.hidden = !this.threadOpen
    // Same as mobile: open a chat → hide channel list until Back.
    this.pillsEl.hidden = this.threadOpen

    if (mobile) {
      this.root.hidden = !this.visible || (!this.panelOpen && !mobilePeek)
      this.mobileBackdrop.hidden = !this.visible || !this.panelOpen
      document.body.classList.toggle('social-chat-mobile-open', this.visible && this.panelOpen)
    } else {
      // Desktop: dock only while expanded from FAB (or scene auto-open).
      this.root.hidden = !this.visible || !this.panelOpen
      this.mobileBackdrop.hidden = true
      document.body.classList.remove('social-chat-mobile-open')
    }

    if (this.listExpanded || this.threadOpen) this.hidePillTip()
    this.updateChatFab()
    // Guest "Sign in to chat" visibility depends on panel open state.
    this.renderStatus(this.controller.getStatus())

    if (!mobile) this.syncContentAlign()
  }

  private bindContentAlign(): void {
    this.unbindContentAlign()
    window.addEventListener('resize', this.onAlignViewportChange)
    const landingMain = document.querySelector('.scene-landing-view__main')
    landingMain?.addEventListener('scroll', this.onAlignViewportChange, { passive: true })

    this.alignResizeObs = new ResizeObserver(() => this.syncContentAlign())
    const card = document.querySelector('.scene-watch-dest-scene-card')
    if (card) this.alignResizeObs.observe(card)
    if (landingMain) {
      this.alignResizeObs.observe(landingMain)
      this.alignMutationObs = new MutationObserver(() => this.syncContentAlign())
      this.alignMutationObs.observe(landingMain, { childList: true, subtree: true })
    }
  }

  private unbindContentAlign(): void {
    window.removeEventListener('resize', this.onAlignViewportChange)
    const landingMain = document.querySelector('.scene-landing-view__main')
    landingMain?.removeEventListener('scroll', this.onAlignViewportChange)
    this.alignResizeObs?.disconnect()
    this.alignResizeObs = null
    this.alignMutationObs?.disconnect()
    this.alignMutationObs = null
    if (this.alignRetryTimer !== null) {
      window.clearTimeout(this.alignRetryTimer)
      this.alignRetryTimer = null
    }
  }

  private clearContentAlign(): void {
    this.root.classList.remove('social-chat-dock--scene-aligned')
    this.root.style.top = ''
    this.root.style.height = ''
    this.root.style.bottom = ''
  }

  /** On scene landing, align chat top to the scene info card; keep full height to viewport bottom. */
  private syncContentAlign(): void {
    if (!this.visible || this.isMobileLayout()) return

    if (!document.body.classList.contains('scene-landing-route')) {
      this.clearContentAlign()
      return
    }

    const card = document.querySelector('.scene-watch-dest-scene-card')
    if (!card) {
      this.clearContentAlign()
      if (this.alignRetryTimer === null) {
        this.alignRetryTimer = window.setTimeout(() => {
          this.alignRetryTimer = null
          this.syncContentAlign()
        }, 200)
      }
      return
    }

    if (this.alignRetryTimer !== null) {
      window.clearTimeout(this.alignRetryTimer)
      this.alignRetryTimer = null
    }

    const rect = card.getBoundingClientRect()
    if (rect.height < 40) return

    this.root.classList.add('social-chat-dock--scene-aligned')
    this.root.style.top = `${Math.round(rect.top)}px`
    this.root.style.height = ''
    // Match CSS: leave clear space for the bottom-right FAB.
    this.root.style.bottom = ''
  }
}