/**
 * Tour Focus — followers mirror the leader freecam POV (1P/3P, boom, FOV).
 *
 * Leader publishes cam via CommunityFollowController; this class:
 * - blocks follower input (PlayerSystem.setTourFocusActive)
 * - reconstructs freecam from leader remote feet + cam payload
 * - shows a small banner; Esc leaves the tour
 */

import * as THREE from 'three'
import { isTextInputFocused } from '../client/ui/textInputFocus'
import type { SceneHost } from '../rendering/SceneHost'
import { clientSettings } from '../rendering/ClientSettings'
import type { FollowCamState } from './communityFollowWire'

/** Match PlayerSystem freecam constants. */
const CAM_PIVOT_HEIGHT = 1.45
const CAM_EYE_HEIGHT = 1.82
const CAM_LOOK_HEIGHT = 1.15
const CAM_SHOULDER_OFFSET = 0.3
const CAM_FPV_MAX_DISTANCE = 0.35

/** Used until the first leader `cam` packet arrives (focus ON can beat first sample). */
const DEFAULT_CAM: FollowCamState = {
  fp: false,
  yaw: 0,
  pitch: 0.35,
  dist: 4,
  fov: 75
}

const _pivot = new THREE.Vector3()
const _lookAt = new THREE.Vector3()
const _offset = new THREE.Vector3()
const _shoulder = new THREE.Vector3()
const _camPos = new THREE.Vector3()
const _camQuat = new THREE.Quaternion()
const _camEuler = new THREE.Euler(0, 0, 0, 'YXZ')
const _smoothedPos = new THREE.Vector3()
const _smoothedQuat = new THREE.Quaternion()
const _feetWorld = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _lookMat = new THREE.Matrix4()

export type TourFocusControllerDeps = {
  host: SceneHost
  /** Leader peer feet root (Three world), or null if not yet posed. */
  getLeaderFeet: () => THREE.Object3D | null
  setPlayerTourFocusActive: (active: boolean) => void
  /** Photo mode owns the lens — do not fight it. Tour Focus overrides freecam / scene VC. */
  isPhotoCameraActive?: () => boolean
  /** Esc while focused → leave tour (unfollow). */
  onLeave: () => void
}

export class TourFocusController {
  private active = false
  private leaderAddress: string | null = null
  private cam: FollowCamState | null = null
  private hasSmoothed = false
  private restoredFov: number | null = null
  private banner: HTMLElement | null = null
  private readonly onKey: (e: KeyboardEvent) => void
  private readonly deps: TourFocusControllerDeps

  constructor(deps: TourFocusControllerDeps) {
    this.deps = deps
    this.onKey = (e) => {
      if (!this.active) return
      if (e.key !== 'Escape') return
      if (isTextInputFocused()) return
      e.preventDefault()
      e.stopPropagation()
      this.deps.onLeave()
    }
  }

  isActive(): boolean {
    return this.active
  }

  getLeaderAddress(): string | null {
    return this.leaderAddress
  }

  /** Enter / refresh focus for a leader. */
  enter(leaderAddress: string, cam?: FollowCamState | null): void {
    const addr = leaderAddress.trim().toLowerCase()
    if (!addr) return
    const wasActive = this.active
    this.active = true
    this.leaderAddress = addr
    if (cam) this.cam = cam
    // Never leave cam null — otherwise update() no-ops and the lens stays on the follower.
    if (!this.cam) this.cam = { ...DEFAULT_CAM, fov: clientSettings.getFov() }
    if (!wasActive) {
      this.restoredFov = this.deps.host.camera.fov
      this.deps.setPlayerTourFocusActive(true)
      this.showBanner()
      window.addEventListener('keydown', this.onKey, true)
      this.hasSmoothed = false
      // Snap on first frame so we jump to the leader immediately (not stay at local freecam).
      this.update(1 / 30)
    } else {
      this.refreshBanner()
    }
  }

  setCam(cam: FollowCamState): void {
    this.cam = cam
    if (this.active) {
      this.applyFov(cam.fov)
      // First real cam packet after focus — hard snap so we don't ease from defaults.
      if (!this.hasSmoothed) this.update(1 / 30)
    }
  }

  exit(): void {
    if (!this.active && !this.banner) return
    this.active = false
    this.leaderAddress = null
    this.cam = null
    this.hasSmoothed = false
    this.deps.setPlayerTourFocusActive(false)
    this.restoreFov()
    this.hideBanner()
    window.removeEventListener('keydown', this.onKey, true)
  }

