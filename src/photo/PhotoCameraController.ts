/**
 * Dedicated In-World Camera (Explorer photo mode) — separate from orbit freecam.
 *
 * - Own pose + FOV applied to SceneHost.camera while active
 * - Fly within PHOTO_MAX_DISTANCE_FROM_PLAYER of the avatar
 * - Shutter captures cropped frame + frustum metadata (people in view)
 * - Review UI (3/4 preview + 1/4 people/items) before download/share
 */

import * as THREE from 'three'
import { isTextInputFocused } from '../client/ui/textInputFocus'
import type { SceneHost } from '../rendering/SceneHost'
import {
  PHOTO_DEFAULT_FOV,
  PHOTO_FRAME_SCALE,
  PHOTO_LOOK_SENSITIVITY,
  PHOTO_MAX_DISTANCE_FROM_PLAYER,
  PHOTO_MAX_FOV,
  PHOTO_MIN_FOV,
  PHOTO_MIN_Y,
  PHOTO_RUN_MULTIPLIER,
  PHOTO_TRANSLATION_SPEED,
  PHOTO_WALK_MULTIPLIER,
  PHOTO_FOV_SCROLL_SPEED
} from './constants'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import {
  galleryReelsUrl,
  photoMetadataToCameraReel,
  resolvePlaceIdForParcel,
  uploadGalleryImage
} from '../social/dclGallery'
import { capturePhotoFromRenderer, type PhotoCaptureResult } from './photoCapture'
import { PhotoCameraHud } from './PhotoCameraHud'
import { PhotoReviewPanel } from './PhotoReviewPanel'
import {
  buildPhotoMetadata,
  peopleInPhotoFrustum,
  type PhotoMetadata,
  type PhotoPersonSample,
  type PhotoVisiblePerson
} from './photoMetadata'

export type PhotoCameraDeps = {
  host: SceneHost
  /** Local avatar feet (Three world). */
  getPlayerFeet: () => THREE.Vector3
  /** Samples for frustum people metadata (local + remotes). */
  getPeopleSamples: () => PhotoPersonSample[]
  getSelfIdentity: () => { name: string; address: string; isGuest: boolean }
  getSceneMeta: () => { sceneName: string; realm: string; parcelX: number; parcelY: number }
  /** Signed-fetch identity for Camera Reel upload (null = guest). */
  getAuthIdentity: () => AuthIdentity | null
  /** Hide client + scene chrome while photographing (like Explorer). */
  setWorldChromeVisible: (visible: boolean) => void
  /** Catalyst peer base for wearable thumbs in review rail. */
  peerUrl?: string
  /** Optional: after successful gallery save / download / share. */
  onCaptured?: (result: PhotoCaptureResult) => void
}

const _forward = new THREE.Vector3()
const _right = new THREE.Vector3()
const _move = new THREE.Vector3()
const _euler = new THREE.Euler(0, 0, 0, 'YXZ')

export class PhotoCameraController {
  private active = false
  private capturing = false
  private reviewing = false
  private yaw = 0
  private pitch = 0
  private fov = PHOTO_DEFAULT_FOV
  private readonly position = new THREE.Vector3()
  private readonly keys = {
    w: false,
    a: false,
    s: false,
    d: false,
    q: false,
    e: false,
    shift: false,
    ctrl: false
  }
  private pointerLocked = false
  private readonly hud: PhotoCameraHud
  private readonly review: PhotoReviewPanel
  private peoplePollAcc = 0
  /** Tour location bind: first successful shutter invokes then clears. */
  private nextCaptureHandler:
    | ((result: PhotoCaptureResult) => void | Promise<void>)
    | null = null
  /** True while Camera Reel was opened from Tour Locations → Add photo. */
  private tourLocationCapture = false
  /** Fired when leaving tour photo mode: captured=true if a shot bound successfully. */
  private onTourCaptureExit: ((captured: boolean) => void) | null = null
  private tourCaptureSucceeded = false

