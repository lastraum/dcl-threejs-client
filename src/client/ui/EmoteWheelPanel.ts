import { buildEmoteWheelSlots, type EmoteWheelSlot } from '../../avatar/profileEmotes'
import type { AvatarProfile } from '../../avatar/types'

export type EmoteWheelCallbacks = {
  onEmoteSelected?: (emoteId: string, slotIndex: number) => void
  onVisibilityChange?: (visible: boolean) => void
}

const SLOT_COUNT = 10
const INNER_RADIUS = 62
const OUTER_RADIUS = 168
const CENTER = 200
const WEDGE_GAP_DEG = 2.5
const NAME_RADIUS = (INNER_RADIUS + OUTER_RADIUS) / 2 - 6
const KEY_RADIUS = (INNER_RADIUS + OUTER_RADIUS) / 2 + 32

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function wedgePath(index: number): string {
  const slice = 360 / SLOT_COUNT
  const halfGap = WEDGE_GAP_DEG / 2
  const s = degToRad(-90 + index * slice + halfGap)
  const e = degToRad(-90 + (index + 1) * slice - halfGap)

  const ox1 = CENTER + OUTER_RADIUS * Math.cos(s)
  const oy1 = CENTER + OUTER_RADIUS * Math.sin(s)
  const ox2 = CENTER + OUTER_RADIUS * Math.cos(e)
  const oy2 = CENTER + OUTER_RADIUS * Math.sin(e)
  const ix1 = CENTER + INNER_RADIUS * Math.cos(e)
  const iy1 = CENTER + INNER_RADIUS * Math.sin(e)
  const ix2 = CENTER + INNER_RADIUS * Math.cos(s)
  const iy2 = CENTER + INNER_RADIUS * Math.sin(s)

  return [
    `M ${ox1.toFixed(1)} ${oy1.toFixed(1)}`,
    `A ${OUTER_RADIUS} ${OUTER_RADIUS} 0 0 1 ${ox2.toFixed(1)} ${oy2.toFixed(1)}`,
    `L ${ix1.toFixed(1)} ${iy1.toFixed(1)}`,
    `A ${INNER_RADIUS} ${INNER_RADIUS} 0 0 0 ${ix2.toFixed(1)} ${iy2.toFixed(1)}`,
    'Z'
  ].join(' ')
}

function polarPos(index: number, radius: number): { x: number; y: number } {
  const slice = 360 / SLOT_COUNT
  const angle = degToRad(-90 + index * slice + slice / 2)
  return {
    x: CENTER + radius * Math.cos(angle),
    y: CENTER + radius * Math.sin(angle)
  }
}

/** DCL Explorer-style radial emote wheel — 10 wedge slots, B to toggle. */
export class EmoteWheelPanel {
  readonly element: HTMLDivElement
  private visible = false
  private hoveredIndex = -1
  private slots: EmoteWheelSlot[] = buildEmoteWheelSlots()
  private readonly wedgePaths: SVGPathElement[] = []
  private readonly nameTexts: SVGTextElement[] = []
  private callbacks: EmoteWheelCallbacks = {}

  constructor() {
    this.element = document.createElement('div')
    this.element.className = 'emote-wheel-overlay'
    this.element.hidden = true

    const NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 400 400')
    svg.classList.add('emote-wheel__svg')

    const glowRing = document.createElementNS(NS, 'circle')
    glowRing.setAttribute('cx', String(CENTER))
    glowRing.setAttribute('cy', String(CENTER))
    glowRing.setAttribute('r', String(OUTER_RADIUS + 4))
    glowRing.classList.add('emote-wheel__glow')
    svg.appendChild(glowRing)

    for (let i = 0; i < SLOT_COUNT; i++) {
      const g = document.createElementNS(NS, 'g')
      g.classList.add('emote-wheel__slot')
      g.dataset.index = String(i)

      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', wedgePath(i))
      path.classList.add('emote-wheel__wedge')
      this.wedgePaths.push(path)
      g.appendChild(path)

      const kp = polarPos(i, KEY_RADIUS)
      const keyText = document.createElementNS(NS, 'text')
      keyText.setAttribute('x', kp.x.toFixed(1))
      keyText.setAttribute('y', kp.y.toFixed(1))
      keyText.classList.add('emote-wheel__key')
      g.appendChild(keyText)

      const np = polarPos(i, NAME_RADIUS)
      const nameText = document.createElementNS(NS, 'text')
      nameText.setAttribute('x', np.x.toFixed(1))
      nameText.setAttribute('y', np.y.toFixed(1))
      nameText.classList.add('emote-wheel__name')
      this.nameTexts.push(nameText)
      g.appendChild(nameText)

      g.addEventListener('mouseenter', () => this.setHovered(i))
      g.addEventListener('mouseleave', () => this.setHovered(-1))
      g.addEventListener('click', (ev) => {
        ev.stopPropagation()
        this.select(i)
      })

      svg.appendChild(g)
    }

    const centerBg = document.createElementNS(NS, 'circle')
    centerBg.setAttribute('cx', String(CENTER))
    centerBg.setAttribute('cy', String(CENTER))
    centerBg.setAttribute('r', String(INNER_RADIUS - 4))
    centerBg.classList.add('emote-wheel__center')
    svg.appendChild(centerBg)

    const title = document.createElementNS(NS, 'text')
    title.setAttribute('x', String(CENTER))
    title.setAttribute('y', String(CENTER - 10))
    title.classList.add('emote-wheel__center-title')
    title.textContent = 'EMOTES'
    svg.appendChild(title)

    const sub = document.createElementNS(NS, 'text')
    sub.setAttribute('x', String(CENTER))
    sub.setAttribute('y', String(CENTER + 10))
    sub.classList.add('emote-wheel__center-sub')
    sub.textContent = 'Customize [E]'
    svg.appendChild(sub)

    this.element.appendChild(svg)

    const hint = document.createElement('div')
    hint.className = 'emote-wheel__hint'
    hint.innerHTML = 'Press <kbd>B</kbd> to close · <kbd>0–9</kbd> to select'
    this.element.appendChild(hint)

    this.element.addEventListener('click', () => this.hide())

    window.addEventListener('keydown', this.onKeyDown, true)

    document.body.appendChild(this.element)
    this.applySlotLabels()
  }

