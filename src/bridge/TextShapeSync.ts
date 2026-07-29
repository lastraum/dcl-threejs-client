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
 * - fontSize N → N/10 m glyph height.
 * - Non-wrap (Jump Zone rows etc.): plane is **content-sized** (auth width/height are max
 *   bounds only — scenes often set width:12–20 as slack, not the visual box). textAlign is a
 *   **pivot** on the entity Transform (DCL local):
 *     left → left edge on origin; center → center; right → right edge.
 *   Mesh local X is written with DCL→Three flip (−meshX) so pivot matches entity positions
 *   that already go through dclToThreePos (without the flip, left looked like right / columns
 *   sat too far toward −board-X).
 * - Wrap **with authored height**: full auth box, glyphs paint with textAlign inside.
 * - Wrap **without height** (common — e.g. Xarvon monitor): wrap to width, **content-size
 *   height** (Explorer collapses omitted height). textAlign is a pivot, not “top of a 1 m slab”.
 * - Default textAlign when omitted: MIDDLE_CENTER (SDK).
 */

const PIXELS_PER_METER = 160
const CANVAS_MIN = 4
const CANVAS_MAX = 2048
const PLANE_MIN = 0.02
const FONT_SIZE_TO_METERS = 0.1

type Align = {
  textAlign: CanvasTextAlign
  h: 'left' | 'center' | 'right'
  v: 'top' | 'middle' | 'bottom'
}

type TextLayout = {
  planeW: number
  planeH: number
  canvasW: number
  canvasH: number
  fontPx: number
  lines: string[]
  lineHeight: number
  family: string
  align: Align
  padL: number
  padT: number
  innerW: number
  innerH: number
  /** DCL-local mesh offset (pivot). Applied as Three (−meshX, meshY, 0). */
  meshX: number
  meshY: number
}

/** Entity TRS uses dclToThreePos (X negated); child mesh offsets must match. */
function applyTextShapeMeshOffset(mesh: THREE.Mesh, layout: TextLayout): void {
  mesh.position.set(-layout.meshX, layout.meshY, 0)
}

/**
 * @param worldScale Abs geometric mean of parent XY scale (plaza event cards use 5).
 *   Canvas pixel density scales with this so text stays sharp when Transform.scale enlarges the entity.
 */
export function buildTextShapeMesh(spec: PBTextShape, worldScale = 1): THREE.Mesh {
  const layout = layoutTextShape(spec, worldScale)

  const canvas = document.createElement('canvas')
  canvas.width = layout.canvasW
  canvas.height = layout.canvasH
  const ctx = canvas.getContext('2d')!
  paintLaidOutText(ctx, spec, layout)

  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace

  const geometry = buildDclPlaneGeometry(layout.planeW, layout.planeH)
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.FrontSide,
    depthWrite: false
  })

  const mesh = new THREE.Mesh(geometry, material)
  applyTextShapeMeshOffset(mesh, layout)
  mesh.userData.textShapeSignature = textShapeSignature(spec, worldScale)
  mesh.userData.textShapeWorldScale = worldScale
  mesh.userData.textShapeCanvas = canvas
  return mesh
}

