import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { registerNameTagObject, unregisterNameTagObject } from './NameTagRenderer'

export type NameTagStyle = {
  textColor: string
  claimed?: boolean
}

export type NameTagOptions = NameTagStyle & {
  /** Wallet address — enables right-click context menu when interactive. */
  address?: string
  interactive?: boolean
}

/** Horizontal growth cap before chat wraps and the pill grows taller. */
export const NAME_TAG_CHAT_MAX_WIDTH_PX = 200

/** How long overhead chat stays visible above an avatar. */
export const NAME_TAG_CHAT_DISPLAY_MS = 10_000

type NameTagContextHandler = (address: string, clientX: number, clientY: number) => void

let contextMenuHandler: NameTagContextHandler | null = null

export function setNameTagContextMenuHandler(handler: NameTagContextHandler | null): void {
  contextMenuHandler = handler
}

const OPTIONS_TOOLTIP_HTML = `
  <span class="avatar-name-tag__options-label">Options</span>
  <span class="avatar-name-tag__options-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M8 6h12M8 12h12M8 18h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <rect x="2.5" y="4.5" width="3" height="3" rx="0.6" fill="currentColor"/>
      <rect x="2.5" y="10.5" width="3" height="3" rx="0.6" fill="currentColor"/>
      <rect x="2.5" y="16.5" width="3" height="3" rx="0.6" fill="currentColor"/>
    </svg>
  </span>
`

export type NameTagDmChatOptions = {
  /** Outgoing: "Name DM to Peer". Incoming: "Name DM". */
  mode: 'outgoing' | 'incoming'
  /** Peer display name for outgoing "to …" suffix. */
  peerName?: string
}

/** Floating label above an avatar — billboard via CSS2DRenderer. */
export class NameTag {
  readonly object: CSS2DObject
  private readonly rootEl: HTMLDivElement
  private readonly textEl: HTMLSpanElement
  private readonly badgeEl: HTMLSpanElement | null
  private readonly dmBadgeEl: HTMLSpanElement
  private readonly dmToEl: HTMLSpanElement
  private readonly chatEl: HTMLDivElement
  private readonly loadingEl: HTMLDivElement
  private readonly voiceEl: HTMLDivElement

  private label: string
  private loading = false
  private style: NameTagStyle
  private readonly address: string | null
  private chatHideTimer: ReturnType<typeof setTimeout> | null = null
  private voiceLevel = 0

  constructor(text: string, options: NameTagOptions) {
    const el = document.createElement('div')
    el.className = 'avatar-name-tag'
    this.rootEl = el

    const header = document.createElement('div')
    header.className = 'avatar-name-tag__header'

    this.textEl = document.createElement('span')
    this.textEl.className = 'avatar-name-tag__text'
    header.appendChild(this.textEl)

    this.badgeEl = options.claimed ? document.createElement('span') : null
    if (this.badgeEl) {
      this.badgeEl.className = 'avatar-name-tag__badge'
      this.badgeEl.textContent = '✓'
      header.appendChild(this.badgeEl)
    }

    // Explorer-style pink "DM" marker — only visible while a private message is shown.
    this.dmBadgeEl = document.createElement('span')
    this.dmBadgeEl.className = 'avatar-name-tag__dm-badge'
    this.dmBadgeEl.textContent = 'DM'
    this.dmBadgeEl.hidden = true
    header.appendChild(this.dmBadgeEl)

    this.dmToEl = document.createElement('span')
    this.dmToEl.className = 'avatar-name-tag__dm-to'
    this.dmToEl.hidden = true
    header.appendChild(this.dmToEl)

    // 3 green voice bars inside the pill, to the right of name / checkmark.
    this.voiceEl = document.createElement('div')
    this.voiceEl.className = 'avatar-name-tag__voice'
    this.voiceEl.setAttribute('aria-hidden', 'true')
    for (let i = 0; i < 3; i++) {
      const bar = document.createElement('span')
      bar.className = 'avatar-name-tag__voice-bar'
      this.voiceEl.appendChild(bar)
    }
    header.appendChild(this.voiceEl)

    el.appendChild(header)

    this.chatEl = document.createElement('div')
    this.chatEl.className = 'avatar-name-tag__chat'
    this.chatEl.setAttribute('aria-hidden', 'true')
    el.appendChild(this.chatEl)

    this.loadingEl = document.createElement('div')
    this.loadingEl.className = 'avatar-name-tag__loading'
    this.loadingEl.setAttribute('aria-hidden', 'true')
    const spinner = document.createElement('div')
    spinner.className = 'avatar-name-tag__loading-spinner'
    this.loadingEl.appendChild(spinner)
    el.appendChild(this.loadingEl)

    this.label = text
    this.style = { textColor: options.textColor, claimed: options.claimed }
    this.address = options.address?.toLowerCase() ?? null
    this.textEl.textContent = text
    this.applyStyle()

    if (options.interactive && this.address) {
      el.classList.add('avatar-name-tag--interactive')
      el.dataset.peerAddress = this.address
      const hint = document.createElement('div')
      hint.className = 'avatar-name-tag__options-hint'
      hint.innerHTML = OPTIONS_TOOLTIP_HTML
      el.appendChild(hint)
      this.wireInteraction()
    }

    this.object = new CSS2DObject(el)
    this.syncPresentFlags()
  }

