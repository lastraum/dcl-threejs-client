declare module 'yoga-layout-prebuilt' {
  const Yoga: {
    Node: {
      create(): YogaNode
      createDefault(): YogaNode
    }
    DIRECTION_LTR: number
    POSITION_TYPE_RELATIVE: number
    POSITION_TYPE_ABSOLUTE: number
    DISPLAY_FLEX: number
    DISPLAY_NONE: number
    FLEX_DIRECTION_ROW: number
    FLEX_DIRECTION_COLUMN: number
    FLEX_DIRECTION_COLUMN_REVERSE: number
    FLEX_DIRECTION_ROW_REVERSE: number
    JUSTIFY_FLEX_START: number
    JUSTIFY_CENTER: number
    JUSTIFY_FLEX_END: number
    JUSTIFY_SPACE_BETWEEN: number
    JUSTIFY_SPACE_AROUND: number
    JUSTIFY_SPACE_EVENLY: number
    ALIGN_AUTO: number
    ALIGN_FLEX_START: number
    ALIGN_CENTER: number
    ALIGN_FLEX_END: number
    ALIGN_STRETCH: number
    ALIGN_BASELINE: number
    ALIGN_SPACE_BETWEEN: number
    ALIGN_SPACE_AROUND: number
    WRAP_NO_WRAP: number
    WRAP_WRAP: number
    WRAP_WRAP_REVERSE: number
    OVERFLOW_VISIBLE: number
    OVERFLOW_HIDDEN: number
    OVERFLOW_SCROLL: number
    EDGE_LEFT: number
    EDGE_TOP: number
    EDGE_RIGHT: number
    EDGE_BOTTOM: number
  }
  export default Yoga

  interface YogaNode {
    free(): void
    insertChild(child: YogaNode, index: number): void
    removeChild(child: YogaNode): void
    getChildCount(): number
    calculateLayout(width: number, height: number, direction: number): void
    getComputedLeft(): number
    getComputedTop(): number
    getComputedWidth(): number
    getComputedHeight(): number
    setWidth(width: number): void
    setHeight(height: number): void
    setWidthPercent(percent: number): void
    setHeightPercent(percent: number): void
    setWidthAuto(): void
    setHeightAuto(): void
    setMinWidth(width: number): void
    setMinHeight(height: number): void
    setMaxWidth(width: number): void
    setMaxHeight(height: number): void
    setMinWidthPercent(percent: number): void
    setMinHeightPercent(percent: number): void
    setMaxWidthPercent(percent: number): void
    setMaxHeightPercent(percent: number): void
    setFlexGrow(grow: number): void
    setFlexShrink(shrink: number): void
    setFlexBasis(basis: number): void
    setFlexBasisPercent(percent: number): void
    setFlexBasisAuto(): void
    setFlexDirection(direction: number): void
    setJustifyContent(justify: number): void
    setAlignItems(align: number): void
    setAlignContent(align: number): void
    setAlignSelf(align: number): void
    setFlexWrap(wrap: number): void
    setOverflow(overflow: number): void
    setDisplay(display: number): void
    setPositionType(type: number): void
    setPosition(edge: number, value: number): void
    setPositionPercent(edge: number, percent: number): void
    setMargin(edge: number, value: number): void
    setMarginPercent(edge: number, percent: number): void
    setMarginAuto(edge: number): void
    setPadding(edge: number, value: number): void
    setPaddingPercent(edge: number, percent: number): void
  }
}