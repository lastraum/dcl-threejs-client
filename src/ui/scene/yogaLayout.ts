import type { Entity } from '@dcl/ecs'
import type { PBUiBackground } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_background.gen'
import type { PBUiInput } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_input.gen'
import type { PBUiText } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_text.gen'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'
import Yoga from 'yoga-layout-prebuilt'
import { CANVAS_ROOT_ENTITY, type UiEntityRecord } from './uiTree'
import { measureUiText } from './uiTextMeasure'
import {
  YGAlign,
  isYGDisplayNone,
  YGFlexDirection,
  YGJustify,
  YGOverflow,
  YGPositionType,
  YGUnit,
  YGWrap,
  normalizeYGAlign,
  normalizeYGFlexDirection,
  normalizeYGJustify,
  normalizeYGPositionType
} from './yogaEnums'

export type LayoutBox = {
  entity: Entity
  /** Canvas-absolute virtual px (flat hit-test / debug). */
  left: number
  top: number
  /** Parent-relative virtual px (nested DOM geometry). */
  relLeft: number
  relTop: number
  width: number
  height: number
}

type YogaNode = ReturnType<typeof Yoga.Node.create>

const FLEX_DIR: Record<number, number> = {
  [YGFlexDirection.ROW]: Yoga.FLEX_DIRECTION_ROW,
  [YGFlexDirection.COLUMN]: Yoga.FLEX_DIRECTION_COLUMN,
  [YGFlexDirection.COLUMN_REVERSE]: Yoga.FLEX_DIRECTION_COLUMN_REVERSE,
  [YGFlexDirection.ROW_REVERSE]: Yoga.FLEX_DIRECTION_ROW_REVERSE
}

const JUSTIFY: Record<number, number> = {
  [YGJustify.FLEX_START]: Yoga.JUSTIFY_FLEX_START,
  [YGJustify.CENTER]: Yoga.JUSTIFY_CENTER,
  [YGJustify.FLEX_END]: Yoga.JUSTIFY_FLEX_END,
  [YGJustify.SPACE_BETWEEN]: Yoga.JUSTIFY_SPACE_BETWEEN,
  [YGJustify.SPACE_AROUND]: Yoga.JUSTIFY_SPACE_AROUND,
  [YGJustify.SPACE_EVENLY]: Yoga.JUSTIFY_SPACE_EVENLY
}

const ALIGN: Record<number, number> = {
  [YGAlign.AUTO]: Yoga.ALIGN_AUTO,
  [YGAlign.FLEX_START]: Yoga.ALIGN_FLEX_START,
  [YGAlign.CENTER]: Yoga.ALIGN_CENTER,
  [YGAlign.FLEX_END]: Yoga.ALIGN_FLEX_END,
  [YGAlign.STRETCH]: Yoga.ALIGN_STRETCH,
  [YGAlign.BASELINE]: Yoga.ALIGN_BASELINE,
  [YGAlign.SPACE_BETWEEN]: Yoga.ALIGN_SPACE_BETWEEN,
  [YGAlign.SPACE_AROUND]: Yoga.ALIGN_SPACE_AROUND
}

const WRAP: Record<number, number> = {
  [YGWrap.NO_WRAP]: Yoga.WRAP_NO_WRAP,
  [YGWrap.WRAP]: Yoga.WRAP_WRAP,
  [YGWrap.WRAP_REVERSE]: Yoga.WRAP_WRAP_REVERSE
}

const OVERFLOW: Record<number, number> = {
  [YGOverflow.VISIBLE]: Yoga.OVERFLOW_VISIBLE,
  [YGOverflow.HIDDEN]: Yoga.OVERFLOW_HIDDEN,
  [YGOverflow.SCROLL]: Yoga.OVERFLOW_SCROLL
}

function applyUnit(
  set: (n: number) => void,
  setPct: (n: number) => void,
  setAuto: () => void,
  unit: number | undefined,
  value: number | undefined
): void {
  const u = unit ?? YGUnit.UNDEFINED
  const v = value ?? 0
  if (u === YGUnit.AUTO) {
    setAuto()
    return
  }
  if (u === YGUnit.PERCENT) {
    setPct(v)
    return
  }
  if (u === YGUnit.POINT) {
    set(v)
    return
  }
  // UNDEFINED + numeric value — react-ecs always sets an explicit unit; treat as points.
  if (v !== 0) set(v)
}

