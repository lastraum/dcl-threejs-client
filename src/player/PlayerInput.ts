import {
  isClientOverlayTarget,
  tryOpenPeerContextMenu,
  tryOpenPeerContextMenuFromPillRect
} from '../client/ui/overlayHitTest'
import { PointerLockReticle } from '../client/ui/PointerLockReticle'
import { isTextInputFocused } from '../client/ui/textInputFocus'
import { keybinds } from '../input/keybinds'
import { clearPointerLockAim } from '../input/pointerLockAim'
import type { SceneKeyboardSnapshot } from '../input/SceneInputRelay'
import { isPointerOverSceneUi, isSceneUiInteractiveTarget } from '../ui/scene/sceneUiOverlay'
import { isSceneUiTypingFocus } from '../ui/scene/sceneUiTyping'

/** Keyboard + pointer-lock input for DCL-style third-person camera. */
export class PlayerInput {
  readonly keys = { w: false, a: false, s: false, d: false, space: false, shift: false, ctrl: false }
  readonly actionKeys = { digit1: false, digit2: false, digit3: false, digit4: false }
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
  private isLocomotionBlocked: () => boolean = () => false
  /** Scene VirtualCamera owns MainCamera — block freecam orbit / pointer-lock look. */
  private isLookBlocked: () => boolean = () => false
  private readonly reticle: PointerLockReticle

  constructor(private readonly canvas: HTMLElement) {
    this.reticle = new PointerLockReticle(canvas)
    // Capture phase so chat/text focus beats locomotion before bubble handlers run.
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    document.addEventListener('focusin', this.onFocusIn, true)
    window.addEventListener('blur', this.onWindowBlur)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('focus', this.onWindowFocus)
    document.addEventListener('pointerlockchange', this.onLockChange)
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    // Sync if lock already active (rare).
    this.onLockChange()
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    document.removeEventListener('focusin', this.onFocusIn, true)
    window.removeEventListener('blur', this.onWindowBlur)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('focus', this.onWindowFocus)
    document.removeEventListener('pointerlockchange', this.onLockChange)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.reticle.dispose()
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
    // Edge only — holding must not re-fire spacePressed every frame (glide vs double-jump).
    if (down && !this.keys.space) this.spacePressed = true
    this.keys.space = down
  }

  get looking(): boolean {
    if (this.isLookBlocked()) return false
    return this.pointer.locked || this.orbiting
  }

  /** Snapshot for SceneInputRelay — scene worker inputSystem; separate from avatar InputModifier. */
  getSceneKeyboardSnapshot(): SceneKeyboardSnapshot {
    return {
      forward: this.keys.w,
      backward: this.keys.s,
      left: this.keys.a,
      right: this.keys.d,
      jump: this.keys.space,
      ctrl: this.keys.ctrl,
      action3: this.actionKeys.digit1,
      action4: this.actionKeys.digit2,
      action5: this.actionKeys.digit3,
      action6: this.actionKeys.digit4
    }
  }

  /** Main projection InputModifier — block avatar WASD/jump when scene disables locomotion. */
  setLocomotionBlocked(fn: () => boolean): void {
    this.isLocomotionBlocked = fn
  }

  /** Block freecam orbit + pointer-lock look while a scene VirtualCamera drives MainCamera. */
  setLookBlocked(fn: () => boolean): void {
    this.isLookBlocked = fn
  }

  /** Cancel in-progress LMB orbit (call when VC binds mid-drag). */
  stopOrbitIfActive(): void {
    if (this.orbiting) this.stopOrbit()
  }

  /**
   * Block scene WASD relay while typing in any text field (client chat dock, scene UI, etc.)
   * or when a full-screen overlay is open. Highest priority over locomotion.
   */
  isSceneRelayBlocked(): boolean {
    if (this.isOverlayOpen()) return true
    if (isTextInputFocused()) return true
    return isSceneUiTypingFocus()
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
    if (this.isLocomotionBlocked() && this.isMoveKeyCode(e.code)) return

    let handled = false
    if (this.setMoveKey(e.code, true)) handled = true
    if (this.setBoundKey(e.code, true)) handled = true
    if (handled) e.preventDefault()

    if (e.code === 'Tab') {
      e.preventDefault()
      if (!this.isLookBlocked()) this.togglePointerLock()
    }
    if (e.code === 'Escape' && this.pointer.locked) {
      document.exitPointerLock()
      this.stopOrbit()
    }
  }

  private onKeyUp = (e: KeyboardEvent) => {
    // Always release — keyup is often lost when focus moves to chat/settings or another tab.
    // Ignoring keyup while typing left WASD stuck until a full page reload.
    this.setMoveKey(e.code, false)
    this.setBoundKey(e.code, false)
  }

  private onWindowBlur = (): void => {
    this.clearMovementKeys()
    this.stopOrbit()
  }

  private onVisibilityChange = (): void => {
    // Hidden: browser often skips keyup. Visible: sanitize after resume (keys may be stale).
    this.clearMovementKeys()
    this.stopOrbit()
  }

  private onWindowFocus = (): void => {
    // Tab return — force clean slate so the next physical keydown re-arms locomotion.
    this.clearMovementKeys()
  }

  private onLockChange = () => {
    this.pointer.locked = document.pointerLockElement === this.canvas
    this.canvas.style.cursor = this.pointer.locked ? 'none' : 'default'
    this.reticle.setVisible(this.pointer.locked)
    if (this.pointer.locked) {
      this.stopOrbit()
      this.notifyUserGesture()
    } else {
      clearPointerLockAim()
    }
  }

