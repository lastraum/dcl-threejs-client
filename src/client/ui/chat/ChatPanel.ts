import { SocialService } from '../../../social/SocialService'
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
import type { RouteTarget } from '../../../dcl/content/route'
import { parseGotoCommand } from '../../../dcl/content/route'
import { sceneChatRailIcon } from '../shell/icons'
import { communityDisplayImageUrl } from '../../../social/communityThumbnails'
import { isAllowedChatImageFile } from '../../../social/prepareChatImage'
import { socialChannelKey } from '../../../social/SocialService'
import {
  chatTranslationService,
  chatTranslationSettings
} from '../../../social/translation'
import { isChatImageLine, type ChatChannelChoice, type ChatLine } from '../../../social/types'
import { wireChatImageExpand } from './chatImageLightbox'
import { ChatChannelMenu } from './ChatChannelMenu'
import { appendTranslateControls } from './chatTranslateUi'

export type ChatPanelOptions = {
  social: SocialService
  onVisibilityChange?: (visible: boolean) => void
  onGoto?: (target: RouteTarget) => void | Promise<void>
  onOpenProfile?: (address: string) => void
}

type ChatBodyMode = 'messages' | 'users'

const USERS_ICON = `<svg class="chat-panel__users-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="9" cy="8" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 17c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="16.5" cy="9" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M13.5 17c.4-1.6 1.7-2.8 3.3-2.8 1 0 1.9.4 2.5 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`

const MORE_ICON = `<svg class="chat-panel__more-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>`

const AUTO_INDICATOR_ICON = `<svg class="chat-panel__auto-ind-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M4 5h7M7.5 5v1a8 8 0 0 0 8 8h.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M5 19h14M13 9l3.5 10M20.5 19 17 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`

/** Compact bottom-left chat window with a vertical channel rail on the right. */
export class ChatPanel {
  readonly root: HTMLElement
  private readonly panelEl: HTMLElement
  private readonly railEl: HTMLElement
  private readonly railScrollEl: HTMLElement
  private readonly headerTitle: HTMLElement
  private readonly headerSubtitle: HTMLElement
  private readonly autoIndicatorEl: HTMLElement
  private readonly usersBtn: HTMLButtonElement
  private readonly moreBtn: HTMLButtonElement
  private readonly messagesEl: HTMLElement
  private readonly composerEl: HTMLElement
  private readonly mentionDockEl: HTMLElement
  private readonly mentionListEl: HTMLUListElement
  private readonly inputEl: HTMLInputElement
  private readonly social: SocialService
  private readonly channelMenu: ChatChannelMenu
  private readonly onGoto?: ChatPanelOptions['onGoto']
  private readonly onOpenProfile?: ChatPanelOptions['onOpenProfile']
  private onVisibilityChange: ((visible: boolean) => void) | null = null
  /** Fired when open+pinned vs closed/scene-mode changes (HUD unread badge). */
  private onReadingChange: ((reading: boolean) => void) | null = null
  private visible = false
  private bodyMode: ChatBodyMode = 'messages'
  private unsubChat: (() => void) | null = null
  private unsubChannel: (() => void) | null = null
  private unsubProfiles: (() => void) | null = null
  private unsubTranslate: (() => void) | null = null
  private unsubTranslateSettings: (() => void) | null = null
  private presenceTimer: number | null = null
  private mounted = false
  private readonly sceneCanvas: HTMLElement | null
  private inputCaret = 0
  private mentionHighlight = 0
  private mentionPopupRows: MentionCandidate[] = []
  private lastMentionStart: number | null = null
  private imageSending = false

