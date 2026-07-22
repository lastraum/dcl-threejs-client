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

/**
 * Explorer multiplies UiBackground.color × texture (RGB + A).
 * Poker Night welcome uses white `rounded-rect-white.png` nine-slice + dark/green tints —
 * without this, CSS border-image paints raw white and the panel stays white.
 */
const multipliedImageUrl = new Map<string, string>()
const multipliedImageLoading = new Set<string>()

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function notifyUiImageReady(): void {
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('scene-ui-image-loaded'))
  }
}

/**
 * Explorer multiplies UiBackground.color with the texture (incl. alpha).
 *
 * - No `color` → opaque white (react-ecs default).
 * - Numeric `color.a` (incl. 0) → honor it.
 * - Color present without `a` → opaque (1). Snapshot path must reinstate omitted `a:0`
 *   (protobuf/JSON omit-zero) so dormancy colors like blood_frame stay invisible.
 */
export function effectiveUiBackgroundAlpha(
  color: { r?: number; g?: number; b?: number; a?: number } | null | undefined
): number {
  if (color == null) return 1
  if (typeof color.a === 'number' && Number.isFinite(color.a)) return clamp01(color.a)
  if (Object.prototype.hasOwnProperty.call(color, 'a')) {
    const raw = (color as { a?: unknown }).a
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(n)) return clamp01(n)
  }
  return 1
}

/**
 * Normalize a Color4-like value so `a: 0` survives JSON omit-default / protobuf toJSON.
 * Call before shipping UiBackground rows to main.
 */
export function plainColor4(
  color: { r?: number; g?: number; b?: number; a?: number } | null | undefined
): { r: number; g: number; b: number; a: number } | undefined {
  if (color == null || typeof color !== 'object') return undefined
  const r = typeof color.r === 'number' && Number.isFinite(color.r) ? color.r : 0
  const g = typeof color.g === 'number' && Number.isFinite(color.g) ? color.g : 0
  const b = typeof color.b === 'number' && Number.isFinite(color.b) ? color.b : 0
  // Prefer own-property / getter value (protobuf Message.a returns default 0 when unset
  // on wire for intentional Color4.create(1,1,1,0)).
  let a = 1
  if (typeof color.a === 'number' && Number.isFinite(color.a)) {
    a = color.a
  } else if (Object.prototype.hasOwnProperty.call(color, 'a')) {
    const n = Number((color as { a?: unknown }).a)
    if (Number.isFinite(n)) a = n
  } else {
    // Getter path (protobufjs Message): reading .a yields 0 when field was default-omitted.
    try {
      const got = (color as { a?: unknown }).a
      if (typeof got === 'number' && Number.isFinite(got)) a = got
    } catch {
      /* ignore */
    }
  }
  return { r, g, b, a: clamp01(a) }
}

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
  const a = effectiveUiBackgroundAlpha(c)
  if (a <= 0.01) return 'transparent'
  return `rgba(${r},${g},${b},${a})`
}

/**
 * True when a UiBackground should paint (color and/or texture).
 *
 * Explorer multiplies `color` with the texture — `color.a === 0` means fully
 * invisible even when a texture is set. Dead Surge keeps a full-screen
 * `blood_frame.png` mounted at alpha 0 as a dormant damage vignette; painting
 * that texture opaque would show a circular "hit" frame under the tutorial.
 */
