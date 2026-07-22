import {
  buildEmoteWheelSlots,
  emoteWheelThumbnailUrl,
  type EmoteWheelSlot
} from '../../avatar/profileEmotes'
import type { AvatarProfile } from '../../avatar/types'

export type EmoteWheelCallbacks = {
  onEmoteSelected?: (emoteId: string, slotIndex: number) => void
  onVisibilityChange?: (visible: boolean) => void
  /** When false, B / sidebar / mobile emote controls cannot open the wheel. */
  canOpen?: () => boolean
  /**
   * Customize [E] while wheel is open — close wheel + open emote backpack.
   * Must not forward E to scene/PE workers (handled here + InputHub block).
   */
  onCustomize?: () => void
}

const SLOT_COUNT = 10
/** Large pies with a little air between them on the ring. */
const INNER_RADIUS = 74
const OUTER_RADIUS = 202
const CENTER = 220
const VIEW = 440
const WEDGE_GAP_DEG = 4.2
const THUMB_SIZE = 56
const NAME_RADIUS = (INNER_RADIUS + OUTER_RADIUS) / 2 + 10
const THUMB_RADIUS = (INNER_RADIUS + OUTER_RADIUS) / 2 - 8
const KEY_RADIUS = OUTER_RADIUS - 15

/** SVG gradient stops per DCL rarity (light inner → richer outer). */
const RARITY_GRADIENTS: Record<string, [string, string, string?]> = {
  base: ['#f2f2f6', '#c8c8d2', '#a8a8b4'],
  common: ['#e8fbfb', '#73d3d3', '#3a9e9e'],
  uncommon: ['#ffe8e0', '#ff8362', '#c94a2e'],
  rare: ['#e0ffe8', '#34ce76', '#1a8f4c'],
  epic: ['#e4efff', '#438fff', '#1f5fc4'],
  legendary: ['#f0e0ff', '#a14bf3', '#6b1fc4'],
  mythic: ['#ffe0f7', '#ff4bed', '#b010a0'],
  unique: ['#fff0d4', '#fea217', '#c47800'],
  exotic: ['#f5d4d4', '#9b2222', '#5c1010']
}

