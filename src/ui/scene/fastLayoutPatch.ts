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
    if (!t) continue
    // Flex/relative dirties keep previous box — do not poison the whole refine.
    if (normalizeYGPositionType(t.positionType) !== YGPositionType.ABSOLUTE) continue

    const parentId = (t.parent ?? CANVAS_ROOT_ENTITY) as number
    const pb = parentBox(parentId)
    if (!pb || pb.width <= 0 || pb.height <= 0) continue

    const w = resolveSize(t.width, t.widthUnit, pb.width)
    const h = resolveSize(t.height, t.heightUnit, pb.height)
    if (w == null || h == null) continue

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
  return refinedAny || dirty.length > 0 ? next : null
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
