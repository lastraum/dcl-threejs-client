import { SIDEBAR_ICONS } from './shell/ProfileSidebarButton'
import {
  isTabletPlayLayout,
  isTouchPlayLayout,
  subscribeTouchPlayLayout
} from './touchPlayLayout'

const ANALOG_DEADZONE = 0.18

export type MobileGameHudHandlers = {
  onEmote: () => void
  onPrimaryDown: () => void
  onPrimaryUp: () => void
  onSecondaryDown: () => void
  onSecondaryUp: () => void
  onJumpDown: () => void
  onJumpUp: () => void
  onAnalogMove?: (x: number, z: number) => void
  /** Right stick — yaw (x, right+) and pitch (y, down+), each in [-1, 1]. */
  onAnalogLook?: (x: number, y: number) => void
}

type InvisibleStickState = {
  pointerId: number | null
  originX: number
  originY: number
  stick: HTMLDivElement
  knob: HTMLDivElement
}

/** Touch: left move + right look analog sticks; E/F/jump/emotes on top. Phone + iPad. */
export class MobileGameHud {
  private readonly root: HTMLDivElement
  private readonly movePad: HTMLDivElement
  private readonly lookPad: HTMLDivElement
  private readonly unsubLayout: () => void
  private handlers: MobileGameHudHandlers
  private shellVisible = false
  private chatFab: HTMLElement | null = null
  private readonly moveStick: InvisibleStickState
  private readonly lookStick: InvisibleStickState

