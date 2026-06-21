/** Keyboard + pointer-lock input for DCL-style third-person camera. */
export class PlayerInput {
  readonly keys = { w: false, a: false, s: false, d: false, space: false, shift: false, ctrl: false }
  readonly pointer = { locked: false, dx: 0, dy: 0 }
  scrollDelta = 0
  pinchZoomDelta = 0
  spacePressed = false
  /** Left-button drag orbit — does not change pointer lock. */
  orbiting = false
  private userGestureUnlocked = false
  private onUserGestureUnlock: (() => void) | null = null
  private orbitPointerId: number | null = null
  private lastPointerX = 0
  private lastPointerY = 0
  private readonly activePointers = new Map<number, { x: number; y: number }>()
  private lastPinchSpan = 0

  constructor(private readonly canvas: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    document.addEventListener('focusin', this.onFocusIn)
    document.addEventListener('pointerlockchange', this.onLockChange)
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    document.removeEventListener('focusin', this.onFocusIn)
    document.removeEventListener('pointerlockchange', this.onLockChange)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.canvas.removeEventListener('wheel', this.onWheel)
    if (document.pointerLockElement === this.canvas) document.exitPointerLock()
  }

  endFrame(): void {
    this.pointer.dx = 0
    this.pointer.dy = 0
    this.scrollDelta = 0
    this.pinchZoomDelta = 0
    this.spacePressed = false
  }

  setJumpHeld(down: boolean): void {
    this.keys.space = down
    if (down) this.spacePressed = true
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
      this.stopOrbit()
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
    if (this.pointer.locked) {
      this.stopOrbit()
      this.notifyUserGesture()
    }
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }

    if (this.activePointers.size >= 2) {
      this.applyPinchZoom()
      return
    }

    if (!this.looking) return
    if (this.pointer.locked) {
      this.pointer.dx += e.movementX
      this.pointer.dy += e.movementY
      return
    }
    if (!this.orbiting || e.pointerId !== this.orbitPointerId) return
    const dx = e.clientX - this.lastPointerX
    const dy = e.clientY - this.lastPointerY
    this.lastPointerX = e.clientX
    this.lastPointerY = e.clientY
    this.pointer.dx += dx
    this.pointer.dy += dy
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.target !== this.canvas) return
    if (this.isOverlayOpen()) return

    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (this.activePointers.size >= 2) {
      this.stopOrbit()
      this.lastPinchSpan = this.pointerSpan()
      return
    }

    if (e.button === 0) {
      this.notifyUserGesture()
      if (!this.pointer.locked) {
        this.orbiting = true
        this.orbitPointerId = e.pointerId
        this.lastPointerX = e.clientX
        this.lastPointerY = e.clientY
        try {
          this.canvas.setPointerCapture(e.pointerId)
        } catch {
          // ignore capture failures on unsupported browsers
        }
      }
      return
    }
    if (e.button === 2) {
      e.preventDefault()
      this.togglePointerLock()
    }
  }

  private onPointerUp = (e: PointerEvent) => {
    this.activePointers.delete(e.pointerId)
    if (this.activePointers.size < 2) this.lastPinchSpan = 0
    if (e.pointerId !== this.orbitPointerId) return
    this.stopOrbit()
  }

  private pointerSpan(): number {
    const pts = [...this.activePointers.values()]
    if (pts.length < 2) return 0
    return Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y)
  }

  private applyPinchZoom(): void {
    const span = this.pointerSpan()
    if (span <= 0 || this.lastPinchSpan <= 0) {
      this.lastPinchSpan = span
      return
    }
    this.pinchZoomDelta += span - this.lastPinchSpan
    this.lastPinchSpan = span
  }

  private stopOrbit(): void {
    const pointerId = this.orbitPointerId
    this.orbiting = false
    this.orbitPointerId = null
    if (pointerId === null) return
    try {
      this.canvas.releasePointerCapture(pointerId)
    } catch {
      // ignore
    }
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
    this.stopOrbit()
    if (this.pointer.locked) document.exitPointerLock()
    else this.canvas.requestPointerLock()
  }
}