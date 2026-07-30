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
 * After worker open settle, two large absolute modal roots can overlap on-screen:
 * empty color-only shell + texture-rich content. Zero the lean twin so icons paint.
 *
 * COD:
 * - Never suppress while a twin is still parked off-right (that blanked the only
 *   visible shell and left PE-only ghosts on second open).
 * - No pose invent — content keeps ECS left; worker flush unparks before snapshot.
 * - Texture count only (purple slots also have UiBackground color).
 */
export function suppressEmptyOverlappingModalTwin(
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
  const roots = forest.get(CANVAS_ROOT_ENTITY as Entity) ?? []
  type Info = { entity: Entity; box: LayoutBox; tex: number; ids: Set<Entity> }
  const large: Info[] = []
  const walk = (e: Entity, ids: Set<Entity>): number => {
    ids.add(e)
    const bg = backgroundOf?.(e) ?? null
    let n = texOf(bg) ? 1 : 0
    for (const c of forest.get(e) ?? []) n += walk(c, ids)
    return n
  }
  for (const r of roots) {
    const box = byEntity.get(r)
    if (!box || box.width < 800 || box.height < 400) continue
    const t = transformOf(r)
    if (!t || normalizeYGPositionType(t.positionType) !== YGPositionType.ABSOLUTE) continue
    if (box.width >= virtual.width * 0.95) continue
    const ids = new Set<Entity>()
    large.push({ entity: r, box, tex: walk(r, ids), ids })
  }
  if (large.length < 2) return 0
  const vw = virtual.width
  // Content still parked off-right → do nothing (shell must stay paint/hit until unpark).
  if (large.some((x) => x.box.left >= vw - 1)) return 0
  const on = large.filter((x) => x.box.left >= -40 && x.box.left < vw - 80)
  if (on.length < 2) return 0
  const sorted = [...on].sort((a, b) => b.tex - a.tex)
  const content = sorted[0]!
  const shell = sorted[1]!
  const overlap =
    Math.abs(content.box.left - shell.box.left) < 120 &&
    Math.abs(content.box.top - shell.box.top) < 120
  if (!overlap) return 0
  // Content must clearly win on *textures* (icons), not purple slot color fills.
  if (content.tex < 8) return 0
  if (content.tex < shell.tex + 5) return 0
  if (shell.tex >= content.tex * 0.5 && shell.tex > 3) return 0

  let n = 0
  for (const b of boxes) {
    if (!shell.ids.has(b.entity)) continue
    b.width = 0
    b.height = 0
    n++
  }
  return n
}