  dispose(): void {
    this.exit()
  }

  /**
   * Apply leader freecam each frame after remote avatar pose ticks.
   * No-op when inactive, missing leader pose, or photo camera owns the lens.
   */
  update(delta: number): void {
    if (!this.active) return
    if (this.deps.isPhotoCameraActive?.()) return

    const feet = this.deps.getLeaderFeet()
    if (!feet) {
      this.refreshBannerWaiting(true)
      return
    }
    this.refreshBannerWaiting(false)

    const cam = this.cam ?? { ...DEFAULT_CAM, fov: clientSettings.getFov() }
    this.cam = cam
    this.applyFov(cam.fov)

    // World position — peer roots may sit under a scene parent.
    feet.updateWorldMatrix(true, false)
    feet.getWorldPosition(_feetWorld)

    const fpv = cam.fp || cam.dist <= CAM_FPV_MAX_DISTANCE

    if (fpv) {
      _pivot.copy(_feetWorld)
      _pivot.y += CAM_EYE_HEIGHT + 0.3
      _camEuler.set(cam.pitch, cam.yaw, 0)
      _camQuat.setFromEuler(_camEuler)
      _camPos.copy(_pivot)
    } else {
      _pivot.copy(_feetWorld)
      _pivot.y += CAM_PIVOT_HEIGHT
      _lookAt.copy(_feetWorld)
      _lookAt.y += CAM_LOOK_HEIGHT

      const cosPitch = Math.cos(cam.pitch)
      const sinPitch = Math.sin(cam.pitch)
      _offset.set(
        Math.sin(cam.yaw) * cosPitch * cam.dist,
        sinPitch * cam.dist,
        Math.cos(cam.yaw) * cosPitch * cam.dist
      )
      if (cam.pitch < 0.65) {
        _shoulder.set(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw))
        _offset.addScaledVector(_shoulder, CAM_SHOULDER_OFFSET * (1 - cam.pitch / 0.65))
      }
      _camPos.copy(_pivot).add(_offset)
      // Look-at quaternion toward avatar chest.
      _lookMat.lookAt(_camPos, _lookAt, _up)
      _camQuat.setFromRotationMatrix(_lookMat)
    }

    const dt = Math.min(Math.max(delta, 0), 0.05)
    const alpha = this.hasSmoothed ? 1 - Math.exp(-14 * dt) : 1
    if (!this.hasSmoothed) {
      _smoothedPos.copy(_camPos)
      _smoothedQuat.copy(_camQuat)
      this.hasSmoothed = true
    } else {
      _smoothedPos.lerp(_camPos, alpha)
      _smoothedQuat.slerp(_camQuat, alpha)
    }

    this.deps.host.camera.position.copy(_smoothedPos)
    this.deps.host.camera.quaternion.copy(_smoothedQuat)
    this.deps.host.camera.updateMatrixWorld(true)
  }

  private applyFov(fov: number): void {
    const cam = this.deps.host.camera
    const next = Math.max(20, Math.min(140, fov))
    if (Math.abs(cam.fov - next) < 0.05) return
    cam.fov = next
    cam.updateProjectionMatrix()
  }

  private restoreFov(): void {
    const cam = this.deps.host.camera
    const target = this.restoredFov ?? clientSettings.getFov()
    this.restoredFov = null
    if (Math.abs(cam.fov - target) < 0.05) return
    cam.fov = target
    cam.updateProjectionMatrix()
  }

  private showBanner(): void {
    if (this.banner) return
    const el = document.createElement('div')
    el.className = 'tour-focus-banner'
    el.setAttribute('role', 'status')
    el.innerHTML = `
      <span class="tour-focus-banner-icon" aria-hidden="true">◎</span>
      <span class="tour-focus-banner-text" data-focus-text>Tour Focus — watching leader</span>
      <span class="tour-focus-banner-hint">Esc to exit focus</span>
    `
    document.body.appendChild(el)
    this.banner = el
  }

  private refreshBanner(): void {
    this.refreshBannerWaiting(false)
  }

  private refreshBannerWaiting(waiting: boolean): void {
    const text = this.banner?.querySelector('[data-focus-text]')
    if (!text) return
    text.textContent = waiting
      ? 'Tour Focus — waiting for leader pose…'
      : 'Tour Focus — watching leader'
  }

  private hideBanner(): void {
    this.banner?.remove()
    this.banner = null
  }
}
