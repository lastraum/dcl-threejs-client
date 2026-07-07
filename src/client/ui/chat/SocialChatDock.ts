import type { RouteTarget } from '../../../dcl/content/route'
import { parseGotoCommand } from '../../../dcl/content/route'
import { textChatMentionsSelf } from '../../../social/chatMentionDetection'
import {
  CHAT_MAX_LENGTH,
  applyMentionToDraft,
  effectiveCaretForMention,
  filterMentionPopupRows,
  mentionInsertLabel,
  parseActiveMention,
  type MentionCandidate
} from '../../../social/chatMentions'
import { appendLinkifiedText } from '../../../social/linkifyText'
import { communityDisplayImageUrl } from '../../../social/communityThumbnails'
import { isAllowedChatImageFile } from '../../../social/prepareChatImage'
import { SocialService } from '../../../social/SocialService'
import { isChatImageLine, type ChatChannelChoice, type ChatLine } from '../../../social/types'
import { SCENE_CHAT_RAIL_ICON, SIDEBAR_ICONS } from '../shell/icons'
import type { SocialChatController, SocialChatStatus } from './SocialChatController'

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
  private readonly pillsToolbarEl: HTMLElement
  private readonly pillsScrollEl: HTMLElement
  private readonly expandBtn: HTMLButtonElement
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
  private mobilePanelOpen = false
  private unsubChat: (() => void) | null = null
  private unsubChannel: (() => void) | null = null
  private unsubProfiles: (() => void) | null = null
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

    this.pillsEl = document.createElement('nav')
    this.pillsEl.className = 'social-chat-dock__pills chat-panel__rail'
    this.pillsEl.setAttribute('aria-label', 'Chat channels')

    this.pillsToolbarEl = document.createElement('div')
    this.pillsToolbarEl.className = 'social-chat-dock__pills-toolbar'
    this.expandBtn = document.createElement('button')
    this.expandBtn.type = 'button'
    this.expandBtn.className = 'social-chat-dock__expand'
    this.expandBtn.setAttribute('aria-label', 'Expand chat list')
    this.expandBtn.setAttribute('aria-expanded', 'false')
    this.expandBtn.textContent = '‹'
    this.pillsToolbarEl.appendChild(this.expandBtn)

    this.pillsScrollEl = document.createElement('div')
    this.pillsScrollEl.className = 'chat-panel__rail-scroll'
    this.pillsEl.appendChild(this.pillsToolbarEl)
    this.pillsEl.appendChild(this.pillsScrollEl)

    this.threadEl = document.createElement('section')
    this.threadEl.className = 'social-chat-dock__thread'
    this.threadEl.innerHTML = `
      <header class="social-chat-dock__thread-header">
        <button type="button" class="social-chat-dock__back" aria-label="Back to channels">←</button>
        <span class="social-chat-dock__thread-avatar" aria-hidden="true"></span>
        <div class="social-chat-dock__thread-head-text">
          <div class="social-chat-dock__thread-title"></div>
          <div class="social-chat-dock__thread-subtitle"></div>
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

    this.root.appendChild(this.statusEl)
    this.root.appendChild(body)

    this.pillTipFloatEl = document.createElement('div')
    this.pillTipFloatEl.className = 'social-chat-dock__pill-tip-float'
    this.pillTipFloatEl.hidden = true
    this.pillTipFloatEl.setAttribute('role', 'tooltip')

    this.headerAvatarEl = this.threadEl.querySelector('.social-chat-dock__thread-avatar')!
    this.headerTitle = this.threadEl.querySelector('.social-chat-dock__thread-title')!
    this.headerSubtitle = this.threadEl.querySelector('.social-chat-dock__thread-subtitle')!
    this.messagesEl = this.threadEl.querySelector('.social-chat-dock__messages')!
    this.composerEl = this.threadEl.querySelector('.social-chat-dock__composer')!
    this.mentionDockEl = this.threadEl.querySelector('.chat-panel__mention-dock')!
    this.mentionListEl = this.threadEl.querySelector('.chat-panel__mention-list')!
    this.inputEl = this.threadEl.querySelector('.social-chat-dock__input')!
    this.backBtn = this.threadEl.querySelector('.social-chat-dock__back')!

    this.backBtn.addEventListener('click', () => {
      this.threadOpen = false
      if (this.isMobileLayout()) this.listExpanded = true
      this.syncLayout()
      this.renderPills()
    })

    this.expandBtn.addEventListener('click', () => {
      this.listExpanded = !this.listExpanded
      this.hidePillTip()
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
    this.mobileBackdrop.addEventListener('click', () => this.closeMobilePanel())

    this.mobileFab = document.createElement('button')
    this.mobileFab.type = 'button'
    this.mobileFab.className = 'social-chat-dock__mobile-fab'
    this.mobileFab.setAttribute('aria-label', 'Open chat')
    this.mobileFab.setAttribute('aria-expanded', 'false')
    this.mobileFab.hidden = true
    this.mobileFab.innerHTML = `
      <span class="social-chat-dock__mobile-fab-icon" aria-hidden="true">${SIDEBAR_ICONS.chat}</span>
    `
    this.mobileFabBadge = document.createElement('span')
    this.mobileFabBadge.className = 'social-chat-dock__mobile-fab-badge'
    this.mobileFabBadge.hidden = true
    this.mobileFab.appendChild(this.mobileFabBadge)
    this.mobileFab.addEventListener('click', () => this.toggleMobilePanel())

    this.mobileMq = window.matchMedia(SOCIAL_CHAT_MOBILE_MQ)
    this.mobileMq.addEventListener('change', this.onMobileMqChange)
  }

  show(): void {
    this.ensureMounted()
    this.visible = true
    this.threadOpen = false
    this.mobilePanelOpen = false
    if (this.isMobileLayout()) this.listExpanded = true
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
    this.mobilePanelOpen = false
    this.root.hidden = true
    this.mobileFab.hidden = true
    this.mobileBackdrop.hidden = true
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

  /** Notifications bell — open chat panel (mobile sheet or desktop expanded list). */
  openFromNotification(): void {
    if (!this.visible) return
    if (this.isMobileLayout()) {
      this.openMobilePanel()
      return
    }
    this.listExpanded = true
    this.threadOpen = false
    this.syncLayout()
    this.renderPills()
  }

  /** Scene landing — select scene channel; desktop opens thread, mobile stays on FAB only. */
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
    if (this.isMobileLayout()) {
      this.threadOpen = false
      this.mobilePanelOpen = false
    } else {
      this.threadOpen = true
    }
    this.syncLayout()
    this.renderAll()
  }

  dispose(): void {
    this.hide()
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

  private toggleMobilePanel(): void {
    if (this.mobilePanelOpen) this.closeMobilePanel()
    else this.openMobilePanel()
  }

  private openMobilePanel(): void {
    if (!this.visible || !this.isMobileLayout()) return
    this.mobilePanelOpen = true
    this.threadOpen = false
    this.listExpanded = true
    this.hidePillTip()
    this.syncLayout()
    this.renderPills()
  }

  private closeMobilePanel(): void {
    if (!this.mobilePanelOpen) return
    this.mobilePanelOpen = false
    this.threadOpen = false
    this.listExpanded = true
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
      this.updateComposerUi()
    })
    this.unsubChannel = social.onChannelChange(() => this.renderAll())
    this.unsubProfiles = social.onPeerProfilesChange(() => {
      this.renderMessages()
      this.updateComposerUi()
    })
  }

  private unbindSocial(): void {
    this.unsubChat?.()
    this.unsubChannel?.()
    this.unsubProfiles?.()
    this.unsubChat = null
    this.unsubChannel = null
    this.unsubProfiles = null
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
    this.updateMobileFab()
  }

  private totalUnreadCount(): number {
    const social = this.social()
    const current = social.getChannel()
    let total = 0

    for (const scene of social.getSceneTabs()) {
      const channel = { kind: 'scene' as const, sceneKey: scene.key, label: scene.label }
      const active = current.kind === 'scene' && current.sceneKey === scene.key
      if (!active) total += social.getUnreadCount(channel)
    }

    for (const community of social.getCommunities()) {
      const channel = {
        kind: 'community' as const,
        communityId: community.id,
        displayName: community.name
      }
      const active = current.kind === 'community' && current.communityId === community.id
      if (!active) total += social.getUnreadCount(channel)
    }

    return total
  }

  private updateMobileFab(): void {
    if (!this.mounted) return
    const mobile = this.isMobileLayout()
    this.mobileFab.hidden = !this.visible || !mobile
    if (!mobile) return

    this.mobileFab.classList.toggle('is-active', this.mobilePanelOpen)
    this.mobileFab.setAttribute('aria-expanded', String(this.mobilePanelOpen))
    this.mobileFab.setAttribute(
      'aria-label',
      this.mobilePanelOpen ? 'Close chat' : 'Open chat'
    )

    const unread = this.mobilePanelOpen ? 0 : this.totalUnreadCount()
    if (unread > 0) {
      this.mobileFabBadge.hidden = false
      this.mobileFabBadge.textContent = unread > 99 ? '99+' : String(unread)
    } else {
      this.mobileFabBadge.hidden = true
      this.mobileFabBadge.textContent = ''
    }
  }

  private renderStatus(status: SocialChatStatus): void {
    let message = ''
    let tone: 'info' | 'warn' | 'error' = 'info'

    switch (status.kind) {
      case 'guest':
        message = 'Sign in to chat'
        tone = 'warn'
        break
      case 'connecting':
        message = 'Connecting to scene chat…'
        break
      case 'duplicate_wallet':
        message = 'This wallet is already connected in another session'
        tone = 'error'
        break
      case 'failed':
        message = status.message
        tone = 'error'
        break
      case 'idle':
        message = this.social().getCommunities().length > 0 ? '' : 'Visit a scene for scene chat'
        break
      case 'connected':
        message = ''
        break
      case 'browser_chat_disabled':
        message = 'Browser chat is disabled for this scene'
        tone = 'warn'
        break
    }

    if (!message) {
      this.statusEl.hidden = true
      this.statusEl.textContent = ''
      return
    }

    this.statusEl.hidden = false
    this.statusEl.className = `social-chat-dock__status social-chat-dock__status--${tone}`
    this.statusEl.textContent = message
  }

  private renderThreadHeader(): void {
    const social = this.social()
    const channel = social.getChannel()
    this.headerTitle.textContent = social.getChannelTitle()
    this.headerSubtitle.textContent = social.getChannelSubtitle()
    this.headerAvatarEl.className = 'social-chat-dock__thread-avatar'
    this.headerAvatarEl.innerHTML = ''

    if (channel.kind === 'scene') {
      this.headerAvatarEl.classList.add('social-chat-dock__thread-avatar--svg')
      this.headerAvatarEl.innerHTML = SCENE_CHAT_RAIL_ICON
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

    this.headerAvatarEl.textContent = '✉'
  }

  private renderPills(): void {
    this.hidePillTip()
    const social = this.social()
    const current = social.getChannel()
    this.pillsScrollEl.innerHTML = ''
    this.pillsScrollEl.classList.toggle('social-chat-dock__list-scroll', this.useExpandedChannelList())

    for (const scene of social.getSceneTabs()) {
      const channel = { kind: 'scene' as const, sceneKey: scene.key, label: scene.label }
      const active = current.kind === 'scene' && current.sceneKey === scene.key
      this.pillsScrollEl.appendChild(
        this.createChannelEntry({
          channel,
          title: scene.label,
          subtitle: scene.browserChatEnabled ? 'Scene chat' : 'Chat disabled',
          iconSvg: SCENE_CHAT_RAIL_ICON,
          active,
          unreadCount: active ? 0 : social.getUnreadCount(channel)
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
      this.pillsScrollEl.appendChild(
        this.createChannelEntry({
          channel,
          title: community.name,
          subtitle: 'Community',
          imageUrl: communityDisplayImageUrl(community.id, community.thumbnails),
          fallback: community.name.slice(0, 1).toUpperCase(),
          active,
          unreadCount: active ? 0 : social.getUnreadCount(channel)
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
  }): HTMLButtonElement {
    if (this.useExpandedChannelList()) return this.createListRow(options)
    return this.createPillButton(options)
  }

  private openChannel(channel: ChatChannelChoice): void {
    this.social().selectChannel(channel)
    this.threadOpen = true
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
  }): HTMLButtonElement {
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

    return btn
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
    this.messagesEl.innerHTML = ''

    if (
      social.getChannel().kind === 'scene' &&
      !social.isSceneBrowserChatEnabled()
    ) {
      const empty = document.createElement('div')
      empty.className = 'chat-panel__empty'
      empty.textContent =
        'The creator has disabled browser chat for this scene. Jump in to explore — in-world chat may still be available.'
      this.messagesEl.appendChild(empty)
      return
    }

    if (!lines.length) {
      const empty = document.createElement('div')
      empty.className = 'chat-panel__empty'
      empty.textContent = 'No messages yet — say hello!'
      this.messagesEl.appendChild(empty)
      return
    }

    for (const line of lines) {
      this.messagesEl.appendChild(this.renderLine(line))
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight
  }

  private renderLine(line: ChatLine): HTMLElement {
    const social = this.social()
    const local = social.getLocalDisplay()
    const localAddress = social.getLocalAddress()
    const mentionsSelf =
      !isChatImageLine(line) &&
      !line.self &&
      textChatMentionsSelf(line.text, localAddress, local.displayName)

    const row = document.createElement('div')
    row.className = `chat-panel__line${line.self ? ' is-self' : ''}${isChatImageLine(line) ? ' is-image' : ''}`

    const avatar = document.createElement('div')
    avatar.className = 'chat-panel__avatar'

    const bubble = document.createElement('div')
    bubble.className = `chat-panel__bubble${mentionsSelf ? ' is-mentioned' : ''}${isChatImageLine(line) ? ' is-image' : ''}`

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
      body.appendChild(img)
    } else {
      appendLinkifiedText(body, line.text, {
        onNavigate: (target) => void this.onGoto?.(target)
      })
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
    const channel = this.social().getChannel()
    const status = this.controller.getStatus()
    if (channel.kind === 'scene' && status.kind !== 'connected') return
    if (channel.kind === 'community' && (status.kind === 'guest' || !this.social().isReady())) return

    const text = this.inputEl.value.trim().slice(0, CHAT_MAX_LENGTH)
    if (!text) return

    const goto = parseGotoCommand(text)
    if (goto) {
      this.inputEl.value = ''
      this.updateComposerUi()
      await this.onGoto?.(goto)
      return
    }

    const sent = await this.social().sendMessage(text)
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
    const sceneChatAllowed =
      channel.kind !== 'scene' || (social.isSceneBrowserChatEnabled() && status.kind === 'connected')
    const canChat =
      channel.kind === 'community'
        ? socialReady && status.kind !== 'guest'
        : channel.kind === 'scene'
          ? sceneChatAllowed
          : false
    this.inputEl.disabled = !canChat || this.imageSending
    this.composerEl.classList.toggle('social-chat-dock__composer--disabled', !canChat)

    if (!this.imageSending) {
      if (channel.kind === 'scene' && !social.isSceneBrowserChatEnabled()) {
        this.inputEl.placeholder = 'Browser chat is disabled for this scene'
      } else if (channel.kind === 'scene') {
        this.inputEl.placeholder = 'Press Enter to chat — drop an image'
      } else {
        this.inputEl.placeholder = 'Press Enter to chat'
      }
    }

    const value = this.inputEl.value
    this.inputEl.classList.toggle('chat-panel__input--goto', /^\/goto/i.test(value))
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
      if (e.key === 'Enter') {
        e.preventDefault()
        const pick = this.mentionPopupRows[this.mentionHighlight]
        if (pick) this.commitMentionPick(pick)
        return
      }
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

  private syncLayout(): void {
    const mobile = this.isMobileLayout()

    if (mobile) {
      this.listExpanded = true
      this.clearContentAlign()
    }

    this.root.classList.toggle('social-chat-dock--thread-open', this.threadOpen)
    this.root.classList.toggle(
      'social-chat-dock--list-expanded',
      this.useExpandedChannelList() && !this.threadOpen
    )
    this.root.classList.toggle('social-chat-dock--mobile', mobile)
    this.root.classList.toggle('social-chat-dock--mobile-open', mobile && this.mobilePanelOpen)

    this.threadEl.hidden = !this.threadOpen
    this.pillsEl.hidden = this.threadOpen
    this.pillsToolbarEl.hidden = mobile
    this.expandBtn.hidden = this.threadOpen || mobile
    this.expandBtn.setAttribute('aria-expanded', String(this.listExpanded))
    this.expandBtn.setAttribute(
      'aria-label',
      this.listExpanded ? 'Collapse chat list' : 'Expand chat list'
    )
    this.expandBtn.textContent = this.listExpanded ? '›' : '‹'

    if (mobile) {
      this.root.hidden = !this.visible || !this.mobilePanelOpen
      this.mobileBackdrop.hidden = !this.visible || !this.mobilePanelOpen
      document.body.classList.toggle('social-chat-mobile-open', this.visible && this.mobilePanelOpen)
    } else {
      this.mobilePanelOpen = false
      this.root.hidden = !this.visible
      this.mobileBackdrop.hidden = true
      document.body.classList.remove('social-chat-mobile-open')
    }

    if (this.listExpanded || this.threadOpen) this.hidePillTip()
    this.updateMobileFab()

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
    this.root.style.bottom = '0'
  }
}