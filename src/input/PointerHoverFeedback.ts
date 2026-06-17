import type { PBPointerEvents_Entry } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/pointer_events.gen'
import { InputAction, InteractionType, PointerEventType, type InputActionValue } from './pointerConstants'
import { inputActionKeyBadge, shouldShowPointerHoverHint } from './inputActionBinding'

type TooltipEntry = { hoverText: string; button: InputActionValue }

type TooltipLine = {
  root: HTMLDivElement
  iconSlot: HTMLSpanElement
  text: HTMLSpanElement
  iconButton: InputActionValue | null
}

const LINE_PILL_STYLE =
  'padding:6px 12px;border-radius:8px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.12);'

const LINE_ROW_STYLE = 'display:flex;align-items:center;gap:8px;'

const KEY_BADGE_STYLE =
  'display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;' +
  'min-width:20px;height:20px;padding:0 5px;border-radius:5px;' +
  'background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);' +
  'font:700 11px/1 system-ui,sans-serif;color:#fff;letter-spacing:.02em;'

const MOUSE_ICON_STYLE =
  'display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;' +
  'width:20px;height:20px;border-radius:5px;' +
  'background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);color:#fff;'

/** Floating hover hints near the cursor — Unity `IECSInteractionHoverCanvas` parity. */
export class PointerHoverFeedback {
  private readonly root: HTMLDivElement
  private readonly lines: TooltipLine[] = []
  private visible = false

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div')
    this.root.className = 'pointer-hover-feedback'
    this.root.style.cssText =
      'position:fixed;left:0;top:0;' +
      'display:none;flex-direction:column;align-items:flex-start;gap:6px;' +
      'pointer-events:none;z-index:9000;font:600 13px/1.3 system-ui,sans-serif;color:#fff;' +
      'text-shadow:0 1px 3px rgba(0,0,0,.85);'
    parent.appendChild(this.root)
  }

  dispose(): void {
    this.root.remove()
    this.lines.length = 0
  }

  update(
    entries: ReadonlyArray<PBPointerEvents_Entry>,
    inRange: boolean,
    primaryActionDown: boolean,
    screenX: number,
    screenY: number
  ): void {
    if (!inRange) {
      this.hide()
      return
    }

    const tooltips: TooltipEntry[] = []

    for (const entry of entries) {
      const info = entry.eventInfo
      if (!info || info.showFeedback === false) continue
      if ((entry.interactionType ?? InteractionType.CURSOR) !== InteractionType.CURSOR) continue

      const hoverText = info.hoverText?.trim() || 'Interact'
      const button = (info.button ?? InputAction.IA_ANY) as InputActionValue
      const eventType = entry.eventType ?? PointerEventType.PET_DOWN

      if (shouldShowPointerHoverHint(button, eventType, primaryActionDown)) {
        tooltips.push({ hoverText, button })
      }
    }

    if (!tooltips.length) {
      this.hide()
      return
    }

    while (this.lines.length < tooltips.length) {
      this.lines.push(this.createLine())
    }

    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i]
      if (i < tooltips.length) {
        this.applyTooltipLine(line, tooltips[i])
        line.root.style.display = 'block'
      } else {
        line.root.style.display = 'none'
      }
    }

    const offsetX = 18
    const offsetY = 18
    const maxX = Math.max(0, window.innerWidth - 280)
    const maxY = Math.max(0, window.innerHeight - 48)
    this.root.style.left = `${Math.min(screenX + offsetX, maxX)}px`
    this.root.style.top = `${Math.min(screenY + offsetY, maxY)}px`

    if (!this.visible) {
      this.root.style.display = 'flex'
      this.visible = true
    }
  }

  hide(): void {
    if (!this.visible) return
    this.root.style.display = 'none'
    this.visible = false
  }

  private createLine(): TooltipLine {
    const root = document.createElement('div')
    root.style.cssText = LINE_PILL_STYLE

    const row = document.createElement('div')
    row.style.cssText = LINE_ROW_STYLE

    const iconSlot = document.createElement('span')
    iconSlot.setAttribute('aria-hidden', 'true')

    const text = document.createElement('span')
    text.style.flex = '1'

    row.append(iconSlot, text)
    root.appendChild(row)
    this.root.appendChild(root)

    return { root, iconSlot, text, iconButton: null }
  }

  private applyTooltipLine(line: TooltipLine, entry: TooltipEntry): void {
    if (line.text.textContent !== entry.hoverText) {
      line.text.textContent = entry.hoverText
    }
    this.applyInputIcon(line, entry.button)
  }

  private applyInputIcon(line: TooltipLine, button: InputActionValue): void {
    if (line.iconButton === button) return

    line.iconButton = button
    line.iconSlot.replaceChildren()

    if (button === InputAction.IA_ANY) {
      line.iconSlot.style.display = 'none'
      return
    }

    line.iconSlot.style.display = 'inline-flex'

    const badge = inputActionKeyBadge(button)
    if (badge) {
      line.iconSlot.appendChild(createKeyBadge(badge))
    } else if (button === InputAction.IA_POINTER) {
      line.iconSlot.appendChild(createMouseIcon())
    } else {
      line.iconSlot.style.display = 'none'
    }
  }
}

function createKeyBadge(label: string): HTMLSpanElement {
  const badge = document.createElement('span')
  badge.style.cssText = KEY_BADGE_STYLE
  badge.textContent = label
  return badge
}

function createMouseIcon(): HTMLSpanElement {
  const wrap = document.createElement('span')
  wrap.style.cssText = MOUSE_ICON_STYLE

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '11')
  svg.setAttribute('height', '13')
  svg.setAttribute('viewBox', '0 0 11 13')
  svg.setAttribute('aria-hidden', 'true')

  const body = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  body.setAttribute(
    'd',
    'M5.5 1C3.57 1 2 2.57 2 4.5v4C2 10.43 3.57 12 5.5 12S9 10.43 9 8.5v-4C9 2.57 7.43 1 5.5 1Z'
  )
  body.setAttribute('fill', 'none')
  body.setAttribute('stroke', 'currentColor')
  body.setAttribute('stroke-width', '1.2')

  const wheel = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  wheel.setAttribute('d', 'M5.5 4v2')
  wheel.setAttribute('stroke', 'currentColor')
  wheel.setAttribute('stroke-width', '1.1')
  wheel.setAttribute('stroke-linecap', 'round')

  svg.append(body, wheel)
  wrap.appendChild(svg)
  return wrap
}
