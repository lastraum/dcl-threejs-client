import type { PBUiDropdown } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_dropdown.gen'
import type { PBUiInput } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_input.gen'
import type { PBUiText } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_text.gen'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'
import type { LayoutBox } from './yogaLayout'
import {
  YGAlign,
  isYGDisplayNone,
  YGFlexDirection,
  YGJustify,
  YGOverflow,
  YGUnit,
  YGWrap
} from './yogaEnums'

/** Virtual-pixel scale (1:1) — prefer `uiScreenScaleFromViewport` when mapping yoga → screen DOM. */
export const VIRTUAL_LAYOUT_SCALE: UiScreenScale = { scaleX: 1, scaleY: 1, uniform: 1 }

export type UiScreenScale = {
  scaleX: number
  scaleY: number
  /** Uniform scale for typography and radii. */
  uniform: number
}

export function uiScreenScale(virtualWidth: number, virtualHeight: number, screenW: number, screenH: number): UiScreenScale {
  const scaleX = screenW / Math.max(1, virtualWidth)
  const scaleY = screenH / Math.max(1, virtualHeight)
  return { scaleX, scaleY, uniform: Math.min(scaleX, scaleY) }
}

/** Screen scale from a precomputed viewport (fill-mode layout mapping). */
export function uiScreenScaleFromViewport(viewport: {
  scaleX: number
  scaleY: number
  uniform: number
}): UiScreenScale {
  return { scaleX: viewport.scaleX, scaleY: viewport.scaleY, uniform: viewport.uniform }
}

export function color4Css(c: { r?: number; g?: number; b?: number; a?: number } | undefined): string {
  if (!c) return 'transparent'
  const r = Math.round(Math.min(1, Math.max(0, c.r ?? 1)) * 255)
  const g = Math.round(Math.min(1, Math.max(0, c.g ?? 1)) * 255)
  const b = Math.round(Math.min(1, Math.max(0, c.b ?? 1)) * 255)
  const a = Math.min(1, Math.max(0, c.a ?? 1))
  return `rgba(${r},${g},${b},${a})`
}

function scaledPx(value: number | undefined, unit: number | undefined, scale: number, fallback = 0): string {
  const v = value ?? fallback
  if (v <= 0) return '0'
  if (unit === YGUnit.PERCENT) return `${v}%`
  return `${v * scale}px`
}

export function paddingCss(t: PBUiTransform, scale: UiScreenScale): string {
  const top = scaledPx(t.paddingTop, t.paddingTopUnit, scale.scaleY)
  const right = scaledPx(t.paddingRight, t.paddingRightUnit, scale.scaleX)
  const bottom = scaledPx(t.paddingBottom, t.paddingBottomUnit, scale.scaleY)
  const left = scaledPx(t.paddingLeft, t.paddingLeftUnit, scale.scaleX)
  if (top === '0' && right === '0' && bottom === '0' && left === '0') return ''
  return `${top} ${right} ${bottom} ${left}`
}

export function borderRadiusCss(t: PBUiTransform, scale: UiScreenScale): string {
  const tl = scaledPx(t.borderTopLeftRadius, t.borderTopLeftRadiusUnit, scale.uniform)
  const tr = scaledPx(t.borderTopRightRadius, t.borderTopRightRadiusUnit, scale.uniform)
  const br = scaledPx(t.borderBottomRightRadius, t.borderBottomRightRadiusUnit, scale.uniform)
  const bl = scaledPx(t.borderBottomLeftRadius, t.borderBottomLeftRadiusUnit, scale.uniform)
  if (tl === '0' && tr === '0' && br === '0' && bl === '0') return ''
  return `${tl} ${tr} ${br} ${bl}`
}

function hasVisibleColor(c: { r?: number; g?: number; b?: number; a?: number } | undefined): boolean {
  if (!c) return false
  return (c.a ?? 1) > 0.01
}

