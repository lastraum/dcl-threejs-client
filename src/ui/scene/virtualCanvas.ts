/** Virtual UI canvas — Yoga layout coordinate system (Explorer default). */
export const DEFAULT_VIRTUAL_CANVAS = { width: 1920, height: 1080 } as const

export type VirtualCanvasSize = {
  width: number
  height: number
}

export type ScreenUiRect = {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Viewport mapping virtual Yoga space → screen pixels.
 *
 * Scene UI is **authored** in virtual px (default 1920×1080 / setUiRenderer).
 * We then **stretch-map** that rect onto the full interactable (WebGL canvas box) —
 * non-uniform scaleX/scaleY so the HUD fills the real screen (no letterbox black bars).
 * Typography/radii use `uniform` so text does not stretch weirdly.
 */
export type UiViewport = {
  scaleX: number
  scaleY: number
  /** min(scaleX, scaleY) — typography / radii only. */
  uniform: number
  canvasWidth: number
  canvasHeight: number
}

export function computeUiViewport(
  virtual: VirtualCanvasSize,
  interactable: ScreenUiRect
): UiViewport {
  // Stretch virtual design space onto full canvas (Explorer fill, not letterbox).
  const scaleX = interactable.width / Math.max(1, virtual.width)
  const scaleY = interactable.height / Math.max(1, virtual.height)
  return {
    scaleX,
    scaleY,
    uniform: Math.min(scaleX, scaleY),
    canvasWidth: interactable.width,
    canvasHeight: interactable.height
  }
}

/** Map virtual Yoga layout px → screen px (fill interactable area). */
export function layoutToScreen(
  interactable: ScreenUiRect,
  viewport: UiViewport,
  x: number,
  y: number,
  w: number,
  h: number
): { left: number; top: number; width: number; height: number; scaleX: number; scaleY: number } {
  return {
    left: interactable.left + x * viewport.scaleX,
    top: interactable.top + y * viewport.scaleY,
    width: w * viewport.scaleX,
    height: h * viewport.scaleY,
    scaleX: viewport.scaleX,
    scaleY: viewport.scaleY
  }
}

/** WebGL canvas rect — single source for Yoga→screen mapping and #scene-ui-root placement. */
export function readInteractableArea(canvas?: HTMLElement | null): ScreenUiRect {
  const el = canvas ?? document.querySelector('#app canvas')
  if (el) {
    const r = el.getBoundingClientRect()
    if (r.width > 1 && r.height > 1) {
      return { left: r.left, top: r.top, width: r.width, height: r.height }
    }
  }
  // Fallback: full #app (absolute-fill canvas) so UI is never letterboxed short.
  const app = document.getElementById('app')
  if (app) {
    const r = app.getBoundingClientRect()
    if (r.width > 1 && r.height > 1) {
      return { left: r.left, top: r.top, width: r.width, height: r.height }
    }
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}

/**
 * Pin #scene-ui-root to the WebGL canvas box.
 * Yoga laid out in virtual 1920×1080; this root is the **fullscreen overlay** of that
 * design space onto real pixels (see computeUiViewport stretch mapping).
 */
export function alignSceneUiRoot(root: HTMLElement, interactable: ScreenUiRect): void {
  root.style.position = 'fixed'
  root.style.inset = 'unset'
  root.style.left = `${interactable.left}px`
  root.style.top = `${interactable.top}px`
  root.style.width = `${interactable.width}px`
  root.style.height = `${interactable.height}px`
  root.style.right = 'auto'
  root.style.bottom = 'auto'
  root.style.overflow = 'hidden'
  root.style.pointerEvents = 'none'
}

/** Virtual-space insets for UiCanvasInformation (Explorer react-ecs uiSizer). */
export function interactableInsetsVirtual(
  virtual: VirtualCanvasSize,
  interactable: ScreenUiRect
): { left: number; top: number; right: number; bottom: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const sx = virtual.width / Math.max(1, vw)
  const sy = virtual.height / Math.max(1, vh)
  return {
    left: Math.round(interactable.left * sx),
    top: Math.round(interactable.top * sy),
    right: Math.round(Math.max(0, vw - interactable.left - interactable.width) * sx),
    bottom: Math.round(Math.max(0, vh - interactable.top - interactable.height) * sy)
  }
}