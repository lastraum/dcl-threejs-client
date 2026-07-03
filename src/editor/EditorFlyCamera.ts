import * as THREE from 'three'
import type { SceneWorldBounds } from '../player/SceneBounds'

const ORBIT_SPEED = 0.005
/** Keyboard yaw — ~1.6 rad/s, scaled to match right-drag orbit feel. */
const YAW_SPEED = ORBIT_SPEED * 320
const WHEEL_DOLLY = 0.28 * 0.8
/** One scroll-notch equivalent for zoom +/- buttons. */
const ZOOM_BUTTON_WHEEL_DELTA = 100
const MOVE_SPEED = 42
const FAST_MULT = 3
const MIN_PITCH = 0.12
const MAX_PITCH = Math.PI / 2 - 0.08

function isTypingInField(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable
}

/**
 * Genesis MapBuilderCamera — drives an existing scene camera (WASD, Space/Shift height, Q/E yaw, right-drag orbit, wheel).
 */
export class EditorFlyCamera {
  private yaw = Math.PI
  private pitch = 0.45
  private readonly pos = new THREE.Vector3()
  private readonly look = new THREE.Vector3()
  private dragging = false
  private lastX = 0
  private lastY = 0
  private readonly keys = new Set<string>()
  private enabled = true
  private defaultBounds: SceneWorldBounds | null = null
  private defaultCenterY = 0
  private readonly removeListeners: Array<() => void> = []

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement
  ) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())

    const onMouseDown = (e: MouseEvent) => {
      if (!this.enabled || e.button !== 2) return
      this.dragging = true
      this.lastX = e.clientX
      this.lastY = e.clientY
    }
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 2) this.dragging = false
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!this.enabled || !this.dragging) return
      const dx = e.clientX - this.lastX
      const dy = e.clientY - this.lastY
      this.lastX = e.clientX
      this.lastY = e.clientY
      this.yaw -= dx * ORBIT_SPEED * 2
      this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch + dy * ORBIT_SPEED * 2))
      this.syncCamera()
    }
    const onWheel = (e: WheelEvent) => {
      if (!this.enabled) return
      e.preventDefault()
      this.dollyByWheelDelta(e.deltaY)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || isTypingInField()) return
      this.keys.add(e.code)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.code)
      if (
        e.code === 'MetaLeft' ||
        e.code === 'MetaRight' ||
        e.code === 'ControlLeft' ||
        e.code === 'ControlRight'
      ) {
        this.keys.clear()
      }
    }
    const onBlur = () => this.keys.clear()

    canvas.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    this.removeListeners.push(
      () => canvas.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => window.removeEventListener('mousemove', onMouseMove),
      () => canvas.removeEventListener('wheel', onWheel),
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur)
    )
  }

  dispose(): void {
    for (const remove of this.removeListeners) remove()
    this.removeListeners.length = 0
    this.keys.clear()
    this.dragging = false
  }

  focusSceneCenter(centerX: number, centerY: number, centerZ: number): void {
    const half = 8
    this.focusSouthFacingNorth(
      { minX: centerX - half, maxX: centerX + half, minZ: centerZ - half, maxZ: centerZ + half },
      centerY
    )
  }

  /** Min camera.far so the south-facing overview keeps the full footprint in frustum. */
  static overviewFarPlaneM(bounds: SceneWorldBounds, fovDeg: number): number {
    const widthM = bounds.maxX - bounds.minX
    const depthM = bounds.maxZ - bounds.minZ
    const span = Math.max(widthM, depthM)
    const large = span > 320
    const standoffScale = large ? 0.58 : 1.65
    const heightFactor = large ? 0.4 : 1.15
    const vFovRad = (fovDeg * Math.PI) / 180
    const distForHeight = (span * 1.08) / (2 * Math.tan(vFovRad / 2))
    const standoff = distForHeight * standoffScale
    const height = Math.max(90, span * heightFactor)
    const lookDist = standoff + depthM * 0.55
    const eyeToCenter = Math.hypot(lookDist, height)
    return Math.max(800, eyeToCenter * 1.35, span * 2.5)
  }

  /** South of parcel footprint, looking north (+Z) with full scene in frame. */
  focusSouthFacingNorth(bounds: SceneWorldBounds, centerY: number): void {
    const centerX = (bounds.minX + bounds.maxX) / 2
    const widthM = bounds.maxX - bounds.minX
    const depthM = bounds.maxZ - bounds.minZ
    const span = Math.max(widthM, depthM)
    const vFovRad = (this.camera.fov * Math.PI) / 180
    const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * this.camera.aspect)
    const large = span > 320
    const standoffScale = large ? 0.58 : 1.65
    const heightFactor = large ? 0.4 : 1.15
    const distForHeight = (span * 1.08) / (2 * Math.tan(vFovRad / 2))
    const distForWidth = (widthM * 1.08) / (2 * Math.tan(hFovRad / 2))
    const standoff = Math.max(distForHeight, distForWidth) * standoffScale
    const height = Math.max(90, span * heightFactor)
    this.pos.set(centerX, centerY + height, bounds.minZ - standoff)
    this.yaw = 0
    const lookDist = standoff + depthM * 0.55
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, Math.atan(height / lookDist)))
    this.defaultBounds = { ...bounds }
    this.defaultCenterY = centerY
    this.syncCamera()
  }

  /** Restore the initial south-facing overview (position + zoom). */
  resetView(): void {
    if (!this.defaultBounds) return
    this.focusSouthFacingNorth(this.defaultBounds, this.defaultCenterY)
  }

  zoomIn(): void {
    if (!this.enabled) return
    this.dollyByWheelDelta(-ZOOM_BUTTON_WHEEL_DELTA)
  }

  zoomOut(): void {
    if (!this.enabled) return
    this.dollyByWheelDelta(ZOOM_BUTTON_WHEEL_DELTA)
  }

  update(deltaS: number): void {
    if (!this.enabled) return
    const fast = this.keys.has('AltLeft') || this.keys.has('AltRight')
    const speed = MOVE_SPEED * (fast ? FAST_MULT : 1) * Math.max(1, this.pos.y / 40) * deltaS
    const fwdX = Math.sin(this.yaw)
    const fwdZ = Math.cos(this.yaw)
    const rightX = -Math.cos(this.yaw)
    const rightZ = Math.sin(this.yaw)
    if (this.keys.has('KeyW')) {
      this.pos.x += fwdX * speed
      this.pos.z += fwdZ * speed
    }
    if (this.keys.has('KeyS')) {
      this.pos.x -= fwdX * speed
      this.pos.z -= fwdZ * speed
    }
    if (this.keys.has('KeyA')) {
      this.pos.x -= rightX * speed
      this.pos.z -= rightZ * speed
    }
    if (this.keys.has('KeyD')) {
      this.pos.x += rightX * speed
      this.pos.z += rightZ * speed
    }
    if (this.keys.has('Space')) this.pos.y += speed
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) this.pos.y -= speed
    const yawSpeed = YAW_SPEED * (fast ? FAST_MULT : 1) * deltaS
    if (this.keys.has('KeyQ')) this.yaw += yawSpeed
    if (this.keys.has('KeyE')) this.yaw -= yawSpeed
    this.syncCamera()
  }

  onResize(w: number, h: number): void {
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.dragging = false
      this.keys.clear()
    }
  }

  /** Horizontal orbit angle (radians) — for viewport compass. */
  getYaw(): number {
    return this.yaw
  }

  private dollyByWheelDelta(wheelDeltaY: number): void {
    const dir = this.lookDir(this.look)
    const alt = Math.max(1, this.pos.y / 50)
    this.pos.addScaledVector(dir, -wheelDeltaY * WHEEL_DOLLY * alt)
    this.syncCamera()
  }

  private lookDir(out: THREE.Vector3): THREE.Vector3 {
    return out.set(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch)
    )
  }

  private syncCamera(): void {
    const d = this.lookDir(this.look)
    this.camera.position.copy(this.pos)
    this.camera.lookAt(this.pos.x + d.x, this.pos.y + d.y, this.pos.z + d.z)
  }
}