import type { Entity } from '@dcl/ecs'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'
import type { LayoutBox } from './yogaLayout'
import { YGPositionType, YGUnit, normalizeYGPositionType } from './yogaEnums'
import { CANVAS_ROOT_ENTITY } from './uiTree'
import type { VirtualCanvasSize } from './virtualCanvas'

/**
 * Fast re-layout for **absolute** nodes when only size/position change (fishing reeling bars).
 * Full Yoga is too expensive every tick during cast/reel.
 *
 * Non-absolute dirties are **skipped** (keep previous box) so a single flex life-bar
 * text/layout dirty does not force full Yoga on 100+ nodes (COD: no thrash).
 * Callers should only pass layout-dirty entities when possible.
 */
export function tryRefineAbsoluteLayoutBoxes(
  prev: ReadonlyMap<Entity, LayoutBox>,
  dirty: readonly Entity[],
  transformOf: (e: Entity) => PBUiTransform | null,
  virtual: VirtualCanvasSize
): Map<Entity, LayoutBox> | null {
  if (!dirty.length || !prev.size) return null

  // Flex/relative/display/parent dirties and brand-new nodes need full Yoga.
  // Silently keeping a stale prev box (old behavior) left shop roots box-less after
  // display:none → flex, so SceneUiDomRenderer hid entire inventory subtrees.
  for (const entity of dirty) {
    const t = transformOf(entity)
    if (!t) return null
    if (normalizeYGPositionType(t.positionType) !== YGPositionType.ABSOLUTE) return null
    if (!prev.has(entity)) return null
  }

  const next = new Map(prev)
  let refinedAny = false

  const parentBox = (parentId: number): LayoutBox | null => {
    if (parentId === 0 || parentId === (CANVAS_ROOT_ENTITY as number)) {
      return {
        entity: CANVAS_ROOT_ENTITY,
        left: 0,
        top: 0,
        relLeft: 0,
        relTop: 0,
        width: virtual.width,
        height: virtual.height
      }
    }
    return next.get(parentId as Entity) ?? prev.get(parentId as Entity) ?? null
  }

  // Parents before children when possible (dirty order often DFS).
  const ordered = [...dirty].sort((a, b) => {
    const ta = transformOf(a)
    const tb = transformOf(b)
    const pa = (ta?.parent ?? 0) as number
    const pb = (tb?.parent ?? 0) as number
    if (pa === (b as number)) return 1
    if (pb === (a as number)) return -1
    return (a as number) - (b as number)
  })

  for (const entity of ordered) {
    const t = transformOf(entity)
    if (!t) return null

    const parentId = (t.parent ?? CANVAS_ROOT_ENTITY) as number
    const pb = parentBox(parentId)
    if (!pb || pb.width <= 0 || pb.height <= 0) return null

    const w = resolveSize(t.width, t.widthUnit, pb.width)
    const h = resolveSize(t.height, t.heightUnit, pb.height)
    if (w == null || h == null) return null

    const leftEdge = resolveEdge(t.positionLeft, t.positionLeftUnit, pb.width)
    const rightEdge = resolveEdge(t.positionRight, t.positionRightUnit, pb.width)
    const topEdge = resolveEdge(t.positionTop, t.positionTopUnit, pb.height)
    const bottomEdge = resolveEdge(t.positionBottom, t.positionBottomUnit, pb.height)

    let relLeft = 0
    let relTop = 0
    if (leftEdge != null) relLeft = leftEdge
    else if (rightEdge != null) relLeft = pb.width - rightEdge - w
    else relLeft = 0

    if (topEdge != null) relTop = topEdge
    else if (bottomEdge != null) relTop = pb.height - bottomEdge - h
    else relTop = 0

    next.set(entity, {
      entity,
      left: pb.left + relLeft,
      top: pb.top + relTop,
      relLeft,
      relTop,
      width: Math.max(0, w),
      height: Math.max(0, h)
    })
    refinedAny = true
  }
  return refinedAny ? next : null
}

function resolveSize(
  value: number | undefined,
  unit: number | undefined,
  parentSize: number
): number | null {
  const u = unit ?? YGUnit.UNDEFINED
  const v = value ?? 0
  if (u === YGUnit.PERCENT) return (parentSize * v) / 100
  if (u === YGUnit.POINT || (u === YGUnit.UNDEFINED && v > 0)) return v
  // AUTO / undefined 0 — need Yoga measure
  return null
}

function resolveEdge(
  value: number | undefined,
  unit: number | undefined,
  parentSize: number
): number | null {
  const u = unit ?? YGUnit.UNDEFINED
  if (u === YGUnit.UNDEFINED || u === YGUnit.AUTO) return null
  const v = value ?? 0
  if (u === YGUnit.PERCENT) return (parentSize * v) / 100
  if (u === YGUnit.POINT) return v
  return null
}