function applyEdge(
  node: YogaNode,
  edge: number,
  unit: number | undefined,
  value: number | undefined,
  kind: 'margin' | 'padding' | 'position'
): void {
  const u = unit ?? YGUnit.UNDEFINED
  const v = value ?? 0
  if (kind === 'margin') {
    if (u === YGUnit.AUTO) node.setMarginAuto(edge)
    else if (u === YGUnit.PERCENT) node.setMarginPercent(edge, v)
    else if (u === YGUnit.POINT) node.setMargin(edge, v)
    else if (v !== 0) node.setMargin(edge, v)
    return
  }
  if (kind === 'padding') {
    if (u === YGUnit.PERCENT) node.setPaddingPercent(edge, v)
    else if (u === YGUnit.POINT) node.setPadding(edge, v)
    else if (v !== 0) node.setPadding(edge, v)
    return
  }
  if (u === YGUnit.PERCENT) node.setPositionPercent(edge, v)
  else if (u === YGUnit.POINT) node.setPosition(edge, v)
  else if (v !== 0) node.setPosition(edge, v)
}

/** True when UiTransform gives Yoga a concrete horizontal size (points or %). */
function hasExplicitWidth(t: PBUiTransform | null | undefined): boolean {
  if (!t) return false
  const u = t.widthUnit ?? YGUnit.UNDEFINED
  if (u === YGUnit.PERCENT) return true
  if (u === YGUnit.POINT && (t.width ?? 0) > 0) return true
  return false
}

function applyTextMinSize(
  node: YogaNode,
  text: PBUiText | null | undefined,
  transform?: PBUiTransform | null
): void {
  if (!text?.value?.trim()) return
  // TW_NO_WRAP = 1; default / TW_WRAP = 0 / unset → wrap (SDK default TW_WRAP).
  const noWrap = text.textWrap === 1
  const measured = measureUiText(text, 1)
  if (measured.height > 0) node.setMinHeight(measured.height)
  if (measured.width <= 0) return

  if (noWrap) {
    // Single line: intrinsic width is the unwrapped run.
    node.setMinWidth(measured.width)
    return
  }

  // Wrap + explicit width (e.g. width: '100%'): let the node shrink to the parent.
  // minWidth = full unwrapped measure overflows long paragraphs (Planetangzaar, etc.).
  if (hasExplicitWidth(transform)) return

  // Wrap + auto/undefined width under alignItems:center (RickRoll CREATOR cards, modal titles):
  // without minWidth Yoga collapses the leaf to 0×h — borders paint, labels stay blank.
  node.setMinWidth(measured.width)
}

function applyInputMinSize(node: YogaNode, input: PBUiInput | null | undefined): void {
  if (!input) return
  const fontSize = input.fontSize ?? 10
  node.setMinWidth(120)
  node.setMinHeight(Math.max(28, fontSize * 2.4))
}

/** True when width/height unit is AUTO or undefined (Yoga content-sized). */
function sizeAxisAuto(unit: number | undefined, value: number | undefined): boolean {
  const u = unit ?? YGUnit.UNDEFINED
  if (u === YGUnit.AUTO || u === YGUnit.UNDEFINED) return true
  if (u === YGUnit.POINT && (value ?? 0) <= 0) return true
  return false
}

/** True when this edge is not authored (undefined/auto unit). */
function positionEdgeUnset(unit: number | undefined, _value?: number): boolean {
  const u = unit ?? YGUnit.UNDEFINED
  if (u === YGUnit.UNDEFINED || u === YGUnit.AUTO) return true
  // Explicit 0 with a real unit counts as set (e.g. bottom: 0).
  return false
}

/**
 * Corner badges / NEW ribbons / SOLD OUT chips: single-corner pin + AUTO size.
 * Must NOT fill the parent slot (that stretched atlas UVs into diagonal mash on first open).
 *
 * Full-bleed icons: no edges, or opposite edges (left+right / top+bottom), or % size.
 */
