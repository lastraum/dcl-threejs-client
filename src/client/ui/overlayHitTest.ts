const INTERACTIVE_NAME_TAG_SELECTOR = '.avatar-name-tag--interactive[data-peer-address]'

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

/**
 * Nearest remote name pill at screen coords — used when the canvas receives right-click
 * near (but not exactly on) a CSS2D pill.
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

    const pad = maxDistancePx * 0.35
    const inSlop =
      clientX >= rect.left - pad &&
      clientX <= rect.right + pad &&
      clientY >= rect.top - pad &&
      clientY <= rect.bottom + pad
    const cx = rect.left + rect.width * 0.5
    const cy = rect.top + rect.height * 0.5
    const dist = Math.hypot(clientX - cx, clientY - cy)
    if (!inSlop && dist > maxDistancePx) continue

    const score = inSlop ? dist : dist + maxDistancePx
    if (!best || score < best.score) {
      best = { hit: { address, element }, score }
    }
  }

  return best?.hit ?? null
}