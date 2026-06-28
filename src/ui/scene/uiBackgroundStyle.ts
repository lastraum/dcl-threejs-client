import type { PBUiBackground } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_background.gen'
import type { ResolvedScene } from '../../dcl/content/types'
import { resolveSceneTextureUrl } from '../../bridge/material/resolveTexture'
import { isCorsSafeTextureUrl, proxiedTextureUrl } from '../../rendering/textureProxy'
import type { UiScreenScale } from './uiDomStyles'
import { assignUiImageSrc } from './uiImageLoad'

export const BackgroundTextureMode = {
  NINE_SLICES: 0,
  CENTER: 1,
  STRETCH: 2
} as const

const DEFAULT_SLICES = { top: 1 / 3, left: 1 / 3, right: 1 / 3, bottom: 1 / 3 }

function color4Css(
  c: { r?: number; g?: number; b?: number; a?: number } | undefined,
  /** PBUiBackground / Color4 protobuf default when the field is omitted on the wire. */
  defaultRgb: [number, number, number] = [1, 1, 1]
): string {
  if (!c) {
    const [dr, dg, db] = defaultRgb
    return `rgba(${Math.round(dr * 255)},${Math.round(dg * 255)},${Math.round(db * 255)},1)`
  }
  const r = Math.round(Math.min(1, Math.max(0, c.r ?? defaultRgb[0])) * 255)
  const g = Math.round(Math.min(1, Math.max(0, c.g ?? defaultRgb[1])) * 255)
  const b = Math.round(Math.min(1, Math.max(0, c.b ?? defaultRgb[2])) * 255)
  const a = Math.min(1, Math.max(0, c.a ?? 1))
  if (a <= 0.01) return 'transparent'
  return `rgba(${r},${g},${b},${a})`
}

/** True when a UiBackground should paint (color and/or texture). */
export function hasUiVisualBackground(
  bg: PBUiBackground | null | undefined,
  imageUrl?: string | null
): boolean {
  if (!bg) return false
  if (imageUrl || hasUiBackgroundTexture(bg)) return true
  return (bg.color?.a ?? 1) > 0.01
}

/** SDK TextureUnion, react-ecs `{ src }`, and loose CRDT shapes. */
export function extractUiTextureSrc(texture: unknown): string | null {
  if (!texture) return null
  if (typeof texture === 'string') return texture.trim() || null

  const t = texture as Record<string, unknown>
  const tex = t.tex as { $case?: string; texture?: { src?: string } } | undefined
  if (tex?.$case === 'texture' && typeof tex.texture?.src === 'string') {
    return tex.texture.src.trim() || null
  }
  if (typeof t.src === 'string') return t.src.trim() || null

  const nested = t.texture as { src?: string } | undefined
  if (typeof nested?.src === 'string') return nested.src.trim() || null

  return null
}

export function hasUiBackgroundTexture(bg: PBUiBackground | null | undefined): boolean {
  return extractUiTextureSrc(bg?.texture) !== null
}

/**
 * react-ecs defaults missing textureMode to CENTER (1).
 * Protobuf defaults to NINE_SLICES (0) — upgrade absolute URLs to stretch.
 */
export function normalizeBackgroundTextureMode(
  mode: number | string | undefined,
  src: string | null
): number {
  if (typeof mode === 'string') {
    const key = mode.toLowerCase().replace(/-/g, '_')
    if (key === 'stretch') return BackgroundTextureMode.STRETCH
    if (key === 'center') return BackgroundTextureMode.CENTER
    if (key === 'nine_slices') return BackgroundTextureMode.NINE_SLICES
  }
  const numeric = typeof mode === 'number' ? mode : BackgroundTextureMode.CENTER
  if (numeric === BackgroundTextureMode.NINE_SLICES && src && /^https?:\/\//i.test(src)) {
    return BackgroundTextureMode.STRETCH
  }
  return numeric
}

/** DOM overlay images — prefer direct CORS-safe URLs; WebGL path uses proxiedTextureUrl. */
export function resolveUiBackgroundImageUrl(
  bg: PBUiBackground | null | undefined,
  scene: ResolvedScene | null
): string | null {
  const src = extractUiTextureSrc(bg?.texture)
  if (!src) return null
  if (/^(https?:|data:|blob:)/i.test(src)) {
    return isCorsSafeTextureUrl(src) ? src : proxiedTextureUrl(src)
  }
  if (!scene) return null
  return resolveSceneTextureUrl(src, scene)
}

function isOpaqueWhite(c: { r?: number; g?: number; b?: number; a?: number } | undefined): boolean {
  if (!c) return true
  return (c.r ?? 1) >= 0.99 && (c.g ?? 1) >= 0.99 && (c.b ?? 1) >= 0.99 && (c.a ?? 1) >= 0.99
}

function isOpaqueBlack(c: { r?: number; g?: number; b?: number; a?: number } | undefined): boolean {
  if (!c) return false
  return (c.r ?? 0) <= 0.01 && (c.g ?? 0) <= 0.01 && (c.b ?? 0) <= 0.01 && (c.a ?? 1) > 0.5
}

