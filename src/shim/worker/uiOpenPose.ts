/**
 * Scene UI open pose readiness — pure geometry law (SCENE_UI_COD + cod_prompt).
 *
 * Single authority for: flush exit, needsOpenScale, open-scale finish, cooperative mid-open.
 * No menu kinds, no timestamp oracles, no twinAlign.
 *
 * poseReady :=
 *   NOT dualParkedAbsLeftPastVirtualWidth
 *   AND NOT trueScaleSeed
 *   AND (if mountJustGrew: some modal body intersects virtual canvas OR no modalish at all)
 */

export const VIRTUAL_UI_WIDTH = 1920
export const VIRTUAL_UI_HEIGHT = 1080

/** Epsilon for virtual-edge dual-root (1px — not a product strip policy). */
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
 * Dual-root **open** still mid-flight: on-canvas shell + off-canvas content twin.
 *
 * Uses **canvas-accumulated** abs origin (parent chain), not local top/left alone.
 * Shop pattern: shell on canvas + twin at left ≥ VW (e.g. @2146).
 *
 * **Not** dual-root open (do not block settle / PE UI forever):
 * - Permanent below-fold HUD chrome (inventory @y=1227) alone — Neurolink/PX peOff strips
 * - Full-bleed HUD strips (w≥VW)
 * - Near-fullscreen scrims
 */
export function isDualRootParked(
  byId: Map<number, UiPoseRow>,
  vw = VIRTUAL_UI_WIDTH,
  vh = VIRTUAL_UI_HEIGHT
): boolean {
  let hasParkedTwin = false
  let hasOnCanvasShell = false

  for (const [id, r] of byId) {
    if (uiPoseHidden(r)) continue
    // Full-bleed HUD strips (1920×86) — not open content.
    if (r.w >= vw - 20) continue
    // Ignore pin dots / tiny chrome; keep inventory slots (~110) and shop twins.
    if (r.w < 48 || r.h < 48) continue

    const origin = canvasAbsOrigin(byId, id)
    // Near-fullscreen scrim covering the virtual canvas (not an off-canvas twin).
    const coversCanvas =
      origin.left < vw * 0.15 &&
      origin.top < vh * 0.15 &&
      origin.left + r.w > vw * 0.85 &&
      origin.top + r.h > vh * 0.85
    if (coversCanvas) continue

    const intersectsCanvas =
      origin.left < vw - 8 &&
      origin.top < vh - 8 &&
      origin.left + r.w > 8 &&
      origin.top + r.h > 8

    // On-canvas modal / large panel = open shell candidate.
    if (
      intersectsCanvas &&
      (uiPoseIsModal(r, vw, vh) || (r.w >= 200 && r.h >= 160))
    ) {
      hasOnCanvasShell = true
    }

    // Shop dual-root twin: parked to the **side** of the virtual canvas (not pure below-fold).
    // Pure below-fold (top ≥ VH) is permanent inventory chrome — Neurolink/PX peOff @y=1227.
    if (origin.left >= vw - DUAL_ROOT_EDGE_EPS) hasParkedTwin = true
    if (origin.left + r.w <= DUAL_ROOT_EDGE_EPS) hasParkedTwin = true
  }

  return hasParkedTwin && hasOnCanvasShell
}

/**
 * True while scale-from-zero open is in flight (canvas-fraction geometry only).
 */