export function borderCss(t: PBUiTransform, scale: UiScreenScale): {
  width: string
  style: string
  topColor: string
  rightColor: string
  bottomColor: string
  leftColor: string
} {
  let top = scaledPx(t.borderTopWidth, t.borderTopWidthUnit, scale.scaleY)
  let right = scaledPx(t.borderRightWidth, t.borderRightWidthUnit, scale.scaleX)
  let bottom = scaledPx(t.borderBottomWidth, t.borderBottomWidthUnit, scale.scaleY)
  let left = scaledPx(t.borderLeftWidth, t.borderLeftWidthUnit, scale.scaleX)
  const colored =
    hasVisibleColor(t.borderTopColor) ||
    hasVisibleColor(t.borderRightColor) ||
    hasVisibleColor(t.borderBottomColor) ||
    hasVisibleColor(t.borderLeftColor)
  const minStroke = `${Math.max(1, scale.uniform)}px`
  if (colored) {
    if (top === '0') top = minStroke
    if (right === '0') right = minStroke
    if (bottom === '0') bottom = minStroke
    if (left === '0') left = minStroke
  }
  const hasBorder = top !== '0' || right !== '0' || bottom !== '0' || left !== '0'
  return {
    width: hasBorder ? `${top} ${right} ${bottom} ${left}` : '',
    style: hasBorder ? 'solid' : '',
    topColor: color4Css(t.borderTopColor),
    rightColor: color4Css(t.borderRightColor ?? t.borderTopColor),
    bottomColor: color4Css(t.borderBottomColor ?? t.borderTopColor),
    leftColor: color4Css(t.borderLeftColor ?? t.borderTopColor)
  }
}

const FLEX_ALIGN: Record<number, string> = {
  [YGAlign.AUTO]: 'stretch',
  [YGAlign.FLEX_START]: 'flex-start',
  [YGAlign.CENTER]: 'center',
  [YGAlign.FLEX_END]: 'flex-end',
  [YGAlign.STRETCH]: 'stretch',
  [YGAlign.BASELINE]: 'baseline'
}

const FLEX_JUSTIFY: Record<number, string> = {
  [YGJustify.FLEX_START]: 'flex-start',
  [YGJustify.CENTER]: 'center',
  [YGJustify.FLEX_END]: 'flex-end',
  [YGJustify.SPACE_BETWEEN]: 'space-between',
  [YGJustify.SPACE_AROUND]: 'space-around',
  [YGJustify.SPACE_EVENLY]: 'space-evenly'
}

const FLEX_DIR: Record<number, string> = {
  [YGFlexDirection.ROW]: 'row',
  [YGFlexDirection.COLUMN]: 'column',
  [YGFlexDirection.COLUMN_REVERSE]: 'column-reverse',
  [YGFlexDirection.ROW_REVERSE]: 'row-reverse'
}

const FLEX_WRAP: Record<number, string> = {
  [YGWrap.NO_WRAP]: 'nowrap',
  [YGWrap.WRAP]: 'wrap',
  [YGWrap.WRAP_REVERSE]: 'wrap-reverse'
}

/** Flex container styles from PBUiTransform (text/content inside the layout box). */
export function flexContainerCss(t: PBUiTransform): {
  flexDirection: string
  alignItems: string
  alignContent: string
  justifyContent: string
  flexWrap: string
  overflow: string
} {
  return {
    flexDirection: FLEX_DIR[t.flexDirection] ?? 'row',
    alignItems: FLEX_ALIGN[t.alignItems ?? YGAlign.STRETCH] ?? 'stretch',
    alignContent: FLEX_ALIGN[t.alignContent ?? YGAlign.FLEX_START] ?? 'flex-start',
    justifyContent: FLEX_JUSTIFY[t.justifyContent] ?? 'flex-start',
    flexWrap: FLEX_WRAP[t.flexWrap ?? YGWrap.WRAP] ?? 'wrap',
    overflow: t.overflow === YGOverflow.HIDDEN ? 'hidden' : t.overflow === YGOverflow.SCROLL ? 'auto' : 'visible'
  }
}

