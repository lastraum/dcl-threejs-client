/**
 * Scene UI open settle — fingerprint / tween only.
 *
 * **Killed:** size-based “dual-root / shell+twin / huge panel off-side” open gates.
 * Scenes park **one** panel off virtual canvas and tween it on — not two copies.
 * Panel size must not invent mid-open or block inject.
 *
 * poseReady := fingerprintStable (caller) — isOpenPoseBlocked is always false.
 */

export const VIRTUAL_UI_WIDTH = 1920
export const VIRTUAL_UI_HEIGHT = 1080

/** @deprecated Off-canvas park is DOM/hit only — not an open-pose size gate. */
export const DUAL_ROOT_EDGE_EPS = 1

export type UiPoseRow = {
  w: number
  h: number
  parent: number
  abs: boolean
  left: number
  top: number
  display: unknown
  opacity: number
}

export type UiPoseInput = {
  width?: number
  height?: number
  widthUnit?: number
  heightUnit?: number
  positionType?: number
  positionLeft?: number
  positionTop?: number
  positionLeftUnit?: number
  positionTopUnit?: number
  position?: { left?: number; top?: number }
  parent?: number
  display?: unknown
  opacity?: number
}

/** Resolve POINT/PERCENT size+pose into canvas px (AUTO axes → 0, skipped by collectors). */
export function resolveUiPoseRow(
  input: UiPoseInput,
  vw = VIRTUAL_UI_WIDTH,
  vh = VIRTUAL_UI_HEIGHT
): UiPoseRow | null {
  const wU = input.widthUnit ?? 0
  const hU = input.heightUnit ?? 0
  const wRaw = input.width ?? 0
  const hRaw = input.height ?? 0
  const w = wU === 2 ? (wRaw / 100) * vw : wU === 1 || wU === 0 ? wRaw : 0
  const h = hU === 2 ? (hRaw / 100) * vh : hU === 1 || hU === 0 ? hRaw : 0
  if (w < 1 || h < 1) return null
  const leftU = input.positionLeftUnit ?? 0
  const topU = input.positionTopUnit ?? 0
  const leftRaw = input.positionLeft ?? input.position?.left ?? 0
  const topRaw = input.positionTop ?? input.position?.top ?? 0
  const left = leftU === 2 ? (leftRaw / 100) * vw : leftRaw
  const top = topU === 2 ? (topRaw / 100) * vh : topRaw
  return {
    w,
    h,
    parent: (input.parent ?? 0) as number,
    abs: (input.positionType ?? 0) === 1,
    left,
    top,
    display: input.display,
    opacity: input.opacity ?? 1
  }
}

export function uiPoseHidden(r: UiPoseRow): boolean {
  const d = r.display
  if (d === 1 || d === 'none' || d === 'YG_DISPLAY_NONE') return true
  return r.opacity < 0.05
}

export function uiPoseIsScaleSeed(
  r: UiPoseRow,
  vw = VIRTUAL_UI_WIDTH,
  vh = VIRTUAL_UI_HEIGHT
): boolean {
  const maxSeed = Math.min(vw, vh) * 0.025
  return r.w >= 2 && r.h >= 2 && r.w <= maxSeed && r.h <= maxSeed
}

export function uiPoseIsMicro(
  r: UiPoseRow,
  vw = VIRTUAL_UI_WIDTH,
  vh = VIRTUAL_UI_HEIGHT
): boolean {
  const maxMicro = Math.min(vw, vh) * 0.045
  return r.w >= 4 && r.h >= 4 && r.w <= maxMicro && r.h <= maxMicro
}

export function uiPoseIsModal(
  r: UiPoseRow,
  vw = VIRTUAL_UI_WIDTH,
  vh = VIRTUAL_UI_HEIGHT
): boolean {
  const area = r.w * r.h
  const canvas = vw * vh
  if (area < canvas * 0.02) return false
  return area < canvas * 0.45
}

export function uiPoseHasModalAncestor(
  byId: Map<number, UiPoseRow>,
  startParent: number
): boolean {
  let p = startParent
  for (let guard = 0; p && p !== 0 && guard < 16; guard++) {
    const pr = byId.get(p)
    if (!pr) break
    if (!uiPoseHidden(pr) && uiPoseIsModal(pr)) return true
    p = pr.parent
  }
  return false
}

export function uiPoseChildCount(byId: Map<number, UiPoseRow>, id: number): number {
  let n = 0
  for (const r of byId.values()) {
    if (r.parent === id) n++
  }
  return n
}

/**
 * Canvas-absolute origin: sum absolute offsets along the parent chain.
 * Local-only top/left miss nested parks (parent@200 + child@1027 → canvas y=1227).
 * Oracle 21:25: flags=ready while main yoga PE at 934,1227 — blank inventory icons.
 */
