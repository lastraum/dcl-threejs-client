const JOYSTICK_ZONE_WIDTH = 0.48
const LOOK_ZONE_START = 0.48
const MAX_RADIUS_PX = 80
const DEAD_ZONE_PX = 10

const UI_BLOCK_SELECTOR =
  '.mobile-hud, .mobile-hud *, .preferences-panel, .preferences-panel *, .chat-panel-wrap, .chat-panel-wrap *, .settings-overlay, .settings-overlay *, .splash-screen, .splash-screen *, .loading-screen, .loading-screen *'

function isBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest(UI_BLOCK_SELECTOR)
}

/**
 * Invisible touch joystick (left) + drag-to-look (right) for mobile portrait.
 * Joystick output is camera-relative: x = strafe, z = forward (matches WASD in PlayerSystem).
 */
export class TouchControls {
  readonly move = { x: 0, z: 0 }
  readonly look = { dx: 0, dy: 0 }

  private enabled = false
  private joystickTouchId: number | null = null
  private lookTouchId: number | null = null
  private joystickOriginX = 0
  private joystickOriginY = 0
  private lookLastX = 0
  private lookLastY = 0

  constructor(private readonly canvas: HTMLElement) {}

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      this.canvas.addEventListener('touchstart', this.onTouchStart, { passive: false })
      this.canvas.addEventListener('touchmove', this.onTouchMove, { passive: false })
      this.canvas.addEventListener('touchend', this.onTouchEnd, { passive: true })
      this.canvas.addEventListener('touchcancel', this.onTouchEnd, { passive: true })
    } else {
      this.canvas.removeEventListener('touchstart', this.onTouchStart)
      this.canvas.removeEventListener('touchmove', this.onTouchMove)
      this.canvas.removeEventListener('touchend', this.onTouchEnd)
      this.canvas.removeEventListener('touchcancel', this.onTouchEnd)
      this.reset()
    }
  }

  get isLooking(): boolean {
    return this.lookTouchId !== null
  }

  endFrame(): void {
    this.look.dx = 0
    this.look.dy = 0
  }

  dispose(): void {
    this.setEnabled(false)
  }

  private reset(): void {
    this.joystickTouchId = null
    this.lookTouchId = null
    this.move.x = 0
    this.move.z = 0
    this.look.dx = 0
    this.look.dy = 0
  }

  private normX(clientX: number): number {
    return clientX / Math.max(1, window.innerWidth)
  }

  private updateJoystick(clientX: number, clientY: number): void {
    const dx = clientX - this.joystickOriginX
    const dy = clientY - this.joystickOriginY
    const dist = Math.hypot(dx, dy)
    if (dist < DEAD_ZONE_PX) {
      this.move.x = 0
      this.move.z = 0
      return
    }
    const clamped = Math.min(dist, MAX_RADIUS_PX)
    const nx = dx / clamped
    const ny = dy / clamped
    const mag = Math.min(1, dist / MAX_RADIUS_PX)
    this.move.x = nx * mag
    // Screen Y down = drag down = backward in world (invert for forward).
    this.move.z = -ny * mag
  }

  private onTouchStart = (e: TouchEvent): void => {
    if (!this.enabled) return
    for (const touch of Array.from(e.changedTouches)) {
      if (isBlockedTarget(touch.target)) continue
      const x = this.normX(touch.clientX)
      if (x < JOYSTICK_ZONE_WIDTH && this.joystickTouchId === null) {
        this.joystickTouchId = touch.identifier
        this.joystickOriginX = touch.clientX
        this.joystickOriginY = touch.clientY
        this.updateJoystick(touch.clientX, touch.clientY)
        e.preventDefault()
      } else if (x >= LOOK_ZONE_START && this.lookTouchId === null) {
        this.lookTouchId = touch.identifier
        this.lookLastX = touch.clientX
        this.lookLastY = touch.clientY
        e.preventDefault()
      }
    }
  }

  private onTouchMove = (e: TouchEvent): void => {
    if (!this.enabled) return
    for (const touch of Array.from(e.changedTouches)) {
      if (touch.identifier === this.joystickTouchId) {
        this.updateJoystick(touch.clientX, touch.clientY)
        e.preventDefault()
      } else if (touch.identifier === this.lookTouchId) {
        const dx = touch.clientX - this.lookLastX
        const dy = touch.clientY - this.lookLastY
        this.lookLastX = touch.clientX
        this.lookLastY = touch.clientY
        this.look.dx += dx
        this.look.dy += dy
        e.preventDefault()
      }
    }
  }

  private onTouchEnd = (e: TouchEvent): void => {
    for (const touch of Array.from(e.changedTouches)) {
      if (touch.identifier === this.joystickTouchId) {
        this.joystickTouchId = null
        this.move.x = 0
        this.move.z = 0
      }
      if (touch.identifier === this.lookTouchId) {
        this.lookTouchId = null
      }
    }
  }
}