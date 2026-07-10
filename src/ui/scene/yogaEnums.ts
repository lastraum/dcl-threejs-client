/** PBUiTransform enum values — numeric literals (const enums are not importable with isolatedModules). */
export const YGPositionType = {
  RELATIVE: 0,
  ABSOLUTE: 1
} as const

export const YGAlign = {
  AUTO: 0,
  FLEX_START: 1,
  CENTER: 2,
  FLEX_END: 3,
  STRETCH: 4,
  BASELINE: 5,
  SPACE_BETWEEN: 6,
  SPACE_AROUND: 7
} as const

export const YGUnit = {
  UNDEFINED: 0,
  POINT: 1,
  PERCENT: 2,
  AUTO: 3
} as const

export const YGFlexDirection = {
  ROW: 0,
  COLUMN: 1,
  COLUMN_REVERSE: 2,
  ROW_REVERSE: 3
} as const

export const YGWrap = {
  NO_WRAP: 0,
  WRAP: 1,
  WRAP_REVERSE: 2
} as const

export const YGJustify = {
  FLEX_START: 0,
  CENTER: 1,
  FLEX_END: 2,
  SPACE_BETWEEN: 3,
  SPACE_AROUND: 4,
  SPACE_EVENLY: 5
} as const

export const YGOverflow = {
  VISIBLE: 0,
  HIDDEN: 1,
  SCROLL: 2
} as const

export const YGDisplay = {
  FLEX: 0,
  NONE: 1
} as const

/** react-ecs JSX may use `"flex"` / `"none"` strings; protobuf uses numeric enums. */
export function normalizeYGDisplay(display: unknown): number {
  if (display === YGDisplay.NONE || display === 1) return YGDisplay.NONE
  if (display === YGDisplay.FLEX || display === 0) return YGDisplay.FLEX
  if (typeof display === 'string') {
    const key = display.toLowerCase()
    if (key === 'none') return YGDisplay.NONE
    if (key === 'flex') return YGDisplay.FLEX
  }
  return YGDisplay.FLEX
}

export function isYGDisplayNone(display: unknown): boolean {
  return normalizeYGDisplay(display) === YGDisplay.NONE
}

/** PBUiTransform.pointerFilter — default PFM_NONE (pass through to 3D camera). */
export const PointerFilterMode = {
  NONE: 0,
  BLOCK: 1
} as const

/** react-ecs may emit `"block"` / `"none"` strings for pointerFilter. */
export function normalizePointerFilterMode(mode: unknown): number {
  if (mode === PointerFilterMode.BLOCK || mode === 1) return PointerFilterMode.BLOCK
  if (mode === PointerFilterMode.NONE || mode === 0) return PointerFilterMode.NONE
  if (typeof mode === 'string') {
    const key = mode.toLowerCase()
    if (key === 'block') return PointerFilterMode.BLOCK
    if (key === 'none') return PointerFilterMode.NONE
  }
  return PointerFilterMode.NONE
}