export function canvasAbsOrigin(
  byId: Map<number, UiPoseRow>,
  startId: number
): { left: number; top: number } {
  let left = 0
  let top = 0
  let cur: number | undefined = startId
  const seen = new Set<number>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const r = byId.get(cur)
    if (!r) break
    if (r.abs) {
      left += r.left
      top += r.top
    }
    cur = r.parent
  }
  return { left, top }
}

/**
 * @deprecated Always false. Size-based “shell on canvas + panel off side” mid-open is dead.
 * Scenes use one panel off-screen → tween on. Panel area must not gate inject/open settle.
 */
export function isDualRootParked(
  _byId: Map<number, UiPoseRow>,
  _vw = VIRTUAL_UI_WIDTH,
  _vh = VIRTUAL_UI_HEIGHT
): boolean {
  return false
}

/**
 * @deprecated Always false. Micro / scale-seed size heuristics must not block open settle.
 */
export function isScaleSeedOpen(
  _byId: Map<number, UiPoseRow>,
  _vw = VIRTUAL_UI_WIDTH,
  _vh = VIRTUAL_UI_HEIGHT
): boolean {
  return false
}

/** Some modal-scale body intersects the virtual canvas (or relative under on-canvas tree). */
export function hasOnCanvasModalBody(
  byId: Map<number, UiPoseRow>,
  vw = VIRTUAL_UI_WIDTH,
  vh = VIRTUAL_UI_HEIGHT
): boolean {
  for (const r of byId.values()) {
    if (uiPoseHidden(r)) continue
    if (!uiPoseIsModal(r, vw, vh)) continue
    if (r.abs) {
      if (r.left < vw - 8 && r.top < vh - 8 && r.left + r.w > 8 && r.top + r.h > 8) {
        return true
      }
    } else {
      // Relative modal under shell — Yoga places inside parent; raw left/top often 0.
      return true
    }
  }
  return false
}

/**
 * @deprecated Always false. Modal area heuristics must not block open settle.
 */
export function isNoVisibleModalOnCanvas(
  _byId: Map<number, UiPoseRow>,
  _vw = VIRTUAL_UI_WIDTH,
  _vh = VIRTUAL_UI_HEIGHT
): boolean {
  return false
}

/** Modal-sized panel already on virtual canvas (shell-ready for micro content coop). */
export function isModalShellOnCanvas(
  byId: Map<number, UiPoseRow>,
  vw = VIRTUAL_UI_WIDTH,
  vh = VIRTUAL_UI_HEIGHT
): boolean {
  for (const r of byId.values()) {
    if (uiPoseHidden(r)) continue
    if (!uiPoseIsModal(r, vw, vh)) continue
    if (r.abs) {
      if (r.left < vw - 8 && r.top < vh - 8 && r.left + r.w > 8 && r.top + r.h > 8) {
        return true
      }
    } else if (r.left < vw && r.top < vh) {
      return true
    }
  }
  return false
}

export type OpenPoseBlockedOptions = {
  /** @deprecated Ignored — size/PX open gates removed. */
  portableExperience?: boolean
}

/**
 * Size-based mid-open is dead. Always false — flush/open-scale must not wait on panel area.
 */
export function isOpenPoseBlocked(
  _byId: Map<number, UiPoseRow>,
  _opts?: OpenPoseBlockedOptions
): boolean {
  return false
}

export type OpenPoseReadyOptions = {
  /** Fingerprint stable for N passes — when false, never ready. */
  fingerprintStable?: boolean
  /** @deprecated Ignored. */
  mountJustGrew?: boolean
}

/**
 * poseReady := fingerprintStable only (no size geometry).
 */
export function isOpenPoseReady(
  byId: Map<number, UiPoseRow>,
  opts?: OpenPoseReadyOptions & OpenPoseBlockedOptions
): boolean {
  if (opts?.fingerprintStable === false) return false
  return !isOpenPoseBlocked(byId, opts)
}

/** needsOpenScale — always false; size geometry no longer drives open-scale. */
export function needsOpenScale(
  _needOpenSettle: boolean,
  _byId: Map<number, UiPoseRow>,
  _opts?: OpenPoseBlockedOptions
): boolean {
  return false
}

/** QA sample for logs. */
export function sampleOpenPoseBlockedFlags(
  _byId: Map<number, UiPoseRow>,
  _opts?: OpenPoseBlockedOptions
): string {
  return 'ready'
}

export function sampleOpenPoseMicroSeeds(
  _byId: Map<number, UiPoseRow>,
  _limit = 4
): string {
  return '(none)'
}
