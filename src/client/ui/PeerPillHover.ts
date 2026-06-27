import type * as THREE from 'three'
import type { RemoteAvatarManager } from '../../network/RemoteAvatarManager'
import { findHoveredPeerPill, isClientOverlayTarget } from './overlayHitTest'

const INTERACTIVE_NAME_TAG_SELECTOR = '.avatar-name-tag--interactive[data-peer-address]'

export type PeerPillHoverOptions = {
  getRemoteAvatars: () => RemoteAvatarManager | null
  getCamera: () => THREE.Camera | null
}

/**
 * Canvas-driven hover for remote player pills — uses avatar screen bounds (pointer lock)
 * and CSS2D pill proximity, and shows the Options tooltip.
 */
export class PeerPillHover {
  private installed = false
  private blocked = false
  private activeAddress: string | null = null
  private lastClientX = 0
  private lastClientY = 0

  constructor(private readonly options: PeerPillHoverOptions) {}

  install(): void {
    if (this.installed) return
    this.installed = true
    document.addEventListener('pointermove', this.onPointerMove, { passive: true })
    document.addEventListener('pointerdown', this.onPointerMove, { passive: true })
    document.addEventListener('pointerlockchange', this.onPointerLockChange)
    window.addEventListener('blur', this.onWindowBlur)
  }

  dispose(): void {
    if (!this.installed) return
    this.installed = false
    document.removeEventListener('pointermove', this.onPointerMove)
    document.removeEventListener('pointerdown', this.onPointerMove)
    document.removeEventListener('pointerlockchange', this.onPointerLockChange)
    window.removeEventListener('blur', this.onWindowBlur)
    this.clear()
  }

  /** Pause while profile overlays are open; call refresh() after dismiss. */
  setBlocked(blocked: boolean): void {
    this.blocked = blocked
    if (blocked) this.clear()
    else this.update(this.lastClientX, this.lastClientY)
  }

  refresh(): void {
    this.update(this.lastClientX, this.lastClientY)
  }

  private onPointerMove = (e: PointerEvent): void => {
    this.lastClientX = e.clientX
    this.lastClientY = e.clientY
    if (this.blocked) return
    if (isClientOverlayTarget(e.target)) {
      this.clear()
      return
    }
    this.update(e.clientX, e.clientY)
  }

  private onPointerLockChange = (): void => {
    if (this.blocked) return
    this.update(this.lastClientX, this.lastClientY)
  }

  private onWindowBlur = (): void => {
    this.clear()
  }

  private update(clientX: number, clientY: number): void {
    const hit = findHoveredPeerPill(clientX, clientY, {
      getRemoteAvatars: this.options.getRemoteAvatars,
      getCamera: this.options.getCamera
    })
    const nextAddress = hit?.address ?? null

    for (const element of document.querySelectorAll<HTMLElement>(INTERACTIVE_NAME_TAG_SELECTOR)) {
      const addr = element.dataset.peerAddress?.trim().toLowerCase()
      element.classList.toggle('avatar-name-tag--hovered', !!nextAddress && addr === nextAddress)
    }

    if (nextAddress === this.activeAddress) return
    this.activeAddress = nextAddress
  }

  private clear(): void {
    document
      .querySelectorAll<HTMLElement>(INTERACTIVE_NAME_TAG_SELECTOR)
      .forEach((el) => el.classList.remove('avatar-name-tag--hovered'))
    this.activeAddress = null
  }
}