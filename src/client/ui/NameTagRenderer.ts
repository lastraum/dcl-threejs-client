import type { Camera, Scene } from 'three'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

/** Renders CSS2D name tags on top of the WebGL canvas. */
export class NameTagRenderer {
  private readonly renderer: CSS2DRenderer

  constructor(container: HTMLElement) {
    this.renderer = new CSS2DRenderer()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    const dom = this.renderer.domElement
    dom.style.position = 'absolute'
    dom.style.top = '0'
    dom.style.left = '0'
    dom.style.pointerEvents = 'none'
    container.appendChild(dom)
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height)
  }

  render(scene: Scene, camera: Camera): void {
    this.renderer.render(scene, camera)
  }

  dispose(): void {
    this.renderer.domElement.remove()
  }
}
