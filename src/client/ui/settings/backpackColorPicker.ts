import type { WearableCategory } from '../../../avatar/types'

/** Avatar body colors the backpack can tint. */
export type ColorChannel = 'eyes' | 'hair' | 'skin'

/**
 * Which body color a category's detail panel edits. Mirrors the desktop client:
 * EYES → eye color, HAIR → hair color, BODY SHAPE → skin color.
 */
export function tintChannelForCategory(category: WearableCategory | 'unknown'): ColorChannel | null {
  if (category === 'eyes') return 'eyes'
  if (category === 'hair') return 'hair'
  if (category === 'body_shape') return 'skin'
  return null
}

/**
 * Preset swatches (hex without `#`, optional common color name for the tooltip).
 * Skin tones intentionally have no names — labeling them risks culturally loaded
 * descriptors — so they fall back to the hex value.
 */
export const COLOR_PRESETS: Record<ColorChannel, Array<{ hex: string; name?: string }>> = {
  skin: [
    { hex: 'ffe4c6' },
    { hex: 'f2c2a1' },
    { hex: 'e5a980' },
    { hex: 'cc9b76' },
    { hex: 'b47a53' },
    { hex: '8a5b3e' },
    { hex: '6b4432' },
    { hex: '4a2c22' },
    { hex: '38211a' },
    { hex: '26140d' }
  ],
  hair: [
    { hex: '090909', name: 'Black' },
    { hex: '2c1e14', name: 'Dark Brown' },
    { hex: '4a3121', name: 'Brown' },
    { hex: '5a4032', name: 'Chestnut' },
    { hex: '7a3a23', name: 'Auburn' },
    { hex: 'b8551f', name: 'Ginger' },
    { hex: 'c19a6b', name: 'Dark Blonde' },
    { hex: 'e0c39a', name: 'Blonde' },
    { hex: 'b7b7b7', name: 'Gray' },
    { hex: 'ede1c8', name: 'Platinum' }
  ],
  eyes: [
    { hex: '2a1e14', name: 'Dark Brown' },
    { hex: '5c3a1e', name: 'Brown' },
    { hex: '8a5a2b', name: 'Amber' },
    { hex: 'b08d4a', name: 'Hazel' },
    { hex: '7a7a7a', name: 'Gray' },
    { hex: 'a9c7d8', name: 'Pale Blue' },
    { hex: '3ba8c9', name: 'Cyan' },
    { hex: '2f6fb0', name: 'Blue' },
    { hex: '4a9b52', name: 'Green' },
    { hex: '2f7a3f', name: 'Dark Green' }
  ]
}

function normalizeHex(hex: string): string {
  const raw = hex.replace('#', '').toLowerCase()
  return raw.length === 6 ? raw : '000000'
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = normalizeHex(hex)
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16)
  }
}

/** Iris-weighting + reference iris luminance — must match the eye shader (face.ts). */
const EYE_TINT_BOOST = 1.7
const EYE_REF_LUM = 0.3

/** sRGB 0-255 → linear 0-1. Tinting must match the shader, which works in linear space. */
function srgbToLinear(c: number): number {
  const n = c / 255
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4)
}

/** linear 0-1 → sRGB 0-255. */
function linearToSrgb(c: number): number {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, s)) * 255)
}

/**
 * Tints a transparent grayscale thumbnail (base eyes) toward `hex`, weighting by darkness
 * so the white sclera stays white and only the iris takes color — mirroring the 3D shader.
 * The source is loaded once and cached; each call re-tints from the cached pixels. Returns a
 * data URL, or null if the image can't be read (CORS/load failure) so the caller keeps the original.
 */
export function makeThumbnailTinter(url: string): (hex: string) => Promise<string | null> {
  let basePromise: Promise<ImageData | null> | null = null

  const loadBase = (): Promise<ImageData | null> => {
    if (basePromise) return basePromise
    basePromise = new Promise((resolve) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
          const ctx = canvas.getContext('2d')
          if (!ctx) return resolve(null)
          ctx.drawImage(img, 0, 0)
          resolve(ctx.getImageData(0, 0, canvas.width, canvas.height))
        } catch (err) {
          console.warn('[backpack] eye thumbnail tint failed (canvas read)', err)
          resolve(null)
        }
      }
      img.onerror = () => {
        console.warn('[backpack] eye thumbnail tint failed (load)', url)
        resolve(null)
      }
      // Distinct query so this CORS request isn't served from the non-CORS cache entry
      // the visible <img> already populated (which would taint the canvas).
      img.src = url + (url.includes('?') ? '&' : '?') + 'tintcors=1'
    })
    return basePromise
  }

  return async (hex: string): Promise<string | null> => {
    const base = await loadBase()
    if (!base) return null
    const tint = hexToRgb(hex)
    const tintL = [srgbToLinear(tint.r), srgbToLinear(tint.g), srgbToLinear(tint.b)]
    const out = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height)
    const d = out.data
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue
      const rl = srgbToLinear(d[i])
      const gl = srgbToLinear(d[i + 1])
      const bl = srgbToLinear(d[i + 2])
      const lum = Math.max(rl, gl, bl)
      // Iris weight (sclera→0, iris→1), then tint × brightness-relative-to-reference so a
      // mid-iris pixel = the picked color exactly — identical model to the eye shader (face.ts).
      const w = Math.min(1, (1 - lum) * EYE_TINT_BOOST)
      const shade = lum / EYE_REF_LUM
      d[i] = linearToSrgb(rl + (tintL[0] * shade - rl) * w)
      d[i + 1] = linearToSrgb(gl + (tintL[1] * shade - gl) * w)
      d[i + 2] = linearToSrgb(bl + (tintL[2] * shade - bl) * w)
    }
    const canvas = document.createElement('canvas')
    canvas.width = out.width
    canvas.height = out.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.putImageData(out, 0, 0)
    return canvas.toDataURL()
  }
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const n = normalizeHex(hex)
  const r = parseInt(n.slice(0, 2), 16) / 255
  const g = parseInt(n.slice(2, 4), 16) / 255
  const b = parseInt(n.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  return { h, s: s * 100, v: max * 100 }
}