/**
 * Repair 0×0 boxes **only** from authored resolvable geometry (SCENE_UI_COD).
 *
 * Yoga owns AUTO icon measure (`applyBackgroundMinSize` + expand pass). This post-pass
 * must NOT invent fill-parent for AUTO leaves (that ballooned NEW/SOLD-OUT badges).
 *
 * Safe cases only:
 *  1. Explicit POINT / PERCENT width×height
 *  2. Opposite edges (left+right / top+bottom) define the box
 *  3. PERCENT ≥ 90 on an axis under a *slot-sized* parent (authored full-bleed %)
 *
 * Multi-pass so parent repairs unlock child % sizes.
 */
export function repairCollapsedLayoutBoxes(
  boxes: LayoutBox[],
  transformOf: (e: Entity) => PBUiTransform | null,
  virtual: VirtualCanvasSize
): number {
  if (!boxes.length) return 0
  const byEntity = new Map<Entity, LayoutBox>()
  for (const b of boxes) byEntity.set(b.entity, b)

  const parentBox = (parentId: number): LayoutBox | null => {
    if (parentId === 0 || parentId === (CANVAS_ROOT_ENTITY as number)) {
      return {
        entity: CANVAS_ROOT_ENTITY,
        left: 0,
        top: 0,
        relLeft: 0,
        relTop: 0,
        width: virtual.width,
        height: virtual.height
      }
    }
    return byEntity.get(parentId as Entity) ?? null
  }

  let repaired = 0
  const ordered = [...boxes].sort((a, b) => (a.entity as number) - (b.entity as number))

  const repairOne = (box: LayoutBox): boolean => {
    if (box.width > 0.5 && box.height > 0.5) return false
    const t = transformOf(box.entity)
    if (!t) return false
    const parentId = (t.parent ?? CANVAS_ROOT_ENTITY) as number
    const pb = parentBox(parentId)
    if (!pb || pb.width < 1 || pb.height < 1) return false

    let w = resolveSize(t.width, t.widthUnit, pb.width)
    let h = resolveSize(t.height, t.heightUnit, pb.height)

    const leftEdge = resolveEdge(t.positionLeft, t.positionLeftUnit, pb.width)
    const rightEdge = resolveEdge(t.positionRight, t.positionRightUnit, pb.width)
    const topEdge = resolveEdge(t.positionTop, t.positionTopUnit, pb.height)
    const bottomEdge = resolveEdge(t.positionBottom, t.positionBottomUnit, pb.height)

    // Opposite edges define size (authored inset fill).
    if ((w == null || w <= 0.5) && leftEdge != null && rightEdge != null) {
      w = Math.max(0, pb.width - leftEdge - rightEdge)
    }
    if ((h == null || h <= 0.5) && topEdge != null && bottomEdge != null) {
      h = Math.max(0, pb.height - topEdge - bottomEdge)
    }

    // Authored % ≥ 90 under a slot cell only — never AUTO invent, never under modal panels.
    const parentIsSlotCell =
      pb.width >= 24 && pb.height >= 24 && pb.width <= 200 && pb.height <= 200
    const widthUnit = t.widthUnit ?? YGUnit.UNDEFINED
    const heightUnit = t.heightUnit ?? YGUnit.UNDEFINED
    const isAbs = normalizeYGPositionType(t.positionType) === YGPositionType.ABSOLUTE
    if (parentIsSlotCell) {
      if ((w == null || w <= 0.5) && widthUnit === YGUnit.PERCENT && (t.width ?? 0) >= 90) {
        w = (pb.width * (t.width ?? 100)) / 100
      }
      if ((h == null || h <= 0.5) && heightUnit === YGUnit.PERCENT && (t.height ?? 0) >= 90) {
        h = (pb.height * (t.height ?? 100)) / 100
      }
    }

    // AUTO absolute leaves: leave for Yoga measure — do not fill parent here.
    if (w == null || h == null || w <= 0.5 || h <= 0.5) return false

    let relLeft = box.relLeft
    let relTop = box.relTop
    if (leftEdge != null) relLeft = leftEdge
    else if (rightEdge != null) relLeft = pb.width - rightEdge - w
    else if (isAbs && (widthUnit === YGUnit.PERCENT || (leftEdge == null && rightEdge == null))) {
      if (box.width <= 0.5 && box.height <= 0.5 && Math.abs(box.relLeft) < 0.5) relLeft = 0
    }

    if (topEdge != null) relTop = topEdge
    else if (bottomEdge != null) relTop = pb.height - bottomEdge - h
    else if (isAbs && (heightUnit === YGUnit.PERCENT || (topEdge == null && bottomEdge == null))) {
      if (box.width <= 0.5 && box.height <= 0.5 && Math.abs(box.relTop) < 0.5) relTop = 0
    }

    box.relLeft = relLeft
    box.relTop = relTop
    box.left = pb.left + relLeft
    box.top = pb.top + relTop
    box.width = Math.max(0, w)
    box.height = Math.max(0, h)
    byEntity.set(box.entity, box)
    return true
  }

  for (let pass = 0; pass < 4; pass++) {
    let passRepaired = 0
    for (const box of ordered) {
      if (repairOne(box)) passRepaired++
    }
    repaired += passRepaired
    if (passRepaired === 0) break
  }
  return repaired
}

