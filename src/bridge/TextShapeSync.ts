import * as THREE from 'three'
import type { PBTextShape } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/text_shape.gen'
import { buildDclPlaneGeometry } from './primitiveShapes'
import { color3ToThree, color4Alpha, color4ToThree } from './pbColor'

/** TextAlignMode numeric values (const enum — avoid isolatedModules import). */
const TAM = {
  TOP_LEFT: 0,
  TOP_CENTER: 1,
  TOP_RIGHT: 2,
  MIDDLE_LEFT: 3,
  MIDDLE_CENTER: 4,
  MIDDLE_RIGHT: 5,
  BOTTOM_LEFT: 6,
  BOTTOM_CENTER: 7,
  BOTTOM_RIGHT: 8
} as const

/**
 * DCL TextShape is world-space text (Unity TMP-like).
 *
 * - `width` / `height` — plane size in meters (default 1×1)
 * - `fontSize` — roughly proportional to glyph height in meters × 10
 *   (leaderboard rows use ~1.2–1.6; lobby title uses ~8.3 on a taller plane)
 * - `textColor` defaults to white (Explorer); black-on-black boards are unreadable otherwise
 *
 * Previous `fontSize * 4` on a fixed 512×256 canvas left 1.x sizes at ~8px → invisible.
 */

/** Canvas pixels per world-meter of plane edge (capped for GPU). */
const PIXELS_PER_METER = 160
const CANVAS_MIN = 128
const CANVAS_MAX = 2048

/** fontSize N → ~N/10 meters glyph height at transform scale 1 (Explorer-ish). */
const FONT_SIZE_TO_METERS = 0.1

export function buildTextShapeMesh(spec: PBTextShape): THREE.Mesh {
  const planeW = Math.max(0.01, spec.width ?? 1)
  const planeH = Math.max(0.01, spec.height ?? 1)
  const { canvasW, canvasH } = canvasSizeForPlane(planeW, planeH)

  const canvas = document.createElement('canvas')
  canvas.width = canvasW
  canvas.height = canvasH
  const ctx = canvas.getContext('2d')!
  paintTextShape(ctx, spec, canvasW, canvasH, planeW, planeH)

  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace

  const geometry = buildDclPlaneGeometry(planeW, planeH)
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.userData.textShapeSignature = textShapeSignature(spec)
  mesh.userData.textShapeCanvas = canvas
  return mesh
}

export function updateTextShapeMesh(mesh: THREE.Mesh, spec: PBTextShape): void {
  const sig = textShapeSignature(spec)
  if (mesh.userData.textShapeSignature === sig) return
  mesh.userData.textShapeSignature = sig

  const planeW = Math.max(0.01, spec.width ?? 1)
  const planeH = Math.max(0.01, spec.height ?? 1)
  const { canvasW, canvasH } = canvasSizeForPlane(planeW, planeH)

  const mat = mesh.material as THREE.MeshBasicMaterial
  let map = mat.map as THREE.CanvasTexture | null
  let canvas = (mesh.userData.textShapeCanvas as HTMLCanvasElement | undefined) ?? null

  if (!canvas || canvas.width !== canvasW || canvas.height !== canvasH) {
    canvas = document.createElement('canvas')
    canvas.width = canvasW
    canvas.height = canvasH
    mesh.userData.textShapeCanvas = canvas
    map?.dispose()
    map = new THREE.CanvasTexture(canvas)
    map.minFilter = THREE.LinearFilter
    map.magFilter = THREE.LinearFilter
    map.generateMipmaps = false
    map.colorSpace = THREE.SRGBColorSpace
    mat.map = map
  }

  const ctx = canvas.getContext('2d')!
  paintTextShape(ctx, spec, canvasW, canvasH, planeW, planeH)
  if (map) map.needsUpdate = true
  mat.needsUpdate = true

  mesh.geometry.dispose()
  mesh.geometry = buildDclPlaneGeometry(planeW, planeH)
}

export function disposeTextShapeMesh(mesh: THREE.Object3D): void {
  if (!(mesh instanceof THREE.Mesh)) return
  mesh.geometry.dispose()
  const mat = mesh.material
  if (Array.isArray(mat)) mat.forEach(disposeMat)
  else disposeMat(mat)
}

function disposeMat(m: THREE.Material): void {
  const map = (m as THREE.MeshBasicMaterial).map
  map?.dispose()
  m.dispose()
}

function canvasSizeForPlane(planeW: number, planeH: number): { canvasW: number; canvasH: number } {
  const canvasW = Math.min(CANVAS_MAX, Math.max(CANVAS_MIN, Math.round(planeW * PIXELS_PER_METER)))
  const canvasH = Math.min(CANVAS_MAX, Math.max(CANVAS_MIN, Math.round(planeH * PIXELS_PER_METER)))
  return { canvasW, canvasH }
}