export function hsvToHex(h: number, s: number, v: number): string {
  const sn = s / 100
  const vn = v / 100
  const c = vn * sn
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = vn - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g] = [c, x]
  else if (h < 120) [r, g] = [x, c]
  else if (h < 180) [g, b] = [c, x]
  else if (h < 240) [g, b] = [x, c]
  else if (h < 300) [r, b] = [x, c]
  else [r, b] = [c, x]
  const to = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return to(r) + to(g) + to(b)
}

type Slider = { wrap: HTMLElement; input: HTMLInputElement }

function makeSlider(name: string, max: number, value: number): Slider {
  const wrap = document.createElement('label')
  wrap.className = 'backpack-color__slider'
  const cap = document.createElement('span')
  cap.className = 'backpack-color__slider-label'
  cap.textContent = name
  const input = document.createElement('input')
  input.className = 'backpack-color__range'
  input.type = 'range'
  input.min = '0'
  input.max = String(max)
  input.step = '1'
  input.value = String(Math.round(value))
  if (name === 'Hue') {
    input.style.background =
      'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)'
  }
  wrap.append(cap, input)
  return { wrap, input }
}

/**
 * Inline HSV color control (swatch + presets + hue/sat/brightness sliders).
 * `onCommit` fires on preset click and slider release (not during drag) so the
 * avatar recompose runs once per adjustment, not per pixel.
 */
export function createColorPicker(opts: {
  channel: ColorChannel
  value: string
  onCommit: (hex: string) => void
}): HTMLElement {
  const hsv = hexToHsv(opts.value)

  const root = document.createElement('div')
  root.className = 'backpack-color'

  const header = document.createElement('div')
  header.className = 'backpack-color__header'
  const label = document.createElement('span')
  label.className = 'backpack-color__label'
  label.textContent = 'COLOR'
  const swatch = document.createElement('span')
  swatch.className = 'backpack-color__swatch'
  header.append(label, swatch)

  const presetsWrap = document.createElement('div')
  presetsWrap.className = 'backpack-color__presets'

  const hue = makeSlider('Hue', 360, hsv.h)
  const sat = makeSlider('Saturation', 100, hsv.s)
  const bri = makeSlider('Brightness', 100, hsv.v)

  const currentHex = (): string =>
    hsvToHex(Number(hue.input.value), Number(sat.input.value), Number(bri.input.value))

  const refresh = (): void => {
    const h = Number(hue.input.value)
    const s = Number(sat.input.value)
    const v = Number(bri.input.value)
    swatch.style.background = `#${currentHex()}`
    sat.input.style.background = `linear-gradient(90deg,#${hsvToHex(h, 0, v)},#${hsvToHex(h, 100, v)})`
    bri.input.style.background = `linear-gradient(90deg,#000,#${hsvToHex(h, s, 100)})`
  }

  const setFromHex = (hex: string): void => {
    const next = hexToHsv(hex)
    hue.input.value = String(Math.round(next.h))
    sat.input.value = String(Math.round(next.s))
    bri.input.value = String(Math.round(next.v))
    refresh()
  }

  for (const { hex, name } of COLOR_PRESETS[opts.channel]) {
    const label = name ?? `#${hex}`
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'backpack-color__preset'
    btn.style.background = `#${hex}`
    btn.title = label
    btn.setAttribute('aria-label', label)
    btn.addEventListener('click', () => {
      setFromHex(hex)
      opts.onCommit(hex)
    })
    presetsWrap.appendChild(btn)
  }

  for (const s of [hue, sat, bri]) {
    s.input.addEventListener('input', refresh)
    s.input.addEventListener('change', () => opts.onCommit(currentHex()))
  }

  refresh()
  root.append(header, presetsWrap, hue.wrap, sat.wrap, bri.wrap)
  return root
}