export function updateTextShapeMesh(mesh: THREE.Mesh, spec: PBTextShape, worldScale = 1): void {
  const sig = textShapeSignature(spec, worldScale)
  if (mesh.userData.textShapeSignature === sig) return
  mesh.userData.textShapeSignature = sig
  mesh.userData.textShapeWorldScale = worldScale

  const layout = layoutTextShape(spec, worldScale)

  const mat = mesh.material as THREE.MeshBasicMaterial
  let map = mat.map as THREE.CanvasTexture | null
  let canvas = (mesh.userData.textShapeCanvas as HTMLCanvasElement | undefined) ?? null

  if (!canvas || canvas.width !== layout.canvasW || canvas.height !== layout.canvasH) {
    canvas = document.createElement('canvas')
    canvas.width = layout.canvasW
    canvas.height = layout.canvasH
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
  paintLaidOutText(ctx, spec, layout)
  if (map) map.needsUpdate = true
  mat.side = THREE.FrontSide
  mat.needsUpdate = true

  mesh.geometry.dispose()
  mesh.geometry = buildDclPlaneGeometry(layout.planeW, layout.planeH)
  applyTextShapeMeshOffset(mesh, layout)

  if (mesh.userData.dclTextShapeMirrorX) {
    applyTextShapeFacingMirror(mesh, true)
  }
}

/**
 * Scenes often set Transform.scale.x = −1 on TextShape so text faces a wall in Unity.
 * Flip map U when the entity (or parent chain) has negative X scale product.
 */
export function applyTextShapeFacingMirror(mesh: THREE.Mesh, mirrorX: boolean): void {
  const mat = mesh.material as THREE.MeshBasicMaterial
  const map = mat.map
  if (!map) return
  if (mirrorX) {
    map.repeat.x = -1
    map.offset.x = 1
  } else {
    map.repeat.x = 1
    map.offset.x = 0
  }
  map.needsUpdate = true
  mesh.userData.dclTextShapeMirrorX = mirrorX
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

/**
 * Layout text at authored fontSize (world meters = fontSize * 0.1).
 * Non-wrap / wrap-without-height: content-sized plane + textAlign as entity pivot.
 * Wrap with authored height: full auth plane, align painted inside.
 *
 * @param worldScale Parent XY scale product (geom mean). Plaza event cards use scale 5 —
 *   without denser canvas, glyphs are ~9px then blown up soft.
 */
function layoutTextShape(spec: PBTextShape, worldScale = 1): TextLayout {
  // Cap density so huge scaled props don't allocate multi‑MB canvases.
  const resScale = Math.min(8, Math.max(1, Math.abs(worldScale) || 1))
  const ppm = PIXELS_PER_METER * resScale

  const widthAuthored = spec.width != null && Number.isFinite(spec.width)
  const heightAuthored = spec.height != null && Number.isFinite(spec.height)
  const authW = Math.max(PLANE_MIN, widthAuthored ? (spec.width as number) : 1)
  const authH = Math.max(PLANE_MIN, heightAuthored ? (spec.height as number) : 1)
  const wrap = spec.textWrapping === true
  /** Full-box paint only when wrap + explicit height (vertical align has a real box). */
  const fullBox = wrap && heightAuthored
  const family = fontFamilyForSpec(spec)
  const align = alignFromSpec(spec)
  const plain = stripTextShapeMarkup(spec.text ?? '')

  const boxW = Math.min(CANVAS_MAX, Math.max(CANVAS_MIN, Math.round(authW * ppm)))
  // When height is omitted, start from a generous measure box then shrink to content.
  const measureH = heightAuthored
    ? authH
    : Math.max(authH, 4)
  const boxH = Math.min(
    CANVAS_MAX,
    Math.max(CANVAS_MIN, Math.round(measureH * ppm))
  )

  const padL0 = Math.max(0, (spec.paddingLeft ?? 0) * boxW * 0.5)
  const padR0 = Math.max(0, (spec.paddingRight ?? 0) * boxW * 0.5)
  const padT0 = Math.max(0, (spec.paddingTop ?? 0) * boxH * 0.5)
  const padB0 = Math.max(0, (spec.paddingBottom ?? 0) * boxH * 0.5)
  const innerW0 = Math.max(1, boxW - padL0 - padR0)
  const innerH0 = Math.max(1, boxH - padT0 - padB0)

  // fontSize N → N/10 m local → denser px when parent scale enlarges the entity in world.
  const fontSizeSpec = spec.fontSize ?? 10
  let fontPx = Math.max(4, fontSizeSpec * FONT_SIZE_TO_METERS * ppm)

  const mcanvas = document.createElement('canvas')
  mcanvas.width = 4
  mcanvas.height = 4
  const mctx = mcanvas.getContext('2d')!

  if (spec.fontAutoSize === true && heightAuthored) {
    fontPx = Math.min(fontPx, innerH0 * 0.85)
    for (let guard = 0; guard < 24; guard++) {
      mctx.font = `600 ${fontPx}px ${family}`
      const trial = wrapLines(mctx, plain, wrap ? innerW0 : 1e9, wrap)
      const widest = Math.max(0, ...trial.map((ln) => mctx.measureText(ln).width))
      const lh = fontPx * (1.15 + (spec.lineSpacing ?? 0) * 0.1)
      const blockH = Math.max(lh, trial.length * lh)
      if (widest <= innerW0 * 0.98 && blockH <= innerH0 * 1.02) break
      fontPx *= 0.9
      if (fontPx < 4) break
    }
  }

  mctx.font = `600 ${fontPx}px ${family}`
  let lines = wrapLines(mctx, plain, wrap ? innerW0 : 1e9, wrap)
  if (spec.lineCount != null && spec.lineCount > 0 && lines.length > spec.lineCount) {
    lines = lines.slice(0, spec.lineCount)
  }

  const lineHeight = fontPx * (1.15 + (spec.lineSpacing ?? 0) * 0.1)
  const blockH = Math.max(lineHeight, lines.length * lineHeight)
  const widest = Math.max(fontPx * 0.5, ...lines.map((ln) => mctx.measureText(ln || ' ').width))

  let canvasW: number
  let canvasH: number
  let planeW: number
  let planeH: number
  let meshX = 0
  let meshY = 0

  if (fullBox) {
    // Full authored box — multi-line wrap + align inside (mesh stays centered).
    canvasW = boxW
    canvasH = boxH
    planeW = authW
    planeH = authH
    meshX = 0
    meshY = 0
  } else {
    // Content-sized plane. Auth width is wrap/max width; height is content (or cap if authored).
    const padX = Math.max(padL0 + padR0, fontPx * 0.2)
    const padY = Math.max(padT0 + padB0, fontPx * 0.2)
    // Wrap without height: keep authored width so lines wrap as intended; height hugs content.
    const contentWpx = wrap
      ? boxW
      : Math.min(boxW, Math.max(CANVAS_MIN, Math.ceil(widest + padX)))
    const contentHpx = heightAuthored
      ? Math.min(boxH, Math.max(CANVAS_MIN, Math.ceil(blockH + padY)))
      : Math.max(CANVAS_MIN, Math.ceil(blockH + padY))
    canvasW = Math.min(CANVAS_MAX, contentWpx)
    canvasH = Math.min(CANVAS_MAX, contentHpx)
    // Plane stays in local meters (independent of resScale); denser canvas only.
    planeW = Math.max(PLANE_MIN, canvasW / ppm)
    planeH = Math.max(PLANE_MIN, canvasH / ppm)

    // textAlign = pivot on entity origin (not placement inside a huge default 1 m box).
    // Plane geometry is centered on mesh local 0 — shift so the align edge hits origin.
    if (align.h === 'left') meshX = planeW * 0.5
    else if (align.h === 'right') meshX = -planeW * 0.5
    else meshX = 0

    if (align.v === 'top') meshY = -planeH * 0.5
    else if (align.v === 'bottom') meshY = planeH * 0.5
    else meshY = 0
  }

  const padL = Math.max(0, (spec.paddingLeft ?? 0) * canvasW * 0.5)
  const padR = Math.max(0, (spec.paddingRight ?? 0) * canvasW * 0.5)
  const padT = Math.max(0, (spec.paddingTop ?? 0) * canvasH * 0.5)
  const padB = Math.max(0, (spec.paddingBottom ?? 0) * canvasH * 0.5)

  return {
    planeW,
    planeH,
    canvasW,
    canvasH,
    fontPx,
    lines,
    lineHeight,
    family,
    align,
    padL,
    padT,
    innerW: Math.max(1, canvasW - padL - padR),
    innerH: Math.max(1, canvasH - padT - padB),
    meshX,
    meshY
  }
}

function paintLaidOutText(
  ctx: CanvasRenderingContext2D,
  spec: PBTextShape,
  layout: TextLayout
): void {
  const { canvasW: w, canvasH: h, fontPx, lines, lineHeight, family, align, padL, padT, innerW, innerH } =
    layout

  ctx.clearRect(0, 0, w, h)
  ctx.imageSmoothingEnabled = true
  ctx.font = `600 ${fontPx}px ${family}`
  ctx.textAlign = align.textAlign
  ctx.textBaseline = 'middle'

  const { color: fill, alpha } = resolveTextFill(spec)
  const outline = color3ToThree(spec.outlineColor, 0x000000)
  const shadow = color3ToThree(spec.shadowColor, 0x000000)
  const outlineWidth = spec.outlineWidth ?? 0
  const shadowBlur = spec.shadowBlur ?? 0
  const shadowX = spec.shadowOffsetX ?? 0
  const shadowY = spec.shadowOffsetY ?? 0
  const strokePx = outlineWidth > 0 ? Math.max(1, outlineWidth * fontPx * 0.35) : 0

  const blockH = lines.length * lineHeight
  let startY: number
  if (align.v === 'top') startY = padT + lineHeight * 0.5
  else if (align.v === 'bottom') startY = padT + innerH - blockH + lineHeight * 0.5
  else startY = padT + innerH / 2 - blockH / 2 + lineHeight / 2

  // Content-sized planes: glyphs fill the canvas — still honor h align for multi-line.
  const xFor = (): number => {
    if (align.h === 'left') return padL
    if (align.h === 'right') return padL + innerW
    return padL + innerW / 2
  }

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

export function textShapeSignature(spec: PBTextShape, worldScale = 1): string {
  // Quantize scale so tiny matrix jitter does not thrash re-raster.
  const resScale = Math.min(8, Math.max(1, Math.abs(worldScale) || 1))
  const scaleKey = Math.round(resScale * 4) / 4
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
    font: spec.font,
    worldScale: scaleKey
  })
}

function stripTextShapeMarkup(text: string): string {
  return text
    .replace(/<\/?(?:b|i|u)>/gi, '')
    .replace(/<\/?color(?:=[^>]*)?>/gi, '')
    .replace(/<\/?size(?:=[^>]*)?>/gi, '')
    .replace(/<\/?space(?:=[^>]*)?>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
}

function resolveTextFill(spec: PBTextShape): { color: THREE.Color; alpha: number } {
  const c = spec.textColor
  if (!c) return { color: new THREE.Color(0xffffff), alpha: 1 }
  const r = c.r
  const g = c.g
  const b = c.b
  if (r === undefined && g === undefined && b === undefined) {
    return { color: new THREE.Color(0xffffff), alpha: color4Alpha(c, 1) }
  }
  return {
    color: color4ToThree(c, 0xffffff),
    alpha: color4Alpha(c, 1)
  }
}

function fontFamilyForSpec(spec: PBTextShape): string {
  const f = spec.font
  if (f === 1) return 'Georgia, "Times New Roman", serif'
  if (f === 2) return 'ui-monospace, "Cascadia Code", Menlo, monospace'
  return 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
}

function alignFromSpec(spec: PBTextShape): Align {
  // SDK default TAM_MIDDLE_CENTER when omitted. Explicit values (incl. TOP_*) still win.
  const a = spec.textAlign ?? TAM.MIDDLE_CENTER
  switch (a) {
    case TAM.TOP_LEFT:
      return { textAlign: 'left', h: 'left', v: 'top' }
    case TAM.TOP_CENTER:
      return { textAlign: 'center', h: 'center', v: 'top' }
    case TAM.TOP_RIGHT:
      return { textAlign: 'right', h: 'right', v: 'top' }
    case TAM.MIDDLE_LEFT:
      return { textAlign: 'left', h: 'left', v: 'middle' }
    case TAM.MIDDLE_RIGHT:
      return { textAlign: 'right', h: 'right', v: 'middle' }
    case TAM.BOTTOM_LEFT:
      return { textAlign: 'left', h: 'left', v: 'bottom' }
    case TAM.BOTTOM_CENTER:
      return { textAlign: 'center', h: 'center', v: 'bottom' }
    case TAM.BOTTOM_RIGHT:
      return { textAlign: 'right', h: 'right', v: 'bottom' }
    case TAM.MIDDLE_CENTER:
      return { textAlign: 'center', h: 'center', v: 'middle' }
    default:
      return { textAlign: 'center', h: 'center', v: 'middle' }
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