/** Flex/padding inside a yoga layout box — geometry is never derived from CSS. */
export function applyUiTransformContentStyles(
  el: HTMLElement,
  t: PBUiTransform,
  scale: UiScreenScale = VIRTUAL_LAYOUT_SCALE
): void {
  if (isYGDisplayNone(t.display)) {
    el.style.display = 'none'
    return
  }

  const flex = flexContainerCss(t)
  el.style.display = 'flex'
  el.style.boxSizing = 'border-box'
  el.style.flexDirection = flex.flexDirection
  el.style.alignItems = flex.alignItems
  el.style.alignContent = flex.alignContent
  el.style.justifyContent = flex.justifyContent
  el.style.flexWrap = flex.flexWrap
  el.style.overflow = flex.overflow
  el.style.flexGrow = ''
  el.style.flexShrink = ''
  el.style.flexBasis = ''
  el.style.alignSelf = 'auto'
  el.style.margin = '0'

  const padding = paddingCss(t, scale)
  el.style.padding = padding || '0'
}

/** Yoga layout box → sole DOM geometry (screen px). Nested nodes use parent-relative coords. */
export function applyYogaLayoutBox(
  el: HTMLElement,
  box: LayoutBox,
  scale: UiScreenScale = VIRTUAL_LAYOUT_SCALE,
  coords: 'canvas' | 'parent' = 'canvas',
  /** When true, keep overflow for border-radius / YGOverflow.HIDDEN clip of nested shells. */
  clipOverflow = false
): void {
  const x = (coords === 'parent' ? box.relLeft : box.left) * scale.scaleX
  const y = (coords === 'parent' ? box.relTop : box.top) * scale.scaleY
  const w = Math.max(0, box.width * scale.scaleX)
  const h = Math.max(0, box.height * scale.scaleY)

  el.classList.add('scene-ui-node--positioned')
  // translate() — left/top alone were not affecting getBoundingClientRect (nodes stacked @0,0).
  el.style.setProperty('position', 'absolute', 'important')
  el.style.setProperty('left', '0', 'important')
  el.style.setProperty('top', '0', 'important')
  el.style.setProperty('width', `${w}px`, 'important')
  el.style.setProperty('height', `${h}px`, 'important')
  el.style.setProperty('transform', `translate(${x}px, ${y}px)`, 'important')
  el.style.display = 'block'
  el.style.boxSizing = 'border-box'
  // Default visible so non-clipping panels don't trap absolute children; clip when radius/overflow require it.
  el.style.overflow = clipOverflow ? 'hidden' : 'visible'
  el.style.margin = '0'
  el.style.right = ''
  el.style.bottom = ''
  el.style.inset = ''
  el.style.minWidth = ''
  el.style.minHeight = ''
  el.style.maxWidth = ''
  el.style.maxHeight = ''
}

const TEXT_ALIGN_MODES = {
  0: { alignItems: 'flex-start', justifyContent: 'flex-start', textAlign: 'left' },
  1: { alignItems: 'flex-start', justifyContent: 'center', textAlign: 'center' },
  2: { alignItems: 'flex-start', justifyContent: 'flex-end', textAlign: 'right' },
  3: { alignItems: 'center', justifyContent: 'flex-start', textAlign: 'left' },
  4: { alignItems: 'center', justifyContent: 'center', textAlign: 'center' },
  5: { alignItems: 'center', justifyContent: 'flex-end', textAlign: 'right' },
  6: { alignItems: 'flex-end', justifyContent: 'flex-start', textAlign: 'left' },
  7: { alignItems: 'flex-end', justifyContent: 'center', textAlign: 'center' },
  8: { alignItems: 'flex-end', justifyContent: 'flex-end', textAlign: 'right' }
} as const