function normalizeRarity(raw: string | undefined): string {
  const r = (raw ?? 'base').trim().toLowerCase()
  return RARITY_GRADIENTS[r] ? r : 'base'
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function wedgePath(index: number, outerR = OUTER_RADIUS, innerR = INNER_RADIUS): string {
  const slice = 360 / SLOT_COUNT
  const halfGap = WEDGE_GAP_DEG / 2
  const s = degToRad(-90 + index * slice + halfGap)
  const e = degToRad(-90 + (index + 1) * slice - halfGap)

  const ox1 = CENTER + outerR * Math.cos(s)
  const oy1 = CENTER + outerR * Math.sin(s)
  const ox2 = CENTER + outerR * Math.cos(e)
  const oy2 = CENTER + outerR * Math.sin(e)
  const ix1 = CENTER + innerR * Math.cos(e)
  const iy1 = CENTER + innerR * Math.sin(e)
  const ix2 = CENTER + innerR * Math.cos(s)
  const iy2 = CENTER + innerR * Math.sin(s)

  return [
    `M ${ox1.toFixed(1)} ${oy1.toFixed(1)}`,
    `A ${outerR} ${outerR} 0 0 1 ${ox2.toFixed(1)} ${oy2.toFixed(1)}`,
    `L ${ix1.toFixed(1)} ${iy1.toFixed(1)}`,
    `A ${innerR} ${innerR} 0 0 0 ${ix2.toFixed(1)} ${iy2.toFixed(1)}`,
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

function truncateLabel(label: string, max = 14): string {
  const t = label.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

/** DCL Explorer-style radial emote wheel — 10 wedge slots, B to toggle. */
export class EmoteWheelPanel {
  readonly element: HTMLDivElement
  private visible = false
  private hoveredIndex = -1
  private slots: EmoteWheelSlot[] = buildEmoteWheelSlots()
  private readonly slotGroups: SVGGElement[] = []
  private readonly wedgePaths: SVGPathElement[] = []
  private readonly nameTexts: SVGTextElement[] = []
  private readonly keyTexts: SVGTextElement[] = []
  private readonly thumbImages: SVGImageElement[] = []
  private readonly clipPaths: SVGPathElement[] = []
  private callbacks: EmoteWheelCallbacks = {}

  constructor() {
    this.element = document.createElement('div')
    this.element.className = 'emote-wheel-overlay'
    this.element.hidden = true

    const NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', `0 0 ${VIEW} ${VIEW}`)
    svg.classList.add('emote-wheel__svg')

    const defs = document.createElementNS(NS, 'defs')
    for (const [rarity, stops] of Object.entries(RARITY_GRADIENTS)) {
      const grad = document.createElementNS(NS, 'radialGradient')
      grad.setAttribute('id', `emote-rarity-${rarity}`)
      grad.setAttribute('cx', '50%')
      grad.setAttribute('cy', '50%')
      grad.setAttribute('r', '75%')
      grad.setAttribute('fx', '42%')
      grad.setAttribute('fy', '38%')
      const s0 = document.createElementNS(NS, 'stop')
      s0.setAttribute('offset', '0%')
      s0.setAttribute('stop-color', stops[0])
      const s1 = document.createElementNS(NS, 'stop')
      s1.setAttribute('offset', '62%')
      s1.setAttribute('stop-color', stops[1])
      const s2 = document.createElementNS(NS, 'stop')
      s2.setAttribute('offset', '100%')
      s2.setAttribute('stop-color', stops[2] ?? stops[1])
      grad.append(s0, s1, s2)
      defs.appendChild(grad)

      const hGrad = document.createElementNS(NS, 'radialGradient')
      hGrad.setAttribute('id', `emote-rarity-${rarity}-hot`)
      hGrad.setAttribute('cx', '48%')
      hGrad.setAttribute('cy', '40%')
      hGrad.setAttribute('r', '80%')
      const h0 = document.createElementNS(NS, 'stop')
      h0.setAttribute('offset', '0%')
      h0.setAttribute('stop-color', '#ffffff')
      const h1 = document.createElementNS(NS, 'stop')
      h1.setAttribute('offset', '45%')
      h1.setAttribute('stop-color', stops[0])
      const h2 = document.createElementNS(NS, 'stop')
      h2.setAttribute('offset', '100%')
      h2.setAttribute('stop-color', stops[1])
      hGrad.append(h0, h1, h2)
      defs.appendChild(hGrad)
    }

    for (let i = 0; i < SLOT_COUNT; i++) {
      const clip = document.createElementNS(NS, 'clipPath')
      clip.setAttribute('id', `emote-wedge-clip-${i}`)
      const clipPath = document.createElementNS(NS, 'path')
      clipPath.setAttribute('d', wedgePath(i))
      this.clipPaths.push(clipPath)
      clip.appendChild(clipPath)
      defs.appendChild(clip)
    }

    const filter = document.createElementNS(NS, 'filter')
    filter.setAttribute('id', 'emote-wedge-shadow')
    filter.setAttribute('x', '-25%')
    filter.setAttribute('y', '-25%')
    filter.setAttribute('width', '150%')
    filter.setAttribute('height', '150%')
    const feDrop = document.createElementNS(NS, 'feDropShadow')
    feDrop.setAttribute('dx', '0')
    feDrop.setAttribute('dy', '2')
    feDrop.setAttribute('stdDeviation', '3')
    feDrop.setAttribute('flood-color', '#000')
    feDrop.setAttribute('flood-opacity', '0.38')
    filter.appendChild(feDrop)
    defs.appendChild(filter)

    const centerGrad = document.createElementNS(NS, 'radialGradient')
    centerGrad.setAttribute('id', 'emote-center-grad')
    centerGrad.setAttribute('cx', '42%')
    centerGrad.setAttribute('cy', '36%')
    centerGrad.setAttribute('r', '70%')
    for (const [off, col] of [
      ['0%', '#3a3a48'],
      ['55%', '#24242e'],
      ['100%', '#14141a']
    ] as const) {
      const stop = document.createElementNS(NS, 'stop')
      stop.setAttribute('offset', off)
      stop.setAttribute('stop-color', col)
      centerGrad.appendChild(stop)
    }
    defs.appendChild(centerGrad)
    svg.appendChild(defs)

    const glowRing = document.createElementNS(NS, 'circle')
    glowRing.setAttribute('cx', String(CENTER))
    glowRing.setAttribute('cy', String(CENTER))
    glowRing.setAttribute('r', String(OUTER_RADIUS + 8))
    glowRing.classList.add('emote-wheel__glow')
    svg.appendChild(glowRing)

    const disc = document.createElementNS(NS, 'circle')
    disc.setAttribute('cx', String(CENTER))
    disc.setAttribute('cy', String(CENTER))
    disc.setAttribute('r', String(OUTER_RADIUS + 2))
    disc.classList.add('emote-wheel__disc')
    svg.appendChild(disc)

    for (let i = 0; i < SLOT_COUNT; i++) {
      const g = document.createElementNS(NS, 'g')
      g.classList.add('emote-wheel__slot')
      g.dataset.index = String(i)
      g.style.transformOrigin = `${CENTER}px ${CENTER}px`

      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', wedgePath(i))
      path.classList.add('emote-wheel__wedge')
      path.setAttribute('filter', 'url(#emote-wedge-shadow)')
      this.wedgePaths.push(path)
      g.appendChild(path)

      const tp = polarPos(i, THUMB_RADIUS)
      const img = document.createElementNS(NS, 'image')
      img.setAttribute('x', (tp.x - THUMB_SIZE / 2).toFixed(1))
      img.setAttribute('y', (tp.y - THUMB_SIZE / 2 - 4).toFixed(1))
      img.setAttribute('width', String(THUMB_SIZE))
      img.setAttribute('height', String(THUMB_SIZE))
      img.setAttribute('preserveAspectRatio', 'xMidYMid meet')
      img.setAttribute('clip-path', `url(#emote-wedge-clip-${i})`)
      img.classList.add('emote-wheel__thumb')
      img.setAttribute('pointer-events', 'none')
      this.thumbImages.push(img)
      g.appendChild(img)

      const kp = polarPos(i, KEY_RADIUS)
      const keyText = document.createElementNS(NS, 'text')
      keyText.setAttribute('x', kp.x.toFixed(1))
      keyText.setAttribute('y', kp.y.toFixed(1))
      keyText.classList.add('emote-wheel__key')
      this.keyTexts.push(keyText)
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

      this.slotGroups.push(g)
      svg.appendChild(g)
    }

    const centerHit = document.createElementNS(NS, 'circle')
    centerHit.setAttribute('cx', String(CENTER))
    centerHit.setAttribute('cy', String(CENTER))
    centerHit.setAttribute('r', String(INNER_RADIUS - 4))
    centerHit.classList.add('emote-wheel__center')
    centerHit.style.cursor = 'pointer'
    centerHit.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.openCustomize()
    })
    svg.appendChild(centerHit)

    const centerRing = document.createElementNS(NS, 'circle')
    centerRing.setAttribute('cx', String(CENTER))
    centerRing.setAttribute('cy', String(CENTER))
    centerRing.setAttribute('r', String(INNER_RADIUS - 4))
    centerRing.classList.add('emote-wheel__center-ring')
    centerRing.setAttribute('pointer-events', 'none')
    svg.appendChild(centerRing)

    const title = document.createElementNS(NS, 'text')
    title.setAttribute('x', String(CENTER))
    title.setAttribute('y', String(CENTER - 10))
    title.classList.add('emote-wheel__center-title')
    title.setAttribute('pointer-events', 'none')
    title.textContent = 'EMOTES'
    svg.appendChild(title)

    const sub = document.createElementNS(NS, 'text')
    sub.setAttribute('x', String(CENTER))
    sub.setAttribute('y', String(CENTER + 12))
    sub.classList.add('emote-wheel__center-sub')
    sub.setAttribute('pointer-events', 'none')
    sub.textContent = 'Customize [E]'
    svg.appendChild(sub)

    this.element.appendChild(svg)

    const hint = document.createElement('div')
    hint.className = 'emote-wheel__hint'
    hint.innerHTML =
      'Press <kbd>B</kbd> to close · <kbd>0–9</kbd> to select · <kbd>E</kbd> customize'
    this.element.appendChild(hint)

    this.element.addEventListener('click', () => this.hide())

    // Capture phase — eat keys before InputHub / workers.
    window.addEventListener('keydown', this.onKeyDown, true)

    document.body.appendChild(this.element)
    this.applySlots()
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
    this.applySlots()
  }

  toggle(): void {
    if (this.visible) this.hide()
    else if (this.canOpen()) this.show()
  }

  show(): void {
    if (this.visible || !this.canOpen()) return
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

  private applySlots(): void {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = this.slots[i]
      const rarity = normalizeRarity(slot?.rarity)
      const path = this.wedgePaths[i]!
      const group = this.slotGroups[i]!
      const d = wedgePath(i)

      path.setAttribute('d', d)
      this.clipPaths[i]?.setAttribute('d', d)
      path.dataset.rarity = rarity
      path.setAttribute('fill', `url(#emote-rarity-${rarity})`)
      group.dataset.rarity = rarity

      this.keyTexts[i]!.textContent = slot?.key ?? String(i)
      this.nameTexts[i]!.textContent = truncateLabel(slot?.label ?? '')

      const thumb = this.thumbImages[i]!
      const url = (slot?.thumbnailUrl || (slot?.id ? emoteWheelThumbnailUrl(slot.id) : '')).trim()
      if (url) {
        thumb.setAttribute('href', url)
        thumb.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url)
        thumb.style.display = ''
        thumb.onerror = () => {
          thumb.style.display = 'none'
        }
      } else {
        thumb.removeAttribute('href')
        thumb.style.display = 'none'
      }
    }
  }

  private select(index: number): void {
    const slot = this.slots[index]
    if (!slot) return
    console.info(`[emote-wheel] ${slot.label} (${slot.key})`)
    this.callbacks.onEmoteSelected?.(slot.id, index)
    this.hide()
  }

  private openCustomize(): void {
    this.hide()
    this.callbacks.onCustomize?.()
  }

  private setHovered(index: number): void {
    if (this.hoveredIndex === index) return

    if (this.hoveredIndex >= 0) {
      const prev = this.hoveredIndex
      this.slotGroups[prev]?.classList.remove('is-hovered')
      this.wedgePaths[prev]?.classList.remove('is-hovered')
      const prevRarity = normalizeRarity(this.slots[prev]?.rarity)
      this.wedgePaths[prev]?.setAttribute('fill', `url(#emote-rarity-${prevRarity})`)
    }

    this.hoveredIndex = index

    if (index >= 0) {
      const g = this.slotGroups[index]
      g?.parentNode?.appendChild(g)
      const svg = g?.ownerSVGElement
      const center = svg?.querySelector('.emote-wheel__center')
      const ring = svg?.querySelector('.emote-wheel__center-ring')
      const title = svg?.querySelector('.emote-wheel__center-title')
      const sub = svg?.querySelector('.emote-wheel__center-sub')
      if (svg && center) {
        svg.appendChild(center)
        if (ring) svg.appendChild(ring)
        if (title) svg.appendChild(title)
        if (sub) svg.appendChild(sub)
      }
      g?.classList.add('is-hovered')
      this.wedgePaths[index]?.classList.add('is-hovered')
      const rarity = normalizeRarity(this.slots[index]?.rarity)
      this.wedgePaths[index]?.setAttribute('fill', `url(#emote-rarity-${rarity}-hot)`)
    }
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

  private canOpen(): boolean {
    return this.callbacks.canOpen?.() ?? true
  }

  private swallowKey(e: KeyboardEvent): void {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'KeyB' && !this.isTyping()) {
      if (!this.visible && !this.canOpen()) return
      this.swallowKey(e)
      this.toggle()
      return
    }

    if (!this.visible) return

    // While open, never let movement / interact reach workers.
    const suppress = [
      'KeyW',
      'KeyA',
      'KeyS',
      'KeyD',
      'Space',
      'ShiftLeft',
      'ShiftRight',
      'KeyE',
      'KeyF',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight'
    ]
    if (suppress.includes(e.code)) {
      this.swallowKey(e)
      if (e.code === 'KeyE') this.openCustomize()
      return
    }

    if (e.code === 'Escape') {
      this.swallowKey(e)
      this.hide()
      return
    }

    const m = e.code.match(/^(?:Digit|Numpad)(\d)$/)
    if (m) {
      this.swallowKey(e)
      const idx = this.slots.findIndex((s) => s.key === m[1])
      if (idx >= 0) this.select(idx)
    }
  }
}
