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

/** naturalWidth/Height cache for border-image nine-slice sizing. */
const imageNaturalSize = new Map<string, { w: number; h: number }>()
const imageSizeLoading = new Set<string>()

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
  const tex = t.tex as
    | { $case?: string; texture?: { src?: string }; avatarTexture?: { userId?: string } }
    | undefined
  if (tex?.$case === 'texture' && typeof tex.texture?.src === 'string') {
    return tex.texture.src.trim() || null
  }
  // Some CRDT decodes omit $case but still nest texture.src
  if (tex && typeof tex.texture?.src === 'string') {
    return tex.texture.src.trim() || null
  }
  if (typeof t.src === 'string') return t.src.trim() || null

  const nested = t.texture as { src?: string; tex?: { $case?: string; texture?: { src?: string } } } | undefined
  if (typeof nested?.src === 'string') return nested.src.trim() || null
  if (nested?.tex?.$case === 'texture' && typeof nested.tex.texture?.src === 'string') {
    return nested.tex.texture.src.trim() || null
  }

  return null
}

export function hasUiBackgroundTexture(bg: PBUiBackground | null | undefined): boolean {
  return extractUiTextureSrc(bg?.texture) !== null
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/**
 * react-ecs may omit textureMode (CENTER intent). Protobuf enum default is NINE_SLICES (0).
 *
 * Honor nine-slice when:
 *  - mode string is 'nine_slices' / 'nine-slices' (always — even default 1/3 slices), or
 *  - mode is NINE_SLICES (0) and textureSlices is present (object, any fractions incl. 1/3)
 *
 * HTTP/CDN textures are allowed (previously always demoted to stretch — broken panels).
 * Bare mode 0 with **no** textureSlices field → STRETCH (protobuf false-default without slices).
 */
export function normalizeBackgroundTextureMode(
  mode: number | string | undefined,
  _src: string | null,
  textureSlices?: PBUiBackground['textureSlices']
): number {
  if (typeof mode === 'string') {
    const key = mode.toLowerCase().replace(/-/g, '_')
    if (key === 'stretch') return BackgroundTextureMode.STRETCH
    if (key === 'center') return BackgroundTextureMode.CENTER
    if (key === 'nine_slices') return BackgroundTextureMode.NINE_SLICES
  }
  if (mode === undefined || mode === null) {
    return BackgroundTextureMode.CENTER
  }
  const numeric = typeof mode === 'number' ? mode : BackgroundTextureMode.CENTER
  if (numeric === BackgroundTextureMode.NINE_SLICES) {
    // Slices object present (incl. default 1/3) → real nine-slice. Missing → stretch.
    if (textureSlices != null && typeof textureSlices === 'object') {
      return BackgroundTextureMode.NINE_SLICES
    }
    return BackgroundTextureMode.STRETCH
  }
  if (
    numeric === BackgroundTextureMode.CENTER ||
    numeric === BackgroundTextureMode.STRETCH
  ) {
    return numeric
  }
  return BackgroundTextureMode.CENTER
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
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
  img.style.position = 'absolute'
  img.style.inset = '0'
  img.style.width = '100%'
  img.style.height = '100%'
  img.style.pointerEvents = 'none'
  img.style.opacity = '1'
  img.style.objectFit = mode === BackgroundTextureMode.CENTER ? 'contain' : 'fill'
  img.style.objectPosition = 'center'
  img.style.borderRadius = 'inherit'
  el.style.backgroundImage = ''
  el.style.backgroundSize = ''
  el.style.backgroundPosition = ''
  el.style.backgroundRepeat = ''
  el.style.backgroundColor = 'transparent'
  el.style.backgroundBlendMode = ''
  // Clear nine-slice leftovers so mode switches don't stick.
  el.style.borderImage = ''
  el.style.borderImageSource = ''
  el.style.borderImageSlice = ''
  el.style.borderImageWidth = ''
  el.style.borderImageRepeat = ''
  el.style.borderWidth = ''
  el.style.borderStyle = ''
  el.style.borderColor = ''
}

function slicePercent(v: number): string {
  return `${Math.max(0, Math.min(100, clamp01(v) * 100))}%`
}

/** Kick off natural size probe; repaint via scene-ui-image-loaded when ready. */
function probeImageNaturalSize(imageUrl: string): { w: number; h: number } | null {
  const cached = imageNaturalSize.get(imageUrl)
  if (cached) return cached
  if (imageSizeLoading.has(imageUrl)) return null
  imageSizeLoading.add(imageUrl)

  const img = new Image()
  img.decoding = 'async'
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    imageSizeLoading.delete(imageUrl)
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      imageNaturalSize.set(imageUrl, { w: img.naturalWidth, h: img.naturalHeight })
      if (typeof document !== 'undefined') {
        document.dispatchEvent(new CustomEvent('scene-ui-image-loaded'))
      }
    }
  }
  img.onerror = () => {
    imageSizeLoading.delete(imageUrl)
    // Retry via blob fetch path used by assignUiImageSrc
    void fetch(imageUrl)
      .then((res) => (res.ok ? res.blob() : Promise.reject()))
      .then((blob) => {
        if (!blob.type.startsWith('image/')) return
        const blobUrl = URL.createObjectURL(blob)
        const retry = new Image()
        retry.onload = () => {
          if (retry.naturalWidth > 0 && retry.naturalHeight > 0) {
            imageNaturalSize.set(imageUrl, { w: retry.naturalWidth, h: retry.naturalHeight })
            if (typeof document !== 'undefined') {
              document.dispatchEvent(new CustomEvent('scene-ui-image-loaded'))
            }
          }
          URL.revokeObjectURL(blobUrl)
        }
        retry.onerror = () => URL.revokeObjectURL(blobUrl)
        retry.src = blobUrl
      })
      .catch(() => {})
  }
  img.src = imageUrl
  return null
}