export function hasUiVisualBackground(
  bg: PBUiBackground | null | undefined,
  imageUrl?: string | null
): boolean {
  if (!bg) return false
  if (effectiveUiBackgroundAlpha(bg.color) <= 0.01) return false
  if (imageUrl || hasUiBackgroundTexture(bg)) return true
  return true
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

/** Near-white RGB only (alpha ignored). */
function isWhiteRgb(c: { r?: number; g?: number; b?: number; a?: number } | undefined): boolean {
  if (!c) return true
  return (c.r ?? 1) >= 0.99 && (c.g ?? 1) >= 0.99 && (c.b ?? 1) >= 0.99
}

function isOpaqueWhite(c: { r?: number; g?: number; b?: number; a?: number } | undefined): boolean {
  if (!c) return true
  return isWhiteRgb(c) && effectiveUiBackgroundAlpha(c) >= 0.99
}

function isOpaqueBlack(c: { r?: number; g?: number; b?: number; a?: number } | undefined): boolean {
  if (!c) return false
  return (c.r ?? 0) <= 0.01 && (c.g ?? 0) <= 0.01 && (c.b ?? 0) <= 0.01 && (c.a ?? 1) > 0.5
}

function colorMultiplyKey(
  imageUrl: string,
  c: { r?: number; g?: number; b?: number; a?: number }
): string {
  const r = Math.round(clamp01(c.r ?? 1) * 1000)
  const g = Math.round(clamp01(c.g ?? 1) * 1000)
  const b = Math.round(clamp01(c.b ?? 1) * 1000)
  const a = Math.round(effectiveUiBackgroundAlpha(c) * 1000)
  return `${imageUrl}|${r},${g},${b},${a}`
}

/**
 * True when RGB tint must be baked into the texture (Explorer color×texture).
 *
 * **White RGB + any alpha** does NOT need canvas bake — CSS `img.opacity` matches
 * Explorer `Color4(1,1,1,a)` multiply. Canvas bake on animated alpha (CBD Plaza
 * welcome splash fades 0→0.92→0) was re-baking every frame and, while pending or
 * on CORS/getImageData failure, left a solid white panel forever.
 *
 * Dark/tinted RGB (Poker welcome, green buttons) still needs premultiply bake.
 */
function needsTextureColorMultiply(
  c: { r?: number; g?: number; b?: number; a?: number } | null | undefined
): boolean {
  if (!c) return false
  if (isWhiteRgb(c)) return false
  if (isOpaqueWhite(c)) return false
  return true
}

/**
 * Return a blob URL of `imageUrl` with per-texel color multiply, or null while baking.
 * Fires `scene-ui-image-loaded` when a bake completes so the DOM can repaint.
 *
 * On hard failure, caches `imageUrl` itself under the multiply key so callers stop
 * painting solid tint forever (CBD Plaza welcome splash).
 */
function resolveColorMultipliedImageUrl(
  imageUrl: string,
  c: { r?: number; g?: number; b?: number; a?: number }
): string | null {
  const key = colorMultiplyKey(imageUrl, c)
  const hit = multipliedImageUrl.get(key)
  if (hit) return hit
  if (multipliedImageLoading.has(key)) return null
  multipliedImageLoading.add(key)

  const mr = clamp01(c.r ?? 1)
  const mg = clamp01(c.g ?? 1)
  const mb = clamp01(c.b ?? 1)
  const ma = effectiveUiBackgroundAlpha(c)

  const failBake = (): void => {
    // Prefer raw texture over permanent white solid panel.
    multipliedImageUrl.set(key, imageUrl)
    multipliedImageLoading.delete(key)
    notifyUiImageReady()
  }

  const bake = (img: HTMLImageElement) => {
    try {
      const w = img.naturalWidth || img.width
      const h = img.naturalHeight || img.height
      if (w < 1 || h < 1) throw new Error('empty image')
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('no 2d')
      ctx.drawImage(img, 0, 0)
      const imageData = ctx.getImageData(0, 0, w, h)
      const d = imageData.data
      for (let i = 0; i < d.length; i += 4) {
        d[i] = Math.round((d[i] ?? 0) * mr)
        d[i + 1] = Math.round((d[i + 1] ?? 0) * mg)
        d[i + 2] = Math.round((d[i + 2] ?? 0) * mb)
        d[i + 3] = Math.round((d[i + 3] ?? 0) * ma)
      }
      ctx.putImageData(imageData, 0, 0)
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            failBake()
            return
          }
          const url = URL.createObjectURL(blob)
          multipliedImageUrl.set(key, url)
          multipliedImageLoading.delete(key)
          notifyUiImageReady()
        },
        'image/png'
      )
    } catch {
      failBake()
    }
  }

  const img = new Image()
  img.decoding = 'async'
  img.crossOrigin = 'anonymous'
  img.onload = () => bake(img)
  img.onerror = () => {
    void fetch(imageUrl)
      .then((res) => (res.ok ? res.blob() : Promise.reject()))
      .then((blob) => {
        const blobUrl = URL.createObjectURL(blob)
        const retry = new Image()
        retry.onload = () => {
          bake(retry)
          URL.revokeObjectURL(blobUrl)
        }
        retry.onerror = () => {
          URL.revokeObjectURL(blobUrl)
          failBake()
        }
        retry.src = blobUrl
      })
      .catch(() => {
        failBake()
      })
  }
  img.src = imageUrl
  return null
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

/**
 * Parse UiBackground.uvs — 8 floats, bottom-left clockwise (Explorer / SDK7):
 *   [u0,v0, u1,v1, u2,v2, u3,v3] = BL, TL, TR, BR
 * Dead Surge atlas: createAtlasUvs → [left,bottom, left,top, right,top, right,bottom].
 * Returns axis-aligned UV rect, or null when full texture / unusable.
 */