  constructor(private readonly deps: PhotoCameraDeps) {
    this.hud = new PhotoCameraHud({
      onShutter: () => void this.takePhoto(),
      onExit: () => this.exit()
    })
    this.review = new PhotoReviewPanel({
      peerUrl: deps.peerUrl,
      onScrap: () => this.onReviewScrap(),
      onSaveToGallery: (r) => this.saveToGallery(r),
      onDownload: (r) => this.deps.onCaptured?.(r),
      onShare: (r) => this.deps.onCaptured?.(r)
    })
  }

  /** Camera Reel upload — no local download. */
  private async saveToGallery(result: PhotoCaptureResult): Promise<void> {
    const identity = this.deps.getAuthIdentity()
    if (!identity) {
      throw new Error('Connect your wallet to save to gallery')
    }
    const self = this.deps.getSelfIdentity()
    const address = (self.address || result.metadata.userAddress || '').toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(address)) {
      throw new Error('Connect your wallet to save to gallery')
    }

    // Ensure metadata address matches signed wallet (API rejects mismatches).
    const meta = {
      ...result.metadata,
      userAddress: address,
      userName: result.metadata.userName || self.name
    }

    let placeId = ''
    try {
      placeId = await resolvePlaceIdForParcel(meta.scene.parcelX, meta.scene.parcelY)
    } catch {
      placeId = ''
    }

    const uploadMeta = photoMetadataToCameraReel(meta, placeId)
    const uploaded = await uploadGalleryImage({
      image: result.blob,
      metadata: uploadMeta,
      identity,
      isPublic: true,
      filename: `dcl-photo-${meta.dateTime}.jpg`
    })

