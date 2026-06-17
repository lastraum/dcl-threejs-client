import { SocialService } from '../../../social/SocialService'
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
import type { RouteTarget } from '../../../dcl/content/route'
import { parseGotoCommand } from '../../../dcl/content/route'
import { SCENE_CHAT_RAIL_ICON } from '../shell/icons'
import { pickCommunityThumbnailUrl } from '../../../social/memberCommunities'
import type { ChatChannelChoice, ChatLine } from '../../../social/types'

export type ChatPanelOptions = {
  social: SocialService
  onVisibilityChange?: (visible: boolean) => void
  onGoto?: (target: RouteTarget) => void | Promise<void>
}

/** Compact bottom-left chat window with a vertical channel rail on the right. */
export class ChatPanel {
  readonly root: HTMLElement
  private readonly panelEl: HTMLElement
  private readonly railEl: HTMLElement
  private readonly railScrollEl: HTMLElement
  private readonly headerTitle: HTMLElement
  private readonly headerSubtitle: HTMLElement
  private readonly messagesEl: HTMLElement
  private readonly composerEl: HTMLElement
  private readonly mentionDockEl: HTMLElement
  private readonly mentionListEl: HTMLUListElement
  private readonly inputEl: HTMLInputElement
  private readonly social: SocialService
  private readonly onGoto?: ChatPanelOptions['onGoto']
  private onVisibilityChange: ((visible: boolean) => void) | null = null
  private visible = false
  private unsubChat: (() => void) | null = null
  private unsubChannel: (() => void) | null = null
  private unsubProfiles: (() => void) | null = null
  private mounted = false
  private readonly sceneCanvas: HTMLElement | null
  private inputCaret = 0
  private mentionHighlight = 0
  private mentionPopupRows: MentionCandidate[] = []
  private lastMentionStart: number | null = null

