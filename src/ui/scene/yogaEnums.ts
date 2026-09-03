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

/** react-ecs / protobuf may emit `"percent"` / boxed enums for widthUnit. */
export function normalizeYGUnit(value: unknown): number {
  if (value === YGUnit.PERCENT || value === 2) return YGUnit.PERCENT
  if (value === YGUnit.POINT || value === 1) return YGUnit.POINT
  if (value === YGUnit.AUTO || value === 3) return YGUnit.AUTO
  if (value === YGUnit.UNDEFINED || value === 0 || value == null) return YGUnit.UNDEFINED
  if (typeof value === 'string') {
    const key = value.toLowerCase().trim()
    if (key === 'percent' || key === '%') return YGUnit.PERCENT
    if (key === 'point' || key === 'px' || key === 'points') return YGUnit.POINT
    if (key === 'auto') return YGUnit.AUTO
  }
  if (typeof value === 'object') {
    const v = (value as { value?: unknown }).value ?? (value as { low?: unknown }).low
    if (v === 2 || v === '2') return YGUnit.PERCENT
    if (v === 1 || v === '1') return YGUnit.POINT
    if (v === 3 || v === '3') return YGUnit.AUTO
  }
  const n = Number(value)
  if (n === 2) return YGUnit.PERCENT
  if (n === 1) return YGUnit.POINT
  if (n === 3) return YGUnit.AUTO
  return YGUnit.UNDEFINED
}

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

/** Read display only when the value is actually present. Empty/unknown is not flex. */
export function readYGDisplay(display: unknown): number | undefined {
  if (display === undefined || display === null) return undefined
  if (display === YGDisplay.NONE || display === 1 || display === true) return YGDisplay.NONE
  if (display === YGDisplay.FLEX || display === 0 || display === false) return YGDisplay.FLEX
  if (typeof display === 'string') {
    const key = display.toLowerCase().trim()
    if (key === 'none' || key === '1' || key === 'hidden') return YGDisplay.NONE
    if (key === 'flex' || key === '0' || key === 'visible') return YGDisplay.FLEX
    return undefined
  }
  if (typeof display === 'object') {
    const v = (display as { value?: unknown }).value ?? (display as { low?: unknown }).low
    if (v === undefined || v === null) return undefined
    if (v === 1 || v === '1') return YGDisplay.NONE
    if (v === 0 || v === '0') return YGDisplay.FLEX
    return undefined
  }
  const n = Number(display)
  if (n === 1) return YGDisplay.NONE
  if (n === 0) return YGDisplay.FLEX
  return undefined
}

/** react-ecs JSX may use `"flex"` / `"none"` strings; protobuf uses numeric enums. */
export function normalizeYGDisplay(display: unknown): number {
  return readYGDisplay(display) ?? YGDisplay.FLEX
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

/**
 * react-ecs JSX often keeps string enums (`"center"`, `"row"`) until protobuf encode.
 * Mount snapshots / partial paths can still carry strings — map them for Yoga + CSS.
 */
export function normalizeYGJustify(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'flex-start':
      case 'start':
        return YGJustify.FLEX_START
      case 'center':
        return YGJustify.CENTER
      case 'flex-end':
      case 'end':
        return YGJustify.FLEX_END
      case 'space-between':
        return YGJustify.SPACE_BETWEEN
      case 'space-around':
        return YGJustify.SPACE_AROUND
      case 'space-evenly':
        return YGJustify.SPACE_EVENLY
    }
  }
  return YGJustify.FLEX_START
}

export function normalizeYGAlign(value: unknown, fallback: number = YGAlign.STRETCH): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'auto':
        return YGAlign.AUTO
      case 'flex-start':
      case 'start':
        return YGAlign.FLEX_START
      case 'center':
        return YGAlign.CENTER
      case 'flex-end':
      case 'end':
        return YGAlign.FLEX_END
      case 'stretch':
        return YGAlign.STRETCH
      case 'baseline':
        return YGAlign.BASELINE
      case 'space-between':
        return YGAlign.SPACE_BETWEEN
      case 'space-around':
        return YGAlign.SPACE_AROUND
    }
  }
  return fallback
}

export function normalizeYGFlexDirection(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'row':
        return YGFlexDirection.ROW
      case 'column':
        return YGFlexDirection.COLUMN
      case 'column-reverse':
        return YGFlexDirection.COLUMN_REVERSE
      case 'row-reverse':
        return YGFlexDirection.ROW_REVERSE
    }
  }
  return YGFlexDirection.ROW
}

/** react-ecs may emit `"absolute"` / `"relative"` strings before protobuf encode. */
export function normalizeYGPositionType(value: unknown): number {
  if (value === YGPositionType.ABSOLUTE || value === 1) return YGPositionType.ABSOLUTE
  if (value === YGPositionType.RELATIVE || value === 0) return YGPositionType.RELATIVE
  if (typeof value === 'string') {
    const key = value.toLowerCase()
    if (key === 'absolute') return YGPositionType.ABSOLUTE
    if (key === 'relative') return YGPositionType.RELATIVE
  }
  return YGPositionType.RELATIVE
}