    console.info('[photo-camera] saved to gallery', {
      id: uploaded.image.id,
      reels: galleryReelsUrl(uploaded.image.id),
      current: uploaded.currentImages,
      max: uploaded.maxImages
    })
    this.deps.onCaptured?.(result)
  }

  isActive(): boolean {
    return this.active
  }

  isReviewing(): boolean {
    return this.reviewing
  }

  enter(): void {
    if (this.active) return
    if (isTextInputFocused()) return

    const cam = this.deps.host.camera
    this.position.copy(cam.position)
    _euler.setFromQuaternion(cam.quaternion, 'YXZ')
    this.yaw = _euler.y
    this.pitch = _euler.x
    this.fov = THREE.MathUtils.clamp(cam.fov, PHOTO_MIN_FOV, PHOTO_MAX_FOV)
    this.active = true
    this.reviewing = false
    this.clearKeys()

    this.deps.setWorldChromeVisible(false)
    this.hud.show()
    document.body.classList.add('photo-camera-mode')

    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false })
    document.addEventListener('pointerlockchange', this.onPointerLockChange)
    this.deps.host.renderer.domElement.addEventListener('click', this.onCanvasClick)

    this.applyToCamera()
    this.refreshPeopleCount()
    // Explorer locks cursor immediately on enter (look mode + hidden cursor).
    this.requestLookLock()
    console.info('[photo-camera] entered In-World Camera mode')
  }

  exit(): void {
    if (!this.active) return
    this.active = false
    this.capturing = false
    this.reviewing = false
    this.clearKeys()
    this.review.close()
    this.detachListeners()
    if (document.pointerLockElement) document.exitPointerLock()
    this.pointerLocked = false

    this.hud.hide()
    document.body.classList.remove('photo-camera-mode')
    this.deps.setWorldChromeVisible(true)

    // Tour location photo flow: always notify exit (success or cancel via Esc).
    const wasTour = this.tourLocationCapture
    const captured = this.tourCaptureSucceeded
    const onTourExit = this.onTourCaptureExit
    this.tourLocationCapture = false
    this.tourCaptureSucceeded = false
    this.nextCaptureHandler = null
    this.onTourCaptureExit = null
    if (wasTour && onTourExit) {
      try {
        onTourExit(captured)
      } catch (err) {
        console.warn('[photo-camera] tour capture exit handler failed', err)
      }
    }

    console.info('[photo-camera] exited In-World Camera mode')
  }

  toggle(): void {
    if (this.active) this.exit()
    else this.enter()
  }

  dispose(): void {
    if (this.active) this.exit()
    this.hud.dispose()
    this.review.dispose()
  }

  /** Per-frame fly + apply pose. Call only when active, before render. */
  update(delta: number): void {
    if (!this.active || this.capturing) return

    // Review freezes fly; keep last pose on the lens.
    if (this.reviewing) {
      this.applyToCamera()
      return
    }

    const dt = Math.min(delta, 0.05)
    const speedMult = this.keys.shift
      ? PHOTO_RUN_MULTIPLIER
      : this.keys.ctrl
        ? PHOTO_WALK_MULTIPLIER
        : 1
    const speed = PHOTO_TRANSLATION_SPEED * speedMult

    _euler.set(this.pitch, this.yaw, 0, 'YXZ')
    const quat = new THREE.Quaternion().setFromEuler(_euler)
    _forward.set(0, 0, -1).applyQuaternion(quat)
    _right.set(1, 0, 0).applyQuaternion(quat)

    _move.set(0, 0, 0)
    if (this.keys.w) _move.add(_forward)
    if (this.keys.s) _move.sub(_forward)
    if (this.keys.d) _move.add(_right)
    if (this.keys.a) _move.sub(_right)
    if (this.keys.e) _move.y += 1
    if (this.keys.q) _move.y -= 1

    if (_move.lengthSq() > 1e-8) {
      _move.normalize().multiplyScalar(speed * dt)
      this.position.add(_move)
    }

    this.clampToPlayer()
    this.applyToCamera()

    this.peoplePollAcc += dt
    if (this.peoplePollAcc >= 0.25) {
      this.peoplePollAcc = 0
      this.refreshPeopleCount()
    }
  }

  applyToCamera(): void {
    const cam = this.deps.host.camera
    cam.position.copy(this.position)
    _euler.set(this.pitch, this.yaw, 0, 'YXZ')
    cam.quaternion.setFromEuler(_euler)
    cam.fov = this.fov
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld(true)
  }

  /** Tour Locations: bind next shutter to a handler (one-shot). */
  setNextCaptureHandler(
    handler: ((result: PhotoCaptureResult) => void | Promise<void>) | null
  ): void {
    this.nextCaptureHandler = handler
  }

  isTourLocationCapture(): boolean {
    return this.tourLocationCapture
  }

  /**
   * Open Camera Reel for a tour location photo.
   * Caller hides tour chrome; on exit without shot, `onExit(false)`.
   */
  beginTourLocationCapture(opts: {
    onCapture: (result: PhotoCaptureResult) => void | Promise<void>
    onExit: (captured: boolean) => void
  }): void {
    this.tourLocationCapture = true
    this.tourCaptureSucceeded = false
    this.onTourCaptureExit = opts.onExit
    this.nextCaptureHandler = opts.onCapture
    if (!this.active) this.enter()
  }

  async takePhoto(): Promise<PhotoCaptureResult | null> {
    if (!this.active || this.capturing || this.reviewing) return null
    this.capturing = true
    this.hud.setCaptureChromeVisible(false)
    this.hud.setStatus('Capturing…')

    try {
      // One clean frame without HUD chrome.
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      this.applyToCamera()
      this.deps.host.renderFrame()

      const people = this.collectVisiblePeople()
      const self = this.deps.getSelfIdentity()
      const scene = this.deps.getSceneMeta()
      const metadata = buildPhotoMetadata({
        selfName: self.name,
        selfAddress: self.address,
        realm: scene.realm,
        sceneName: scene.sceneName,
        parcelX: scene.parcelX,
        parcelY: scene.parcelY,
        camera: this.deps.host.camera,
        visiblePeople: people
      })

      const result = await capturePhotoFromRenderer(
        this.deps.host.renderer,
        metadata,
        PHOTO_FRAME_SCALE
      )

      this.hud.setCaptureChromeVisible(true)
      this.hud.playFlash()
      this.hud.setStatus('')

      const bind = this.nextCaptureHandler
      if (bind || this.tourLocationCapture) {
        this.nextCaptureHandler = null
        try {
          await Promise.resolve(bind?.(result))
          this.tourCaptureSucceeded = true
        } catch (err) {
          console.warn('[photo-camera] next-capture handler failed', err)
          this.tourCaptureSucceeded = false
        }
        // Tour bind: skip review rail — photo is already attached to the stop.
        this.capturing = false
        this.exit()
        return result
      }

      this.openReview(result)

      console.info('[photo-camera] capture → review', {
        people: people.length,
        parcel: `${scene.parcelX},${scene.parcelY}`,
        names: people.map((p) => p.userName)
      })
      return result
    } catch (err) {
      console.warn('[photo-camera] capture failed', err)
      this.hud.setStatus('Capture failed')
      this.hud.setCaptureChromeVisible(true)
      return null
    } finally {
      this.capturing = false
    }
  }

  private openReview(result: PhotoCaptureResult): void {
    this.reviewing = true
    this.clearKeys()
    // Unlock so the user can use the review UI (cursor visible).
    if (document.pointerLockElement) document.exitPointerLock()
    this.pointerLocked = false
    this.hud.hide()
    document.body.classList.remove('photo-camera-mode')
    this.review.open(result)
  }

  private onReviewScrap(): void {
    this.reviewing = false
    this.hud.show()
    document.body.classList.add('photo-camera-mode')
    this.refreshPeopleCount()
    this.requestLookLock()
  }

  private collectVisiblePeople(): PhotoVisiblePerson[] {
    return peopleInPhotoFrustum(this.deps.host.camera, this.deps.getPeopleSamples(), PHOTO_FRAME_SCALE)
  }

  private refreshPeopleCount(): void {
    if (!this.active || this.reviewing) return
    this.hud.setPeopleCount(this.collectVisiblePeople().length)
  }

  private clampToPlayer(): void {
    const feet = this.deps.getPlayerFeet()
    if (this.position.y < PHOTO_MIN_Y) this.position.y = PHOTO_MIN_Y

    const dx = this.position.x - feet.x
    const dy = this.position.y - feet.y
    const dz = this.position.z - feet.z
    const dist = Math.hypot(dx, dy, dz)
    if (dist > PHOTO_MAX_DISTANCE_FROM_PLAYER && dist > 1e-6) {
      const s = PHOTO_MAX_DISTANCE_FROM_PLAYER / dist
      this.position.set(feet.x + dx * s, feet.y + dy * s, feet.z + dz * s)
      if (this.position.y < PHOTO_MIN_Y) this.position.y = PHOTO_MIN_Y
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return
    if (isTextInputFocused()) return
    if (e.metaKey || e.altKey) return

    // Review: Esc scraps; C exits fully.
    if (this.reviewing) {
      if (e.code === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.review.scrap()
        return
      }
      if (e.code === 'KeyC') {
        e.preventDefault()
        e.stopPropagation()
        this.exit()
        return
      }
      // Block fly / shutter while reviewing.
      if (e.code === 'Space' || this.isFlyCode(e.code)) {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }

    if (e.code === 'Escape' || e.code === 'KeyC') {
      e.preventDefault()
      e.stopPropagation()
      this.exit()
      return
    }
    if (e.code === 'Space' || e.code === 'Enter') {
      // Space = shutter when not typing (Explorer InWorldCamera.Screenshot)
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault()
        e.stopPropagation()
        void this.takePhoto()
      }
      return
    }

    this.setKey(e.code, true)
    if (this.isFlyCode(e.code)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.setKey(e.code, false)
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.active || this.reviewing || this.capturing) return
    e.preventDefault()
    e.stopPropagation()
    // Explorer FOV scroll — scale with deltaY so trackpad + mouse both feel right.
    const step =
      Math.abs(e.deltaY) > 0
        ? e.deltaY * PHOTO_FOV_SCROLL_SPEED
        : Math.sign(e.deltaX) * PHOTO_FOV_SCROLL_SPEED * 16
    this.fov = THREE.MathUtils.clamp(this.fov + step, PHOTO_MIN_FOV, PHOTO_MAX_FOV)
    this.applyToCamera()
    this.hud.setStatus(`FOV ${Math.round(this.fov)}°`)
  }

  private onCanvasClick = (): void => {
    if (!this.active || this.reviewing) return
    // Re-lock if user unlocked (Esc) but stays in photo mode.
    this.requestLookLock()
  }

  /** Pointer lock = Explorer look mode (cursor hidden, mouse aims the lens). */
  private requestLookLock(): void {
    if (this.reviewing) return
    const el = this.deps.host.renderer.domElement
    if (document.pointerLockElement === el) return
    try {
      const req = el.requestPointerLock()
      if (req && typeof (req as Promise<void>).then === 'function') {
        void (req as Promise<void>).catch(() => {
          /* browser may require another click — canvas click re-tries */
        })
      }
    } catch {
      /* ignore */
    }
  }

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.deps.host.renderer.domElement
    if (this.pointerLocked && !this.reviewing) {
      document.addEventListener('mousemove', this.onMouseMove)
    } else {
      document.removeEventListener('mousemove', this.onMouseMove)
    }
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.active || !this.pointerLocked || this.reviewing) return
    this.yaw -= e.movementX * PHOTO_LOOK_SENSITIVITY
    this.pitch -= e.movementY * PHOTO_LOOK_SENSITIVITY
    const lim = Math.PI / 2 - 0.02
    this.pitch = THREE.MathUtils.clamp(this.pitch, -lim, lim)
  }

  private setKey(code: string, down: boolean): void {
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        this.keys.w = down
        break
      case 'KeyS':
      case 'ArrowDown':
        this.keys.s = down
        break
      case 'KeyA':
      case 'ArrowLeft':
        this.keys.a = down
        break
      case 'KeyD':
      case 'ArrowRight':
        this.keys.d = down
        break
      case 'KeyR':
      case 'KeyQ':
        this.keys.q = down
        break
      case 'KeyF':
      case 'KeyE':
        this.keys.e = down
        break
      case 'ShiftLeft':
      case 'ShiftRight':
        this.keys.shift = down
        break
      case 'ControlLeft':
      case 'ControlRight':
        this.keys.ctrl = down
        break
    }
  }

  private isFlyCode(code: string): boolean {
    return (
      code === 'KeyW' ||
      code === 'KeyA' ||
      code === 'KeyS' ||
      code === 'KeyD' ||
      code === 'KeyQ' ||
      code === 'KeyE' ||
      code === 'KeyR' ||
      code === 'KeyF' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'ShiftLeft' ||
      code === 'ShiftRight' ||
      code === 'ControlLeft' ||
      code === 'ControlRight'
    )
  }

  private clearKeys(): void {
    this.keys.w = this.keys.a = this.keys.s = this.keys.d = false
    this.keys.q = this.keys.e = this.keys.shift = this.keys.ctrl = false
  }

  private detachListeners(): void {
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    window.removeEventListener('wheel', this.onWheel, true)
    document.removeEventListener('pointerlockchange', this.onPointerLockChange)
    document.removeEventListener('mousemove', this.onMouseMove)
    this.deps.host.renderer.domElement.removeEventListener('click', this.onCanvasClick)
  }
}

export type { PhotoMetadata }