function textShapeSignature(spec: PBTextShape): string {
  return JSON.stringify({
    text: spec.text,
    fontSize: spec.fontSize,
    fontAutoSize: spec.fontAutoSize,
    textAlign: spec.textAlign,
    width: spec.width,
    height: spec.height,
    textColor: spec.textColor,
    outlineWidth: spec.outlineWidth,
    outlineColor: spec.outlineColor,
    shadowBlur: spec.shadowBlur,
    shadowOffsetX: spec.shadowOffsetX,
    shadowOffsetY: spec.shadowOffsetY,
    shadowColor: spec.shadowColor,
    textWrapping: spec.textWrapping,
    lineSpacing: spec.lineSpacing,
    lineCount: spec.lineCount,
    paddingTop: spec.paddingTop,
    paddingRight: spec.paddingRight,
    paddingBottom: spec.paddingBottom,
    paddingLeft: spec.paddingLeft,
    font: spec.font
  })
}

/** Strip DCL / TextMeshPro-style tags so canvas text matches Explorer (no raw `<color=…>`). */
function stripTextShapeMarkup(text: string): string {
  return text
    .replace(/<\/?(?:b|i|u)>/gi, '')
    .replace(/<\/?color(?:=[^>]*)?>/gi, '')
    .replace(/<\/?size(?:=[^>]*)?>/gi, '')
    .replace(/<\/?space(?:=[^>]*)?>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
}

/**
 * Explorer default text color is white. Protobuf omit / empty objects must not
 * paint black-on-black (leaderboard on #111111 board).
 */
function resolveTextFill(spec: PBTextShape): { color: THREE.Color; alpha: number } {
  const c = spec.textColor
  if (!c) return { color: new THREE.Color(0xffffff), alpha: 1 }
  const r = c.r
  const g = c.g
  const b = c.b
  // Fully missing channels after omit-zero → treat as white default
  if (r === undefined && g === undefined && b === undefined) {
    return { color: new THREE.Color(0xffffff), alpha: color4Alpha(c, 1) }
  }
  return {
    color: color4ToThree(c, 0xffffff),
    alpha: color4Alpha(c, 1)
  }
}

function fontFamilyForSpec(spec: PBTextShape): string {
  // Font enum: 0 sans, 1 serif, 2 mono
  const f = spec.font
  if (f === 1) return 'Georgia, "Times New Roman", serif'
  if (f === 2) return 'ui-monospace, "Cascadia Code", Menlo, monospace'
  return 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
}

function alignFromSpec(spec: PBTextShape): {
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  h: 'left' | 'center' | 'right'
  v: 'top' | 'middle' | 'bottom'
} {
  const a = spec.textAlign ?? TAM.MIDDLE_CENTER
  switch (a) {
    case TAM.TOP_LEFT:
      return { textAlign: 'left', textBaseline: 'top', h: 'left', v: 'top' }
    case TAM.TOP_CENTER:
      return { textAlign: 'center', textBaseline: 'top', h: 'center', v: 'top' }
    case TAM.TOP_RIGHT:
      return { textAlign: 'right', textBaseline: 'top', h: 'right', v: 'top' }
    case TAM.MIDDLE_LEFT:
      return { textAlign: 'left', textBaseline: 'middle', h: 'left', v: 'middle' }
    case TAM.MIDDLE_RIGHT:
      return { textAlign: 'right', textBaseline: 'middle', h: 'right', v: 'middle' }
    case TAM.BOTTOM_LEFT:
      return { textAlign: 'left', textBaseline: 'bottom', h: 'left', v: 'bottom' }
    case TAM.BOTTOM_CENTER:
      return { textAlign: 'center', textBaseline: 'bottom', h: 'center', v: 'bottom' }
    case TAM.BOTTOM_RIGHT:
      return { textAlign: 'right', textBaseline: 'bottom', h: 'right', v: 'bottom' }
    case TAM.MIDDLE_CENTER:
    default:
      return { textAlign: 'center', textBaseline: 'middle', h: 'center', v: 'middle' }
  }
}

function paintTextShape(
  ctx: CanvasRenderingContext2D,
  spec: PBTextShape,
  w: number,
  h: number,
  _planeW: number,
  planeH: number
): void {
  ctx.clearRect(0, 0, w, h)
  ctx.imageSmoothingEnabled = true

  // Padding is in plane-relative units (0–1-ish of width/height in scene authoring).
  const padL = Math.max(0, (spec.paddingLeft ?? 0) * w * 0.5)
  const padR = Math.max(0, (spec.paddingRight ?? 0) * w * 0.5)
  const padT = Math.max(0, (spec.paddingTop ?? 0) * h * 0.5)
  const padB = Math.max(0, (spec.paddingBottom ?? 0) * h * 0.5)
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, h - padT - padB)

  const fontSizeSpec = spec.fontSize ?? 10
  // World glyph height (m) → canvas px via plane mapping
  const glyphMeters = Math.max(0.02, fontSizeSpec * FONT_SIZE_TO_METERS)
  let fontPx = glyphMeters * (h / Math.max(0.01, planeH))

  if (spec.fontAutoSize) {
    // Fit a single line to ~70% of inner height (and width check below)
    fontPx = Math.min(fontPx, innerH * 0.7)
  }

  fontPx = Math.max(10, Math.min(fontPx, innerH * 0.95))

  const family = fontFamilyForSpec(spec)
  const align = alignFromSpec(spec)
  ctx.font = `600 ${fontPx}px ${family}`
  ctx.textAlign = align.textAlign
  ctx.textBaseline = align.textBaseline

  const { color: fill, alpha } = resolveTextFill(spec)
  const outline = color3ToThree(spec.outlineColor, 0x000000)
  const shadow = color3ToThree(spec.shadowColor, 0x000000)
  const outlineWidth = spec.outlineWidth ?? 0
  const shadowBlur = spec.shadowBlur ?? 0
  const shadowX = spec.shadowOffsetX ?? 0
  const shadowY = spec.shadowOffsetY ?? 0

  let plain = stripTextShapeMarkup(spec.text ?? '')
  if (spec.lineCount != null && spec.lineCount > 0) {
    // Soft cap: keep first N lines after wrap
  }

  // Shrink-to-fit: fontAutoSize always; without it still shrink when non-wrapping
  // text overflows the plane (lobby title: width 6, fontSize 8.3 → was clipped to
  // "layers Joined: 0/" missing P and 5). Explorer TMP fits the rect.
  const shouldFitWidth = spec.fontAutoSize === true || spec.textWrapping !== true
  if (shouldFitWidth) {
    for (let guard = 0; guard < 24; guard++) {
      ctx.font = `600 ${fontPx}px ${family}`
      const lines = wrapLines(ctx, plain, innerW, spec.textWrapping === true)
      const widest = Math.max(0, ...lines.map((ln) => ctx.measureText(ln).width))
      const lineHeight = fontPx * (1.15 + (spec.lineSpacing ?? 0) * 0.1)
      const blockH = lines.length * lineHeight
      const widthOk = widest <= innerW * 0.98
      const heightOk = !spec.fontAutoSize || blockH <= innerH * 1.02
      if (widthOk && heightOk) break
      fontPx *= 0.9
      if (fontPx < 8) break
    }
  }

  ctx.font = `600 ${fontPx}px ${family}`
  let lines = wrapLines(ctx, plain, innerW, spec.textWrapping === true)
  if (spec.lineCount != null && spec.lineCount > 0 && lines.length > spec.lineCount) {
    lines = lines.slice(0, spec.lineCount)
  }

  const lineHeight = fontPx * (1.15 + (spec.lineSpacing ?? 0) * 0.1)
  const blockH = lines.length * lineHeight

  let startY: number
  if (align.v === 'top') startY = padT + lineHeight * 0.5
  else if (align.v === 'bottom') startY = padT + innerH - blockH + lineHeight * 0.5
  else startY = padT + innerH / 2 - blockH / 2 + lineHeight / 2

  const xFor = (): number => {
    if (align.h === 'left') return padL
    if (align.h === 'right') return padL + innerW
    return padL + innerW / 2
  }

  // Outline width: DCL uses ~0–1 relative; scale to canvas stroke
  const strokePx = outlineWidth > 0 ? Math.max(1, outlineWidth * fontPx * 0.35) : 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const x = xFor()
    const y = startY + i * lineHeight

    if (shadowBlur > 0 || shadowX !== 0 || shadowY !== 0) {
      ctx.shadowColor = `#${shadow.getHexString()}`
      ctx.shadowBlur = shadowBlur * fontPx * 0.5
      ctx.shadowOffsetX = shadowX * fontPx * 0.15
      ctx.shadowOffsetY = shadowY * fontPx * 0.15
    } else {
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 0
    }

    if (strokePx > 0) {
      ctx.strokeStyle = `#${outline.getHexString()}`
      ctx.lineWidth = strokePx
      ctx.lineJoin = 'round'
      ctx.strokeText(line, x, y)
    }

    ctx.shadowColor = 'transparent'
    ctx.fillStyle = `rgba(${Math.round(fill.r * 255)},${Math.round(fill.g * 255)},${Math.round(fill.b * 255)},${alpha})`
    ctx.fillText(line, x, y)
  }
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, wrap: boolean): string[] {
  const paragraphs = text.split(/\n/)
  if (!wrap) return paragraphs.length ? paragraphs : ['']
  const lines: string[] = []
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const test = line ? `${line} ${word}` : word
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line)
        line = word
      } else {
        line = test
      }
    }
    if (line) lines.push(line)
  }
  return lines.length ? lines : ['']
}