  static attach(parent: THREE.Object3D, text: string, options: NameTagOptions): NameTag {
    // Drop any leftover CSS2D pills on this anchor (reload / N-toggle races).
    for (const child of [...parent.children]) {
      if (child instanceof CSS2DObject) {
        child.removeFromParent()
        child.element?.remove()
      }
    }
    const tag = new NameTag(text, options)
    parent.add(tag.object)
    registerNameTagObject(tag.object)
    return tag
  }

  setText(text: string): void {
    if (text === this.label) return
    this.label = text
    this.textEl.textContent = text
    this.syncPresentFlags()
  }

  setStyle(style: NameTagStyle): void {
    const next = { ...style }
    if (
      next.textColor === this.style.textColor &&
      !!next.claimed === !!this.style.claimed
    ) {
      return
    }
    this.style = next
    if (this.badgeEl) {
      this.badgeEl.style.display = next.claimed ? '' : 'none'
    }
    this.applyStyle()
    this.syncPresentFlags()
  }

  /**
   * Show chat under the name for a short duration.
   * Message body only — never re-print the display name (header already has it).
   */
  showChat(text: string, durationMs = NAME_TAG_CHAT_DISPLAY_MS): void {
    const trimmed = stripDuplicateNameFromChat(text, this.label)
    if (!trimmed) {
      this.clearChat()
      return
    }
    // Scene chat — clear any leftover private-DM header chrome.
    this.rootEl.classList.remove('avatar-name-tag--dm')
    this.dmBadgeEl.hidden = true
    this.dmToEl.hidden = true
    this.dmToEl.textContent = ''
    this.beginChatDisplay(trimmed, durationMs)
  }

  /**
   * Private message overhead (local client only).
   * Outgoing: `Name ✓ DM to Peer` + message.
   * Incoming: `Name ✓ DM` + message.
   */
  showDmChat(text: string, options: NameTagDmChatOptions, durationMs = NAME_TAG_CHAT_DISPLAY_MS): void {
    const trimmed = stripDuplicateNameFromChat(text, this.label)
    if (!trimmed) {
      this.clearChat()
      return
    }
    this.dmBadgeEl.hidden = false
    this.rootEl.classList.add('avatar-name-tag--dm')
    if (options.mode === 'outgoing' && options.peerName?.trim()) {
      this.dmToEl.textContent = `to ${options.peerName.trim()}`
      this.dmToEl.hidden = false
    } else {
      this.dmToEl.textContent = ''
      this.dmToEl.hidden = true
    }
    this.beginChatDisplay(trimmed, durationMs)
  }

  clearChat(): void {
    if (this.chatHideTimer !== null) {
      clearTimeout(this.chatHideTimer)
      this.chatHideTimer = null
    }
    this.chatEl.textContent = ''
    this.rootEl.classList.remove('avatar-name-tag--has-chat')
    this.rootEl.classList.remove('avatar-name-tag--dm')
    this.dmBadgeEl.hidden = true
    this.dmToEl.hidden = true
    this.dmToEl.textContent = ''
    this.chatEl.setAttribute('aria-hidden', 'true')
    this.syncPresentFlags()
  }