function isCornerPinnedAutoBadge(t: PBUiTransform): boolean {
  const left = !positionEdgeUnset(t.positionLeftUnit, t.positionLeft)
  const right = !positionEdgeUnset(t.positionRightUnit, t.positionRight)
  const top = !positionEdgeUnset(t.positionTopUnit, t.positionTop)
  const bottom = !positionEdgeUnset(t.positionBottomUnit, t.positionBottom)
  // Opposite edges define a fill box — not a badge.
  if (left && right) return false
  if (top && bottom) return false
  const edgeCount = (left ? 1 : 0) + (right ? 1 : 0) + (top ? 1 : 0) + (bottom ? 1 : 0)
  // 1–2 edges without an opposite pair = corner/edge pin (badge / ribbon).
  return edgeCount >= 1 && edgeCount <= 2
}

/**
 * Icon leaves with UiBackground + AUTO size collapse to 0×0 (Yoga has no image measure).
 * When the parent transform authors a concrete POINT size in the slot range, fill **only
 * full-bleed** leaves inside Yoga (inventory/vending icons).
 *
 * Never fill corner-pinned AUTO badges — that ballooned rarity/SOLD-OUT atlas cells to the
 * full 110×110 slot (wrong UV crop / diagonal mash on first shop open).
 */
function applyBackgroundMinSize(
  node: YogaNode,
  transform: PBUiTransform,
  parentTransform: PBUiTransform | null | undefined,
  background: PBUiBackground | null | undefined,
  text: PBUiText | null | undefined
): void {
  if (!background) return
  if (text?.value?.trim()) return

  const wAuto = sizeAxisAuto(transform.widthUnit, transform.width)
  const hAuto = sizeAxisAuto(transform.heightUnit, transform.height)
  if (!wAuto && !hAuto) return

  // Parent must author a concrete slot-sized POINT box — never fill under modal panels.
  if (!parentTransform) return
  const pwUnit = parentTransform.widthUnit ?? YGUnit.UNDEFINED
  const phUnit = parentTransform.heightUnit ?? YGUnit.UNDEFINED
  const pw = parentTransform.width ?? 0
  const ph = parentTransform.height ?? 0
  if (pwUnit !== YGUnit.POINT || phUnit !== YGUnit.POINT) return
  if (pw < 24 || ph < 24 || pw > 200 || ph > 200) return

  const isAbs = normalizeYGPositionType(transform.positionType) === YGPositionType.ABSOLUTE
  if (!isAbs && !(wAuto && hAuto)) return
  if (isAbs && isCornerPinnedAutoBadge(transform)) return

  if (wAuto) node.setWidth(pw)
  if (hAuto) node.setHeight(ph)
}

function hasConcreteSize(unit: number | undefined, value: number | undefined): boolean {
  const u = unit ?? YGUnit.UNDEFINED
  if (u === YGUnit.PERCENT) return true
  if (u === YGUnit.POINT && (value ?? 0) > 0) return true
  return false
}

/**
 * Absolute edge quirks for percent-positioned HUD.
 *
 * Genesis Plaza parks idle chrome **off-canvas** with percent edges — do not “flush”
 * those parks onto the visible edge (that leaks movie letterbox + confetti/cake HUD):
 *
 * - Letterbox bottom bar: top:100% + height 8%  (below canvas until cinematic show)
 * - Confetti ammo strip:  bottom:100% + height 162 (above canvas until showUi y→0)
 * - Cake throw strip:     bottom:-20% parked, bottom:0% shown
 *
 * Only keep left/right:100% side-drawer remaps (those are not park-off patterns).
 */