/** Count visible boxes that are still collapsed (0×0) — gate for patch-vs-full paint. */
export function countCollapsedLayoutBoxes(boxes: Iterable<LayoutBox>): number {
  let n = 0
  for (const b of boxes) {
    if (b.width <= 0.5 || b.height <= 0.5) n++
  }
  return n
}

/**
 * Fishing shop dual absolute modal panels (and similar):
 *   - empty chrome shell already on-screen (left≈346, color slots, PE block)
 *   - texture-rich content twin still at left≥1920 (icons / X / grids)
 *
 * Inject path skips exports.onUpdate, so open tweens often never leave park during
 * mesh/sceneUi flush — eng.update(dt) alone freezes dual pose. Yoga then fully-off-hides
 * content and paints an empty PE shell ("open does nothing").
 *
 * Resolve **one visible modal** for paint+hit-map:
 *   1. Translate contentful subtree onto shell origin (layout boxes only — ECS unchanged)
 *   2. Collapse lean shell so it cannot ghost over icons
 *
 * Texture count only (purple slots have UiBackground color without icons).
 * Scans all large absolute boxes (content may nest under an intermediate parent).
 */
export function alignParkedModalTwinBoxes(
  boxes: LayoutBox[],
  forest: ReadonlyMap<Entity, Entity[]>,
  transformOf: (e: Entity) => PBUiTransform | null,
  backgroundOf: ((e: Entity) => { texture?: unknown } | null | undefined) | null | undefined,
  virtual: VirtualCanvasSize,
  hasTexture?: (bg: { texture?: unknown } | null | undefined) => boolean
): number {
  if (!boxes.length) return 0
  const texOf = hasTexture ?? ((bg) => !!(bg && bg.texture))
  const byEntity = new Map<Entity, LayoutBox>()
  for (const b of boxes) byEntity.set(b.entity, b)

  type Info = { entity: Entity; box: LayoutBox; tex: number; ids: Set<Entity> }
  const walk = (e: Entity, ids: Set<Entity>): number => {
    ids.add(e)
    const bg = backgroundOf?.(e) ?? null
    let n = texOf(bg) ? 1 : 0
    for (const c of forest.get(e) ?? []) n += walk(c, ids)
    return n
  }

  const large: Info[] = []
  const seen = new Set<Entity>()
  for (const box of boxes) {
    if (box.width < 800 || box.height < 400) continue
    // Skip near-fullscreen scrims (they are not shop panels).
    if (box.width >= virtual.width * 0.95) continue
    if (seen.has(box.entity)) continue
    const t = transformOf(box.entity)
    if (!t || normalizeYGPositionType(t.positionType) !== YGPositionType.ABSOLUTE) continue
    const ids = new Set<Entity>()
    const tex = walk(box.entity, ids)
    for (const id of ids) seen.add(id)
    large.push({ entity: box.entity, box, tex, ids })
  }
  if (large.length < 2) return 0

  const vw = virtual.width
  const vh = virtual.height
  const onScreen = large.filter(
    (r) => r.box.left >= -40 && r.box.left < vw - 80 && r.box.top < vh - 40
  )
  const offRight = large.filter((r) => r.box.left >= vw - 1)

  let content: Info | null = null
  let shell: Info | null = null

  if (onScreen.length && offRight.length) {
    content = [...offRight].sort((a, b) => b.tex - a.tex)[0]!
    shell = [...onScreen].sort((a, b) => a.tex - b.tex || a.box.left - b.box.left)[0]!
  } else if (onScreen.length >= 2) {
    // Both unparked / overlapping — keep texture-rich, collapse lean chrome.
    const sorted = [...onScreen].sort((a, b) => b.tex - a.tex)
    content = sorted[0]!
    shell = sorted[1]!
    const overlap =
      Math.abs(content.box.left - shell.box.left) < 120 &&
      Math.abs(content.box.top - shell.box.top) < 120
    if (!overlap) return 0
  } else {
    return 0
  }

  // Content must clearly win on *textures* (icons), not purple slot color fills.
  if (content.tex < 8) return 0
  if (content.tex < shell.tex + 5) return 0

  let n = 0
  const dx = shell.box.left - content.box.left
  const dy = shell.box.top - content.box.top
  if (Math.abs(dx) >= 8 || Math.abs(dy) >= 8) {
    for (const b of boxes) {
      if (!content.ids.has(b.entity)) continue
      b.left += dx
      b.top += dy
      n++
    }
  }

  // Collapse empty/lean shell so dual chrome + PE ghost cannot cover content.
  if (shell.tex < content.tex * 0.5 || shell.tex <= 3) {
    for (const b of boxes) {
      if (!shell.ids.has(b.entity)) continue
      b.width = 0
      b.height = 0
      n++
    }
  }
  return n
}