/**
 * CSS border-image nine-slice.
 * textureSlices are 0–1 fractions of the source image (Explorer / SDK7).
 * Border widths on the element use source-pixel borders × UI uniform scale once size is known.
 */
function applyNineSlice(
  el: HTMLElement,
  bg: PBUiBackground,
  imageUrl: string,
  scale: UiScreenScale
): void {
  clearBgImg(el)
  const slices = bg.textureSlices ?? DEFAULT_SLICES
  const topF = clamp01(slices.top ?? DEFAULT_SLICES.top)
  const rightF = clamp01(slices.right ?? DEFAULT_SLICES.right)
  const bottomF = clamp01(slices.bottom ?? DEFAULT_SLICES.bottom)
  const leftF = clamp01(slices.left ?? DEFAULT_SLICES.left)

  const safeUrl = imageUrl.replace(/"/g, '%22')
  const tint = color4Css(bg.color)
  const natural = probeImageNaturalSize(imageUrl)
  const u = Math.max(0.2, scale.uniform)

  // Source-image pixel borders when known; else fall back to modest screen px.
  let topPx: number
  let rightPx: number
  let bottomPx: number
  let leftPx: number
  let sliceTop: string
  let sliceRight: string
  let sliceBottom: string
  let sliceLeft: string

  if (natural && natural.w > 0 && natural.h > 0) {
    const srcTop = Math.max(1, Math.round(topF * natural.h))
    const srcRight = Math.max(1, Math.round(rightF * natural.w))
    const srcBottom = Math.max(1, Math.round(bottomF * natural.h))
    const srcLeft = Math.max(1, Math.round(leftF * natural.w))
    // border-image-slice in source pixels (more reliable than % across browsers)
    sliceTop = String(srcTop)
    sliceRight = String(srcRight)
    sliceBottom = String(srcBottom)
    sliceLeft = String(srcLeft)
    // Display border ≈ texture pixels at UI scale (corners stay crisp, center stretches)
    topPx = Math.max(1, srcTop * u)
    rightPx = Math.max(1, srcRight * u)
    bottomPx = Math.max(1, srcBottom * u)
    leftPx = Math.max(1, srcLeft * u)
  } else {
    // Pre-load: % slice of source + provisional border width
    sliceTop = slicePercent(topF)
    sliceRight = slicePercent(rightF)
    sliceBottom = slicePercent(bottomF)
    sliceLeft = slicePercent(leftF)
    topPx = Math.max(4, 24 * u * topF * 3)
    rightPx = Math.max(4, 24 * u * rightF * 3)
    bottomPx = Math.max(4, 24 * u * bottomF * 3)
    leftPx = Math.max(4, 24 * u * leftF * 3)
  }

  if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
  el.style.boxSizing = 'border-box'
  el.style.borderStyle = 'solid'
  el.style.borderColor = 'transparent'
  el.style.borderWidth = `${topPx}px ${rightPx}px ${bottomPx}px ${leftPx}px`
  el.style.borderImageSource = `url("${safeUrl}")`
  el.style.borderImageSlice = `${sliceTop} ${sliceRight} ${sliceBottom} ${sliceLeft} fill`
  el.style.borderImageWidth = `${topPx}px ${rightPx}px ${bottomPx}px ${leftPx}px`
  el.style.borderImageRepeat = 'stretch'
  el.style.borderImageOutset = '0'
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
  el.style.borderImageOutset = ''
  el.style.backgroundBlendMode = ''

  const c = bg?.color
  const tint = color4Css(c)
  if (!imageUrl) {
    clearBgImg(el)
    el.style.backgroundImage = ''
    el.style.backgroundSize = ''
    el.style.backgroundPosition = ''
    el.style.backgroundRepeat = ''
    el.style.borderWidth = ''
    el.style.borderStyle = ''
    el.style.borderColor = ''
    // Missing/failed texture — fall back to color tint (Explorer parity).
    el.style.backgroundColor = tint === 'transparent' ? 'transparent' : tint
    return
  }

  const rawSrc = extractUiTextureSrc(bg?.texture)
  const mode = normalizeBackgroundTextureMode(bg?.textureMode, rawSrc, bg?.textureSlices)
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

/** Test helper — clear natural-size cache between tests. */
export function clearUiBackgroundImageSizeCache(): void {
  imageNaturalSize.clear()
  imageSizeLoading.clear()
}
