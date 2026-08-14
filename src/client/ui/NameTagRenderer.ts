import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

const registered = new Set<CSS2DObject>()

const _ndc = new THREE.Vector3()
const _viewProjection = new THREE.Matrix4()

/** Beyond this distance, idle pills draw on a canvas atlas instead of CSS2D. */
const FAR_ATLAS_M2 = 20 * 20
const ATLAS_MAX_LABEL = 16

export function registerNameTagObject(obj: CSS2DObject): void {
  registered.add(obj)
}

export function unregisterNameTagObject(obj: CSS2DObject): void {
  registered.delete(obj)
}

function isHierarchyVisible(obj: THREE.Object3D): boolean {
  // Detached leftovers (reload stripped the CSS2D but left it registered) have
  // parent === null. That is not "visible" — it is not in the scene graph.
  if (!obj.parent) return false
  let p: THREE.Object3D | null = obj
  while (p) {
    if (!p.visible) return false
    p = p.parent
  }
  return true
}

function truncateLabel(label: string): string {
  if (label.length <= ATLAS_MAX_LABEL) return label
  return `${label.slice(0, ATLAS_MAX_LABEL - 1)}…`
}

/**
 * Overhead pills — project only registered CSS2DObjects.
 * Never walk the world scene (CSS2DRenderer.render(scene) was ~5ms on plaza).
 * Far idle tags share one canvas atlas (no per-pill CSS layout).
 */
export class NameTagRenderer {
  private readonly renderer: CSS2DRenderer
  readonly domElement: HTMLElement
  private readonly atlasCanvas: HTMLCanvasElement
  private readonly atlasCtx: CanvasRenderingContext2D | null
  private width = 1
  private height = 1

  constructor(container: HTMLElement) {
    this.renderer = new CSS2DRenderer()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    const dom = this.renderer.domElement
    dom.className = 'name-tag-layer'
    this.domElement = dom
    container.appendChild(dom)

    this.atlasCanvas = document.createElement('canvas')
    this.atlasCanvas.className = 'name-tag-atlas'
    this.atlasCanvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1'
    dom.appendChild(this.atlasCanvas)
    this.atlasCtx = this.atlasCanvas.getContext('2d')

    const size = this.renderer.getSize()
    this.width = size.width
    this.height = size.height
    this.resizeAtlas()
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height)
    this.width = width
    this.height = height
    this.resizeAtlas()
  }

  render(_scene: THREE.Scene, camera: THREE.Camera): void {
    if (registered.size === 0) {
      this.clearAtlas()
      return
    }
    if (camera.parent === null && camera.matrixWorldAutoUpdate === true) {
      camera.updateMatrixWorld()
    }
    _viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    const widthHalf = this.width * 0.5
    const heightHalf = this.height * 0.5
    const layer = this.domElement
    const visible: Array<{ obj: CSS2DObject; distSq: number }> = []
    const camX = camera.matrixWorld.elements[12]!
    const camY = camera.matrixWorld.elements[13]!
    const camZ = camera.matrixWorld.elements[14]!

    this.beginAtlas()

    for (const obj of registered) {
      const el = obj.element
      if (!el) continue
      if (!isHierarchyVisible(obj)) {
        el.style.display = 'none'
        continue
      }
      _ndc.setFromMatrixPosition(obj.matrixWorld)
      _ndc.applyMatrix4(_viewProjection)
      const onScreen = _ndc.z >= -1 && _ndc.z <= 1 && obj.layers.test(camera.layers)
      if (!onScreen) {
        el.style.display = 'none'
        continue
      }
      const dx = obj.matrixWorld.elements[12]! - camX
      const dy = obj.matrixWorld.elements[13]! - camY
      const dz = obj.matrixWorld.elements[14]! - camZ
      const distSq = dx * dx + dy * dy + dz * dz
      const rich = obj.userData.dclTagRich === true
      if (!rich && distSq > FAR_ATLAS_M2) {
        el.style.display = 'none'
        this.drawAtlasPill(
          _ndc.x * widthHalf + widthHalf,
          -_ndc.y * heightHalf + heightHalf,
          String(obj.userData.dclTagLabel ?? ''),
          String(obj.userData.dclTagColor ?? '#ffffff')
        )
        continue
      }
      el.style.display = ''
      el.style.transform =
        `translate(${-100 * obj.center.x}%,${-100 * obj.center.y}%)` +
        `translate(${_ndc.x * widthHalf + widthHalf}px,${-_ndc.y * heightHalf + heightHalf}px)`
      if (el.parentNode !== layer) layer.appendChild(el)
      visible.push({ obj, distSq })
    }

    visible.sort((a, b) => {
      if (a.obj.renderOrder !== b.obj.renderOrder) return b.obj.renderOrder - a.obj.renderOrder
      return a.distSq - b.distSq
    })
    const zMax = visible.length
    for (let i = 0; i < zMax; i++) {
      visible[i]!.obj.element.style.zIndex = String(zMax - i)
    }
  }

  dispose(): void {
    this.atlasCanvas.remove()
    this.renderer.domElement.remove()
    registered.clear()
  }

  private resizeAtlas(): void {
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1
    this.atlasCanvas.width = Math.max(1, Math.floor(this.width * dpr))
    this.atlasCanvas.height = Math.max(1, Math.floor(this.height * dpr))
    this.atlasCtx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private beginAtlas(): void {
    const ctx = this.atlasCtx
    if (!ctx) return
    ctx.clearRect(0, 0, this.width, this.height)
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
  }

  private clearAtlas(): void {
    this.atlasCtx?.clearRect(0, 0, this.width, this.height)
  }

  private drawAtlasPill(x: number, y: number, label: string, color: string): void {
    const ctx = this.atlasCtx
    if (!ctx || !label) return
    const text = truncateLabel(label)
    const padX = 7
    const h = 16
    const w = Math.min(140, ctx.measureText(text).width + padX * 2)
    const left = x - w * 0.5
    const top = y - h * 0.5
    const r = 8
    ctx.beginPath()
    ctx.moveTo(left + r, top)
    ctx.arcTo(left + w, top, left + w, top + h, r)
    ctx.arcTo(left + w, top + h, left, top + h, r)
    ctx.arcTo(left, top + h, left, top, r)
    ctx.arcTo(left, top, left + w, top, r)
    ctx.closePath()
    ctx.fillStyle = 'rgba(8, 10, 16, 0.62)'
    ctx.fill()
    ctx.fillStyle = color || '#ffffff'
    ctx.fillText(text, x, y)
  }
}
