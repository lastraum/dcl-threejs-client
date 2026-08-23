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
}

/** Touch: invisible left stick + E/F/jump/emotes on the right. Phone + iPad. */
export class MobileGameHud {
  private readonly root: HTMLDivElement
  private readonly movePad: HTMLDivElement
  private readonly unsubLayout: () => void
  private handlers: MobileGameHudHandlers
  private shellVisible = false
  private analogPointerId: number | null = null
  private analogOriginX = 0
  private analogOriginY = 0

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

    this.movePad = document.createElement('div')
    this.movePad.className = 'touch-move-pad'
    this.movePad.setAttribute('aria-hidden', 'true')
    this.movePad.hidden = true
    this.bindMovePad()

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
    document.body.appendChild(this.root)
    this.unsubLayout = subscribeTouchPlayLayout(() => this.syncVisibility())
    this.syncVisibility()
  }

  setHandlers(handlers: MobileGameHudHandlers): void {
    this.handlers = handlers
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
    if (!show) this.releaseAnalog()
  }

  private analogMaxRadius(): number {
    return isTabletPlayLayout() ? 88 : 56
  }

  private bindMovePad(): void {
    this.movePad.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 && ev.pointerType === 'mouse') return
      if (this.analogPointerId != null) return
      ev.preventDefault()
      ev.stopPropagation()
      this.analogPointerId = ev.pointerId
      this.analogOriginX = ev.clientX
      this.analogOriginY = ev.clientY
      try {
        this.movePad.setPointerCapture(ev.pointerId)
      } catch {
        /* unsupported */
      }
      this.applyAnalog(ev.clientX, ev.clientY)
    })
    this.movePad.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== this.analogPointerId) return
      this.applyAnalog(ev.clientX, ev.clientY)
    })
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== this.analogPointerId) return
      this.releaseAnalog()
    }
    this.movePad.addEventListener('pointerup', up)
    this.movePad.addEventListener('pointercancel', up)
  }

  private applyAnalog(clientX: number, clientY: number): void {
    const maxR = this.analogMaxRadius()
    const dx = clientX - this.analogOriginX
    const dy = clientY - this.analogOriginY
    let x = dx / maxR
    let z = -dy / maxR
    const mag = Math.hypot(x, z)
    if (mag < ANALOG_DEADZONE) {
      this.handlers.onAnalogMove?.(0, 0)
      return
    }
    if (mag > 1) {
      x /= mag
      z /= mag
    }
    const used = (Math.min(mag, 1) - ANALOG_DEADZONE) / (1 - ANALOG_DEADZONE)
    const scale = used / Math.min(mag, 1)
    this.handlers.onAnalogMove?.(x * scale, z * scale)
  }

  private releaseAnalog(): void {
    if (this.analogPointerId != null) {
      try {
        this.movePad.releasePointerCapture(this.analogPointerId)
      } catch {
        /* ignore */
      }
    }
    this.analogPointerId = null
    this.handlers.onAnalogMove?.(0, 0)
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
    this.releaseAnalog()
    this.unsubLayout()
    this.movePad.remove()
    this.root.remove()
  }
}
