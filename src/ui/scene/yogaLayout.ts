import type { Entity } from '@dcl/ecs'
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
  YGWrap
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

function applyUiTransform(node: YogaNode, t: PBUiTransform): void {
  node.setFlexDirection(FLEX_DIR[t.flexDirection] ?? Yoga.FLEX_DIRECTION_ROW)
  node.setJustifyContent(JUSTIFY[t.justifyContent] ?? Yoga.JUSTIFY_FLEX_START)
  node.setAlignItems(ALIGN[t.alignItems ?? YGAlign.STRETCH] ?? Yoga.ALIGN_STRETCH)
  node.setAlignSelf(ALIGN[t.alignSelf] ?? Yoga.ALIGN_AUTO)
  if (t.alignContent !== undefined) {
    node.setAlignContent(ALIGN[t.alignContent] ?? Yoga.ALIGN_FLEX_START)
  }
  node.setFlexWrap(WRAP[t.flexWrap ?? YGWrap.NO_WRAP] ?? Yoga.WRAP_NO_WRAP)
  node.setOverflow(OVERFLOW[t.overflow] ?? Yoga.OVERFLOW_VISIBLE)
  node.setDisplay(isYGDisplayNone(t.display) ? Yoga.DISPLAY_NONE : Yoga.DISPLAY_FLEX)
  node.setPositionType(
    t.positionType === YGPositionType.ABSOLUTE
      ? Yoga.POSITION_TYPE_ABSOLUTE
      : Yoga.POSITION_TYPE_RELATIVE
  )

  if (typeof t.flexGrow === 'number') node.setFlexGrow(t.flexGrow)
  if (typeof t.flexShrink === 'number') node.setFlexShrink(t.flexShrink)
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
  applyEdge(node, Yoga.EDGE_LEFT, t.positionLeftUnit, t.positionLeft, 'position')
  applyEdge(node, Yoga.EDGE_TOP, t.positionTopUnit, t.positionTop, 'position')
  applyEdge(node, Yoga.EDGE_RIGHT, t.positionRightUnit, t.positionRight, 'position')
  applyEdge(node, Yoga.EDGE_BOTTOM, t.positionBottomUnit, t.positionBottom, 'position')
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
  inputOf?: (entity: Entity) => PBUiInput | null
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
    if (textOf) applyTextMinSize(yoga, textOf(entity), transform)
    if (inputOf) applyInputMinSize(yoga, inputOf(entity))
    const childEntities = childrenOf.get(entity) ?? []
    const children = childEntities.map((c) => build(c))
    children.forEach((child, index) => yoga.insertChild(child.yoga, index))
    return { entity, yoga, children }
  }

  const roots = childrenOf.get(CANVAS_ROOT_ENTITY) ?? []
  const forest = roots.map((e) => build(e))
  const root = Yoga.Node.create()
  allYoga.push(root)
  root.setWidth(virtualWidth)
  root.setHeight(virtualHeight)
  root.setDisplay(Yoga.DISPLAY_FLEX)
  root.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN)
  forest.forEach((node, index) => root.insertChild(node.yoga, index))

  root.calculateLayout(virtualWidth, virtualHeight, Yoga.DIRECTION_LTR)

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