  /** Keep reticle on the projected aim point (above avatar) while locked. */
  syncReticleLayout(): void {
    if (this.pointer.locked) this.reticle.syncLayout()
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

  /** Release orbit drag / pointer lock — e.g. before profile context menus open. */
  cancelCameraPointer(): void {
    this.stopOrbit()
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock()
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    if (isClientOverlayTarget(e.target)) return
    if (isSceneUiInteractiveTarget(e.target) || isPointerOverSceneUi(e.clientX, e.clientY)) return
    if (e.target !== this.canvas) return
    if (this.isOverlayOpen()) return

    // Clicking the world should reclaim keyboard from chat/composer so WASD works again.
    if (this.isTypingTarget()) {
      const active = document.activeElement
      if (active instanceof HTMLElement) active.blur()
      this.clearMovementKeys()
    }

    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (this.activePointers.size >= 2) {
      this.stopOrbit()
      this.lastPinchSpan = this.pointerSpan()
      return
    }

    if (e.button === 0) {
      this.notifyUserGesture()
      // Left-click drag orbit only when unlocked. In pointer lock, movement alone orbits.
      if (this.pointer.locked) return
      // Clicking the pill (or its Options hint) is a UI action — orbiting instead
      // rotates the avatar out from under the cursor and drops the hover.
      if (tryOpenPeerContextMenuFromPillRect(e.clientX, e.clientY)) {
        e.preventDefault()
        return
      }
      if (this.isLookBlocked()) return
      this.orbiting = true
      this.orbitPointerId = e.pointerId
      this.lastPointerX = e.clientX
      this.lastPointerY = e.clientY
      try {
        this.canvas.setPointerCapture(e.pointerId)
      } catch {
        // ignore capture failures on unsupported browsers
      }
      return
    }
    if (e.button === 2) {
      e.preventDefault()
      this.notifyUserGesture()
      // Peer options win over camera look while the cursor is free: entering
      // pointer lock re-aims at screen center, losing the pill we clicked on.
      // While already locked, right-click keeps its unlock role.
      if (!this.pointer.locked && tryOpenPeerContextMenu(e.clientX, e.clientY)) return
      // Right-click toggles pointer lock (look without holding a button).
      // Scene VC owns the lens — do not enter freecam look.
      if (this.isLookBlocked()) return
      this.togglePointerLock()
      return
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
    if (isPointerOverSceneUi(e.clientX, e.clientY)) return
    e.preventDefault()
    this.scrollDelta += e.deltaY
  }

  private onFocusIn = (): void => {
    if (this.isTypingTarget()) this.clearMovementKeys()
  }

  private isTypingTarget(): boolean {
    if (isTextInputFocused()) return true
    if (isSceneUiTypingFocus()) return true
    return false
  }

  private isOverlayOpen(): boolean {
    return (
      document.querySelector('.settings-overlay.is-open') !== null ||
      document.querySelector('.preferences-panel.is-open') !== null ||
      document.querySelector('.explorer-auth-panel:not([hidden])') !== null ||
      // RestrictedActions openExternalUrl / openNftDialog — block re-lock while faded dialog is up
      document.getElementById('threejs-hud-confirm-overlay') !== null ||
      document.getElementById('threejs-external-link-overlay') !== null ||
      document.getElementById('threejs-nft-dialog-overlay') !== null
    )
  }

  clearMovementKeys(): void {
    this.keys.w = false
    this.keys.a = false
    this.keys.s = false
    this.keys.d = false
    this.keys.space = false
    this.keys.shift = false
    this.keys.ctrl = false
    this.actionKeys.digit1 = false
    this.actionKeys.digit2 = false
    this.actionKeys.digit3 = false
    this.actionKeys.digit4 = false
    this.spacePressed = false
  }

  private isMoveKeyCode(code: string): boolean {
    const id = keybinds.bindIdForCode(code)
    return id === 'forward' || id === 'backward' || id === 'left' || id === 'right'
  }

  /** Keybind-driven move axes → internal wasd flags (names kept for PlayerSystem). */
  private setMoveKey(code: string, down: boolean): boolean {
    const id = keybinds.bindIdForCode(code)
    switch (id) {
      case 'forward':
        this.keys.w = down
        return true
      case 'backward':
        this.keys.s = down
        return true
      case 'left':
        this.keys.a = down
        return true
      case 'right':
        this.keys.d = down
        return true
      default:
        return false
    }
  }

  /** Jump / walk / sprint / action hotkeys from keybind store. */
  private setBoundKey(code: string, down: boolean): boolean {
    const id = keybinds.bindIdForCode(code)
    switch (id) {
      case 'jump':
        if (down && !this.keys.space) this.spacePressed = true
        this.keys.space = down
        return true
      case 'walk':
        this.keys.ctrl = down
        return true
      case 'modifier':
        this.keys.shift = down
        return true
      case 'action3':
        this.actionKeys.digit1 = down
        return true
      case 'action4':
        this.actionKeys.digit2 = down
        return true
      case 'action5':
        this.actionKeys.digit3 = down
        return true
      case 'action6':
        this.actionKeys.digit4 = down
        return true
      default:
        return false
    }
  }

  private togglePointerLock(): void {
    this.stopOrbit()
    if (this.pointer.locked) {
      document.exitPointerLock()
      return
    }
    // Canvas may be detached / in a non-lockable document after World rebuild
    // or when the click originated from a different browsing context.
    try {
      if (!this.canvas.isConnected) return
      const req = this.canvas.requestPointerLock()
      // Spec returns Promise in modern browsers.
      void Promise.resolve(req).catch(() => {
        /* WrongDocumentError / NotAllowedError — ignore */
      })
    } catch {
      /* WrongDocumentError: root document not valid for pointer lock */
    }
  }
}