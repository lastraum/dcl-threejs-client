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
 * Fills the interactable area (no letterbox) so fullscreen scrims and `right: 0` panels
 * anchor to the actual screen edges — matches Explorer stretch behavior.
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
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}

/** Pin the DOM overlay to the same screen rect used for layoutToScreen / hit regions. */
export function alignSceneUiRoot(root: HTMLElement, interactable: ScreenUiRect): void {
  root.style.position = 'fixed'
  root.style.left = `${interactable.left}px`
  root.style.top = `${interactable.top}px`
  root.style.width = `${interactable.width}px`
  root.style.height = `${interactable.height}px`
  root.style.right = 'auto'
  root.style.bottom = 'auto'
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