  constructor(handlers: MobileGameHudHandlers) {
    this.handlers = handlers
    this.root = document.createElement('div')
    this.root.className = 'mobile-game-hud'
    this.root.hidden = true
    this.root.innerHTML = `
      <button type="button" class="mobile-game-hud__btn mobile-game-hud__btn--emote" aria-label="Emotes">
        <span class="mobile-game-hud__icon" aria-hidden="true">${SIDEBAR_ICONS.emotes}</span>
      </button>
      <button type="button" class="mobile-game-hud__btn mobile-game-hud__btn--primary" aria-label="Interact (E)">
        <span class="mobile-game-hud__key">E</span>
      </button>
      <button type="button" class="mobile-game-hud__btn mobile-game-hud__btn--secondary" aria-label="Interact (F)">
        <span class="mobile-game-hud__key">F</span>
      </button>
      <button type="button" class="mobile-game-hud__btn mobile-game-hud__btn--jump" aria-label="Jump">
        <span class="mobile-game-hud__icon mobile-game-hud__icon--jump" aria-hidden="true">↑</span>
      </button>
    `

    this.movePad = this.createPad('touch-move-pad')
    this.lookPad = this.createPad('touch-look-pad')
    this.moveStick = this.attachStick(this.movePad)
    this.lookStick = this.attachStick(this.lookPad)
    this.bindInvisibleStick(this.movePad, this.moveStick, (x, yDown) => {
      this.handlers.onAnalogMove?.(x, -yDown)
    })
    this.bindInvisibleStick(this.lookPad, this.lookStick, (x, yDown) => {
      this.handlers.onAnalogLook?.(x, yDown)
    })

    this.root.querySelector('.mobile-game-hud__btn--emote')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.handlers.onEmote()
    })

    this.bindHoldButton(
      this.root.querySelector('.mobile-game-hud__btn--primary') as HTMLButtonElement,
      () => this.handlers.onPrimaryDown(),
      () => this.handlers.onPrimaryUp()
    )
    this.bindHoldButton(
      this.root.querySelector('.mobile-game-hud__btn--secondary') as HTMLButtonElement,
      () => this.handlers.onSecondaryDown(),
      () => this.handlers.onSecondaryUp()
    )
    this.bindHoldButton(
      this.root.querySelector('.mobile-game-hud__btn--jump') as HTMLButtonElement,
      () => this.handlers.onJumpDown(),
      () => this.handlers.onJumpUp()
    )

    document.body.appendChild(this.movePad)
    document.body.appendChild(this.lookPad)
    document.body.appendChild(this.root)
    this.unsubLayout = subscribeTouchPlayLayout(() => this.syncVisibility())
    this.syncVisibility()
  }

  setHandlers(handlers: MobileGameHudHandlers): void {
    this.handlers = handlers
  }

  /** Park the 3D chat FAB in the right HUD stack (emote → chat → E/F/jump). */
  attachChatFab(fab: HTMLElement): void {
    this.releaseChatFab()
    this.chatFab = fab
    const emote = this.root.querySelector('.mobile-game-hud__btn--emote')
    if (emote?.nextSibling) this.root.insertBefore(fab, emote.nextSibling)
    else this.root.appendChild(fab)
  }

  private releaseChatFab(): void {
    if (!this.chatFab) return
    if (this.chatFab.parentElement === this.root) document.body.appendChild(this.chatFab)
    this.chatFab = null
  }

  setShellVisible(visible: boolean): void {
    this.shellVisible = visible
    this.syncVisibility()
  }

  setEmoteActive(active: boolean): void {
    this.root.querySelector('.mobile-game-hud__btn--emote')?.classList.toggle('is-active', active)
  }

  setEmoteEnabled(enabled: boolean): void {
    const btn = this.root.querySelector('.mobile-game-hud__btn--emote') as HTMLButtonElement | null
    if (!btn) return
    btn.disabled = !enabled
    btn.classList.toggle('is-disabled', !enabled)
    if (!enabled) btn.classList.remove('is-active')
  }

  private syncVisibility(): void {
    const show = isTouchPlayLayout() && this.shellVisible
    this.root.hidden = !show
    this.movePad.hidden = !show
    this.lookPad.hidden = !show
    if (!show) this.releaseSticks()
  }

  private analogMaxRadius(): number {
    return isTabletPlayLayout() ? 72 : 48
  }

  private createPad(className: string): HTMLDivElement {
    const pad = document.createElement('div')
    pad.className = className
    pad.setAttribute('aria-hidden', 'true')
    pad.hidden = true
    return pad
  }

  private attachStick(pad: HTMLDivElement): InvisibleStickState {
    const stick = document.createElement('div')
    stick.className = 'touch-stick'
    const base = document.createElement('div')
    base.className = 'touch-stick__base'
    const knob = document.createElement('div')
    knob.className = 'touch-stick__knob'
    stick.append(base, knob)
    pad.appendChild(stick)
    return { pointerId: null, originX: 0, originY: 0, stick, knob }
  }

  private placeStickAt(pad: HTMLDivElement, state: InvisibleStickState, clientX: number, clientY: number): void {
    const rect = pad.getBoundingClientRect()
    state.stick.style.left = `${clientX - rect.left}px`
    state.stick.style.top = `${clientY - rect.top}px`
    state.stick.style.bottom = 'auto'
    state.stick.style.right = 'auto'
    state.stick.style.transform = 'translate(-50%, -50%)'
    pad.classList.add('is-held')
  }

  private resetStickVisual(pad: HTMLDivElement, state: InvisibleStickState): void {
    pad.classList.remove('is-held')
    state.stick.style.left = ''
    state.stick.style.top = ''
    state.stick.style.bottom = ''
    state.stick.style.right = ''
    state.stick.style.transform = ''
    state.knob.style.transform = ''
  }

  private bindInvisibleStick(
    pad: HTMLDivElement,
    state: InvisibleStickState,
    onAxis: (x: number, yDown: number) => void
  ): void {
    pad.addEventListener('contextmenu', (ev) => ev.preventDefault())
    pad.addEventListener('touchstart', (ev) => ev.preventDefault(), { passive: false })
    pad.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 && ev.pointerType === 'mouse') return
      if (state.pointerId != null) return
      ev.preventDefault()
      ev.stopPropagation()
      state.pointerId = ev.pointerId
      state.originX = ev.clientX
      state.originY = ev.clientY
      this.placeStickAt(pad, state, ev.clientX, ev.clientY)
      try {
        pad.setPointerCapture(ev.pointerId)
      } catch {
        /* unsupported */
      }
      this.applyStick(state, ev.clientX, ev.clientY, onAxis)
    })
    pad.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== state.pointerId) return
      this.applyStick(state, ev.clientX, ev.clientY, onAxis)
    })
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== state.pointerId) return
      this.releaseStick(pad, state, onAxis)
    }
    pad.addEventListener('pointerup', up)
    pad.addEventListener('pointercancel', up)
  }

  private applyStick(
    state: InvisibleStickState,
    clientX: number,
    clientY: number,
    onAxis: (x: number, yDown: number) => void
  ): void {
    const maxR = this.analogMaxRadius()
    const dx = clientX - state.originX
    const dy = clientY - state.originY
    const dist = Math.hypot(dx, dy)
    if (dist > 0) {
      const usedDist = Math.min(dist, maxR)
      state.knob.style.transform = `translate(${(dx / dist) * usedDist}px, ${(dy / dist) * usedDist}px)`
    } else {
      state.knob.style.transform = ''
    }
    if (dist < ANALOG_DEADZONE * maxR) {
      onAxis(0, 0)
      return
    }
    let x = dx / maxR
    let yDown = dy / maxR
    const mag = dist / maxR
    if (mag > 1) {
      x /= mag
      yDown /= mag
    }
    const used = (Math.min(mag, 1) - ANALOG_DEADZONE) / (1 - ANALOG_DEADZONE)
    const scale = used / Math.min(mag, 1)
    onAxis(x * scale, yDown * scale)
  }

  private releaseStick(
    pad: HTMLDivElement,
    state: InvisibleStickState,
    onAxis: (x: number, yDown: number) => void
  ): void {
    if (state.pointerId != null) {
      try {
        pad.releasePointerCapture(state.pointerId)
      } catch {
        /* ignore */
      }
    }
    state.pointerId = null
    this.resetStickVisual(pad, state)
    onAxis(0, 0)
  }

  private releaseSticks(): void {
    this.releaseStick(this.movePad, this.moveStick, (x, yDown) => {
      this.handlers.onAnalogMove?.(x, -yDown)
    })
    this.releaseStick(this.lookPad, this.lookStick, (x, yDown) => {
      this.handlers.onAnalogLook?.(x, yDown)
    })
  }

  private bindHoldButton(btn: HTMLButtonElement, onDown: () => void, onUp: () => void): void {
    const release = (): void => {
      onUp()
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
    btn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      onDown()
      window.addEventListener('pointerup', release)
      window.addEventListener('pointercancel', release)
    })
  }

  dispose(): void {
    this.releaseSticks()
    this.releaseChatFab()
    this.unsubLayout()
    this.movePad.remove()
    this.lookPad.remove()
    this.root.remove()
  }
}