  constructor({ social, onVisibilityChange, onGoto, onOpenProfile }: ChatPanelOptions) {
    this.social = social
    this.onGoto = onGoto
    this.onOpenProfile = onOpenProfile
    this.onVisibilityChange = onVisibilityChange ?? null
    this.sceneCanvas = document.querySelector('#app canvas')

    window.addEventListener('keydown', this.onGlobalKeyDown, true)
    this.root = document.createElement('div')
    this.root.id = 'chat-panel-wrap'
    this.root.className = 'chat-panel-wrap'
    this.root.hidden = true

    this.panelEl = document.createElement('aside')
    this.panelEl.className = 'chat-panel'
    this.panelEl.innerHTML = `
      <header class="chat-panel__header">
        <div class="chat-panel__header-text">
          <div class="chat-panel__title"></div>
          <div class="chat-panel__auto-indicator" hidden>${AUTO_INDICATOR_ICON}<span class="chat-panel__auto-indicator-text">Auto-Translate On</span></div>
          <div class="chat-panel__subtitle"></div>
        </div>
        <div class="chat-panel__header-actions">
          <button type="button" class="chat-panel__users-btn" hidden aria-pressed="false" title="People in scene"></button>
          <button type="button" class="chat-panel__more-btn" aria-label="More channel options" aria-haspopup="menu" title="More">${MORE_ICON}</button>
          <button type="button" class="chat-panel__close" aria-label="Close chat">×</button>
        </div>
      </header>
      <div class="chat-panel__messages" role="log" aria-live="polite"></div>
      <form class="chat-panel__composer">
        <div class="chat-panel__mention-dock" hidden>
          <div class="chat-panel__mention-head">Mention suggestions</div>
          <ul class="chat-panel__mention-list" role="listbox" aria-label="Mention suggestions"></ul>
        </div>
        <input class="chat-panel__input" type="text" maxlength="${CHAT_MAX_LENGTH}" placeholder="Press Enter to chat" autocomplete="off" />
        <button type="submit" class="chat-panel__send" aria-label="Send">♥</button>
      </form>
    `

    this.railEl = document.createElement('nav')
    this.railEl.className = 'chat-panel__rail'
    this.railEl.setAttribute('aria-label', 'Chat channels')
    this.railScrollEl = document.createElement('div')
    this.railScrollEl.className = 'chat-panel__rail-scroll'
    this.railEl.appendChild(this.railScrollEl)

    this.root.appendChild(this.panelEl)
    this.root.appendChild(this.railEl)

    this.headerTitle = this.panelEl.querySelector('.chat-panel__title')!
    this.headerSubtitle = this.panelEl.querySelector('.chat-panel__subtitle')!
    this.autoIndicatorEl = this.panelEl.querySelector('.chat-panel__auto-indicator')!
    this.usersBtn = this.panelEl.querySelector('.chat-panel__users-btn')!
    this.moreBtn = this.panelEl.querySelector('.chat-panel__more-btn')!
    this.messagesEl = this.panelEl.querySelector('.chat-panel__messages')!
    this.composerEl = this.panelEl.querySelector('.chat-panel__composer')!
    this.mentionDockEl = this.panelEl.querySelector('.chat-panel__mention-dock')!
    this.mentionListEl = this.panelEl.querySelector('.chat-panel__mention-list')!
    this.inputEl = this.panelEl.querySelector('.chat-panel__input')!

    this.channelMenu = new ChatChannelMenu({
      getChannelKey: () => socialChannelKey(this.social.getChannel()),
      onAutoTranslateChange: (enabled) => {
        if (enabled) this.social.backfillAutoTranslate()
        this.syncAutoTranslateIndicator()
        if (this.bodyMode === 'messages') this.renderMessages()
      },
      onDeleteHistory: () => {
        this.social.clearChannelHistory()
        this.bodyMode = 'messages'
        this.renderAll()
      }
    })

    this.inputEl.addEventListener('input', this.onInputChange)
    this.inputEl.addEventListener('select', this.onInputSelect)
    this.inputEl.addEventListener('keyup', this.onInputSelect)
    this.inputEl.addEventListener('keydown', this.onInputKeyDown)

    this.panelEl.querySelector('.chat-panel__close')?.addEventListener('click', () => this.hide())
    this.usersBtn.addEventListener('click', () => this.toggleUsersView())
    this.moreBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.channelMenu.toggle(this.moreBtn)
    })
    this.panelEl.querySelector('.chat-panel__composer')?.addEventListener('submit', (ev) => {
      ev.preventDefault()
      void this.submitMessage()
    })

    this.composerEl.addEventListener('dragenter', this.onComposerDragEnter)
    this.composerEl.addEventListener('dragover', this.onComposerDragOver)
    this.composerEl.addEventListener('dragleave', this.onComposerDragLeave)
    this.composerEl.addEventListener('drop', this.onComposerDrop)

    this.root.addEventListener('mousedown', this.onChatPointerDown)
    this.sceneCanvas?.addEventListener('mousedown', this.onScenePointerDown)
  }

  private ensureMounted(): void {
    if (this.mounted) return
    document.body.appendChild(this.root)
    this.mounted = true
  }

  setOnVisibilityChange(handler: (visible: boolean) => void): void {
    this.onVisibilityChange = handler
  }

  setOnReadingChange(handler: ((reading: boolean) => void) | null): void {
    this.onReadingChange = handler
  }

  /**
   * True when the panel is open and focused (not faded scene-mode).
   * Scene-mode still mounts the panel but should count as "chat closed" for unread badges.
   */
  isActivelyReading(): boolean {
    return this.visible && !this.root.classList.contains('is-scene-mode')
  }

  /** Open panel on a community text channel (from community modal 💬). */
  openCommunityChannel(communityId: string, displayName: string): void {
    const id = communityId.trim()
    if (!id) return
    const name =
      displayName.trim() ||
      this.social.getCommunities().find((c) => c.id.toLowerCase() === id.toLowerCase())?.name ||
      'Community'
    this.social.selectChannel({
      kind: 'community',
      communityId: id,
      displayName: name
    })
    this.show()
    this.renderAll()
  }

  show(): void {
    this.ensureMounted()
    this.visible = true
    this.root.hidden = false
    this.resetBackgroundMode()
    this.renderAll()
    this.unsubChat?.()
    this.unsubChannel?.()
    this.unsubProfiles?.()
    this.unsubTranslate?.()
    this.unsubTranslateSettings?.()
    // Always re-render when a line lands (even if panel was empty/stale channel).
    this.unsubChat = this.social.onChat(() => {
      if (this.bodyMode === 'messages') this.renderMessages()
      this.updateComposerUi()
      this.updateUsersButton()
    })
    // Pull history for the active scene channel in case lines arrived before show().
    if (this.bodyMode === 'messages') this.renderMessages()
    this.unsubChannel = this.social.onChannelChange(() => {
      if (this.social.getChannel().kind !== 'scene' && this.bodyMode === 'users') {
        this.bodyMode = 'messages'
      }
      this.renderAll()
    })
    this.unsubProfiles = this.social.onPeerProfilesChange(() => {
      if (this.bodyMode === 'users') this.renderUsersList()
      else this.renderMessages()
      this.updateComposerUi()
      this.updateUsersButton()
    })
    this.unsubTranslate = chatTranslationService.onUpdate(() => {
      if (this.visible && this.bodyMode === 'messages') this.renderMessages()
    })
    this.unsubTranslateSettings = chatTranslationSettings.subscribe(() => {
      this.syncAutoTranslateIndicator()
      if (this.visible && this.bodyMode === 'messages') this.renderMessages()
    })
    this.syncAutoTranslateIndicator()
    this.startPresencePoll()
    this.social.setChannelThreadOpen(true)
    this.onVisibilityChange?.(true)
    this.onReadingChange?.(true)
    window.setTimeout(() => {
      if (this.bodyMode === 'messages') this.focusComposer()
    }, 0)
  }

  hide(): void {
    this.visible = false
    this.root.hidden = true
    this.inputEl.blur()
    this.channelMenu.hide()
    this.resetBackgroundMode()
    this.stopPresencePoll()
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
    this.social.setChannelThreadOpen(false)
    this.onVisibilityChange?.(false)
    this.onReadingChange?.(false)
  }

  toggle(): boolean {
    if (this.visible) {
      this.hide()
      return false
    }
    this.show()
    return true
  }

  isVisible(): boolean {
    return this.visible
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onGlobalKeyDown, true)
    this.sceneCanvas?.removeEventListener('mousedown', this.onScenePointerDown)
    this.hide()
    this.channelMenu.dispose()
    if (this.mounted) this.root.remove()
    this.mounted = false
  }

  private onGlobalKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
    if (this.isModalUiOpen()) return
    if (this.isTypingTarget() && document.activeElement !== this.inputEl) return
    if (document.activeElement === this.inputEl) return

    e.preventDefault()
    e.stopPropagation()

    if (!this.visible) {
      this.show()
      return
    }

    this.focusComposer()
  }

  /** Pin chat chrome and focus the message field (exits pointer lock). */
  private focusComposer(): void {
    if (document.pointerLockElement) document.exitPointerLock()
    const wasReading = this.isActivelyReading()
    this.root.classList.remove('is-scene-mode')
    this.root.classList.add('is-chat-pinned')
    this.inputEl.focus({ preventScroll: true })
    if (!wasReading && this.visible) {
      this.social.setChannelThreadOpen(true)
      this.onReadingChange?.(true)
    }
  }

  private isModalUiOpen(): boolean {
    return (
      document.querySelector('.settings-overlay.is-open') !== null ||
      document.querySelector('.emote-wheel-overlay.is-open') !== null ||
      document.getElementById('threejs-hud-confirm-overlay') !== null ||
      document.getElementById('threejs-nft-dialog-overlay') !== null
    )
  }

  private onScenePointerDown = (): void => {
    if (!this.visible) return
    const wasReading = this.isActivelyReading()
    this.root.classList.add('is-scene-mode')
    this.root.classList.remove('is-chat-pinned')
    // Release composer focus so WASD is not gated by isTextInputFocused after clicking the world
    // (or returning from another browser tab with chat still focused).
    if (document.activeElement === this.inputEl) this.inputEl.blur()
    if (wasReading) {
      this.social.setChannelThreadOpen(false)
      this.onReadingChange?.(false)
    }
  }

  private onChatPointerDown = (e: MouseEvent): void => {
    if (!this.visible) return
    e.stopPropagation()
    const wasReading = this.isActivelyReading()
    this.root.classList.remove('is-scene-mode')
    this.root.classList.add('is-chat-pinned')
    if (!wasReading) {
      this.social.setChannelThreadOpen(true)
      this.onReadingChange?.(true)
    }
  }

  private resetBackgroundMode(): void {
    this.root.classList.remove('is-scene-mode', 'is-chat-pinned')
  }

  private isTypingTarget(): boolean {
    const el = document.activeElement
    if (!el) return false
    if (el instanceof HTMLInputElement) {
      const type = el.type.toLowerCase()
      return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'reset'
    }
    if (el instanceof HTMLTextAreaElement) return true
    if (el instanceof HTMLElement && el.isContentEditable) return true
    return false
  }

  private async submitMessage(): Promise<void> {
    const text = this.inputEl.value.trim().slice(0, CHAT_MAX_LENGTH)
    if (!text) return

    const goto = parseGotoCommand(text)
    if (goto) {
      this.inputEl.value = ''
      this.updateComposerUi()
      await this.onGoto?.(goto)
      return
    }

    const sent = await this.social.sendMessage(text)
    if (sent) {
      this.inputEl.value = ''
      this.updateComposerUi()
      this.renderMessages()
    }
  }

  private renderAll(): void {
    this.headerTitle.textContent = this.social.getChannelTitle()
    const subtitle =
      this.bodyMode === 'users' ? 'People in scene' : this.social.getChannelSubtitle()
    this.headerSubtitle.textContent = subtitle
    // Hide empty subtitle so auto-indicator sits cleanly under the title.
    this.headerSubtitle.hidden = !subtitle.trim()
    this.syncAutoTranslateIndicator()
    this.updateUsersButton()
    this.renderRail()
    if (this.bodyMode === 'users') this.renderUsersList()
    else this.renderMessages()
    this.composerEl.hidden = this.bodyMode === 'users'
    this.updateComposerUi()
    this.inputEl.disabled = this.imageSending || this.bodyMode === 'users'
    if (this.bodyMode === 'messages') {
      this.inputEl.placeholder =
        this.social.getChannel().kind === 'scene'
          ? 'Press Enter to chat — drop an image'
          : 'Press Enter to chat'
    }
    this.updateComposerDropUi()
  }

  private startPresencePoll(): void {
    this.stopPresencePoll()
    this.presenceTimer = window.setInterval(() => {
      if (!this.visible) return
      this.updateUsersButton()
      if (this.bodyMode === 'users') this.renderUsersList()
    }, 2500)
  }

  private stopPresencePoll(): void {
    if (this.presenceTimer != null) {
      window.clearInterval(this.presenceTimer)
      this.presenceTimer = null
    }
  }

  private toggleUsersView(): void {
    if (this.social.getChannel().kind !== 'scene') return
    this.bodyMode = this.bodyMode === 'users' ? 'messages' : 'users'
    this.renderAll()
    if (this.bodyMode === 'messages') {
      window.setTimeout(() => this.focusComposer(), 0)
    }
  }

  private updateUsersButton(): void {
    const isScene = this.social.getChannel().kind === 'scene'
    if (!isScene) {
      this.usersBtn.hidden = true
      this.usersBtn.classList.remove('is-active')
      return
    }
    const count = Math.max(1, this.social.getScenePresenceCount() || 1)
    this.usersBtn.hidden = false
    this.usersBtn.classList.toggle('is-active', this.bodyMode === 'users')
    this.usersBtn.setAttribute('aria-pressed', this.bodyMode === 'users' ? 'true' : 'false')
    this.usersBtn.setAttribute(
      'aria-label',
      this.bodyMode === 'users' ? 'Back to chat messages' : `View ${count} people in this scene`
    )
    this.usersBtn.title =
      this.bodyMode === 'users' ? 'Back to chat' : `${count} ${count === 1 ? 'person' : 'people'}`
    // Explorer-style: icon + count only (right side of header).
    this.usersBtn.innerHTML = `${USERS_ICON}<span class="chat-panel__users-label">${count}</span>`
  }

  private syncAutoTranslateIndicator(): void {
    const on = chatTranslationSettings.getAutoTranslate(socialChannelKey(this.social.getChannel()))
    this.autoIndicatorEl.hidden = !on
  }

  private renderUsersList(): void {
    const rows = this.social.getScenePresenceRows()
    this.messagesEl.innerHTML = ''
    this.messagesEl.classList.add('chat-panel__messages--users')
    this.messagesEl.setAttribute('role', 'list')
    this.messagesEl.removeAttribute('aria-live')

    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'chat-panel__empty'
      empty.textContent = 'No one listed yet — peers appear as they join the room.'
      this.messagesEl.appendChild(empty)
      return
    }

    const list = document.createElement('ul')
    list.className = 'chat-panel__users-list'
    for (const row of rows) {
      const li = document.createElement('li')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'chat-panel__user-row'
      btn.dataset.address = row.address

      const avatar = document.createElement('div')
      avatar.className = 'chat-panel__user-avatar'
      this.fillAvatar(avatar, row.faceUrl, row.displayName)

      const meta = document.createElement('div')
      meta.className = 'chat-panel__user-meta'
      const name = document.createElement('span')
      name.className = 'chat-panel__user-name'
      name.textContent = row.displayName
      meta.appendChild(name)
      if (row.isSelf) {
        const you = document.createElement('span')
        you.className = 'chat-panel__user-you'
        you.textContent = 'You'
        meta.appendChild(you)
      }

      btn.appendChild(avatar)
      btn.appendChild(meta)
      if (this.onOpenProfile) {
        btn.addEventListener('click', () => {
          if (document.pointerLockElement) document.exitPointerLock()
          this.onOpenProfile?.(row.address)
        })
      } else {
        btn.disabled = true
        btn.classList.add('is-static')
      }
      li.appendChild(btn)
      list.appendChild(li)
    }
    this.messagesEl.appendChild(list)
  }

  private renderRail(): void {
    this.railScrollEl.innerHTML = ''
    const current = this.social.getChannel()

    for (const scene of this.social.getSceneTabs()) {
      this.railScrollEl.appendChild(
        this.createRailButton({
          channel: { kind: 'scene', sceneKey: scene.key, label: scene.label },
          title: scene.label,
          iconSvg: sceneChatRailIcon(),
          active: current.kind === 'scene' && current.sceneKey === scene.key
        })
      )
    }

    for (const community of this.social.getCommunities()) {
      this.railScrollEl.appendChild(
        this.createRailButton({
          channel: { kind: 'community', communityId: community.id, displayName: community.name },
          title: community.name,
          imageUrl: communityDisplayImageUrl(community.id, community.thumbnails),
          fallback: community.name.slice(0, 1).toUpperCase(),
          active: current.kind === 'community' && current.communityId === community.id
        })
      )
    }
  }

  private createRailButton(options: {
    channel: ChatChannelChoice
    title: string
    imageUrl?: string
    iconSvg?: string
    fallback?: string
    active: boolean
  }): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `chat-panel__rail-btn${options.active ? ' is-active' : ''}`
    btn.title = options.title
    btn.setAttribute('aria-label', options.title)
    btn.setAttribute('aria-current', options.active ? 'true' : 'false')

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

    btn.addEventListener('click', () => {
      this.social.selectChannel(options.channel)
      this.renderAll()
    })
    return btn
  }

  private renderMessages(): void {
    if (this.bodyMode !== 'messages') return
    const lines = this.social.getMessages()
    const el = this.messagesEl
    const stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    const prevTop = el.scrollTop
    el.innerHTML = ''
    el.classList.remove('chat-panel__messages--users')
    el.setAttribute('role', 'log')
    el.setAttribute('aria-live', 'polite')

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

  private renderLine(line: ChatLine): HTMLElement {
    const local = this.social.getLocalDisplay()
    const localAddress = this.social.getLocalAddress()
    const channelKey = socialChannelKey(this.social.getChannel())
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
        {
          onNavigate: (target) => {
            if (document.pointerLockElement) document.exitPointerLock()
            void this.onGoto?.(target)
          }
        },
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
      const peer = this.social.getPeerDisplay(line.senderAddress)
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
    const open = (): void => {
      if (document.pointerLockElement) document.exitPointerLock()
      this.onOpenProfile?.(address)
    }
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
    return this.visible && this.social.getChannel().kind === 'scene' && !this.imageSending
  }

  private pickImageFileFromDataTransfer(dt: DataTransfer | null): File | null {
    if (!dt) return null
    const files = [...dt.files]
    for (const file of files) {
      if (isAllowedChatImageFile(file)) return file
    }
    return null
  }

  private async sendImageFile(file: File): Promise<void> {
    if (this.imageSending || this.social.getChannel().kind !== 'scene') return
    this.imageSending = true
    this.updateComposerDropUi()
    try {
      const sent = await this.social.sendImageFile(file)
      if (sent) this.renderMessages()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.inputEl.placeholder = msg
      window.setTimeout(() => this.updateComposerDropUi(), 3000)
    } finally {
      this.imageSending = false
      this.updateComposerDropUi()
    }
  }

  private updateComposerDropUi(): void {
    this.inputEl.disabled = this.imageSending
    this.composerEl.classList.toggle('chat-panel__composer--sending', this.imageSending)
    if (!this.imageSending) {
      this.inputEl.placeholder =
        this.social.getChannel().kind === 'scene'
          ? 'Press Enter to chat — drop an image'
          : 'Press Enter to chat'
    } else {
      this.inputEl.placeholder = 'Sending image…'
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

  private updateComposerUi(): void {
    const value = this.inputEl.value
    this.inputEl.classList.toggle(
      'chat-panel__input--goto',
      /^\/(?:goto|changerealm|change-realm|realm)\b/i.test(value)
    )
    this.composerEl.classList.toggle('chat-panel__composer--mention', Boolean(this.activeMention()))

    const am = this.activeMention()
    if (!am || this.social.getChannel().kind !== 'scene') {
      this.mentionPopupRows = []
      this.mentionDockEl.hidden = true
      this.lastMentionStart = null
      return
    }

    if (this.lastMentionStart !== am.start) {
      this.mentionHighlight = 0
      this.lastMentionStart = am.start
    }

    this.mentionPopupRows = filterMentionPopupRows(this.social.getMentionCandidates(), am.query)
    if (this.mentionPopupRows.length === 0) {
      this.mentionDockEl.hidden = true
      return
    }

    this.mentionHighlight = Math.min(this.mentionHighlight, this.mentionPopupRows.length - 1)
    this.mentionDockEl.hidden = false
    this.renderMentionPopup()
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
}
