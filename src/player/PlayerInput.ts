/** Keyboard + pointer-lock input for DCL-style third-person camera. */
export class PlayerInput {
  readonly keys = { w: false, a: false, s: false, d: false, space: false, shift: false, ctrl: false }
  readonly pointer = { locked: false, dx: 0, dy: 0 }
  scrollDelta = 0
  spacePressed = false
  /** Left-button drag orbit — does not change pointer lock. */
  orbiting = false
  private userGestureUnlocked = false
  private onUserGestureUnlock: (() => void) | null = null

  constructor(private readonly canvas: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    document.addEventListener('focusin', this.onFocusIn)
    document.addEventListener('pointerlockchange', this.onLockChange)
    document.addEventListener('mousemove', this.onMouseMove)
    this.canvas.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mouseup', this.onMouseUp)
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    document.removeEventListener('focusin', this.onFocusIn)
    document.removeEventListener('pointerlockchange', this.onLockChange)
    document.removeEventListener('mousemove', this.onMouseMove)
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mouseup', this.onMouseUp)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.canvas.removeEventListener('wheel', this.onWheel)
    if (document.pointerLockElement === this.canvas) document.exitPointerLock()
  }

  endFrame(): void {
    this.pointer.dx = 0
    this.pointer.dy = 0
    this.scrollDelta = 0
    this.spacePressed = false
  }

  get looking(): boolean {
    return this.pointer.locked || this.orbiting
  }

  setOnUserGestureUnlock(callback: () => void): void {
    this.onUserGestureUnlock = callback
    if (this.userGestureUnlocked) callback()
  }

  private notifyUserGesture(): void {
    if (this.userGestureUnlocked) return
    this.userGestureUnlocked = true
    this.onUserGestureUnlock?.()
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.isTypingTarget() || this.isOverlayOpen()) return

    if (this.setMoveKey(e.code, true)) e.preventDefault()

    if (e.code === 'Space') {
      if (!this.keys.space) this.spacePressed = true
      this.keys.space = true
      e.preventDefault()
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.keys.shift = true
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
      this.keys.ctrl = true
      e.preventDefault()
    }

    if (e.code === 'Tab') {
      e.preventDefault()
      this.togglePointerLock()
    }
    if (e.code === 'Escape' && this.pointer.locked) {
      document.exitPointerLock()
      this.orbiting = false
    }
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.setMoveKey(e.code, false)
    if (e.code === 'Space') this.keys.space = false
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.keys.shift = false
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') this.keys.ctrl = false
  }

  private onLockChange = () => {
    this.pointer.locked = document.pointerLockElement === this.canvas
    this.canvas.style.cursor = this.pointer.locked ? 'none' : 'default'
    if (this.pointer.locked) this.notifyUserGesture()
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.looking) return
    this.pointer.dx += e.movementX
    this.pointer.dy += e.movementY
  }

  private onMouseDown = (e: MouseEvent) => {
    if (this.isOverlayOpen()) return
    if (e.button === 0) {
      this.notifyUserGesture()
      // Orbit drag only when unlocked — pointer lock uses movementX, not LMB hold.
      if (!this.pointer.locked) this.orbiting = true
      return
    }
    if (e.button === 2) {
      e.preventDefault()
      this.togglePointerLock()
    }
  }

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.orbiting = false
  }

  private onContextMenu = (e: Event) => {
    e.preventDefault()
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.scrollDelta += e.deltaY
  }

  private onFocusIn = (): void => {
    if (this.isTypingTarget()) this.clearMovementKeys()
  }

  private isTypingTarget(): boolean {
    const el = document.activeElement
    if (!el || el === this.canvas) return false
    if (el instanceof HTMLInputElement) {
      const type = el.type.toLowerCase()
      return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'reset'
    }
    if (el instanceof HTMLTextAreaElement) return true
    if (el instanceof HTMLElement && el.isContentEditable) return true
    return false
  }

  private isOverlayOpen(): boolean {
    return document.querySelector('.settings-overlay.is-open') !== null
  }

  private clearMovementKeys(): void {
    this.keys.w = false
    this.keys.a = false
    this.keys.s = false
    this.keys.d = false
    this.keys.space = false
    this.keys.shift = false
    this.keys.ctrl = false
    this.spacePressed = false
  }

  /** WASD + arrow keys → movement vector. Returns true if code is a move key. */
  private setMoveKey(code: string, down: boolean): boolean {
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        this.keys.w = down
        return true
      case 'KeyS':
      case 'ArrowDown':
        this.keys.s = down
        return true
      case 'KeyA':
      case 'ArrowLeft':
        this.keys.a = down
        return true
      case 'KeyD':
      case 'ArrowRight':
        this.keys.d = down
        return true
      default:
        return false
    }
  }

  private togglePointerLock(): void {
    this.orbiting = false
    if (this.pointer.locked) document.exitPointerLock()
    else this.canvas.requestPointerLock()
  }
}
