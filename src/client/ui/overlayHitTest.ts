import type * as THREE from 'three'
import type { RemoteAvatarManager } from '../../network/RemoteAvatarManager'

const INTERACTIVE_NAME_TAG_SELECTOR = '.avatar-name-tag--interactive[data-peer-address]'
const APP_CANVAS_SELECTOR = '#app canvas'

/** Extra slop above the pill for the floating Options hint. */
const PILL_OPTIONS_HINT_PAD_TOP_PX = 40

let peerPillLookup: PillHoverLookupOptions | null = null
let peerContextMenuHandler: ((address: string, clientX: number, clientY: number) => void) | null = null

export function setPeerPillHitTestOptions(options: PillHoverLookupOptions | null): void {
  peerPillLookup = options
}

export function setPeerContextMenuHandler(
  handler: ((address: string, clientX: number, clientY: number) => void) | null
): void {
  peerContextMenuHandler = handler
}

/** Under pointer lock, aim is screen center — CSS2D pill rects use stale cursor coords. */
export function resolvePointerClientCoords(clientX: number, clientY: number): { x: number; y: number } {
  const canvas = document.querySelector(APP_CANVAS_SELECTOR) as HTMLCanvasElement | null
  if (canvas && document.pointerLockElement === canvas) {
    const rect = canvas.getBoundingClientRect()
    return { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.5 }
  }
  return { x: clientX, y: clientY }
}

/** True when the event target is an interactive client overlay (name pill, profile UI). */
export function isClientOverlayTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest(
    `${INTERACTIVE_NAME_TAG_SELECTOR}, .user-context-menu, .user-context-menu-backdrop, .user-profile-modal, .user-profile-modal-backdrop`
  )
}

export type InteractiveNameTagHit = {
  address: string
  element: HTMLElement
}

export type PillHoverLookupOptions = {
  getRemoteAvatars?: () => RemoteAvatarManager | null
  getCamera?: () => THREE.Camera | null
}

/**
 * Nearest remote player pill — prefers the live avatar's projected screen bounds (pointer-lock friendly),
 * then falls back to the CSS2D pill rectangle.
 */
export function findHoveredPeerPill(
  clientX: number,
  clientY: number,
  options: PillHoverLookupOptions = {}
): InteractiveNameTagHit | null {
  const coords = resolvePointerClientCoords(clientX, clientY)
  const avatarHit = options.getRemoteAvatars?.()?.findPeerNearScreenPoint(
    coords.x,
    coords.y,
    options.getCamera?.() ?? null
  )
  if (avatarHit) return avatarHit
  return findInteractiveNameTagNear(coords.x, coords.y)
}

/** Avatar bounds + pill proximity — used for right-click / secondary interact routing. */
export function findPeerPillAtPointer(
  clientX: number,
  clientY: number,
  options: PillHoverLookupOptions | null = peerPillLookup
): InteractiveNameTagHit | null {
  return findHoveredPeerPill(clientX, clientY, options ?? {})
}

/** Opens the peer context menu when the pointer is over a remote player pill/avatar. */
export function tryOpenPeerContextMenu(clientX: number, clientY: number): boolean {
  const coords = resolvePointerClientCoords(clientX, clientY)
  const hit = findPeerPillAtPointer(coords.x, coords.y)
  if (!hit) return false
  peerContextMenuHandler?.(hit.address, coords.x, coords.y)
  return true
}

/**
 * Nearest remote name pill at screen coords — CSS2D pill rectangle (+ Options hint slop).
 */
export function findInteractiveNameTagNear(
  clientX: number,
  clientY: number,
  maxDistancePx = 96
): InteractiveNameTagHit | null {
  const tags = document.querySelectorAll<HTMLElement>(INTERACTIVE_NAME_TAG_SELECTOR)
  let best: { hit: InteractiveNameTagHit; score: number } | null = null

  for (const element of tags) {
    const address = element.dataset.peerAddress?.trim().toLowerCase()
    if (!address) continue
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) continue

    const padX = Math.max(12, maxDistancePx * 0.25)
    const padY = Math.max(10, maxDistancePx * 0.2)
    const hitLeft = rect.left - padX
    const hitRight = rect.right + padX
    const hitTop = rect.top - padY - PILL_OPTIONS_HINT_PAD_TOP_PX
    const hitBottom = rect.bottom + padY

    const inPill =
      clientX >= hitLeft &&
      clientX <= hitRight &&
      clientY >= hitTop &&
      clientY <= hitBottom

    const cx = rect.left + rect.width * 0.5
    const cy = rect.top + rect.height * 0.5
    const dist = Math.hypot(clientX - cx, clientY - cy)

    if (!inPill && dist > maxDistancePx) continue

    const score = inPill ? dist : dist + maxDistancePx
    if (!best || score < best.score) {
      best = { hit: { address, element }, score }
    }
  }

  return best?.hit ?? null
}