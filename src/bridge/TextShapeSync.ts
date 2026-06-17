import * as THREE from 'three'
import type { PBTextShape } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/text_shape.gen'
import { color3ToThree, color4Alpha, color4ToThree } from './pbColor'

const CANVAS_W = 512
const CANVAS_H = 256

export function buildTextShapeMesh(spec: PBTextShape): THREE.Mesh {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  const ctx = canvas.getContext('2d')!
  paintTextShape(ctx, spec, CANVAS_W, CANVAS_H)

  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter

  const width = spec.width ?? 1
  const height = spec.height ?? 1
  const geometry = new THREE.PlaneGeometry(width, height)
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.userData.textShapeSignature = textShapeSignature(spec)
  return mesh
}

export function updateTextShapeMesh(mesh: THREE.Mesh, spec: PBTextShape): void {
  const sig = textShapeSignature(spec)
  if (mesh.userData.textShapeSignature === sig) return
  mesh.userData.textShapeSignature = sig

  const mat = mesh.material as THREE.MeshBasicMaterial
  const map = mat.map as THREE.CanvasTexture
  const canvas = map.image as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  paintTextShape(ctx, spec, canvas.width, canvas.height)
  map.needsUpdate = true

  const width = spec.width ?? 1
  const height = spec.height ?? 1
  mesh.geometry.dispose()
  mesh.geometry = new THREE.PlaneGeometry(width, height)
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

function textShapeSignature(spec: PBTextShape): string {
  return JSON.stringify({
    text: spec.text,
    fontSize: spec.fontSize,
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
    paddingTop: spec.paddingTop,
    paddingRight: spec.paddingRight,
    paddingBottom: spec.paddingBottom,
    paddingLeft: spec.paddingLeft
  })
}

function paintTextShape(ctx: CanvasRenderingContext2D, spec: PBTextShape, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h)

  const padL = (spec.paddingLeft ?? 0) * w * 0.1
  const padR = (spec.paddingRight ?? 0) * w * 0.1
  const padT = (spec.paddingTop ?? 0) * h * 0.1
  const padB = (spec.paddingBottom ?? 0) * h * 0.1
  const innerW = w - padL - padR
  const innerH = h - padT - padB

  const fontSize = Math.max(8, (spec.fontSize ?? 10) * 4)
  ctx.font = `${fontSize}px sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'

  const fill = color4ToThree(spec.textColor)
  const alpha = color4Alpha(spec.textColor, 1)
  const outline = color3ToThree(spec.outlineColor)
  const shadow = color3ToThree(spec.shadowColor)
  const outlineWidth = spec.outlineWidth ?? 0
  const shadowBlur = spec.shadowBlur ?? 0
  const shadowX = spec.shadowOffsetX ?? 0
  const shadowY = spec.shadowOffsetY ?? 0

  const lines = wrapLines(ctx, spec.text ?? '', innerW, spec.textWrapping === true)
  const lineHeight = fontSize * (1.2 + (spec.lineSpacing ?? 0) * 0.1)
  const blockH = lines.length * lineHeight
  let y = padT + innerH / 2 - blockH / 2 + lineHeight / 2

  for (const line of lines) {
    const x = padL + innerW / 2
    if (shadowBlur > 0 || shadowX !== 0 || shadowY !== 0) {
      ctx.shadowColor = `#${shadow.getHexString()}`
      ctx.shadowBlur = shadowBlur * 2
      ctx.shadowOffsetX = shadowX * 2
      ctx.shadowOffsetY = shadowY * 2
    }
    if (outlineWidth > 0) {
      ctx.strokeStyle = `#${outline.getHexString()}`
      ctx.lineWidth = outlineWidth * 2
      ctx.strokeText(line, x, y)
    }
    ctx.shadowColor = 'transparent'
    ctx.fillStyle = `rgba(${Math.round(fill.r * 255)}, ${Math.round(fill.g * 255)}, ${Math.round(fill.b * 255)}, ${alpha})`
    ctx.fillText(line, x, y)
    y += lineHeight
  }
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, wrap: boolean): string[] {
  if (!wrap) return [text]
  const words = text.split(/\s+/)
  const lines: string[] = []
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
  return lines.length ? lines : ['']
}
