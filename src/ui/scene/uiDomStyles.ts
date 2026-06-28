import type { PBUiDropdown } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_dropdown.gen'
import type { PBUiInput } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_input.gen'
import type { PBUiText } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_text.gen'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'
import {
  YGAlign,
  YGFlexDirection,
  YGJustify,
  YGOverflow,
  YGUnit
} from './yogaEnums'

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

/** Flex container styles from PBUiTransform (text/content inside the layout box). */
export function flexContainerCss(t: PBUiTransform): {
  flexDirection: string
  alignItems: string
  justifyContent: string
  overflow: string
} {
  return {
    flexDirection: FLEX_DIR[t.flexDirection] ?? 'row',
    alignItems: FLEX_ALIGN[t.alignItems ?? YGAlign.STRETCH] ?? 'stretch',
    justifyContent: FLEX_JUSTIFY[t.justifyContent] ?? 'flex-start',
    overflow: t.overflow === YGOverflow.HIDDEN ? 'hidden' : t.overflow === YGOverflow.SCROLL ? 'auto' : 'visible'
  }
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
  label.style.color = color
  label.style.webkitTextFillColor = color
  label.style.fontSize = `${Math.max(1, (text.fontSize ?? 10) * scale.uniform)}px`
  label.style.fontFamily = FONT_FAMILY[text.font ?? 0] ?? FONT_FAMILY[0]
  label.style.textAlign = align.textAlign
  label.style.width = '100%'
  label.style.maxWidth = '100%'
  label.style.flex = '1 1 auto'
  label.style.alignSelf = 'stretch'
  label.style.display = 'block'
  label.style.margin = '0'
  label.style.padding = '0'
  label.style.boxSizing = 'border-box'
  label.style.wordBreak = text.textWrap === 1 ? 'normal' : 'break-word'
  label.style.whiteSpace = text.textWrap === 1 ? 'nowrap' : 'pre-wrap'
  label.style.overflow = 'visible'
  label.style.lineHeight = '1.25'
  label.style.pointerEvents = 'none'
  label.style.position = 'relative'
  label.style.zIndex = '2'
}

export function sanitizeUiTextHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;b&gt;/gi, '<b>')
    .replace(/&lt;\/b&gt;/gi, '</b>')
    .replace(/&lt;i&gt;/gi, '<i>')
    .replace(/&lt;\/i&gt;/gi, '</i>')
}