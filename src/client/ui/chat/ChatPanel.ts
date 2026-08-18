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
import { parseGotoCommand, parseReloadCommand } from '../../../dcl/content/route'
import { sceneChatRailIcon } from '../shell/icons'
import { communityDisplayImageUrl } from '../../../social/communityThumbnails'
import { followTargetLabel } from '../../../social/communityFollowWire'
import {
  isAllowedFollowFlagFile,
  prepareFollowFlagImage
} from '../../../social/prepareFollowFlagImage'
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
import {
  getCommunityVoiceSession,
  walletFromIdentity,
  type CommunityVoiceParticipant,
  type CommunityVoiceSessionState
} from '../../../social/CommunityVoiceSession'
import { ChatPeerProfiles } from '../../../social/ChatPeerProfiles'
import { shortenAddress } from '../../../avatar/displayName'
import { soundSettings, VOLUME_MAX, VOLUME_MIN } from '../../../rendering/SoundSettings'

export type ChatPanelOptions = {
  social: SocialService
  onVisibilityChange?: (visible: boolean) => void
  onGoto?: (target: RouteTarget) => void | Promise<void>
  /** Unity `/reload` — recycle the current scene facade without leaving play. */
  onReload?: () => void | Promise<void>
  onOpenProfile?: (address: string) => void
  /** Current play route — seeds tour start + leader pulses. */
  getCurrentRoute?: () => RouteTarget | null
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
  private readonly onReload?: ChatPanelOptions['onReload']
  private readonly onOpenProfile?: ChatPanelOptions['onOpenProfile']
  private onVisibilityChange: ((visible: boolean) => void) | null = null
  /** Fired when open+pinned vs closed/scene-mode changes (HUD unread badge). */
  private onReadingChange: ((reading: boolean) => void) | null = null
  private visible = false
  private bodyMode: ChatBodyMode = 'messages'
  private unsubChat: (() => void) | null = null
  private unsubChannel: (() => void) | null = null
  private unsubProfiles: (() => void) | null = null
  private unsubFriendship: (() => void) | null = null
  private unsubTranslate: (() => void) | null = null
  private unsubTranslateSettings: (() => void) | null = null
  private unsubFollow: (() => void) | null = null
  private presenceTimer: number | null = null
  private lastRailPresenceKey = ''
  private mounted = false
  private readonly sceneCanvas: HTMLElement | null
  private inputCaret = 0
  private mentionHighlight = 0
  private mentionPopupRows: MentionCandidate[] = []
  private lastMentionStart: number | null = null
  private imageSending = false
  private readonly followBarEl: HTMLElement
  private readonly followLabelEl: HTMLElement
  private readonly followActionBtn: HTMLButtonElement
  private readonly followStopBtn: HTMLButtonElement
  private readonly followFlagBtn: HTMLButtonElement
  private readonly followFlagInput: HTMLInputElement
  private readonly followFlagThumb: HTMLImageElement
  /**
   * Separate community-voice card stacked above the chat panel (Explorer-style).
   * Accordion + Speakers / Listeners tabs with horizontal avatar scroll.
   */
  private readonly voiceCardEl: HTMLElement
  private readonly panelStackEl: HTMLElement
  private readonly panelRowEl: HTMLElement
  private unsubCommunityVoice: (() => void) | null = null
  private unsubVoiceSound: (() => void) | null = null
  private unsubVoiceProfiles: (() => void) | null = null
  private communityVoiceState: CommunityVoiceSessionState | null = null
  private voiceAccordionOpen = false
  private voiceRosterTab: 'speakers' | 'listeners' = 'speakers'
  private readonly voiceProfiles = new ChatPeerProfiles()

  constructor({ social, onVisibilityChange, onGoto, onReload, onOpenProfile }: ChatPanelOptions) {
    this.social = social
    this.onGoto = onGoto
    this.onReload = onReload
    this.onOpenProfile = onOpenProfile
    this.onVisibilityChange = onVisibilityChange ?? null
    this.sceneCanvas = document.querySelector('#app canvas')

    window.addEventListener('keydown', this.onGlobalKeyDown, true)
    this.root = document.createElement('div')
    this.root.id = 'chat-panel-wrap'
    this.root.className = 'chat-panel-wrap'
    this.root.hidden = true

    this.panelStackEl = document.createElement('div')
    this.panelStackEl.className = 'chat-panel-stack'

    this.voiceCardEl = document.createElement('div')
    this.voiceCardEl.className = 'chat-voice-card'
    this.voiceCardEl.hidden = true
    this.voiceCardEl.setAttribute('role', 'region')
    this.voiceCardEl.setAttribute('aria-label', 'Community voice')
    this.voiceCardEl.innerHTML = `
      <div class="chat-voice-card__head">
        <button type="button" class="chat-voice-card__toggle" data-voice-accordion aria-expanded="false">
          <span class="chat-voice-card__live" aria-hidden="true"></span>
          <span class="chat-voice-card__kicker">Community voice</span>
          <span class="chat-voice-card__role" data-voice-role></span>
          <span class="chat-voice-card__chevron" data-voice-chevron aria-hidden="true">▸</span>
        </button>
        <div class="chat-voice-card__info-row">
          <span class="chat-voice-card__title" data-voice-title>Voice chat</span>
          <span class="chat-voice-card__counts" data-voice-meta></span>
        </div>
        <div class="chat-voice-card__controls">
          <button type="button" class="chat-voice-card__btn" data-voice-hand hidden title="Request to speak">Speak</button>
          <button type="button" class="chat-voice-card__btn" data-voice-mic hidden title="Mute">Mute</button>
          <label class="chat-voice-card__vol" title="Voice volume">
            <span aria-hidden="true">🔊</span>
            <input type="range" class="chat-voice-card__slider" data-voice-volume
              min="${VOLUME_MIN}" max="${VOLUME_MAX}" step="1" />
          </label>
          <button type="button" class="chat-voice-card__btn chat-voice-card__btn--leave" data-voice-leave title="Leave voice">Leave</button>
        </div>
      </div>
      <div class="chat-voice-card__body" data-voice-body hidden>
        <div class="chat-voice-card__tabs" role="tablist">
          <button type="button" class="chat-voice-card__tab is-active" role="tab" data-voice-tab="speakers" aria-selected="true">Speakers</button>
          <button type="button" class="chat-voice-card__tab" role="tab" data-voice-tab="listeners" aria-selected="false">Listeners</button>
        </div>
        <div class="chat-voice-card__scroll" data-voice-people role="list"></div>
      </div>
    `

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
      <div class="chat-panel__follow-bar" hidden>
        <span class="chat-panel__follow-label"></span>
        <div class="chat-panel__follow-actions">
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
            class="chat-panel__follow-flag-input" hidden data-follow-flag-input />
          <img class="chat-panel__follow-flag-thumb" alt="" data-follow-flag-thumb hidden />
          <button type="button" class="chat-panel__follow-btn chat-panel__follow-btn--flag" hidden data-follow-flag-btn title="Upload a banner for your tour flag pole">🚩 Set flag</button>
          <button type="button" class="chat-panel__follow-btn chat-panel__follow-btn--primary" hidden></button>
          <button type="button" class="chat-panel__follow-btn chat-panel__follow-btn--stop" hidden></button>
        </div>
      </div>
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

    // Voice card above; rail only next to the chat panel (not full stack height).
    this.panelRowEl = document.createElement('div')
    this.panelRowEl.className = 'chat-panel-row'
    this.panelRowEl.appendChild(this.panelEl)
    this.panelRowEl.appendChild(this.railEl)
    this.panelStackEl.appendChild(this.voiceCardEl)
    this.panelStackEl.appendChild(this.panelRowEl)
    this.root.appendChild(this.panelStackEl)

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
    this.followBarEl = this.panelEl.querySelector('.chat-panel__follow-bar')!
    this.followLabelEl = this.panelEl.querySelector('.chat-panel__follow-label')!
    this.followActionBtn = this.panelEl.querySelector('.chat-panel__follow-btn--primary')!
    this.followStopBtn = this.panelEl.querySelector('.chat-panel__follow-btn--stop')!
    this.followFlagBtn = this.panelEl.querySelector('[data-follow-flag-btn]') as HTMLButtonElement
    this.followFlagInput = this.panelEl.querySelector(
      '[data-follow-flag-input]'
    ) as HTMLInputElement
    this.followFlagThumb = this.panelEl.querySelector(
      '[data-follow-flag-thumb]'
    ) as HTMLImageElement
    this.wireCommunityVoiceCard()

    this.channelMenu = new ChatChannelMenu({
      getChannelKey: () => socialChannelKey(this.social.getChannel()),
      onAutoTranslateChange: (enabled) => {
        if (enabled) this.social.backfillAutoTranslate()
        this.syncAutoTranslateIndicator()
        if (this.bodyMode === 'messages') this.renderMessages()
      },
      onCopyChat: () => void this.copyChannelTranscript(),
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

    this.followActionBtn.addEventListener('click', () => void this.onFollowPrimaryClick())
    this.followStopBtn.addEventListener('click', () => void this.onFollowStopClick())
    this.followFlagBtn.addEventListener('click', () => {
      if (this.followFlagBtn.dataset.hasFlag === '1') {
        void this.clearFollowFlag()
        return
      }
      this.followFlagInput.click()
    })
    this.followFlagInput.addEventListener('change', () => void this.onFollowFlagFilePicked())

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

  /** Open a 1:1 private message thread (Friends panel / profile). */
  openDirectMessage(peerAddress: string, displayName: string): void {
    const address = peerAddress.trim().toLowerCase()
    if (!address) return
    const name = displayName.trim() || `${address.slice(0, 6)}…${address.slice(-4)}`
    // Fire-and-forget open; PM room connect is async — sendMessage also reconnects.
    void this.social.openDirectMessage(address, name).then((ready) => {
      if (!ready) {
        console.warn('[chat] private-messages room not ready after openDirectMessage')
      }
      if (this.visible) this.renderAll()
    })
    this.show()
    this.renderAll()
    this.bodyMode = 'messages'
    this.inputEl.placeholder = 'Private message — press Enter to send'
    window.setTimeout(() => this.focusComposer(), 0)
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
      // Refresh rail presence/unread badges when DMs arrive on another channel.
      this.renderRail()
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
      // Refresh DM rail faces when profile snapshots arrive.
      this.renderRail()
      this.updateComposerUi()
      this.updateUsersButton()
    })
    // Friend connectivity stream → green dots on DM faces (same source as Friends ONLINE).
    this.unsubFriendship = this.social.onFriendshipChange(() => {
      if (this.visible) this.renderRail()
    })
    this.unsubTranslate = chatTranslationService.onUpdate(() => {
      if (this.visible && this.bodyMode === 'messages') this.renderMessages()
    })
    this.unsubTranslateSettings = chatTranslationSettings.subscribe(() => {
      this.syncAutoTranslateIndicator()
      if (this.visible && this.bodyMode === 'messages') this.renderMessages()
    })
    this.unsubFollow?.()
    this.unsubFollow = this.social.getFollow()?.subscribe(() => {
      if (this.visible) this.renderFollowBar()
    }) ?? null
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
    this.unsubFriendship?.()
    this.unsubTranslate?.()
    this.unsubTranslateSettings?.()
    this.unsubFollow?.()
    this.unsubChat = null
    this.unsubChannel = null
    this.unsubProfiles = null
    this.unsubFriendship = null
    this.unsubTranslate = null
    this.unsubTranslateSettings = null
    this.unsubFollow = null
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

  private async copyChannelTranscript(): Promise<void> {
    const social = this.social
    const title = social.getChannelTitle()
    const lines = social.getMessages()
    const parts: string[] = [`# ${title}`, '']
    for (const line of lines) {
      if (isChatImageLine(line)) {
        const who = line.self
          ? social.getLocalDisplay().displayName
          : social.getPeerDisplay(line.senderAddress).displayName
        parts.push(`[${SocialService.formatLineTime(line)}] ${who}: [image]`)
        continue
      }
      const who = line.self
        ? social.getLocalDisplay().displayName
        : (line.senderName?.trim() ||
            social.getPeerDisplay(line.senderAddress).displayName)
      parts.push(`[${SocialService.formatLineTime(line)}] ${who}: ${line.text}`)
    }
    const text = parts.join('\n').trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* ignore */
      }
      ta.remove()
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onGlobalKeyDown, true)
    this.sceneCanvas?.removeEventListener('mousedown', this.onScenePointerDown)
    this.unsubCommunityVoice?.()
    this.unsubCommunityVoice = null
    this.unsubVoiceSound?.()
    this.unsubVoiceSound = null
    this.unsubVoiceProfiles?.()
    this.unsubVoiceProfiles = null
    this.voiceProfiles.clear()
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
      document.getElementById('threejs-external-link-overlay') !== null ||
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
    if (parseReloadCommand(text)) {
      this.inputEl.value = ''
      this.updateComposerUi()
      await this.onReload?.()
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
    this.renderCommunityVoiceCard()
    this.renderFollowBar()
    this.renderRail()
    if (this.bodyMode === 'users') this.renderUsersList()
    else this.renderMessages()
    this.composerEl.hidden = this.bodyMode === 'users'
    this.updateComposerUi()
    this.inputEl.disabled = this.imageSending || this.bodyMode === 'users'
    if (this.bodyMode === 'messages') {
      const kind = this.social.getChannel().kind
      if (kind === 'scene') {
        this.inputEl.placeholder = 'Press Enter to chat — drop an image'
      } else if (kind === 'dm') {
        const pmReady = this.social.isPrivateMessagesReady()
        const pmConnecting = this.social.isPrivateMessagesConnecting()
        this.inputEl.placeholder = pmConnecting
          ? 'Connecting private chat…'
          : pmReady
            ? 'Private message — press Enter to send'
            : this.social.getPrivateMessagesError()
              ? 'Private chat offline — try again'
              : 'Private message — press Enter to send'
        this.inputEl.disabled = this.imageSending || pmConnecting
      } else {
        this.inputEl.placeholder = 'Press Enter to chat'
      }
    }
    this.updateComposerDropUi()
  }

  /**
   * Separate card above the chat panel. Accordion + Speakers/Listeners tabs
   * with horizontal avatar + name scroll (Explorer-style).
   */
  private wireCommunityVoiceCard(): void {
    this.unsubCommunityVoice?.()
    this.unsubVoiceSound?.()
    this.unsubVoiceProfiles?.()
    const voice = getCommunityVoiceSession()
    this.unsubCommunityVoice = voice.subscribe((state) => {
      this.communityVoiceState = state
      void this.ensureVoiceFaces(state.participants)
      this.renderCommunityVoiceCard()
    })
    this.unsubVoiceProfiles = this.voiceProfiles.onUpdate(() => {
      if (this.communityVoiceState?.active) this.renderCommunityVoiceCard()
    })
    this.unsubVoiceSound = soundSettings.subscribe(() => {
      if (!this.communityVoiceState?.active) return
      const slider = this.voiceCardEl.querySelector<HTMLInputElement>('[data-voice-volume]')
      if (slider) {
        slider.value = String(soundSettings.get().voiceChatVolume)
        this.setVoiceSliderPct(slider)
      }
    })

    this.voiceCardEl.querySelector('[data-voice-accordion]')?.addEventListener('click', () => {
      this.voiceAccordionOpen = !this.voiceAccordionOpen
      this.renderCommunityVoiceCard()
    })
    this.voiceCardEl.querySelector('[data-voice-mic]')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const v = getCommunityVoiceSession()
      if (!v.isActive()) return
      void v.setMicEnabled(!v.getState().micEnabled)
    })
    this.voiceCardEl.querySelector('[data-voice-hand]')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const v = getCommunityVoiceSession()
      if (!v.isActive()) return
      void v.setHandRaised(!v.isHandRaised())
    })
    this.voiceCardEl.querySelector('[data-voice-leave]')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      void getCommunityVoiceSession().leave()
    })
    for (const tab of this.voiceCardEl.querySelectorAll<HTMLButtonElement>('[data-voice-tab]')) {
      tab.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const t = tab.dataset.voiceTab
        if (t === 'speakers' || t === 'listeners') {
          this.voiceRosterTab = t
          this.renderCommunityVoiceCard()
        }
      })
    }
    const slider = this.voiceCardEl.querySelector<HTMLInputElement>('[data-voice-volume]')
    slider?.addEventListener('input', (ev) => {
      ev.stopPropagation()
      const n = Number(slider.value)
      if (Number.isFinite(n)) soundSettings.set({ voiceChatVolume: n })
      this.setVoiceSliderPct(slider)
    })
    if (slider) {
      slider.value = String(soundSettings.get().voiceChatVolume)
      this.setVoiceSliderPct(slider)
    }
  }

  private async ensureVoiceFaces(participants: CommunityVoiceParticipant[]): Promise<void> {
    const wallets = participants
      .map((p) => p.wallet ?? walletFromIdentity(p.identity))
      .filter((w): w is string => !!w)
    await Promise.all(wallets.map((w) => this.voiceProfiles.ensurePeer(w, { fast: true })))
  }

  private renderCommunityVoiceCard(): void {
    const state = this.communityVoiceState ?? getCommunityVoiceSession().getState()
    this.communityVoiceState = state
    if (!state.active || !state.communityId) {
      this.voiceCardEl.hidden = true
      this.root.classList.remove('has-community-voice')
      return
    }
    this.voiceCardEl.hidden = false
    this.root.classList.add('has-community-voice')
    this.voiceCardEl.classList.toggle('is-expanded', this.voiceAccordionOpen)

    const name = (state.communityName || 'Community').trim()
    const speakers = state.participants.filter((p) => p.isSpeaker)
    const listeners = state.participants.filter((p) => !p.isSpeaker)
    const role =
      state.role === 'speaker' ? 'Speaker' : state.handRaised ? 'Hand raised' : 'Listening'
    const titleEl = this.voiceCardEl.querySelector('[data-voice-title]')
    const metaEl = this.voiceCardEl.querySelector('[data-voice-meta]')
    const roleEl = this.voiceCardEl.querySelector('[data-voice-role]')
    if (titleEl) titleEl.textContent = name
    if (roleEl) roleEl.textContent = role
    if (metaEl) {
      metaEl.textContent = `${speakers.length} speaker${speakers.length === 1 ? '' : 's'} · ${listeners.length} listener${listeners.length === 1 ? '' : 's'}`
    }

    const toggle = this.voiceCardEl.querySelector<HTMLButtonElement>('[data-voice-accordion]')
    const chevron = this.voiceCardEl.querySelector('[data-voice-chevron]')
    const body = this.voiceCardEl.querySelector<HTMLElement>('[data-voice-body]')
    if (toggle) toggle.setAttribute('aria-expanded', this.voiceAccordionOpen ? 'true' : 'false')
    if (chevron) chevron.textContent = this.voiceAccordionOpen ? '▾' : '▸'
    if (body) body.hidden = !this.voiceAccordionOpen

    const canMic = state.role === 'speaker' || state.canPublish
    const micBtn = this.voiceCardEl.querySelector<HTMLButtonElement>('[data-voice-mic]')
    const handBtn = this.voiceCardEl.querySelector<HTMLButtonElement>('[data-voice-hand]')
    if (micBtn) {
      micBtn.hidden = !canMic
      micBtn.textContent = state.micEnabled ? 'Mute' : 'Unmute'
      micBtn.title = state.micEnabled ? 'Mute microphone' : 'Unmute microphone'
      micBtn.classList.toggle('is-off', !state.micEnabled)
    }
    if (handBtn) {
      handBtn.hidden = canMic
      handBtn.textContent = state.handRaised ? 'Lower' : 'Speak'
      handBtn.title = state.handRaised ? 'Lower hand' : 'Request to speak'
      handBtn.classList.toggle('is-raised', state.handRaised)
    }
    const slider = this.voiceCardEl.querySelector<HTMLInputElement>('[data-voice-volume]')
    if (slider) {
      slider.value = String(soundSettings.get().voiceChatVolume)
      this.setVoiceSliderPct(slider)
    }

    for (const tab of this.voiceCardEl.querySelectorAll<HTMLButtonElement>('[data-voice-tab]')) {
      const active = tab.dataset.voiceTab === this.voiceRosterTab
      tab.classList.toggle('is-active', active)
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
      if (tab.dataset.voiceTab === 'speakers') {
        tab.textContent = `Speakers (${speakers.length})`
      } else {
        tab.textContent = `Listeners (${listeners.length})`
      }
    }

    const list = this.voiceRosterTab === 'speakers' ? speakers : listeners
    const peopleEl = this.voiceCardEl.querySelector('[data-voice-people]')
    if (peopleEl) {
      if (list.length === 0) {
        peopleEl.innerHTML = `<div class="chat-voice-card__empty">No ${this.voiceRosterTab} yet</div>`
      } else {
        peopleEl.innerHTML = list.map((p) => this.renderVoicePersonChip(p)).join('')
        for (const chip of peopleEl.querySelectorAll<HTMLButtonElement>('[data-voice-profile]')) {
          chip.addEventListener('click', () => {
            const addr = chip.dataset.voiceProfile
            if (addr) this.onOpenProfile?.(addr)
          })
        }
      }
    }
  }

  private renderVoicePersonChip(p: CommunityVoiceParticipant): string {
    const wallet = p.wallet ?? walletFromIdentity(p.identity)
    const profile = wallet ? this.voiceProfiles.get(wallet) : null
    const displayName =
      profile?.displayName?.trim() ||
      p.name?.trim() ||
      (wallet ? shortenAddress(wallet) : p.identity.slice(0, 10))
    const initial = displayName.charAt(0).toUpperCase() || '?'
    const face = profile?.faceUrl
      ? `<img src="${escapeHtmlAttr(profile.faceUrl)}" alt="" class="chat-voice-card__face" loading="lazy" decoding="async" />`
      : `<span class="chat-voice-card__face chat-voice-card__face--fallback" aria-hidden="true">${escapeHtmlText(initial)}</span>`
    const tags: string[] = []
    if (p.isLocal) tags.push('you')
    if (p.isMod) tags.push('mod')
    if (p.handRaised) tags.push('✋')
    if (p.isSpeaking) tags.push('🎙')
    const tagHtml = tags.length
      ? `<span class="chat-voice-card__chip-tags">${tags.map((t) => escapeHtmlText(t)).join(' · ')}</span>`
      : ''
    const clickable = wallet ? `type="button" data-voice-profile="${escapeHtmlAttr(wallet)}"` : 'type="button" disabled'
    return `<button ${clickable} class="chat-voice-card__chip${p.isSpeaking ? ' is-speaking' : ''}${p.isLocal ? ' is-you' : ''}" role="listitem" title="${escapeHtmlAttr(displayName)}">
      ${face}
      <span class="chat-voice-card__chip-name">${escapeHtmlText(displayName)}</span>
      ${tagHtml}
    </button>`
  }

  private setVoiceSliderPct(slider: HTMLInputElement): void {
    const min = Number(slider.min) || 0
    const max = Number(slider.max) || 100
    const val = Number(slider.value)
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0
    slider.style.setProperty('--pct', `${pct}%`)
  }

  /** Sticky Follow / Tour row under community chat title (in-world only). */
  private renderFollowBar(): void {
    const channel = this.social.getChannel()
    const follow = this.social.getFollow()
    if (channel.kind !== 'community' || this.bodyMode === 'users' || !follow) {
      this.followBarEl.hidden = true
      return
    }

    const communityId = channel.communityId
    const session = follow.getSession(communityId)
    const canLead = follow.canLead(communityId)
    const leading = follow.isLeading(communityId)
    const following = follow.isFollowing(communityId)
    const stopLabel = followTargetLabel(session?.lastTarget ?? null)
    const leaderShort = session
      ? this.shortLeaderLabel(session.leaderAddress)
      : ''

    // Hide entirely when idle and user cannot lead (no tour to join).
    if (!session && !canLead) {
      this.followBarEl.hidden = true
      return
    }

    this.followBarEl.hidden = false
    this.followActionBtn.hidden = true
    this.followStopBtn.hidden = true
    this.followFlagBtn.hidden = true
    this.followFlagThumb.hidden = true
    this.followActionBtn.disabled = false
    this.followStopBtn.disabled = false
    this.followFlagBtn.disabled = false
    const hasFlag = Boolean(session?.flagDataUrl)
    this.followFlagBtn.dataset.hasFlag = hasFlag ? '1' : '0'
    this.followFlagBtn.textContent = hasFlag ? 'Clear flag' : '🚩 Set flag'
    this.followFlagBtn.setAttribute(
      'aria-label',
      hasFlag ? 'Remove tour flag image' : 'Upload tour flag image for your spine banner'
    )
    if (hasFlag && session?.flagDataUrl) {
      this.followFlagThumb.src = session.flagDataUrl
      this.followFlagThumb.hidden = false
    } else {
      this.followFlagThumb.removeAttribute('src')
    }

    if (leading) {
      this.followLabelEl.textContent = hasFlag
        ? stopLabel
          ? `Leading · ${stopLabel} · flag on`
          : 'Leading · flag on · /goto moves group'
        : stopLabel
          ? `Leading · ${stopLabel} · sidebar 🚩 Tour Options for flag`
          : 'Leading · /goto moves group · sidebar 🚩 for flag'
      this.followStopBtn.hidden = false
      this.followStopBtn.textContent = 'Stop tour'
      this.followStopBtn.setAttribute('aria-label', 'Stop community tour')
      // Flag upload moved to sidebar Tour Options (and community START TOUR).
      this.followFlagBtn.hidden = true
      return
    }

    if (following && session) {
      this.followLabelEl.textContent = stopLabel
        ? `Following ${leaderShort} · ${stopLabel}${session.flagDataUrl ? ' · flag' : ''}`
        : `Following ${leaderShort}${session.flagDataUrl ? ' · flag' : ''}`
      this.followStopBtn.hidden = false
      this.followStopBtn.textContent = 'Stop'
      this.followStopBtn.setAttribute('aria-label', 'Stop following tour')
      return
    }

    if (session) {
      this.followLabelEl.textContent = stopLabel
        ? `Tour live · ${leaderShort} @ ${stopLabel}`
        : `Tour live · ${leaderShort}`
      this.followActionBtn.hidden = false
      this.followActionBtn.textContent = 'Follow'
      this.followActionBtn.setAttribute('aria-label', 'Follow community tour')
      return
    }

    // Can lead, no active tour — start from community panel (under Voice Stream).
    this.followLabelEl.textContent = 'Start a tour from Communities → your community → START TOUR'
    this.followActionBtn.hidden = true
  }

  private async onFollowFlagFilePicked(): Promise<void> {
    const file = this.followFlagInput.files?.[0]
    this.followFlagInput.value = ''
    if (!file) return
    const follow = this.social.getFollow()
    if (!follow?.isLeading()) return
    if (!isAllowedFollowFlagFile(file)) {
      this.followLabelEl.textContent = 'Flag: use JPEG, PNG, WebP, or GIF'
      return
    }
    this.followFlagBtn.disabled = true
    try {
      const dataUrl = await prepareFollowFlagImage(file)
      const ok = await follow.setFlagImage(dataUrl)
      if (!ok) {
        this.followLabelEl.textContent = 'Could not set tour flag — try again'
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not process flag image'
      this.followLabelEl.textContent = msg
    } finally {
      this.followFlagBtn.disabled = false
      this.renderFollowBar()
    }
  }

  private async clearFollowFlag(): Promise<void> {
    const follow = this.social.getFollow()
    if (!follow?.isLeading()) return
    this.followFlagBtn.disabled = true
    await follow.setFlagImage(null)
    this.followFlagBtn.disabled = false
    this.renderFollowBar()
  }

  private shortLeaderLabel(address: string): string {
    const name = this.social.getPeerDisplay(address)?.displayName?.trim()
    if (name) return name
    const a = address.toLowerCase()
    if (a.startsWith('0x') && a.length >= 10) return `${a.slice(0, 6)}…${a.slice(-4)}`
    return 'leader'
  }

  private async onFollowPrimaryClick(): Promise<void> {
    const channel = this.social.getChannel()
    if (channel.kind !== 'community') return
    const follow = this.social.getFollow()
    if (!follow) return
    const communityId = channel.communityId
    const session = follow.getSession(communityId)

    if (session && !follow.isLeading(communityId) && !follow.isFollowing(communityId)) {
      follow.follow(communityId)
      this.renderFollowBar()
      return
    }

    // Start tour moved to Community modal (under Voice Stream).
  }

  private async onFollowStopClick(): Promise<void> {
    const channel = this.social.getChannel()
    if (channel.kind !== 'community') return
    const follow = this.social.getFollow()
    if (!follow) return
    const communityId = channel.communityId

    if (follow.isLeading(communityId)) {
      this.followStopBtn.disabled = true
      await follow.stopLead()
      this.followStopBtn.disabled = false
      this.renderFollowBar()
      return
    }

    if (follow.isFollowing(communityId)) {
      follow.unfollow()
      this.renderFollowBar()
    }
  }

  private startPresencePoll(): void {
    this.stopPresencePoll()
    this.lastRailPresenceKey = this.railPresenceKey()
    this.presenceTimer = window.setInterval(() => {
      if (!this.visible) return
      this.updateUsersButton()
      if (this.bodyMode === 'users') this.renderUsersList()
      // Re-render rail when friend online / unread / PM-room presence changes.
      const key = this.railPresenceKey()
      if (key !== this.lastRailPresenceKey) {
        this.lastRailPresenceKey = key
        this.renderRail()
      }
    }, 2000)
  }

  private railPresenceKey(): string {
    try {
      const parts = this.social.getDmPeers().map((p) => {
        const ch = {
          kind: 'dm' as const,
          peerAddress: p.address,
          displayName: p.displayName
        }
        return `${p.address}:${this.social.isPeerOnline(p.address) ? 1 : 0}:${this.social.getUnreadCount(ch)}`
      })
      return parts.join('|')
    } catch {
      return ''
    }
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
    document.querySelectorAll('.chat-panel__rail-chip-hover').forEach((el) => el.remove())
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

    // Private DMs above community channels — profile face when known.
    for (const peer of this.social.getDmPeers()) {
      const face = peer.faceUrl || this.social.getPeerDisplay(peer.address).faceUrl
      if (!face) this.social.scheduleEnsurePeer(peer.address)
      const channel = {
        kind: 'dm' as const,
        peerAddress: peer.address,
        displayName: peer.displayName
      }
      const active = current.kind === 'dm' && current.peerAddress.toLowerCase() === peer.address
      // Unread badge when this DM is not the active open thread.
      const viewingThis = active && this.isActivelyReading()
      this.railScrollEl.appendChild(
        this.createRailButton({
          channel,
          title: peer.displayName,
          imageUrl: face ?? undefined,
          fallback: peer.displayName.slice(0, 1).toUpperCase() || '?',
          active,
          closable: true,
          online: this.social.isPeerOnline(peer.address),
          unreadCount: viewingThis ? 0 : this.social.getUnreadCount(channel)
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
    closable?: boolean
    online?: boolean
    unreadCount?: number
  }): HTMLElement {
    const chip = document.createElement('div')
    chip.className = `chat-panel__rail-chip${options.active ? ' is-active' : ''}${
      options.closable ? ' is-closable' : ''
    }`
    if (options.channel.kind === 'community' || options.closable) {
      chip.classList.add('is-named')
    }
    if (options.channel.kind === 'dm') {
      chip.classList.add(options.online ? 'is-online' : 'is-offline')
    }

    const hover = document.createElement('div')
    hover.className = 'chat-panel__rail-chip-hover'
    hover.setAttribute('aria-hidden', 'true')

    if (options.closable) {
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'chat-panel__rail-chip-close'
      close.setAttribute('aria-label', `Remove ${options.title}`)
      close.textContent = '×'
      close.addEventListener('click', (ev) => {
        ev.stopPropagation()
        ev.preventDefault()
        if (options.channel.kind === 'dm') {
          this.social.closeDirectMessage(options.channel.peerAddress)
          this.renderAll()
        }
      })
      hover.appendChild(close)
    }

    const label = document.createElement('span')
    label.className = 'chat-panel__rail-chip-label'
    label.textContent = options.title
    hover.appendChild(label)
    document.body.appendChild(hover)

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
    chip.appendChild(btn)

    // Presence on CHIP (not inside overflow:hidden button) so badge/dot sit ON the profile.
    if (options.channel.kind === 'dm') {
      const unread = options.unreadCount ?? 0
      if (unread > 0) {
        chip.classList.add('has-unread')
        const badge = document.createElement('span')
        badge.className = 'social-chat-dock__unread'
        badge.textContent = unread > 99 ? '99+' : String(unread)
        badge.setAttribute('aria-label', `${unread} unread`)
        chip.appendChild(badge)
      }
      if (options.online) {
        const dot = document.createElement('span')
        dot.className = 'chat-panel__rail-online-dot'
        dot.title = 'Online'
        dot.setAttribute('aria-label', 'Online')
        chip.appendChild(dot)
      }
    }
    if (chip.classList.contains('is-named')) {
      let hideTimer: ReturnType<typeof setTimeout> | null = null
      const place = (): void => {
        // Left edge of the whole chat rail (outside the panel), not over the avatar.
        const rail = this.railScrollEl?.getBoundingClientRect?.() ?? null
        const btnRect = btn.getBoundingClientRect()
        const leftEdge = rail ? rail.left : btnRect.left
        hover.style.left = `${Math.round(leftEdge - 10)}px`
        hover.style.top = `${Math.round(btnRect.top + btnRect.height / 2)}px`
      }
      const open = (): void => {
        if (hideTimer) {
          clearTimeout(hideTimer)
          hideTimer = null
        }
        place()
        chip.classList.add('is-hover-open')
        hover.classList.add('is-open')
      }
      const scheduleClose = (): void => {
        if (hideTimer) clearTimeout(hideTimer)
        hideTimer = setTimeout(() => {
          hideTimer = null
          chip.classList.remove('is-hover-open')
          hover.classList.remove('is-open')
        }, 120)
      }
      chip.addEventListener('mouseenter', open)
      chip.addEventListener('mouseleave', scheduleClose)
      chip.addEventListener('focusin', open)
      chip.addEventListener('focusout', scheduleClose)
      hover.addEventListener('mouseenter', open)
      hover.addEventListener('mouseleave', scheduleClose)
    }
    return chip
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

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/'/g, '&#39;')
}
