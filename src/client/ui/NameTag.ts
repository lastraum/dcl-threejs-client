import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

export type NameTagStyle = {
  textColor: string
  claimed?: boolean
}

/** Floating label above an avatar — billboard via CSS2DRenderer. */
export class NameTag {
  readonly object: CSS2DObject
  private readonly textEl: HTMLSpanElement
  private readonly badgeEl: HTMLSpanElement | null
  private label: string
  private style: NameTagStyle

  constructor(text: string, style: NameTagStyle) {
    const el = document.createElement('div')
    el.className = 'avatar-name-tag'

    this.textEl = document.createElement('span')
    this.textEl.className = 'avatar-name-tag__text'
    el.appendChild(this.textEl)

    this.badgeEl = style.claimed ? document.createElement('span') : null
    if (this.badgeEl) {
      this.badgeEl.className = 'avatar-name-tag__badge'
      this.badgeEl.textContent = '✓'
      el.appendChild(this.badgeEl)
    }

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

  dispose(): void {
    this.object.removeFromParent()
  }

  private applyStyle(): void {
    this.textEl.style.color = this.style.textColor
  }
}