function normalizeAbsoluteEdgeFlush(t: PBUiTransform): {
  topU: number | undefined
  topV: number | undefined
  bottomU: number | undefined
  bottomV: number | undefined
  leftU: number | undefined
  leftV: number | undefined
  rightU: number | undefined
  rightV: number | undefined
} {
  let topU = t.positionTopUnit
  let topV = t.positionTop
  let bottomU = t.positionBottomUnit
  let bottomV = t.positionBottom
  let leftU = t.positionLeftUnit
  let leftV = t.positionLeft
  let rightU = t.positionRightUnit
  let rightV = t.positionRight

  if (normalizeYGPositionType(t.positionType) !== YGPositionType.ABSOLUTE) {
    return { topU, topV, bottomU, bottomV, leftU, leftV, rightU, rightV }
  }

  const left100 =
    (leftU ?? YGUnit.UNDEFINED) === YGUnit.PERCENT && Math.abs((leftV ?? 0) - 100) < 0.01
  const right100 =
    (rightU ?? YGUnit.UNDEFINED) === YGUnit.PERCENT && Math.abs((rightV ?? 0) - 100) < 0.01

  // Right drawer: left 100% alone + has width → right: 0
  if (
    left100 &&
    positionEdgeUnset(rightU, rightV) &&
    hasConcreteSize(t.widthUnit, t.width)
  ) {
    leftU = YGUnit.UNDEFINED
    leftV = 0
    rightU = YGUnit.POINT
    rightV = 0
  }
  // Left drawer: right 100% alone + has width → left: 0
  if (
    right100 &&
    positionEdgeUnset(leftU, leftV) &&
    hasConcreteSize(t.widthUnit, t.width)
  ) {
    rightU = YGUnit.UNDEFINED
    rightV = 0
    leftU = YGUnit.POINT
    leftV = 0
  }

  return { topU, topV, bottomU, bottomV, leftU, leftV, rightU, rightV }
}

function applyUiTransform(node: YogaNode, t: PBUiTransform): void {
  const flexDir = normalizeYGFlexDirection(t.flexDirection)
  const justify = normalizeYGJustify(t.justifyContent)
  const alignItems = normalizeYGAlign(t.alignItems, YGAlign.STRETCH)
  const alignSelf = normalizeYGAlign(t.alignSelf, YGAlign.AUTO)
  node.setFlexDirection(FLEX_DIR[flexDir] ?? Yoga.FLEX_DIRECTION_ROW)
  node.setJustifyContent(JUSTIFY[justify] ?? Yoga.JUSTIFY_FLEX_START)
  node.setAlignItems(ALIGN[alignItems] ?? Yoga.ALIGN_STRETCH)
  node.setAlignSelf(ALIGN[alignSelf] ?? Yoga.ALIGN_AUTO)
  if (t.alignContent !== undefined) {
    node.setAlignContent(ALIGN[t.alignContent] ?? Yoga.ALIGN_FLEX_START)
  }
  node.setFlexWrap(WRAP[t.flexWrap ?? YGWrap.NO_WRAP] ?? Yoga.WRAP_NO_WRAP)
  // Prefer hidden for absolute full-bleed panels so shop layers don't paint over each other.
  const overflow = t.overflow ?? YGOverflow.VISIBLE
  node.setOverflow(OVERFLOW[overflow] ?? Yoga.OVERFLOW_VISIBLE)
  node.setDisplay(isYGDisplayNone(t.display) ? Yoga.DISPLAY_NONE : Yoga.DISPLAY_FLEX)
  // String "absolute" must not fall through to relative (shop HUD piles at wrong origin).
  node.setPositionType(
    normalizeYGPositionType(t.positionType) === YGPositionType.ABSOLUTE
      ? Yoga.POSITION_TYPE_ABSOLUTE
      : Yoga.POSITION_TYPE_RELATIVE
  )

  if (typeof t.flexGrow === 'number') node.setFlexGrow(t.flexGrow)
  // Explicit 0 — Yoga default is 0 but leave clear when authored undefined.
  if (typeof t.flexShrink === 'number') node.setFlexShrink(t.flexShrink)
  else node.setFlexShrink(0)
  applyUnit(
    (n) => node.setFlexBasis(n),
    (n) => node.setFlexBasisPercent(n),
    () => node.setFlexBasisAuto(),
    t.flexBasisUnit,
    t.flexBasis
  )
  applyUnit(
    (n) => node.setWidth(n),
    (n) => node.setWidthPercent(n),
    () => node.setWidthAuto(),
    t.widthUnit,
    t.width
  )
  applyUnit(
    (n) => node.setHeight(n),
    (n) => node.setHeightPercent(n),
    () => node.setHeightAuto(),
    t.heightUnit,
    t.height
  )
  applyUnit(
    (n) => node.setMinWidth(n),
    (n) => node.setMinWidthPercent(n),
    () => {},
    t.minWidthUnit,
    t.minWidth
  )
  applyUnit(
    (n) => node.setMinHeight(n),
    (n) => node.setMinHeightPercent(n),
    () => {},
    t.minHeightUnit,
    t.minHeight
  )
  applyUnit(
    (n) => node.setMaxWidth(n),
    (n) => node.setMaxWidthPercent(n),
    () => {},
    t.maxWidthUnit,
    t.maxWidth
  )
  applyUnit(
    (n) => node.setMaxHeight(n),
    (n) => node.setMaxHeightPercent(n),
    () => {},
    t.maxHeightUnit,
    t.maxHeight
  )

  applyEdge(node, Yoga.EDGE_LEFT, t.marginLeftUnit, t.marginLeft, 'margin')
  applyEdge(node, Yoga.EDGE_TOP, t.marginTopUnit, t.marginTop, 'margin')
  applyEdge(node, Yoga.EDGE_RIGHT, t.marginRightUnit, t.marginRight, 'margin')
  applyEdge(node, Yoga.EDGE_BOTTOM, t.marginBottomUnit, t.marginBottom, 'margin')
  applyEdge(node, Yoga.EDGE_LEFT, t.paddingLeftUnit, t.paddingLeft, 'padding')
  applyEdge(node, Yoga.EDGE_TOP, t.paddingTopUnit, t.paddingTop, 'padding')
  applyEdge(node, Yoga.EDGE_RIGHT, t.paddingRightUnit, t.paddingRight, 'padding')
  applyEdge(node, Yoga.EDGE_BOTTOM, t.paddingBottomUnit, t.paddingBottom, 'padding')

  const edges = normalizeAbsoluteEdgeFlush(t)
  applyEdge(node, Yoga.EDGE_LEFT, edges.leftU, edges.leftV, 'position')
  applyEdge(node, Yoga.EDGE_TOP, edges.topU, edges.topV, 'position')
  applyEdge(node, Yoga.EDGE_RIGHT, edges.rightU, edges.rightV, 'position')
  applyEdge(node, Yoga.EDGE_BOTTOM, edges.bottomU, edges.bottomV, 'position')
}

