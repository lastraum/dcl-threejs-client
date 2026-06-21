import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

export type NameTagStyle = {
  textColor: string
  claimed?: boolean
}

/** Horizontal growth cap before chat wraps and the pill grows taller. */
export const NAME_TAG_CHAT_MAX_WIDTH_PX = 200

/** How long overhead chat stays visible above an avatar. */
export const NAME_TAG_CHAT_DISPLAY_MS = 10_000

/** Floating label above an avatar — billboard via CSS2DRenderer. */
export class NameTag {
  readonly object: CSS2DObject
  private readonly rootEl: HTMLDivElement
  private readonly textEl: HTMLSpanElement
  private readonly badgeEl: HTMLSpanElement | null
  private readonly chatEl: HTMLDivElement
  private label: string
  private style: NameTagStyle
  private chatHideTimer: ReturnType<typeof setTimeout> | null = null

  constructor(text: string, style: NameTagStyle) {
    const el = document.createElement('div')
    el.className = 'avatar-name-tag'
    this.rootEl = el

    const header = document.createElement('div')
    header.className = 'avatar-name-tag__header'

    this.textEl = document.createElement('span')
    this.textEl.className = 'avatar-name-tag__text'
    header.appendChild(this.textEl)

    this.badgeEl = style.claimed ? document.createElement('span') : null
    if (this.badgeEl) {
      this.badgeEl.className = 'avatar-name-tag__badge'
      this.badgeEl.textContent = '✓'
      header.appendChild(this.badgeEl)
    }

    el.appendChild(header)

    this.chatEl = document.createElement('div')
    this.chatEl.className = 'avatar-name-tag__chat'
    this.chatEl.setAttribute('aria-hidden', 'true')
    el.appendChild(this.chatEl)

    this.label = text
    this.style = { ...style }
    this.textEl.textContent = text
    this.applyStyle()

    this.object = new CSS2DObject(el)
  }

  static attach(parent: THREE.Object3D, text: string, style: NameTagStyle): NameTag {
    const tag = new NameTag(text, style)
    parent.add(tag.object)
    return tag
  }

  setText(text: string): void {
    if (text === this.label) return
    this.label = text
    this.textEl.textContent = text
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
  }

  /** Show chat inside the pill (under the name) for a short duration. */
  showChat(text: string, durationMs = NAME_TAG_CHAT_DISPLAY_MS): void {
    const trimmed = text.trim()
    if (!trimmed) {
      this.clearChat()
      return
    }
    if (this.chatHideTimer !== null) {
      clearTimeout(this.chatHideTimer)
      this.chatHideTimer = null
    }
    this.chatEl.textContent = trimmed
    this.rootEl.classList.add('avatar-name-tag--has-chat')
    this.chatEl.setAttribute('aria-hidden', 'false')
    this.chatHideTimer = setTimeout(() => this.clearChat(), durationMs)
  }

  clearChat(): void {
    if (this.chatHideTimer !== null) {
      clearTimeout(this.chatHideTimer)
      this.chatHideTimer = null
    }
    this.chatEl.textContent = ''
    this.rootEl.classList.remove('avatar-name-tag--has-chat')
    this.chatEl.setAttribute('aria-hidden', 'true')
  }

  dispose(): void {
    this.clearChat()
    this.object.removeFromParent()
  }

  private applyStyle(): void {
    this.textEl.style.color = this.style.textColor
  }
}