  constructor({ social, onVisibilityChange, onGoto }: ChatPanelOptions) {
    this.social = social
    this.onGoto = onGoto
    this.onVisibilityChange = onVisibilityChange ?? null
    this.sceneCanvas = document.querySelector('#app canvas')

    window.addEventListener('keydown', this.onGlobalKeyDown)
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
          <div class="chat-panel__subtitle"></div>
        </div>
        <button type="button" class="chat-panel__close" aria-label="Close chat">×</button>
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
    this.messagesEl = this.panelEl.querySelector('.chat-panel__messages')!
    this.composerEl = this.panelEl.querySelector('.chat-panel__composer')!
    this.mentionDockEl = this.panelEl.querySelector('.chat-panel__mention-dock')!
    this.mentionListEl = this.panelEl.querySelector('.chat-panel__mention-list')!
    this.inputEl = this.panelEl.querySelector('.chat-panel__input')!

    this.inputEl.addEventListener('input', this.onInputChange)
    this.inputEl.addEventListener('select', this.onInputSelect)
    this.inputEl.addEventListener('keyup', this.onInputSelect)
    this.inputEl.addEventListener('keydown', this.onInputKeyDown)

    this.panelEl.querySelector('.chat-panel__close')?.addEventListener('click', () => this.hide())
    this.panelEl.querySelector('.chat-panel__composer')?.addEventListener('submit', (ev) => {
      ev.preventDefault()
      void this.submitMessage()
    })

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

  show(): void {
    this.ensureMounted()
    this.visible = true
    this.root.hidden = false
    this.resetBackgroundMode()
    this.renderAll()
    this.unsubChat?.()
    this.unsubChannel?.()
    this.unsubProfiles?.()
    this.unsubChat = this.social.onChat(() => {
      this.renderMessages()
      this.updateComposerUi()
    })
    this.unsubChannel = this.social.onChannelChange(() => this.renderAll())
    this.unsubProfiles = this.social.onPeerProfilesChange(() => {
      this.renderMessages()
      this.updateComposerUi()
    })
    this.onVisibilityChange?.(true)
    window.setTimeout(() => this.inputEl.focus(), 0)
  }

  hide(): void {
    this.visible = false
    this.root.hidden = true
    this.inputEl.blur()
    this.resetBackgroundMode()
    this.unsubChat?.()
    this.unsubChannel?.()
    this.unsubProfiles?.()
    this.unsubChat = null
    this.unsubChannel = null
    this.unsubProfiles = null
    this.onVisibilityChange?.(false)
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
    window.removeEventListener('keydown', this.onGlobalKeyDown)
    this.sceneCanvas?.removeEventListener('mousedown', this.onScenePointerDown)
    this.hide()
    if (this.mounted) this.root.remove()
    this.mounted = false
  }

  private onGlobalKeyDown = (e: KeyboardEvent): void => {
    if (this.visible) return
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
    if (this.isTypingTarget()) return
    e.preventDefault()
    this.show()
  }

  private onScenePointerDown = (): void => {
    if (!this.visible) return
    this.root.classList.add('is-scene-mode')
    this.root.classList.remove('is-chat-pinned')
  }

  private onChatPointerDown = (e: MouseEvent): void => {
    if (!this.visible) return
    e.stopPropagation()
    this.root.classList.remove('is-scene-mode')
    this.root.classList.add('is-chat-pinned')
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
    this.headerSubtitle.textContent = this.social.getChannelSubtitle()
    this.renderRail()
    this.renderMessages()
    this.updateComposerUi()
    this.inputEl.disabled = false
    this.inputEl.placeholder = 'Press Enter to chat'
  }

  private renderRail(): void {
    this.railScrollEl.innerHTML = ''
    const current = this.social.getChannel()

    const scene = this.social.getSceneTab()
    if (scene) {
      this.railScrollEl.appendChild(
        this.createRailButton({
          channel: { kind: 'scene', sceneKey: scene.key, label: scene.label },
          title: scene.label,
          iconSvg: SCENE_CHAT_RAIL_ICON,
          active: current.kind === 'scene'
        })
      )
    }

    for (const community of this.social.getCommunities()) {
      this.railScrollEl.appendChild(
        this.createRailButton({
          channel: { kind: 'community', communityId: community.id, displayName: community.name },
          title: community.name,
          imageUrl: pickCommunityThumbnailUrl(community.thumbnails),
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
    const lines = this.social.getMessages()
    this.messagesEl.innerHTML = ''

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
    const local = this.social.getLocalDisplay()
    const localAddress = this.social.getLocalAddress()
    const mentionsSelf =
      !line.self &&
      textChatMentionsSelf(line.text, localAddress, local.displayName)

    const row = document.createElement('div')
    row.className = `chat-panel__line${line.self ? ' is-self' : ''}`

    const avatar = document.createElement('div')
    avatar.className = 'chat-panel__avatar'

    const bubble = document.createElement('div')
    bubble.className = `chat-panel__bubble${mentionsSelf ? ' is-mentioned' : ''}`

    const name = document.createElement('div')
    name.className = 'chat-panel__sender'

    const text = document.createElement('div')
    text.className = 'chat-panel__text'
    appendLinkifiedText(text, line.text, {
      onNavigate: (target) => {
        if (document.pointerLockElement) document.exitPointerLock()
        void this.onGoto?.(target)
      }
    })

    const time = document.createElement('div')
    time.className = 'chat-panel__time'
    time.textContent = SocialService.formatLineTime(line)

    if (line.self) {
      name.textContent = local.displayName
      name.style.color = local.nameColor
      this.fillAvatar(avatar, local.faceUrl, local.displayName)
    } else {
      const peer = this.social.getPeerDisplay(line.senderAddress)
      name.textContent = peer.displayName
      name.style.color = peer.nameColor
      this.fillAvatar(avatar, peer.faceUrl, peer.displayName)
    }

    bubble.appendChild(name)
    bubble.appendChild(text)
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

  private updateComposerUi(): void {
    const value = this.inputEl.value
    this.inputEl.classList.toggle('chat-panel__input--goto', /^\/goto/i.test(value))
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