  setCallbacks(cb: EmoteWheelCallbacks): void {
    this.callbacks = cb
  }

  setProfile(profile: AvatarProfile | null | undefined): void {
    this.setSlots(buildEmoteWheelSlots(profile))
  }

  setSlots(slots: EmoteWheelSlot[]): void {
    this.slots = slots.slice(0, SLOT_COUNT)
    while (this.slots.length < SLOT_COUNT) {
      this.slots.push(buildEmoteWheelSlots()[this.slots.length])
    }
    this.applySlotLabels()
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  show(): void {
    if (this.visible) return
    if (document.pointerLockElement) document.exitPointerLock()
    this.visible = true
    this.element.hidden = false
    requestAnimationFrame(() => this.element.classList.add('is-open'))
    this.callbacks.onVisibilityChange?.(true)
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.element.classList.remove('is-open')
    this.setHovered(-1)
    setTimeout(() => {
      if (!this.visible) this.element.hidden = true
    }, 220)
    this.callbacks.onVisibilityChange?.(false)
  }

  isVisible(): boolean {
    return this.visible
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown, true)
    this.element.remove()
  }

  private applySlotLabels(): void {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = this.slots[i]
      const keyEl = this.element.querySelector(`.emote-wheel__slot[data-index="${i}"] .emote-wheel__key`)
      if (keyEl) keyEl.textContent = slot?.key ?? String(i)
      this.nameTexts[i]!.textContent = slot?.label ?? ''
    }
  }

  private select(index: number): void {
    const slot = this.slots[index]
    if (!slot) return
    console.info(`[emote-wheel] ${slot.label} (${slot.key})`)
    this.callbacks.onEmoteSelected?.(slot.id, index)
    this.hide()
  }

  private setHovered(index: number): void {
    if (this.hoveredIndex === index) return
    if (this.hoveredIndex >= 0) this.wedgePaths[this.hoveredIndex]?.classList.remove('is-hovered')
    this.hoveredIndex = index
    if (index >= 0) this.wedgePaths[index]?.classList.add('is-hovered')
  }

  private isTyping(): boolean {
    const el = document.activeElement
    if (el instanceof HTMLInputElement) {
      const t = el.type.toLowerCase()
      return t !== 'checkbox' && t !== 'radio' && t !== 'button' && t !== 'submit' && t !== 'reset'
    }
    if (el instanceof HTMLTextAreaElement) return true
    if (el instanceof HTMLElement && el.isContentEditable) return true
    return false
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'KeyB' && !this.isTyping()) {
      e.preventDefault()
      e.stopPropagation()
      this.toggle()
      return
    }

    if (!this.visible) return

    const suppress = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight']
    if (suppress.includes(e.code)) {
      e.stopPropagation()
      return
    }

    if (e.code === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      this.hide()
      return
    }

    const m = e.code.match(/^(?:Digit|Numpad)(\d)$/)
    if (m) {
      e.preventDefault()
      e.stopPropagation()
      const idx = this.slots.findIndex((s) => s.key === m[1])
      if (idx >= 0) this.select(idx)
    }
  }
}