type YogaTreeNode = {
  entity: Entity
  yoga: YogaNode
  children: YogaTreeNode[]
}

export function layoutUiTree(
  records: UiEntityRecord[],
  childrenOf: Map<Entity, Entity[]>,
  virtualWidth: number,
  virtualHeight: number,
  textOf?: (entity: Entity) => PBUiText | null,
  inputOf?: (entity: Entity) => PBUiInput | null,
  backgroundOf?: (entity: Entity) => PBUiBackground | null
): { boxes: LayoutBox[]; dispose: () => void } {
  const transformOf = new Map<Entity, PBUiTransform>()
  for (const r of records) transformOf.set(r.entity, r.transform)

  const yogaOf = new Map<Entity, YogaNode>()
  const allYoga: YogaNode[] = []

  const build = (entity: Entity): YogaTreeNode => {
    const yoga = Yoga.Node.create()
    allYoga.push(yoga)
    yogaOf.set(entity, yoga)
    const transform = transformOf.get(entity)!
    applyUiTransform(yoga, transform)
    const text = textOf?.(entity) ?? null
    if (textOf) applyTextMinSize(yoga, text, transform)
    if (inputOf) applyInputMinSize(yoga, inputOf(entity))
    // Background minSize after text so labels still own size when both present.
    if (backgroundOf) {
      const parentId = (transform.parent ?? CANVAS_ROOT_ENTITY) as Entity
      const parentT =
        parentId === CANVAS_ROOT_ENTITY || (parentId as number) === 0
          ? null
          : transformOf.get(parentId) ?? null
      applyBackgroundMinSize(yoga, transform, parentT, backgroundOf(entity), text)
    }
    const childEntities = childrenOf.get(entity) ?? []
    const children = childEntities.map((c) => build(c))
    children.forEach((child, index) => yoga.insertChild(child.yoga, index))
    return { entity, yoga, children }
  }

  const roots = childrenOf.get(CANVAS_ROOT_ENTITY) ?? []
  const forest = roots.map((e) => build(e))
  const root = Yoga.Node.create()
  allYoga.push(root)
  // Fixed virtual screen — absolute HUD/shop roots position against this box.
  // Cap max size so relative roots cannot expand the containing block past the canvas
  // (that pushed fishing shop columns to x=2736 / y=1300 off-screen).
  root.setWidth(virtualWidth)
  root.setHeight(virtualHeight)
  root.setMaxWidth(virtualWidth)
  root.setMaxHeight(virtualHeight)
  root.setDisplay(Yoga.DISPLAY_FLEX)
  root.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN)
  root.setOverflow(Yoga.OVERFLOW_HIDDEN)
  forest.forEach((node, index) => root.insertChild(node.yoga, index))

  root.calculateLayout(virtualWidth, virtualHeight, Yoga.DIRECTION_LTR)

  // Second pass inside Yoga: parent may be flex-sized (no POINT on transform) so first
  // applyBackgroundMinSize could not fill. Expand 0×0 AUTO bg leaves under computed
  // slot parents, then re-layout once (COD: still Yoga authority, not DOM invent).
  if (backgroundOf) {
    let expanded = 0
    const expandWalk = (node: YogaTreeNode, parentW: number, parentH: number): void => {
      const y = node.yoga
      let w = y.getComputedWidth()
      let h = y.getComputedHeight()
      const t = transformOf.get(node.entity)
      if (t && (w <= 0.5 || h <= 0.5) && parentW >= 24 && parentH >= 24 && parentW <= 200 && parentH <= 200) {
        const text = textOf?.(node.entity) ?? null
        const bg = backgroundOf(node.entity)
        if (bg && !text?.value?.trim()) {
          const wAuto = sizeAxisAuto(t.widthUnit, t.width)
          const hAuto = sizeAxisAuto(t.heightUnit, t.height)
          const isAbs = normalizeYGPositionType(t.positionType) === YGPositionType.ABSOLUTE
          // Never expand corner badges (NEW / SOLD OUT) — only full-bleed icon leaves.
          if (isAbs && isCornerPinnedAutoBadge(t)) {
            /* skip */
          } else if ((isAbs || (wAuto && hAuto)) && (wAuto || hAuto)) {
            if (wAuto && w <= 0.5) {
              y.setWidth(parentW)
              w = parentW
              expanded++
            }
            if (hAuto && h <= 0.5) {
              y.setHeight(parentH)
              h = parentH
              expanded++
            }
          }
        }
      }
      // Prefer computed size; fall back to parent so nested 0×0 stacks expand before re-layout.
      const cw = w > 0.5 ? w : parentW
      const ch = h > 0.5 ? h : parentH
      for (const child of node.children) expandWalk(child, cw, ch)
    }
    for (const node of forest) expandWalk(node, virtualWidth, virtualHeight)
    if (expanded > 0) {
      root.calculateLayout(virtualWidth, virtualHeight, Yoga.DIRECTION_LTR)
    }
  }

  const boxes: LayoutBox[] = []
  const walk = (node: YogaTreeNode, offsetLeft: number, offsetTop: number): void => {
    const y = node.yoga
    const relLeft = y.getComputedLeft()
    const relTop = y.getComputedTop()
    const left = offsetLeft + relLeft
    const top = offsetTop + relTop
    const width = y.getComputedWidth()
    const height = y.getComputedHeight()
    boxes.push({ entity: node.entity, left, top, relLeft, relTop, width, height })
    for (const child of node.children) {
      walk(child, left, top)
    }
  }
  for (const node of forest) walk(node, 0, 0)

  return {
    boxes,
    dispose: () => {
      for (const n of allYoga) n.free()
    }
  }
}