const FONT_FAMILY: Record<number, string> = {
  0: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  1: 'Georgia, "Times New Roman", serif',
  2: 'ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace'
}

export function textAlignCss(mode: number | undefined): (typeof TEXT_ALIGN_MODES)[keyof typeof TEXT_ALIGN_MODES] {
  const key = (mode ?? 4) as keyof typeof TEXT_ALIGN_MODES
  return TEXT_ALIGN_MODES[key] ?? TEXT_ALIGN_MODES[4]
}

export function applyUiInputStyles(
  field: HTMLInputElement,
  input: PBUiInput,
  scale: UiScreenScale,
  syncValue = true,
  hasNodeBackground = false
): void {
  const align = textAlignCss(input.textAlign)
  const color = color4Css(input.color ?? { r: 0, g: 0, b: 0, a: 1 })
  const placeholder = color4Css(input.placeholderColor ?? { r: 0, g: 0, b: 0, a: 1 })
  if (syncValue) field.value = input.value ?? ''
  field.placeholder = input.placeholder ?? ''
  field.disabled = !!input.disabled
  field.readOnly = false
  field.tabIndex = 0
  field.style.width = '100%'
  field.style.height = '100%'
  field.style.boxSizing = 'border-box'
  field.style.border = 'none'
  field.style.outline = 'none'
  field.style.background = hasNodeBackground ? 'transparent' : '#fff'
  field.style.color = color
  field.style.fontSize = `${Math.max(1, (input.fontSize ?? 10) * scale.uniform)}px`
  field.style.fontFamily = FONT_FAMILY[input.font ?? 0] ?? FONT_FAMILY[0]
  field.style.textAlign = align.textAlign
  field.style.padding = '0'
  field.style.margin = '0'
  field.style.pointerEvents = input.disabled ? 'none' : 'auto'
  field.style.position = 'relative'
  field.style.zIndex = '2'
  field.style.cursor = input.disabled ? 'default' : 'text'
  field.style.setProperty('--placeholder-color', placeholder)
}

export function applyUiDropdownStyles(
  select: HTMLSelectElement,
  dropdown: PBUiDropdown,
  scale: UiScreenScale
): void {
  const align = textAlignCss(dropdown.textAlign)
  const color = color4Css(dropdown.color ?? { r: 0, g: 0, b: 0, a: 1 })
  select.disabled = !!dropdown.disabled
  select.style.width = '100%'
  select.style.height = '100%'
  select.style.boxSizing = 'border-box'
  select.style.border = 'none'
  select.style.outline = 'none'
  select.style.background = 'transparent'
  select.style.color = color
  select.style.fontSize = `${Math.max(1, (dropdown.fontSize ?? 10) * scale.uniform)}px`
  select.style.fontFamily = FONT_FAMILY[dropdown.font ?? 0] ?? FONT_FAMILY[0]
  select.style.textAlign = align.textAlign
  select.style.padding = '0'
  select.style.margin = '0'
  select.style.pointerEvents = dropdown.disabled ? 'none' : 'auto'
  select.style.position = 'relative'
  select.style.zIndex = '2'
  select.style.cursor = dropdown.disabled ? 'default' : 'pointer'
  select.style.appearance = 'none'
}