export function parseUiBackgroundUvRect(
  uvs: number[] | null | undefined
): { u0: number; v0: number; u1: number; v1: number } | null {
  if (!uvs || uvs.length < 8) return null
  const nums = uvs.map((n) => Number(n))
  if (nums.some((n) => !Number.isFinite(n))) return null
  // Prefer corners BL/TR; also min/max in case winding differs.
  const us = [nums[0]!, nums[2]!, nums[4]!, nums[6]!]
  const vs = [nums[1]!, nums[3]!, nums[5]!, nums[7]!]
  const u0 = Math.min(...us)
  const u1 = Math.max(...us)
  const v0 = Math.min(...vs)
  const v1 = Math.max(...vs)
  if (u1 - u0 < 1e-5 || v1 - v0 < 1e-5) return null
  // Full-texture default — treat as no crop (object-fit path).
  if (u0 <= 1e-5 && v0 <= 1e-5 && u1 >= 1 - 1e-5 && v1 >= 1 - 1e-5) return null
  return { u0, v0, u1, v1 }
}

function applyBgImg(
  el: HTMLElement,
  imageUrl: string,
  mode: number,
  colorAlpha = 1,
  uvs?: number[] | null
): void {
  const img = ensureBgImg(el)
  assignUiImageSrc(img, imageUrl)
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
  img.style.position = 'absolute'
  img.style.pointerEvents = 'none'
  // Explorer multiplies UiBackground.color with the texture (incl. alpha).
  img.style.opacity = String(clamp01(colorAlpha))
  img.style.borderRadius = 'inherit'
  img.style.objectFit = 'fill'
  img.style.objectPosition = 'center'

  // Atlas UV crop (stretch + uvs) — clip sheet sprite into the element box.
  // Without this, Dead Surge lobby buttons paint the whole HUD_LOBBY2 atlas
  // squashed into each small rect ("UI scaled wrong").
  const rect =
    mode === BackgroundTextureMode.STRETCH ? parseUiBackgroundUvRect(uvs) : null
  if (rect) {
    const { u0, v0, u1, v1 } = rect
    const uSpan = u1 - u0
    const vSpan = v1 - v0
    // GL v=0 bottom; CSS top=0 top → image top edge is at (1 - v1).
    el.style.overflow = 'hidden'
    img.style.inset = 'unset'
    img.style.right = 'auto'
    img.style.bottom = 'auto'
    img.style.width = `${(100 / uSpan).toFixed(4)}%`
    img.style.height = `${(100 / vSpan).toFixed(4)}%`
    img.style.left = `${((-u0 / uSpan) * 100).toFixed(4)}%`
    img.style.top = `${((-(1 - v1) / vSpan) * 100).toFixed(4)}%`
  } else {
    el.style.overflow = ''
    img.style.inset = '0'
    img.style.left = ''
    img.style.top = ''
    img.style.right = ''
    img.style.bottom = ''
    img.style.width = '100%'
    img.style.height = '100%'
    img.style.objectFit = mode === BackgroundTextureMode.CENTER ? 'contain' : 'fill'
  }

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

/** Instant solid fill (Explorer color×white-sheet) with slice-based corner radius. */
function applySolidColorPanel(
  el: HTMLElement,
  tint: string,
  topF: number,
  rightF: number,
  bottomF: number,
  leftF: number
): void {
  el.style.borderImage = ''
  el.style.borderImageSource = ''
  el.style.borderImageSlice = ''
  el.style.borderImageWidth = ''
  el.style.borderImageRepeat = ''
  el.style.borderImageOutset = ''
  el.style.borderWidth = ''
  el.style.borderStyle = ''
  el.style.borderColor = ''
  el.style.backgroundImage = ''
  el.style.backgroundSize = ''
  el.style.backgroundPosition = ''
  el.style.backgroundRepeat = ''
  el.style.backgroundColor = tint === 'transparent' ? 'transparent' : tint
  el.style.opacity = '1'
  // Approximate 0.2 nine-slice corners (Poker rounded-rect-white).
  const r = Math.round(Math.max(topF, rightF, bottomF, leftF) * 48)
  el.style.borderRadius = `${Math.max(8, r)}px`
}

/**
 * CSS border-image nine-slice.
 * textureSlices are 0–1 fractions of the source image (Explorer / SDK7).
 * Border widths on the element use source-pixel borders × UI uniform scale once size is known.
 *
 * Explorer multiplies UiBackground.color × texture. White panel sheets + dark tints
 * (Poker welcome `#050510FE`) need a pre-multiplied source or the panel stays white.
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

  const tint = color4Css(bg.color)
  const multiply = needsTextureColorMultiply(bg.color)
  // Explorer multiplies white nine-slice sheets × Color4 (Poker welcome #050510, green buttons).
  // Never paint the raw white texture — that flashes white/purple for ~1s. Solid tint is
  // instant and correct for opaque tints; upgrade to pre-multiplied nine-slice only when
  // the bake is already cached (same session).
  let paintUrl = imageUrl
  if (multiply && bg.color) {
    const baked = resolveColorMultipliedImageUrl(imageUrl, bg.color)
    if (!baked) {
      applySolidColorPanel(el, tint, topF, rightF, bottomF, leftF)
      return
    }
    paintUrl = baked
  }

  const safeUrl = paintUrl.replace(/"/g, '%22')
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
  // RGB+A already in premultiplied texture; avoid double-applying alpha.
  el.style.opacity = multiply ? '1' : String(effectiveUiBackgroundAlpha(bg.color))
  el.style.backgroundImage = ''
  el.style.backgroundSize = ''
  el.style.backgroundPosition = ''
  el.style.backgroundRepeat = ''
  el.style.backgroundColor = 'transparent'
  el.style.backgroundBlendMode = ''
  el.style.borderRadius = ''
}

/** Apply PBUiBackground color + texture to a DOM node. */
export function applyUiBackgroundStyles(
  el: HTMLElement,
  bg: PBUiBackground | null | undefined,
  imageUrl: string | null,
  scale?: UiScreenScale
): void {
  const c = bg?.color
  const tint = color4Css(c)
  const rawSrc = extractUiTextureSrc(bg?.texture)
  const mode = imageUrl
    ? normalizeBackgroundTextureMode(bg?.textureMode, rawSrc, bg?.textureSlices)
    : -1
  // Skip full style thrash when paint re-visits stable PE HUD panels every tick.
  // Clearing borderImage / swapping solid→texture every frame is the PX UI flash.
  const uvsKey = bg?.uvs?.length ? bg.uvs.map((n) => Number(n).toFixed(4)).join(',') : ''
  const sig = `${imageUrl ?? ''}|${mode}|${tint}|${uvsKey}`
  if (el.dataset.dclUiBgSig === sig) return
  el.dataset.dclUiBgSig = sig

  el.style.borderImage = ''
  el.style.borderImageSource = ''
  el.style.borderImageSlice = ''
  el.style.borderImageWidth = ''
  el.style.borderImageRepeat = ''
  el.style.borderImageOutset = ''
  el.style.backgroundBlendMode = ''

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

  const screenScale = scale ?? { scaleX: 1, scaleY: 1, uniform: 1 }

  if (mode === BackgroundTextureMode.NINE_SLICES) {
    applyNineSlice(el, bg!, imageUrl, screenScale)
    return
  }

  if (isOpaqueBlack(c) && hasUiBackgroundTexture(bg)) {
    el.style.backgroundColor = 'transparent'
  }

  // Stretch/center: Explorer multiplies full Color4 × texture (not alpha alone).
  // White RGB + alpha → raw texture + CSS opacity (splash fades, no canvas thrash).
  let paintUrl = imageUrl
  let imgAlpha = effectiveUiBackgroundAlpha(c)
  if (c && needsTextureColorMultiply(c)) {
    const baked = resolveColorMultipliedImageUrl(imageUrl, c)
    if (!baked) {
      // Dark tint bake in flight — solid tint, not raw white sheet.
      // (White RGB never enters this branch; see needsTextureColorMultiply.)
      clearBgImg(el)
      el.style.backgroundImage = ''
      el.style.backgroundColor = tint === 'transparent' ? 'transparent' : tint
      el.style.opacity = '1'
      el.style.borderRadius = el.style.borderRadius || '10px'
      return
    }
    paintUrl = baked
    // When failBake cached the raw URL, still apply CSS alpha.
    imgAlpha = baked === imageUrl ? effectiveUiBackgroundAlpha(c) : 1
  }

  // Clear any leftover nine-slice opacity on this element (alpha lives on the img).
  el.style.opacity = ''
  el.style.backgroundColor = 'transparent'
  applyBgImg(el, paintUrl, mode, imgAlpha, bg?.uvs)
}

/** Test helper — clear natural-size cache between tests. */
export function clearUiBackgroundImageSizeCache(): void {
  imageNaturalSize.clear()
  imageSizeLoading.clear()
  for (const url of multipliedImageUrl.values()) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* ignore */
    }
  }
  multipliedImageUrl.clear()
  multipliedImageLoading.clear()
}