export function isScaleSeedOpen(
  byId: Map<number, UiPoseRow>,
  vw = VIRTUAL_UI_WIDTH,
  vh = VIRTUAL_UI_HEIGHT
): boolean {
  let scaleMicro = 0
  let microAbsLoose = 0
  let fullAbs = 0
  for (const [id, r] of byId) {
    if (uiPoseHidden(r)) continue
    const kids = uiPoseChildCount(byId, id)
    const aspect = Math.max(r.w, r.h) / Math.max(1, Math.min(r.w, r.h))
    if (
      !r.abs &&
      kids >= 2 &&
      !uiPoseIsModal(r, vw, vh) &&
      aspect < 4 &&
      r.w >= 2 &&
      r.h >= 2 &&
      uiPoseHasModalAncestor(byId, r.parent)
    ) {
      let p = r.parent
      let parentRow: UiPoseRow | undefined
      for (let g = 0; p && g < 16; g++) {
        parentRow = byId.get(p)
        if (!parentRow) break
        if (!uiPoseHidden(parentRow) && uiPoseIsModal(parentRow, vw, vh)) break
        p = parentRow.parent
        parentRow = undefined
      }
      if (parentRow) {
        const fracW = r.w / Math.max(1, parentRow.w)
        const fracH = r.h / Math.max(1, parentRow.h)
        if (fracW < 0.08 && fracH < 0.08) {
          scaleMicro++
          continue
        }
      }
    }
    if (uiPoseIsScaleSeed(r, vw, vh) && r.abs) {
      const cx = r.left + r.w / 2
      const cy = r.top + r.h / 2
      if (Math.abs(cx - vw / 2) < vw * 0.25 && Math.abs(cy - vh / 2) < vh * 0.33 && kids >= 1) {
        scaleMicro++
        continue
      }
    }
    if (r.abs && uiPoseIsMicro(r, vw, vh) && !uiPoseIsScaleSeed(r, vw, vh)) {
      microAbsLoose++
    } else if (r.abs && uiPoseIsModal(r, vw, vh)) {
      fullAbs++
    }
  }
  if (scaleMicro > 0) return true
  return microAbsLoose > 0 && fullAbs === 0
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
 * Modalish panels exist but none are paint-visible on the virtual canvas.
 * (Complement of hasOnCanvasModalBody when modalish > 0.)
 */
export function isNoVisibleModalOnCanvas(
  byId: Map<number, UiPoseRow>,
  vw = VIRTUAL_UI_WIDTH,
  vh = VIRTUAL_UI_HEIGHT
): boolean {
  let modalish = 0
  let shown = 0
  for (const r of byId.values()) {
    if (!uiPoseIsModal(r, vw, vh)) continue
    modalish++
    if (uiPoseHidden(r)) continue
    shown++
  }
  if (modalish === 0) return false
  if (shown === 0) return true
  return !hasOnCanvasModalBody(byId, vw, vh)
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
  /**
   * Portable experience (PX) workers: permanent off-canvas HUD chrome is normal.
   * Do **not** use plaza `isNoVisibleModalOnCanvas` — it keeps Neurolink "still mid-open"
   * forever and leaves menu PE handlers display:none / unclickable after icon inject.
   */
  portableExperience?: boolean
}

/**
 * Open pose blocked (mid-open): dual-park OR scale seed OR (primary only) no visible modal.
 * Used for needsOpenScale / flush refuse-exit / cooperative midOpen.
 */
export function isOpenPoseBlocked(
  byId: Map<number, UiPoseRow>,
  opts?: OpenPoseBlockedOptions
): boolean {
  if (isDualRootParked(byId) || isScaleSeedOpen(byId)) return true
  if (opts?.portableExperience) return false
  return isNoVisibleModalOnCanvas(byId)
}

export type OpenPoseReadyOptions = {
  /** Fingerprint stable for N passes — when false, never ready. */
  fingerprintStable?: boolean
  /**
   * @deprecated Ignored — poseReady is exact complement of isOpenPoseBlocked when
   * fingerprint is stable. Kept so call sites compile during migration.
   */
  mountJustGrew?: boolean
}

/**
 * SINGLE open-pose-ready law (fail closed).
 *
 * poseReady := fingerprintStable AND NOT isOpenPoseBlocked
 * (blocked = dualParked | scaleSeed | noVisibleModal)
 *
 * Exact complement of isOpenPoseBlocked when fingerprintStable !== false —
 * one surface for flush skip, needsOpenScale, open-scale finish.
 */
export function isOpenPoseReady(
  byId: Map<number, UiPoseRow>,
  opts?: OpenPoseReadyOptions & OpenPoseBlockedOptions
): boolean {
  if (opts?.fingerprintStable === false) return false
  return !isOpenPoseBlocked(byId, opts)
}

/** needsOpenScale := needOpenSettle AND NOT poseReady (fail closed). */
export function needsOpenScale(
  needOpenSettle: boolean,
  byId: Map<number, UiPoseRow>,
  opts?: OpenPoseBlockedOptions
): boolean {
  return needOpenSettle && isOpenPoseBlocked(byId, opts)
}

/** QA sample for logs. */
export function sampleOpenPoseBlockedFlags(
  byId: Map<number, UiPoseRow>,
  opts?: OpenPoseBlockedOptions
): string {
  const parts: string[] = []
  if (isDualRootParked(byId)) parts.push('dualRootParked')
  if (isScaleSeedOpen(byId)) parts.push('micro')
  if (!opts?.portableExperience && isNoVisibleModalOnCanvas(byId)) {
    parts.push('noVisibleModal')
  }
  return parts.length ? parts.join('+') : 'ready'
}

export function sampleOpenPoseMicroSeeds(
  byId: Map<number, UiPoseRow>,
  limit = 4
): string {
  const vw = VIRTUAL_UI_WIDTH
  const vh = VIRTUAL_UI_HEIGHT
  const samples: string[] = []
  for (const [id, r] of byId) {
    if (uiPoseHidden(r)) continue
    const kids = uiPoseChildCount(byId, id)
    if (
      !r.abs &&
      kids >= 2 &&
      !uiPoseIsModal(r, vw, vh) &&
      uiPoseHasModalAncestor(byId, r.parent)
    ) {
      let p = r.parent
      let parentRow: UiPoseRow | undefined
      for (let g = 0; p && g < 16; g++) {
        parentRow = byId.get(p)
        if (!parentRow) break
        if (!uiPoseHidden(parentRow) && uiPoseIsModal(parentRow, vw, vh)) break
        p = parentRow.parent
        parentRow = undefined
      }
      if (
        parentRow &&
        r.w / Math.max(1, parentRow.w) < 0.08 &&
        r.h / Math.max(1, parentRow.h) < 0.08
      ) {
        samples.push(`e${id}:${Math.round(r.w)}×${Math.round(r.h)} kids=${kids} relSeed`)
        if (samples.length >= limit) break
      }
    }
  }
  if (samples.length < limit && isDualRootParked(byId)) samples.push('dualRootParked')
  if (samples.length < limit && isNoVisibleModalOnCanvas(byId)) samples.push('noVisibleModal')
  return samples.length ? samples.join('; ') : '(none)'
}