export function applyUiTextStyles(label: HTMLElement, text: PBUiText, scale: UiScreenScale): void {
  const align = textAlignCss(text.textAlign)
  const c = text.color ?? { r: 1, g: 1, b: 1, a: 1 }
  const safeColor = (c.a ?? 1) < 0.05 ? { r: 1, g: 1, b: 1, a: 1 } : c
  const color = color4Css(safeColor)
  const fontPx = Math.max(1, (text.fontSize ?? 10) * scale.uniform)
  label.style.color = color
  label.style.webkitTextFillColor = color
  label.style.fontSize = `${fontPx}px`
  label.style.fontFamily = FONT_FAMILY[text.font ?? 0] ?? FONT_FAMILY[0]
  label.style.textAlign = align.textAlign
  // SDK default is TW_WRAP (0). Only TW_NO_WRAP (1) is single-line.
  const singleLine = text.textWrap === 1
  // Fill the UiTransform box and honor TextAlignMode (default TAM_MIDDLE_CENTER).
  // Prior wrap path used display:block + height:auto → always top-aligned.
  label.style.width = '100%'
  label.style.height = '100%'
  label.style.maxWidth = '100%'
  label.style.minWidth = '0'
  label.style.minHeight = '0'
  label.style.flex = '1 1 auto'
  label.style.alignSelf = 'stretch'
  label.style.margin = '0'
  label.style.padding = '0'
  label.style.boxSizing = 'border-box'
  label.style.display = 'flex'
  label.style.flexDirection = 'row'
  // TEXT_ALIGN_MODES: justifyContent = horizontal, alignItems = vertical (row flex).
  label.style.justifyContent = align.justifyContent
  label.style.alignItems = align.alignItems
  label.style.wordBreak = singleLine ? 'normal' : 'break-word'
  label.style.overflowWrap = singleLine ? 'normal' : 'anywhere'
  label.style.whiteSpace = singleLine ? 'nowrap' : 'pre-wrap'
  label.style.overflow = singleLine ? 'hidden' : 'hidden'
  label.style.lineHeight = singleLine ? `${fontPx}px` : '1.25'
  label.style.pointerEvents = 'none'
  label.style.position = 'relative'
  label.style.zIndex = '2'
}

/**
 * DCL / TextMeshPro-style rich text → safe HTML for scene UiText.
 * Explorer parses color/size/bold; unknown tags (e.g. `<space=…>`) must be stripped,
 * not escaped as visible garbage on event cards.
 */
export function sanitizeUiTextHtml(raw: string): string {
  let s = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Bold / italic
  s = s
    .replace(/&lt;b&gt;/gi, '<b>')
    .replace(/&lt;\/b&gt;/gi, '</b>')
    .replace(/&lt;i&gt;/gi, '<i>')
    .replace(/&lt;\/i&gt;/gi, '</i>')
    .replace(/&lt;u&gt;/gi, '<u>')
    .replace(/&lt;\/u&gt;/gi, '</u>')

  // <color=#RRGGBB[AA]> / <color="red"> … </color>
  s = s
    .replace(
      /&lt;color=#([0-9a-fA-F]{3,8})&gt;/gi,
      (_m, hex: string) => `<span style="color:#${hex.length === 8 ? hex.slice(0, 6) : hex}">`
    )
    .replace(/&lt;color=["']([^"']+)["']&gt;/gi, '<span style="color:$1">')
    .replace(/&lt;color=([a-zA-Z]+)&gt;/gi, '<span style="color:$1">')
    .replace(/&lt;\/color&gt;/gi, '</span>')

  // <size=N> … </size> — N in SDK units ≈ px after screen scale is applied on the label
  s = s
    .replace(
      /&lt;size=(\d+(?:\.\d+)?)(?:px|em|%)?&gt;/gi,
      '<span style="font-size:$1em">'
    )
    .replace(/&lt;\/size&gt;/gi, '</span>')

  // Layout-only / unknown tags — drop (do not show as text)
  s = s
    .replace(/&lt;space=[^&]*&gt;/gi, '')
    .replace(/&lt;\/space&gt;/gi, '')
    .replace(/&lt;br\s*\/?&gt;/gi, '<br/>')
    .replace(/&lt;\/?[a-zA-Z][^&]*&gt;/g, '')

  return s
}

/** Plain text for measurement — strip DCL rich-text markup. */
export function stripUiTextMarkup(value: string): string {
  return value
    .replace(/<\/?(?:b|i|u|color|size|space)(?:\s*=[^>]*)?>/gi, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&lt;\/?[a-zA-Z][^&]*&gt;/gi, '')
}