  private beginChatDisplay(trimmed: string, durationMs: number): void {
    if (this.chatHideTimer !== null) {
      clearTimeout(this.chatHideTimer)
      this.chatHideTimer = null
    }
    this.chatEl.textContent = trimmed
    this.rootEl.classList.add('avatar-name-tag--has-chat')
    this.chatEl.setAttribute('aria-hidden', 'false')
    this.chatHideTimer = setTimeout(() => this.clearChat(), durationMs)
    this.syncPresentFlags()
  }

  /** Centered spinner overlay while a remote avatar is still loading. */
  setLoading(loading: boolean): void {
    if (loading === this.loading) return
    this.loading = loading
    this.rootEl.classList.toggle('avatar-name-tag--loading', loading)
    this.loadingEl.setAttribute('aria-hidden', loading ? 'false' : 'true')
    this.syncPresentFlags()
  }

  /**
   * Nearby-voice activity (0–1). Shows 3 green bars above the name when active.
   * LiveKit `audioLevel` typically ~0–1 when speaking.
   */
  setVoiceLevel(level: number): void {
    const next = Math.max(0, Math.min(1, level))
    if (Math.abs(next - this.voiceLevel) < 0.01) return
    const was = this.voiceLevel > 0.02
    const now = next > 0.02
    this.voiceLevel = next
    this.rootEl.style.setProperty('--voice-level', next.toFixed(3))
    if (was === now) return
    this.rootEl.classList.toggle('avatar-name-tag--speaking', now)
    this.voiceEl.setAttribute('aria-hidden', now ? 'false' : 'true')
    this.syncPresentFlags()
  }

  dispose(): void {
    this.clearChat()
    this.setVoiceLevel(0)
    unregisterNameTagObject(this.object)
    this.object.removeFromParent()
    this.rootEl.remove()
  }

  private wireInteraction(): void {
    if (!this.address) return

    const blockCameraInput = (e: Event): void => {
      e.stopPropagation()
    }

    // Open from `pointerdown`, not the derived `click` / `contextmenu` events.
    // `click` only fires when down and up land on the same element, and the pill
    // tracks a moving avatar — it slips out from under the cursor between the
    // two. `contextmenu` is worse: Opera's mouse gestures (on by default) claim
    // the right button and never dispatch it. pointerdown fires in every engine.
    this.rootEl.addEventListener(
      'pointerdown',
      (e) => {
        e.stopPropagation()
        // Primary and secondary only — middle-click stays a browser gesture.
        if (e.button !== 0 && e.button !== 2) return
        e.preventDefault()
        contextMenuHandler?.(this.address!, e.clientX, e.clientY)
      },
      true
    )

    // Right-click already opened the menu above; keep the native menu suppressed.
    this.rootEl.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })

    this.rootEl.addEventListener('mousedown', blockCameraInput, true)
    this.rootEl.addEventListener('pointerup', blockCameraInput, true)
  }

  private applyStyle(): void {
    this.textEl.style.color = this.style.textColor
  }

  /** Far tags drop CSS layout unless chat / voice / loading need the full pill. */
  private syncPresentFlags(): void {
    const rich =
      this.loading ||
      this.voiceLevel > 0.02 ||
      this.rootEl.classList.contains('avatar-name-tag--has-chat')
    this.object.userData.dclTagRich = rich
    this.object.userData.dclTagLabel = this.label
    this.object.userData.dclTagColor = this.style.textColor
  }
}

/**
 * Overhead pill already shows the display name in the header.
 * Strip a leading name line / "Name:" prefix so chat doesn't print the name twice.
 */
export function stripDuplicateNameFromChat(text: string, displayName: string): string {
  let trimmed = text.trim()
  if (!trimmed) return ''
  const name = displayName.trim()
  if (!name) return trimmed

  // "Lastraum\n@Guest-fudge …"
  const lines = trimmed.split(/\r?\n/)
  if (lines.length > 1 && lines[0]!.trim().toLowerCase() === name.toLowerCase()) {
    trimmed = lines.slice(1).join('\n').trim()
  }

  // "Lastraum: message" / "Lastraum - message"
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const prefix = new RegExp(`^${escaped}\\s*[:\\-]\\s+`, 'i')
  trimmed = trimmed.replace(prefix, '').trim()

  return trimmed
}