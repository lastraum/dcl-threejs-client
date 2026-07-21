/**
 * Cross-root UI pointer ownership — primary `#scene-ui-root` vs PX `#pe-ui-root`.
 *
 * Both run their own PointerEventsSystem on window (capture). Registration order means
 * primary usually runs first; without a shared owner tag, primary hit-maps inject into
 * scene UI under a PX enable/close dialog (click-through).
 */

import {
  PE_UI_ROOT,
  SCENE_UI_ROOT,
  uiRootIdFromEventTarget
} from './uiDomPick'

const OWNER_KEY = '__dclUiRootOwner' as const

type OwnedPointerEvent = PointerEvent & { [OWNER_KEY]?: string | null }

let gateInstalled = false

/**
 * Topmost ECS UI host under the point (any hittable descendant — not only
 * `.scene-ui-node--interactive`). PE is checked before primary per stack order.
 */
export function topmostUiRootIdUnderPoint(clientX: number, clientY: number): string | null {
  if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') {
    return null
  }
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!(el instanceof Element)) continue
    // Prefer PX — higher z-index; first stack hit under pe-ui-root wins.
    if (el.closest(PE_UI_ROOT)) return 'pe-ui-root'
    if (el.closest(SCENE_UI_ROOT)) return 'scene-ui-root'
    // Canvas / world under the cursor — no UI overlay owns this point.
    if (el instanceof HTMLCanvasElement) return null
  }
  return null
}

/** Resolve which UI root owns this pointer event (target first, then stack). */
export function resolveUiPointerOwner(e: PointerEvent): string | null {
  const fromTarget = uiRootIdFromEventTarget(e.target)
  if (fromTarget) return fromTarget
  return topmostUiRootIdUnderPoint(e.clientX, e.clientY)
}

export function uiPointerOwnerOf(e: PointerEvent): string | null {
  const tagged = (e as OwnedPointerEvent)[OWNER_KEY]
  if (tagged !== undefined) return tagged
  return resolveUiPointerOwner(e)
}

export function isForeignUiPointerOwner(ownRootId: string, e: PointerEvent): boolean {
  const owner = uiPointerOwnerOf(e)
  if (!owner) return false
  return owner !== ownRootId
}

/** True when any ECS UI root (scene or PX) owns this pointer event. */
export function isUiOverlayPointerEvent(e: PointerEvent): boolean {
  return uiPointerOwnerOf(e) != null
}

/**
 * Install once at module load (capture, first). Tags every pointerdown/up with the
 * owning UI root before primary/PX PointerEventsSystem handlers run.
 */
export function installUiPointerGate(): void {
  if (gateInstalled || typeof window === 'undefined') return
  gateInstalled = true
  const tag = (e: PointerEvent): void => {
    ;(e as OwnedPointerEvent)[OWNER_KEY] = resolveUiPointerOwner(e)
  }
  window.addEventListener('pointerdown', tag, { capture: true })
  window.addEventListener('pointerup', tag, { capture: true })
  window.addEventListener('pointercancel', tag, { capture: true })
}

// Ensure gate is active as soon as any scene-UI module loads (before PES bind).
installUiPointerGate()