function ensureBgImg(el: HTMLElement): HTMLImageElement {
  let img = el.querySelector('.scene-ui-node__bg-img') as HTMLImageElement | null
  if (!img) {
    img = document.createElement('img')
    img.className = 'scene-ui-node__bg-img'
    img.alt = ''
    img.draggable = false
    el.appendChild(img)
  }
  return img
}

function clearBgImg(el: HTMLElement): void {
  el.querySelector('.scene-ui-node__bg-img')?.remove()
}

function applyBgImg(el: HTMLElement, imageUrl: string, mode: number): void {
  const img = ensureBgImg(el)
  assignUiImageSrc(img, imageUrl)
  img.style.position = 'absolute'
  img.style.inset = '0'
  img.style.width = '100%'
  img.style.height = '100%'
  img.style.pointerEvents = 'none'
  img.style.opacity = '1'
  img.style.objectFit = mode === BackgroundTextureMode.CENTER ? 'contain' : 'fill'
  img.style.objectPosition = 'center'
  el.style.backgroundImage = ''
  el.style.backgroundSize = ''
  el.style.backgroundPosition = ''
  el.style.backgroundRepeat = ''
  el.style.backgroundColor = 'transparent'
  el.style.backgroundBlendMode = ''
}

function slicePercent(v: number): string {
  return `${Math.max(0, Math.min(100, v * 100))}%`
}

function applyNineSlice(
  el: HTMLElement,
  bg: PBUiBackground,
  imageUrl: string,
  scale: UiScreenScale
): void {
  clearBgImg(el)
  const slices = bg.textureSlices ?? DEFAULT_SLICES
  const safeUrl = imageUrl.replace(/"/g, '%22')
  const tint = color4Css(bg.color)
  const u = scale.uniform
  const top = Math.max(1, (slices.top ?? DEFAULT_SLICES.top) * 48 * u)
  const right = Math.max(1, (slices.right ?? DEFAULT_SLICES.right) * 48 * u)
  const bottom = Math.max(1, (slices.bottom ?? DEFAULT_SLICES.bottom) * 48 * u)
  const left = Math.max(1, (slices.left ?? DEFAULT_SLICES.left) * 48 * u)

  el.style.borderStyle = 'solid'
  el.style.borderColor = 'transparent'
  el.style.borderWidth = `${top}px ${right}px ${bottom}px ${left}px`
  el.style.borderImageSource = `url("${safeUrl}")`
  el.style.borderImageSlice = `${slicePercent(slices.top ?? DEFAULT_SLICES.top)} ${slicePercent(slices.right ?? DEFAULT_SLICES.right)} ${slicePercent(slices.bottom ?? DEFAULT_SLICES.bottom)} ${slicePercent(slices.left ?? DEFAULT_SLICES.left)} fill`
  el.style.borderImageWidth = `${top}px ${right}px ${bottom}px ${left}px`
  el.style.borderImageRepeat = 'stretch'
  el.style.backgroundImage = ''
  el.style.backgroundSize = ''
  el.style.backgroundPosition = ''
  el.style.backgroundRepeat = ''
  el.style.backgroundColor = tint === 'transparent' || isOpaqueWhite(bg.color) ? 'transparent' : tint
  el.style.backgroundBlendMode = ''
}

/** Apply PBUiBackground color + texture to a DOM node. */
export function applyUiBackgroundStyles(
  el: HTMLElement,
  bg: PBUiBackground | null | undefined,
  imageUrl: string | null,
  scale?: UiScreenScale
): void {
  el.style.borderImage = ''
  el.style.borderImageSource = ''
  el.style.borderImageSlice = ''
  el.style.borderImageWidth = ''
  el.style.borderImageRepeat = ''
  el.style.backgroundBlendMode = ''

  const c = bg?.color
  const tint = color4Css(c)
  if (!imageUrl) {
    clearBgImg(el)
    el.style.backgroundImage = ''
    el.style.backgroundSize = ''
    el.style.backgroundPosition = ''
    el.style.backgroundRepeat = ''
    // Missing/failed texture — fall back to color tint (Explorer parity).
    el.style.backgroundColor = tint === 'transparent' ? 'transparent' : tint
    return
  }

  const rawSrc = extractUiTextureSrc(bg?.texture)
  const mode = normalizeBackgroundTextureMode(bg?.textureMode, rawSrc)
  const screenScale = scale ?? { scaleX: 1, scaleY: 1, uniform: 1 }

  if (mode === BackgroundTextureMode.NINE_SLICES) {
    applyNineSlice(el, bg!, imageUrl, screenScale)
    return
  }

  if (isOpaqueBlack(c) && hasUiBackgroundTexture(bg)) {
    el.style.backgroundColor = 'transparent'
  }

  applyBgImg(el, imageUrl, mode)
}